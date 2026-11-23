import assert from "node:assert/strict";
/** A sprite's `shader`, `params` and `lookup` (ABI v16) in a component: props that follow state, with the files checked. */
import { after, describe, it } from "node:test";

import { Sprite, World, type Entity } from "@tsengine/runtime";

import { checkAssets } from "../src/index.ts";
import { cleanOutput, closeCompiler, compile, load, typeCheck } from "./helpers.ts";

after(() => {
  closeCompiler();
  cleanOutput();
});

describe("a sprite's shader", () => {
  it("compiles, its params following state", async () => {
    const compiled = compile(`export function Fruit() {
  const s = useMutable({ turn: 0 });
  useUpdate(() => { s.turn = 2; });
  return <Sprite image="apple.png" shader="fruit.glsl" lookup="ramps.png" params={[s.turn, 0.5]} />;
}`);
    assert.deepEqual(typeCheck(compiled), []);
    const { Fruit } = await load<{ Fruit: new () => Entity }>(compiled);
    const world = new World();
    const fruit = new Fruit();
    world.mount(fruit);
    world.flush();
    assert.ok(fruit instanceof Sprite);
    const sprite = fruit as unknown as Sprite;
    assert.deepEqual([sprite.shader, sprite.lookup, [...sprite.params]], ["fruit.glsl", "ramps.png", [0, 0.5]]);
    world.tick(1 / 60);
    world.flush();
    assert.deepEqual([...sprite.params], [2, 0.5]);
  });

  it("checks the shader and the lookup named as literals against the assets folder", () => {
    const files = ["apple.png", "fruit.glsl", "ramps.png"];
    const check = (source: string) =>
      checkAssets([compile(source).ir], { folder: "assets", exists: (name) => files.includes(name), list: () => files });
    const found = check(`function Fruit() { return <Sprite image="apple.png" shader="friut.glsl" lookup="rmaps.png" />; }`);
    assert.equal(found.length, 2);
    assert.match(found[0]!.message, /shader.*fruit\.glsl/s);
    assert.match(found[1]!.message, /image.*ramps\.png/s);
    assert.deepEqual(check(`function Fruit() { return <Sprite image="apple.png" shader="fruit.glsl" lookup="ramps.png" />; }`), []);
    assert.equal(check(`function Fruit() { return <AnimatedSprite frames={["apple.png"]} shader="nope.glsl" />; }`).length, 1);
  });
});
