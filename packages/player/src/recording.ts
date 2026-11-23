import type { Backend, StorageBackend, WindowConfig } from "./backend.ts";
import { colorToHex } from "./color.ts";
import { estimateTextWidth } from "./draw.ts";
import {
  TSE_BUILTIN_FONT_SHEETS,
  KEYS,
  KEY_INDEX,
  TSE_IN_DT,
  TSE_IN_HEIGHT,
  TSE_IN_LEN,
  TSE_IN_MOUSE_X,
  TSE_IN_MOUSE_Y,
  TSE_IN_QUIT,
  TSE_IN_WHEEL,
  TSE_IN_WIDTH,
  TSE_KEY_DOWN,
  TSE_KEY_PRESSED,
  TSE_KEY_RELEASED,
  TSE_OP_CANVAS,
  TSE_OP_CANVAS_LEN,
  TSE_OP_BOX,
  TSE_OP_BOX_LEN,
  TSE_OP_LAYER_BEGIN,
  TSE_OP_LAYER_BEGIN_LEN,
  TSE_OP_LAYER_END,
  TSE_OP_LAYER_END_LEN,
  TSE_OP_LIGHT,
  TSE_OP_LIGHT_LEN,
  TSE_LAYER_MAX,
  TSE_BLEND_ADD,
  TSE_BLEND_MULTIPLY,
  TSE_BLEND_SCREEN,
  TSE_OP_ELLIPSE,
  TSE_OP_ELLIPSE_LEN,
  TSE_OP_RECT,
  TSE_OP_RECT_LEN,
  TSE_OP_SCISSOR,
  TSE_OP_SCISSOR_END,
  TSE_OP_SCISSOR_END_LEN,
  TSE_OP_SCISSOR_LEN,
  TSE_OP_SPRITE,
  TSE_OP_SPRITE_LEN,
  TSE_OP_SPRITE_REGION,
  TSE_OP_SPRITE_REGION_LEN,
  TSE_OP_SPRITE_SHADED,
  TSE_OP_SPRITE_SHADED_LEN,
  TSE_SPRITE_FLIP_X,
  TSE_SPRITE_FLIP_Y,
  TSE_SPRITE_SILHOUETTE,
  TSE_OP_TEXT,
  TSE_OP_TEXT_LEN,
  TSE_OP_VIEW,
  TSE_OP_VIEW_LEN,
} from "./protocol.ts";

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** A draw record in readable form; colours are `#rrggbbaa` and textures are the path they were loaded from. */
/** A blend mode by name, as `<Layer blend>` takes it. */
export type BlendName = "normal" | "add" | "multiply" | "screen";

function blendName(code: number): BlendName {
  return code === TSE_BLEND_ADD ? "add" : code === TSE_BLEND_MULTIPLY ? "multiply" : code === TSE_BLEND_SCREEN ? "screen" : "normal";
}

export type DecodedRecord =
  | {
      readonly op: "canvas";
      readonly width: number;
      readonly height: number;
      readonly destX: number;
      readonly destY: number;
      readonly destW: number;
      readonly destH: number;
      readonly borderColor: string;
    }
  | { readonly op: "scissor"; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly op: "scissorEnd" }
  /** A light (ABI v12): `color` at the middle (its alpha the strength) falling off to black at `radius`. */
  | {
      readonly op: "light";
      readonly x: number;
      readonly y: number;
      readonly rotation: number;
      readonly scaleX: number;
      readonly scaleY: number;
      readonly radius: number;
      readonly color: string;
    }
  /** A layer opens (ABI v10): what follows is drawn into it, cleared to `clear`, each drawable blended with `childBlend`. */
  | { readonly op: "layerBegin"; readonly clear: string; readonly childBlend: BlendName }
  /**
   * The innermost layer closes and is laid over what is below it with `blend`, its colours multiplied by `tint`, through `shader` (the
   * path it was loaded from, or null) with `time` and its eight `params` (ABI v11).
   */
  | {
      readonly op: "layerEnd";
      readonly blend: BlendName;
      readonly tint: string;
      readonly shader: string | null;
      readonly time: number;
      readonly params: readonly number[];
    }
  | {
      readonly op: "view";
      readonly a: number;
      readonly b: number;
      readonly c: number;
      readonly d: number;
      readonly e: number;
      readonly f: number;
    }
  | ({ readonly op: "sprite"; readonly texture: string } & Placed)
  | ({
      readonly op: "spriteRegion";
      readonly texture: string;
      readonly srcX: number;
      readonly srcY: number;
      readonly srcW: number;
      readonly srcH: number;
      readonly originX: number;
      readonly originY: number;
      readonly flipX: boolean;
      readonly flipY: boolean;
      readonly tint: string;
      /** Present (true) only when the record draws the region's shape in the tint (TSE_SPRITE_SILHOUETTE): a sprite's `flash`. */
      readonly silhouette?: true;
    } & Placed)
  /** A region drawn through `shader` (the path it was loaded from), given `lookup` (a texture's path, or null) and its eight `params` (ABI v16). */
  | ({
      readonly op: "spriteShaded";
      readonly texture: string;
      readonly srcX: number;
      readonly srcY: number;
      readonly srcW: number;
      readonly srcH: number;
      readonly originX: number;
      readonly originY: number;
      readonly flipX: boolean;
      readonly flipY: boolean;
      readonly tint: string;
      readonly shader: string;
      readonly lookup: string | null;
      readonly params: readonly number[];
    } & Placed)
  | ({ readonly op: "rect"; readonly width: number; readonly height: number; readonly color: string } & Placed)
  | ({ readonly op: "ellipse"; readonly width: number; readonly height: number; readonly color: string } & Placed)
  | ({
      readonly op: "box";
      readonly width: number;
      readonly height: number;
      readonly fill: string;
      readonly borderColor: string;
      readonly borderWidth: number;
      readonly radius: number;
    } & Placed)
  | ({ readonly op: "text"; readonly text: string; readonly size: number; readonly color: string } & Placed);

export interface RecordedFrame {
  readonly clearColor: string;
  readonly records: readonly DecodedRecord[];
}

/** What the fake devices report for one frame. Anything left out is zero, except `dt` (1/60) and the window size. */
export interface InputFrame {
  readonly dt?: number;
  readonly width?: number;
  readonly height?: number;
  readonly mouse?: { readonly x: number; readonly y: number };
  /**
   * The mouse is on what is labelled this (`click@Play` in an input script): the middle of the topmost thing that can be
   * pressed and holds that text. `fresh` on the frame that moves it there, where the label is looked up in the game as it is
   * drawn; on the frames after, the mouse stays where that found it. A backend that feeds scripted frames resolves it (`aimFrame`).
   */
  readonly aim?: { readonly label: string; readonly fresh: boolean };
  readonly wheel?: number;
  readonly quit?: boolean;
  /** Went down this frame (so it is also down). */
  readonly pressed?: readonly string[];
  /** Held. */
  readonly down?: readonly string[];
  /** Went up this frame. */
  readonly released?: readonly string[];
  /** Characters typed this frame (`Backend.typed`), `"\b"` for Backspace. */
  readonly typed?: string;
}

export interface RecordingOptions {
  /** Texture paths that fail to load (handle -1), as a missing file would. */
  readonly missingTextures?: Iterable<string>;
  /** Sound paths that fail to load (handle -1). */
  readonly missingSounds?: Iterable<string>;
  /** Music paths that fail to load (handle -1). */
  readonly missingMusic?: Iterable<string>;
  /** Shader paths that fail to load (handle -1), as a missing file or one that does not compile would. */
  readonly missingShaders?: Iterable<string>;
  /** Entries the backend's saved data starts with (name to text): a replay can start from a save. */
  readonly storage?: Readonly<Record<string, string>>;
  /** The size `textureSize` reports for a texture path. Default 16 × 16, or a built-in font's sheet (`tse:small`: 64 × 36). */
  readonly textureSizes?: Readonly<Record<string, { readonly width: number; readonly height: number }>>;
  /** Keep only this many of the latest drawn frames (default all): for a long scripted run that only looks at the game's state. */
  readonly keepFrames?: number;
}

/**
 * A backend that draws nothing and remembers everything: for tests of the player, with no window.
 * Input is scripted a frame at a time with `queueInput`; when the queue is empty a frame is
 * idle (dt 1/60, nothing pressed).
 */
export class RecordingBackend implements Backend {
  config: WindowConfig | null = null;
  opened = false;
  closed = false;
  readonly frames: RecordedFrame[] = [];
  /** Every `loadTexture` call, repeats included: the player should load a path once. */
  readonly textureLoads: string[] = [];
  /** Every `loadShader` call, repeats included. */
  readonly shaderLoads: string[] = [];
  readonly #shaders: string[] = [];
  readonly #missingShaders: Set<string>;
  readonly soundLoads: string[] = [];
  /** The path of each sound played, in order. */
  readonly plays: string[] = [];
  /** Each sound played with the volume it was played at (1 when none was given). */
  readonly playVolumes: { readonly path: string; readonly volume: number }[] = [];
  /** What the game did with music, in order: `load:path`, `play:path:volume:loop`, `volume:path:volume`, `stop:path`. */
  readonly musicEvents: string[] = [];
  /** The gamepad dead zone the game set, when it did. */
  gamepadDeadzone: number | null = null;
  readonly #music: string[] = [];
  readonly #missingMusic: Set<string>;
  /** Every `measureText` call, as `size:text`: the player should measure a string once, not every frame. */
  readonly textMeasures: string[] = [];
  /** The game id the player opened saved data with, or null if it did not. */
  storageOpenedFor: string | null = null;
  /** Saved data, in memory: the entries now, which a test reads. Starts from `RecordingOptions.storage`. */
  readonly stored: Map<string, string>;
  readonly storage: StorageBackend = {
    open: (gameId) => ((this.storageOpenedFor = gameId), true),
    read: (name) => this.stored.get(name) ?? null,
    write: (name, text) => (this.stored.set(name, text), true),
    remove: (name) => void this.stored.delete(name),
  };
  /** Every `textureSize` call, by path. */
  readonly textureSizeQueries: string[] = [];
  readonly #textures: string[] = [];
  readonly #sounds: string[] = [];
  readonly #missing: Set<string>;
  readonly #keepFrames: number | undefined;
  readonly #missingSounds: Set<string>;
  readonly #textureSizes: Readonly<Record<string, { readonly width: number; readonly height: number }>>;
  readonly #queue: InputFrame[] = [];
  /** How a frame's `aim` (a label, `click@Play`) is found: the harness sets `aim.lookup` to its player's `pointOf`. */
  readonly aim: AimState = { lookup: undefined, last: undefined };

  constructor(options: RecordingOptions = {}) {
    this.#keepFrames = options.keepFrames;
    this.#missing = new Set(options.missingTextures);
    this.#missingSounds = new Set(options.missingSounds);
    this.#missingMusic = new Set(options.missingMusic);
    this.#missingShaders = new Set(options.missingShaders);
    this.#textureSizes = options.textureSizes ?? {};
    this.stored = new Map(Object.entries(options.storage ?? {}));
  }

  queueInput(frame: InputFrame): void {
    this.#queue.push(frame);
  }

  #typed = "";

  /** What the last frame's scripted input typed. */
  typed(): string {
    return this.#typed;
  }

  get lastFrame(): RecordedFrame {
    const frame = this.frames.at(-1);
    if (frame === undefined) throw new Error("No frame has been drawn yet.");
    return frame;
  }

  open(config: WindowConfig): void {
    this.config = config;
    this.opened = true;
  }

  close(): void {
    this.closed = true;
  }

  /** Every `setFullscreen` call, in order. */
  readonly fullscreenCalls: boolean[] = [];

  setFullscreen(on: boolean): boolean {
    this.fullscreenCalls.push(on);
    return true;
  }

  loadTexture(path: string): number {
    this.textureLoads.push(path);
    if (this.#missing.has(path)) return -1;
    return handleFor(this.#textures, path);
  }

  loadShader(path: string): number {
    this.shaderLoads.push(path);
    if (this.#missingShaders.has(path)) return -1;
    return handleFor(this.#shaders, path);
  }

  loadSound(path: string): number {
    this.soundLoads.push(path);
    if (this.#missingSounds.has(path)) return -1;
    return handleFor(this.#sounds, path);
  }

  /** The player's own estimate (`estimateTextWidth`), so layout tests have stable numbers without a font. */
  measureText(text: string, size: number): { width: number; height: number } {
    this.textMeasures.push(`${size}:${text}`);
    return { width: estimateTextWidth(text, size), height: size };
  }

  textureSize(handle: number): { width: number; height: number } {
    const path = this.#textures[handle];
    if (path === undefined) throw new Error(`textureSize: no texture has handle ${handle}.`);
    this.textureSizeQueries.push(path);
    return { ...(this.#textureSizes[path] ?? TSE_BUILTIN_FONT_SHEETS[path] ?? { width: 16, height: 16 }) };
  }

  playSound(handle: number, volume = 1): void {
    const path = this.#sounds[handle];
    if (path === undefined) throw new Error(`playSound: no sound has handle ${handle}.`);
    this.plays.push(path);
    this.playVolumes.push({ path, volume });
  }

  loadMusic(path: string): number {
    this.musicEvents.push(`load:${path}`);
    if (this.#missingMusic.has(path)) return -1;
    return handleFor(this.#music, path);
  }

  #musicPath(handle: number, what: string): string {
    const path = this.#music[handle];
    if (path === undefined) throw new Error(`${what}: no music has handle ${handle}.`);
    return path;
  }

  playMusic(handle: number, volume: number, loop: boolean): void {
    this.musicEvents.push(`play:${this.#musicPath(handle, "playMusic")}:${volume}:${loop}`);
  }

  setMusicVolume(handle: number, volume: number): void {
    this.musicEvents.push(`volume:${this.#musicPath(handle, "setMusicVolume")}:${volume}`);
  }

  stopMusic(handle: number): void {
    this.musicEvents.push(`stop:${this.#musicPath(handle, "stopMusic")}`);
  }

  setGamepadDeadzone(deadzone: number): void {
    this.gamepadDeadzone = deadzone;
  }

  frame(clearColor: number, records: Float64Array, length: number, texts: readonly string[], input: Float64Array, keys: Uint8Array): void {
    if (input.length < TSE_IN_LEN) throw new Error(`The input buffer needs ${TSE_IN_LEN} entries, not ${input.length}.`);
    if (keys.length < KEYS.length) throw new Error(`The keys buffer needs ${KEYS.length} entries, not ${keys.length}.`);
    // Every frame is checked now (a bad record is the player's bug, and should fail the frame that drew it), but read into
    // `DecodedRecord`s only when a test looks: a long scripted run that keeps two frames of thirty thousand never builds the rest.
    this.#decode(records, length, texts, null);
    const copy = records.slice(0, length);
    const strings = texts.slice();
    let decoded: DecodedRecord[] | undefined;
    const decode = (): DecodedRecord[] => {
      if (decoded === undefined) this.#decode(copy, length, strings, (decoded = []));
      return decoded;
    };
    this.frames.push({
      clearColor: colorToHex(clearColor),
      get records() {
        return decode();
      },
    });
    if (this.#keepFrames !== undefined && this.frames.length > this.#keepFrames)
      this.frames.splice(0, this.frames.length - this.#keepFrames);

    const next = aimFrame(this.#queue.shift() ?? {}, this.aim);
    this.#typed = next.typed ?? "";
    applyInputFrame(next, input, keys, this.config?.width ?? 0, this.config?.height ?? 0);
  }

  /** Check the frame's records, and when `out` is given, read them into it. */
  #decode(records: Float64Array, length: number, texts: readonly string[], out: DecodedRecord[] | null): void {
    let depth = 0;
    for (let at = 0; at < length;) {
      const op = records[at] as number;
      const placed = (): Placed => ({
        x: records[at + 1] as number,
        y: records[at + 2] as number,
        rotation: records[at + 3] as number,
        scaleX: records[at + 4] as number,
        scaleY: records[at + 5] as number,
      });
      const need = (count: number): void => {
        if (at + count > length) throw new Error(`Record at ${at} (op ${op}) runs past the end of the buffer.`);
      };
      switch (op) {
        case TSE_OP_VIEW:
          need(TSE_OP_VIEW_LEN);
          out?.push({
            op: "view",
            a: records[at + 1]!,
            b: records[at + 2]!,
            c: records[at + 3]!,
            d: records[at + 4]!,
            e: records[at + 5]!,
            f: records[at + 6]!,
          });
          at += TSE_OP_VIEW_LEN;
          break;
        case TSE_OP_CANVAS:
          need(TSE_OP_CANVAS_LEN);
          if (at !== 0) throw new Error(`A canvas record must be the first record of a frame, not at ${at}.`);
          out?.push({
            op: "canvas",
            width: records[at + 1]!,
            height: records[at + 2]!,
            destX: records[at + 3]!,
            destY: records[at + 4]!,
            destW: records[at + 5]!,
            destH: records[at + 6]!,
            borderColor: colorToHex(records[at + 7]!),
          });
          at += TSE_OP_CANVAS_LEN;
          break;
        case TSE_OP_SCISSOR:
          need(TSE_OP_SCISSOR_LEN);
          out?.push({ op: "scissor", x: records[at + 1]!, y: records[at + 2]!, width: records[at + 3]!, height: records[at + 4]! });
          at += TSE_OP_SCISSOR_LEN;
          break;
        case TSE_OP_SCISSOR_END:
          need(TSE_OP_SCISSOR_END_LEN);
          out?.push({ op: "scissorEnd" });
          at += TSE_OP_SCISSOR_END_LEN;
          break;
        case TSE_OP_LIGHT:
          need(TSE_OP_LIGHT_LEN);
          out?.push({ op: "light", ...placed(), radius: records[at + 6]!, color: colorToHex(records[at + 7]!) });
          at += TSE_OP_LIGHT_LEN;
          break;
        case TSE_OP_LAYER_BEGIN:
          need(TSE_OP_LAYER_BEGIN_LEN);
          if (++depth > TSE_LAYER_MAX) throw new Error(`Layers nested deeper than ${TSE_LAYER_MAX} at ${at}.`);
          out?.push({ op: "layerBegin", clear: colorToHex(records[at + 1]!), childBlend: blendName(records[at + 2]!) });
          at += TSE_OP_LAYER_BEGIN_LEN;
          break;
        case TSE_OP_LAYER_END:
          need(TSE_OP_LAYER_END_LEN);
          if (--depth < 0) throw new Error(`A layer end with no layer open at ${at}.`);
          {
            const handle = records[at + 3]!;
            const shader = handle >= 0 ? this.#shaders[handle] : null;
            if (shader === undefined) throw new Error(`Layer end record uses shader handle ${handle}, which was never loaded.`);
            out?.push({
              op: "layerEnd",
              blend: blendName(records[at + 1]!),
              tint: colorToHex(records[at + 2]!),
              shader,
              time: records[at + 4]!,
              params: Array.from(records.subarray(at + 5, at + 13)),
            });
          }
          at += TSE_OP_LAYER_END_LEN;
          break;
        case TSE_OP_SPRITE: {
          need(TSE_OP_SPRITE_LEN);
          const handle = records[at + 6] as number;
          const texture = this.#textures[handle];
          if (texture === undefined) throw new Error(`Sprite record uses texture handle ${handle}, which was never loaded.`);
          out?.push({ op: "sprite", ...placed(), texture });
          at += TSE_OP_SPRITE_LEN;
          break;
        }
        case TSE_OP_SPRITE_REGION: {
          need(TSE_OP_SPRITE_REGION_LEN);
          const handle = records[at + 6] as number;
          const texture = this.#textures[handle];
          if (texture === undefined) throw new Error(`Sprite region record uses texture handle ${handle}, which was never loaded.`);
          const flags = records[at + 13] as number;
          out?.push({
            op: "spriteRegion",
            ...placed(),
            texture,
            srcX: records[at + 7]!,
            srcY: records[at + 8]!,
            srcW: records[at + 9]!,
            srcH: records[at + 10]!,
            originX: records[at + 11]!,
            originY: records[at + 12]!,
            flipX: (flags & TSE_SPRITE_FLIP_X) !== 0,
            flipY: (flags & TSE_SPRITE_FLIP_Y) !== 0,
            tint: colorToHex(records[at + 14]!),
            ...((flags & TSE_SPRITE_SILHOUETTE) !== 0 ? { silhouette: true as const } : {}),
          });
          at += TSE_OP_SPRITE_REGION_LEN;
          break;
        }
        case TSE_OP_SPRITE_SHADED: {
          need(TSE_OP_SPRITE_SHADED_LEN);
          const handle = records[at + 6] as number;
          const texture = this.#textures[handle];
          if (texture === undefined) throw new Error(`Shaded sprite record uses texture handle ${handle}, which was never loaded.`);
          const shaderHandle = records[at + 15] as number;
          const shader = this.#shaders[shaderHandle];
          if (shader === undefined) throw new Error(`Shaded sprite record uses shader handle ${shaderHandle}, which was never loaded.`);
          const lookupHandle = records[at + 16] as number;
          const lookup = lookupHandle >= 0 ? this.#textures[lookupHandle] : null;
          if (lookup === undefined)
            throw new Error(`Shaded sprite record uses lookup texture handle ${lookupHandle}, which was never loaded.`);
          const flags = records[at + 13] as number;
          out?.push({
            op: "spriteShaded",
            ...placed(),
            texture,
            srcX: records[at + 7]!,
            srcY: records[at + 8]!,
            srcW: records[at + 9]!,
            srcH: records[at + 10]!,
            originX: records[at + 11]!,
            originY: records[at + 12]!,
            flipX: (flags & TSE_SPRITE_FLIP_X) !== 0,
            flipY: (flags & TSE_SPRITE_FLIP_Y) !== 0,
            tint: colorToHex(records[at + 14]!),
            shader,
            lookup,
            params: Array.from(records.subarray(at + 17, at + 25)),
          });
          at += TSE_OP_SPRITE_SHADED_LEN;
          break;
        }
        case TSE_OP_RECT:
        case TSE_OP_ELLIPSE: {
          need(TSE_OP_RECT_LEN);
          out?.push({
            op: op === TSE_OP_RECT ? "rect" : "ellipse",
            ...placed(),
            width: records[at + 6]!,
            height: records[at + 7]!,
            color: colorToHex(records[at + 8]!),
          });
          at += op === TSE_OP_RECT ? TSE_OP_RECT_LEN : TSE_OP_ELLIPSE_LEN;
          break;
        }
        case TSE_OP_BOX: {
          need(TSE_OP_BOX_LEN);
          out?.push({
            op: "box",
            ...placed(),
            width: records[at + 6]!,
            height: records[at + 7]!,
            fill: colorToHex(records[at + 8]!),
            borderColor: colorToHex(records[at + 9]!),
            borderWidth: records[at + 10]!,
            radius: records[at + 11]!,
          });
          at += TSE_OP_BOX_LEN;
          break;
        }
        case TSE_OP_TEXT: {
          need(TSE_OP_TEXT_LEN);
          const index = records[at + 6] as number;
          const text = texts[index];
          if (text === undefined) throw new Error(`Text record uses string ${index}, but the frame has ${texts.length}.`);
          out?.push({ op: "text", ...placed(), text, size: records[at + 7]!, color: colorToHex(records[at + 8]!) });
          at += TSE_OP_TEXT_LEN;
          break;
        }
        default:
          throw new Error(`Unknown draw op ${op} at record offset ${at}.`);
      }
    }
  }
}

/**
 * Write one scripted frame into the buffers a backend fills at the end of `frame`. A value the frame leaves out is zero
 * (and no key is down), except `dt` (1/60) and the window size, which fall back to `width` and `height`.
 */
/** Finds where a label is on screen, in window pixels: `Player.pointOf`. Null when nothing that can be pressed holds it. */
export type AimLookup = (label: string) => { readonly x: number; readonly y: number } | null;

/** What a backend keeps between frames to resolve `InputFrame.aim`: how labels are looked up, and where the last one was. */
export interface AimState {
  lookup: AimLookup | undefined;
  /** The labels that could be aimed at now (`Player.labels`), for the error when one is not there. */
  labels?: (() => readonly string[]) | undefined;
  last: { readonly x: number; readonly y: number } | undefined;
}

/**
 * A scripted frame with its `aim` turned into a mouse position: looked up now for a `fresh` one (the game as it was just drawn,
 * which is what the step that reads this frame will act on), the same place again for the frames after it.
 */
export function aimFrame(frame: InputFrame, state: AimState): InputFrame {
  if (frame.aim === undefined) return frame;
  if (frame.aim.fresh) {
    if (state.lookup === undefined)
      throw new Error(
        `'${frame.aim.label}' in an input script names something on screen, which this run cannot look up: give the mouse a point (click@x,y).`
      );
    const found = state.lookup(frame.aim.label);
    if (found === null) {
      const there = state.labels?.() ?? [];
      throw new Error(
        `An input script aims at '${frame.aim.label}', and nothing that can be pressed is labelled that now.${there.length > 0 ? ` What can be pressed is labelled: ${there.join(", ")}.` : ""}`
      );
    }
    state.last = found;
  }
  return state.last === undefined ? frame : { ...frame, mouse: state.last };
}

export function applyInputFrame(next: InputFrame, input: Float64Array, keys: Uint8Array, width: number, height: number): void {
  input[TSE_IN_DT] = next.dt ?? 1 / 60;
  input[TSE_IN_WIDTH] = next.width ?? width;
  input[TSE_IN_HEIGHT] = next.height ?? height;
  input[TSE_IN_MOUSE_X] = next.mouse?.x ?? 0;
  input[TSE_IN_MOUSE_Y] = next.mouse?.y ?? 0;
  input[TSE_IN_WHEEL] = next.wheel ?? 0;
  input[TSE_IN_QUIT] = next.quit ? 1 : 0;
  keys.fill(0);
  for (const name of next.down ?? []) keys[keyIndex(name)]! |= TSE_KEY_DOWN;
  for (const name of next.pressed ?? []) keys[keyIndex(name)]! |= TSE_KEY_DOWN | TSE_KEY_PRESSED;
  for (const name of next.released ?? []) keys[keyIndex(name)]! |= TSE_KEY_RELEASED;
}

function handleFor(paths: string[], path: string): number {
  const existing = paths.indexOf(path);
  if (existing >= 0) return existing;
  paths.push(path);
  return paths.length - 1;
}

function keyIndex(name: string): number {
  const index = KEY_INDEX.get(name);
  if (index === undefined) throw new Error(`Unknown key '${name}' (known: ${KEYS.join(", ")}).`);
  return index;
}
