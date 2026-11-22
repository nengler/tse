import { BALL_TOUCH_TOLERANCE, stepBalls, type Ball, type BallContact, type BallSpace, type SolidBox } from "./ball.ts";
import type { BodySpace, Box } from "./body.ts";
import { Collider, type Contact, type Nearby, type SendTarget } from "./components/Collider.ts";
import { Menu } from "./components/Menu.ts";
import type { Pressable } from "./components/Pointer.ts";
import { Tilemap } from "./components/Tilemap.ts";
import { GameObject } from "./GameObject.ts";
import { takeTreeRestore } from "./gameTree.ts";
import { restoreHotState } from "./hot.ts";
import { inputDeviceOf, NO_INPUT, setInputDevice, type InputState } from "./input.ts";
import { activeProfiler, PROFILE_INPUT, PROFILE_RENDER, PROFILE_UPDATE } from "./profile.ts";
import { geometryOf, geometryOverlapsBox } from "./shapes.ts";
import { countStep } from "./Sound.ts";
import { findTilemap } from "./tilemap.ts";
import type { WorldTransform } from "./Transform.ts";

/** Steps the world is asked to freeze for by `freeze`: taken up by the next tick that is not already frozen. */
let freezeRequest = 0;

/**
 * Pause the world's `onUpdate` for the next `steps` ticks: a hit, a dash, a death, which feels heavier for a few frames of
 * stillness. Things drawn keep drawing, `onInput` still runs, and renders still happen, so state set by the step that
 * called this still shows. The player keeps the key edges of a frozen step for the first step after it, so a press during
 * the freeze is not lost. Asking again while frozen extends it to the longer of the two. Any code in a tick can call it,
 * including a game state action.
 */
export function freeze(steps: number): void {
  if (steps > freezeRequest) freezeRequest = Math.floor(steps);
}

/** Numbers each pass of any World's `flush` over its list of renders (see `GameObject.renderInPass`): one counter for all worlds, so an object that moves between them is never mistaken for one already seen. */
let passes = 0;

/**
 * Owns the root of the object tree and drives dirty-driven updates:
 * render every dirty object, then apply queued structural changes.
 */
/** A focusable that takes typing (`<TextInput>`): while it has the focus, the World hands it `InputState.typed`, and Enter submits it. */
interface TextEntry {
  takeText(typed: string): void;
  submit(): void;
}

export class World implements BodySpace, BallSpace {
  readonly root: GameObject = new GameObject();
  /**
   * A counter the player's frame builder advances once per frame it builds. A change to an object is stamped with
   * the value current when it happens (`GameObject.markChanged`), so the builder can tell what changed since it
   * last drew an object: a stamp at or after the serial of that frame is newer than the frame.
   */
  serial = 0;
  /**
   * The objects that asked for a render, in the order they asked. A list, not a `Set`: adding to one and copying it out each
   * frame was a fifth of the tick for 2,000 objects that re-render every frame. An object can be in it twice (it asks when it
   * turns dirty, and again if it joins this world while dirty), which `flush` sees to: each object is looked at once per pass.
   */
  #dirty: GameObject[] = [];
  #structure = new Set<GameObject>();
  #onInput = new Set<GameObject>();
  #onUpdate = new Set<GameObject>();
  /**
   * The objects with an `onInput` or an `onUpdate`, in tree order (depth first, a parent before its children, siblings as they are
   * children of their parent): the order handlers run in. It is made when a frame needs it after the tree or the set of handlers
   * changed (`orderChanged`), and a frame runs over the list it began with, so an object added during it starts next frame.
   */
  #order: { readonly input: readonly GameObject[]; readonly update: readonly GameObject[] } | null = null;
  readonly #inert = new Set<GameObject>();
  /** Objects with `modal`, in the order they were mounted: the last one in this world takes the input. */
  readonly #modals: GameObject[] = [];
  /** Every `<Pointer>` and `<Flex>` in this world: what a `pressKey`, the focus and the confirm key look through. */
  readonly #pressables = new Set<GameObject & Pressable>();
  #focused: (GameObject & Pressable) | null = null;
  /** What had the focus when a modal made it inert, to give it back when it can take it again (as a browser does when a dialog closes). */
  #focusBeforeInert: (GameObject & Pressable) | null = null;
  readonly #live: (GameObject & Pressable)[] = [];
  readonly #focusables: (GameObject & Pressable)[] = [];
  #frozen = 0;
  /** While true no `onUpdate` runs (the player sets it from `<Game paused>`); `onInput` and presses still do. */
  paused = false;
  /** Objects with timers waiting (`GameObject.after`, `every`), stepped after the updates of each step that is not frozen or paused. */
  readonly #timed = new Set<GameObject>();

  /** An object in this world has a timer waiting. */
  addTimed(object: GameObject): void {
    this.#timed.add(object);
  }

  constructor() {
    this.root.attachToWorld(this);
  }

  mount(object: GameObject): void {
    this.root.addChild(object);
  }

  scheduleRender(object: GameObject): void {
    this.#dirty.push(object);
  }

  scheduleCommit(object: GameObject): void {
    this.#structure.add(object);
  }

  /**
   * Run one frame, in a fixed order: `onInput` → `onUpdate` → render dirty
   * objects → commit structure. Only objects that override a hook are visited
   * (registered on attach), and the visit lists are snapshotted at the start,
   * so objects attached during a frame start receiving hooks next frame and
   * objects detached mid-frame are skipped. Returns the number of renders run.
   *
   * `beforeUpdate`, when given, is called after `onInput` and before `onUpdate`, and only when the update is not frozen: the
   * player uses it to show `onUpdate` the key edges a freeze kept (see `freeze`), which `onInput` has already seen.
   */
  tick(dt: number, input: InputState = NO_INPUT, beforeUpdate?: () => void): number {
    countStep();
    this.#spaces = null;
    this.#spaceObject = null;
    this.#space = null;
    this.#indexes = null;
    const anyInert = this.#hasInert();
    if (input !== NO_INPUT) {
      // Whatever was pressed last is what the player is using (`getInputDevice()`), whoever in the tree hears the press.
      const last = input.lastPressed?.();
      if (last !== undefined) setInputDevice(inputDeviceOf(last));
    }
    if (this.#pressables.size > 0 && input !== NO_INPUT) this.#keys(input, anyInert);
    const order = (this.#order ??= this.#treeOrder());
    const inputs = order.input;
    const profiler = activeProfiler();
    if (profiler === null) {
      for (const object of inputs) if (object.world === this) object.onInput(anyInert && this.isInert(object) ? NO_INPUT : input);
    } else {
      for (const object of inputs) {
        if (object.world !== this) continue;
        const started = profiler.now();
        object.onInput(anyInert && this.isInert(object) ? NO_INPUT : input);
        profiler.add(object, PROFILE_INPUT, profiler.now() - started);
      }
    }
    if (this.#frozen > 0) this.#frozen--;
    else if (!this.paused) {
      // Balls first, so the step's updates see them where this step put them (DESIGN.md, "Balls: `useBall`").
      if (this.#balls.size > 0) stepBalls([...this.#balls], this, dt);
      beforeUpdate?.();
      const updates = order.update;
      if (profiler === null) {
        for (const object of updates) if (object.world === this) object.onUpdate(dt, anyInert && this.isInert(object) ? NO_INPUT : input);
      } else {
        for (const object of updates) {
          if (object.world !== this) continue;
          const started = profiler.now();
          object.onUpdate(dt, anyInert && this.isInert(object) ? NO_INPUT : input);
          profiler.add(object, PROFILE_UPDATE, profiler.now() - started);
        }
      }
      // Timers, after the updates of the step, in the order their objects first set one.
      if (this.#timed.size > 0) {
        for (const object of [...this.#timed]) {
          const started = profiler?.now() ?? 0;
          if (object.world !== this || !object.stepTimers(dt)) this.#timed.delete(object);
          if (profiler !== null) profiler.add(object, PROFILE_UPDATE, profiler.now() - started);
        }
      }
    }
    // What was sent this step (`send`), now that every update and timer has run: before the step renders, so what a receiver
    // changes is drawn this step. Run even while frozen or paused, as collisions are: a send from `useInput` still lands.
    if (this.#sends.length > 0) this.#deliver();
    // A freeze asked for during this tick starts with the next.
    if (freezeRequest > this.#frozen) this.#frozen = freezeRequest;
    freezeRequest = 0;
    return this.flush();
  }

  /** How many more ticks `onUpdate` will be skipped for (see `freeze`). */
  get frozenSteps(): number {
    return this.#frozen;
  }

  /** Put back a freeze a snapshot had (development rewind). */
  set frozenSteps(steps: number) {
    this.#frozen = Math.max(0, Math.floor(steps));
  }

  /**
   * Report that two colliders began touching (the mock has no physics; a
   * collision system calls this). Each collider's own `onCollisionEnter`
   * callback is called with the other collider. Dispatch only: the player
   * calls `flush` after the step's contacts, so what they change renders
   * before the next step.
   */
  reportCollision(a: Collider, b: Collider): void {
    if (a.world === this) a.onCollisionEnter?.(b as unknown as Contact);
    if (b.world === this) b.onCollisionEnter?.(a as unknown as Contact);
  }

  /**
   * Report that two colliders stopped touching, because they moved apart or because one of them left the world or
   * lost its area. Each collider's own `onCollisionExit` callback is called with the other, but only for a collider
   * that is still mounted in this world (one that left is gone, and hears nothing). Dispatch only.
   */
  reportCollisionExit(a: Collider, b: Collider): void {
    if (a.world === this) a.onCollisionExit?.(b as unknown as Contact);
    if (b.world === this) b.onCollisionExit?.(a as unknown as Contact);
  }

  /**
   * A press at a world-space point: calls the pointer's own `onPress` when the
   * point is inside its area and it is mounted in this world. Returns whether it
   * was hit. Dispatch only: renders happen in the next `tick`. Which pointer
   * to test (and in what order, for overlaps) is the input system's job.
   *
   * `held` keeps `onPressAt` and `onPress` back until the button is let go (`reportRelease`), and drops them if the drag
   * scrolls a box instead (`cancelPress`): the player holds back a press that lands over a scroll box, so a drag that
   * scrolls it does not also press what it began on. The pressable is pressed (its `pressed*` look) from the start.
   */
  reportPress(pointer: Pressable, x: number, y: number, held = false): boolean {
    if (pointer.world !== this || !pointer.contains(x, y)) return false;
    if (this.#hasInert() && this.isInert(pointer as unknown as GameObject)) return false;
    // A disabled one is hit, so what is under it does not get the press, but it hears nothing and takes no focus.
    if (pointer.disabled === true) return true;
    if (pointer.focusable === true) this.focus(pointer);
    this.#pressed = pointer;
    if (held) {
      this.#heldPress = { pointer, x, y };
      return true;
    }
    pointer.onPressAt?.(x, y);
    pointer.onPress?.();
    pointer.onDragStart?.(x, y);
    return true;
  }

  /** A press held back until the button is let go (`reportPress` with `held`), and where it landed; null for none. */
  #heldPress: { pointer: Pressable; x: number; y: number } | null = null;

  /**
   * A left press landed on `target` (null: on nothing). Every mounted pressable with an `onPressOutside` hears it, unless the
   * target is it or inside it, or it is inert. The player calls this once for each press on the game's screen, after the press itself.
   */
  reportPressOutside(target: Pressable | null): void {
    const anyInert = this.#hasInert();
    // A copy: a handler may take pressables out of the world.
    for (const p of [...this.#pressables]) {
      if (p.onPressOutside === undefined || p.world !== this) continue;
      if (anyInert && this.isInert(p)) continue;
      let inside = false;
      for (let at = target as unknown as GameObject | null; at !== null && !inside; at = at.parent) inside = at === p;
      if (!inside) p.onPressOutside();
    }
  }

  #pressed: Pressable | null = null;

  /** The pressable a press began on, while the mouse button is still held (null for none): what a `<Flex>`'s `pressed*` props are drawn for. */
  get pressed(): Pressable | null {
    return this.#pressed;
  }

  /**
   * The mouse button is up: nothing is pressed any more. The player calls it every step the button is not held. A press held
   * back (`reportPress` with `held`) is heard now, by a pressable that is still in this world, enabled and not inert.
   */
  reportRelease(): void {
    this.#pressed = null;
    const held = this.#heldPress;
    if (held === null) return;
    this.#heldPress = null;
    const { pointer } = held;
    if (pointer.world !== this || pointer.disabled === true) return;
    if (this.#hasInert() && this.isInert(pointer as unknown as GameObject)) return;
    pointer.onPressAt?.(held.x, held.y);
    pointer.onPress?.();
  }

  /** A drag took the held press to scroll a box: nothing is pressed any more, and a press held back is never heard. */
  cancelPress(): void {
    this.#pressed = null;
    this.#heldPress = null;
  }

  #hovered: Pressable | null = null;

  /** The pressable the mouse is over, as of the last `reportHover` (null for none): what a `<Flex>`'s `hover*` props are drawn for. */
  get hovered(): Pressable | null {
    return this.#hovered;
  }

  /**
   * The topmost pressable under the mouse this frame (null for none, or for a mouse off the screen): when it is not the one
   * before, the one before hears `onPointerLeave` (if it is still in this world) and the new one `onPointerEnter`, as the DOM's
   * `pointerenter` / `pointerleave`. One in an inert subtree counts as none. Dispatch only: renders happen in the next `tick`.
   */
  reportHover(pointer: Pressable | null, silent = false): void {
    if (pointer !== null && (pointer.world !== this || (this.#hasInert() && this.isInert(pointer as unknown as GameObject))))
      pointer = null;
    if (pointer === this.#hovered) return;
    const previous = this.#hovered;
    this.#hovered = pointer;
    // `silent`: the mouse was already over it (development rewind puts back a tree the mouse was over), so nobody is told.
    if (silent) return;
    if (previous !== null && previous.world === this) previous.onPointerLeave?.();
    pointer?.onPointerEnter?.();
  }

  /**
   * Make a subtree inert, or not, as the HTML attribute does: it still updates, draws and collides, but hears no input (its
   * `useInput` and `useUpdate` get no keys pressed) and none of its pointers can be pressed. A router makes the screen it is
   * leaving inert for the transition, so a button pressed during a fade acts only on the screen being entered.
   */
  setInert(object: GameObject, inert: boolean): void {
    if (inert) this.#inert.add(object);
    else this.#inert.delete(object);
  }

  /**
   * Make an object modal, or not, as a `<dialog>` opened with `showModal()`: while it is in this world, everything outside its
   * subtree is inert (see `setInert`). The one made modal last takes the input. `GameObject.modal` calls it.
   */
  setModal(object: GameObject, modal: boolean): void {
    const at = this.#modals.indexOf(object);
    if (at !== -1) this.#modals.splice(at, 1);
    if (modal) this.#modals.push(object);
  }

  /** The modal that takes the input now, or null: the last one made modal that is still in this world. */
  get modal(): GameObject | null {
    const modals = this.#modals;
    while (modals.length > 0 && modals[modals.length - 1]!.world !== this) modals.pop();
    return modals.at(-1) ?? null;
  }

  /** Whether `object` hears no input: it is in a subtree made inert (see `setInert`), or outside the modal (see `setModal`). */
  isInert(object: GameObject): boolean {
    const modal = this.#modals.length > 0 ? this.modal : null;
    if (this.#inert.size === 0 && modal === null) return false;
    let insideModal = modal === null;
    for (let at: GameObject | null = object; at !== null; at = at.parent) {
      if (this.#inert.has(at)) return true;
      if (at === modal) insideModal = true;
    }
    return !insideModal;
  }

  #hasInert(): boolean {
    for (const object of this.#inert) if (object.world !== this) this.#inert.delete(object);
    return this.#inert.size > 0 || (this.#modals.length > 0 && this.modal !== null);
  }

  /** What has the focus (see `PressableProps.focusable`), or null. */
  get focused(): Pressable | null {
    return this.#focused;
  }

  /**
   * Give the focus to a focusable pressable in this world (null takes it away): the one that had it hears `onBlur`, this one
   * `onFocus`. A click on a focusable one focuses it, as in a browser; the arrow keys move it (`tick`).
   */
  focus(target: Pressable | null): void {
    const next =
      target !== null && (target as GameObject & Pressable).world === this && target.focusable === true && target.disabled !== true
        ? (target as GameObject & Pressable)
        : null;
    if (next === this.#focused) return;
    const previous = this.#focused;
    this.#focused = next;
    if (previous !== null && previous.world === this) previous.onBlur?.();
    next?.onFocus?.();
  }

  /**
   * Keys that press things, before any `onInput`: each mounted, not inert pressable whose `pressKey` was pressed is pressed; the focus
   * goes to an `autoFocus` one when nothing has it, moves with the direction actions (`left` `right` `up` `down`, or the arrows and the
   * d-pad when the controls have no such action) to the nearest focusable that way, and `confirm` (or Enter and PadA) presses it.
   */
  #keys(input: InputState, anyInert: boolean): void {
    // Scratch lists kept between ticks, so a tick allocates nothing here once warm.
    const live = this.#live;
    const focusables = this.#focusables;
    live.length = 0;
    focusables.length = 0;
    for (const p of this.#pressables) {
      if (p.world !== this || (anyInert && this.isInert(p))) continue;
      if (p.disabled === true) continue;
      live.push(p);
      if (p.focusable === true) focusables.push(p);
    }
    // While a text field has the focus, what is typed goes into it, and the keys that move or press are only the plain ones (the arrows,
    // Enter, Escape and the gamepad's), never letters an action is bound to: typing "x" must not go back, nor a `pressKey` fire.
    const ask = (action: string, keys: readonly string[]): boolean =>
      !typing() && input.isAction?.(action) ? input.pressed(action) : keys.some((k) => input.pressed(k));
    const typing = (): boolean => this.#focused !== null && typeof (this.#focused as Partial<TextEntry>).takeText === "function";
    if (this.#focused !== null && !focusables.includes(this.#focused)) {
      const lost = this.#focused;
      if (anyInert && lost.world === this && lost.focusable === true && lost.disabled !== true && this.isInert(lost))
        this.#focusBeforeInert = lost;
      this.focus(null);
    }
    const before = this.#focusBeforeInert;
    if (before !== null && (before.world !== this || focusables.includes(before))) {
      this.#focusBeforeInert = null;
      if (before.world === this && (this.#focused === null || this.#focused.world !== this)) this.focus(before);
    }
    if (this.#focused === null) {
      const auto = focusables.find((p) => p.autoFocus === true);
      if (auto) this.focus(auto);
    }
    if (typing()) (this.#focused as unknown as TextEntry).takeText(input.typed ?? "");
    if (focusables.length > 0) {
      const dx = (ask("right", ["ArrowRight", "PadRight"]) ? 1 : 0) - (ask("left", ["ArrowLeft", "PadLeft"]) ? 1 : 0);
      const dy = dx !== 0 ? 0 : (ask("down", ["ArrowDown", "PadDown"]) ? 1 : 0) - (ask("up", ["ArrowUp", "PadUp"]) ? 1 : 0);
      if (dx !== 0 || dy !== 0) {
        if (this.#focused === null) this.focus(focusables[0]!);
        else if (this.#focused.onNavigate?.(dx, dy) === true) {
          // It used the direction itself (a slider moving its thumb), so the focus stays.
        } else {
          const next = this.#nextFocus(this.#focused, focusables, dx, dy);
          if (next !== null) this.focus(next);
        }
      } else if (this.#focused !== null && ask("confirm", ["Enter", "PadA"])) {
        if (typing()) (this.#focused as unknown as TextEntry).submit();
        else this.#focused.onPress?.();
      } else if (this.#focused !== null && ask("back", ["Escape", "PadB"])) menuOf(this.#focused)?.onBack?.();
    }
    if (typing()) return;
    for (const p of live) if (p.pressKey !== undefined && p.world === this && input.pressed(p.pressKey)) p.onPress?.();
  }

  /**
   * Where the focus goes from `from` in a direction: inside a `<Menu>`, the nearest of the menu's own items that way, or round to the
   * far end when there is none and the menu loops (it never leaves the menu); elsewhere, the nearest focusable that way.
   */
  #nextFocus(
    from: GameObject & Pressable,
    focusables: readonly (GameObject & Pressable)[],
    dx: number,
    dy: number
  ): (GameObject & Pressable) | null {
    const menu = menuOf(from);
    if (menu === null) return nearestInDirection(from, focusables, dx, dy);
    const items = focusables.filter((p) => menuOf(p) === menu);
    return nearestInDirection(from, items, dx, dy) ?? (menu.loop ? farthestInDirection(from, items, -dx, -dy) : null);
  }

  /** Called by GameObject when it joins this world: remember which per-tick hooks it overrides. */
  /** The colliders and the solid tilemaps in this world, for bodies (`useBody`). */
  readonly #colliders = new Set<Collider>();
  /**
   * The colliders by tag with their world boxes, on a grid, for queries (`#indexOf`): worked out once per update phase, as a body's
   * queries (twenty towers each asking which of a hundred enemies are near) would otherwise compose each collider's transform up the
   * tree every time. Transforms change when the tree renders, so they are dropped as a tick starts and after every flush: a query
   * sees the colliders where they were when the step's updates began, as the step's state is a snapshot. Dropped too when a collider
   * joins or leaves.
   */
  #indexes: Map<string, ColliderIndex> | null = null;
  /** The child spaces of objects with many children, for the boxes (`#spaceOf`): dropped with the indexes. */
  #spaces: Map<GameObject, WorldTransform> | null = null;
  /** The object `#spaceOf` last looked up in `#spaces`, and its space: a list's items ask for the list's one after another. */
  #spaceObject: GameObject | null = null;
  #space: WorldTransform | null = null;
  readonly #tilemaps = new Set<Tilemap>();

  /**
   * The colliders with `tag` whose boxes come within `radius` of (`x`, `y`) in world space, nearest first (by the distance from the
   * point to the box, 0 inside it; ties in the order the colliders joined the world). The colliders `ignore` draws itself (the
   * asking component's own, not those of components inside it) do not count. Each is its contact (`tag`, `owner`, `data`) with where its box's middle is and that distance; it can
   * be handed to `send` to reach that one collider. Boxes are where they were when the step's updates began, as for bodies.
   */
  nearby<Tag extends string>(tag: Tag, x: number, y: number, radius: number, ignore: GameObject | null = null): Nearby<Tag>[] {
    if (!(radius >= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    const index = this.#indexOf(tag);
    const found = index.within(x, y, radius, ignore);
    const out: Nearby<Tag>[] = new Array(found);
    const { colliders, boxes } = index;
    for (let i = 0; i < found; i++) {
      const at = NEAR[i] as number;
      const b = at * 4;
      out[i] = new NearbyResult(
        colliders[at] as Collider,
        index.ownerOf(at),
        (boxes[b] as number) + (boxes[b + 2] as number) / 2,
        (boxes[b + 1] as number) + (boxes[b + 3] as number) / 2,
        NEAR_DISTANCES[i] as number
      ) as unknown as Nearby<Tag>;
    }
    return out;
  }

  /**
   * Send `value` to the colliders with `tag` that `where` names: every one whose box comes within a circle (`{ x, y, radius }`), or the
   * one collider a `nearby` result is. Delivered to their `onReceive` at the end of this step's update phase (after every
   * `useUpdate` and timer), in the order sent, each send's receivers nearest first; a send made while delivering (from an
   * `onReceive`) is delivered after the ones before it, in the same step. A send from outside a tick (a collision callback) is
   * delivered at the end of the next step's update phase. A receiver that left the world by then hears nothing.
   */
  send<Tag extends string>(tag: Tag, where: SendTarget<Tag>, value: unknown): void {
    this.#sends.push({ tag, where, value });
  }

  /**
   * Deliver now what `send` has queued, instead of at the end of the next step's update phase: for a test that hands a component
   * a value between steps (`@tsengine/testing`'s `t.send`). A game never needs it.
   */
  deliverSends(): void {
    if (this.#sends.length > 0) this.#deliver();
  }

  /** What `send` has queued for the end of the update phase. */
  readonly #sends: { readonly tag: string; readonly where: SendTarget; readonly value: unknown }[] = [];

  #deliver(): void {
    let delivered = 0;
    // Sends made by receivers join the end of the queue, so every one is delivered in order, in this step.
    for (let i = 0; i < this.#sends.length; i++) {
      const { tag, where, value } = this.#sends[i]!;
      const one = colliderOfResult(where);
      const receivers: Collider[] =
        one !== undefined
          ? one.tag === tag && one.world === this
            ? [one]
            : []
          : "radius" in where
            ? this.#collidersWithin(tag, where.x, where.y, where.radius)
            : [];
      for (const receiver of receivers) {
        if (receiver.world !== this) continue;
        (receiver.onReceive as ((value: unknown) => void) | undefined)?.(value);
        if (++delivered > MAX_DELIVERIES)
          throw new Error(
            `More than ${MAX_DELIVERIES} values were delivered in one step: receivers are sending to each other without end (an onReceive that sends to its own tag?).`
          );
      }
    }
    this.#sends.length = 0;
  }

  /** The colliders with `tag` within `radius` of a point, nearest first: whom a send to a circle reaches. */
  #collidersWithin(tag: string, x: number, y: number, radius: number): Collider[] {
    if (!(radius >= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return [];
    const index = this.#indexOf(tag);
    const found = index.within(x, y, radius, null);
    const out: Collider[] = new Array(found);
    for (let i = 0; i < found; i++) out[i] = index.colliders[NEAR[i] as number] as Collider;
    return out;
  }

  /** `BodySpace`: the tag of something solid in `box` (`"tile"` for a solid tile), or null. */
  solidIn(box: Box, ignore: GameObject): string | null {
    for (const map of this.#tilemaps) {
      if (!map.solid) continue;
      const grid = findTilemap(map.map);
      if (grid === undefined) continue;
      const at = map.worldTransform();
      const { tileWidth, tileHeight } = grid.data;
      const left = Math.floor((box.x - at.x) / tileWidth);
      const right = Math.floor((box.x + box.width - 1 - at.x) / tileWidth);
      const top = Math.floor((box.y - at.y) / tileHeight);
      const bottom = Math.floor((box.y + box.height - 1 - at.y) / tileHeight);
      for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) if (grid.solidAt(col, row)) return "tile";
    }
    for (const collider of this.#indexOf(SOLID).query(box)) if (!isUnder(collider, ignore)) return collider.tag;
    return null;
  }

  /** The balls in this world (`useBall`), in the order they joined it; `stepBalls` solves them in an order of their own. */
  readonly #balls = new Set<Ball>();

  #turnedBall: Ball | null = null;

  /**
   * The first ball that was stepped inside a rotated or scaled parent, or null. A ball follows its parent's position only, so
   * it is then not where its picture is drawn; the player warns about it once.
   */
  get turnedBall(): Ball | null {
    return this.#turnedBall;
  }

  ballTurned(ball: Ball): void {
    this.#turnedBall ??= ball;
  }

  /** Called by a ball when its owner joins this world. */
  addBall(ball: Ball): void {
    this.#balls.add(ball);
  }

  removeBall(ball: Ball): void {
    this.#balls.delete(ball);
  }

  /** How many balls are in this world. */
  get ballCount(): number {
    return this.#balls.size;
  }

  /**
   * `BallSpace`: the solid boxes near a box in world space: every `<Collider solid>` (by its box: shapes are not used here) and the
   * solid tiles of every `<Tilemap solid>`. Colliders under `ignore` do not count.
   */
  solidBoxesNear(x: number, y: number, width: number, height: number, ignore: GameObject | null): SolidBox[] {
    const out: SolidBox[] = [];
    for (const map of this.#tilemaps) {
      if (!map.solid) continue;
      const grid = findTilemap(map.map);
      if (grid === undefined) continue;
      const at = map.worldTransform();
      const { tileWidth, tileHeight } = grid.data;
      const left = Math.floor((x - at.x) / tileWidth);
      const right = Math.floor((x + width - at.x) / tileWidth);
      const top = Math.floor((y - at.y) / tileHeight);
      const bottom = Math.floor((y + height - at.y) / tileHeight);
      for (let row = top; row <= bottom; row++)
        for (let col = left; col <= right; col++)
          if (grid.solidAt(col, row))
            out.push({ x: at.x + col * tileWidth, y: at.y + row * tileHeight, width: tileWidth, height: tileHeight });
    }
    for (const collider of this.#indexOf(SOLID).query({ x, y, width, height })) {
      if (ignore !== null && isUnder(collider, ignore)) continue;
      const at = collider.worldTransform();
      out.push({ x: at.x, y: at.y, width: collider.width, height: collider.height });
    }
    return out;
  }

  /** The balls with `tag` touching `ball` now, in no particular order (`Ball.stick`). */
  ballsTouching(ball: Ball, tag: string): Ball[] {
    const home = ball.origin();
    const ax = home.x + ball.x;
    const ay = home.y + ball.y;
    const out: Ball[] = [];
    for (const other of this.#balls) {
      if (other === ball || other.tag !== tag) continue;
      const o = other.origin();
      const dx = o.x + other.x - ax;
      const dy = o.y + other.y - ay;
      const reach = ball.radius + other.radius + BALL_TOUCH_TOLERANCE;
      if (dx * dx + dy * dy <= reach * reach) out.push(other);
    }
    return out;
  }

  /** The balls with `tag` touching `ball` now, nearest first, each where it is in `ball`'s parent's space. */
  ballContacts(ball: Ball, tag: string): BallContact[] {
    const home = ball.origin();
    const ax = home.x + ball.x;
    const ay = home.y + ball.y;
    const found: { contact: BallContact; d: number }[] = [];
    for (const other of this.#balls) {
      if (other === ball || other.tag !== tag) continue;
      const o = other.origin();
      const bx = o.x + other.x;
      const by = o.y + other.y;
      const dx = bx - ax;
      const dy = by - ay;
      const reach = ball.radius + other.radius + BALL_TOUCH_TOLERANCE;
      const d2 = dx * dx + dy * dy;
      if (d2 > reach * reach) continue;
      found.push({
        contact: { tag: other.tag, data: other.data, owner: other.ownerName, x: bx - home.x, y: by - home.y, radius: other.radius },
        d: d2,
      });
    }
    // Nearest first; ties by place, so the answer does not depend on the order the balls joined the world.
    found.sort((p, q) => p.d - q.d || p.contact.x - q.contact.x || p.contact.y - q.contact.y);
    return found.map((f) => f.contact);
  }

  /** `BodySpace`: whether a collider with this tag overlaps `box` (a shaped one, by its shape). */
  tagIn(box: Box, tag: string, ignore: GameObject): boolean {
    for (const collider of this.#indexOf(tag).query(box)) if (!isUnder(collider, ignore) && shapeOverlaps(collider, box)) return true;
    return false;
  }

  /** `BodySpace`: every collider with this tag that overlaps `box` (a shaped one, by its shape), in the order the colliders joined the world. */
  collidersIn(box: Box, tag: string, ignore: GameObject): Contact[] {
    const out: Contact[] = [];
    for (const collider of this.#indexOf(tag).query(box))
      if (!isUnder(collider, ignore) && shapeOverlaps(collider, box)) out.push(collider as unknown as Contact);
    return out;
  }

  /**
   * The colliders with a tag (or, for `SOLID`, the solid ones), with their boxes, on a grid: made on the first query for that tag
   * in an update phase and dropped with the boxes, so twenty towers asking about a hundred enemies look at the few near each, not
   * every collider in the world. What a query returns is in the order of `#colliders`, as a plain scan would give it.
   */
  #indexOf(tag: string): ColliderIndex {
    const indexes = (this.#indexes ??= new Map());
    let index = indexes.get(tag);
    if (index === undefined) {
      const colliders: Collider[] = [];
      for (const collider of this.#colliders) if (tag === SOLID ? collider.solid : collider.tag === tag) colliders.push(collider);
      const boxes = new Float64Array(colliders.length * 4);
      for (let i = 0; i < colliders.length; i++) {
        const collider = colliders[i] as Collider;
        const at = collider.parent === null ? collider.worldTransform() : collider.worldTransformIn(this.#spaceOf(collider.parent));
        boxes[i * 4] = at.x;
        boxes[i * 4 + 1] = at.y;
        boxes[i * 4 + 2] = collider.width;
        boxes[i * 4 + 3] = collider.height;
      }
      index = new ColliderIndex(colliders, boxes);
      indexes.set(tag, index);
    }
    return index;
  }

  /**
   * The space `object`'s children are placed in (`childSpace()`). An object with more than a few children has its space remembered
   * with the indexes: a thousand enemies' colliders share every object above their own entity, and composing each one's transform up
   * the tree from scratch was most of making an index. One with a few is worked out each time it is asked for: an enemy's entity is
   * asked once, by its one collider, and remembering it cost more than working it out.
   */
  #spaceOf(object: GameObject): WorldTransform {
    if (object === this.#spaceObject) return this.#space as WorldTransform;
    const shared = object.children.length > SHARED_SPACE;
    let space: WorldTransform | undefined;
    if (shared) {
      space = (this.#spaces ??= new Map()).get(object);
      if (space !== undefined) {
        this.#spaceObject = object;
        this.#space = space;
        return space;
      }
    }
    // An object that places its children its own way (a `Camera` is transparent to them) is asked.
    space =
      object.childSpace !== GameObject.prototype.childSpace || object.worldTransform !== GameObject.prototype.worldTransform
        ? object.childSpace()
        : object.parent === null
          ? object.worldTransform()
          : object.worldTransformIn(this.#spaceOf(object.parent));
    if (shared) {
      (this.#spaces as Map<GameObject, WorldTransform>).set(object, space);
      this.#spaceObject = object;
      this.#space = space;
    }
    return space;
  }

  /** The tree changed (a child added, removed or moved) or an object with handlers joined or left: the order handlers run in is made again. */
  orderChanged(): void {
    this.#order = null;
  }

  #treeOrder(): { readonly input: readonly GameObject[]; readonly update: readonly GameObject[] } {
    const input: GameObject[] = [];
    const update: GameObject[] = [];
    const stack: GameObject[] = [this.root];
    while (stack.length > 0) {
      const object = stack.pop() as GameObject;
      const handlers = object.worldHandlers;
      if ((handlers & HANDLES_INPUT) !== 0) input.push(object);
      if ((handlers & HANDLES_UPDATE) !== 0) update.push(object);
      const children = object.children;
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i] as GameObject;
        // A leaf with no hooks (a sprite, a collider) adds nothing: most of a crowd's objects.
        if (child.children.length > 0 || child.worldHandlers !== 0) stack.push(child);
      }
    }
    // An object registered but not under the root (it should not happen) still runs, after the rest, as it did before. Each object is
    // in the tree once, so when every registered one was found there is nothing to add, and no set of what was seen is needed.
    if (input.length !== this.#onInput.size) {
      const found = new Set(input);
      for (const object of this.#onInput) if (!found.has(object)) input.push(object);
    }
    if (update.length !== this.#onUpdate.size) {
      const found = new Set(update);
      for (const object of this.#onUpdate) if (!found.has(object)) update.push(object);
    }
    return { input, update };
  }

  registerObject(object: GameObject): void {
    if (object instanceof Collider) {
      this.#colliders.add(object);
      this.#indexes = null;
    } else if (object instanceof Tilemap) this.#tilemaps.add(object);
    if ("pressKey" in object && "focusable" in object) this.#pressables.add(object as GameObject & Pressable);
    object.worldHandlers = 0;
    if (object.onInput !== GameObject.prototype.onInput) {
      this.#onInput.add(object);
      object.worldHandlers |= HANDLES_INPUT;
    }
    if (object.onUpdate !== GameObject.prototype.onUpdate) {
      this.#onUpdate.add(object);
      object.worldHandlers |= HANDLES_UPDATE;
    }
    this.#order = null;
  }

  unregisterObject(object: GameObject): void {
    this.#timed.delete(object);
    if (object instanceof Collider) {
      this.#colliders.delete(object);
      this.#indexes = null;
    } else if (object instanceof Tilemap) this.#tilemaps.delete(object);
    this.#pressables.delete(object as GameObject & Pressable);
    if (this.#focused === object) this.#focused = null;
    if (this.#pressed === (object as unknown as Pressable)) this.#pressed = null;
    if (this.#heldPress?.pointer === (object as unknown as Pressable)) this.#heldPress = null;
    this.#onInput.delete(object);
    this.#onUpdate.delete(object);
    object.worldHandlers = 0;
    this.#order = null;
  }

  /** Process all pending work until the tree is stable. Returns the number of renders run. */
  flush(): number {
    let renders = 0;
    while (this.#dirty.length > 0 || this.#structure.size > 0) {
      const dirty = this.#dirty;
      this.#dirty = [];
      const pass = ++passes;
      const profiler = activeProfiler();
      if (profiler === null) {
        for (let i = 0; i < dirty.length; i++) if ((dirty[i] as GameObject).renderInPass(this, pass)) renders++;
      } else {
        for (let i = 0; i < dirty.length; i++) {
          const object = dirty[i] as GameObject;
          const started = profiler.now();
          if (!object.renderInPass(this, pass)) continue;
          renders++;
          profiler.add(object, PROFILE_RENDER, profiler.now() - started);
        }
      }
      const structure = [...this.#structure];
      this.#structure.clear();
      for (const object of structure) object.commitStructure();
    }
    // A save loaded with its tree (`createSave({ tree: true })`): the game state it applied has now built the tree, so its
    // components take their saved state back. `restoreHotState` flushes again; the restore was taken, so it runs once.
    const restore = takeTreeRestore(this);
    if (restore !== null) restoreHotState(this, restore.root, restore.state);
    this.#spaces = null;
    this.#spaceObject = null;
    this.#space = null;
    this.#indexes = null;
    return renders;
  }
}

/**
 * The focusable nearest to `from` in a direction: only those on that side of it count, and distance across the direction
 * counts double, so the focus goes along a row before it jumps to the next one. Null when there is none that way.
 */
function nearestInDirection(
  from: Pressable,
  candidates: readonly (GameObject & Pressable)[],
  dx: number,
  dy: number
): (GameObject & Pressable) | null {
  const here = from.focusPoint?.() ?? { x: 0, y: 0 };
  let best: (GameObject & Pressable) | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c === from) continue;
    const at = c.focusPoint?.() ?? { x: 0, y: 0 };
    const along = (at.x - here.x) * dx + (at.y - here.y) * dy;
    if (along <= 0) continue;
    const across = Math.abs((at.x - here.x) * dy) + Math.abs((at.y - here.y) * dx);
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** The farthest of `candidates` from `from` in a direction (the other end of a menu, to go round to), or null when none is that way. */
function farthestInDirection(
  from: Pressable,
  candidates: readonly (GameObject & Pressable)[],
  dx: number,
  dy: number
): (GameObject & Pressable) | null {
  const here = from.focusPoint?.() ?? { x: 0, y: 0 };
  let best: (GameObject & Pressable) | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (c === from) continue;
    const at = c.focusPoint?.() ?? { x: 0, y: 0 };
    const along = (at.x - here.x) * dx + (at.y - here.y) * dy;
    if (along <= 0) continue;
    const across = Math.abs((at.x - here.x) * dy) + Math.abs((at.y - here.y) * dx);
    const score = along - across * 2;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** The nearest `<Menu>` that holds `object` (not counting itself), or null. */
function menuOf(object: Pressable): Menu | null {
  for (let at = (object as unknown as GameObject).parent; at !== null; at = at.parent) if (at instanceof Menu) return at;
  return null;
}

/** Is `object` `root` or inside it? */
function isUnder(object: GameObject, root: GameObject): boolean {
  for (let at: GameObject | null = object; at !== null; at = at.parent) if (at === root) return true;
  return false;
}

/** Whether a collider found by its box overlaps `box` by its shape: always for a plain box, which the box already answers. */
function shapeOverlaps(collider: Collider, box: Box): boolean {
  if (collider.shape === "box") return true;
  const g = geometryOf(collider, collider.worldTransform());
  return g !== null && geometryOverlapsBox(g, box.x, box.y, box.width, box.height);
}

/**
 * The component a collider belongs to: the nearest object above it that is not a built-in (a compiled component's class has no
 * `intrinsic` of its own), or null.
 */
function componentOf(collider: Collider): GameObject | null {
  // Starting at the collider: a component whose root is the `<Collider>` is that collider.
  for (let at: GameObject | null = collider; at !== null; at = at.parent) if (!Object.hasOwn(at.constructor, "intrinsic")) return at;
  return null;
}

/**
 * A `nearby` result: the collider's contact (`tag`, `owner`, `data`), where its box's middle is and how far it is, and, hidden, the
 * collider itself, so `send` can reach that one. A private field and not a `WeakMap` from result to collider: putting each result in
 * a map cost about 200 times making it, and kept every result alive past the young generation, in a crowd where every enemy asks
 * for its neighbours every step. A copy of a result (a save, a snapshot) has no collider and reaches nothing, as a result kept past
 * its world does.
 */
class NearbyResult {
  readonly #collider: Collider;
  readonly tag: string;
  readonly owner: unknown;
  readonly data: unknown;
  readonly x: number;
  readonly y: number;
  readonly distance: number;

  constructor(collider: Collider, owner: string, x: number, y: number, distance: number) {
    this.#collider = collider;
    this.tag = collider.tag;
    this.owner = owner;
    this.data = collider.data;
    this.x = x;
    this.y = y;
    this.distance = distance;
  }

  static colliderOf(where: object): Collider | undefined {
    return #collider in where ? (where as NearbyResult).#collider : undefined;
  }
}

/** The collider a `nearby` result is, or undefined for anything else (a circle, a copy of a result). */
const colliderOfResult = (where: object): Collider | undefined => NearbyResult.colliderOf(where);

/** `GameObject.worldHandlers`: the world runs its `onInput`, its `onUpdate`. */
const HANDLES_INPUT = 1;
const HANDLES_UPDATE = 2;

/** More deliveries than this in one step is a loop of receivers sending to each other. */
const MAX_DELIVERIES = 100_000;

/** The key of the index of the solid colliders, whatever their tags (`solidIn`): not a tag a game can write. */
const SOLID = "\u0000solid";
/** The sides a collider index's cells may have, in pixels: about one and a half times its boxes' typical side, as a power of two. */
const MIN_CELL = 16;
const MAX_CELL = 64;
/** An object with more children than this has its child space remembered while an index is made (`World.#spaceOf`). */
const SHARED_SPACE = 4;
/** Fewer entries than this are not put on a grid, and a query looks at them all: a grid costs more than it saves. */
const SMALL = 16;

/**
 * What `ColliderIndex.within` found, nearest first: each one's place in the index's `colliders` and its distance, in arrays kept from
 * one query to the next, so a thousand enemies each asking for their neighbours make no garbage but the results they are given.
 */
const NEAR: number[] = [];
const NEAR_DISTANCES: number[] = [];

/** An object with no component, in `ColliderIndex`'s list of them (null is a component looked for and not found). */
const UNKNOWN = undefined;

/**
 * One grid of an index: some of its entries, each in the one cell its box's middle is in, with the boxes' edges in cell order in one
 * array. A query looks at the cells its area covers, widened by half the widest and half the tallest box here (`reachX`, `reachY`):
 * an entry is in one cell only, so none is met twice and nothing is written to say it was seen, and the edges of a cell's entries
 * are next to each other in memory. (Entries used to be in every cell their boxes touched, each an object with its box another: in a
 * crowd a query looked at twenty to find three, and each look was a read of memory that was not in the cache.)
 */
class Grid {
  readonly cell: number;
  readonly reachX: number;
  readonly reachY: number;
  /** The entries here (their places in the index), in cell order; within a cell, in the index's order. */
  readonly items: Int32Array;
  /** Left, top, right and bottom of each of `items`' boxes. */
  readonly edges: Float64Array;
  /** Where each cell's run of `items` starts (and, one past the last cell, where the last ends). */
  readonly #starts: Int32Array;
  /** The cells are a rectangle of `#cols` by `#rows` from (`#left`, `#top`), unless that would be mostly empty: then `#sparse` has each cell's place in `#starts`. */
  readonly #left: number;
  readonly #top: number;
  readonly #cols: number;
  readonly #rows: number;
  readonly #sparse: Map<number, number> | null;

  /** `members`: places in `boxes` (x, y, width, height each), ascending, all finite and none wider or taller than two cells. */
  constructor(members: readonly number[], boxes: Float64Array, cell: number) {
    const n = members.length;
    this.cell = cell;
    // Doubles: a cell far from the origin has a number no 32-bit integer holds.
    const cxs = new Float64Array(n);
    const cys = new Float64Array(n);
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let reachX = 0;
    let reachY = 0;
    for (let i = 0; i < n; i++) {
      const b = (members[i] as number) * 4;
      const halfW = (boxes[b + 2] as number) / 2;
      const halfH = (boxes[b + 3] as number) / 2;
      const cx = Math.floor(((boxes[b] as number) + halfW) / cell);
      const cy = Math.floor(((boxes[b + 1] as number) + halfH) / cell);
      cxs[i] = cx;
      cys[i] = cy;
      if (cx < left) left = cx;
      if (cx > right) right = cx;
      if (cy < top) top = cy;
      if (cy > bottom) bottom = cy;
      if (halfW > reachX) reachX = halfW;
      if (halfH > reachY) reachY = halfH;
    }
    this.reachX = reachX;
    this.reachY = reachY;
    this.#left = left;
    this.#top = top;
    const cols = right - left + 1;
    const rows = bottom - top + 1;
    this.#cols = cols;
    this.#rows = rows;
    // Which cell each member is in, as a place in `#starts`.
    const at = new Int32Array(n);
    let cells: number;
    if (cols * rows <= Math.max(1024, 16 * n)) {
      this.#sparse = null;
      cells = cols * rows;
      for (let i = 0; i < n; i++) at[i] = ((cys[i] as number) - top) * cols + ((cxs[i] as number) - left);
    } else {
      // A few colliders far apart: only the cells that hold something are kept.
      const sparse = (this.#sparse = new Map<number, number>());
      for (let i = 0; i < n; i++) {
        const key = cellKey(cxs[i] as number, cys[i] as number);
        let id = sparse.get(key);
        if (id === undefined) sparse.set(key, (id = sparse.size));
        at[i] = id;
      }
      cells = sparse.size;
    }
    // A counting sort by cell, which keeps the members of a cell in their order.
    const starts = (this.#starts = new Int32Array(cells + 1));
    for (let i = 0; i < n; i++) starts[(at[i] as number) + 1]!++;
    for (let c = 0; c < cells; c++) starts[c + 1]! += starts[c] as number;
    const next = starts.slice(0, cells);
    const items = (this.items = new Int32Array(n));
    const edges = (this.edges = new Float64Array(n * 4));
    for (let i = 0; i < n; i++) {
      const to = next[at[i] as number]!++;
      const member = members[i] as number;
      const b = member * 4;
      items[to] = member;
      edges[to * 4] = boxes[b] as number;
      edges[to * 4 + 1] = boxes[b + 1] as number;
      edges[to * 4 + 2] = (boxes[b] as number) + (boxes[b + 2] as number);
      edges[to * 4 + 3] = (boxes[b + 1] as number) + (boxes[b + 3] as number);
    }
  }

  /**
   * The runs of `items` that hold every entry whose middle is in the cells from (`x0`, `y0`) to (`x1`, `y1`), in pixels: pairs of
   * from and to in `RUNS`; returns how many numbers. All of `items` as one run when the area covers more cells than there are entries.
   */
  runs(x0: number, y0: number, x1: number, y1: number): number {
    const cell = this.cell;
    let left = Math.floor(x0 / cell);
    let right = Math.floor(x1 / cell);
    let top = Math.floor(y0 / cell);
    let bottom = Math.floor(y1 / cell);
    const starts = this.#starts;
    const sparse = this.#sparse;
    let count = 0;
    if (sparse === null) {
      const cols = this.#cols;
      left = Math.max(left - this.#left, 0);
      right = Math.min(right - this.#left, cols - 1);
      top = Math.max(top - this.#top, 0);
      bottom = Math.min(bottom - this.#top, this.#rows - 1);
      // Not a number (a query at infinity) fails every comparison and leaves no cells.
      if (!(left <= right && top <= bottom)) return 0;
      // The cells of a row are next to each other in `starts`: one run a row.
      for (let cy = top; cy <= bottom; cy++) {
        const from = starts[cy * cols + left] as number;
        const to = starts[cy * cols + right + 1] as number;
        if (from === to) continue;
        RUNS[count++] = from;
        RUNS[count++] = to;
      }
      return count;
    }
    const cells = (right - left + 1) * (bottom - top + 1);
    if (!(cells <= this.items.length)) {
      if (!(left <= right && top <= bottom)) return 0;
      RUNS[0] = 0;
      RUNS[1] = this.items.length;
      return 2;
    }
    for (let cy = top; cy <= bottom; cy++) {
      for (let cx = left; cx <= right; cx++) {
        const id = sparse.get(cellKey(cx, cy));
        if (id === undefined) continue;
        RUNS[count++] = starts[id] as number;
        RUNS[count++] = starts[id + 1] as number;
      }
    }
    return count;
  }
}

/** What `Grid.runs` answers with: kept from one query to the next. */
const RUNS: number[] = [];

/**
 * The colliders of one tag with their boxes, for queries. Each is on a grid whose cells are about one and a half times the typical
 * box's side; those more than two cells wide or tall are on a coarser grid of their own, sized to them the same way, and so on; a
 * last few (fewer than `SMALL`, or with a box that is not finite) are looked at by every query. In a crowd, a cell much bigger than
 * the boxes holds dozens of them, and every query looks at all of them.
 */
class ColliderIndex {
  /** The colliders, in the world's order: queries answer in this order, and a place here is what `NEAR` holds. */
  readonly colliders: readonly Collider[];
  /** Each collider's box: x, y, width and height. */
  readonly boxes: Float64Array;
  readonly #grids: Grid[] = [];
  /** The entries on no grid. */
  readonly #loose: number[] = [];
  /** The component each collider belongs to (`componentOf`), worked out the first time a query needs it. */
  #components: (GameObject | null | undefined)[] | null = null;
  /** Each collider's `owner`, likewise: it is a walk up the tree, and a crowd's `nearby` results name the same few over and over. */
  #owners: (string | undefined)[] | null = null;
  readonly #hits: number[] = [];
  readonly #out: Collider[] = [];

  constructor(colliders: readonly Collider[], boxes: Float64Array) {
    this.colliders = colliders;
    this.boxes = boxes;
    let rest: number[] = [];
    for (let i = 0; i < colliders.length; i++) {
      const b = i * 4;
      if (Number.isFinite((boxes[b] as number) + (boxes[b + 1] as number) + (boxes[b + 2] as number) + (boxes[b + 3] as number)))
        rest.push(i);
      else this.#loose.push(i);
    }
    for (let level = 0; rest.length >= SMALL; level++) {
      // Only the first grid's cells have a largest size: it keeps a query for a small area among large boxes to a few cells.
      const cell = cellSideFor(rest, boxes, level === 0 ? MAX_CELL : Infinity);
      const members: number[] = [];
      const larger: number[] = [];
      for (let i = 0; i < rest.length; i++) {
        const b = (rest[i] as number) * 4;
        if (Math.max(boxes[b + 2] as number, boxes[b + 3] as number) <= cell * 2) members.push(rest[i] as number);
        else larger.push(rest[i] as number);
      }
      // Past the first grid a cell is at least as large as the box it was sized by, so something always goes on it and this ends.
      if (members.length > 0) this.#grids.push(new Grid(members, boxes, cell));
      rest = larger;
    }
    if (rest.length > 0) {
      for (let i = 0; i < rest.length; i++) this.#loose.push(rest[i] as number);
      this.#loose.sort(ascending);
    }
  }

  /** The `owner` of the collider at `at`. */
  ownerOf(at: number): string {
    const owners = (this.#owners ??= new Array<string | undefined>(this.colliders.length).fill(undefined));
    return (owners[at] ??= (this.colliders[at] as Collider).owner);
  }

  /** The colliders whose boxes overlap `box`, in the world's order. The array is reused by the next query. */
  query(box: Box): readonly Collider[] {
    const hits = this.#hits;
    let found = 0;
    const x0 = box.x;
    const y0 = box.y;
    const x1 = box.x + box.width;
    const y1 = box.y + box.height;
    const grids = this.#grids;
    for (let g = 0; g < grids.length; g++) {
      const grid = grids[g] as Grid;
      const edges = grid.edges;
      const items = grid.items;
      const runs = grid.runs(x0 - grid.reachX, y0 - grid.reachY, x1 + grid.reachX, y1 + grid.reachY);
      for (let r = 0; r < runs; r += 2) {
        for (let i = RUNS[r] as number, end = RUNS[r + 1] as number; i < end; i++) {
          const e = i * 4;
          // `boxesOverlap`: touching edges do not.
          if (x0 < (edges[e + 2] as number) && (edges[e] as number) < x1 && y0 < (edges[e + 3] as number) && (edges[e + 1] as number) < y1)
            hits[found++] = items[i] as number;
        }
      }
    }
    const loose = this.#loose;
    const boxes = this.boxes;
    for (let i = 0; i < loose.length; i++) {
      const b = (loose[i] as number) * 4;
      const bx = boxes[b] as number;
      const by = boxes[b + 1] as number;
      if (x0 < bx + (boxes[b + 2] as number) && bx < x1 && y0 < by + (boxes[b + 3] as number) && by < y1)
        hits[found++] = loose[i] as number;
    }
    hits.length = found;
    if (found > 1) hits.sort(ascending);
    const out = this.#out;
    out.length = found;
    const colliders = this.colliders;
    for (let i = 0; i < found; i++) out[i] = colliders[hits[i] as number] as Collider;
    return out;
  }

  /**
   * The entries whose boxes come within `radius` of (`x`, `y`), not counting those `ignore` draws itself, into `NEAR` and
   * `NEAR_DISTANCES`, nearest first (ties in the world's order); returns how many. One pass over the cells the circle's bounds
   * cover (a pixel wider, so a box that just touches the circle is looked at), with no object made per entry.
   */
  within(x: number, y: number, radius: number, ignore: GameObject | null): number {
    let found = 0;
    // The square the circle is in, a hair wider than rounding could move a box that touches it.
    const pad = (Math.abs(x) + Math.abs(y) + radius) * 1e-9;
    const x0 = x - radius - pad;
    const x1 = x + radius + pad;
    const y0 = y - radius - pad;
    const y1 = y + radius + pad;
    const grids = this.#grids;
    for (let g = 0; g < grids.length; g++) {
      const grid = grids[g] as Grid;
      const edges = grid.edges;
      const items = grid.items;
      const reachX = radius + 1 + grid.reachX;
      const reachY = radius + 1 + grid.reachY;
      const runs = grid.runs(x - reachX, y - reachY, x + reachX, y + reachY);
      for (let r = 0; r < runs; r += 2) {
        for (let i = RUNS[r] as number, end = RUNS[r + 1] as number; i < end; i++) {
          const e = i * 4;
          const left = edges[e] as number;
          const top = edges[e + 1] as number;
          const right = edges[e + 2] as number;
          const bottom = edges[e + 3] as number;
          // Most of what the cells hold is out of reach, and which side of the point a box is on is a coin toss the processor cannot
          // guess: one test of all four sides costs half of what working out the distance of each did. (`+` and `|`, so that it is
          // one branch: `||`, or `? 1 : 0` on each, is four.)
          if ((+(left > x1) | +(right < x0) | +(top > y1) | +(bottom < y0)) !== 0) continue;
          // The distance from the point to the box (0 inside it). Not `Math.hypot`, which V8 runs several times slower.
          const dx = left > x ? left - x : x > right ? x - right : 0;
          const dy = top > y ? top - y : y > bottom ? y - bottom : 0;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance <= radius) found = this.#take(items[i] as number, distance, ignore, found);
        }
      }
    }
    const loose = this.#loose;
    const boxes = this.boxes;
    for (let i = 0; i < loose.length; i++) {
      const b = (loose[i] as number) * 4;
      const left = boxes[b] as number;
      const top = boxes[b + 1] as number;
      const right = left + (boxes[b + 2] as number);
      const bottom = top + (boxes[b + 3] as number);
      const dx = left > x ? left - x : x > right ? x - right : 0;
      const dy = top > y ? top - y : y > bottom ? y - bottom : 0;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= radius) found = this.#take(loose[i] as number, distance, ignore, found);
    }
    return found;
  }

  /**
   * `within`'s entry `at`, `distance` away: unless it is `ignore`'s own, into its place in the sorted run of `found` in `NEAR` (a
   * query finds a handful, so an insertion). Returns the new count.
   */
  #take(at: number, distance: number, ignore: GameObject | null, found: number): number {
    if (ignore !== null) {
      const components = (this.#components ??= new Array<GameObject | null | undefined>(this.colliders.length).fill(UNKNOWN));
      let component = components[at];
      if (component === UNKNOWN) component = components[at] = componentOf(this.colliders[at] as Collider);
      if (component === ignore) return found;
    }
    let i = found;
    // Nearer first, then in the world's order.
    while (i > 0) {
      const d = NEAR_DISTANCES[i - 1] as number;
      if (!(distance < d || (distance === d && at < (NEAR[i - 1] as number)))) break;
      NEAR[i] = NEAR[i - 1] as number;
      NEAR_DISTANCES[i] = d;
      i--;
    }
    NEAR[i] = at;
    NEAR_DISTANCES[i] = distance;
    return found + 1;
  }
}

const ascending = (a: number, b: number): number => a - b;

/**
 * A power of two about one and a half times the median longer side of the boxes at `members`, from `MIN_CELL` to `max`.
 */
function cellSideFor(members: readonly number[], boxes: Float64Array, max: number): number {
  // The median of a sample of up to 64 is enough to size the cells.
  const step = Math.max(1, Math.floor(members.length / 64));
  const sides: number[] = [];
  for (let i = 0; i < members.length; i += step) {
    const b = (members[i] as number) * 4;
    sides.push(Math.max(boxes[b + 2] as number, boxes[b + 3] as number));
  }
  sides.sort(ascending);
  const want = (sides[sides.length >> 1] as number) * 1.5;
  let cell = MIN_CELL;
  while (cell < want && cell < max) cell *= 2;
  return cell;
}

/** One number for a cell: distinct for any cell a game reaches (±32,768 cells, a million pixels each way); a clash would only cost a check. */
function cellKey(cx: number, cy: number): number {
  return (cx + 0x8000) * 0x10000 + (cy + 0x8000);
}
