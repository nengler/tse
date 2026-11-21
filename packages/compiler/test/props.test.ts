/**
 * Props and callbacks between components. A parent passes values and callbacks to a local or imported component; a changed
 * value updates the existing child in place. Also the props object (`props.name`) and a callback prop forwarded to a built-in.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { Entity, Sprite, World, Flex } from "@tsengine/runtime";

import { DiagnosticCode } from "../src/index.ts";
import {
  cleanOutput,
  closeCompiler,
  compile,
  compileErrors,
  compileProject,
  load,
  loadProject,
  typeCheck,
  typeCheckProject,
  elementOf,
  component,
} from "./helpers.ts";

after(() => {
  closeCompiler();
  cleanOutput();
});

const GAME = `
interface EnemyProps {
  speed: number;
  skin?: "red" | "blue";
  onDefeated?: () => void;
}

function Enemy({ speed, skin = "red", onDefeated }: EnemyProps) {
  const s = useMutable({ hp: 10 });
  useUpdate((dt) => {
    s.hp -= speed * dt;
    if (s.hp <= 0) onDefeated?.();
  });
  return (
    <Entity name="Enemy" x={speed}>
      <Sprite image={skin === "red" ? "enemy-red.png" : "enemy-blue.png"} />
    </Entity>
  );
}

function Level() {
  const s = useMutable({ score: 0 });
  return (
    <Entity name="Level">
      <Enemy speed={s.score > 10 ? 2 : 1} onDefeated={() => { s.score += 1; }} />
    </Entity>
  );
}
`;

interface EnemyProps {
  speed: number;
  skin?: "red" | "blue";
  onDefeated?: () => void;
}
interface EnemyInstance extends Entity {
  props: EnemyProps;
  updateProps(next: Partial<EnemyProps>): void;
  readonly sprite: Sprite;
  s: { hp: number };
}
interface LevelInstance extends Entity {
  s: { score: number };
  readonly enemy: EnemyInstance;
}

let Enemy: new (props: EnemyProps) => EnemyInstance;
let Level: new () => LevelInstance;

before(async () => {
  ({ Enemy, Level } = await load<{ Enemy: typeof Enemy; Level: typeof Level }>(compile(GAME, "Game.tsx")));
});

describe("props: IR shape", () => {
  it("keeps the props type declaration and describes every prop", () => {
    const { ir } = compile(GAME, "Game.tsx");
    assert.deepEqual(
      ir.typeDeclarations.map((t) => t.name),
      ["EnemyProps"]
    );
    assert.match(ir.typeDeclarations[0]!.text, /^interface EnemyProps \{/);
    const enemy = ir.components.find((c) => c.name === "Enemy")!;
    assert.equal(enemy.propsType, "EnemyProps");
    assert.deepEqual(
      enemy.props.map((p) => [p.name, p.role, p.optional, p.type.kind]),
      [
        ["speed", "value", false, "Primitive"],
        ["skin", "value", true, "Literals"],
        ["onDefeated", "callback", true, "Function"],
      ]
    );
    assert.deepEqual(enemy.props[1]!.type, { kind: "Literals", values: ["red", "blue"] });
    assert.deepEqual(enemy.props[1]!.defaultValue, { kind: "StringLiteral", value: "red" });
  });

  it("describes array, literal and unrepresentable prop types for the scene schema", () => {
    const c = component(
      `
type Shape = { points: number[]; mode: 1 | 2 | 3; label: string | undefined; tags: string[] };
function P({ points }: Shape) { return <Entity name="P" />; }`,
      "P"
    );
    assert.deepEqual(
      c.props.map((p) => p.type),
      [
        { kind: "Array", element: { kind: "Primitive", name: "number" } },
        { kind: "Literals", values: [1, 2, 3] },
        { kind: "SourceText", text: "string | undefined" },
        { kind: "Array", element: { kind: "Primitive", name: "string" } },
      ]
    );
  });

  it("makes a prop read a dependency, so JSX that uses a prop re-renders when the parent changes it", () => {
    const enemy = component(GAME, "Enemy");
    const sprite = elementOf(enemy.root.children[0]!);
    const image = sprite.props[0]!;
    assert.ok(image.kind === "DynamicProp");
    assert.deepEqual(image.dependencies, [{ kind: "Prop", name: "skin" }]);
    const x = enemy.root.transform[0]!;
    assert.ok(x.kind === "DynamicProp" && x.value.kind === "PropRead");
  });

  it("lowers an inline arrow passed to a component to a callback with contextually typed parameters", () => {
    const level = component(GAME, "Level");
    const props = elementOf(level.root.children[0]!).props;
    assert.deepEqual(
      props.map((p) => [p.name, p.kind]),
      [
        ["speed", "DynamicProp"],
        ["onDefeated", "CallbackProp"],
      ]
    );
    const callback = props[1]!;
    assert.ok(callback.kind === "CallbackProp");
    assert.equal(callback.handler.params.length, 0);
    const parametrised = component(
      `interface ChildProps { onHit: (amount: number) => void }
function Child({ onHit }: ChildProps) { return <Entity name="C" />; }
function P() { const s = useMutable({ n: 0 }); return <Entity name="P"><Child onHit={(amount) => { s.n += amount; }} /></Entity>; }`,
      "P"
    );
    const hit = elementOf(parametrised.root.children[0]!).props[0]!;
    assert.ok(hit.kind === "CallbackProp" && hit.handler.params[0]!.type.kind === "Contextual");
  });
});

describe("props: generated code", () => {
  it("types the class with its props, passes them and the defaults up, and generates updateProps", () => {
    const { code } = compile(GAME, "Game.tsx");
    assert.match(code, /^export interface EnemyProps \{/m);
    assert.match(code, /export class Enemy extends Entity<EnemyProps> \{/);
    assert.match(code, /constructor\(props: EnemyProps\) \{\n\s+super\(\{ name: "Enemy" \}, props, \{ skin: "red" \}\);/);
    assert.match(
      code,
      /updateProps\(next: Partial<EnemyProps>\): void \{\n\s+if \(this\.applyProps\(next, \{ skin: "red" \}\)\) this\.markDirty\(\);/
    );
    assert.match(code, /this\.props\.onDefeated\?\.\(\)/);
    assert.match(code, /const (\$\d+)(?:: [^=]+)? = this\.props\.speed;[^]*?this\.transform\.x = \1;/);
  });

  it("builds a child with all its props and callbacks, and re-sends the dynamic ones in one call", () => {
    const { code } = compile(GAME, "Game.tsx");
    assert.match(
      code,
      /readonly enemy: Enemy = this\.withPropGetters\(new Enemy\(\{ speed: \(this\.\$s_score > 10\) \? 2 : 1, onDefeated: \(\) => \{ this\.\$set_s_score\(/
    );
    assert.match(code, /this\.enemy\.updateProps\(\{ speed: \(this\.\$s_score > 10\) \? 2 : 1 \}\);/);
    assert.doesNotMatch(
      code.slice(code.indexOf("class Level")),
      /updateProps\(\{[^}]*onDefeated/,
      "a callback is created once, never re-sent"
    );
  });

  it("treats an optional prop with a default as defined, so arithmetic on it type-checks", () => {
    const compiled = compile(`interface SpinProps { rate?: number; label?: string }
function Spinner({ rate = 2, label }: SpinProps) {
  const s = useMutable({ angle: 0 });
  useUpdate((dt) => { s.angle += dt * rate; });
  return <Entity name="spinner" rotation={s.angle * rate} x={label ? 1 : 0} />;
}`);
    assert.match(compiled.code, /dt \* this\.\$live_rate!/);
    assert.match(compiled.code, /this\.props\.label\b(?!!)/, "an optional prop without a default really can be undefined");
    assert.deepEqual(typeCheck(compiled), []);
  });

  it("allows every prop to be omitted when each is optional", () => {
    const { code } = compile(`interface BadgeProps { label?: string }
function Badge({ label = "x" }: BadgeProps) { return <Entity name={label} />; }
function Host() { return <Entity name="H"><Badge /></Entity>; }`);
    assert.match(code, /constructor\(props: BadgeProps = \{\}\)/);
    assert.match(code, /new Badge\(\)/);
  });

  it("type-checks", () => {
    assert.deepEqual(typeCheck(compile(GAME, "Game.tsx")), []);
  });

  it("fails the type-check for a missing required prop, a wrong type and an unknown prop", () => {
    for (const props of [``, `speed="fast"`, `speed={1} wings={2}`, `speed={1} skin="green"`, `speed={1} onDefeated={(x) => {}}`]) {
      const compiled = compile(`${GAME}\nfunction Bad() { return <Entity name="B"><Enemy ${props} /></Entity>; }`, "Bad.tsx");
      assert.ok(typeCheck(compiled).length > 0, props || "(no props)");
    }
  });
});

describe("props: runtime behaviour", () => {
  it("updates the child in place when the parent's state changes, rendering the child once", () => {
    const world = new World();
    const level = new Level();
    world.mount(level);
    const enemy = level.enemy;
    assert.equal(enemy.props.speed, 1);
    assert.equal(enemy.transform.x, 1);

    let childRenders = 0;
    const render = enemy.render.bind(enemy);
    enemy.render = () => {
      childRenders++;
      render();
    };

    level.s.score = 11;
    assert.equal(world.flush(), 2, "the parent renders once and re-renders the child once, in the same flush");
    assert.equal(childRenders, 1);
    assert.equal(level.enemy, enemy, "same instance");
    assert.equal(enemy.props.speed, 2);
    assert.equal(enemy.transform.x, 2, "JSX that reads a prop followed it");
  });

  it("does not render the child when the parent re-renders with unchanged props", () => {
    const world = new World();
    const level = new Level();
    world.mount(level);
    const enemy = level.enemy;
    level.s.score = 1; // speed stays 1
    assert.equal(world.flush(), 1);
    assert.equal(enemy.isDirty, false);
  });

  it("lets the child call a callback that updates the parent's state", () => {
    const world = new World();
    const level = new Level();
    world.mount(level);
    world.tick(19); // hp: 10 - 1 * 19 = -9 at the end of the step...
    assert.equal(level.enemy.s.hp, -9);
    // ...and the handler read the hp it had just written, so it called onDefeated in that same step, and the parent's write rendered.
    assert.equal(level.s.score, 1, "the callback's write was applied in the same tick's flush");
    world.tick(1);
    assert.equal(level.s.score, 2, "still at or below 0: defeated again");
  });

  it("calls an optional callback that was not passed without error", () => {
    const world = new World();
    const enemy = new Enemy({ speed: 1 });
    world.mount(enemy);
    world.tick(20);
    assert.doesNotThrow(() => world.tick(1));
  });

  it("applies defaults at construction, for omitted and undefined props, and on update", () => {
    const enemy = new Enemy({ speed: 1 });
    assert.equal(enemy.props.skin, "red");
    assert.equal(enemy.sprite.image, "enemy-red.png");
    assert.equal(new Enemy({ speed: 1, skin: undefined }).props.skin, "red");

    const world = new World();
    world.mount(enemy);
    enemy.updateProps({ skin: "blue" });
    world.flush();
    assert.equal(enemy.sprite.image, "enemy-blue.png");
    enemy.updateProps({ skin: undefined });
    world.flush();
    assert.equal(enemy.props.skin, "red", "an undefined update falls back to the default");
    assert.equal(enemy.sprite.image, "enemy-red.png");
  });

  it("leaves a prop alone when it is not in the update, and ignores an unchanged update", () => {
    const world = new World();
    const enemy = new Enemy({ speed: 3, skin: "blue" });
    world.mount(enemy);
    enemy.updateProps({ speed: 3 });
    assert.equal(enemy.isDirty, false, "the same value is not a change");
    enemy.updateProps({ skin: "red" });
    assert.equal(enemy.props.speed, 3);
    assert.equal(enemy.isDirty, true);
  });
});

describe("where props can be read", () => {
  it("reads props when a state value is first created, and in handlers, conditions and derived values", async () => {
    const { Counter } = await load<{
      Counter: new (props: { start: number; limit: number; show?: boolean }) => Entity & { updateProps(p: object): void; s: { n: number } };
    }>(
      compile(`interface CounterProps { start: number; limit: number; show?: boolean }
function Counter({ start, limit, show = true }: CounterProps) {
  const s = useMutable({ n: start });
  const over = s.n >= limit;
  useUpdate(() => { s.n += 1; });
  return (
    <Entity name="Counter">
      {show && over && <Sprite image="over.png" />}
    </Entity>
  );
}`)
    );
    const world = new World();
    const counter = new Counter({ start: 3, limit: 5 });
    world.mount(counter);
    assert.equal(counter.s.n, 3, "the initial state read the prop");
    world.tick(1);
    world.tick(1);
    assert.equal(counter.s.n, 5);
    assert.equal(counter.children.length, 1, "a condition that reads a prop and state is true");
    counter.updateProps({ show: false });
    world.flush();
    assert.equal(counter.children.length, 0, "the condition follows a prop");
    counter.updateProps({ limit: 100, show: true });
    world.flush();
    assert.equal(counter.children.length, 0);
  });

  it("forwards a callback prop whole to a child", async () => {
    const { Panel } = await load<{ Panel: new (props: { onDone?: () => void }) => Entity & { updateProps(p: object): void } }>(
      compile(`interface BarProps { start: number; onDone?: () => void }
function Bar({ start, onDone }: BarProps) {
  const s = useMutable({ n: start });
  useUpdate(() => { if (s.n > 3) onDone?.(); });
  return <Entity name="Bar" />;
}
interface PanelProps { onDone?: () => void }
function Panel({ onDone }: PanelProps) {
  return <Entity name="Panel"><Bar start={5} onDone={onDone} /></Entity>;
}`)
    );
    let done = 0;
    const world = new World();
    const panel = new Panel({
      onDone: () => {
        done++;
      },
    });
    world.mount(panel);
    world.tick(1);
    assert.equal(done, 1);
    let replaced = 0;
    panel.updateProps({
      onDone: () => {
        replaced++;
      },
    });
    world.flush();
    world.tick(1);
    assert.deepEqual([done, replaced], [1, 1], "an updated callback reaches the child");
  });

  it("tests whether an optional callback prop was passed (`onAdjust === undefined`), in the tree and in a handler", async () => {
    const compiled = compile(`interface RowProps { label: string; onAdjust?: (by: number) => void }
function Row({ label, onAdjust }: RowProps) {
  useInput((input) => {
    if (onAdjust === undefined) return;
    if (input.pressed("Right")) onAdjust(1);
  });
  return <Entity name="Row">{onAdjust !== undefined && <Text>{\`\${label} <>\`}</Text>}{null == onAdjust && <Text>{label}</Text>}</Entity>;
}`);
    assert.deepEqual(typeCheck(compiled), []);
    const { Row } = await load<{
      Row: new (props: { label: string; onAdjust?: (by: number) => void }) => Entity & { updateProps(p: object): void };
    }>(compiled);
    const texts = (row: Entity): string[] => row.children.flatMap((c) => ("text" in c ? [String(c.text)] : []));
    const world = new World();
    const plain = new Row({ label: "a" });
    world.mount(plain);
    world.flush();
    assert.deepEqual(texts(plain), ["a"]);
    const moved: number[] = [];
    plain.updateProps({ label: "a", onAdjust: (by: number) => moved.push(by) });
    world.flush();
    assert.deepEqual(texts(plain), ["a <>"], "passing it later is seen");
    world.tick(1 / 60, { pressed: (k: string) => k === "Right", down: () => false, released: () => false } as never);
    assert.deepEqual(moved, [1]);
    assert.match(
      compileErrors(`function A({ onGo }: { onGo?: () => void }) { const f = onGo; return <Entity />; }`)[0]!.message,
      /'onGo' is a callback prop: call it/,
      "read as a value otherwise, it is still an error"
    );
  });
});

describe("props across files", () => {
  const FILES = {
    "Enemy.tsx": `interface EnemyProps { speed: number; onDefeated?: () => void }
export function Enemy({ speed, onDefeated }: EnemyProps) {
  useUpdate(() => { if (speed > 5) onDefeated?.(); });
  return <Entity name="Enemy" x={speed} />;
}`,
    "Level.tsx": `import { Enemy } from "./Enemy.tsx";
export function Level() {
  const s = useMutable({ score: 0, speed: 1 });
  return (
    <Entity name="Level">
      <Entity y={s.score}>
        <Enemy speed={s.speed} onDefeated={() => { s.score += 1; }} />
      </Entity>
    </Entity>
  );
}`,
  };

  it("passes props and callbacks to an imported component, and the project type-checks", async () => {
    const project = compileProject(FILES);
    assert.deepEqual(typeCheckProject(project), []);
    const { Level } = await loadProject<{ Level: new () => Entity & { s: { score: number; speed: number }; enemy: Entity } }>(
      project,
      "Level.tsx"
    );
    const world = new World();
    const level = new Level();
    world.mount(level);
    assert.equal(level.enemy.transform.x, 1);
    level.s.speed = 9;
    world.flush();
    assert.equal(level.enemy.transform.x, 9);
    world.tick(1);
    assert.equal(level.s.score, 1, "the imported child called the parent's callback");
    assert.equal(level.enemy.worldTransform().y, 1, "and the wrapper around it follows the score");
  });

  it("catches a wrong prop to an imported component in the project's type-check", () => {
    const bad = compileProject({ ...FILES, "Level.tsx": FILES["Level.tsx"].replace("speed={s.speed}", `speed="fast"`) });
    assert.ok(typeCheckProject(bad).length > 0);
  });
});

describe("props: diagnostics", () => {
  const codes = (source: string) => compileErrors(source).map((d) => d.code);
  const withProps = (declaration: string, parameter: string, body = "") =>
    `${declaration}\nfunction A(${parameter}) { ${body} return <Entity name="A" />; }`;

  it("rejects a props parameter that is not a destructuring annotated with a declared type", () => {
    const P = `interface P { a: number; b?: number }`;
    assert.deepEqual(codes(withProps(P, `{ a }: Missing`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(P, `{ a }`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(P, `props`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(P, `{ a, ...rest }: P`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(P, `{ nope: renamed }: P`)), [DiagnosticCode.InvalidProps], "a renamed prop must still be one");
    assert.deepEqual(codes(withProps(P, `{ a: { x } }: P`)), [DiagnosticCode.InvalidProps], "no nesting");
    assert.deepEqual(codes(withProps(P, `{ a }: P, other: P`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(P, `{ nope }: P`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(P, `{ a }: P = { a: 1 }`)), [DiagnosticCode.InvalidProps]);
  });

  it("takes a prop under another name (`{ seed: firstSeed }`), with a default, read live in handlers", async () => {
    const source = `interface SeedProps { seed: number; speed?: number }
export function Seeded({ seed: firstSeed, speed: rate = 2 }: SeedProps) {
  const s = useMutable({ seed: 0, seen: 0 });
  useUpdate(() => { s.seed = firstSeed * rate; s.seen = firstSeed; });
  return <Entity name="A" x={firstSeed} />;
}`;
    const { Seeded } = await load<{
      Seeded: new (props: {
        seed: number;
        speed?: number;
      }) => Entity & { s: { seed: number; seen: number }; updateProps(p: { seed: number }): void };
    }>(compile(source, "Seeded.tsx"));
    const a = new Seeded({ seed: 3 });
    const world = new World();
    world.mount(a);
    world.tick(1 / 60);
    assert.deepEqual([a.s.seed, a.transform.x], [6, 3], "the default applies under the new name");
    a.updateProps({ seed: 5 });
    world.tick(1 / 60);
    assert.deepEqual([a.s.seed, a.s.seen, a.transform.x], [10, 5, 5]);
    assert.deepEqual(typeCheck(compile(source, "Seeded.tsx")), []);
  });

  it("rejects props types it cannot describe", () => {
    assert.deepEqual(codes(withProps(`interface P extends Other { a: number }`, `{ a }: P`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(`type P = number`, `{ a }: P`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(`interface P { [key: string]: number }`, `{ a }: P`)), [
      DiagnosticCode.InvalidProps,
      DiagnosticCode.InvalidProps,
    ]);
    assert.deepEqual(codes(withProps(`interface P<T> { a: T }`, `{ a }: P`)), [
      DiagnosticCode.UnsupportedSyntax,
      DiagnosticCode.InvalidProps,
    ]);
  });

  it("rejects framework-reserved prop names", () => {
    for (const name of ["key", "ref", "transform", "children"]) {
      assert.ok(codes(withProps(`interface P { ${name}: number }`, `{}: P`)).includes(DiagnosticCode.InvalidProps), name);
    }
  });

  it("rejects defaults that are not constants, and defaults on callbacks", () => {
    assert.deepEqual(codes(withProps(`interface P { a?: number; b?: number }`, `{ a = 1, b = a }: P`)), [DiagnosticCode.InvalidProps]);
    assert.deepEqual(codes(withProps(`interface P { f?: () => void }`, `{ f = () => {} }: P`)), [DiagnosticCode.InvalidProps]);
  });

  it("infers a state's type from a primitive prop, and asks for a type argument otherwise", () => {
    const P = `interface P { label: string; count: number; items: number[]; onX?: () => void }`;
    const state = (initial: string, type = "") =>
      withProps(P, `{ label, count, items }: P`, `const s = useMutable({ v: ${type === "" ? initial : `${initial} as ${type}`} });`);
    const primitive = (name: string) => ({ kind: "Primitive", name });
    assert.deepEqual(compile(state("label")).ir.components[0]!.state[0]!.type, primitive("string"));
    assert.deepEqual(compile(state("count")).ir.components[0]!.state[0]!.type, primitive("number"));
    assert.deepEqual(
      compile(state("items")).ir.components[0]!.state[0]!.type,
      { kind: "Array", element: primitive("number") },
      "an array prop (M5a)"
    );
    for (const [initial, type] of [
      ["count * 2", "number"],
      ["count + 1", "number"],
      ['label + "!"', "string"],
      ["`${label}:${count}`", "string"],
      ["count > 3", "boolean"],
      ["!label", "boolean"],
      ["count > 3 ? 1 : 2", "number"],
    ] as const) {
      assert.deepEqual(compile(state(initial)).ir.components[0]!.state[0]!.type, primitive(type), initial);
    }
    assert.deepEqual(codes(state("count > 3 ? 1 : label")), [DiagnosticCode.UnsupportedStateType], "branches of different types");
    assert.deepEqual(compile(state("count", "number")).ir.components[0]!.state[0]!.type, primitive("number"));
  });

  it("imports a runtime function that is used only in a prop's default", async () => {
    const compiled = compile(`import { Entity, clamp } from "@tsengine/runtime/jsx";
interface P { speed?: number }
export function Capped({ speed = clamp(5, 0, 3) }: P) { return <Entity name="Capped" x={speed} />; }`);
    assert.match(compiled.code, /import \{ Entity, clamp, type PrefabDefinition \} from "@tsengine\/runtime";/);
    assert.deepEqual(typeCheck(compiled), []);
    const { Capped } = await load<{ Capped: new (props?: { speed?: number }) => Entity }>(compiled);
    assert.equal(new Capped().transform.x, 3, "the default was computed");
    assert.equal(new Capped({ speed: 1 }).transform.x, 1);
  });

  it("keeps the generated updateProps name free", () => {
    assert.ok(
      compile(`function A() { const updateProps = useMutable({ n: 0 }); return <Entity name="A" />; }`).code.includes("get $updateProps()")
    );
  });

  it("rejects a prop that clashes with state", () => {
    assert.ok(
      codes(withProps(`interface P { n: number }`, `{ n }: P`, `const n = useMutable({ v: 0 });`)).includes(
        DiagnosticCode.InvalidUseMutable
      )
    );
  });

  it("rejects calling a value, and reading a callback as a value", () => {
    const P = `interface P { a: number; f: () => void }`;
    assert.deepEqual(codes(withProps(P, `{ a, f }: P`, `useUpdate(() => { a(); });`)), [DiagnosticCode.UnsupportedExpression]);
    assert.deepEqual(codes(withProps(P, `{ a, f }: P`, `const g = f;`)), [DiagnosticCode.UnsupportedExpression]);
    assert.doesNotThrow(() => compile(withProps(P, `{ a, f }: P`, `useUpdate(() => { f?.(); });`)), "calling a callback prop is fine");
  });

  it("rejects a function passed to a built-in, key on a component's root, and children as attributes", () => {
    assert.deepEqual(codes(`function A() { return <Entity name="A"><Sprite image="a" onClick={() => {}} /></Entity>; }`), [
      DiagnosticCode.UnsupportedAttribute,
    ]);
    assert.deepEqual(
      codes(`function B() { return <Entity name="B" key="x" />; } function A() { return <Entity name="A"><B /></Entity>; }`),
      [DiagnosticCode.UnsupportedAttribute]
    );
    assert.deepEqual(
      codes(`function B() { return <Entity name="B" />; } function A() { return <Entity name="A"><B children={1} /></Entity>; }`),
      [DiagnosticCode.UnsupportedAttribute]
    );
  });
});

describe("the props object", () => {
  const SOURCE = `interface EnemyProps { speed: number; skin?: "red" | "blue"; onDefeated?: () => void }
function Enemy(props: EnemyProps) {
  const s = useMutable({ hp: props.speed * 10 });
  useUpdate((dt) => {
    s.hp -= dt * props.speed;
    if (s.hp <= 0) props.onDefeated?.();
  });
  return (
    <Entity name="Enemy" x={props.speed}>
      <Sprite image={props.skin === "blue" ? "blue.png" : "red.png"} />
    </Entity>
  );
}`;

  it("reads props as props.name, with the same lowering as destructuring", async () => {
    const compiled = compile(SOURCE);
    assert.match(compiled.code, /this\.props\.speed/);
    assert.match(compiled.code, /this\.props\.onDefeated\?\.\(\)/);
    assert.deepEqual(typeCheck(compiled), []);
    const enemy = compiled.ir.components[0]!;
    assert.deepEqual(
      enemy.props.map((p) => p.name),
      ["speed", "skin", "onDefeated"],
      "every member of the type is a prop"
    );
    const { Enemy } = await load<{ Enemy: new (props: EnemyProps) => EnemyInstance }>(compiled);
    let defeated = 0;
    const world = new World();
    const e = new Enemy({
      speed: 2,
      onDefeated: () => {
        defeated++;
      },
    });
    world.mount(e);
    assert.equal(e.s.hp, 20);
    e.updateProps({ speed: 5, skin: "blue" });
    world.flush();
    assert.equal(e.transform.x, 5, "JSX that reads props.speed followed the update");
    assert.equal(e.sprite.image, "blue.png");
    world.tick(100);
    assert.equal(defeated, 1, "the handler reads the hp it just wrote: defeated in the step that took it to 0");
    world.tick(1);
    assert.equal(defeated, 2);
  });

  it("applies no defaults, since there is no destructuring to hold them", () => {
    const { code } = compile(SOURCE);
    assert.match(code, /super\(\{ name: "Enemy" \}, props\);/);
    assert.match(code, /this\.applyProps\(next\)\) this\.markDirty\(\);/);
  });

  it("forwards a callback whole", () => {
    const { code } = compile(`interface BarProps { onDone?: () => void }
function Bar(props: BarProps) { return <Entity name="Bar" />; }
function Panel(props: BarProps) { return <Entity name="Panel"><Bar onDone={props.onDone} /></Entity>; }`);
    assert.match(code, /new Bar\(\{ onDone: this\.props\.onDone \}\)/);
  });

  it("rejects the bare object, unknown members, and calling a value", () => {
    const P = `interface P { a: number; f?: () => void }`;
    const run = (body: string) => compileErrors(`${P}\nfunction A(props: P) { ${body} return <Entity name="A" />; }`).map((d) => d.code);
    assert.deepEqual(run(`const copy = props;`), [DiagnosticCode.UnsupportedExpression]);
    assert.deepEqual(run(`useUpdate(() => { props.nope; });`).includes(DiagnosticCode.UnsupportedExpression), true);
    assert.deepEqual(run(`useUpdate(() => { props.a(); });`), [DiagnosticCode.UnsupportedExpression]);
    assert.deepEqual(run(`const g = props.f;`), [DiagnosticCode.UnsupportedExpression]);
  });
});

describe("a callback prop forwarded to a built-in", () => {
  it("is the prop itself: `<Flex onPress={onPress}>`, `props.onPress` too", async () => {
    const compiled = compile(`
interface ButtonProps { onPress: () => void; label: string; }
export function Button({ onPress, label }: ButtonProps) {
  return <Flex onPress={onPress}><Text size={8}>{label}</Text></Flex>;
}
export function Plain(props: ButtonProps) {
  return <Pointer width={4} height={4} onPress={props.onPress} />;
}`);
    assert.deepEqual(typeCheck(compiled), []);
    const { Button, Plain } = await load<{
      Button: new (p: { onPress: () => void; label: string }) => Flex;
      Plain: new (p: { onPress: () => void; label: string }) => Entity & { onPress?: () => void };
    }>(compiled);
    let presses = 0;
    const world = new World();
    const button = new Button({ onPress: () => presses++, label: "go" });
    const plain = new Plain({ onPress: () => (presses += 10), label: "x" });
    world.mount(button);
    world.mount(plain);
    world.flush();
    button.onPress!();
    plain.onPress!();
    assert.equal(presses, 11);
  });

  it("leaves the built-in without one when it was not passed, so the box does not take the press", async () => {
    const compiled = compile(`
interface PanelProps { onPress?: () => void }
export function Panel({ onPress }: PanelProps) {
  return <Flex onPress={onPress} />;
}`);
    assert.deepEqual(typeCheck(compiled), []);
    const { Panel } = await load<{ Panel: new (p: { onPress?: () => void }) => Flex & { updateProps(p: object): void } }>(compiled);
    const world = new World();
    const panel = new Panel({});
    world.mount(panel);
    world.flush();
    assert.equal(panel.onPress, undefined, "not passed: no handler");
    let presses = 0;
    panel.updateProps({ onPress: () => presses++ });
    world.flush();
    panel.onPress!();
    assert.equal(presses, 1, "passed later: the handler is the prop");
    panel.updateProps({ onPress: undefined });
    world.flush();
    assert.equal(panel.onPress, undefined, "taken away again: none");
  });
});

describe("a choice of callbacks", () => {
  it("gives a built-in the callback a condition chooses, or none, as the condition changes", async () => {
    const compiled = compile(`
export function Door() {
  const s = useMutable({ open: false, knocks: 0, mode: 0 });
  const knock = () => { s.knocks += 1; };
  return (
    <Flex onPress={s.open ? undefined : () => { s.knocks += 10; }}>
      <Flex onPress={s.mode === 0 ? null : s.mode === 1 ? knock : () => { s.mode = 0; }} />
      <Flex onDrag={s.open ? (x, y) => { s.knocks = x + y; } : undefined} />
    </Flex>
  );
}`);
    assert.deepEqual(typeCheck(compiled), []);
    type DoorState = { $s_knocks: number; $s_mode: number; $set_s_open(v: boolean): void; $set_s_mode(v: number): void };
    const { Door } = await load<{ Door: new () => Flex & DoorState }>(compiled);
    const world = new World();
    const door = new Door();
    world.mount(door);
    world.flush();
    const [bell, mat] = door.children as Flex[];
    assert.equal(bell!.onPress, undefined, "null is none");
    assert.equal(mat!.onDrag, undefined);
    door.onPress!();
    world.flush();
    assert.equal(door.$s_knocks, 10);
    door.$set_s_open(true);
    door.$set_s_mode(1);
    world.flush();
    assert.equal(door.onPress, undefined, "the branch taken is none: no handler");
    bell!.onPress!();
    world.flush();
    assert.equal(door.$s_knocks, 11, "a function of the component's, passed whole");
    mat!.onDrag!(3, 4);
    world.flush();
    assert.equal(door.$s_knocks, 7, "a built-in's callback parameters are typed");
    door.$set_s_mode(2);
    world.flush();
    bell!.onPress!();
    world.flush();
    assert.equal(door.$s_mode, 0, "nested choices");
  });

  it("calls a callback prop in a branch its test proves was passed: `onPress === undefined ? undefined : () => onPress()`", async () => {
    const compiled = compile(`
interface PanelProps { onPress?: () => void; onDrop?: (x: number, y: number) => void; label: string }
export function Panel({ onPress, onDrop, label }: PanelProps) {
  return (
    <Flex onPress={onPress === undefined ? undefined : () => onPress()}>
      <Flex onPress={!onPress ? undefined : () => onPress()} />
      <Flex onPress={onPress && onDrop ? () => { onPress(); onDrop(1, 2); } : undefined} />
      <Flex onDrag={onDrop != null ? (x, y) => onDrop(x, y) : undefined} />
      <Text>{label}</Text>
    </Flex>
  );
}`);
    assert.deepEqual(typeCheck(compiled), []);
    const { Panel } = await load<{ Panel: new (p: object) => Flex & { updateProps(p: object): void } }>(compiled);
    const world = new World();
    const panel = new Panel({ label: "x" });
    world.mount(panel);
    world.flush();
    const boxes = panel.children.filter((c): c is Flex => c instanceof Flex);
    assert.deepEqual([panel.onPress, ...boxes.map((b) => b.onPress ?? b.onDrag)], [undefined, undefined, undefined, undefined]);
    const calls: string[] = [];
    panel.updateProps({ label: "x", onPress: () => calls.push("press"), onDrop: (x: number, y: number) => calls.push(`drop ${x},${y}`) });
    world.flush();
    panel.onPress!();
    boxes[0]!.onPress!();
    boxes[1]!.onPress!();
    boxes[2]!.onDrag!(5, 6);
    assert.deepEqual(calls, ["press", "press", "press", "drop 1,2", "drop 5,6"]);
  });

  it("still fails the type-check for a call its test does not prove: `open ? () => onPress() : undefined`", () => {
    const compiled = compile(`
export function Panel({ onPress, open }: { onPress?: () => void; open: boolean }) {
  return <Flex onPress={open ? () => onPress() : undefined} />;
}`);
    assert.match(
      typeCheck(compiled)
        .map((d) => d.message)
        .join("\n"),
      /possibly 'undefined'/
    );
  });

  it("passes a component a choice of functions passed whole, and leaves other choices of values alone", async () => {
    const compiled = compile(`
interface RowProps { onGo?: (n: number) => void; size: number }
function Row({ onGo, size }: RowProps) { return <Flex width={size} onPress={() => onGo?.(size)} />; }
export function List({ onPick }: { onPick?: (n: number) => void }) {
  const s = useMutable({ open: false, picked: 0 });
  const pick = (n: number) => { s.picked = n; };
  return <Entity name="List"><Row onGo={s.open ? pick : onPick} size={s.open ? 2 : 1} /></Entity>;
}`);
    assert.deepEqual(typeCheck(compiled), []);
    const { List } = await load<{ List: new (p: object) => Entity & { $s_picked: number; $set_s_open(v: boolean): void } }>(compiled);
    const world = new World();
    const picked: number[] = [];
    const list = new List({ onPick: (n: number) => picked.push(n) });
    world.mount(list);
    world.flush();
    const row = (): Flex => list.children[0] as Flex;
    row().onPress!();
    list.$set_s_open(true);
    world.flush();
    row().onPress!();
    world.flush();
    assert.deepEqual([picked, list.$s_picked], [[1], 2]);
  });

  it("rejects a branch that is not a callback, and an arrow in a choice for a component", () => {
    assert.match(
      compileErrors(`function A({ open }: { open: boolean }) { return <Flex onPress={open ? 3 : undefined} />; }`)[0]!.message,
      /Each branch of 'onPress' must be a callback or none/
    );
    assert.match(
      compileErrors(`function Row({ onGo }: { onGo?: (n: number) => void }) { return <Flex onPress={() => onGo?.(1)} />; }
function A({ open }: { open: boolean }) { return <Row onGo={open ? (n) => {} : undefined} />; }`)[0]!.message,
      /declare the arrow in the component body/
    );
  });
});
