/**
 * A `Backend` for the browser: WebGL2 for drawing (`WebRenderer`), Web Audio for sounds, an audio element for music, localStorage for
 * saved data, and DOM events for input (`WebInput`). The player asks for an asset and its size in the same call, so every file the game
 * may load is fetched and decoded before it starts (`preloadAssets`); a load is then a lookup, as it is from disk natively.
 */
import type { Backend, StorageBackend, WindowConfig } from "@tsengine/player";
import { TSE_IN_DT, TSE_IN_HEIGHT, TSE_IN_WIDTH, TSE_OP_CANVAS, TSE_SOUND_VOICES } from "@tsengine/player";

import { BUILTIN_FONT_BITS } from "./fonts-data.ts";
import { WebInput } from "./input.ts";
import { WebRenderer, type GlTexture, type LayerShader } from "./renderer.ts";

/** A file the game ships, as `preloadAssets` fetched it. */
export type Preloaded =
  | { readonly kind: "image"; readonly image: ImageBitmap }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "audio"; readonly bytes: ArrayBuffer; readonly url: string };

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const AUDIO = /\.(wav|ogg|mp3|flac|m4a)$/i;

/** `./a/b.png` and `a//b.png` as `a/b.png`: the key a loaded file is found by. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

/**
 * Fetch and decode every file in `files` (paths relative to `base`, as the game names them): images decoded without premultiplying or
 * colour conversion (exact pixels, as libtse reads them), shaders and other text as text, sounds as bytes.
 */
export async function preloadAssets(base: string, files: readonly string[]): Promise<Map<string, Preloaded>> {
  const loaded = new Map<string, Preloaded>();
  await Promise.all(
    files.map(async (file) => {
      const path = normalizePath(file);
      const url = new URL(path.split("/").map(encodeURIComponent).join("/"), base).href;
      const response = await fetch(url);
      if (!response.ok) return;
      if (IMAGE.test(path)) {
        const blob = await response.blob();
        const image = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        loaded.set(path, { kind: "image", image });
      } else if (AUDIO.test(path)) loaded.set(path, { kind: "audio", bytes: await response.arrayBuffer(), url });
      else loaded.set(path, { kind: "text", text: await response.text() });
    })
  );
  return loaded;
}

interface TextureEntry {
  readonly path: string;
  readonly texture: GlTexture;
  /** Its pixels, kept for its silhouette (made the first time one is drawn). */
  readonly source: TexImageSource | Uint8Array;
  silhouette: GlTexture | null;
}

interface SoundEntry {
  buffer: AudioBuffer | null;
  readonly voices: AudioBufferSourceNode[];
}

export class WebBackend implements Backend {
  readonly #canvas: HTMLCanvasElement;
  readonly #files: ReadonlyMap<string, Preloaded>;
  readonly #input: WebInput;
  #renderer: WebRenderer | null = null;
  readonly #textures: TextureEntry[] = [];
  readonly #shaders: LayerShader[] = [];
  readonly #sounds: SoundEntry[] = [];
  readonly #music: { readonly element: HTMLAudioElement; wanted: boolean }[] = [];
  readonly #textCache = new Map<string, GlTexture>();
  #audio: AudioContext | null = null;
  #last = -1;
  /** Device pixels to a unit of the sizes the player is given: the pixel ratio (CSS pixels), or 1 once the game draws through a canvas. */
  #scale = globalThis.devicePixelRatio || 1;
  readonly #measure: CanvasRenderingContext2D | null;

  constructor(canvas: HTMLCanvasElement, files: ReadonlyMap<string, Preloaded>) {
    this.#canvas = canvas;
    this.#files = files;
    this.#input = new WebInput(canvas);
    this.#input.onGesture = () => this.unlockAudio();
    this.#measure = canvas.ownerDocument.createElement("canvas").getContext("2d");
  }

  /** Saved data in localStorage, each entry under the game's id. */
  readonly storage: StorageBackend = (() => {
    let prefix = "";
    const valid = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);
    return {
      open: (gameId: string) => {
        if (!valid(gameId)) return false;
        prefix = `tse:${gameId}:`;
        try {
          return typeof localStorage !== "undefined";
        } catch {
          return false;
        }
      },
      read: (name: string) => {
        if (prefix === "" || !valid(name)) return null;
        try {
          return localStorage.getItem(prefix + name);
        } catch {
          return null;
        }
      },
      write: (name: string, text: string) => {
        if (prefix === "" || !valid(name)) return false;
        try {
          localStorage.setItem(prefix + name, text);
          return true;
        } catch {
          return false;
        }
      },
      remove: (name: string) => {
        if (prefix === "" || !valid(name)) return;
        try {
          localStorage.removeItem(prefix + name);
        } catch {
          // Nothing to remove where storage is off.
        }
      },
    };
  })();

  open(config: WindowConfig): void {
    if (this.#renderer !== null) throw new Error("The window is open already.");
    const doc = this.#canvas.ownerDocument;
    if (config.title) doc.title = config.title;
    const gl = this.#canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (gl === null) throw new Error("This browser cannot run WebGL2, which the game needs.");
    this.#renderer = new WebRenderer(gl, this.#assetsForRenderer(), config.smooth ?? false);
    this.#resize();
  }

  close(): void {
    this.#audio?.close().catch(() => {});
    for (const m of this.#music) m.element.pause();
  }

  setFullscreen(on: boolean): boolean {
    const doc = this.#canvas.ownerDocument;
    if (on && doc.fullscreenElement === null) doc.documentElement.requestFullscreen?.().catch(() => {});
    else if (!on && doc.fullscreenElement !== null) doc.exitFullscreen?.().catch(() => {});
    return true;
  }

  get #gl(): WebRenderer {
    if (this.#renderer === null) throw new Error("The window is not open.");
    return this.#renderer;
  }

  #file(path: string): Preloaded | undefined {
    return this.#files.get(normalizePath(path));
  }

  loadTexture(path: string): number {
    const renderer = this.#gl;
    let source: TexImageSource | Uint8Array;
    let width: number, height: number;
    const font = path.startsWith("tse:") ? BUILTIN_FONT_BITS[path] : undefined;
    if (font !== undefined) {
      width = 16 * font.cellWidth;
      height = 6 * font.cellHeight;
      source = fontPixels(font.bits, width, height);
    } else {
      const file = this.#file(path);
      if (file?.kind !== "image") return -1;
      source = file.image;
      width = file.image.width;
      height = file.image.height;
    }
    const texture = renderer.makeTexture(width, height, source, renderer.smooth);
    this.#textures.push({ path, texture, source, silhouette: null });
    return this.#textures.length - 1;
  }

  textureSize(handle: number): { width: number; height: number } {
    const entry = this.#textures[handle];
    if (entry === undefined) throw new Error(`There is no texture with handle ${handle}.`);
    return { width: entry.texture.width, height: entry.texture.height };
  }

  loadShader(path: string): number {
    const file = this.#file(path);
    if (file?.kind !== "text") return -1;
    try {
      this.#shaders.push(this.#gl.compileLayerShader(file.text));
      return this.#shaders.length - 1;
    } catch (error) {
      console.warn(`TSE: the shader ${path} did not compile: what it shades is drawn without it.\n${String(error)}`);
      return -1;
    }
  }

  // ---------- Sound ----------

  /** Browsers start audio only after the player has pressed something: the first press starts it, and any music asked for meanwhile. */
  unlockAudio(): void {
    const ctx = this.#context();
    if (ctx !== null && ctx.state === "suspended") ctx.resume().catch(() => {});
    for (const m of this.#music) if (m.wanted && m.element.paused) m.element.play().catch(() => {});
  }

  #context(): AudioContext | null {
    if (this.#audio === null && typeof AudioContext !== "undefined") this.#audio = new AudioContext();
    return this.#audio;
  }

  loadSound(path: string): number {
    const file = this.#file(path);
    if (file?.kind !== "audio") return -1;
    const entry: SoundEntry = { buffer: null, voices: [] };
    const ctx = this.#context();
    // Decoding is asynchronous: a sound asked for before it is decoded is skipped, as a sound with no device is.
    ctx?.decodeAudioData(file.bytes.slice(0)).then(
      (buffer) => (entry.buffer = buffer),
      () => {}
    );
    this.#sounds.push(entry);
    return this.#sounds.length - 1;
  }

  playSound(handle: number, volume = 1): void {
    const entry = this.#sounds[handle];
    const ctx = this.#audio;
    if (entry === undefined || entry.buffer === null || ctx === null || ctx.state !== "running") return;
    if (entry.voices.length >= TSE_SOUND_VOICES) entry.voices.shift()?.stop();
    const source = ctx.createBufferSource();
    source.buffer = entry.buffer;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, Math.max(0, volume));
    source.connect(gain).connect(ctx.destination);
    source.onended = () => {
      const i = entry.voices.indexOf(source);
      if (i >= 0) entry.voices.splice(i, 1);
    };
    entry.voices.push(source);
    source.start();
  }

  loadMusic(path: string): number {
    const file = this.#file(path);
    if (file?.kind !== "audio") return -1;
    // From the bytes already fetched, so the track is not downloaded a second time.
    const element = new Audio(URL.createObjectURL(new Blob([file.bytes])));
    element.preload = "auto";
    this.#music.push({ element, wanted: false });
    return this.#music.length - 1;
  }

  playMusic(handle: number, volume: number, loop: boolean): void {
    const m = this.#music[handle];
    if (m === undefined) return;
    m.element.loop = loop;
    m.element.volume = Math.min(1, Math.max(0, volume));
    m.element.currentTime = 0;
    m.wanted = true;
    m.element.play().catch(() => {});
  }

  setMusicVolume(handle: number, volume: number): void {
    const m = this.#music[handle];
    if (m !== undefined) m.element.volume = Math.min(1, Math.max(0, volume));
  }

  stopMusic(handle: number): void {
    const m = this.#music[handle];
    if (m === undefined) return;
    m.wanted = false;
    m.element.pause();
    m.element.currentTime = 0;
  }

  setGamepadDeadzone(deadzone: number): void {
    this.#input.deadzone = Math.min(1, Math.max(0, deadzone));
  }

  // ---------- Text ----------

  /** raylib's default font is not in the browser: text without a bitmap font is drawn and measured with the browser's monospace. */
  measureText(text: string, size: number): { width: number; height: number } {
    const ctx = this.#measure;
    if (ctx === null) return { width: text.length * size * 0.6, height: size };
    ctx.font = `${size}px monospace`;
    return { width: ctx.measureText(text).width + (size / 10) * Math.max(0, [...text].length - 1), height: size };
  }

  #textTexture(text: string, size: number): GlTexture | null {
    const key = `${size}\u0000${text}`;
    const hit = this.#textCache.get(key);
    if (hit !== undefined) return hit;
    const doc = this.#canvas.ownerDocument;
    const canvas = doc.createElement("canvas");
    const { width, height } = this.measureText(text, size);
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    ctx.font = `${size}px monospace`;
    ctx.textBaseline = "top";
    ctx.fillStyle = "white";
    let x = 0;
    for (const ch of text) {
      ctx.fillText(ch, x, 0);
      x += ctx.measureText(ch).width + size / 10;
    }
    const texture = this.#gl.makeTexture(canvas.width, canvas.height, canvas, true);
    this.#textCache.set(key, texture);
    return texture;
  }

  #assetsForRenderer() {
    return {
      texture: (handle: number) => this.#textures[handle]?.texture ?? null,
      silhouette: (handle: number) => {
        const entry = this.#textures[handle];
        if (entry === undefined) return null;
        entry.silhouette ??= this.#makeSilhouette(entry);
        return entry.silhouette;
      },
      shader: (handle: number) => this.#shaders[handle] ?? null,
      text: (text: string, size: number) => this.#textTexture(text, size),
    };
  }

  /** White where the image is, with the image's alpha: what a hit flash fills with its tint. */
  #makeSilhouette(entry: TextureEntry): GlTexture | null {
    const { width, height } = entry.texture;
    let pixels: Uint8Array;
    if (entry.source instanceof Uint8Array) pixels = entry.source.slice();
    else {
      const canvas = this.#canvas.ownerDocument.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) return null;
      ctx.drawImage(entry.source as CanvasImageSource, 0, 0);
      pixels = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer);
    }
    for (let i = 0; i < pixels.length; i += 4) pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    return this.#gl.makeTexture(width, height, pixels, this.#gl.smooth);
  }

  // ---------- A frame ----------

  /** Match the drawing buffer to the canvas's size on screen, in device pixels, so pixel art is drawn at the screen's own resolution. */
  #resize(): void {
    const ratio = globalThis.devicePixelRatio || 1;
    // Sizes in CSS pixels, drawn at the screen's density, as libtse's high-DPI window: until a <Screen> canvas is seen (see `frame`).
    if (this.#scale !== 1) this.#scale = ratio;
    const width = Math.max(1, Math.round(this.#canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.#canvas.clientHeight * ratio));
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
  }

  frame(clearColor: number, records: Float64Array, length: number, texts: readonly string[], input: Float64Array, keys: Uint8Array): void {
    const renderer = this.#gl;
    // Text textures are let go between frames, never during one: the frame being drawn may still have one waiting in its batch.
    if (this.#textCache.size > 512) {
      for (const t of this.#textCache.values()) renderer.gl.deleteTexture(t.texture);
      this.#textCache.clear();
    }
    renderer.frame(this.#canvas.width, this.#canvas.height, this.#scale, clearColor, records, length, texts);
    // A game drawn through a <Screen> canvas is a picture scaled into the window: from now on its window is measured in device pixels,
    // so a whole-number fit uses every pixel of a dense phone screen instead of a whole number of CSS pixels.
    if (length > 0 && records[0] === TSE_OP_CANVAS) this.#scale = 1;
    this.#resize();
    const now = performance.now();
    input[TSE_IN_DT] = this.#last < 0 ? 1 / 60 : Math.min(0.25, Math.max(0, (now - this.#last) / 1000));
    this.#last = now;
    input[TSE_IN_WIDTH] = this.#canvas.width / this.#scale;
    input[TSE_IN_HEIGHT] = this.#canvas.height / this.#scale;
    this.#input.scale = this.#scale;
    this.#input.collect(input, keys);
  }

  typed(): string {
    return this.#input.typed();
  }
}

/** A built-in font's sheet as RGBA8: white and opaque where a bit is set, clear elsewhere. */
function fontPixels(base64: string, width: number, height: number): Uint8Array {
  const bits = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  const stride = Math.ceil(width / 8);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!((bits[y * stride + (x >> 3)] ?? 0) & (0x80 >> (x & 7)))) continue;
      pixels.set([255, 255, 255, 255], (y * width + x) * 4);
    }
  return pixels;
}
