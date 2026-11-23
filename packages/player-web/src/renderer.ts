/**
 * The draw records of `native/include/tse.h`, executed with WebGL2: what `native/src/tse.c` does with raylib, done in the browser.
 * Each record is drawn as triangles, transformed on the CPU (the view, then the record's translate, rotate and scale), and batched
 * until the texture, the blend or the target changes. Layers and the canvas are framebuffers; a layer's or a shaded sprite's shader
 * is the author's `effect` function wrapped for GLSL ES 3.00, as libtse wraps it for desktop GLSL.
 */
import {
  TSE_BLEND_ADD,
  TSE_BLEND_MULTIPLY,
  TSE_BLEND_NORMAL,
  TSE_BLEND_SCREEN,
  TSE_LAYER_MAX,
  TSE_OP_BOX,
  TSE_OP_BOX_LEN,
  TSE_OP_CANVAS,
  TSE_OP_CANVAS_LEN,
  TSE_OP_ELLIPSE,
  TSE_OP_ELLIPSE_LEN,
  TSE_OP_LAYER_BEGIN,
  TSE_OP_LAYER_BEGIN_LEN,
  TSE_OP_LAYER_END,
  TSE_OP_LAYER_END_LEN,
  TSE_OP_LIGHT,
  TSE_OP_LIGHT_LEN,
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
  TSE_OP_TEXT,
  TSE_OP_TEXT_LEN,
  TSE_OP_VIEW,
  TSE_OP_VIEW_LEN,
} from "@tsengine/player";

const TSE_SPRITE_FLIP_X = 1;
const TSE_SPRITE_FLIP_Y = 2;
const TSE_SPRITE_SILHOUETTE = 4;
const MAX_CANVAS = 16384;

/** A texture the renderer can draw: its GL handle and size, and whether its rows are stored bottom first (a framebuffer's). */
export interface GlTexture {
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly flipped: boolean;
}

/** What the renderer asks its owner for: textures by handle (and their silhouettes), shaders by handle, and text drawn to a texture. */
export interface RendererAssets {
  texture(handle: number): GlTexture | null;
  silhouette(handle: number): GlTexture | null;
  shader(handle: number): LayerShader | null;
  text(text: string, size: number): GlTexture | null;
}

/** A compiled shader (a layer's, or a shaded sprite's) and where its inputs are. */
export interface LayerShader {
  readonly program: WebGLProgram;
  readonly resolution: WebGLUniformLocation | null;
  readonly time: WebGLUniformLocation | null;
  readonly params: WebGLUniformLocation | null;
  readonly region: WebGLUniformLocation | null;
  readonly turn: WebGLUniformLocation | null;
  readonly lookup: WebGLUniformLocation | null;
  readonly targetSize: WebGLUniformLocation | null;
  readonly image: WebGLUniformLocation | null;
  readonly colDiffuse: WebGLUniformLocation | null;
}

/** A framebuffer with a colour texture and no depth: the canvas, or a layer. */
interface Target {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: GlTexture;
}

const VERTEX = `#version 300 es
in vec2 position;
in vec2 texCoord;
in vec4 color;
uniform vec2 targetSize;
out vec2 fragTexCoord;
out vec4 fragColor;
void main() {
  fragTexCoord = texCoord;
  fragColor = color;
  gl_Position = vec4(position.x / targetSize.x * 2.0 - 1.0, 1.0 - position.y / targetSize.y * 2.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 fragTexCoord;
in vec4 fragColor;
uniform sampler2D texture0;
out vec4 finalColor;
void main() {
  finalColor = texture(texture0, fragTexCoord) * fragColor;
}`;

/**
 * What wraps an author's `effect` function: the inputs it is given, and the main that calls it. The same names libtse gives it
 * (`image`, `pixel`, `resolution`, `time`, `params`, `region`, `turn`, `lookup`), in GLSL ES 3.00; `#line 1` counts the compiler's
 * lines in the author's file. `turn` is a mat2 made from a vec4 of its columns, because libtse's raylib has no mat2 uniform.
 */
export const SHADER_HEAD = `#version 300 es
precision highp float;
precision highp int;
in vec2 fragTexCoord;
in vec4 fragColor;
uniform sampler2D texture0;
uniform vec4 colDiffuse;
uniform vec2 resolution;
uniform float time;
uniform float params[8];
uniform vec4 region;
uniform vec4 tseTurn;
uniform sampler2D lookup;
out vec4 finalColor;
vec2 pixel;
#define image texture0
#define turn mat2(tseTurn.xy, tseTurn.zw)
#line 1
`;
export const SHADER_TAIL = `
void main() {
  pixel = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
  finalColor = effect(fragTexCoord) * colDiffuse * fragColor;
}
`;

/** Floats a vertex holds: x, y, u, v, r, g, b, a. */
const STRIDE = 8;
const MAX_VERTICES = 65536;

/** A 2D affine transform: x' = a x + c y + e, y' = b x + d y + f. */
type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

const WHITE: readonly number[] = [1, 1, 1, 1];
/** `turn` for what is not turned: a layer, or a sprite drawn upright. */
const IDENTITY_TURN: readonly number[] = [1, 0, 0, 1];

/** A record field as an index or an op: -1 unless it is a whole number in range. */
function toIndex(value: number): number {
  return value >= 0 && value <= 2147483647 ? Math.floor(value) : -1;
}

/** A packed 0xRRGGBBAA colour as four numbers 0 to 1; anything that is not one is magenta. */
function unpack(value: number, out: number[] = [0, 0, 0, 0]): number[] {
  const v = value >= 0 && value <= 4294967295 ? value : 0xff00ffff;
  out[0] = Math.floor(v / 16777216) / 255;
  out[1] = (Math.floor(v / 65536) & 255) / 255;
  out[2] = (Math.floor(v / 256) & 255) / 255;
  out[3] = (v & 255) / 255;
  return out;
}

const finite = (v: number) => (Number.isFinite(v) ? v : 0);

/** The segments for one rounded corner, as libtse picks them: about one a pixel of radius, 4 to 24. */
const cornerSegments = (radius: number) => Math.min(24, Math.max(4, Math.ceil(radius)));

export class WebRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly #assets: RendererAssets;
  readonly #program: WebGLProgram;
  readonly #programTargetSize: WebGLUniformLocation | null;
  readonly #vao: WebGLVertexArrayObject;
  readonly #buffer: WebGLBuffer;
  readonly #vertices = new Float32Array(MAX_VERTICES * STRIDE);
  #count = 0;
  readonly #white: GlTexture;
  #batchTexture: GlTexture | null = null;
  #canvas: Target | null = null;
  readonly #layers: (Target | null)[] = new Array(TSE_LAYER_MAX).fill(null);
  #warned = false;
  // Scratch values reused for every record, so a frame allocates nothing per record.
  readonly #color = [0, 0, 0, 0];
  readonly #color2 = [0, 0, 0, 0];
  readonly #ringInner = [0, 0, 0, 1];
  readonly #ringOuter = [0, 0, 0, 1];
  readonly #local: Affine = [1, 0, 0, 1, 0, 0];
  readonly #params = new Float32Array(8);
  readonly #turnOut = [1, 0, 0, 1];
  /** Target pixels per unit the records use: the device pixel ratio for a window drawn at full density, 1 for the canvas and layers in it. */
  #scale = 1;

  // The frame's target state, as tse.c keeps it.
  #targetWidth = 0;
  #targetHeight = 0;
  #depth = 0;
  readonly #childBlend: number[] = new Array(TSE_LAYER_MAX + 1).fill(TSE_BLEND_NORMAL);
  #view: Affine = IDENTITY;
  #scissor: [number, number, number, number] | null = null;
  #blend = -1;
  #program_: WebGLProgram | null = null;
  #smooth: boolean;

  constructor(gl: WebGL2RenderingContext, assets: RendererAssets, smooth: boolean) {
    this.gl = gl;
    this.#assets = assets;
    this.#smooth = smooth;
    this.#program = this.compile(VERTEX, FRAGMENT);
    this.#programTargetSize = gl.getUniformLocation(this.#program, "targetSize");
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (vao === null || buffer === null) throw new Error("WebGL2: could not make the vertex buffer");
    this.#vao = vao;
    this.#buffer = buffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.#vertices.byteLength, gl.DYNAMIC_DRAW);
    // The same attribute locations in every program: they are bound before linking.
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE * 4, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE * 4, 16);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    this.#white = this.makeTexture(1, 1, new Uint8Array([255, 255, 255, 255]), false);
  }

  /** Link a program with the attribute locations every draw uses. Throws with the compiler's message. */
  compile(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (s === null) throw new Error("WebGL2: could not make a shader");
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? "";
        gl.deleteShader(s);
        throw new Error(log);
      }
      return s;
    };
    const program = gl.createProgram();
    if (program === null) throw new Error("WebGL2: could not make a program");
    const vs = shader(gl.VERTEX_SHADER, vertexSource);
    const fs = shader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "position");
    gl.bindAttribLocation(program, 1, "texCoord");
    gl.bindAttribLocation(program, 2, "color");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    return program;
  }

  /** A layer shader from the author's `effect` function, wrapped; throws with the compiler's message if it does not compile. */
  compileLayerShader(body: string): LayerShader {
    const program = this.compile(VERTEX, SHADER_HEAD + body + SHADER_TAIL);
    const gl = this.gl;
    return {
      program,
      resolution: gl.getUniformLocation(program, "resolution"),
      time: gl.getUniformLocation(program, "time"),
      params: gl.getUniformLocation(program, "params"),
      region: gl.getUniformLocation(program, "region"),
      turn: gl.getUniformLocation(program, "tseTurn"),
      lookup: gl.getUniformLocation(program, "lookup"),
      targetSize: gl.getUniformLocation(program, "targetSize"),
      image: gl.getUniformLocation(program, "texture0"),
      colDiffuse: gl.getUniformLocation(program, "colDiffuse"),
    };
  }

  /** A texture from RGBA8 pixels (top row first), or from an image the browser decoded. */
  makeTexture(width: number, height: number, pixels: Uint8Array | TexImageSource | null, smooth: boolean): GlTexture {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (texture === null) throw new Error("WebGL2: could not make a texture");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (pixels === null || pixels instanceof Uint8Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels ?? new Uint8Array(width * height * 4));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    const filter = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.#batchTexture = null;
    return { texture, width, height, flipped: false };
  }

  get smooth(): boolean {
    return this.#smooth;
  }

  #makeTarget(width: number, height: number): Target | null {
    const gl = this.gl;
    const tex = this.makeTexture(width, height, null, false);
    const framebuffer = gl.createFramebuffer();
    if (framebuffer === null) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) return null;
    return { framebuffer, texture: { ...tex, flipped: true } };
  }

  #dropTarget(target: Target | null): void {
    if (target === null) return;
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture.texture);
  }

  #report(why: string, at: number): void {
    if (this.#warned) return;
    this.#warned = true;
    console.error(`TSE: malformed draw records (${why} at ${at}): the rest of the frame is not drawn`);
  }

  // ---------- Batching ----------

  #flush(): void {
    if (this.#count === 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.#vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#vertices, 0, this.#count * STRIDE);
    gl.drawArrays(gl.TRIANGLES, 0, this.#count);
    this.#count = 0;
  }

  #useTexture(tex: GlTexture): void {
    if (this.#batchTexture === tex && this.#program_ === this.#program) return;
    this.#flush();
    const gl = this.gl;
    if (this.#program_ !== this.#program) {
      gl.useProgram(this.#program);
      gl.uniform2f(this.#programTargetSize, this.#targetWidth / this.#scale, this.#targetHeight / this.#scale);
      this.#program_ = this.#program;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.texture);
    this.#batchTexture = tex;
  }

  /** One vertex, in local coordinates under `m`. */
  #vertex(m: Affine, x: number, y: number, u: number, v: number, c: readonly number[]): void {
    if (this.#count >= MAX_VERTICES) this.#flush();
    const o = this.#count * STRIDE;
    const a = this.#vertices;
    a[o] = m[0] * x + m[2] * y + m[4];
    a[o + 1] = m[1] * x + m[3] * y + m[5];
    a[o + 2] = u;
    a[o + 3] = v;
    a[o + 4] = c[0]!;
    a[o + 5] = c[1]!;
    a[o + 6] = c[2]!;
    a[o + 7] = c[3]!;
    this.#count++;
  }

  /** Make room for `n` vertices in one go, so a triangle never straddles a flush. */
  #reserve(n: number): void {
    if (this.#count + n > MAX_VERTICES) this.#flush();
  }

  #quad(
    m: Affine,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    c: readonly number[]
  ): void {
    this.#reserve(6);
    this.#vertex(m, x0, y0, u0, v0, c);
    this.#vertex(m, x1, y0, u1, v0, c);
    this.#vertex(m, x1, y1, u1, v1, c);
    this.#vertex(m, x0, y0, u0, v0, c);
    this.#vertex(m, x1, y1, u1, v1, c);
    this.#vertex(m, x0, y1, u0, v1, c);
  }

  #rect(m: Affine, x: number, y: number, w: number, h: number, c: readonly number[]): void {
    if (!(w > 0 && h > 0)) return;
    this.#useTexture(this.#white);
    this.#quad(m, x, y, x + w, y + h, 0.5, 0.5, 0.5, 0.5, c);
  }

  /** A ring between radii r0 and r1 about (cx, cy), from angle a0 to a1 in degrees (clockwise on screen from +x); r0 0 is a sector. */
  #ring(m: Affine, cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, segments: number, c: readonly number[]): void {
    this.#useTexture(this.#white);
    for (let s = 0; s < segments; s++) {
      const t0 = ((a0 + ((a1 - a0) * s) / segments) * Math.PI) / 180;
      const t1 = ((a0 + ((a1 - a0) * (s + 1)) / segments) * Math.PI) / 180;
      const ix0 = cx + Math.cos(t0) * r0,
        iy0 = cy + Math.sin(t0) * r0;
      const ix1 = cx + Math.cos(t1) * r0,
        iy1 = cy + Math.sin(t1) * r0;
      const ox0 = cx + Math.cos(t0) * r1,
        oy0 = cy + Math.sin(t0) * r1;
      const ox1 = cx + Math.cos(t1) * r1,
        oy1 = cy + Math.sin(t1) * r1;
      this.#reserve(6);
      this.#vertex(m, ix0, iy0, 0.5, 0.5, c);
      this.#vertex(m, ox0, oy0, 0.5, 0.5, c);
      this.#vertex(m, ox1, oy1, 0.5, 0.5, c);
      if (r0 > 0) {
        this.#vertex(m, ix0, iy0, 0.5, 0.5, c);
        this.#vertex(m, ox1, oy1, 0.5, 0.5, c);
        this.#vertex(m, ix1, iy1, 0.5, 0.5, c);
      }
    }
  }

  #ellipse(m: Affine, w: number, h: number, c: readonly number[]): void {
    if (!(w > 0 && h > 0)) return;
    this.#useTexture(this.#white);
    const cx = w / 2,
      cy = h / 2,
      segments = Math.min(72, Math.max(24, Math.ceil(Math.max(w, h))));
    for (let s = 0; s < segments; s++) {
      const t0 = (2 * Math.PI * s) / segments,
        t1 = (2 * Math.PI * (s + 1)) / segments;
      this.#reserve(3);
      this.#vertex(m, cx, cy, 0.5, 0.5, c);
      this.#vertex(m, cx + Math.cos(t0) * cx, cy + Math.sin(t0) * cy, 0.5, 0.5, c);
      this.#vertex(m, cx + Math.cos(t1) * cx, cy + Math.sin(t1) * cy, 0.5, 0.5, c);
    }
  }

  /** TSE_OP_BOX, as tse.c's draw_box: the fill, then the border inside the edge in exact pieces. */
  #box(m: Affine, width: number, height: number, fill: number, border: number, borderWidth: number, radius: number): void {
    width = finite(width);
    height = finite(height);
    if (!(width > 0 && height > 0)) return;
    const half = Math.min(width, height) / 2;
    const r = Math.max(0, Math.min(finite(radius), half));
    const bw = Math.min(finite(borderWidth), half);
    const fillColor = unpack(fill, this.#color);
    if (fillColor[3]! > 0) {
      if (r > 0) {
        // The middle cross, then a quarter disc in each corner.
        this.#rect(m, r, 0, width - 2 * r, height, fillColor);
        this.#rect(m, 0, r, r, height - 2 * r, fillColor);
        this.#rect(m, width - r, r, r, height - 2 * r, fillColor);
        const seg = cornerSegments(r);
        this.#ring(m, r, r, 0, r, 180, 270, seg, fillColor);
        this.#ring(m, width - r, r, 0, r, 270, 360, seg, fillColor);
        this.#ring(m, width - r, height - r, 0, r, 0, 90, seg, fillColor);
        this.#ring(m, r, height - r, 0, r, 90, 180, seg, fillColor);
      } else this.#rect(m, 0, 0, width, height, fillColor);
    }
    const c = unpack(border, this.#color2);
    if (!(c[3]! > 0 && bw > 0)) return;
    const k = Math.max(r, bw);
    const runX = width - 2 * k,
      runY = height - 2 * k;
    if (runX > 0) {
      this.#rect(m, k, 0, runX, bw, c);
      this.#rect(m, k, height - bw, runX, bw, c);
    }
    if (runY > 0) {
      this.#rect(m, 0, k, bw, runY, c);
      this.#rect(m, width - bw, k, bw, runY, c);
    }
    for (let corner = 0; corner < 4; corner++) {
      const right = corner === 1 || corner === 2,
        bottom = corner === 2 || corner === 3;
      const bx = right ? width - k : 0,
        by = bottom ? height - k : 0;
      if (r <= 0) {
        this.#rect(m, bx, by, k, k, c);
        continue;
      }
      const cx = right ? width - r : r,
        cy = bottom ? height - r : r;
      const from = 180 + 90 * corner;
      if (r >= bw) this.#ring(m, cx, cy, r - bw, r, from, from + 90, cornerSegments(r), c);
      else {
        this.#ring(m, cx, cy, 0, r, from, from + 90, cornerSegments(r), c);
        const rest = k - r;
        this.#rect(m, right ? bx : bx + r, by, rest, k, c);
        this.#rect(m, right ? bx + rest : bx, bottom ? by : by + r, r, rest, c);
      }
    }
  }

  /** TSE_OP_LIGHT: rings whose colour falls off as (1 - d)^2, premultiplied by the strength, opaque. */
  #light(m: Affine, radius: number, packed: number): void {
    if (!(radius > 0)) return;
    const c = unpack(packed, this.#color);
    const strength = c[3]!;
    this.#useTexture(this.#white);
    const RINGS = 6,
      SEGMENTS = 48;
    const c0 = this.#ringInner,
      c1 = this.#ringOuter;
    for (let ring = 0; ring < RINGS; ring++) {
      const t0 = ring / RINGS,
        t1 = (ring + 1) / RINGS;
      const k0 = (1 - t0) * (1 - t0) * strength,
        k1 = (1 - t1) * (1 - t1) * strength;
      for (let i = 0; i < 3; i++) {
        c0[i] = c[i]! * k0;
        c1[i] = c[i]! * k1;
      }
      for (let s = 0; s < SEGMENTS; s++) {
        const a0 = (2 * Math.PI * s) / SEGMENTS,
          a1 = (2 * Math.PI * (s + 1)) / SEGMENTS;
        const x00 = Math.cos(a0) * radius * t0,
          y00 = Math.sin(a0) * radius * t0;
        const x01 = Math.cos(a1) * radius * t0,
          y01 = Math.sin(a1) * radius * t0;
        const x10 = Math.cos(a0) * radius * t1,
          y10 = Math.sin(a0) * radius * t1;
        const x11 = Math.cos(a1) * radius * t1,
          y11 = Math.sin(a1) * radius * t1;
        this.#reserve(6);
        this.#vertex(m, x00, y00, 0.5, 0.5, c0);
        this.#vertex(m, x11, y11, 0.5, 0.5, c1);
        this.#vertex(m, x10, y10, 0.5, 0.5, c1);
        if (ring > 0) {
          this.#vertex(m, x00, y00, 0.5, 0.5, c0);
          this.#vertex(m, x01, y01, 0.5, 0.5, c0);
          this.#vertex(m, x11, y11, 0.5, 0.5, c1);
        }
      }
    }
  }

  /** A region of a texture drawn into the rectangle (dx, dy, dw, dh) in local coordinates. */
  #region(
    m: Affine,
    tex: GlTexture,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    c: readonly number[]
  ): void {
    this.#useTexture(tex);
    const u0 = sx / tex.width,
      u1 = (sx + sw) / tex.width;
    let v0 = sy / tex.height,
      v1 = (sy + sh) / tex.height;
    if (tex.flipped) {
      v0 = 1 - v0;
      v1 = 1 - v1;
    }
    this.#quad(m, dx, dy, dx + dw, dy + dh, u0, v0, u1, v1, c);
  }

  // ---------- Target state ----------

  #setBlend(mode: number): void {
    if (this.#blend === mode) return;
    this.#flush();
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    switch (mode) {
      case TSE_BLEND_ADD:
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        break;
      case TSE_BLEND_MULTIPLY:
        gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        break;
      case TSE_BLEND_SCREEN:
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
        break;
      default:
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    this.#blend = mode;
  }

  #applyScissor(): void {
    const gl = this.gl;
    if (this.#scissor === null) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    const [x, y, w, h] = this.#scissor;
    const k = this.#scale;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      Math.round(x * k),
      Math.round(this.#targetHeight - (y + h) * k),
      Math.max(0, Math.round(w * k)),
      Math.max(0, Math.round(h * k))
    );
  }

  /** Bind the target at the current depth: the innermost layer, or the base (the canvas, or the window when there is none). */
  #bindCurrent(base: Target | null): void {
    this.#flush();
    const gl = this.gl;
    const target = this.#depth > 0 ? this.#layers[this.#depth - 1]! : base;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target === null ? null : target.framebuffer);
    gl.viewport(0, 0, this.#targetWidth, this.#targetHeight);
    this.#program_ = null;
    this.#batchTexture = null;
    this.#applyScissor();
    this.#blend = -1;
    this.#setBlend(this.#childBlend[this.#depth]!);
  }

  #clear(color: number): void {
    const gl = this.gl;
    const c = unpack(color, this.#color);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(c[0]!, c[1]!, c[2]!, c[3]!);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.#applyScissor();
  }

  #beginLayer(base: Target | null, clear: number, childBlend: number): boolean {
    if (this.#depth >= TSE_LAYER_MAX) return false;
    this.#flush();
    let layer = this.#layers[this.#depth] ?? null;
    if (layer !== null && (layer.texture.width !== this.#targetWidth || layer.texture.height !== this.#targetHeight)) {
      this.#dropTarget(layer);
      layer = null;
    }
    if (layer === null) layer = this.#makeTarget(this.#targetWidth, this.#targetHeight);
    if (layer === null) return false;
    this.#layers[this.#depth] = layer;
    this.#depth++;
    this.#childBlend[this.#depth] = childBlend;
    this.#bindCurrent(base);
    this.#clear(clear);
    return true;
  }

  #endLayer(
    base: Target | null,
    blend: number,
    tint: number,
    shaderHandle: number,
    time: number,
    params: Float64Array | null,
    at: number
  ): void {
    if (this.#depth === 0) return;
    const layer = this.#layers[this.#depth - 1]!;
    this.#flush();
    this.#depth--;
    this.#bindCurrent(base);
    this.#setBlend(blend);
    const c = unpack(tint, this.#color);
    // Screen and multiply read no alpha from the source colour: the opacity goes on the colour too, as tse.c does.
    if (blend === TSE_BLEND_SCREEN || blend === TSE_BLEND_MULTIPLY) {
      c[0]! *= c[3]!;
      c[1]! *= c[3]!;
      c[2]! *= c[3]!;
    }
    const shader = shaderHandle >= 0 ? this.#assets.shader(shaderHandle) : null;
    // The layer covers its target exactly: in units, its size over the scale.
    const w = this.#targetWidth / this.#scale,
      h = this.#targetHeight / this.#scale;
    if (shader !== null) {
      this.#beginShader(shader, layer.texture, time, params, at + 5, 0, 0, this.#targetWidth, this.#targetHeight, IDENTITY_TURN, null);
      this.#quad(IDENTITY, 0, 0, w, h, 0, 1, 1, 0, c);
      this.#endShader();
    } else {
      this.#useTexture(layer.texture);
      this.#quad(IDENTITY, 0, 0, w, h, 0, 1, 1, 0, c);
      this.#flush();
    }
    this.#setBlend(this.#childBlend[this.#depth]!);
  }

  /**
   * Draw what is quadded next through `shader`, sampling `image` (bound now), with its inputs: the target's size, `time`, the eight
   * parameters at `records[from…]` (0 where missing or not finite), the region of the image drawn, how the image is turned (the
   * columns of a 2x2 matrix) and the lookup texture (a white pixel for none). `#endShader` draws it.
   */
  #beginShader(
    shader: LayerShader,
    image: GlTexture,
    time: number,
    records: Float64Array | null,
    from: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    turn: readonly number[],
    lookup: GlTexture | null
  ): void {
    this.#flush();
    const gl = this.gl;
    // In units, as libtse gives it.
    const w = this.#targetWidth / this.#scale,
      h = this.#targetHeight / this.#scale;
    gl.useProgram(shader.program);
    gl.uniform2f(shader.targetSize, w, h);
    if (shader.resolution !== null) gl.uniform2f(shader.resolution, w, h);
    if (shader.time !== null) gl.uniform1f(shader.time, time);
    if (shader.colDiffuse !== null) gl.uniform4f(shader.colDiffuse, 1, 1, 1, 1);
    if (shader.image !== null) gl.uniform1i(shader.image, 0);
    if (shader.params !== null) {
      const p = this.#params;
      for (let i = 0; i < 8; i++) p[i] = records !== null && Number.isFinite(records[from + i]) ? (records[from + i] as number) : 0;
      gl.uniform1fv(shader.params, p);
    }
    if (shader.region !== null) gl.uniform4f(shader.region, rx, ry, rw, rh);
    if (shader.turn !== null) gl.uniform4f(shader.turn, turn[0]!, turn[1]!, turn[2]!, turn[3]!);
    if (shader.lookup !== null) {
      gl.uniform1i(shader.lookup, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, (lookup ?? this.#white).texture);
    }
    this.#program_ = shader.program;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, image.texture);
    this.#batchTexture = image;
  }

  /** Draw what `#beginShader` started, and go back to the plain program on the next draw. */
  #endShader(): void {
    this.#flush();
    this.#program_ = null;
    this.#batchTexture = null;
  }

  /**
   * How a record's image is turned on the target, as the columns of a 2x2 matrix with no stretch (`turn` in tse.h): the view's
   * linear part, then the record's rotation, then the signs of its scale and its flips, made a rotation or a reflection.
   */
  #turn(r: Float64Array, at: number, flags: number): readonly number[] {
    const m = this.#view;
    const rot = finite(r[at + 3]!);
    const cos = Math.cos(rot),
      sin = Math.sin(rot);
    const fx = (r[at + 4]! < 0 ? -1 : 1) * (flags & TSE_SPRITE_FLIP_X ? -1 : 1);
    const fy = (r[at + 5]! < 0 ? -1 : 1) * (flags & TSE_SPRITE_FLIP_Y ? -1 : 1);
    let x0 = (m[0] * cos + m[2] * sin) * fx,
      x1 = (m[1] * cos + m[3] * sin) * fx;
    const y0 = (m[0] * -sin + m[2] * cos) * fy,
      y1 = (m[1] * -sin + m[3] * cos) * fy;
    const length = Math.hypot(x0, x1);
    if (!(length > 0) || !Number.isFinite(length)) return IDENTITY_TURN;
    x0 /= length;
    x1 /= length;
    // y is x turned a quarter, mirrored when the whole turns the image over.
    const side = x0 * y1 - x1 * y0 < 0 ? -1 : 1;
    const out = this.#turnOut;
    out[0] = x0;
    out[1] = x1;
    out[2] = -x1 * side;
    out[3] = x0 * side;
    return out;
  }

  /**
   * The region of a `TSE_OP_SPRITE_REGION` record, or of a `TSE_OP_SPRITE_SHADED` one (laid out the same up to the tint), from
   * `tex`, batched with the plain program; or, `bound`, with the shader `#beginShader` bound it for.
   */
  #regionRecord(r: Float64Array, at: number, tex: GlTexture, flags: number, bound = false): void {
    const w = r[at + 9]!,
      h = r[at + 10]!;
    if (!(w > 0 && h > 0)) return;
    let ox = r[at + 11]!,
      oy = r[at + 12]!;
    if (flags & TSE_SPRITE_FLIP_X) ox = w - ox;
    if (flags & TSE_SPRITE_FLIP_Y) oy = h - oy;
    const sx = r[at + 7]!,
      sy = r[at + 8]!;
    // A flip swaps the texture coordinates along that axis.
    const fx = (flags & TSE_SPRITE_FLIP_X) !== 0,
      fy = (flags & TSE_SPRITE_FLIP_Y) !== 0;
    if (!bound) this.#useTexture(tex);
    let u0 = sx / tex.width,
      u1 = (sx + w) / tex.width,
      v0 = sy / tex.height,
      v1 = (sy + h) / tex.height;
    if (tex.flipped) {
      v0 = 1 - v0;
      v1 = 1 - v1;
    }
    if (fx) [u0, u1] = [u1, u0];
    if (fy) [v0, v1] = [v1, v0];
    this.#quad(this.#transform(r, at), -ox, -oy, -ox + w, -oy + h, u0, v0, u1, v1, unpack(r[at + 14]!, this.#color));
  }

  /** `TSE_OP_SPRITE_SHADED`: the region through its shader, or plainly when there is none. */
  #shadedSprite(r: Float64Array, at: number): void {
    const tex = this.#assets.texture(toIndex(r[at + 6]!));
    if (tex === null) return;
    let flags = toIndex(r[at + 13]!);
    if (flags < 0) flags = 0;
    flags &= ~TSE_SPRITE_SILHOUETTE;
    const handle = toIndex(r[at + 15]!);
    const shader = handle >= 0 ? this.#assets.shader(handle) : null;
    if (shader === null) {
      this.#regionRecord(r, at, tex, flags);
      return;
    }
    const lookupHandle = toIndex(r[at + 16]!);
    const lookup = lookupHandle >= 0 ? this.#assets.texture(lookupHandle) : null;
    const turn = this.#turn(r, at, flags);
    this.#beginShader(shader, tex, 0, r, at + 17, r[at + 7]!, r[at + 8]!, r[at + 9]!, r[at + 10]!, turn, lookup);
    this.#regionRecord(r, at, tex, flags, true);
    this.#endShader();
  }

  // ---------- A frame ----------

  /**
   * Draw a frame into the window, whose drawing buffer is `width` x `height` pixels with `scale` of them to a unit the records use (the
   * device pixel ratio when sizes are in CSS pixels, 1 when they are in device pixels), and present nothing (the browser presents when
   * the animation frame ends). The canvas and the layers inside it are drawn at one pixel a unit, as libtse draws them.
   */
  frame(
    width: number,
    height: number,
    scale: number,
    clearColor: number,
    records: Float64Array,
    length: number,
    texts: readonly string[]
  ): void {
    const gl = this.gl;
    this.#count = 0;
    this.#program_ = null;
    this.#batchTexture = null;
    this.#blend = -1;
    if (length > 0 && toIndex(records[0]!) === TSE_OP_CANVAS) {
      const cw = toIndex(records[1]!),
        ch = toIndex(records[2]!);
      if (length < TSE_OP_CANVAS_LEN || cw <= 0 || ch <= 0 || cw > MAX_CANVAS || ch > MAX_CANVAS) {
        this.#report("bad canvas record", 0);
        this.#windowClear(width, height, clearColor);
        return;
      }
      if (this.#canvas !== null && (this.#canvas.texture.width !== cw || this.#canvas.texture.height !== ch)) {
        this.#dropTarget(this.#canvas);
        this.#canvas = null;
      }
      this.#canvas ??= this.#makeTarget(cw, ch);
      if (this.#canvas === null) {
        this.#report("could not make the canvas texture", 0);
        this.#windowClear(width, height, clearColor);
        return;
      }
      this.#targetWidth = cw;
      this.#targetHeight = ch;
      this.#scale = 1;
      this.#execute(this.#canvas, clearColor, records, TSE_OP_CANVAS_LEN, length, texts);
      // The canvas, laid over the window opaque (blending off), in the dest rectangle.
      this.#flush();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.SCISSOR_TEST);
      const border = unpack(records[7]!, this.#color);
      gl.clearColor(border[0]!, border[1]!, border[2]!, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.BLEND);
      this.#targetWidth = width;
      this.#targetHeight = height;
      this.#scale = scale;
      this.#program_ = null;
      this.#useTexture(this.#canvas.texture);
      const dx = records[3]!,
        dy = records[4]!,
        dw = records[5]!,
        dh = records[6]!;
      this.#quad(IDENTITY, dx, dy, dx + dw, dy + dh, 0, 1, 1, 0, WHITE);
      this.#flush();
      this.#blend = -1;
      return;
    }
    this.#targetWidth = width;
    this.#targetHeight = height;
    this.#scale = scale;
    this.#execute(null, clearColor, records, 0, length, texts);
  }

  #windowClear(width: number, height: number, color: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    const c = unpack(color, this.#color);
    gl.clearColor(c[0]!, c[1]!, c[2]!, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** The record at `at`'s transform under the view (translate, rotate, scale), in a scratch array the next record reuses. */
  #transform(r: Float64Array, at: number): Affine {
    const cos = Math.cos(r[at + 3]!),
      sin = Math.sin(r[at + 3]!);
    const sx = r[at + 4]!,
      sy = r[at + 5]!;
    const a = cos * sx,
      b = sin * sx,
      c = -sin * sy,
      d = cos * sy,
      e = r[at + 1]!,
      f = r[at + 2]!;
    const m = this.#view,
      out = this.#local;
    out[0] = m[0] * a + m[2] * b;
    out[1] = m[1] * a + m[3] * b;
    out[2] = m[0] * c + m[2] * d;
    out[3] = m[1] * c + m[3] * d;
    out[4] = m[0] * e + m[2] * f + m[4];
    out[5] = m[1] * e + m[3] * f + m[5];
    return out;
  }

  #execute(base: Target | null, clearColor: number, r: Float64Array, start: number, length: number, texts: readonly string[]): void {
    this.#depth = 0;
    this.#childBlend[0] = TSE_BLEND_NORMAL;
    this.#view = IDENTITY;
    this.#scissor = null;
    this.#bindCurrent(base);
    this.#clear(clearColor);
    const c = this.#color;
    let at = start;
    loop: while (at < length) {
      const op = toIndex(r[at]!);
      let need = 0;
      switch (op) {
        case TSE_OP_VIEW:
          need = TSE_OP_VIEW_LEN;
          break;
        case TSE_OP_SPRITE:
          need = TSE_OP_SPRITE_LEN;
          break;
        case TSE_OP_RECT:
          need = TSE_OP_RECT_LEN;
          break;
        case TSE_OP_ELLIPSE:
          need = TSE_OP_ELLIPSE_LEN;
          break;
        case TSE_OP_TEXT:
          need = TSE_OP_TEXT_LEN;
          break;
        case TSE_OP_SPRITE_REGION:
          need = TSE_OP_SPRITE_REGION_LEN;
          break;
        case TSE_OP_BOX:
          need = TSE_OP_BOX_LEN;
          break;
        case TSE_OP_SCISSOR:
          need = TSE_OP_SCISSOR_LEN;
          break;
        case TSE_OP_SCISSOR_END:
          need = TSE_OP_SCISSOR_END_LEN;
          break;
        case TSE_OP_LAYER_BEGIN:
          need = TSE_OP_LAYER_BEGIN_LEN;
          break;
        case TSE_OP_LAYER_END:
          need = TSE_OP_LAYER_END_LEN;
          break;
        case TSE_OP_LIGHT:
          need = TSE_OP_LIGHT_LEN;
          break;
        case TSE_OP_SPRITE_SHADED:
          need = TSE_OP_SPRITE_SHADED_LEN;
          break;
        case TSE_OP_CANVAS:
          this.#report("canvas record that is not first", at);
          break loop;
        default:
          this.#report("unknown op", at);
          break loop;
      }
      if (at + need > length) {
        this.#report("record runs past the end", at);
        break;
      }
      switch (op) {
        case TSE_OP_VIEW:
          this.#view = [r[at + 1]!, r[at + 2]!, r[at + 3]!, r[at + 4]!, r[at + 5]!, r[at + 6]!];
          break;
        case TSE_OP_LAYER_BEGIN:
          if (!this.#beginLayer(base, r[at + 1]!, blendOf(r[at + 2]!))) {
            this.#report(this.#depth >= TSE_LAYER_MAX ? "layers nested too deep" : "could not make the layer texture", at);
            break loop;
          }
          break;
        case TSE_OP_LAYER_END:
          if (this.#depth === 0) {
            this.#report("layer end with no layer open", at);
            break loop;
          }
          this.#endLayer(base, blendOf(r[at + 1]!), r[at + 2]!, toIndex(r[at + 3]!), finite(r[at + 4]!), r, at);
          break;
        case TSE_OP_SCISSOR: {
          const w = r[at + 3]! > 0 && r[at + 3]! <= 1e9 ? r[at + 3]! : 0,
            h = r[at + 4]! > 0 && r[at + 4]! <= 1e9 ? r[at + 4]! : 0;
          const x = r[at + 1]! >= -1e9 && r[at + 1]! <= 1e9 ? r[at + 1]! : 0,
            y = r[at + 2]! >= -1e9 && r[at + 2]! <= 1e9 ? r[at + 2]! : 0;
          this.#flush();
          this.#scissor = [Math.trunc(x), Math.trunc(y), Math.trunc(w), Math.trunc(h)];
          this.#applyScissor();
          break;
        }
        case TSE_OP_SCISSOR_END:
          this.#flush();
          this.#scissor = null;
          this.#applyScissor();
          break;
        case TSE_OP_SPRITE: {
          const tex = this.#assets.texture(toIndex(r[at + 6]!));
          if (tex !== null) this.#region(this.#transform(r, at), tex, 0, 0, tex.width, tex.height, 0, 0, tex.width, tex.height, WHITE);
          break;
        }
        case TSE_OP_SPRITE_REGION: {
          let flags = toIndex(r[at + 13]!);
          if (flags < 0) flags = 0;
          const handle = toIndex(r[at + 6]!);
          const tex = flags & TSE_SPRITE_SILHOUETTE ? this.#assets.silhouette(handle) : this.#assets.texture(handle);
          if (tex !== null) this.#regionRecord(r, at, tex, flags);
          break;
        }
        case TSE_OP_SPRITE_SHADED:
          this.#shadedSprite(r, at);
          break;
        case TSE_OP_RECT:
          this.#rect(this.#transform(r, at), 0, 0, r[at + 6]!, r[at + 7]!, unpack(r[at + 8]!, c));
          break;
        case TSE_OP_BOX:
          this.#box(this.#transform(r, at), r[at + 6]!, r[at + 7]!, r[at + 8]!, r[at + 9]!, r[at + 10]!, r[at + 11]!);
          break;
        case TSE_OP_LIGHT:
          this.#light(this.#transform(r, at), finite(r[at + 6]!), r[at + 7]!);
          break;
        case TSE_OP_ELLIPSE:
          this.#ellipse(this.#transform(r, at), r[at + 6]!, r[at + 7]!, unpack(r[at + 8]!, c));
          break;
        case TSE_OP_TEXT: {
          const index = toIndex(r[at + 6]!);
          const text = index >= 0 && index < texts.length ? texts[index]! : null;
          if (text === null || text === "") break;
          const tex = this.#assets.text(text, r[at + 7]!);
          if (tex !== null)
            this.#region(this.#transform(r, at), tex, 0, 0, tex.width, tex.height, 0, 0, tex.width, tex.height, unpack(r[at + 8]!, c));
          break;
        }
      }
      at += need;
    }
    // A layer still open is closed as if by an END: laid over its target, normal, white.
    while (this.#depth > 0) this.#endLayer(base, TSE_BLEND_NORMAL, 0xffffffff, -1, 0, null, 0);
    this.#flush();
    this.#scissor = null;
    this.gl.disable(this.gl.SCISSOR_TEST);
  }
}

function blendOf(value: number): number {
  const mode = toIndex(value);
  return mode >= TSE_BLEND_NORMAL && mode <= TSE_BLEND_SCREEN ? mode : TSE_BLEND_NORMAL;
}
