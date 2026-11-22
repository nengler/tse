import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { Camera, Entity, Flex, Hud, Shape, getSoundSink, type FlexProps, type GameObject } from "@tsengine/runtime";

import { FrameBuilder } from "../src/draw.ts";
import { Layouter, type MeasuredSize } from "../src/layout.ts";
import { createPlayer } from "../src/loop.ts";
import { KEYS, TSE_IN_LEN } from "../src/protocol.ts";
import { RecordingBackend, type DecodedRecord } from "../src/recording.ts";

const host = {
  measure(object: GameObject, out: MeasuredSize): boolean {
    if (object instanceof Shape) {
      out.width = object.width;
      out.height = object.height;
      if (object instanceof Squishy) out.minHeight = object.smallest;
      return true;
    }
    return false;
  },
  warn(): void {},
};

/** A shape that can be laid out smaller than it is, as a wrapping text can. */
class Squishy extends Shape {
  smallest: number;
  constructor(width: number, height: number, smallest: number) {
    super({ kind: "rect", width, height });
    this.smallest = smallest;
  }
}

const row = (width: number, height: number, z = 0): Shape => {
  const shape = new Shape({ kind: "rect", width, height });
  shape.transform.z = z;
  return shape;
};

function flex(props: FlexProps, ...children: GameObject[]): Flex {
  const f = new Flex(props);
  for (const child of children) f.addChild(child);
  return f;
}

const lay = (root: Flex, width = 1000, height = 1000): Flex => {
  new Layouter(host).layout(root, width, height);
  return root;
};

function draw(root: GameObject, width = 200, height = 100, check = false): DecodedRecord[] {
  const backend = new RecordingBackend();
  const builder = new FrameBuilder({ loadTexture: (path) => backend.loadTexture(path), ...(check ? { retain: "check" as const } : {}) });
  const built = builder.build(root, width, height);
  backend.frame(0, built.list.records, built.list.length, built.list.texts, new Float64Array(TSE_IN_LEN), new Uint8Array(KEYS.length));
  return [...backend.lastFrame.records];
}

const names = (records: readonly DecodedRecord[]): string[] =>
  records.map((r) =>
    r.op === "rect"
      ? `rect${r.width}x${r.height}@${r.x},${r.y}`
      : r.op === "scissor"
        ? `scissor(${r.x},${r.y},${r.width},${r.height})`
        : r.op
  );

describe("overflow: layout", () => {
  const list = (props: FlexProps, count = 5) =>
    flex({ direction: "column", width: 40, height: 20, ...props }, ...Array.from({ length: count }, () => row(30, 10)));

  it("does not shrink the children of a scroll box, so there is something to scroll, and shrinks those of a hidden one as before", () => {
    const squishy = (): Squishy => new Squishy(10, 10, 4);
    const column = (overflow: FlexProps["overflow"]): Flex =>
      lay(flex({ direction: "column", height: 20, overflow }, flex({}, squishy()), flex({}, squishy()), flex({}, squishy())));
    const sizes = (f: Flex): number[] => (f.children as Flex[]).map((k) => k.box.size[1] as number);
    for (const size of sizes(column("hidden"))) assert.ok(Math.abs(size - 20 / 3) < 1e-9, `a hidden box squeezes them into it (${size})`);
    assert.deepEqual(sizes(column("scroll")), [10, 10, 10], "a scroll box lets them keep their size");
    assert.equal(column("scroll").box.scrollMax[1], 10, "and has the 10 that stick out to scroll");
  });

  it("works out how far the content can scroll: its end less the box, 0 when it fits, and 0 for a box that does not scroll", () => {
    const f = lay(list({ overflow: "scroll" }));
    assert.deepEqual([...f.box.contentEnd], [30, 50]);
    assert.deepEqual([...f.box.scrollMax], [0, 30]);
    assert.deepEqual([...lay(list({ overflow: "hidden" })).box.scrollMax], [0, 0]);
    assert.deepEqual([...lay(list({ overflow: "scroll" }, 1)).box.scrollMax], [0, 0], "10 tall in a box of 20");
  });

  it("counts padding after the content, and a gap between children", () => {
    const f = lay(list({ overflow: "scroll", padding: 3, gap: 2 }));
    assert.equal(f.box.contentEnd[1], 3 + 5 * 10 + 4 * 2 + 3);
    assert.equal(f.box.scrollMax[1], 64 - 20);
  });

  it("moves the children by the scroll offset, clamps it to the content, and writes the clamped value back", () => {
    const f = list({ overflow: "scroll", scrollY: 12 });
    lay(f);
    assert.deepEqual(
      (f.children as Shape[]).map((k) => k.layoutY),
      [-12, -2, 8, 18, 28]
    );
    f.scrollY = 9999;
    lay(f);
    assert.equal(f.scrollY, 30, "clamped to the end");
    f.scrollY = -5;
    lay(f);
    assert.equal(f.scrollY, 0, "and to the start");
    f.scrollY = Number.NaN;
    lay(f);
    assert.equal(f.scrollY, 0, "a number that is not one is the start");
  });

  it("scrolls along x for a row, and does not scroll a floating child", () => {
    const f = flex(
      { width: 25, height: 10, overflow: "scroll", scrollX: 10 },
      row(20, 10),
      row(20, 10),
      flex({ float: true, anchor: "top-left", to: "top-left", width: 5, height: 5 })
    );
    lay(f);
    assert.equal(f.box.scrollMax[0], 15);
    const [a, b, floating] = f.children as GameObject[];
    assert.deepEqual([a?.layoutX, b?.layoutX], [-10, 10]);
    assert.equal(floating?.layoutX, 0, "it hangs off the box, so it stays");
  });

  it("lets a parent shrink a scroll box that fits its children, which the content cannot be forced into", () => {
    const outer = lay(flex({ direction: "column", height: 30 }, list({ overflow: "scroll", height: "grow" }), row(10, 20)));
    const inner = outer.children[0] as Flex;
    assert.equal(inner.box.size[1], 10, "the 20 high box beside it leaves 10, and the scroll box takes that");
    assert.equal(inner.box.scrollMax[1], 40);
  });
});

describe("overflow: clip records", () => {
  it("clips what is under a hidden box to its pixels, between a scissor and its end, and not the box's own background", () => {
    const box = flex({ width: 40, height: 20, overflow: "hidden", background: "red" }, row(100, 100));
    box.transform.x = 10;
    box.transform.y = 5;
    const records = names(draw(box));
    assert.deepEqual(records, ["view", "rect40x20@10,5", "scissor(10,5,40,20)", "rect100x100@10,5", "scissorEnd"]);
  });

  it("clips to the inside of the border, so what is clipped never paints over it, and counts a border only when one can show", () => {
    const bordered = flex({ width: 40, height: 20, overflow: "hidden", borderWidth: 3, borderColor: "white" }, row(100, 100));
    assert.ok(names(draw(bordered)).includes("scissor(3,3,34,14)"), "in 3 pixels from every edge: inside the border");
    const hoverOnly = flex({ width: 40, height: 20, overflow: "hidden", borderWidth: 3, hoverBorderColor: "white" }, row(100, 100));
    assert.ok(
      names(draw(hoverOnly)).includes("scissor(3,3,34,14)"),
      "the room is kept while no border shows, so the clip does not move when one does"
    );
    const none = flex({ width: 40, height: 20, overflow: "hidden", borderWidth: 3 }, row(100, 100));
    assert.ok(names(draw(none)).includes("scissor(0,0,40,20)"), "no colour in any state: no border, no room");
  });

  it("draws a box that does not clip with no clip records, as it always did", () => {
    assert.deepEqual(names(draw(flex({ width: 40, height: 20, overflow: "visible" }, row(100, 100)))), ["view", "rect100x100@0,0"]);
  });

  it("is in the pixels the view maps to: a zoomed camera scales the clip with the box", () => {
    const root = new Entity();
    const camera = new Camera({ zoom: 2 });
    const box = flex({ width: 40, height: 20, overflow: "hidden" }, row(100, 100));
    camera.addChild(box);
    root.addChild(camera);
    const clip = draw(root).find((r) => r.op === "scissor");
    assert.ok(clip?.op === "scissor");
    assert.deepEqual([clip.width, clip.height], [80, 40]);
  });

  it("cuts a box inside another down to where the two overlap, and goes back to the outer one after it", () => {
    const inner = flex({ width: 30, height: 30, overflow: "hidden" }, row(100, 100));
    inner.transform.x = 20;
    inner.transform.y = 20;
    const outer = flex({ direction: "column", width: 40, height: 40, overflow: "hidden" }, row(50, 2), inner, row(7, 7));
    // The column puts the inner box at y 2 (its own transform then moves it to 20, 22) and the last row below it at y 32.
    assert.deepEqual(names(draw(outer)), [
      "view",
      "scissor(0,0,40,40)",
      "rect50x2@0,0",
      "scissor(20,22,20,18)",
      "rect100x100@20,22",
      "scissor(0,0,40,40)",
      "rect7x7@0,32",
      "scissorEnd",
    ]);
  });

  it("keeps a clipped child's records inside the clip whatever its z, and leaves what is outside unclipped", () => {
    const box = flex({ width: 40, height: 20, overflow: "hidden" }, row(11, 11, 5), row(12, 12));
    const root = new Entity();
    root.addChild(box);
    root.addChild(row(13, 13, 1));
    const records = names(draw(root));
    assert.deepEqual(records, [
      "view",
      "scissor(0,0,40,20)",
      "rect12x12@11,0",
      "scissorEnd",
      "rect13x13@0,0",
      "scissor(0,0,40,20)",
      "rect11x11@0,0",
      "scissorEnd",
    ]);
  });

  it("works inside a Hud, and does not carry a clip into the next layer", () => {
    const first = new Hud();
    first.addChild(flex({ width: 30, height: 10, overflow: "hidden" }, row(50, 50)));
    const second = new Hud();
    second.addChild(row(9, 9));
    const root = new Entity();
    root.addChild(first);
    root.addChild(second);
    assert.deepEqual(names(draw(root)), ["view", "view", "scissor(0,0,30,10)", "rect50x50@0,0", "scissorEnd", "rect9x9@0,0"]);
  });

  it("is the same frame when it is built again from scratch (retain check), and with a box that has no children", () => {
    const root = new Entity();
    root.addChild(flex({ width: 40, height: 20, overflow: "hidden" }, row(100, 100)));
    root.addChild(flex({ width: 40, height: 20, overflow: "scroll", background: "blue" }));
    const first = names(draw(root, 200, 100, true));
    assert.ok(first.includes("scissor(0,0,40,20)"));
    assert.deepEqual(names(draw(root, 200, 100, true)), first);
  });

  it("clips everything for a box that is not a number, rather than leaving a stale clip", () => {
    const records = draw(flex({ width: Number.NaN as unknown as number, height: 10, overflow: "hidden" }, row(10, 10)));
    assert.ok(records.every((r) => r.op !== "scissor" || (Number.isFinite(r.width) && r.width >= 0)));
  });
});

describe("overflow: the mouse", () => {
  afterEach(() => {
    assert.equal(getSoundSink(), null, "every test closes its player");
  });
  const WINDOW = { width: 200, height: 100, title: "test" };
  type Input = Parameters<RecordingBackend["queueInput"]>[0];

  function play(root: () => GameObject) {
    const backend = new RecordingBackend();
    const p = createPlayer(backend, { ...WINDOW, root, warn: () => {} });
    const step = (input: Input): void => {
      backend.queueInput(input);
      p.step();
    };
    // What a step is given the player acts on at the start of the next one, so an input is followed by one that does nothing new.
    const act = (input: Input): void => {
      step(input);
      step({ mouse: input.mouse });
    };
    return { p, step, act, backend };
  }

  const scrollBox = (props: FlexProps = {}): Flex =>
    flex({ direction: "column", width: 40, height: 20, overflow: "scroll", ...props }, ...Array.from({ length: 5 }, () => row(30, 10)));

  it("scrolls the box under the mouse by the wheel, by a notch of 32 pixels, to its ends and no further", () => {
    const box = scrollBox();
    const { p, step, act } = play(() => box);
    step({ mouse: { x: 5, y: 5 } });
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    assert.equal(box.scrollY, 30, "30 is all there is to scroll");
    act({ mouse: { x: 5, y: 5 }, wheel: 1 });
    assert.equal(box.scrollY, 0, "a wheel the other way, back to the start");
    act({ mouse: { x: 5, y: 5 }, wheel: 0.5 });
    assert.equal(box.scrollY, 0, "and no further");
    act({ mouse: { x: 150, y: 80 }, wheel: -1 });
    assert.equal(box.scrollY, 0, "the mouse is not over it");
    p.close();
  });

  it("moves by a notch where the content allows it, not to the end", () => {
    const box = flex({ direction: "column", width: 40, height: 20, overflow: "scroll" }, ...Array.from({ length: 10 }, () => row(30, 10)));
    const { p, act } = play(() => box);
    act({ mouse: { x: 5, y: 5 } });
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    assert.equal(box.scrollY, 32);
    act({ mouse: { x: 5, y: 5 }, wheel: -2 });
    assert.equal(box.scrollY, 80, "two notches, up to the end (100 in 20)");
    p.close();
  });

  it("is drawn scrolled in the step that heard the wheel", () => {
    const box = scrollBox();
    const { p, act, backend } = play(() => box);
    act({ mouse: { x: 5, y: 5 } });
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    const ys = backend.lastFrame.records.flatMap((r) => (r.op === "rect" && r.width === 30 ? [r.y] : []));
    assert.deepEqual(ys, [-30, -20, -10, 0, 10]);
    p.close();
  });

  it("scrolls along x when it cannot scroll along y, and does nothing for a box that fits or is not a scroll box", () => {
    const wide = flex({ width: 25, height: 10, overflow: "scroll" }, row(20, 10), row(20, 10));
    const fits = flex({ direction: "column", width: 40, height: 100, overflow: "scroll" }, row(30, 10));
    const hidden = flex(
      { direction: "column", width: 40, height: 20, overflow: "hidden" },
      ...Array.from({ length: 5 }, () => row(30, 10))
    );
    const root = new Entity();
    fits.transform.x = 60;
    hidden.transform.x = 120;
    root.addChild(wide);
    root.addChild(fits);
    root.addChild(hidden);
    const { p, act } = play(() => root);
    act({ mouse: { x: 5, y: 5 } });
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    act({ mouse: { x: 65, y: 5 }, wheel: -1 });
    act({ mouse: { x: 125, y: 5 }, wheel: -1 });
    assert.equal(wide.scrollX, 15);
    assert.equal(fits.scrollY, 0);
    assert.equal(hidden.scrollY, 0);
    p.close();
  });

  it("passes the wheel to the scroll box around one that is at its end", () => {
    const inner = flex({ direction: "column", width: 30, height: 20, overflow: "scroll" }, ...Array.from({ length: 4 }, () => row(20, 10)));
    const outer = flex({ direction: "column", width: 40, height: 30, overflow: "scroll" }, inner, row(20, 40));
    const { p, act } = play(() => outer);
    act({ mouse: { x: 5, y: 5 } });
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    assert.equal(inner.scrollY, 20, "the inner box takes it first, to its end (40 in 20)");
    assert.equal(outer.scrollY, 0);
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    assert.equal(outer.scrollY, 30, "then the outer one, to its end (60 in 30)");
    p.close();
  });

  it("scrolls a box in a Hud, with the mouse taken back through the HUD's view", () => {
    const box = scrollBox();
    const hud = new Hud();
    hud.addChild(box);
    const { p, act } = play(() => hud);
    act({ mouse: { x: 5, y: 5 } });
    act({ mouse: { x: 5, y: 5 }, wheel: -1 });
    assert.equal(box.scrollY, 30);
    p.close();
  });

  it("does not press or hover a child where the box clips it, and does where it shows", () => {
    const log: string[] = [];
    const button = flex({
      width: 40,
      height: 20,
      onPress: () => log.push("press"),
      onPointerEnter: () => log.push("enter"),
      onPointerLeave: () => log.push("leave"),
    });
    button.transform.x = 20;
    const clip = flex({ width: 30, height: 20, overflow: "hidden" }, button);
    const { p, act } = play(() => clip);
    act({ mouse: { x: 40, y: 10 } }); // past the clip at x 30, inside the button (20 to 60)
    assert.deepEqual(log, [], "nothing there");
    act({ mouse: { x: 25, y: 10 } });
    act({ mouse: { x: 25, y: 10 }, pressed: ["MouseLeft"] });
    assert.deepEqual(log, ["enter", "press"], "enter and press where it shows");
    act({ mouse: { x: 45, y: 10 } });
    act({ mouse: { x: 45, y: 10 }, pressed: ["MouseLeft"] });
    assert.deepEqual(log, ["enter", "press", "leave"], "moving into the clipped part leaves it, and a press there does nothing");
    p.close();
  });

  it("scrolls the box a drag began over, the content following the pointer to its ends, once the drag is past a tap", () => {
    const box = scrollBox();
    const { p, step } = play(() => box);
    // The player acts on a step's input at the start of the next, so each is given twice.
    const held = (y: number): void => {
      step({ mouse: { x: 5, y }, down: ["MouseLeft"] });
      step({ mouse: { x: 5, y }, down: ["MouseLeft"] });
    };
    step({ mouse: { x: 5, y: 15 } });
    step({ mouse: { x: 5, y: 15 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    held(11);
    assert.equal(box.scrollY, 0, "4 pixels is still a tap");
    held(5);
    assert.equal(box.scrollY, 0, "past it, the drag scrolls from here: the content does not jump");
    held(-3);
    assert.equal(box.scrollY, 8, "up 8, the content up 8");
    held(1);
    assert.equal(box.scrollY, 4, "and back with the pointer");
    held(-60);
    assert.equal(box.scrollY, 30, "to its end and no further");
    step({ mouse: { x: 5, y: -60 } });
    step({ mouse: { x: 5, y: 40 } });
    assert.equal(box.scrollY, 30, "let go: the pointer moving does not scroll it");
    step({ mouse: { x: 150, y: 80 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: 10 }, down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: 60 }, down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: 60 }, down: ["MouseLeft"] });
    assert.equal(box.scrollY, 30, "a drag that began off the box does not scroll it, even over it");
    p.close();
  });

  it("scrolls when the drag began on a button in the box, which looks pressed but never hears the press; not on a box that takes drags", () => {
    let pressed = 0;
    const moves: number[] = [];
    const rows = Array.from({ length: 5 }, () => row(30, 10));
    const button = flex({ width: 30, height: 10, onPress: () => pressed++, pressedBackground: "red" });
    const box = flex({ direction: "column", width: 40, height: 20, overflow: "scroll" }, button, ...rows);
    const { p, step, backend } = play(() => box);
    const red = (): boolean => JSON.stringify(backend.lastFrame.records).includes("#ff0000");
    step({ mouse: { x: 5, y: 5 } });
    step({ mouse: { x: 5, y: 5 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: 5 }, down: ["MouseLeft"] });
    assert.equal(red(), true, "held: the button's pressed look");
    step({ mouse: { x: 5, y: -10 }, down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: -20 }, down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: -20 }, down: ["MouseLeft"] });
    assert.deepEqual([pressed, box.scrollY, red()], [0, 10, false], "scrolled, not pressed, and no longer drawn pressed");
    step({ mouse: { x: 5, y: -20 } });
    step({ mouse: { x: 5, y: -20 } });
    assert.equal(pressed, 0, "nor when it is let go");
    p.close();

    const slider = flex({ width: 30, height: 10, onDrag: (_x, y) => moves.push(y) });
    const list = flex(
      { direction: "column", width: 40, height: 20, overflow: "scroll" },
      slider,
      ...Array.from({ length: 5 }, () => row(30, 10))
    );
    const second = play(() => list);
    second.step({ mouse: { x: 5, y: 5 } });
    second.step({ mouse: { x: 5, y: 5 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    second.step({ mouse: { x: 5, y: -20 }, down: ["MouseLeft"] });
    second.step({ mouse: { x: 5, y: -20 } });
    assert.deepEqual([moves, list.scrollY], [[-20], 0], "the drag is the slider's");
    second.p.close();
  });

  it("over a box with something to scroll, a tap presses on release; a drag that scrolls presses nothing, the box it is in included", () => {
    const log: string[] = [];
    const button = flex({ width: 30, height: 10, onPress: () => log.push("button") });
    const text = flex(
      { direction: "column", width: 40, height: 20, overflow: "scroll" },
      button,
      ...Array.from({ length: 5 }, () => row(30, 10))
    );
    // A card that is pressed to choose it, with text in it that scrolls: as a pick's card in a game.
    const card = flex({ direction: "column", width: 60, height: 60, onPress: () => log.push("card") }, text);
    const { p, step } = play(() => card);
    step({ mouse: { x: 5, y: 5 } });
    step({ mouse: { x: 5, y: 5 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 6, y: 7 }, down: ["MouseLeft"] });
    assert.deepEqual(log, [], "held, and not yet a scroll: nothing heard");
    step({ mouse: { x: 6, y: 7 } });
    step({ mouse: { x: 6, y: 7 } });
    assert.deepEqual(log, ["button"], "let go within a tap: the press");

    log.length = 0;
    step({ mouse: { x: 50, y: 40 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 50, y: 40 } });
    assert.deepEqual(log, ["card"], "on the card off its text: heard as it goes down");

    log.length = 0;
    step({ mouse: { x: 35, y: 15 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 35, y: 5 }, down: ["MouseLeft"] });
    step({ mouse: { x: 35, y: -5 }, down: ["MouseLeft"] });
    step({ mouse: { x: 35, y: -5 }, down: ["MouseLeft"] });
    step({ mouse: { x: 35, y: -5 } });
    step({ mouse: { x: 35, y: -5 } });
    assert.deepEqual([log, text.scrollY], [[], 10], "a drag on the card's text scrolls it, and the card hears nothing");

    log.length = 0;
    step({ mouse: { x: 35, y: 15 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 35, y: 15 } });
    step({ mouse: { x: 35, y: 15 } });
    assert.deepEqual(log, ["card"], "a tap on the card's text chooses the card");
    p.close();
  });

  it("presses at once over a scroll box with nothing to scroll", () => {
    let pressed = 0;
    const button = flex({ width: 30, height: 10, onPress: () => pressed++ });
    const box = flex({ direction: "column", width: 40, height: 40, overflow: "scroll" }, button);
    const { p, step } = play(() => box);
    step({ mouse: { x: 5, y: 5 } });
    step({ mouse: { x: 5, y: 5 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 5, y: 5 }, down: ["MouseLeft"] });
    assert.equal(pressed, 1);
    p.close();
  });

  it("scrolls a box in a Hud by a drag, along x when that is the way it overflows", () => {
    const wide = flex({ width: 25, height: 10, overflow: "scroll" }, row(20, 10), row(20, 10));
    const hud = new Hud();
    hud.addChild(wide);
    const { p, step } = play(() => hud);
    step({ mouse: { x: 20, y: 5 } });
    step({ mouse: { x: 20, y: 5 }, pressed: ["MouseLeft"], down: ["MouseLeft"] });
    step({ mouse: { x: 12, y: 5 }, down: ["MouseLeft"] });
    step({ mouse: { x: 2, y: 5 }, down: ["MouseLeft"] });
    step({ mouse: { x: 2, y: 5 }, down: ["MouseLeft"] });
    assert.deepEqual([wide.scrollX, wide.scrollY], [10, 0]);
    p.close();
  });

  it("clips a press in a Hud too", () => {
    const log: string[] = [];
    const button = flex({ width: 40, height: 20, onPress: () => log.push("press") });
    button.transform.x = 20;
    const clip = flex({ width: 30, height: 20, overflow: "hidden" }, button);
    const hud = new Hud();
    hud.addChild(clip);
    const { p, act } = play(() => hud);
    act({ mouse: { x: 25, y: 10 } });
    act({ mouse: { x: 45, y: 10 }, pressed: ["MouseLeft"] });
    assert.deepEqual(log, [], "past the clip");
    act({ mouse: { x: 25, y: 10 }, pressed: ["MouseLeft"] });
    assert.deepEqual(log, ["press"]);
    p.close();
  });
});
