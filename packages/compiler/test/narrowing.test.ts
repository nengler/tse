import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
/**
 * What the source narrows, the generated code narrows too (Bramble finding 17, Hearth's `p.tower && …`): a callback made under a
 * condition reads state through `this`, a memo through a call, and a list's `&&` is a filter, none of which TypeScript narrows on
 * its own. The generated code says `$assume(condition)`, which narrows and checks nothing.
 */
import { after, describe, it } from "node:test";

import { Text, World, type Entity } from "@tsengine/runtime";

import { cleanOutput, closeCompiler, compile, load, typeCheck } from "./helpers.ts";

after(() => {
  closeCompiler();
  cleanOutput();
});

const repo = resolve(import.meta.dirname, "../../..");

/** Compile and type-check a project's `src/` with the command line; the generated files by name, and what it printed. */
function compileProject(files: Record<string, string>): { status: number | null; stderr: string; out: (name: string) => string } {
  mkdirSync(join(repo, ".test-output"), { recursive: true });
  const dir = mkdtempSync(join(repo, ".test-output", "narrow-"));
  mkdirSync(join(dir, "src"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
  const r = spawnSync(process.execPath, [resolve(repo, "packages/compiler/src/cli.ts"), join(dir, "src"), join(dir, "out")], {
    cwd: repo,
    encoding: "utf8",
  });
  const outputs = new Map<string, string>();
  for (const name of ["Settings.ts", "Pads.ts"]) {
    try {
      outputs.set(name, readFileSync(join(dir, "out", name), "utf8"));
    } catch {
      // not generated
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status, stderr: r.stderr, out: (name) => outputs.get(name) ?? "" };
}

const KEYS = `export function bind(action: string, key: string): void { void action; void key; }
export function pick(id: string): string | null { return id === "" ? null : id; }
`;
const PROMPT = `import { Entity } from "@tsengine/runtime/jsx";
interface PromptProps { onKey: (key: string) => void }
export function Prompt({ onKey }: PromptProps) {
  return <Entity name="Prompt" />;
}
`;

describe("narrowing in the generated code", () => {
  it("a memo under a condition it tests again does not assume that condition (tower-defense: TS2367 'no overlap')", () => {
    const r = compileProject({
      "Settings.tsx": `import { Entity, Text } from "@tsengine/runtime/jsx";
export function Settings(props: { kind: "aura" | "blast"; a: number; b: number; boss: { hp: number } | null }) {
  const x = props.kind === "aura" ? props.a : props.b;
  const hp = props.boss === null ? 0 : props.boss.hp;
  return (
    <Entity name="Settings">
      {props.kind === "blast" && <Text>{\`\${x - 6}\`}</Text>}
      {props.boss !== null && props.kind === "aura" && <Text>{\`\${hp} \${x}\`}</Text>}
    </Entity>
  );
}
`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.out("Settings.ts"), /\$assume\(\(?this\.props\.kind === "blast"/);
  });

  it("a callback under a condition reads state the condition narrowed (through a const, as TypeScript narrows only a const in a closure)", () => {
    const r = compileProject({
      "keys.ts": KEYS,
      "Prompt.tsx": PROMPT,
      "Settings.tsx": `import { Entity, useMutable } from "@tsengine/runtime/jsx";
import { Prompt } from "./Prompt.tsx";
import { bind } from "./keys.ts";
export function Settings() {
  const s = useMutable({ waiting: null as string | null });
  const waiting = s.waiting;
  return <Entity name="Settings">{waiting !== null && <Prompt onKey={(key) => bind(waiting, key)} />}</Entity>;
}
`,
    });
    assert.equal(r.status, 0, r.stderr);
    // The callback is a handler: it reads the field as it is when it runs, and the condition is assumed of that same read.
    assert.match(r.out("Settings.ts"), /\$assume\(\(?this\.#\$s_waitingNext !== null\)?\);\n\s+bind\(this\.#\$s_waitingNext, key\);/);
    assert.match(r.out("Settings.ts"), /function \$assume\(_condition: unknown\): asserts _condition \{\}/);
  });

  it("a callback under a condition on a memo reads the memo once, into a local the condition narrows", () => {
    const r = compileProject({
      "keys.ts": KEYS,
      "Prompt.tsx": PROMPT,
      "Settings.tsx": `import { Entity, useMutable } from "@tsengine/runtime/jsx";
import { Prompt } from "./Prompt.tsx";
import { bind, pick } from "./keys.ts";
export function Settings() {
  const s = useMutable({ id: "" });
  const waiting = pick(s.id);
  return <Entity name="Settings">{waiting !== null && <Prompt onKey={(key) => bind(waiting, key)} />}</Entity>;
}
`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(
      r.out("Settings.ts"),
      /const \$m0 = this\.\$memo\("waiting@live", .*\);\n\s+\$assume\(\(?\$m0 !== null\)?\);\n\s+bind\(\$m0, key\);/
    );
  });

  it("a list item under `&&` is narrowed by its condition, as the filter guarantees", () => {
    const r = compileProject({
      "Pads.tsx": `import { Entity } from "@tsengine/runtime/jsx";
interface TowerProps { level: number }
export function Tower({ level }: TowerProps) {
  return <Entity name={\`t\${level}\`} />;
}
interface Pad { id: string; tower: TowerProps | null }
interface PadsProps { pads: Pad[] }
export function Pads({ pads }: PadsProps) {
  return <Entity name="Pads">{pads.map((p) => p.tower && <Tower key={p.id} {...p.tower} />)}</Entity>;
}
`,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.out("Pads.ts"), /\$assume\(p\.tower\);/);
  });

  it("a const read from a list by index is tested before it is used, so it is one memo the test narrows (Jam Jar: TS2538)", () => {
    const compiled = compile(`const NAMES: Record<string, string> = { cherry: "Cherry" };
export function Offer({ offers, cursor }: { offers: readonly string[]; cursor: number }) {
  const offer = offers[cursor];
  const first = offers[0]?.length;
  return <Entity>
    {offer !== undefined && <Text>{NAMES[offer]}</Text>}
    {first !== undefined && <Text>{\`\${first + 1}\`}</Text>}
  </Entity>;
}`);
    assert.deepEqual(typeCheck(compiled), []);
  });

  it("a memo tested under an outer condition is read once there, so the test narrows what the branch passes on (Jam Jar's pool board)", async () => {
    const compiled = compile(`const NAMES: Record<string, string> = { cherry: "Cherry", grape: "Grape" };
function Tip({ kind }: { kind: string }) { return <Text>{NAMES[kind] ?? kind}</Text>; }
export function Board({ rows, at, open }: { rows: readonly { kind: string }[]; at: number; open: boolean }) {
  const looked = rows[at]?.kind ?? null;
  const row = rows[at];
  return <Entity>
    {open && <Flex>
      <Flex>{looked !== null && <Tip kind={looked} />}</Flex>
      {row !== undefined && <Text>{\`take out \${NAMES[row.kind]}\`}</Text>}
    </Flex>}
  </Entity>;
}`);
    assert.deepEqual(typeCheck(compiled), [], "no `?? fallback` is needed for the branch's `looked` or `row.kind`");
    type Props = { rows: readonly { kind: string }[]; at: number; open: boolean };
    const { Board } = await load<{ Board: new (p: Props) => Entity & { updateProps(p: Props): void } }>(compiled);
    const texts = (e: Entity): string[] => [...(e instanceof Text ? [e.text] : []), ...e.children.flatMap((c) => texts(c as Entity))];
    const rows = [{ kind: "cherry" }, { kind: "grape" }];
    const board = new Board({ rows, at: -1, open: true });
    const world = new World();
    world.mount(board);
    world.flush();
    assert.deepEqual(texts(board), []);
    board.updateProps({ rows, at: 1, open: true });
    world.flush();
    assert.deepEqual(texts(board), ["Grape", "take out Grape"]);
    board.updateProps({ rows, at: 1, open: false });
    world.flush();
    assert.deepEqual(texts(board), []);
  });

  it("checks nothing: a callback still runs when its condition no longer holds (a useUnmount telling the parent)", async () => {
    const { Host } = await load<{ Host: new (props: object) => any }>(
      compile(
        `
interface BadgeProps { onGone: () => void }
function Badge({ onGone }: BadgeProps) {
  useUnmount(() => onGone());
  return <Entity name="Badge" />;
}
interface HostProps { onLog: (line: string) => void }
function Host({ onLog }: HostProps) {
  const s = useMutable({ label: "a" as string | null });
  return <Entity name="Host">{s.label !== null && <Badge onGone={() => onLog(\`gone \${s.label}\`)} />}</Entity>;
}`,
        "Host.tsx"
      )
    );
    const log: string[] = [];
    const host = new Host({ onLog: (line: string) => log.push(line) });
    const world = new World();
    world.mount(host);
    world.flush();
    host.s.label = null;
    world.flush();
    assert.deepEqual(log, ["gone null"], "the callback ran, reading the state as it is now");
  });

  it("a const that tests a memo for null and then reads it reads the memo once, so the test narrows it (Jam Jar: TS2531)", () => {
    const r = compileProject({
      "lessons.ts": `export interface Lesson { target: "jar" | "shelf" }
export function lessonNow(step: number): Lesson | null { return step > 2 ? null : { target: "jar" }; }
export function boxOf(target: "jar" | "shelf" | null): number { return target === null ? 0 : target.length; }
`,
      "Settings.tsx": `import { Entity, Text, useMutable } from "@tsengine/runtime/jsx";
import { boxOf, lessonNow } from "./lessons.ts";
export function Settings(props: { busy: boolean }) {
  const s = useMutable({ step: 0 });
  const lesson = props.busy ? null : lessonNow(s.step);
  const lit = lesson !== null ? lesson.target : s.step > 5 ? "shelf" : null;
  const named = lesson !== null && lesson.target === "jar";
  return (
    <Entity name="Settings">
      <Text>{\`\${boxOf(lit)} \${named}\`}</Text>
    </Entity>
  );
}
`,
    });
    assert.equal(r.status, 0, r.stderr);
    // The memo is worked out once and handed to an arrow whose parameter the test narrows.
    assert.match(r.out("Settings.ts"), /\(\(\$n\d+\) => \(?\$n\d+ !== null\)? \? \$n\d+\.target : /);
    assert.match(r.out("Settings.ts"), /\(\(\$n\d+\) => \(?\$n\d+ !== null\)? && \(?\$n\d+\.target === "jar"/);
  });
});
