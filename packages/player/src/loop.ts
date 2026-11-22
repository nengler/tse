import {
  activeProfiler,
  Flex,
  Game,
  Text,
  IDENTITY_TRANSFORM,
  WIDGET_NONE,
  World,
  captureHotState,
  objectAt,
  pathIn,
  setTextDefaults,
  getSoundSink,
  getStorage,
  setStorage,
  restoreHotState,
  setSoundSink,
  resetGameState,
  setGameTree,
  type Controls,
  type GameObject,
  type HotState,
  type Pressable,
  type SoundSink,
  type StorageSink,
  setInputDevice,
  setWindowSize,
  type ViewTransform,
} from "@tsengine/runtime";

import type { Backend, WindowConfig } from "./backend.ts";
import { CollisionTracker } from "./collide.ts";
import { MAGENTA, parseColor } from "./color.ts";
import { draggable, DrawList, estimateTextWidth, FrameBuilder, rootScreen, type BuiltFrame, type ColliderEntry } from "./draw.ts";
import { FixedDriver, MAX_STEPS_PER_FRAME } from "./fixed.ts";
import { HOST_RUN_KEY } from "./host.ts";
import { PlayerInput } from "./input.ts";
import { Interpolator } from "./interpolate.ts";
import { borderRoom } from "./layout.ts";
import { drawOverlay } from "./overlay.ts";
import {
  KEYS,
  TSE_IN_DT,
  TSE_IN_HEIGHT,
  TSE_IN_MOUSE_X,
  TSE_IN_MOUSE_Y,
  TSE_IN_QUIT,
  TSE_IN_WHEEL,
  TSE_IN_WIDTH,
  TSE_KEY_DOWN,
  TSE_KEY_PRESSED,
  KEY_INDEX,
} from "./protocol.ts";
import { onScreen, type ScreenPlacement } from "./screen.ts";
import { Warner } from "./warn.ts";

/** The window a game gets when neither its `<Game>` root nor the player's config say otherwise. */
export const DEFAULT_WINDOW = { width: 640, height: 360, title: "tse" } as const;

/**
 * What the player is configured with. Everything but `root` is optional, and is the fallback for what the root's own
 * `<Game>` leaves unset: a setting is the `<Game>` prop if it is written, else this, else the default.
 */
export interface PlayerConfig extends Partial<WindowConfig> {
  /**
   * Builds the root object. It is built **before** the window opens, because a root that is a `<Game>` says what window to
   * open; sounds it creates are recorded and preloaded as soon as the window is open.
   */
  readonly root: () => GameObject;
  /** The key that toggles full screen, as the `<Game>` prop of the same name; `false` turns it off. Default `"F11"` (Alt + Enter always works). */
  readonly fullscreenKey?: string | false;
  /** Steps per second for `useUpdate`, as the `<Game>` prop `fixedStep`; unset runs one update per frame. */
  readonly fixedStep?: number;
  /** Draw between fixed steps, as the `<Game>` prop `interpolate`. Default true in a visible window, false in a hidden one. */
  readonly interpolate?: boolean;
  /** The game's actions, as the `<Game>` prop `controls`. */
  readonly controls?: Controls;
  /** The game's id, as the `<Game>` prop `id`: the folder its save and settings are kept in. */
  readonly id?: string;
  /** The gamepad stick's dead zone, as the `<Game>` prop `gamepadDeadzone`. */
  readonly gamepadDeadzone?: number;
  /** How a pixel-perfect screen is scaled up at a scale that is not a whole number, as the `<Game>` prop `upscale`. */
  readonly upscale?: "nearest" | "sharp";
  /**
   * Development tools: the layout overlay, toggled by `<Game overlayKey>` (F1 by default). `tse dev` turns it on; a packaged build
   * never has it. Default false.
   */
  readonly devtools?: boolean;
  /** The frame-rate counter, as the `<Game>` props `showFps` and `fpsKey`. */
  readonly showFps?: boolean;
  readonly fpsKey?: string | false;
  /** A CSS colour. Default `"black"`. */
  readonly background?: string;
  /** Folder that image and sound names are relative to. Default `"assets"`. */
  readonly assets?: string;
  /** Where warnings go. Default `console.warn`. */
  readonly warn?: (message: string) => void;
  /** Reuse last frame's draw records for what has not changed; `"check"` also rebuilds each frame and throws on a difference. See `FrameBuilderOptions.retain`. Default `true`. */
  readonly retain?: boolean | "check";
  /**
   * What happens when the game throws (building its root, mounting it, or in a step). `true`: the window stays open and shows the
   * error and its stack until it is closed (see `Player.failure`). `false`: the error is thrown out of `createPlayer` or `step`.
   * Default `false` for `createPlayer`, so tests and tools see the error; `run` turns it on for a visible window.
   */
  readonly showErrors?: boolean;
  /** The last line of the error screen. Default "Close the window to quit." A host that reloads says how to. */
  readonly errorNote?: string;
}

export interface Player {
  readonly world: World;
  /** Run one frame. Returns false once the window has asked to close (that frame is still drawn). */
  step(): boolean;
  /**
   * Where what is labelled `label` is, in window pixels: the middle of the topmost thing that can be pressed and holds a `<Text>`
   * of exactly that text, as the last frame drew it. Null when there is none. What `click@Play` in an input script looks up.
   */
  pointOf(label: string): { readonly x: number; readonly y: number } | null;
  /** The text of every `<Text>` in something that can be pressed, as the last frame drew them, topmost first: what `pointOf` can find. */
  labels(): string[];
  /**
   * The error the game stopped with, while the window shows it (see `PlayerConfig.showErrors`); null while the game runs. The
   * world is left as the error found it and is not stepped, so a `reload` can still take its state.
   */
  readonly failure: { readonly error: unknown } | null;
  /**
   * Development rewind: what drives the steps besides the tree and the game state (the fixed step's carried time and key edges,
   * a freeze, the animation clock, the input for the next frame), to put back with `restoreTo`.
   */
  snapshotClock(): PlayerClock;
  /**
   * Development rewind: build `config.root` again in place of the current root, give it `hot` (a `captureHotState`) and put
   * `clock` back, so the next `step` runs as the frame after the snapshot did. The colliders that touch now are taken as already
   * touching (no enter is reported for them again). Returns false (and shows the error) if the build throws.
   */
  restoreTo(config: PlayerConfig, hot: HotState, clock: PlayerClock): boolean;
  /** Stop the game and show `error` in the window instead (a host's compile error, say), with `note` as the last line. */
  showError(error: unknown, note?: string): void;
  /**
   * Hot reload: build `config.root` again (from a newer build of the game's classes), put it in place of the current root in the
   * same window and world, and give each component the state its counterpart had (see `captureHotState`). The window's
   * settings stay as they were opened; the controls are taken from the new root. Returns false, and shows the error, if the
   * new root cannot be built or mounted; the state of the last good tree is kept for the next try. Clears an earlier failure.
   */
  reload(config: PlayerConfig): boolean;
  /** Close the window and detach from the runtime. Safe to call twice. */
  close(): void;
}

/** What `Player.snapshotClock` captures. */
export interface PlayerClock {
  readonly driver: FixedDriver | null;
  readonly animationTime: number;
  readonly frozen: number;
  readonly values: Float64Array;
  readonly keys: Uint8Array;
  /** Which pointer the mouse was over, by its path in the tree, or null. */
  readonly hovered: string | null;
}

/** The longest step a frame may simulate: a stall (a breakpoint, a dragged window) must not teleport things. */
export const MAX_DT = 0.1;

export { MAX_STEPS_PER_FRAME };

/** How many times larger than a root `<Screen>` the window opens when nothing sets its size. */
const DEFAULT_SCREEN_SCALE = 3;

const LEFT_BUTTON = KEY_INDEX.get("MouseLeft") as number;
const ENTER_KEY = KEY_INDEX.get("Enter") as number;
const ALT_KEY = KEY_INDEX.get("Alt") as number;

/**
 * Open the window and build the game. Each `step()` is one frame, in a fixed order:
 *
 * 1. a left press goes to the topmost `Pointer` drawn under the mouse last frame (`world.reportPress`), unless it
 *    landed on the bars around a root `<Screen>`;
 * 2. each step (`world.tick(dt, input)`: `useInput`, `useUpdate`, renders, structure; one a frame, or as many as the
 *    fixed step holds) is followed by the collisions it made: the tree is walked (which is where colliders are placed),
 *    contacts that started or ended are reported (`world.reportCollision`; see `CollisionTracker`), and what the
 *    callbacks changed is rendered at once, so the next step's `useUpdate` sees it. Contacts are therefore found at the
 *    same steps whatever the frame rate;
 * 3. the tree is walked into draw records (and the camera's view is taken): the last step's walk, or a new one when a
 *    collision callback changed something since, so a contact and what it caused are drawn in the same frame;
 * 4. the backend draws and presents the frame, then writes the next frame's input.
 *
 * The press uses last frame's pointers because that is what the player was looking at when they
 * clicked, and the input it carries is the state polled at the end of last frame.
 */
/** Whether `object` or anything under it is a `<Text>` reading exactly `label`. */
function holdsText(object: GameObject, label: string): boolean {
  if (object instanceof Text && object.text.trim() === label) return true;
  for (const child of object.children) if (holdsText(child, label)) return true;
  return false;
}

/** Adds the text of every `<Text>` at or under `object` to `found`, once each. */
function textsIn(object: GameObject, found: string[]): void {
  if (object instanceof Text && object.text.trim() !== "" && !found.includes(object.text.trim())) found.push(object.text.trim());
  for (const child of object.children) textsIn(child, found);
}

export function createPlayer(backend: Backend, config: PlayerConfig): Player {
  const warner = new Warner(config.warn);
  // Each game starts with nothing pressed yet (`getInputDevice()`), whatever an earlier player in this process was using.
  setInputDevice("pointer");

  // Build the root first: if it is a `<Game>`, its props say what window to open. Sounds it creates only record their
  // paths for now; they are loaded below, once the window is open. Each game starts from the game state's initial
  // values, whatever an earlier player in this process left behind.
  const preload: string[] = [];
  const preloadMusic: string[] = [];
  const collector: SoundSink = {
    load: (name) => void preload.push(name),
    play: () => {},
    loadMusic: (name) => void preloadMusic.push(name),
  };
  setSoundSink(collector);
  resetGameState();
  const showErrors = config.showErrors ?? false;
  let failure: { error: unknown; note: string } | null = null;
  const defaultNote = config.errorNote ?? "Close the window to quit.";
  let root: GameObject | null = null;
  try {
    root = config.root();
  } catch (error) {
    if (getSoundSink() === collector) setSoundSink(null);
    if (!showErrors) throw error;
    // Open a window anyway, from the config alone, to say what went wrong.
    failure = { error, note: defaultNote };
  }
  const game = root instanceof Game ? root : null;
  // The size and colour of every <Text> that sets none, as the font is: the root's, for this game (a process may run several).
  setTextDefaults({ size: game?.textSize, color: game?.textColor });
  // Each setting: the `<Game>` prop where it is written, else the player's config, else the default.
  // With nothing set, a game with a `<Screen>` opens at 3 × its resolution, so each game pixel is 3 × 3 window pixels.
  const screen0 = root === null ? null : rootScreen(root);
  const fromScreen =
    screen0 !== null && screen0.width > 0 && screen0.height > 0 && Number.isFinite(screen0.width) && Number.isFinite(screen0.height);
  const width = game?.width ?? config.width ?? (fromScreen ? Math.round(screen0.width * DEFAULT_SCREEN_SCALE) : DEFAULT_WINDOW.width);
  const height = game?.height ?? config.height ?? (fromScreen ? Math.round(screen0.height * DEFAULT_SCREEN_SCALE) : DEFAULT_WINDOW.height);
  const assets = game?.assets ?? config.assets ?? "assets";
  const background = resolveBackground(game?.background ?? config.background ?? "black", warner);

  backend.open({
    width,
    height,
    title: game?.title ?? config.title ?? DEFAULT_WINDOW.title,
    resizable: game?.resizable ?? config.resizable,
    vsync: game?.vsync ?? config.vsync,
    hidden: config.hidden,
    highDpi: config.highDpi,
    smooth: game?.smooth ?? config.smooth,
    sharp: (game?.upscale ?? config.upscale) === "sharp" ? true : undefined,
  });

  // Saved data: open the game's folder and let saves and settings write through it, before the tree is mounted, so settings are
  // applied before the first frame.
  const gameId = game?.id ?? config.id;
  let storageSink: StorageSink | null = null;
  if (gameId !== undefined && backend.storage !== undefined) {
    const storage = backend.storage;
    if (storage.open(gameId)) {
      storageSink = {
        read: (name) => storage.read(name),
        write: (name, text) => storage.write(name, text),
        remove: (name) => storage.remove(name),
        setFullscreen: (on) => {
          if (!backend.setFullscreen) return false;
          if (on === fullscreen) return true;
          if (backend.setFullscreen(on)) fullscreen = on;
          return fullscreen === on;
        },
      };
    } else
      warner.once(
        "storage",
        `Saved data is not available: the folder for the game id '${gameId}' could not be opened (the id is 1 to 64 letters, digits, _ and -).`
      );
  } else if (gameId !== undefined)
    warner.once("storage", "This host has no saved data (its backend has no storage): nothing will be kept between runs.");
  const deadzone = game?.gamepadDeadzone ?? config.gamepadDeadzone;
  if (deadzone !== undefined) backend.setGamepadDeadzone?.(deadzone);
  const stepHz = game?.fixedStep ?? config.fixedStep;
  const input = new PlayerInput(warner);
  input.controls = game?.controls ?? config.controls;
  // With a fixed timestep a handler sees a copy of the key flags per step, made by the driver (`fixed.ts`): a press between
  // steps is never lost and never seen twice, and one made in a freeze reaches `onUpdate` in the first step after it.
  const driver = stepHz === undefined ? null : new FixedDriver(stepHz, KEYS.length);
  const interpolator =
    driver !== null && (game?.interpolate ?? config.interpolate ?? !(config.hidden ?? false)) ? new Interpolator() : null;
  input.values[TSE_IN_WIDTH] = width;
  input.values[TSE_IN_HEIGHT] = height;
  // The window this game opened, whatever an earlier player in this process left (`getWindowSize()`); each frame keeps it up to date.
  setWindowSize(width, height);
  const builder = new FrameBuilder({
    loadTexture: (path) => backend.loadTexture(path),
    loadShader: (path) => backend.loadShader?.(path) ?? -2,
    measureText: backend.measureText ? (text, size) => backend.measureText!(text, size) : undefined,
    textureSize: backend.textureSize ? (handle) => backend.textureSize!(handle) : undefined,
    assets,
    font: game?.font,
    warn: config.warn,
    retain: config.retain,
  });
  const sink = createSoundSink(backend, assets, warner);
  const world = new World();
  // The host's broad phase when it has one; the tracker sweeps in script otherwise.
  let collisions = new CollisionTracker(
    undefined,
    true,
    true,
    backend.overlaps ? (boxes, count, order, pairs) => backend.overlaps!(boxes, count, order, pairs) : undefined
  );
  /** The last step's walk, kept to be drawn when nothing has changed since; `stale` once a collision callback ran after it. */
  let lastBuilt: BuiltFrame | null = null;
  let stale = false;
  /** Seconds of game time that have passed (each step's `dt`, capped as the ticks are): the clock a `<Flex transition>` fades by. */
  let animationTime = 0;
  /**
   * The collisions of the step that just ran: walk the tree (which places the colliders), report the contacts that started and
   * ended, and render what the callbacks changed, so the next step, and this frame's drawing, see it.
   */
  const collide = (): void => {
    const profiler = activeProfiler();
    const started = profiler?.now() ?? 0;
    // Drawn from blended transforms, a frame is built again anyway: the step's colliders are placed without drawing anything, unless
    // the world has a box laid out (`colliders` says null). `retain: "check"` builds as well and requires the same colliders.
    const placed = interpolator !== null ? builder.colliders(world.root) : null;
    if (placed !== null && config.retain === "check")
      sameColliders(placed, builder.build(world.root, input.width, input.height, animationTime).colliders);
    if (placed === null) lastBuilt = builder.build(world.root, input.width, input.height, animationTime);
    else lastBuilt = null;
    collisions.update(world, placed ?? (lastBuilt as BuiltFrame).colliders);
    stale = collisions.reported > 0;
    if (stale) world.flush();
    if (profiler !== null) profiler.phase("collisions", profiler.now() - started);
  };
  /** A step of the world (`useInput`, `useUpdate`, the renders they cause), timed when the profiler is on. */
  const tick = (dt: number, beforeUpdate?: () => void): void => {
    input.beginStep(dt);
    const profiler = activeProfiler();
    const started = profiler === null ? 0 : profiler.now();
    world.tick(dt, input, beforeUpdate);
    if (profiler !== null) profiler.phase("steps", profiler.now() - started);
    const turned = world.turnedBall;
    if (turned !== null)
      warner.once(
        "ball-turned",
        `A ball (useBall) in ${turned.owner?.constructor.name ?? "a component"} is inside a rotated or scaled parent. A ball follows its parent's position only, so it is not where its picture is drawn: keep balls and solid colliders outside the turned entity, and turn what is drawn.`
      );
  };
  let pointers: readonly Pressable[] = [];
  let hudPointersFrom = 0;
  let scrollers: readonly Flex[] = [];
  let hudScrollersFrom = 0;
  let hasClips = false;
  let hudView: ViewTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  let screen: ScreenPlacement | null = null;
  let closed = false;
  let fullscreen = false;
  const fullscreenSetting = game?.fullscreenKey ?? config.fullscreenKey ?? "F11";
  const fullscreenKey = fullscreenSetting === false ? undefined : KEY_INDEX.get(fullscreenSetting);
  if (typeof fullscreenSetting === "string" && fullscreenKey === undefined) {
    warner.once(
      `fullscreenKey:${fullscreenSetting}`,
      `Unknown fullscreenKey '${fullscreenSetting}': only Alt + Enter toggles full screen.`
    );
  }

  /** The full-screen key (or Alt + Enter) was pressed last frame: switch, and keep the switch only if the window did. */
  const toggleFullscreen = (): void => {
    if (!backend.setFullscreen) return;
    const pressed = (index: number | undefined): boolean => index !== undefined && ((input.keys[index] as number) & TSE_KEY_PRESSED) !== 0;
    const altEnter = pressed(ENTER_KEY) && ((input.keys[ALT_KEY] as number) & TSE_KEY_DOWN) !== 0;
    if (!pressed(fullscreenKey) && !altEnter) return;
    if (backend.setFullscreen(!fullscreen)) fullscreen = !fullscreen;
  };

  // The frame-rate counter: the frame rate from the time the backend measures between frames, and what the script cost (the step, without the backend's draw and wait), each smoothed.
  let showFps = game?.showFps ?? config.showFps ?? false;
  // The development overlay: only with `devtools` (tse dev), toggled by its key.
  const overlaySetting = config.devtools === true ? (game?.overlayKey ?? "F1") : false;
  const overlayKey = overlaySetting === false ? undefined : KEY_INDEX.get(overlaySetting);
  let overlay = false;
  const fpsSetting = game?.fpsKey ?? config.fpsKey ?? "F3";
  const fpsKey = fpsSetting === false ? undefined : KEY_INDEX.get(fpsSetting);
  let smoothDt = 0;
  let smoothMs = 0;
  const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (getSoundSink() === sink) setSoundSink(null);
    if (storageSink !== null && getStorage() === storageSink) setStorage(null);
    backend.close();
  };

  setSoundSink(sink);
  if (storageSink !== null) setStorage(storageSink);
  for (const name of preload) sink.load(name);
  for (const name of preloadMusic) sink.loadMusic?.(name);
  /** The root in the world, or null when building or mounting the last one failed. */
  let current: GameObject | null = null;
  /** The state of the last tree that was in the world, for the next reload when there is no tree to take it from. */
  let lastState: HotState = new Map();
  if (root !== null) {
    try {
      world.mount(root);
      current = root;
      setGameTree(world, root);
    } catch (error) {
      if (!showErrors) {
        close();
        throw error;
      }
      failure = { error, note: defaultNote };
    }
  }

  // The error screen: the error's lines, wrapped to the window, drawn in window pixels over a dark red background.
  const errorList = new DrawList();
  let errorLayout: { readonly key: string; readonly lines: readonly ErrorLine[] } | null = null;
  const measure = (text: string, size: number): number =>
    backend.measureText ? backend.measureText(text, size).width : estimateTextWidth(text, size);
  const drawError = (shown: { error: unknown; note: string }): void => {
    const width = input.width;
    const height = input.height;
    const key = `${width}x${height}`;
    if (errorLayout === null || errorLayout.key !== key)
      errorLayout = { key, lines: layoutError(shown.error, shown.note, width, height, measure) };
    errorList.reset();
    errorList.view({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    for (const line of errorLayout.lines)
      errorList.text({ x: line.x, y: line.y, rotation: 0, scaleX: 1, scaleY: 1 }, line.text, line.size, line.color);
    backend.frame(ERROR_BACKGROUND, errorList.records, errorList.length, errorList.texts, input.values, input.keys);
  };
  const fail = (error: unknown, note: string = defaultNote): { error: unknown; note: string } => {
    errorLayout = null;
    return (failure = { error, note });
  };

  /** Where the pointer is for a pressable, in its layer's coordinates (the HUD's for one in a `<Hud>`), or null for one no longer drawn. */
  const pointFor = (pointer: Pressable): { readonly x: number; readonly y: number } | null => {
    const index = pointers.indexOf(pointer);
    if (index < 0) return null;
    return index >= hudPointersFrom
      ? input.pointThrough(hudView, input.screenX, input.screenY)
      : input.worldPoint(input.screenX, input.screenY);
  };
  // Where the pointer was when the held pressable was last told (`onDragStart` or `onDrag`): `onDrag` is called only when it has moved.
  let dragX = 0;
  let dragY = 0;

  const dispatchPress = (): void => {
    // The button is up (or was let go since the last step): nothing is pressed any more. A press this step sets it again below.
    if (((input.keys[LEFT_BUTTON] as number) & (TSE_KEY_DOWN | TSE_KEY_PRESSED)) === 0) {
      const held = world.pressed;
      if (held !== null && held.onDragEnd !== undefined && held.world === world) {
        const point = pointFor(held);
        if (point !== null) held.onDragEnd(point.x, point.y);
      }
      world.reportRelease();
    }
    if (((input.keys[LEFT_BUTTON] as number) & TSE_KEY_PRESSED) === 0) return;
    if (screen !== null && !onScreen(screen, input.screenX, input.screenY)) return;
    const at = input.worldPoint(input.screenX, input.screenY);
    const hudAt = input.pointThrough(hudView, input.screenX, input.screenY);
    // The last pointer drawn is on top, so it gets the press; one press, one pointer. A HUD is drawn after the world, so its pointers come last.
    // A <Flex> collected only for its hover callbacks lets the press through to what is under it.
    for (let i = pointers.length - 1; i >= 0; i--) {
      const pointer = pointers[i] as Pressable;
      if (pointer.onPress === undefined && pointer instanceof Flex && pointer.widget === WIDGET_NONE && !draggable(pointer)) continue;
      const point = i >= hudPointersFrom ? hudAt : at;
      if (clippedOff(pointer as unknown as GameObject, point.x, point.y)) continue;
      // Over a box a drag would scroll, the press is heard when the button is let go, and not at all if the drag scrolls
      // (`dispatchScrollDrag`), as a tap and a scroll are told apart on a phone. A pressable that takes drags keeps them.
      const held = !draggable(pointer) && (pointer as Pressable).onHeldAt === undefined && scrollerAt(at, hudAt) !== null;
      if (world.reportPress(pointer, point.x, point.y, held)) {
        dragX = point.x;
        dragY = point.y;
        input.pressHandledNext = true;
        // A disabled one swallows the press without becoming the pressed one: it is still what the press landed on.
        world.reportPressOutside(pointer);
        return;
      }
    }
    world.reportPressOutside(null);
  };

  /** Whether a point is cut off from `object` by an ancestor that clips (`overflow`): a part of a child outside the box that clips it cannot be pressed or hovered. */
  const clippedOff = (object: GameObject, x: number, y: number): boolean => {
    if (!hasClips) return false;
    for (let up = object.parent; up !== null; up = up.parent) {
      if (up instanceof Flex && up.overflow !== "visible" && !up.contains(x, y, borderRoom(up))) return true;
    }
    return false;
  };

  /** Pixels one notch of the mouse wheel scrolls a box. */
  const SCROLL_STEP = 32;

  /**
   * The wheel scrolls the topmost `overflow="scroll"` box under the mouse that can still move that way (up and down when it can,
   * else left and right); one already at its end passes the wheel on to the box around it, as a browser does.
   */
  const dispatchWheel = (): void => {
    const wheel = input.values[TSE_IN_WHEEL] as number;
    if (!(wheel !== 0) || scrollers.length === 0) return;
    if (screen !== null && !onScreen(screen, input.screenX, input.screenY)) return;
    const at = input.worldPoint(input.screenX, input.screenY);
    const hudAt = input.pointThrough(hudView, input.screenX, input.screenY);
    for (let i = scrollers.length - 1; i >= 0; i--) {
      const box = scrollers[i] as Flex;
      if (box.world !== world || world.isInert(box)) continue;
      const point = i >= hudScrollersFrom ? hudAt : at;
      if (!box.contains(point.x, point.y) || clippedOff(box, point.x, point.y)) continue;
      const max = box.box.scrollMax;
      const axis = (max[1] as number) > 0 ? 1 : 0;
      if (!((max[axis] as number) > 0)) continue;
      const before = axis === 1 ? box.scrollY : box.scrollX;
      const after = Math.min(Math.max(before - wheel * SCROLL_STEP, 0), max[axis] as number);
      if (after === before) continue; // at its end that way: the box around it may still move
      if (axis === 1) box.scrollY = after;
      else box.scrollX = after;
      return;
    }
  };

  /**
   * The topmost `overflow="scroll"` box under the pointer that has something to scroll, whether it is in the HUD, and the
   * pointer in its layer's coordinates; null for none. `at` and `hudAt` are the pointer in the world's and the HUD's.
   */
  const scrollerAt = (
    at: { readonly x: number; readonly y: number },
    hudAt: { readonly x: number; readonly y: number }
  ): { box: Flex; hud: boolean; point: { readonly x: number; readonly y: number } } | null => {
    for (let i = scrollers.length - 1; i >= 0; i--) {
      const box = scrollers[i] as Flex;
      if (box.world !== world || world.isInert(box)) continue;
      const hud = i >= hudScrollersFrom;
      const point = hud ? hudAt : at;
      if (!box.contains(point.x, point.y) || clippedOff(box, point.x, point.y)) continue;
      const max = box.box.scrollMax;
      if (!((max[0] as number) > 0 || (max[1] as number) > 0)) continue;
      return { box, hud, point };
    }
    return null;
  };

  /** How far the mouse (a finger) must move while held before the drag scrolls the box under it, in the box's pixels: less is a tap. */
  const SCROLL_SLOP = 6;
  /**
   * The scroll box a held press began over, and where: the pointer then (in its layer's coordinates) and how far the box was
   * scrolled. `scrolling` once the drag has gone past `SCROLL_SLOP`, from where it was at that moment. Null for none.
   */
  let grab: { box: Flex; hud: boolean; x: number; y: number; fromX: number; fromY: number; scrolling: boolean } | null = null;

  /**
   * A drag scrolls the topmost `overflow="scroll"` box it began over that has something to scroll, as a finger scrolls a page:
   * the content follows the pointer, both ways the box overflows, to its ends. A touch is the left button, so a mouse drags
   * it too. A press that a pressable takes as a drag (a slider's thumb, `onDragStart` / `onDrag` / `onDragEnd`) does not scroll,
   * and once a drag scrolls, the pressable it began on is no longer pressed (its `pressed*` look ends) and never hears the press:
   * over a box with something to scroll, a press waits for the button to be let go (`dispatchPress`), so a drag that begins on
   * a row of a list, or on a card whose text scrolls, scrolls it without choosing it.
   */
  const dispatchScrollDrag = (): void => {
    const keys = input.keys[LEFT_BUTTON] as number;
    if ((keys & TSE_KEY_PRESSED) !== 0) {
      grab = null;
      const held = world.pressed;
      if (scrollers.length === 0 || (held !== null && (draggable(held) || held.onHeldAt !== undefined))) return;
      if (screen !== null && !onScreen(screen, input.screenX, input.screenY)) return;
      const under = scrollerAt(input.worldPoint(input.screenX, input.screenY), input.pointThrough(hudView, input.screenX, input.screenY));
      if (under === null) return;
      const { box, hud, point } = under;
      grab = { box, hud, x: point.x, y: point.y, fromX: box.scrollX, fromY: box.scrollY, scrolling: false };
      return;
    }
    if (grab === null) return;
    const { box } = grab;
    if ((keys & TSE_KEY_DOWN) === 0 || box.world !== world) {
      grab = null;
      return;
    }
    const point = grab.hud ? input.pointThrough(hudView, input.screenX, input.screenY) : input.worldPoint(input.screenX, input.screenY);
    if (!grab.scrolling) {
      if (Math.hypot(point.x - grab.x, point.y - grab.y) <= SCROLL_SLOP) return;
      // From here, not from where the press went down: the content does not jump by the slop.
      grab = { ...grab, x: point.x, y: point.y, fromX: box.scrollX, fromY: box.scrollY, scrolling: true };
      world.cancelPress();
    }
    const max = box.box.scrollMax;
    const clamp = (v: number, end: number): number => Math.min(Math.max(v, 0), end);
    if ((max[0] as number) > 0) box.scrollX = clamp(grab.fromX - (point.x - grab.x), max[0] as number);
    if ((max[1] as number) > 0) box.scrollY = clamp(grab.fromY - (point.y - grab.y), max[1] as number);
  };

  /**
   * A press that is still held keeps telling the pressable it began on where the mouse is, wherever the mouse has gone: a slider's
   * thumb follows it out of the box (`onHeldAt`, every step), and a drag hears each move (`onDrag`, when the mouse is somewhere new).
   * Pressing it already told it once (`onPressAt`, `onDragStart`).
   */
  const dispatchDrag = (): void => {
    const held = world.pressed;
    if (held === null || (held.onHeldAt === undefined && held.onDrag === undefined)) return;
    if (((input.keys[LEFT_BUTTON] as number) & TSE_KEY_DOWN) === 0) return;
    const point = pointFor(held);
    if (point === null) return;
    held.onHeldAt?.(point.x, point.y);
    if (held.onDrag === undefined || (point.x === dragX && point.y === dragY)) return;
    dragX = point.x;
    dragY = point.y;
    held.onDrag(point.x, point.y);
  };

  /** The topmost pressable under the mouse, as last frame drew them, is the hovered one: `onPointerEnter` and `onPointerLeave` when it changes. */
  const dispatchHover = (): void => {
    let hovered: Pressable | null = null;
    if (screen === null || onScreen(screen, input.screenX, input.screenY)) {
      const at = input.worldPoint(input.screenX, input.screenY);
      const hudAt = input.pointThrough(hudView, input.screenX, input.screenY);
      // Every pressable is asked every frame, topmost first, and each answer needs where its parent is. Neighbours in the list are
      // mostly siblings (the tiles of a grid, the rows of a menu), so the parent's space is worked out once for a run of them.
      let siblingsOf: GameObject | null | undefined;
      let space = IDENTITY_TRANSFORM;
      for (let i = pointers.length - 1; i >= 0 && hovered === null; i--) {
        const pointer = pointers[i] as Pressable;
        if (pointer.world !== world) continue;
        const point = i >= hudPointersFrom ? hudAt : at;
        let over: boolean;
        if (pointer.containsIn === undefined) over = pointer.contains(point.x, point.y);
        else {
          const parent = (pointer as unknown as GameObject).parent;
          if (parent !== siblingsOf) {
            siblingsOf = parent;
            space = parent === null ? IDENTITY_TRANSFORM : parent.childSpace();
          }
          over = pointer.containsIn(space, point.x, point.y);
        }
        if (over && !clippedOff(pointer as unknown as GameObject, point.x, point.y)) hovered = pointer;
      }
    }
    world.reportHover(hovered);
  };

  return {
    world,
    get failure() {
      return failure === null ? null : { error: failure.error };
    },
    showError(error: unknown, note?: string): void {
      fail(error, note);
    },
    labels(): string[] {
      const found: string[] = [];
      for (let i = pointers.length - 1; i >= 0; i--) {
        const pointer = pointers[i] as Pressable;
        if (pointer.world === world && pointer.focusPoint !== undefined) textsIn(pointer as unknown as GameObject, found);
      }
      return found;
    },
    pointOf(label: string): { readonly x: number; readonly y: number } | null {
      // The last one drawn is on top, as for a press.
      for (let i = pointers.length - 1; i >= 0; i--) {
        const pointer = pointers[i] as Pressable;
        if (pointer.world !== world || pointer.focusPoint === undefined || !holdsText(pointer as unknown as GameObject, label)) continue;
        const at = pointer.focusPoint();
        const view = i >= hudPointersFrom ? hudView : input.view;
        return { x: view.a * at.x + view.c * at.y + view.e, y: view.b * at.x + view.d * at.y + view.f };
      }
      return null;
    },
    snapshotClock(): PlayerClock {
      const hovered = world.hovered as unknown as GameObject | null;
      return {
        driver: driver?.clone() ?? null,
        animationTime,
        frozen: world.frozenSteps,
        values: input.values.slice(),
        keys: input.keys.slice(),
        hovered: hovered !== null && current !== null ? pathIn(current, hovered) : null,
      };
    },
    restoreTo(next: PlayerConfig, hot: HotState, clock: PlayerClock): boolean {
      if (closed) throw new Error("The player is closed.");
      let fresh: GameObject;
      try {
        fresh = next.root();
        if (current !== null) {
          const old = current;
          current = null;
          world.root.removeChild(old);
        }
        world.mount(fresh);
        current = fresh;
        setGameTree(world, fresh);
        restoreHotState(world, fresh, hot);
      } catch (error) {
        fail(error);
        return false;
      }
      if (driver !== null && clock.driver !== null) driver.copyFrom(clock.driver);
      animationTime = clock.animationTime;
      world.frozenSteps = clock.frozen;
      input.values.set(clock.values);
      input.keys.set(clock.keys);
      // What touches now was touching when the snapshot was taken: a tracker that starts from it reports no enter for it.
      collisions = new CollisionTracker(
        undefined,
        true,
        true,
        backend.overlaps ? (boxes, count, order, pairs) => backend.overlaps!(boxes, count, order, pairs) : undefined
      );
      const settled = builder.build(world.root, input.width, input.height, animationTime);
      collisions.update({ reportCollision() {}, reportCollisionExit() {} } as unknown as World, settled.colliders);
      // The pointer the mouse was over when the snapshot was taken is the hovered one again, and nobody hears it enter.
      pointers = settled.pointers;
      hudPointersFrom = settled.hudPointersFrom;
      hudView = settled.hudView;
      screen = settled.screen;
      input.view = settled.view;
      const hovered = clock.hovered === null ? null : objectAt(fresh, clock.hovered);
      world.reportHover(hovered as unknown as Pressable | null, true);
      lastBuilt = null;
      stale = false;
      failure = null;
      return true;
    },
    reload(next: PlayerConfig): boolean {
      if (closed) throw new Error("The player is closed.");
      try {
        if (current !== null) lastState = captureHotState(current);
      } catch {
        // A tree the error left half-built may not say what it holds: keep the last state that could be read.
      }
      let fresh: GameObject;
      try {
        fresh = next.root();
      } catch (error) {
        fail(error);
        return false;
      }
      try {
        if (current !== null) {
          const old = current;
          // A timer's callback closes over the instance that set it, which the reload replaces: pending timers do not carry over.
          const timers = countTimers(old);
          if (timers > 0)
            config.warn?.(
              `Hot reload dropped ${timers} pending timer${timers === 1 ? "" : "s"} (after, every): a timer calls code of the components it replaced. State is kept; set the timer again if it is still wanted.`
            );
          current = null;
          world.root.removeChild(old);
        }
        world.mount(fresh);
        current = fresh;
        setGameTree(world, fresh);
        restoreHotState(world, fresh, lastState);
      } catch (error) {
        fail(error);
        return false;
      }
      const nextGame = fresh instanceof Game ? fresh : null;
      input.controls = nextGame?.controls ?? next.controls ?? input.controls;
      builder.font = nextGame?.font;
      setTextDefaults({ size: nextGame?.textSize, color: nextGame?.textColor });
      failure = null;
      return true;
    },
    step(): boolean {
      if (closed) throw new Error("The player is closed.");
      if (failure !== null) {
        drawError(failure);
        return input.values[TSE_IN_QUIT] === 0;
      }
      if (!showErrors) return stepGame();
      try {
        return stepGame();
      } catch (error) {
        drawError(fail(error));
        return input.values[TSE_IN_QUIT] === 0;
      }
    },
    close,
  };

  function stepGame(): boolean {
    const started = clock();
    // Before anything steps, so a handler and a render this frame see the window as it is now (a phone turned, a window dragged).
    setWindowSize(input.width, input.height);
    toggleFullscreen();
    if (fpsKey !== undefined && ((input.keys[fpsKey] as number) & TSE_KEY_PRESSED) !== 0) showFps = !showFps;
    if (overlayKey !== undefined && ((input.keys[overlayKey] as number) & TSE_KEY_PRESSED) !== 0) {
      overlay = !overlay;
      builder.inspecting = overlay;
      stale = true; // draw this frame again, with the boxes listed
    }
    const realDt = input.values[TSE_IN_DT] as number;
    if (realDt > 0) smoothDt = smoothDt === 0 ? realDt : smoothDt * 0.9 + realDt * 0.1;
    dispatchPress();
    dispatchDrag();
    dispatchScrollDrag();
    dispatchHover();
    dispatchWheel();
    // `<Game timeScale paused>` are read every frame: they may be state.
    const live = current instanceof Game ? current : null;
    const scale = live?.timeScale ?? 1;
    world.paused = live?.paused === true;
    const dt = (input.values[TSE_IN_DT] as number) * (scale > 0 ? scale : 0);
    // What was typed since the last frame goes to this frame's first step only.
    input.typed = input.typedNext;
    input.typedNext = "";
    animationTime += dt > 0 ? Math.min(dt, MAX_DT * Math.max(1, scale)) : 0;
    if (driver === null) {
      tick(dt > 0 ? Math.min(dt, MAX_DT) : 0);
      collide();
    } else {
      const steps = driver.advance(dt > 0 ? Math.min(dt, MAX_DT * Math.max(1, scale)) : 0, input.keys, (stepKeys, updateKeys, stepDt) => {
        const frozen = world.frozenSteps > 0;
        input.handlerKeys = stepKeys;
        tick(stepDt, () => (input.handlerKeys = updateKeys));
        input.typed = "";
        collide();
        interpolator?.capture(world.root);
        return frozen;
      });
      // With no step this frame nothing ticked: still settle what the hooks of the last one set, and what that moved.
      if (steps === 0) {
        world.flush();
        collide();
      }
    }
    // The last walk is this frame's unless a collision callback has changed something since.
    const profiler = activeProfiler();
    const buildStarted = profiler?.now() ?? 0;
    let built: BuiltFrame;
    if (interpolator !== null && driver !== null && interpolator.blend(world.root, driver.alpha)) {
      // A frame between the last two steps: built from blended transforms, which are then put back before anything else runs.
      try {
        built = builder.build(world.root, input.width, input.height, animationTime);
      } finally {
        interpolator.restore();
      }
    } else built = lastBuilt !== null && !stale ? lastBuilt : builder.build(world.root, input.width, input.height, animationTime);
    if (profiler !== null) profiler.phase("build", profiler.now() - buildStarted);
    lastBuilt = null;
    pointers = built.pointers;
    hudPointersFrom = built.hudPointersFrom;
    scrollers = built.scrollers;
    hudScrollersFrom = built.hudScrollersFrom;
    hasClips = built.hasClips;
    hudView = built.hudView;
    screen = built.screen;
    input.view = built.view;
    if (overlay)
      drawOverlay(
        built.list,
        built,
        builder.inspected,
        input.values[TSE_IN_MOUSE_X] as number,
        input.values[TSE_IN_MOUSE_Y] as number,
        input.width
      );
    if (showFps) {
      const ms = clock() - started;
      smoothMs = smoothMs === 0 ? ms : smoothMs * 0.9 + ms * 0.1;
      const shown = built.list;
      shown.view({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      shown.text(
        { x: 3, y: 3, rotation: 0, scaleX: 1, scaleY: 1 },
        `${smoothDt > 0 ? Math.round(1 / smoothDt) : 0} fps  ${smoothMs.toFixed(1)} ms`,
        8,
        0xffe14dff
      );
    }
    const drawStarted = profiler?.now() ?? 0;
    backend.frame(background, built.list.records, built.list.length, built.list.texts, input.values, input.keys);
    input.typedNext = backend.typed?.() ?? "";
    if (profiler !== null) {
      profiler.phase("draw", profiler.now() - drawStarted);
      profiler.frame();
    }
    return input.values[TSE_IN_QUIT] === 0;
  }
}

/**
 * Open the window, step until it is closed, then clean up (also when the game throws). In a visible window an error is shown
 * there until the window is closed (`showErrors` defaults to on unless the window is `hidden`), and then thrown, so the host
 * still prints it and exits with status 1.
 *
 * A host that drives the loop itself (the Node launcher, which hot reloads) installs a function at `globalThis[HOST_RUN_KEY]`;
 * `run` then hands it the backend and config and returns at once.
 */
export function run(backend: Backend, config: PlayerConfig): void {
  const hostRun = (globalThis as Record<string, unknown>)[HOST_RUN_KEY];
  if (typeof hostRun === "function") {
    (hostRun as (backend: Backend, config: PlayerConfig) => void)(backend, config);
    return;
  }
  const player = createPlayer(backend, { ...config, showErrors: config.showErrors ?? !(config.hidden ?? false) });
  try {
    while (player.step());
  } finally {
    player.close();
  }
  const failure = player.failure;
  if (failure !== null) throw failure.error;
}

/** The error screen's background: a dark red, so it is not mistaken for the game. */
const ERROR_BACKGROUND = 0x3a0d12ff;
const ERROR_TITLE = 0xffd0d0ff;
const ERROR_TEXT = 0xf2f2f2ff;
const ERROR_DIM = 0xc89aa0ff;

/** One line of the error screen, in window pixels. */
export interface ErrorLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: number;
}

/** The title and the stack of an error, as lines of text. A stack that starts with the title (V8's) does not repeat it. */
export function describeError(error: unknown): { readonly title: string; readonly details: readonly string[] } {
  if (error instanceof Error) {
    const title = `${error.name}: ${error.message}`;
    let stack = typeof error.stack === "string" ? error.stack : "";
    if (stack.startsWith(title)) stack = stack.slice(title.length);
    const details = stack
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .map((line) => line.replace(/^\s+/, "  ").replaceAll("file://", ""));
    return { title, details };
  }
  const text = String(error);
  const [first = "", ...rest] = text.split("\n");
  return { title: first, details: rest };
}

/**
 * Where each line of the error screen goes: a heading, the error's title, its stack (dimmer), and `note` at the bottom. Text
 * is sized to the window and long lines are wrapped; what does not fit is cut, with a line that says so.
 */
export function layoutError(
  error: unknown,
  note: string,
  width: number,
  height: number,
  measure: (text: string, size: number) => number
): ErrorLine[] {
  // Whole multiples of 10: the hosts draw text with raylib's built-in 10-pixel font, scaled without smoothing, and at other
  // sizes its one-pixel strokes (an "i", a ".") can vanish.
  const size = height >= 360 && width >= 480 ? 20 : 10;
  const margin = Math.max(8, Math.round(size * 1.2));
  const lineHeight = Math.round(size * 1.35);
  const room = Math.max(size * 4, width - margin * 2);
  const wrap = (text: string, textSize: number): string[] => {
    const out: string[] = [];
    let rest = text;
    while (rest.length > 0 && measure(rest, textSize) > room) {
      // The longest head that fits, broken at a space or a path separator where there is one near the end.
      let fit = 1;
      while (fit < rest.length && measure(rest.slice(0, fit + 1), textSize) <= room) fit++;
      const head = rest.slice(0, fit);
      const at = Math.max(head.lastIndexOf(" "), head.lastIndexOf("/"), head.lastIndexOf("("));
      const cut = at > fit * 0.5 ? at + 1 : fit;
      out.push(rest.slice(0, cut).trimEnd());
      rest = "    " + rest.slice(cut).trimStart();
      if (rest.trim() === "") rest = "";
    }
    if (rest.length > 0) out.push(rest);
    return out;
  };
  const { title, details } = describeError(error);
  const lines: ErrorLine[] = [];
  let y = margin;
  const bottom = height - margin - lineHeight * 2;
  let cut = false;
  const add = (text: string, textSize: number, color: number): void => {
    for (const piece of wrap(text, textSize)) {
      if (y > bottom) {
        cut = true;
        return;
      }
      lines.push({ text: piece, x: margin, y, size: textSize, color });
      y += Math.round(textSize * 1.35);
    }
  };
  add("The game stopped with an error", size, ERROR_DIM);
  y += Math.round(lineHeight / 2);
  for (const line of title.split("\n")) add(line, size, ERROR_TITLE);
  y += Math.round(lineHeight / 2);
  const small = width >= 1400 ? size : 10;
  for (const line of details) add(line, small, ERROR_TEXT);
  if (cut) lines.push({ text: "(the rest does not fit)", x: margin, y: Math.min(y, bottom + lineHeight), size: small, color: ERROR_DIM });
  lines.push({ text: note, x: margin, y: height - margin - size, size, color: ERROR_DIM });
  return lines;
}

/** The timers waiting in a tree. */
function countTimers(root: GameObject): number {
  let count = root.pendingTimers;
  for (const child of root.children) count += countTimers(child);
  return count;
}

function resolveBackground(css: string, warner: Warner): number {
  const color = parseColor(css);
  if (color !== null) return color;
  warner.once(`background:${css}`, `Cannot read the background colour '${css}': using magenta.`);
  return MAGENTA;
}

/**
 * Sounds and music load through the backend once per path (a failed load is remembered too) and play by handle. A sound plays
 * at a volume and over itself (the backend has four voices per sound); music streams, and a backend without music support
 * leaves it silent, with one warning.
 */
function createSoundSink(backend: Backend, assets: string, warner: Warner): SoundSink {
  const handles = new Map<string, number>();
  const handleFor = (name: string): number => {
    const path = `${assets}/${name}`;
    let handle = handles.get(path);
    if (handle === undefined) {
      handle = backend.loadSound(path);
      handles.set(path, handle);
      if (handle < 0) warner.once(`sound:${path}`, `Could not load the sound '${path}': it will not play.`);
    }
    return handle;
  };
  const musics = new Map<string, number>();
  const musicFor = (name: string): number => {
    const path = `${assets}/${name}`;
    let handle = musics.get(path);
    if (handle === undefined) {
      if (backend.loadMusic === undefined) {
        warner.once("music-unsupported", "This backend cannot play music: <Music> is silent.");
        handle = -1;
      } else {
        handle = backend.loadMusic(path);
        if (handle < 0) warner.once(`music:${path}`, `Could not load the music '${path}': it will not play.`);
      }
      musics.set(path, handle);
    }
    return handle;
  };
  return {
    load: (name) => void handleFor(name),
    play: (name, volume) => {
      const handle = handleFor(name);
      if (handle >= 0) backend.playSound(handle, volume);
    },
    loadMusic: (name) => void musicFor(name),
    playMusic: (name, volume, loop) => {
      const handle = musicFor(name);
      if (handle >= 0) backend.playMusic?.(handle, volume, loop);
    },
    setMusicVolume: (name, volume) => {
      const handle = musicFor(name);
      if (handle >= 0) backend.setMusicVolume?.(handle, volume);
    },
    stopMusic: (name) => {
      const handle = musicFor(name);
      if (handle >= 0) backend.stopMusic?.(handle);
    },
  };
}

/** `retain: "check"`: the colliders placed without a build are the build's, in its order and at its transforms; throws where not. */
function sameColliders(placed: readonly ColliderEntry[], built: readonly ColliderEntry[]): void {
  const at = (entry: ColliderEntry): string => {
    const w = entry.world;
    return `${entry.collider.constructor.name} at ${w.x},${w.y} turned ${w.rotation} scaled ${w.scaleX},${w.scaleY}`;
  };
  for (let i = 0; i < Math.max(placed.length, built.length); i++) {
    const a = placed[i];
    const b = built[i];
    if (
      a === undefined ||
      b === undefined ||
      a.collider !== b.collider ||
      a.world.x !== b.world.x ||
      a.world.y !== b.world.y ||
      a.world.rotation !== b.world.rotation ||
      a.world.scaleX !== b.world.scaleX ||
      a.world.scaleY !== b.world.scaleY
    )
      throw new Error(
        `retain: "check": the colliders placed for a step's collisions differ from a build's at ${i}: ${a === undefined ? "none" : at(a)} against ${b === undefined ? "none" : at(b)}.`
      );
  }
}
