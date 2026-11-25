import assert from "node:assert/strict";
/** `<Flex onLayout>`: a box tells its component where it was laid out, at the start of the step after the frame it was laid out in. */
import { describe, it } from "node:test";

import { Entity, Flex, Screen, Shape, World, type LayoutBox } from "@tsengine/runtime";

import { FrameBuilder } from "../src/draw.ts";

const builder = (): FrameBuilder => new FrameBuilder({ loadTexture: () => 0, retain: "check" });

/** A column of a 100 x 30 box and a 40 x 20 box with padding 6 and a gap of 4, 50 pixels in, the second box reporting where it is. */
function scene(): { world: World; column: Flex; first: Flex; second: Flex; heard: LayoutBox[] } {
  const heard: LayoutBox[] = [];
  const world = new World();
  const root = new Entity();
  const at = new Entity();
  at.transform.x = 50;
  at.transform.y = 20;
  const column = new Flex({ direction: "column", padding: 6, gap: 4 });
  const first = new Flex({ width: 100, height: 30 });
  const second = new Flex({ width: 40, height: 20, onLayout: (box) => heard.push(box) });
  column.addChild(first);
  column.addChild(second);
  at.addChild(column);
  root.addChild(at);
  world.mount(root);
  return { world, column, first, second, heard };
}

describe("<Flex onLayout>", () => {
  it("is told where the box was laid out at the start of the next step, and not again until that changes", () => {
    const { world, first, heard } = scene();
    const frames = builder();
    world.tick(1 / 60);
    assert.deepEqual(heard, [], "nothing is laid out before the first frame");
    frames.build(world.root, 320, 180);
    world.tick(1 / 60);
    // Under the first box: 50 + 6 across, 20 + 6 + 30 + 4 down.
    assert.deepEqual(heard, [{ x: 56, y: 60, width: 40, height: 20 }]);
    frames.build(world.root, 320, 180);
    world.tick(1 / 60);
    assert.equal(heard.length, 1, "the same place is not told again");
    first.height = 50;
    first.markChanged();
    frames.build(world.root, 320, 180);
    world.tick(1 / 60);
    assert.deepEqual(heard.at(-1), { x: 56, y: 80, width: 40, height: 20 }, "a taller box above moves it down");
  });

  it("is in the game's pixels under a <Screen>, wherever the screen sits in the window", () => {
    const heard: LayoutBox[] = [];
    const world = new World();
    const screen = new Screen({ width: 640, height: 360 });
    const box = new Flex({ width: 132, height: 40, right: 10, bottom: 10, onLayout: (b) => heard.push(b) });
    screen.addChild(box);
    screen.addChild(new Shape({ kind: "rect", width: 1, height: 1, color: "red" }));
    world.mount(screen);
    const frames = builder();
    for (const [w, h] of [
      [1280, 720],
      [1000, 900],
    ]) {
      frames.build(world.root, w!, h!);
      world.tick(1 / 60);
    }
    assert.deepEqual(heard, [{ x: 498, y: 310, width: 132, height: 40 }], "the same place in a wider and a taller window");
  });

  it("says nothing for a box with no onLayout, or once it is gone", () => {
    const { world, column, second, heard } = scene();
    const frames = builder();
    column.removeChild(second);
    frames.build(world.root, 320, 180);
    world.tick(1 / 60);
    assert.deepEqual(heard, []);
  });
});
