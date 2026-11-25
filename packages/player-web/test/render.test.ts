import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

// The renderer in a real browser: a page draws hand-made draw records into a WebGL2 canvas and reads its pixels back. It needs
// Playwright's Chromium, which CI does not install: without it the test is skipped.
type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = { setContent(html: string): Promise<void>; evaluate<T>(fn: string): Promise<T>; on(e: string, f: (x: unknown) => void): void };
let chromium: { launch(o: object): Promise<Browser> } | null = null;
try {
  chromium = (createRequire(import.meta.url)("playwright") as { chromium: typeof chromium }).chromium;
} catch {
  chromium = null;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The page's script: draws each case into the window and returns the pixels asked for, RGBA, from the top left. */
const PAGE = `
import { TSE_OP_RECT, TSE_OP_BOX, TSE_OP_SPRITE_REGION, TSE_OP_LAYER_BEGIN, TSE_OP_LAYER_END, TSE_OP_SCISSOR, TSE_OP_SCISSOR_END,
  TSE_OP_CANVAS, TSE_OP_VIEW, TSE_OP_SPRITE_SHADED, TSE_BLEND_MULTIPLY, TSE_BLEND_NORMAL, TSE_SHADER_PARAMS } from "@tsengine/player";
import { WebRenderer } from "./src/renderer.ts";

const canvas = document.createElement("canvas");
canvas.width = 64; canvas.height = 64;
document.body.append(canvas);
const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
const textures = [];
const shaders = [];
const renderer = new WebRenderer(gl, {
  texture: (h) => textures[h] ?? null, silhouette: () => null, shader: (h) => shaders[h] ?? null, text: () => null,
}, false);
// A 2 x 1 texture: red, then green.
textures.push(renderer.makeTexture(2, 1, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), false));

const T = [0, 0, 0, 1, 1]; // x, y, rotation, scaleX, scaleY after the op: at the origin, unturned, unscaled
const at = (x, y) => [x, y, 0, 1, 1];
function draw(records, scale = 1) {
  const r = new Float64Array(records);
  renderer.frame(64, 64, scale, 0x000000ff, r, r.length, []);
}
function pixel(x, y) {
  const p = new Uint8Array(4);
  gl.readPixels(x, 63 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
  return [...p];
}
const out = {};

draw([TSE_OP_RECT, ...at(4, 4), 8, 8, 0xff0000ff]);
out.rectIn = pixel(6, 6); out.rectOut = pixel(20, 20);

// A box: blue fill, a white border 2 wide.
draw([TSE_OP_BOX, ...at(10, 10), 20, 20, 0x0000ffff, 0xffffffff, 2, 0]);
out.boxBorder = pixel(10, 15); out.boxFill = pixel(20, 20);

// A region of the texture flipped in x, which mirrors it about its origin: with the origin at its right edge (2, 0) it lands at
// (0, 0) to (2, 1), its first pixel the texture's last.
draw([TSE_OP_SPRITE_REGION, ...at(0, 0), 0, 0, 0, 2, 1, 2, 0, 1, 0xffffffff]);
out.regionFlipped = pixel(0, 0);

// A grey multiply layer over a white rectangle halves it.
draw([TSE_OP_RECT, ...T, 64, 64, 0xffffffff, TSE_OP_LAYER_BEGIN, 0x808080ff, TSE_BLEND_NORMAL,
  TSE_OP_LAYER_END, TSE_BLEND_MULTIPLY, 0xffffffff, -1, -1, 0, ...new Array(TSE_SHADER_PARAMS).fill(0)]);
out.multiplied = pixel(32, 32);

// A scissor clips what follows to its rectangle.
draw([TSE_OP_SCISSOR, 0, 0, 10, 10, TSE_OP_RECT, ...T, 64, 64, 0x00ff00ff, TSE_OP_SCISSOR_END]);
out.scissorIn = pixel(5, 5); out.scissorOut = pixel(20, 20);

// A 16 x 16 canvas drawn into the window at 32 x 32, its border colour around it.
draw([TSE_OP_CANVAS, 16, 16, 0, 0, 32, 32, 0x0000ffff, TSE_OP_RECT, ...T, 8, 8, 0xff0000ff]);
out.canvasScaled = pixel(14, 14); out.canvasBorder = pixel(40, 40);

// At a scale of 2 (CSS pixels on a 2x screen), a rectangle at (4, 4) is at (8, 8) in the drawing buffer, and a view applies on top.
draw([TSE_OP_VIEW, 1, 0, 0, 1, 2, 0, TSE_OP_RECT, ...at(2, 4), 4, 4, 0xff0000ff], 2);
out.scaledIn = pixel(9, 9); out.scaledOut = pixel(5, 5);

// A shaded sprite (ABI v16), as native/test/smoke.c draws one: white where the image's x runs left on the target; else its left
// half the lookup texture's colour, its right half params[0] green times its time (10) / 10.
shaders.push(renderer.compileLayerShader([
  "vec4 effect(vec2 uv) {",
  "  vec2 at = uv * vec2(textureSize(image, 0)) - region.xy;",
  "  if ((transpose(turn) * vec2(1.0, 0.0)).x < 0.0) return vec4(1.0);",
  "  if (at.x < region.z / 2.0) return texture(lookup, vec2(0.5));",
  "  return vec4(0.0, params[0] * time / 10.0, 0.0, 1.0);",
  "}",
].join("\\n")));
textures.push(renderer.makeTexture(16, 16, new Uint8Array(16 * 16 * 4).fill(255), false)); // 1: a white square
textures.push(renderer.makeTexture(1, 1, new Uint8Array([255, 0, 0, 255]), false)); // 2: the lookup, red
const shaded = (x, y, rot, flags, shader, lookup) => [TSE_OP_SPRITE_SHADED, x, y, rot, 1, 1, 1, 0, 0, 16, 16, 8, 8, flags, 0xffffffff,
  shader, lookup, 10, 1, ...new Array(TSE_SHADER_PARAMS - 1).fill(0)];
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...shaded(24, 24, 0, 0, 0, 2)]);
out.shadedLookup = pixel(20, 24); out.shadedParam = pixel(28, 24); out.shadedOut = pixel(4, 4);
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...shaded(24, 24, 0, 0, 0, -1)]);
out.shadedNoLookup = pixel(20, 24);
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...shaded(24, 24, Math.PI, 0, 0, 2)]);
out.shadedTurned = pixel(24, 24);
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...shaded(24, 24, 0, 1, 0, 2)]);
out.shadedFlipped = pixel(24, 24);
draw([TSE_OP_VIEW, -1, 0, 0, 1, 64, 0, ...shaded(40, 24, Math.PI, 0, 0, 2)]);
out.shadedMirroredView = pixel(20, 24);
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...shaded(24, 24, 0, 0, 7, 2)]);
out.shadedNoShader = pixel(24, 24);
// After a shaded sprite, a plain region is drawn with the plain program again.
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...shaded(24, 24, 0, 0, 0, 2), TSE_OP_SPRITE_REGION, ...at(0, 0), 0, 0, 0, 2, 1, 0, 0, 0, 0xffffffff]);
out.afterShaded = pixel(0, 0);

// A layer's lookup, place and uvOf, and a parameter past the eighth (ABI v17), as native/test/smoke.c draws them: the lookup's
// colour where place.x < 4; where 12 <= place.y < 18, what is 12 units up (params[29], params[30]), found with uvOf; else the layer.
shaders.push(renderer.compileLayerShader([
  "vec4 effect(vec2 uv) {",
  "  if (place.x < 4.0) return texture(lookup, vec2(0.5));",
  "  if (params[20] == 1.0 && place.y >= 12.0 && place.y < 18.0) return texture(image, uvOf(place - param2(29)));",
  "  return texture(image, uv);",
  "}",
].join("\\n")));
const placed = (w, h) => [TSE_OP_LAYER_BEGIN, 0x00ff00ff, TSE_BLEND_NORMAL, TSE_OP_RECT, ...T, w, h, 0x0000ffff,
  TSE_OP_LAYER_END, TSE_BLEND_NORMAL, 0xffffffff, 1, 2, 0, ...Array.from({ length: TSE_SHADER_PARAMS }, (_, i) => (i === 20 ? 1 : i === 30 ? 12 : 0))];
// The game doubled by the view: place is in its units.
draw([TSE_OP_VIEW, 2, 0, 0, 2, 0, 0, ...placed(32, 12)]);
out.placeLookup = pixel(4, 4); out.placeLayer = pixel(20, 4); out.placeShifted = pixel(20, 30); out.placeBelow = pixel(20, 44);
// On a 2x screen with no view: pixel and place are in units, half the drawing buffer's pixels.
draw([TSE_OP_VIEW, 1, 0, 0, 1, 0, 0, ...placed(32, 6)], 2);
out.dpiLookup = pixel(4, 60); out.dpiLayer = pixel(20, 4); out.dpiShifted = pixel(20, 30); out.dpiBelow = pixel(20, 44);

window.result = out;
`;

test(
  "the WebGL2 renderer draws rects, boxes, flipped regions, layers, scissors, a canvas, a scale and shaded sprites as libtse does",
  { skip: chromium === null ? "Playwright's Chromium is not installed" : false, timeout: 60_000 },
  async () => {
    const bundle = await build({
      stdin: { contents: PAGE, resolveDir: dirname(here), loader: "ts" },
      bundle: true,
      format: "iife",
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    const script = bundle.outputFiles[0]!.text;
    const browser = await chromium!.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    try {
      const page = await browser.newPage();
      const errors: unknown[] = [];
      page.on("pageerror", (e) => errors.push(e));
      await page.setContent(`<!doctype html><body><script>${script.replace(/<\/script>/g, "<\\/script>")}</script></body>`);
      const r = await page.evaluate<Record<string, number[]>>("window.result");
      assert.deepEqual(errors, []);
      assert.deepEqual(r.rectIn, [255, 0, 0, 255]);
      assert.deepEqual(r.rectOut, [0, 0, 0, 255]);
      assert.deepEqual(r.boxBorder, [255, 255, 255, 255]);
      assert.deepEqual(r.boxFill, [0, 0, 255, 255]);
      assert.deepEqual(r.regionFlipped, [0, 255, 0, 255], "flipped in x: green first");
      for (const c of r.multiplied!.slice(0, 3)) assert.ok(Math.abs(c - 128) <= 1, `multiplied ${r.multiplied}`);
      assert.deepEqual(r.scissorIn, [0, 255, 0, 255]);
      assert.deepEqual(r.scissorOut, [0, 0, 0, 255]);
      assert.deepEqual(r.canvasScaled, [255, 0, 0, 255], "the canvas's 8 x 8 rectangle covers 16 x 16 of the window");
      assert.deepEqual(r.canvasBorder, [0, 0, 255, 255]);
      assert.deepEqual(r.scaledIn, [255, 0, 0, 255], "(2 + 2, 4) at scale 2 starts at (8, 8)");
      assert.deepEqual(r.scaledOut, [0, 0, 0, 255]);
      assert.deepEqual(r.shadedLookup, [255, 0, 0, 255], "a shaded sprite's left half samples the lookup texture");
      assert.deepEqual(r.shadedParam, [0, 255, 0, 255], "...its right half is params[0] green");
      assert.deepEqual(r.shadedOut, [0, 0, 0, 255], "...and nothing is drawn outside its region");
      assert.deepEqual(r.shadedNoLookup, [255, 255, 255, 255], "with no lookup texture the lookup is a white pixel");
      assert.deepEqual(r.shadedTurned, [255, 255, 255, 255], "turned half round, the image's x runs left: turn says so");
      assert.deepEqual(r.shadedFlipped, [255, 255, 255, 255], "mirrored, the image's x runs left too");
      assert.deepEqual(r.shadedMirroredView, [255, 0, 0, 255], "a mirroring view undoes the half turn");
      assert.deepEqual(r.shadedNoShader, [255, 255, 255, 255], "an unknown shader handle draws the region plainly");
      assert.deepEqual(r.afterShaded, [255, 0, 0, 255], "a plain region after a shaded sprite is drawn plainly");
      assert.deepEqual(r.placeLookup, [255, 0, 0, 255], "a layer's shader reads its lookup where place, in the view's units, is left of 4");
      assert.deepEqual(r.placeLayer, [0, 0, 255, 255], "...and the layer elsewhere");
      assert.deepEqual(r.placeShifted, [0, 0, 255, 255], "uvOf finds what is 12 units up, the right way up, past the eighth parameter");
      assert.deepEqual(r.placeBelow, [0, 255, 0, 255], "...and below that the layer is as it was");
      assert.deepEqual(r.dpiLookup, [255, 0, 0, 255], "on a 2x screen, place is in units: x < 4 is the first 8 pixels");
      assert.deepEqual(r.dpiLayer, [0, 0, 255, 255]);
      assert.deepEqual(r.dpiShifted, [0, 0, 255, 255], "...and pixel and uvOf agree with it");
      assert.deepEqual(r.dpiBelow, [0, 255, 0, 255]);
    } finally {
      await browser.close();
    }
  }
);
