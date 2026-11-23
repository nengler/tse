import assert from "node:assert/strict";
/** A sprite's `shader` (ABI v16): its region is written as a shaded sprite record, with the shader, the lookup and the params. */
import { describe, it } from "node:test";

import { AnimatedSprite, Entity, Sprite, type GameObject, type SpriteProps } from "@tsengine/runtime";

import { FrameBuilder } from "../src/draw.ts";
import { KEYS, TSE_IN_LEN } from "../src/protocol.ts";
import { RecordingBackend, type DecodedRecord } from "../src/recording.ts";

function drawWith(
  backend: RecordingBackend,
  root: GameObject,
  frames = 1,
  options: { shaders?: boolean; time?: number } = {}
): { records: DecodedRecord[]; warnings: string[] } {
  const warnings: string[] = [];
  const builder = new FrameBuilder({
    loadTexture: (path) => backend.loadTexture(path),
    ...(options.shaders === false ? {} : { loadShader: (path: string) => backend.loadShader(path) }),
    warn: (message) => warnings.push(message),
    textureSize: (handle) => backend.textureSize(handle) ?? { width: 0, height: 0 },
    measureText: (text, size) => ({ width: text.length * 8, height: size }),
    retain: "check",
  });
  for (let i = 0; i < frames; i++) {
    const built = builder.build(root, 400, 300, options.time);
    backend.frame(0, built.list.records, built.list.length, built.list.texts, new Float64Array(TSE_IN_LEN), new Uint8Array(KEYS.length));
  }
  return { records: backend.lastFrame.records.filter((r) => r.op !== "view"), warnings };
}

function entity(...children: GameObject[]): Entity {
  const e = new Entity();
  for (const child of children) e.addChild(child);
  return e;
}

const sprite = (props: SpriteProps): Sprite => new Sprite(props);

describe("a sprite's shader", () => {
  it("writes a shaded sprite record: the region, then the shader and the lookup under assets, and its params padded to eight", () => {
    const backend = new RecordingBackend({ textureSizes: { "assets/apple.png": { width: 32, height: 32 } } });
    const apple = sprite({ image: "apple.png", originX: 16, originY: 16, shader: "fruit.glsl", lookup: "ramps.png", params: [0.5, 2] });
    apple.transform.x = 100;
    apple.transform.rotation = Math.PI / 2;
    const { records, warnings } = drawWith(backend, entity(apple), 2, { time: 4 });
    assert.deepEqual(records, [
      {
        op: "spriteShaded",
        x: 100,
        y: 0,
        rotation: Math.PI / 2,
        scaleX: 1,
        scaleY: 1,
        texture: "assets/apple.png",
        srcX: 0,
        srcY: 0,
        srcW: 32,
        srcH: 32,
        originX: 16,
        originY: 16,
        flipX: false,
        flipY: false,
        tint: "#ffffffff",
        shader: "assets/fruit.glsl",
        lookup: "assets/ramps.png",
        params: [0.5, 2, 0, 0, 0, 0, 0, 0],
      },
    ]);
    assert.deepEqual(backend.shaderLoads, ["assets/fruit.glsl"], "loaded once, for two frames");
    assert.deepEqual(warnings, []);
  });

  it("has no lookup without one, and takes the flips, the tint and a sheet's frame as a region does", () => {
    const backend = new RecordingBackend({ textureSizes: { "assets/sheet.png": { width: 32, height: 16 } } });
    const s = sprite({ image: "sheet.png", frameWidth: 16, frameHeight: 16, frame: 1, flipX: true, tint: "#ff000080", shader: "s.glsl" });
    const [record] = drawWith(backend, entity(s)).records;
    assert.equal(record?.op, "spriteShaded");
    const shaded = record as Extract<DecodedRecord, { op: "spriteShaded" }>;
    assert.equal(shaded.lookup, null);
    assert.equal(shaded.srcX, 16);
    assert.equal(shaded.flipX, true);
    assert.equal(shaded.tint, "#ff000080");
    assert.deepEqual(shaded.params, [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("keeps its flash: a silhouette region over the shaded one", () => {
    const backend = new RecordingBackend({});
    const records = drawWith(backend, entity(sprite({ image: "a.png", shader: "s.glsl", flash: 0.5 }))).records;
    assert.deepEqual(
      records.map((r) => (r.op === "spriteRegion" && r.silhouette ? "silhouette" : r.op)),
      ["spriteShaded", "silhouette"]
    );
  });

  it("is a plain region record when the shader could not be loaded, or where none can run, saying so once", () => {
    const missing = drawWith(
      new RecordingBackend({ missingShaders: ["assets/gone.glsl"] }),
      entity(sprite({ image: "a.png", shader: "gone.glsl", lookup: "l.png" })),
      2
    );
    assert.deepEqual(
      missing.records.map((r) => r.op),
      ["spriteRegion"]
    );
    assert.equal(missing.warnings.length, 1);
    assert.match(missing.warnings[0]!, /'assets\/gone\.glsl' could not be loaded/);
    const none = drawWith(new RecordingBackend({}), entity(sprite({ image: "a.png", shader: "s.glsl" })), 2, { shaders: false });
    assert.deepEqual(
      none.records.map((r) => r.op),
      ["spriteRegion"]
    );
    assert.match(none.warnings.join("\n"), /runs no shaders/);
  });

  it("is rewritten when its params change, and copied while nothing changes", () => {
    const backend = new RecordingBackend({});
    const s = sprite({ image: "a.png", shader: "s.glsl", params: [1] });
    const root = entity(s);
    const warnings: string[] = [];
    const builder = new FrameBuilder({
      loadTexture: (path) => backend.loadTexture(path),
      loadShader: (path) => backend.loadShader(path),
      warn: (message) => warnings.push(message),
      textureSize: (handle) => backend.textureSize(handle) ?? { width: 0, height: 0 },
      measureText: (text, size) => ({ width: text.length * 8, height: size }),
      retain: "check",
    });
    const params = (): number[] => {
      const built = builder.build(root, 400, 300, 0);
      backend.frame(0, built.list.records, built.list.length, built.list.texts, new Float64Array(TSE_IN_LEN), new Uint8Array(KEYS.length));
      return [...(backend.lastFrame.records.find((r) => r.op === "spriteShaded") as Extract<DecodedRecord, { op: "spriteShaded" }>).params];
    };
    assert.equal(params()[0], 1);
    assert.equal(params()[0], 1);
    s.params = [3];
    s.markChanged();
    assert.equal(params()[0], 3);
    assert.deepEqual(warnings, []);
  });

  it("works on an animated sprite too", () => {
    const backend = new RecordingBackend({});
    const a = new AnimatedSprite({ frames: ["a.png", "b.png"], shader: "s.glsl", params: [7] });
    const [record] = drawWith(backend, entity(a)).records;
    assert.equal(record?.op, "spriteShaded");
    assert.equal((record as Extract<DecodedRecord, { op: "spriteShaded" }>).params[0], 7);
  });
});
