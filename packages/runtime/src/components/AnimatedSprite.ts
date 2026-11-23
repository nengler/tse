import { GameObject } from "../GameObject.ts";
import type { InputState } from "../input.ts";
import { isStyled, type SpriteLook, type SpriteOptions } from "./Sprite.ts";

export interface AnimatedSpriteProps extends SpriteOptions {
  /** The images to cycle through, in order, one image file per frame. Leave it out to play a sheet (`sheet`). */
  frames?: readonly string[];
  /** Frames per second for `frames`. Default 10. A value that is not positive and finite freezes the animation. */
  fps?: number;
  /** False freezes it on the current frame; true resumes from there. Default true. */
  playing?: boolean;
  /** A sheet to play: one image holding every frame, each `frameWidth` × `frameHeight` pixels, read left to right, then down. */
  sheet?: string;
  frameWidth?: number;
  frameHeight?: number;
  /**
   * The named animations of the sheet, as an object (`{ idle: { frames: "0-1", fps: 4 }, die: { frames: "8-12", fps: 10, once: true } }`)
   * or as text (`"idle:0-1@4, run:2-7@12, die:8-12@10~"`: a name, a colon, frames, `@` and the frames per second, and a `~` at the end
   * to play once). Frames are a number, a list of numbers, or text: `3`, `2-7`, or several joined by `+` (`1+2+3+2`). See
   * `parseAnimations`.
   */
  animations?: string | AnimationTable;
  /** Which animation plays. Changing it restarts at its first frame; setting the same one again changes nothing. */
  animation?: string;
  /** Whether an animation without a `~` loops. Default true: false plays each once. */
  loop?: boolean;
}

/** One animation, written as an object: its frames, its rate (default 10 a second), and whether it plays once. */
export interface AnimationEntry {
  readonly frames: number | string | readonly number[];
  readonly fps?: number;
  /** Play once and stay on the last frame, instead of following the sprite's `loop`. */
  readonly once?: boolean;
}

/** The animations of a sheet, by name: `{ idle: { frames: "0-1", fps: 3 }, run: { frames: "2-7", fps: 14 } }`. */
export type AnimationTable = Readonly<Record<string, AnimationEntry>>;

/** One named animation of a sheet. */
export interface SheetAnimation {
  readonly name: string;
  /** Frame numbers on the sheet, in play order. */
  readonly frames: readonly number[];
  readonly fps: number;
  /** Plays once and stays on its last frame (`~`); otherwise follows the sprite's `loop`. */
  readonly once: boolean;
}

/**
 * Read `"idle:0-1@4, run:2-7@12, die:8-12@10~"` into animations. Throws a readable error for a malformed entry, so a typo shows up
 * the moment the sprite is made (and at build time for a literal).
 */
export function parseAnimations(text: string | AnimationTable): SheetAnimation[] {
  if (typeof text !== "string") return animationsOf(text);
  const out: SheetAnimation[] = [];
  for (const entry of text.split(",")) {
    const item = entry.trim();
    if (item === "") continue;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*([\d+\-\s]+?)\s*(?:@\s*(\d+(?:\.\d+)?))?\s*(~?)$/.exec(item);
    if (match === null)
      throw new Error(`Cannot read the animation '${item}': expected name:frames@fps, as in "run:2-7@12" (a trailing ~ plays it once).`);
    const frames = framesOf(match[2] as string, match[1] as string);
    if (out.some((a) => a.name === match[1])) throw new Error(`The animation '${match[1] as string}' is listed twice.`);
    out.push({ name: match[1] as string, frames, fps: match[3] === undefined ? 10 : Number(match[3]), once: match[4] === "~" });
  }
  return out;
}

/** `3`, `2-7` (or `7-2`, backwards) or `1+2+3+2` as frame numbers. */
function framesOf(text: string, name: string): number[] {
  const frames: number[] = [];
  for (const part of text.split("+")) {
    const range = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    if (range === null) throw new Error(`Cannot read the frames '${text}' of the animation '${name}': expected 3, 2-7 or 1+2+3+2.`);
    const from = Number(range[1]);
    const to = range[2] === undefined ? from : Number(range[2]);
    if (to < from) for (let f = from; f >= to; f--) frames.push(f);
    else for (let f = from; f <= to; f++) frames.push(f);
  }
  return frames;
}

/** An animation table as animations, checked as the text form is. */
function animationsOf(table: AnimationTable): SheetAnimation[] {
  return Object.entries(table).map(([name, entry]) => {
    const frames =
      typeof entry.frames === "number"
        ? [entry.frames]
        : typeof entry.frames === "string"
          ? framesOf(entry.frames, name)
          : [...entry.frames];
    if (frames.length === 0 || frames.some((f) => !Number.isInteger(f) || f < 0))
      throw new Error(`The animation '${name}' needs frames: whole numbers from 0.`);
    const fps = entry.fps ?? DEFAULT_FPS;
    if (!(fps > 0)) throw new Error(`The animation '${name}' needs a positive fps, not ${fps}.`);
    return { name, frames, fps, once: entry.once ?? false };
  });
}

const DEFAULT_FPS = 10;

/**
 * A sprite that animates, in one of two ways. With `frames`, it cycles through one image file per frame, looping, at `fps`.
 * With a `sheet`, `frameWidth` and `frameHeight` and the text of `animations`, it plays the frames of the animation named by
 * `animation` from one image, each at its own rate, looping or once (see `SheetAnimation`). Either way `image` is what the
 * renderer draws (the current frame's file, or the sheet) and `sheetFrame` is the frame to cut from the sheet (-1 for files).
 * It takes the sprite options too (flips, origin, tint, opacity, flash, shader). The mock draws nothing. Playing is not state: advancing a
 * frame does not re-render anything, so an animation costs no renders.
 *
 * Setting `frames` to different contents restarts at the first frame; setting it to the same contents (a new array that is
 * equal, which is what a dynamic JSX prop produces on every render) changes nothing. The same holds for `animation`.
 */
export class AnimatedSprite<P extends object = {}> extends GameObject<P> implements SpriteLook {
  static override readonly intrinsic = true;

  fps: number;
  playing: boolean;
  /** Index of the current frame (within `frames`, or within the current animation). */
  frame = 0;
  /** Time carried over toward the next frame, in seconds. */
  elapsed = 0;
  sheet: string | undefined;
  frameWidth: number | undefined;
  frameHeight: number | undefined;
  loop: boolean;
  flipX: boolean;
  flipY: boolean;
  originX: number;
  originY: number;
  tint: string | undefined;
  opacity: number;
  flash: number;
  flashColor: string;
  shader: string;
  params: readonly number[];
  lookup: string;
  #frames: readonly string[];
  #animationsText: string | AnimationTable;
  /** What the animations were last read from, to tell a new table from the same one written again. */
  #animationsKey = "";
  #animations: SheetAnimation[] = [];
  #animation: string;

  /** `props` and `defaults` are the component's own (see `GameObject`); `hostProps` are this element's. */
  constructor(hostProps: AnimatedSpriteProps, props?: P, defaults?: Partial<P>) {
    super(props, defaults);
    // A component rooted at one whose props vary gets `undefined` here (the generated `super()` runs before state exists) and the
    // real value in the first render.
    this.#frames = [...(hostProps.frames ?? [])];
    this.fps = hostProps.fps ?? DEFAULT_FPS;
    this.playing = hostProps.playing ?? true;
    this.sheet = hostProps.sheet;
    this.frameWidth = hostProps.frameWidth;
    this.frameHeight = hostProps.frameHeight;
    this.loop = hostProps.loop ?? true;
    this.flipX = hostProps.flipX ?? false;
    this.flipY = hostProps.flipY ?? false;
    this.originX = hostProps.originX ?? 0;
    this.originY = hostProps.originY ?? 0;
    this.tint = hostProps.tint;
    this.opacity = hostProps.opacity ?? 1;
    this.flash = hostProps.flash ?? 0;
    this.flashColor = hostProps.flashColor ?? "white";
    this.shader = hostProps.shader ?? "";
    this.params = hostProps.params ?? [];
    this.lookup = hostProps.lookup ?? "";
    this.#animationsText = "";
    this.#animation = "";
    if (hostProps.animations !== undefined) this.animations = hostProps.animations;
    if (hostProps.animation !== undefined) this.animation = hostProps.animation;
  }

  get frames(): readonly string[] {
    return this.#frames;
  }

  set frames(value: readonly string[] | undefined) {
    const next = value ?? [];
    if (next.length === this.#frames.length && next.every((image, i) => image === this.#frames[i])) return;
    this.#frames = [...next];
    this.frame = 0;
    this.elapsed = 0;
  }

  get animations(): string | AnimationTable {
    return this.#animationsText;
  }

  set animations(value: string | AnimationTable | undefined) {
    const next = value ?? "";
    const key = typeof next === "string" ? next : JSON.stringify(next);
    if (key === this.#animationsKey) return;
    this.#animationsKey = key;
    this.#animationsText = next;
    this.#animations = parseAnimations(next);
    this.frame = 0;
    this.elapsed = 0;
  }

  get animation(): string {
    return this.#animation;
  }

  set animation(name: string | undefined) {
    const next = name ?? "";
    if (next === this.#animation) return;
    this.#animation = next;
    this.frame = 0;
    this.elapsed = 0;
  }

  /** True when this plays a sheet: it has a `sheet` and animations to play. */
  get isSheet(): boolean {
    return this.sheet !== undefined && this.#animations.length > 0;
  }

  /** The animation now playing: the one named by `animation`, else the first. Null for a sprite of files. */
  get current(): SheetAnimation | null {
    if (!this.isSheet) return null;
    return this.#animations.find((a) => a.name === this.#animation) ?? (this.#animations[0] as SheetAnimation);
  }

  /** What the renderer draws: the sheet, or the current frame's file; empty when there is nothing. */
  get image(): string {
    if (this.isSheet) return this.sheet as string;
    return this.#frames[this.frame] ?? "";
  }

  /** The frame number to cut from the sheet right now, or -1 when this plays files. */
  get sheetFrame(): number {
    const current = this.current;
    return current === null ? -1 : (current.frames[Math.min(this.frame, current.frames.length - 1)] ?? 0);
  }

  /** Whether the renderer must draw this as a region of a sheet or with options, rather than as a whole image. */
  get styled(): boolean {
    return this.isSheet || isStyled(this);
  }

  /** Advance by `dt` seconds while playing. The World calls this every tick, since the class overrides it. */
  override onUpdate(dt: number, _input?: InputState): void {
    const current = this.current;
    const count = current === null ? this.#frames.length : current.frames.length;
    const fps = current === null ? this.fps : current.fps;
    if (!this.playing || count === 0 || !(fps > 0) || !Number.isFinite(fps) || !(dt > 0)) return;
    const step = 1 / fps;
    this.elapsed += dt;
    // The epsilon keeps 10 ticks of 0.1s at 10 fps from landing a rounding error short of the 10th frame.
    const steps = Math.floor((this.elapsed + 1e-9) / step);
    if (steps === 0) return;
    this.elapsed = Math.max(0, this.elapsed - steps * step);
    const looping = current === null ? true : !current.once && this.loop;
    let next = this.frame + steps;
    if (looping) next %= count;
    else next = Math.min(next, count - 1);
    if (next !== this.frame) this.markChanged();
    this.frame = next;
  }

  /** True once a non-looping animation is on its last frame. */
  get finished(): boolean {
    const current = this.current;
    if (current === null || (!current.once && this.loop)) return false;
    return this.frame >= current.frames.length - 1;
  }
}
