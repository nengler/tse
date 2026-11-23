import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
/**
 * A game's own function named like a runtime function (`textOf`, `getInputDevice`, `clamp`): the game's calls reach the game's,
 * and the calls the compiler writes itself (`textOf` around a `<Text>`'s text) or inlines from a hook (`useInputDevice` calls
 * `getInputDevice`) reach the runtime's, which the generated module imports as `$runtime_<name>`. A runtime function may also be
 * imported from the authoring module under another name (`textOf as runtimeText`).
 */
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { Entity, Text, World } from "@tsengine/runtime";

const repo = resolve(import.meta.dirname, "../../..");

function project(files: Record<string, string>): {
  dir: string;
  out: (name: string) => string;
  run: () => { status: number | null; stderr: string; stdout: string };
} {
  mkdirSync(join(repo, ".test-output"), { recursive: true });
  const dir = mkdtempSync(join(repo, ".test-output", "runtime-names-"));
  mkdirSync(join(dir, "src"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text);
  return {
    dir,
    out: (name) => readFileSync(join(dir, "out", name), "utf8"),
    run: () => {
      const r = spawnSync(process.execPath, [resolve(repo, "packages/compiler/src/cli.ts"), join(dir, "src"), join(dir, "out")], {
        cwd: repo,
        encoding: "utf8",
      });
      return { status: r.status, stderr: r.stderr, stdout: r.stdout };
    },
  };
}

/** The text of every `<Text>` under `root`, in order. */
function texts(root: Entity): string[] {
  const out: string[] = [];
  const visit = (o: Entity | Text): void => {
    if (o instanceof Text) out.push(o.text);
    for (const c of o.children) visit(c as Entity);
  };
  visit(root);
  return out;
}

const HELPERS = `export function textOf(kind: string, n: number): string {
  return \`\${kind} x\${n}\`;
}
export function clamp(word: string): string {
  return word.trim();
}
export function getInputDevice(name: string): string {
  return \`device \${name}\`;
}
`;

describe("a game's own function named like a runtime function", () => {
  it("is the one the game calls, and the text the compiler wraps still goes through the runtime's textOf", async () => {
    const p = project({
      "cards.ts": HELPERS,
      "Card.tsx": `import { Entity, Text, useMutable } from "@tsengine/runtime/jsx";
import { clamp, textOf } from "./cards.ts";

export function Card() {
  const s = useMutable({ n: 2 });
  return (
    <Entity name="Card">
      <Text>{textOf("pear", s.n)}</Text>
      <Text>{clamp(" plum ")}</Text>
      <Text>Count: {s.n}</Text>
    </Entity>
  );
}
`,
    });
    try {
      const r = p.run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const code = p.out("Card.ts");
      assert.match(code, /import \{[^}]*\btextOf as \$runtime_textOf\b[^}]*\} from "@tsengine\/runtime";/);
      assert.match(code, /import \{ clamp, textOf \} from "\.\.\/src\/cards\.ts";/);
      assert.match(code, /\$runtime_textOf\(textOf\("pear", this\.\$s_n\)\)/);
      assert.match(code, /\$runtime_textOf\(clamp\(" plum "\)\)/);
      const { Card } = (await import(pathToFileURL(join(p.dir, "out", "Card.ts")).href)) as { Card: new () => Entity };
      const world = new World();
      const card = new Card();
      world.mount(card);
      world.flush();
      assert.deepEqual(texts(card), ["pear x2", "plum", "Count: 2"]);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("does not take the calls an inlined hook makes: useInputDevice still asks the runtime's getInputDevice", () => {
    const p = project({
      "cards.ts": HELPERS,
      "Pad.tsx": `import { Entity, Text, useInputDevice } from "@tsengine/runtime/jsx";
import { getInputDevice } from "./cards.ts";

export function Pad() {
  const device = useInputDevice();
  return (
    <Entity name="Pad">
      <Text>{device} {getInputDevice("pad")}</Text>
    </Entity>
  );
}
`,
    });
    try {
      const r = p.run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const code = p.out("Pad.ts");
      assert.match(code, /import \{[^}]*\bgetInputDevice as \$runtime_getInputDevice\b[^}]*\} from "@tsengine\/runtime";/);
      assert.match(code, /import \{ getInputDevice \} from "\.\.\/src\/cards\.ts";/);
      assert.match(code, /ReturnType<typeof \$runtime_getInputDevice> = \$runtime_getInputDevice\(\);/);
      assert.match(code, /getInputDevice\("pad"\)/);
      assert.doesNotMatch(code, /[^_]getInputDevice\(\)/, "the hook's call is the runtime's");
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("is told apart from one the file declares itself, too", () => {
    const p = project({
      "Label.tsx": `import { Entity, Text } from "@tsengine/runtime/jsx";

function textOf(word: string, times: number): string {
  return word.repeat(times);
}

export function Label() {
  return (
    <Entity name="Label">
      <Text>{textOf("ab", 2)}</Text>
    </Entity>
  );
}
`,
    });
    try {
      const r = p.run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const code = p.out("Label.ts");
      assert.match(code, /textOf as \$runtime_textOf/);
      assert.match(code, /\$runtime_textOf\(textOf\("ab", 2\)\)/);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});

describe("a runtime function imported under another name", () => {
  it("is called by that name, in a component and in a top-level helper", async () => {
    const p = project({
      "Gauge.tsx": `import { Entity, Text, clamp as limit } from "@tsengine/runtime/jsx";

const half = (n: number): number => limit(n / 2, 0, 3);

export function Gauge() {
  return (
    <Entity name="Gauge">
      <Text>{limit(9, 0, 5)} {half(10)}</Text>
    </Entity>
  );
}
`,
    });
    try {
      const r = p.run();
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const code = p.out("Gauge.ts");
      assert.match(code, /\bclamp\(9, 0, 5\)/, "a component calls it by its own name");
      assert.match(code, /\bclamp as limit\b/, "the helper's name is imported for it");
      const { Gauge } = (await import(pathToFileURL(join(p.dir, "out", "Gauge.ts")).href)) as { Gauge: new () => Entity };
      const world = new World();
      const gauge = new Gauge();
      world.mount(gauge);
      world.flush();
      assert.deepEqual(texts(gauge), ["5 3"]);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });

  it("is only allowed for runtime functions: a hook or a built-in element keeps its name", () => {
    const p = project({
      "Bad.tsx": `import { Entity, useMutable as useState } from "@tsengine/runtime/jsx";

export function Bad() {
  const s = useState({ n: 0 });
  return <Entity name="Bad" x={s.n} />;
}
`,
    });
    try {
      const r = p.run();
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /Only a runtime function may be renamed[^\n]*import 'useMutable' as it is/);
    } finally {
      rmSync(p.dir, { recursive: true, force: true });
    }
  });
});
