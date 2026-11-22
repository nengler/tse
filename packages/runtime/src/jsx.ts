import type { AnimatedSpriteProps } from "./components/AnimatedSprite.ts";
import type { ButtonProps } from "./components/Button.ts";
import type { CameraProps } from "./components/Camera.ts";
import type { ColliderProps, ContactOf, MessageOf, Nearby, SendTarget } from "./components/Collider.ts";
import type { EntityProps } from "./components/Entity.ts";
import type { FadeProps } from "./components/Fade.ts";
import type { FlexProps } from "./components/Flex.ts";
import type { GameProps } from "./components/Game.ts";
import type { HudProps } from "./components/Hud.ts";
import type { LayerProps } from "./components/Layer.ts";
import type { LightingProps, LightProps } from "./components/Light.ts";
import type { LineProps } from "./components/Line.ts";
import type { MenuProps } from "./components/Menu.ts";
import type { MusicProps } from "./components/Music.ts";
import type { ParticleLayerProps } from "./components/ParticleLayer.ts";
import type { ParticlesProps } from "./components/Particles.ts";
import type { PointerProps } from "./components/Pointer.ts";
import type { RouteProps, RouterProps } from "./components/Router.ts";
import type { ScreenProps } from "./components/Screen.ts";
import type { ShapeProps } from "./components/Shape.ts";
import type { SliderProps } from "./components/Slider.ts";
import type { SpriteProps } from "./components/Sprite.ts";
import type { TextProps } from "./components/Text.ts";
import type { TextInputProps } from "./components/TextInput.ts";
import type { TilemapProps } from "./components/Tilemap.ts";
import type { ToggleProps } from "./components/Toggle.ts";
import type { TooltipProps } from "./components/Tooltip.ts";
/**
 * The authoring entry point: what component source imports.
 *
 *   import { useMutable, useUpdate, Entity, Sprite } from "@tsengine/runtime/jsx";
 *
 * Source TSX is compiled, never run, so everything here is a declaration that
 * exists for the type-checker (the functions throw if called). Prop types are
 * derived from the runtime's own classes, so they cannot drift from it, and a
 * test checks that this module exports exactly what the compiler accepts.
 */
import type { InputState } from "./input.ts";
import type { Child, JSX } from "./jsx-runtime.ts";
import type { SpringOptions, TweenOptions } from "./math.ts";

export type { TransformShorthand, OpacityShorthand, Child } from "./jsx-runtime.ts";
/** A cutscene's sequence, for a field's type (`intro: null as Sequence | null`); its steps come from `@tsengine/runtime` in a `.ts` file. */
export type { Sequence, SequencePosition, Step } from "./sequence.ts";
import type { OpacityShorthand, TransformShorthand } from "./jsx-runtime.ts";

export { clamp, grace, shakeOn, springBack, startSpring, startTween, stepSpring, stepTween, textOf } from "./math.ts";
export { keepIfEqual } from "./equal.ts";
export { getInputDevice, watchInputDevice, type InputDevice } from "./input.ts";
import type { InputDevice } from "./input.ts";
export { getWindowSize, watchWindowSize, type WindowSize } from "./window.ts";
import type { WindowSize } from "./window.ts";
export { createBall, type BallContact, type BallOptions } from "./ball.ts";
export { createBody, type BodyHit, type BodyOptions } from "./body.ts";
export { readContext, type Context } from "./context.ts";
import type { BallContact, BallOptions } from "./ball.ts";
import type { BodyHit, BodyOptions } from "./body.ts";
import type { Context } from "./context.ts";

// -- state -----------------------------------------------------------

function compileTimeOnly(name: string): never {
  throw new Error(`${name} is a compile-time declaration: components are compiled by @tsengine/compiler, not executed.`);
}

/**
 * Squash and stretch: a scale set at a moment that springs back to 1 at \`recover\` a second (default 1.75), as state you write.
 *
 *     const squash = useSquash();
 *     squash.x = 0.6;                                 // in a handler: thin and tall
 *     squash.y = 1.4;
 *     <Sprite scaleX={squash.x} scaleY={squash.y} … />   // scales about the sprite's origin
 *
 * An ordinary hook the engine ships (\`useMutable\` and \`useUpdate\`, inlined like any custom hook).
 */
export function useSquash(_recover?: number): { x: number; y: number } {
  return compileTimeOnly("useSquash");
}

/**
 * A value that follows `target` like a spring: it moves toward it, overshooting by `bounce` (0, the default, for none), and settles in
 * about `duration` seconds (default 0.5). A new target keeps the speed it had, so it turns round smoothly. A number: a point is two
 * springs, one for each axis.
 *
 *     const y = useSpring(open ? 0 : -40, { duration: 0.4, bounce: 0.2 });
 *     <Entity y={y}>…</Entity>
 *
 * It steps in this component's update, so it follows the fixed step, `freeze` and replays, and renders only while it moves. It
 * starts at its first target. An ordinary hook the engine ships (\`useMutable\` and \`useUpdate\`, inlined like any custom hook).
 */
export function useSpring(_target: number, _options?: SpringOptions): number {
  return compileTimeOnly("useSpring");
}

/**
 * A value that eases to `target` over `duration` seconds (default 0.25), along `ease` (a name, default `"outCubic"`, or a function
 * from a `.ts` file); a new target starts again from where it is. A number: a point is two tweens.
 *
 *     const opacity = useTween(visible ? 1 : 0, { duration: 0.25, ease: "outCubic" });
 *     <Entity opacity={opacity}>…</Entity>
 *
 * It steps in this component's update and renders only while it moves. It starts at its first target.
 */
export function useTween(_target: number, _options?: TweenOptions): number {
  return compileTimeOnly("useTween");
}

/**
 * A shake of the view, as state you write: in a handler, `shake.strength = 3; shake.duration = 0.25; shake.elapsed = 0;` starts one,
 * and it runs down by itself in this component's update. Give it to the camera: `<Camera shake={shake}>`.
 *
 * An ordinary hook the engine ships (\`useMutable\` and \`useUpdate\`, inlined like any custom hook).
 */
export function useShake(): { strength: number; duration: number; elapsed: number } {
  return compileTimeOnly("useShake");
}

/**
 * Seconds since the component mounted, growing with each update: `const time = useTime();`, then
 * `color={time % 1 < 0.66 ? "white" : "black"}` to blink. The component renders every update while it is mounted.
 *
 * An ordinary hook the engine ships (\`useMutable\` and \`useUpdate\`, inlined like any custom hook).
 */
export function useTime(): number {
  return compileTimeOnly("useTime");
}

/**
 * A sound, played by calling the returned function in a handler:
 * `const playHit = useSound("hit.wav");` then `playHit();`, or `playHit(0.5)` at half volume (0 to 1). A sound played again
 * while it still sounds plays over itself, up to four at once, then the oldest is cut off. The path must be a
 * string literal. Sounds are not placed, so they take no `x` or `y`.
 */
export function useSound(_path: string): (volume?: number) => void {
  return compileTimeOnly("useSound");
}

/**
 * What the player is using, kept up to date: `"keyboard"`, `"pointer"` (a mouse or a finger) or `"gamepad"`, by whatever was pressed
 * last. `const device = useInputDevice();`, then `device === "keyboard" ? "Press Enter" : "Tap to start"`. It is `"pointer"` until
 * something is pressed, and the component renders only when it changes.
 *
 * An ordinary hook the engine ships (\`useMutable\` and \`useMount\`, inlined like any custom hook).
 */
export function useInputDevice(): InputDevice {
  return compileTimeOnly("useInputDevice");
}

/**
 * The window's size in logical pixels, kept up to date: `const window = useWindowSize();`, then
 * `window.height > window.width && <RotatePrompt />` to ask a phone held upright to be turned. It is the window, not the game's
 * resolution (a `<Screen>` is scaled into it), and the component renders only when it changes.
 *
 * An ordinary hook the engine ships (\`useMutable\` and \`useMount\`, inlined like any custom hook).
 */
export function useWindowSize(): WindowSize {
  return compileTimeOnly("useWindowSize");
}

/** Anything that says when it changed: `subscribe` takes a listener and returns the function that stops it (`createSettings` stores do). */
export interface Subscribable {
  subscribe(listener: () => void): () => void;
}

/**
 * A value read from a store outside the game state, kept up to date, as React's \`useSyncExternalStore\`:
 * `const values = useStore(settings, settingsView);`. `read` is a function of no arguments (imported from a \`.ts\` file) that
 * returns what to show; it runs when the component mounts and each time the store notifies, and the component renders only when
 * what it returns holds different data. The subscription ends when the component leaves.
 *
 * An ordinary hook the engine ships (\`useMutable\` and \`useMount\`, inlined like any custom hook).
 */
export function useStore<T>(_store: Subscribable, _read: () => T): T {
  return compileTimeOnly("useStore");
}

/** What `useBody` returns: the body's position, as state, and what it can do, as functions of the component. */
export interface BodyHandle {
  readonly x: number;
  readonly y: number;
  /** Move by (dx, dy) pixels, a pixel at a time, stopped by what is solid; returns the sides it was stopped on, now. */
  move(dx: number, dy: number): BodyHit;
  /** Whether a collider with this tag overlaps the body now (its own colliders do not count). */
  touching(tag: string): boolean;
  /** Whether something solid is where a move by (dx, dy) would put the body, without moving it: `blocked(0, 1)` is on the ground. */
  blocked(dx: number, dy: number): boolean;
  /** Every collider with this tag that overlaps the body now, as contacts with their `data` (a tower finding the enemies near it). */
  overlapping<Tag extends string>(tag: Tag): ContactOf<Tag>[];
  /** Put the body somewhere, with no collision (a respawn, a door). */
  place(x: number, y: number): void;
}

/**
 * A box that moves through the world and is stopped by what is solid, answering in the same step: the solid tiles of a
 * `<Tilemap solid>` (the Tiled tile property `solid`) and every `<Collider solid>`, in the world this component is in.
 *
 *     const { x, y, move, touching } = useBody({ x: 16, y: 32, width: 8, height: 11 });
 *     useUpdate((dt, input) => {
 *       const hit = move(dx * 90 * dt, vy * dt);   // stopped at walls and floors, this step
 *       if (hit.down) setVy(0);
 *       if (touching("spikes")) die();
 *     });
 *     return <Entity x={x} y={y}>…</Entity>;
 *
 * Position is in the component's parent's space, as an element's `x` and `y` are. `x` and `y` are state: they render where the body is.
 * An ordinary hook the engine ships (\`useMutable\` and functions of the component, inlined like any custom hook).
 */
export function useBody(_options: BodyOptions): BodyHandle {
  return compileTimeOnly("useBody");
}

/** What `useBall` returns: the ball's centre, as state, and what it can do, as functions of the component. */
export interface BallHandle {
  readonly x: number;
  readonly y: number;
  /** The balls with this tag touching this one now, nearest first, each with its `data` (typed by `ColliderData`) and where it is. */
  contacts<Tag extends string>(tag: Tag): BallContact<Tag>[];
  /** Add to its velocity, in pixels per second (a blast, a flick). */
  push(vx: number, vy: number): void;
  /** Put it somewhere, at rest, with no collision. */
  place(x: number, y: number): void;
  /** How fast it is moving, in pixels per second: a pile has settled when every ball is slow. */
  speed(): number;
  /**
   * Hold it in place, or let it go: pinned, it does not fall and nothing pushes it, and other balls pile up on it as on something
   * solid (a frozen fruit, a peg). Let go, it starts from rest.
   */
  pin(on: boolean): void;
  /**
   * Change its gravity, in pixels per second per second downwards: 0 hangs it in the air, a negative one floats it up. `sideways`
   * sets its pull to the right as well; left out, that stays as it was.
   */
  setGravity(gravity: number, sideways?: number): void;
  /** Change its pull to the right, in pixels per second per second (a tilted table, wind); the `gravityX` option starts it with one. */
  setGravityX(sideways: number): void;
  /**
   * Stick to every ball with this tag touching it now, and stay stuck: the two are held together, touching, and move as one
   * lump (honey, a magnet, a chain of beads). Call it every step to stick to whatever comes to touch it. Returns how many balls
   * it is stuck to.
   */
  stick(tag: string): number;
  /** Let go of every ball it is stuck to. */
  unstick(): void;
}

/**
 * A ball: a circle that falls, rolls and piles up, pushed apart by the other balls in the world and stopped by what is solid (every
 * `<Collider solid>` and the solid tiles of a `<Tilemap solid>`). The world steps all its balls together, once a step, before the
 * step's updates, so a pile of fruit in a jar is a list of components that each call `useBall`.
 *
 *     // in a .ts file: declare global { interface ColliderData { fruit: { id: number; kind: string } } }
 *     const { x, y, contacts } = useBall({ x: 40, y: 0, radius: 6, gravity: 600, tag: "fruit", data: { id, kind } });
 *     useUpdate(() => {
 *       const twin = contacts("fruit").find((c) => c.data.kind === kind);
 *       if (twin) onMerge(id, twin.data.id);
 *     });
 *     return <Sprite image="cherry.png" x={x} y={y} originX={6} originY={6} />;
 *
 * The centre is in the component's parent's space, as an element's `x` and `y` are; `x` and `y` are state, updated each step.
 * An ordinary hook the engine ships (\`useMutable\`, \`useUpdate\` and functions of the component, inlined like any custom hook).
 */
export function useBall(_options: BallOptions): BallHandle {
  return compileTimeOnly("useBall");
}

/**
 * The value of a context (`createContext` in a `.ts` file) from the nearest `<Theme.Provider value>` above this component, or the
 * context's default: `const theme = useContext(Theme)`, or `const { accent } = useContext(Theme)`. The component renders again
 * when that provider's value changes.
 */
export function useContext<T>(_context: Context<T>): T {
  return compileTimeOnly("useContext");
}

/**
 * Provide a context's value to everything below: written `<Theme.Provider value={palette}>…</Theme.Provider>`, as in React, and
 * compiled into this built-in. A container that layout sees through and that draws nothing.
 */
export function Provider<T>(_props: { context: Context<T>; value: T; children?: Child }): JSX.Element {
  return compileTimeOnly("Provider");
}

/**
 * A component's state, written directly: `const s = useMutable({ vx: 0, vy: 0 })`, then `s.vx += 1` in a handler. Each field
 * renders when it changes, is saved, and is kept by hot reload and rewind. A handler reads its own writes at once (and every
 * earlier handler's in the step); render, and the props and context it hands down, see what the frame committed. Fields are
 * written in handlers only. A list or record may be changed in place (`s.list.push(x)`, `s.list[i].hp -= 1`): the field is given the copy. It replaces React's `useState`.
 */
export function useMutable<T extends Record<string, unknown>>(_initial: T): Fields<T> {
  return compileTimeOnly("useMutable");
}

/**
 * A list field, as the author sees it: the methods the compiler turns into a copy (`push`, `splice`, `sort`, …) and writes to an
 * index, but not assignable to `T[]`. A helper that takes `Foe[]` therefore does not accept `s.foes`: it would change the list in
 * place, which render, comparing by `===`, would never see. Take `readonly Foe[]` to read it, or return the new list.
 */
export interface MutableList<T> extends ReadonlyArray<T> {
  [index: number]: T;
  push(...items: T[]): number;
  pop(): T | undefined;
  shift(): T | undefined;
  unshift(...items: T[]): number;
  splice(start: number, deleteCount?: number, ...items: T[]): T[];
  sort(compare?: (a: T, b: T) => number): this;
  reverse(): this;
}

/** What `useMutable` gives back: each array field as a `MutableList`, and the rest as written. */
export type Fields<T> = { [K in keyof T]: T[K] extends (infer U)[] ? (number extends T[K]["length"] ? MutableList<U> : T[K]) : T[K] };

// -- per-frame hooks ----------------------------------------------------------

/**
 * Runs every frame, after `useInput`. `dt` is the frame time in seconds (the fixed step, with a fixed timestep). `input` is the same
 * polled input `useInput` gets, for a game that reads its buttons where it steps: `useUpdate((dt, input) => { step(input, dt); })`.
 */
export function useUpdate(_handler: (dt: number, input: InputState) => void): void {
  return compileTimeOnly("useUpdate");
}

/** Runs every frame with the polled input state, before `useUpdate`. */
export function useInput(_handler: (input: InputState) => void): void {
  return compileTimeOnly("useInput");
}

/**
 * Runs once, when the component joins the world (after its children have).
 * Setting state here renders in the same frame. It may return a cleanup, a
 * function called once when the component leaves the world, after its
 * `useUnmount`: `useMount(() => settings.subscribe(() => setView(read())))`.
 */
export function useMount(_handler: () => void | (() => void)): void {
  return compileTimeOnly("useMount");
}

/**
 * Runs once, when the component leaves the world (a condition turning off, a
 * list item removed). It cannot set state, since the component is going away;
 * it can write refs and call callback props, which is how the parent finds out.
 */
export function useUnmount(_handler: () => void): void {
  return compileTimeOnly("useUnmount");
}

// -- elements -----------------------------------------------------------------

/** A named container; the usual root of a component. */
export function Entity(_props: EntityProps & { children?: Child } & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Entity");
}

/**
 * The root of a game and its configuration: the game's `id` (the folder its save and settings are kept in), the window (`title`, `width`, `height`, `resizable`, `vsync`, `smooth`, `fullscreenKey`, `fixedStep`, `interpolate`, `gamepadDeadzone`, `upscale`, `showFps`, `fpsKey`),
 * the `background`, the `assets` folder and the `controls`. A container, like `<Entity>`, and
 * optional: a component whose root is `<Game …>` overrides the defaults, each prop only where it is written. Its
 * `width` and `height` are the window's; put a `<Screen width height>` inside it for the resolution the game is drawn
 * at. Settings are literals, and it is only ever a component's root.
 */
export function Game(_props: GameProps & { children?: Child }): JSX.Element {
  return compileTimeOnly("Game");
}

/** Draws an image. */
export function Sprite(_props: SpriteProps & TransformShorthand): JSX.Element {
  return compileTimeOnly("Sprite");
}

/** A hit area for collisions, and what `nearby` finds and `send` reaches. Its `onReceive` is typed by its `tag` (`ColliderMessages`). */
export function Collider<Tag extends string = string>(_props: ColliderProps<Tag> & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Collider");
}

/** A hit area for presses (clicks and taps). */
export function Pointer(_props: PointerProps & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Pointer");
}

/**
 * What a `<Text>` may hold between its tags: text and `{expressions}` of strings or numbers. As in React, `null`, `undefined` and
 * booleans draw nothing, so `<Text>{maybe}</Text>` and `<Text>Ready{done && "!"}</Text>` work.
 */
export type TextChild = string | number | boolean | null | undefined;

/**
 * The content is the element's children, and only them: `<Text size={12}>Score: {score}</Text>`. There is no `text` prop in JSX
 * (`Omit` takes it out of the props, so the type-check says it does not exist, and the compiler says where the words go).
 * Elements cannot be children of a `<Text>`.
 */
export type TextAttributes = Omit<TextProps, "text"> & { children: TextChild | readonly TextChild[] };

/**
 * A line of text (a label, a HUD readout). `shadow` and `outline` (with `shadowX`, `shadowY` and `outlineWidth`) draw the text again under
 * itself in another colour, to keep it readable over a busy picture; they take no room in a layout.
 */
export function Text(_props: TextAttributes & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Text");
}

/** A filled rectangle or circle, for debugging colliders and prototyping before art exists. */
export function Shape(_props: ShapeProps & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Shape");
}

/** A straight line from (`x`, `y`) to (`x2`, `y2`), both in the parent's space, `width` pixels thick (default 1) with square ends. */
export function Line(_props: LineProps & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Line");
}

/**
 * The viewport. Its `x` and `y` are the view (moving it pans, `zoom` magnifies),
 * and it follows its children: `<Camera><Player /></Camera>` keeps the view on
 * the player. With no children it stays where it is.
 */
export function Camera(_props: CameraProps & { children?: Child } & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Camera");
}

/**
 * A sprite that cycles through `frames` at `fps`. `playing={false}` freezes it; a
 * different `frames` restarts it. Playing costs no renders.
 */
export function AnimatedSprite(_props: AnimatedSpriteProps & TransformShorthand): JSX.Element {
  return compileTimeOnly("AnimatedSprite");
}

/**
 * A container that places its children in a row or a column. It takes the props of CSS flexbox (`direction`,
 * `alignItems`, `justifyContent`, `gap`, `padding`) and sizes itself the way Clay does: each axis is `"fit"` (the
 * default), `"grow"`, a number of pixels or a percentage such as `"50%"`, with optional `minWidth` / `maxWidth` /
 * `minHeight` / `maxHeight`. A child's own `x` and `y` move it within its slot. `background` fills the box, and `borderWidth`, `borderColor` and `borderRadius`
 * give it a border (which takes room like padding) and rounded corners; `hoverBackground`, `hoverBorderColor`, `focusBackground` and `focusBorderColor`
 * are the colours it is drawn in while the mouse is over it or it has the focus; `pressedBackground` / `pressedBorderColor` while the button is held on it;
 * `disabled` switches it off (and shows `disabledBackground` / `disabledBorderColor` over every other state). `transition` fades between the colours of those states over that many seconds instead of snapping.
 * `wrap` breaks a row into lines (with `rowGap` and `columnGap`).
 * `opacity` fades the box and everything in it (with a `transition`, over time).
 * `backgroundImage` and `slice` skin it with a nine-slice picture (and `hoverBackgroundImage` and the like swap it by state).
 * `overflow` clips children that stick out of the box (`"hidden"`) and lets the mouse wheel or a drag scroll them (`"scroll"`, with `scrollX` / `scrollY`).
 */
export function Flex(_props: FlexProps & { children?: Child } & TransformShorthand): JSX.Element {
  return compileTimeOnly("Flex");
}

/**
 * A horizontal slider, a `<Flex>` with a thumb: `<Slider value={volume} min={0} max={10} step={1} onChange={(v) => setVolume(v)} />`. A press
 * puts the thumb under the mouse and a drag moves it; with the focus the left and right keys move it. The track is the box's own `background`
 * (so it takes a border, a radius and a colour for each state), the part left of the thumb is `fillColor`. `value` is where it starts and what
 * you set; the slider moves it itself and calls `onChange` with the new value, only when it is a different one.
 */
export function Slider(_props: SliderProps & TransformShorthand): JSX.Element {
  return compileTimeOnly("Slider");
}

/**
 * An on and off switch, a `<Flex>` with a knob: `<Toggle checked={sound} onChange={(on) => setSound(on)} />`. A press, the confirm key with the
 * focus, or its `pressKey` flips it; `onChange` is called with the new state. `onColor` and `offColor` colour the track, `thumbColor` the knob.
 */
export function Toggle(_props: ToggleProps & TransformShorthand): JSX.Element {
  return compileTimeOnly("Toggle");
}

/**
 * A button, a `<Flex>` that takes the focus and has a look for each state: `<Button onPress={start}><Text>Play</Text></Button>`. A click,
 * the confirm key while it has the focus, or its `pressKey` presses it; `onAdjust` hears left and right while it has the focus (a settings
 * row). Any `<Flex>` prop replaces the default look (`background`, `focusBackground`, `pressedBackground`, `backgroundImage` and the rest).
 */
export function Button(_props: ButtonProps & { children?: Child } & TransformShorthand): JSX.Element {
  return compileTimeOnly("Button");
}

/**
 * A menu, a `<Flex>` column whose focusable children (usually `<Button>`s) are its items: while one has the focus, up and down move it
 * among them only, going round at the ends (`loop={false}` stops at them), and `back` calls `onBack`. `autoFocus` on an item starts there.
 * `<Menu onBack={close}><Button autoFocus onPress={resume}><Text>Resume</Text></Button>…</Menu>`.
 */
export function Menu(_props: MenuProps & { children?: Child } & TransformShorthand): JSX.Element {
  return compileTimeOnly("Menu");
}

/**
 * A tip shown while the mouse is over the box it is in, or that box has the focus: a floating `<Flex>` above its parent, over what is near
 * it. `<Button onPress={sell}><Text>Sell</Text><Tooltip><Text>Sells for 5 gold</Text></Tooltip></Button>`. `show` forces it on or off;
 * `anchor` and `to` place it elsewhere; any `<Flex>` prop changes its look.
 */
export function Tooltip(_props: TooltipProps & { children?: Child } & TransformShorthand): JSX.Element {
  return compileTimeOnly("Tooltip");
}

/**
 * A one-line text field: `<TextInput value={s.name} placeholder="Your name" maxLength={12} onChange={(v) => { s.name = v; }} onSubmit={start} />`.
 * Focus it (a click, or the arrows) and type; Backspace takes off the last character and Enter calls `onSubmit`. While it has the focus,
 * letters do not trigger the game's `confirm`, `back` or `pressKey`s.
 */
export function TextInput(_props: TextInputProps & TransformShorthand): JSX.Element {
  return compileTimeOnly("TextInput");
}

/**
 * A grid of tiles from a sheet, with no object per tile: `<Tilemap map="room1" image="tiles.png" />` draws the registered Tiled map
 * `room1` with the tiles of `tiles.png`; without `image`, each tile comes from its own tileset's sheet, as saved in Tiled. The same
 * map, as `getTilemap("room1")`, is the solid grid that movement code reads. Placed by `x` and `y` at the map's top left; `layer` draws one layer only. A leaf.
 */
export function Tilemap(_props: TilemapProps & TransformShorthand): JSX.Element {
  return compileTimeOnly("Tilemap");
}

/**
 * An emitter of small squares for dust, a dash's trail or a death, with no game object per particle: `rate` a second while `emitting`,
 * `burst` at once when it turns on (or when it is made), each living `lifetime` seconds, thrown at `speed` toward `angle` ± `spread`,
 * pulled by `gravity`, fading or shrinking. `space="world"` leaves them where they were made. A leaf, placed by `x` and `y`.
 */
export function Particles(_props: ParticlesProps & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Particles");
}

/**
 * Where a particle store's bursts are drawn, as a `<Toaster />` is for toasts: `const fx = createParticles({ dust: { … } })` in a
 * `.ts` module, `<ParticleLayer particles={fx} />` once (inside the `<Camera>`, for bursts at world positions), then
 * `fx.burst("dust", x, y)` from an action, a plain function or a handler. A leaf.
 */
export function ParticleLayer(_props: ParticleLayerProps & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("ParticleLayer");
}

/**
 * A cover that fades the screen to a colour and back: put it in a `<Hud>` and switch `on`. `duration` is the seconds a full fade
 * takes. For a death, a room change, a scene change.
 */
export function Fade(_props: FadeProps): JSX.Element {
  return compileTimeOnly("Fade");
}

/**
 * Music that streams from a file, loops, fades and stops: `<Music src="theme.ogg" volume={0.6} playing={!paused} />`. It plays for as
 * long as it is mounted, so put it in the root, where room and screen changes do not touch it. `fade` is the seconds a full
 * fade takes, in and out. A leaf with no position.
 */
export function Music(_props: MusicProps): JSX.Element {
  return compileTimeOnly("Music");
}

/**
 * The screens of a game, and which one shows: `<Router route={screen} transition={slide}><Route name="title"><Title /></Route>…</Router>`.
 * Only the shown `<Route>` is in the world. When `route` changes, `transition` (a function you write in a `.ts` file, called with the
 * progress from 0 to 1 and the two route names, returning where each screen is, whether it is visible and how far a cover colour
 * is over the screen) runs for `duration` seconds with both screens in the world; without one the screens switch at once.
 */
export function Router(_props: RouterProps & { children?: Child }): JSX.Element {
  return compileTimeOnly("Router");
}

/** One screen of a `<Router>`, named for its `route`. It is in the world only while shown (or being left or entered). */
export function Route(_props: RouteProps & { children?: Child }): JSX.Element {
  return compileTimeOnly("Route");
}

/**
 * Call `fn` once, `seconds` of game time from now: `after(0.15, () => { s.flash = false; })` in a handler. The timer is this
 * component's: it counts the fixed step's time in the update phase (so it stops during `freeze` and `<Game paused>`, and replays),
 * and it is cancelled when the component unmounts, so it never sets state on a component that is gone. Returns the timer's id (1,
 * 2, 3… for this component, never 0), which `cancelTimer` takes: keep it in state to restart one timer and leave the others.
 *
 *     cancelTimer(s.flashTimer);
 *     s.flashTimer = after(0.08, () => { s.flash = false; });
 */
export function after(_seconds: number, _fn: () => void): number {
  return compileTimeOnly("after");
}

/**
 * Call `fn` every `seconds` of game time, the first time `seconds` from now, until `cancelTimer(id)` with the id it returns,
 * `cancelTimers()`, or the component unmounts.
 */
export function every(_seconds: number, _fn: () => void): number {
  return compileTimeOnly("every");
}

/** Cancel one timer: the one whose id `after` or `every` returned. Its other timers keep running. An id that is done, or 0, is ignored. */
export function cancelTimer(_id: number): void {
  return compileTimeOnly("cancelTimer");
}

/** Cancel every timer this component has set. */
export function cancelTimers(): void {
  return compileTimeOnly("cancelTimers");
}

/**
 * The colliders with `tag` whose boxes come within `radius` of (`x`, `y`) in world space, nearest first, not counting the
 * colliders this component draws itself (a child component's count): a tower finding the enemies in reach. Each is the collider's `tag`, `owner` and `data` (typed by tag through
 * `ColliderData`), where its box's middle is (`x`, `y`) and its `distance` from the point (0 inside the box). Hand one to `send`
 * to reach that collider. Call it in a handler (`useUpdate`, `useInput`, a callback prop); boxes are where they were when the
 * step's updates began.
 *
 *     const foes = nearby("enemy", x, y, 60);
 *     if (foes.length > 0) send("enemy", foes[0], { damage: 5 });
 */
export function nearby<Tag extends string>(_tag: Tag, _x: number, _y: number, _radius: number): Nearby<Tag>[] {
  return compileTimeOnly("nearby");
}

/**
 * Send `value` to the `onReceive` of the colliders with `tag` that `where` names: every one whose box comes within a circle
 * (`{ x, y, radius }`), or the one collider a `nearby` result is. Delivered at the end of this step's update phase, after every
 * `useUpdate` and timer, in the order values were sent (each send's receivers nearest first), so it lands in the same step and
 * replays the same way. A value sent from an `onReceive` is delivered later in the same phase; one sent from a collision callback,
 * at the end of the next step's update phase. Typed by tag through `ColliderMessages`. Call it in a handler.
 *
 *     send("enemy", { x: target.x, y: target.y, radius: 24 }, blast);
 */
export function send<Tag extends string>(_tag: Tag, _where: SendTarget<Tag>, _value: MessageOf<Tag>): void {
  return compileTimeOnly("send");
}

/**
 * Pause every `useUpdate` for the next `steps` fixed steps: the freeze frames of a hit or a dash. Call it as a statement in a
 * handler. `useInput` keeps running and a press during the freeze is kept for the first step after it.
 */
export function freeze(_steps: number): void {
  return compileTimeOnly("freeze");
}

/**
 * A layer that stays on the screen while the camera moves, drawn after the world: a score, a health bar, a button.
 * Its coordinates are screen pixels (game pixels under a `<Screen>`). `x` and `y` move the whole layer.
 */
export function Hud(_props: HudProps & { children?: Child } & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Hud");
}

/**
 * A container whose children are drawn off screen and then laid over what is under it with a blend mode: a dark
 * `<Layer blend="multiply" clear="#1a1a2e" childBlend="add">` with light sprites in it is a cave lit by lanterns.
 */
export function Layer(_props: LayerProps & { children?: Child } & TransformShorthand): JSX.Element {
  return compileTimeOnly("Layer");
}

/** A soft disc of light, brightest at its middle, falling off to nothing at `radius`: put it in a `<Lighting>`. */
export function Light(_props: LightProps & TransformShorthand & OpacityShorthand): JSX.Element {
  return compileTimeOnly("Light");
}

/** The world as light reaches it: darkened to `ambient` except where its `<Light>` children shine. */
export function Lighting(_props: LightingProps & { children?: Child } & TransformShorthand): JSX.Element {
  return compileTimeOnly("Lighting");
}

/**
 * The game's screen, at a fixed resolution: `<Screen width={320} height={180}>` as the root of the game draws
 * everything at 320 × 180 and scales it to fit the window (`fit`), with `border` around it. Only the root's
 * `<Screen>` does this; it cannot be placed with `x` and `y`.
 */
export function Screen(_props: ScreenProps & { children?: Child }): JSX.Element {
  return compileTimeOnly("Screen");
}
