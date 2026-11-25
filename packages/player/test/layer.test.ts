import assert from "node:assert/strict";
/** `<Layer>` (ABI v10): its children are drawn between a layer-begin and a layer-end record, at its own z, its opacity on the end. */
import { describe, it } from "node:test";

import { Entity, Hud, Layer, Light, Lighting, Shape, type GameObject, type LayerProps } from "@tsengine/runtime";

import { FrameBuilder } from "../src/draw.ts";
import { KEYS, TSE_IN_LEN } from "../src/protocol.ts";
import { RecordingBackend, type DecodedRecord } from "../src/recording.ts";

function draw(root: GameObject, frames = 1): DecodedRecord[] {
  return drawWith(new RecordingBackend({}), root, frames).records;
}

function drawWith(
  backend: RecordingBackend,
  root: GameObject,
  frames = 1,
  options: { time?: number; shaders?: boolean } = {}
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
  return { records: [...backend.lastFrame.records], warnings };
}

const shape = (color: string, z = 0): Shape => {
  const s = new Shape({ kind: "rect", width: 10, height: 10, color });
  s.transform.z = z;
  return s;
};
function layer(props: LayerProps, ...children: GameObject[]): Layer {
  const l = new Layer(props);
  for (const child of children) l.addChild(child);
  return l;
}
function entity(...children: GameObject[]): Entity {
  const e = new Entity();
  for (const child of children) e.addChild(child);
  return e;
}
/** Each record as a short word: a layer's begin and end, or a rect's colour. */
const ops = (records: readonly DecodedRecord[]): string[] =>
  records.flatMap((r) =>
    r.op === "layerBegin"
      ? [`begin ${r.clear} ${r.childBlend}`]
      : r.op === "layerEnd"
        ? [`end ${r.blend} ${r.tint}`]
        : r.op === "rect"
          ? [r.color]
          : []
  );

describe("<Layer>", () => {
  it("wraps its children in a begin and an end, with its clear colour and its blend modes", () => {
    const root = entity(shape("red"), layer({ blend: "multiply", clear: "#202038", childBlend: "add" }, shape("white"), shape("yellow")));
    assert.deepEqual(ops(draw(root)), ["#ff0000ff", "begin #202038ff add", "#ffffffff", "#ffff00ff", "end multiply #ffffffff"]);
  });

  it("defaults to normal blending, a transparent clear and full opacity, and draws nothing when empty", () => {
    assert.deepEqual(ops(draw(entity(layer({}, shape("red"))))), ["begin #00000000 normal", "#ff0000ff", "end normal #ffffffff"]);
    assert.deepEqual(ops(draw(entity(layer({ blend: "add" }), shape("red")))), ["#ff0000ff"]);
  });

  it("puts its opacity, and any opacity above it, on the end record, and draws its children at full opacity", () => {
    const inner = layer({ opacity: 0.5 }, shape("red"));
    const outer = entity(inner);
    outer.transform.opacity = 0.5;
    assert.deepEqual(ops(draw(outer)), ["begin #00000000 normal", "#ff0000ff", "end normal #ffffff40"]);
  });

  it("keeps its records together at its own z, and puts its children in z order among themselves", () => {
    const root = entity(shape("blue", 2), layer({ blend: "add" }, shape("red", 5), shape("white", -3)), shape("green", 1));
    // The layer is at z 0: before green (1) and blue (2), though red inside it asked for 5. Inside, white (-3) goes under red (5).
    assert.deepEqual(ops(draw(root)), ["begin #00000000 normal", "#ffffffff", "#ff0000ff", "end add #ffffffff", "#008000ff", "#0000ffff"]);
  });

  it("orders by z inside a layer that holds the whole game, as it would be without the layer", () => {
    const game = (): GameObject[] => [shape("red", 3), entity(shape("white", 1), shape("yellow")), shape("green", -1), shape("blue")];
    const plain = ops(draw(entity(...game())));
    assert.deepEqual(plain, ["#008000ff", "#ffff00ff", "#0000ffff", "#ffffffff", "#ff0000ff"]);
    assert.deepEqual(ops(draw(entity(layer({ shader: "screen.glsl" }, ...game())))), [
      "begin #00000000 normal",
      ...plain,
      "end normal #ffffffff",
    ]);
  });

  it("orders each layer by z within the layer it is in, a nested layer moving as one at its own z", () => {
    const inner = layer({ blend: "add" }, shape("red", 2), shape("white", -2));
    inner.transform.z = 1;
    const root = entity(layer({}, shape("blue", 4), inner, shape("green")));
    // The outer layer: green (0), then the inner layer (1, white under red, both kept inside it), then blue (4).
    assert.deepEqual(ops(draw(root)), [
      "begin #00000000 normal",
      "#008000ff",
      "begin #00000000 normal",
      "#ffffffff",
      "#ff0000ff",
      "end add #ffffffff",
      "#0000ffff",
      "end normal #ffffffff",
    ]);
  });

  it("goes back to its own z after its children, so a later sibling is ordered against the layer, not against its last child", () => {
    const l = layer({ blend: "add" }, shape("red", 5));
    l.transform.z = 2;
    // yellow (3) after the layer (2), though the layer's child asked for 5; white (1) before it.
    assert.deepEqual(ops(draw(entity(l, shape("yellow", 3), shape("white", 1)))), [
      "#ffffffff",
      "begin #00000000 normal",
      "#ff0000ff",
      "end add #ffffffff",
      "#ffff00ff",
    ]);
  });

  it("orders by z inside a layer in a HUD", () => {
    const hud = new Hud();
    hud.addChild(layer({}, shape("red", 2), shape("white")));
    assert.deepEqual(ops(draw(entity(hud))), ["begin #00000000 normal", "#ffffffff", "#ff0000ff", "end normal #ffffffff"]);
  });

  it("nests", () => {
    const root = entity(layer({ blend: "multiply" }, layer({ blend: "add" }, shape("red"))));
    assert.deepEqual(ops(draw(root)), [
      "begin #00000000 normal",
      "begin #00000000 normal",
      "#ff0000ff",
      "end add #ffffffff",
      "end multiply #ffffffff",
    ]);
  });

  it("works in a HUD", () => {
    const hud = new Hud();
    hud.addChild(layer({ blend: "screen", clear: "black" }, shape("red")));
    const records = draw(entity(hud));
    assert.deepEqual(ops(records), ["begin #000000ff normal", "#ff0000ff", "end screen #ffffffff"]);
  });

  it("is drawn again each frame, a change of its props included, as the retained frame check expects", () => {
    const l = layer({ blend: "add" }, shape("red"));
    const root = entity(l);
    assert.deepEqual(ops(draw(root, 3)), ["begin #00000000 normal", "#ff0000ff", "end add #ffffffff"]);
    l.blend = "multiply";
    l.markChanged();
    assert.deepEqual(ops(draw(root)), ["begin #00000000 normal", "#ff0000ff", "end multiply #ffffffff"]);
  });

  it("runs its shader as it is laid over: the path under assets, the game's time and its params, padded to eight", () => {
    const backend = new RecordingBackend({});
    const root = entity(layer({ blend: "multiply", shader: "cave.glsl", params: [0.25, 2] }, shape("red")));
    const { records, warnings } = drawWith(backend, root, 2, { time: 3.5 });
    const end = records.find((r) => r.op === "layerEnd");
    assert.deepEqual(end, {
      op: "layerEnd",
      blend: "multiply",
      tint: "#ffffffff",
      shader: "assets/cave.glsl",
      time: 3.5,
      params: [0.25, 2, 0, 0, 0, 0, 0, 0],
    });
    assert.deepEqual(backend.shaderLoads, ["assets/cave.glsl"], "loaded once, for two frames");
    assert.deepEqual(warnings, []);
  });

  it("draws the layer without a shader that could not be loaded, or where none can run, saying so once", () => {
    const missing = drawWith(
      new RecordingBackend({ missingShaders: ["assets/gone.glsl"] }),
      entity(layer({ shader: "gone.glsl" }, shape("red"))),
      2
    );
    assert.equal((missing.records.find((r) => r.op === "layerEnd") as { shader: string | null }).shader, null);
    assert.equal(missing.warnings.length, 1);
    assert.match(missing.warnings[0]!, /'assets\/gone\.glsl' could not be loaded/);
    const none = drawWith(new RecordingBackend({}), entity(layer({ shader: "x.glsl" }, shape("red"))), 2, { shaders: false });
    assert.equal((none.records.find((r) => r.op === "layerEnd") as { shader: string | null }).shader, null);
    assert.match(none.warnings.join("\n"), /runs no shaders/);
  });
});

describe("<Light> and <Lighting>", () => {
  it("is a light map: a multiply layer cleared to the ambient colour, its lights added, each its colour at its intensity", () => {
    const lantern = new Light({ radius: 48, color: "#ffcc88", intensity: 0.5 });
    lantern.transform.x = 100;
    lantern.transform.y = 60;
    const lighting = new Lighting({ ambient: "#16162c" });
    lighting.addChild(lantern);
    lighting.addChild(new Light({ radius: 16 }));
    const records = draw(entity(shape("red"), lighting));
    const begin = records.find((r) => r.op === "layerBegin");
    assert.deepEqual(begin, { op: "layerBegin", clear: "#16162cff", childBlend: "add" });
    const lights = records.filter((r) => r.op === "light");
    assert.deepEqual(
      lights.map((l) => (l.op === "light" ? [l.x, l.y, l.radius, l.color] : [])),
      [
        [100, 60, 48, "#ffcc8880"],
        [0, 0, 16, "#fff3dcff"],
      ]
    );
    assert.equal((records.find((r) => r.op === "layerEnd") as { blend: string }).blend, "multiply");
  });

  it("draws nothing for a light with no radius or no intensity, and fades one under an opacity", () => {
    const faded = new Light({ radius: 10, color: "white" });
    faded.transform.opacity = 0.5;
    const records = draw(entity(new Light({ radius: 0 }), new Light({ radius: 10, intensity: 0 }), faded));
    assert.deepEqual(
      records.filter((r) => r.op === "light").map((l) => (l.op === "light" ? l.color : "")),
      ["#ffffff80"]
    );
  });

  it("follows a change of its ambient colour", () => {
    const lighting = new Lighting({ ambient: "black" });
    lighting.addChild(new Light({ radius: 10 }));
    const root = entity(lighting);
    draw(root);
    lighting.ambient = "#202020";
    lighting.markChanged();
    assert.deepEqual(
      draw(root).find((r) => r.op === "layerBegin"),
      { op: "layerBegin", clear: "#202020ff", childBlend: "add" }
    );
  });
});
