# Compiler design

This document describes the architecture of the TSX → TypeScript game-object compiler and the runtime it targets, the
decisions taken, and the alternatives that were considered. It is the place to push back on a decision before more code is
built on top of it. The native player (libtse, its ABI, the hosts and their performance) is described in [PLAYER.md](PLAYER.md),
and `<Flex>` layout and the fixed game resolution in [LAYOUT.md](LAYOUT.md). A date after a heading is when that decision was
taken; the section describes the code as it is now.

## Ground rules and settled decisions

A change that breaks one of these rules is written up first (a section here, or in [PLAYER.md](PLAYER.md) for the player) and agreed before it is built. [PLAYER.md](PLAYER.md) adds the player's own rules: the runtime stays backend-free; `@tsengine/player` and `@tsengine/runtime` import nothing from Node; `tse.h` is the source of truth for the protocol; the C side does no maths.

- **Feel like ideal React.** A component is a function of state and props, hooks follow React's conventions, and imports, `key`, and callbacks-as-props look like React's. "Ideal" means React's model, not its accidents (stale closures, dependency arrays). A feature that makes authors learn an engine-specific API where a React one exists needs a design note first.
- **IR first.** Each feature starts as new variants in the `packages/compiler/src/ir/` files (`types.ts` re-exports them all). Code is generated only from IR, never from the AST.
- **Exhaustive unions.** Add the variant, then let `assertNever` failures show every place that must handle it. Never add a `default:` that silently passes.
- **No React, no virtual DOM, no signals, no ECS, no generic reconciler.** Updates stay direct: field assignments and queued add/remove on persistent instances.
- **Hooks are compiler intrinsics.** New hooks follow the `useMutable` rule: top-level statement in the component body, rejected anywhere else.
- **TypeScript 7.1 only through the two adapters.** Only `parser/parser.ts` and `typecheck/typecheck.ts` import `typescript/sync`. Verify any new API against the installed `.d.ts` before use.
- **Unsupported means a diagnostic.** Never silently drop syntax. Diagnostic codes in `diagnostics.ts` are append-only.
- **Generated code must type-check.** Every feature adds a test that runs generated output through `typeCheckFiles` and one that imports and runs it against the runtime.

Decisions, each still in force:

| Decision | Choice |
| --- | --- |
| Prop and list types: copy source type text into output, or query the TS 7.1 checker through the API | Copy source text for type-checking, plus a structured `PropTypeIR` (primitives, literal unions, arrays, function, source text) for the prefab schema. A type the compiler cannot describe is a code-only prop (`settable: false`), so the "revisit for prefab schemas" case did not arise and the checker is not queried (settled in M4a/M6) |
| Input model | Per-frame `useInput` hook with polled `InputState` for devices. Events that belong to an element are callback props on that element (`<Collider onCollisionEnter>`, `<Pointer onPress>`), lowered to `CallbackProp` with parameter types from the manifest's `intrinsicCallbacks`; no separate event-prop IR variant |
| Scene format | Support both: JSON scenes validated against the generated schema, and TSX scenes that compose prefabs |
| Hook names | Hooks start with `use`, as in React: `useUpdate`, `useInput` (were `onUpdate`, `onInput`; the old names report `TSE1102`). Collision handling is a prop on `<Collider onCollisionEnter={…}>`, replacing the `onCollisionEnter` hook (decided 2026-11-08, done in M4b) |
| State reads in handlers | `useMutable` (2026-11-14, replacing `useState` and React's snapshot): a handler sees a field as it was last written, this step included (the pending value), and so does a derived `const` read in a handler and the condition a callback is created under; render, and the props and context it hands down, see what the frame committed. Every handler sees the latest writes, in the order handlers run (tree order); render sees the frame's committed state. See "State: `useMutable`" |
| Global state | `createGameState(data, actions)` in `GameState.ts`, real code the game runs: the data a plain object, each action taking the state as its first argument and writing a draft of it directly, committed when the outermost action returns (only changed paths tell readers; unchanged objects keep their identity). Components read it with a selector that returns the value, `const hp = useGame((s) => s.player.hp)` (paths the compiler checks and subscribes to), read-only, and update it by calling an action from `useGame.actions()` in a handler. Per process, reset by the player. Decided 2026-11-09 as a Zustand store changed with `set`; that form was removed 2026-11-15. See "Global state" |
| Values that never render | A `useMutable` field the JSX does not read (`useRef` is `TSE1102`, 2026-11-14). No `ref={…}` on elements or components (`TSE1106`): what is on screen is driven by state and props (decided 2026-11-08) |
| Component forms | Arrow-function components and default exports/imports are allowed. A component may return a fragment (an implicit container) or a non-Entity root; a root may have JSX children only if its element type accepts children (decided 2026-11-08) |
| Lifecycle | `useMount(() => …)` and `useUnmount(() => …)`; no `useEffect` (decided 2026-11-08, confirmed 2026-11-12 with what replaces each of its uses: see "Why there is no `useEffect`") |
| Built-in elements | `<Game>` (the optional root carrying window, assets and game state; see "Game"), `<Text>`, `<Shape>`, `<Line>`, `<Camera>`, `<AnimatedSprite>`, `<Pointer>`, on top of `<Entity>`, `<Sprite>`, `<Collider>`. Each placed element is listed in the manifest's `transformIntrinsics` (decided 2026-11-08) |
| Camera target | A camera follows its children (`<Camera><Hero /></Camera>`) and is transparent to their transforms (`GameObject.childSpace()`); its own `x` and `y` are an offset from the followed point. Replaces the sketched `follow={hero}`, which needed element refs (removed in M3) (decided 2026-11-09, #21) |
| Mutating state in place | A `useMutable` field is written directly (`s.vx += 1`), each write going through its generated setter. Changing a list or an object in a field in place (`s.enemies.push(e)`, `s.enemies[i].hp -= 1`, `s.pos.x = 3`, a `for … of` over a field writing its items) is lowered to the copy the author would write: the field gets a new value, copying only what the path passes through, so `===` still finds every change. A result used as a value and an alias (`const e = s.enemies[i]; e.hp = 0`) are refused (`TSE1301` / `TSE1402`, with what to write instead); any other in-place write to something that is not a field or a `let` local is refused too. No dev-mode `Object.freeze`. See "State: `useMutable`" |
| Sound | A hook, not an element: `const playSound = useSound("hit.wav")`, then `playSound()` in handlers. Sounds have no position, so they take no `x` or `y`. Playing is an effect, not state, so it happens immediately rather than at the next render (decided 2026-11-08) |
| Authoring | Source files import hooks and intrinsics from a typed entry point and type-check in editors (decided 2026-11-08) |
| Transforms: a non-reactive `useTransform` handle written imperatively in handlers, or position as state written through a JSX attribute | Position is state, set with `x={…} y={…}` on any built-in element (decided 2026-11-08 as a `transform={{ x, y }}` attribute, written as props since 2026-11-17; every runtime object has a transform, and the manifest's `transformIntrinsics` lists which built-ins take the props). A component is placed by an `<Entity>` around it. Transforms nest: relative to the parent by default, `global` opts out. Authoring should feel as close to ideal React as possible; a per-frame move costs one render per tick, and dependency-scoped rendering is the optimisation if that ever matters |

## Pipeline

```
 .tsx source
     │  parser/      TypeScript 7.1 native parser (typescript/sync API)
     ▼
 TS AST  (remote-backed nodes, typescript/ast)
     │  analyzer/    find components, hook calls, JSX roots, tag usage
     ▼
 SourceAnalysis   (still points at AST nodes)
     │  transform/   lower expressions, classify children, assign identity
     ▼
 IRModule         (plain data, no AST references, JSON-serialisable)
     │  generator/   IR → TypeScript class source
     ▼
 generated .ts
     │  typecheck/   TypeScript 7.1 program over an in-memory FS layer
     ▼
 diagnostics
```

Each stage is a pure function of the previous stage's output. Only the parser
and type checker talk to the TypeScript process.

**Source maps** (`tse-compile --source-maps`, or `compile(name, text, { file, source })`): a version 3 map beside each
generated file. Each generated line maps to the start of the construct it was written for (the component, a hook, an element:
the IR's spans), not to the exact expression, so a stack trace through `node --enable-source-maps` names the right line of
the `.tsx`. Spans already point at the source as written, through the custom-hook inliner's `EditMap`.

**Errors in the source** (2026-11-12). Every `compile` returns the same line origins
(`origins`), with or without a map. The command line keeps them per generated file, and `mapToSource` moves each type error the
check of the generated code finds (`TSE9001`) to the source line of the construct its generated line was written for, keeping
where it was found: `src/Settings.tsx:9:28 - error TSE9001: TS2345: … (in the generated out/Settings.ts:44:59)`. A line written for
no construct (an import, the class header) keeps its generated position. And when a file fails to compile, the generated code is
not type-checked at all ("skipped type-checking the generated code"), as scenes are not validated: the other files would only
report its module as missing, or check against an old one.

**Errors while the game runs** (2026-11-12). Without a map, a thrown error reads `at Main.onInput (generated/Main.ts:71:7)`: a generated file and a
method the author never wrote. `compileArgs` (what `tse dev`, `build` and `check` compile with) passes `--source-maps`, and `tse dev`
runs the window, and `tse check` its tests, under `node --enable-source-maps`, so the same error reads
`at Main.onInput (src/Main.tsx:14:3)`, the line of the hook (the map is line-level: a generated line maps to the start of the construct
it was written for). The dev window's error screen shows the stack as Node formats it, so it is mapped too, and hot reload's
`?v=N` module URLs map (the `sourceMappingURL` is read relative to the module). The method name stays: it is the component's class
and the hook as the runtime calls it. Not mapped: a packaged game (esbuild's `game.js`) and the Rust host, which have no map to read.

## TypeScript 7.1 integration

TypeScript 7 is the native (Go) compiler. The npm package ships a JS client
that talks to a `tsc` child process over IPC; there is no in-process
`ts.createSourceFile` any more. What we use, all verified against
`typescript@7.1.0-beta` (the only 7.1 build on npm at the time of writing):

| Need | API |
| --- | --- |
| Start the compiler | `new API({ cwd })` from `typescript/sync` |
| Parse TSX | `api.createSourceFile(fileName, text, { scriptKind: ScriptKind.TSX })` → `RetainedSourceFile` (must be `dispose()`d) |
| Walk the AST | node `.forEachChild`, guards from `typescript/ast/is`, `SyntaxKind` from `typescript/ast` |
| Positions | `sourceFile.getLineAndCharacterOfPosition(pos)` |
| Type-check generated code | `api.createSnapshot({ fileSystem: createFileSystemLayer(files), createPrograms: [...] })` then `program.getSemanticDiagnostics()` |
| In-memory files | `createFileSystemLayer` from `typescript/fs`, layered over the real disk, so generated files can import the runtime package |

Limitations found while integrating:

* `RawCompilerOptions` takes **numeric enums** (`ScriptTarget.ES2022`,
  `ModuleKind.ESNext`, …), not the tsconfig strings. Passing strings panics the
  server process. We import the enums from `typescript/sync` / `typescript/ast`.
* The sync API spawns a process; creating one per file is wasteful, so the
  `Compiler` class owns a single `API` instance and must be `close()`d.
* We only use the AST for reading. We do not use `typescript/ast/factory`
  for code generation (see "Code generation" below).

## Authoring model

```tsx
import { useMutable, Entity, Sprite } from "@tsengine/runtime/jsx";
import { WarningIcon } from "./WarningIcon.tsx";

function Player() {
  const s = useMutable({ health: 100 });
  return (
    <Entity name="Player">
      <Sprite image={s.health > 50 ? "normal.png" : "hurt.png"} />
      {s.health < 25 && <WarningIcon />}
    </Entity>
  );
}
```

Rules (anything else is a compiler diagnostic, never silently
ignored):

* A component is a top-level `function` declaration or `const` arrow function
  with a capitalised name (optionally `export`ed, or the module's default
  export) whose body is hooks (`useMutable`, `useSound`, the handler hooks), derived values and statements (see "Statements in the
  component body"), and a `return`. An arrow with
  an expression body (`const Dot = () => <Sprite … />`) is its return. A derived `const` (`const hurt = health < 25;`) may read
  anything declared above it; it is inlined where it is used, so JSX that uses
  it updates with the state it reads, and a handler that uses it sees current
  state.
* The root is a built-in element or a fragment, never another component. It
  describes the component instance itself (the generated class extends that
  built-in), so its props are applied to `this`, and its children become
  children of `this`. A fragment `<>…</>` is an implicit container, a bare
  `Entity`. See "Roots and component forms".
* `useMutable` is a compiler intrinsic. It must be a top-level `const s = useMutable({ … })`
  of plain fields. Calls anywhere else, or a `use*` call that is not one of the hooks, are errors.
  A field's type is inferred from its initial literal (`number`/`string`/`boolean`, and objects and
  arrays of them) or a prop; an empty array or a record needs its type (`enemies: [] as EnemyData[]`,
  with `EnemyData` declared in the file) and is changed in place (`s.enemies.push(e)`, written as a new array) or replaced. See
  "Arrays and records".
* Children: elements, `{condition && <Element />}`,
  `{condition ? <A /> : <B />}` (a branch may be `null`; it lowers to two
  conditional children, on `condition` and `!condition`), or a keyed list
  `{items.map((item) => <Element key={item.id} … />)}` (see "Keyed lists").
  A fragment `<>…</>` may stand for an element anywhere here, as a child or as
  a branch (`{alive && <>…</>}`): it is an implicit `<Entity>` holding its
  children, so they come and go together (decided 2026-11-11). Text children
  go in a `<Text>` or a component that forwards them (see "Text"); spread props are in "Spread props".
* Imports: components from `./Name.tsx`, and hooks, built-in elements and
  `clamp` and the `Child` type from `@tsengine/runtime/jsx` (the manifest's
  `authoringModule`; the type is written `import { type Child }`, the one
  place `type` is accepted). Named imports only; any other import is
  `TSE1001`, and a name the entry point does not export, a `type` on a value,
  or a type imported as a value is `TSE1004`. The entry point is a set of declarations (calling
  one throws) typed from the runtime's own classes, with the `JSX` namespace in
  `@tsengine/runtime/jsx-runtime`, so the TSX itself type-checks: a project uses
  `"jsx": "react-jsx"` and `"jsxImportSource": "@tsengine/runtime"`
  (`packages/example/tsconfig.json`). `tse-compile` runs this check first
  (`TSE9002`; `--no-check` skips it). Imports are mandatory, as in React: a
  hook, built-in element or runtime function used without being imported is
  `TSE1005` (reported once per name per file, naming the import line to
  add). `Math` is a global and needs none.
* Position is state: `x={…} y={0} rotation={…}` on any built-in
  element (`<Entity>`, `<Sprite>`, `<Collider>`, `<Text>`, `<Shape>`, `<Camera>`,
  `<AnimatedSprite>`, `<Pointer>`; the root or a child),
  relative to its parent unless
  it sets `global`. A component is placed by an `<Entity x y>` around it. There is no transform hook. A value that never renders is a `useMutable`
  field. See "Transforms and sounds".
* Hooks: top-level `useInput((input) => ...)`, `useUpdate((dt) => ...)`,
  `useMount(() => ...)` and `useUnmount(() => ...)` statements; each may
  appear several times and runs in source order.
  `onUpdate` / `onInput` (renamed) and `onCollisionEnter` (now a prop on
  `<Collider>`) report `TSE1102` with where they went. See "Handlers" below.
* Element tags are runtime intrinsics (`Entity`, `Sprite`, `Collider`, `Text`,
  `Shape`, `Camera`, `AnimatedSprite`, `Pointer`; the list comes from the runtime manifest), components declared in the same file, or
  components imported from another `.tsx` file with
  `import { Name } from "./Name.tsx"` or `import Name from "./Name.tsx"` (the
  default export, under any local name; no namespace, `as` or `type` forms). A component takes props through a
  destructured parameter annotated with a props type declared in the same
  file, and a parent passes them as attributes; see "Props and callbacks".
* Expressions: number/string/boolean/null literals, state reads, unary
  `! - +`, binary arithmetic / comparison / logical, `?:`, parentheses, array
  and object literals (with spreads), member reads (`e.id`, `items.length`,
  `found?.hp`) and the non-mutating array methods. See "Arrays and records".

## State: `useMutable` (2026-11-14)

A component's state is `const s = useMutable({ hp: 3, foes: [] as Foe[] })`, written directly (`s.hp -= 1`,
`s.foes.push(f)`). There is no `useState` and no `useRef`: each is `TSE1102`, whose message writes out the conversion in the
author's names, once per hook. The codemod that converted whole files was removed (2026-11-17) once no code in the repository
used either hook.

**Why not React's snapshot.** React's state is a snapshot: a handler sees the value from the last render, and a setter's value
shows only after the next one. That suits UI, where a handler does one thing, and not a step function, which reads, changes and
re-reads the same values many times a frame. Under `useState` Kite's `Runner` copied eight values into locals at the top of
`useUpdate`, ran the step on the copies and called eight setters at the end, and that shape pushed game logic out of components
into plain `rules/` files. React keeps state immutable because it finds changes at run time by comparing values; this compiler
sees every write, as Svelte 5, Vue and Solid do, so state can be written directly. What makes code read like React is kept:
components and JSX, read-only props flowing down, render as a pure function of state and props, and hooks for lifecycle and
per-frame work. A handler that cannot read what it just wrote is one of React's accidents, not its model. A second hook beside
`useState` was rejected (an author who knows the engine would always pick the direct one), and so was keeping React's name for
it, since `setA(b); setB(a)` and `setX(x + 1)` twice would mean something React code does not expect.

**The rules.**

1. **A handler reads its own writes.** Each field is a state slot: it renders when it changes, it is saved, and hot reload and
   rewind keep it.
2. **One timing rule for all state: a handler sees every write at once; render sees what the frame committed.** Handlers run in
   tree order (depth first, a parent before its children, siblings in order; `useInput` across the whole tree, then `useUpdate`;
   `World.tick`, pinned by `packages/runtime/test/update-order.test.ts`), and each sees the writes of every handler before it.
   Then each changed component renders once. A derived `const` (plain, destructured, or a render block's names) read in a handler
   is worked out from the fields as they are now, under a memo of its own keyed on their pending values; in render it is worked
   out from the committed values.
3. **Props are read-only, and read live in handlers.** A child changes its parent's state through a callback prop; a write to a
   prop or to anything inside one is an error that names the callback form. A child's handler reads a prop as the parent has it
   now, through a getter the parent hands it (`GameObject.propGetters`, read as `this.$live_health`), so two towers firing at an
   enemy with 1 hp in the same step do not both fire: the second sees it dead. This holds for a plain child, a conditional one, a
   keyed list's items (found again by key in the live list), what is below a list item, an item that switches between two
   elements, and a context value. A callback prop is never live: it is created once (a choice of callbacks, see "A choice of callbacks", is made
   again on render). A getter whose condition no longer holds, or
   whose item's key is gone, says nothing, and the child's last props stand. Render reads what the frame committed. React keeps
   reads stale for UI reasons (a consistent screen, concurrent rendering) that a fixed-step game loop does not have; the price is
   that update order is visible, which is why it is defined and tested.
4. **Render stays pure.** No writes in the component body (`TSE1402`); a write belongs in a handler.

**Lists and objects changed in place are lowered to copies.** `s.list.push(x)` becomes `s.list = [...s.list, x]`, and
`s.list[i].hp -= 1` becomes `s.list.with(i, { ...item, hp })`, copying each level the path passes through and sharing the rest.
The mutating methods (`push`, `unshift`, `pop`, `shift`, `splice`, `sort`, `reverse`) become a spread, `slice`, `toSpliced`,
`toSorted` and `toReversed`; `=`, the compound operators, `++` and `--` through an index or a property become `with` and object
spreads. A `for (const foe of s.foes) { foe.hp -= 1; }` is lowered to a loop over the index (`lowerItemLoop`). Refused, each with
the form to write: a method's result used as a value, an index that is not plain, `?.` in a write, a write through another name
(`const e = s.list[0]; e.hp = 0`), and a loop over a copy (`s.foes.filter(…)`) that writes its items. Index writes need an array;
a record is replaced with a spread. Two alternatives were set aside. A version number on each slot cannot reach what the engine
compares item by item (a keyed list hands each child its item, and a child's props guard is `===`). Hidden write-tracking proxies
(Svelte 5's answer) cost a trap on every read in per-frame loops, cannot be copied by `structuredClone` (rewind would silently stop
snapshotting them), and show up as `Proxy {}` in the debugger. Copying keeps `===` true to what changed, costs nothing at run time
and keeps the committed value a snapshot. Its cost is a copy per write: a loop writing every item of a list is quadratic in its
length, fine for hundreds of items; a write that must be fast builds the list in a local (`const next = s.list.map(…)`) and
assigns it once.

**A helper cannot change a list field.** An array field is typed `MutableList<T>` (`packages/runtime/src/jsx.ts`): the forms the
compiler lowers type-check, but it is not assignable to `T[]`, so a helper in a plain `.ts` file that takes `Foe[]` is an error in
the editor. A helper takes `readonly Foe[]` to read, or returns the new list. Items are plain `T`, so a helper can still change an
item in place, which nothing reports; `Readonly<Foe>` on the field's type catches it.

**`s` as a whole.** A hook hands its state back as the object (`return s`), so `const counter = useCounter(2)` makes `counter` the
hook's fields. `s` passed whole in a handler (`takeHit(s)`) is the component's own object, made the first time and kept, whose
getters read the fields as the handler sees them and whose setters write through the fields' setters, so a helper's write renders;
after the component is unmounted a write through it does nothing and warns in development (`setDevelopmentWarnings`). In render
(`total(s)`, `<Camera shake={shake}>`) `s` is a copy of the committed fields, typed `Readonly<…>`. From outside, a compiled
component's `component.s.vx` reads the committed value and `component.s.vx = 1` writes through the setter, so tests and tools
write state as handlers do.

**No `useRef`.** A `useMutable` field nothing in render reads costs no redraw: a write to it does run `render()`, but a render writes only what differs, and its parts that set a built-in's
props are guarded by what they read. (A keyed list is not guarded: every render of its component goes through the list's items
again, comparing each one's props. With a field written every step, such as a clock, that is a pass over every list each step:
see NEXT_PRIORITIES.md, "Compiler and language".) So one hook covers both kinds of value. A field cannot be written in `useUnmount` (`TSE1402`); to tell the parent, call a
callback prop (`onGone?.()`). `ref={…}` on an element is `TSE1106`.

**Things to know.**

- TypeScript does not narrow a field inside a closure: `{s.waiting !== null && <Prompt onKey={() => bind(s.waiting)} />}` is a
  type error where `const waiting = s.waiting` above it is not. It is also a real hazard, since the callback runs later and the
  field may have changed. The guide teaches the `const`.
- A hook's own state is named after the hook (`body.x`, `body2` for a second call or a clash), which `t.state()`, saves, hot
  reload and the inspector show.

The game state follows the same direct form with one difference: only actions written in `GameState.ts` change it. See "Global
state (`createGameState`)".

## IR

Defined in `packages/compiler/src/ir/` (`types.ts` re-exports them). Highlights:

* Every union is discriminated by `kind`; consumers `switch` on it with an
  `assertNever` default, so adding a variant is a compile error everywhere it
  must be handled.
* IR is plain data. No AST nodes, so it can be serialised, snapshotted in tests
  and (later) cached or diffed for hot reload.
* `ExprIR` is a small expression tree. State reads are `StateRead { state:
  StateId }`, not identifiers: the generator decides how to access state
  (`this.health`), and dependency analysis is a tree walk, not a string scan.
* `StateId` and `ElementId` are branded strings so they cannot be mixed up with
  arbitrary names.
* Props are `StaticProp` (no dependencies, evaluated once), `DynamicProp`
  (carries its `dependencies`, re-evaluated on render) or, on a component
  element, `CallbackProp` (an inline function, created once). A dependency is
  a state slot of this component or one of its props
  (`{ kind: "State" | "Prop" }`), so JSX that reads a prop updates when the
  parent changes it, or, inside a keyed list, the list's item
  (`{ kind: "Item" }`).
* Children are `StaticChild` (instantiated once, never recreated),
  `ConditionalChild` (created/destroyed when `condition` flips),
  `KeyedListChild` (one instance per item, kept by key) or `ChildrenSlot`
  (where a parent's passed children mount).
* The root is a distinct `HostElementIR` (no field name, it *is* `this`), so
  "root element stored in a field" is unrepresentable.
* Each `ElementIR` has a stable `id` (structural path, e.g. `Player/1`) and a
  unique `fieldName`. The id is what future hot-reload / scene serialisation
  keys on; the field name is a codegen detail chosen once in the transform.
* `hooks: HookIR[]` lists hook declarations in source order; `state: StateIR[]`
  lists the persistent storage slots they create. They are separate because
  hook order matters while storage does not.
* The transform props (`x`, `y`, `z`, `rotation`, `scaleX`, `scaleY`, `global`, and `opacity` on most built-ins) are not
  in `props`: elements carry `transform: TransformPropIR[]`, the same static/dynamic props, written to the element's
  runtime `transform`. It is always empty on a component element.

### How future features slot in

| Feature | IR change |
| --- | --- |
| ~~`useUpdate`, `useInput`~~ | done: `OnUpdate` / `OnInput` hooks carrying a `FunctionIR` (IR kinds are named after the runtime methods they override); see "Handlers" |
| ~~event props (`<Collider onCollisionEnter={…}>`)~~ | done: the same `CallbackProp` a component receives, with parameter types from the runtime manifest; see "Roots and component forms" |
| ~~transforms~~ | done: `ElementIR.transform` / `HostElementIR.transform`; see "Transforms and sounds" |
| ~~props between components~~ | done: `ComponentIR.props: PropDeclIR[]` and `propsType`, `IRModule.typeDeclarations`, `ExprIR` `PropRead`, `CalleeIR` `Prop`, `PropIR` `CallbackProp`, `DependencyIR`; see "Props and callbacks" |
| ~~arrays and records in handlers (M5a)~~ | done: `TypeIR` `Array` / `SourceType` for state, `ExprIR` `ArrayLiteral`, `ObjectLiteral`, `MemberRead`, `Arrow`, `CalleeIR` `ArrayMethod`; see "Arrays and records" |
| ~~prefabs / scenes (M6)~~ | done: `ComponentIR.isExported`, a generated `prefabs` registry per module, project-level `prefabs.ts` / `prefabs.json`, scene validation (`TSE15xx`), `loadScene` in the runtime, a Tiled importer; see "Prefabs and scenes" |
| ~~children (M8)~~ | done: `ChildIR` `ChildrenSlot`, `ComponentIR.acceptsChildren`, `ElementIR.children` on a component element are the children passed to it; runtime `attachPassedChild` and friends; see "Children" |
| ~~keyed lists (M5b)~~ | done: `ChildIR` `KeyedListChild { source, item, index, key, element, dependencies }`, `DependencyIR` `Item`; runtime `(slot, order)` and `queueReorder`; see "Keyed lists" |
| ~~mount and unmount (M9)~~ | done: `OnMount` / `OnUnmount` hooks carrying a `FunctionIR`; see "Mount and unmount" |
| ~~built-in elements (M10–M14)~~ | none: `<Text>`, `<Shape>`, `<Camera>`, `<AnimatedSprite>` and `<Pointer>` are runtime classes plus manifest entries (`textContent`, `intrinsicLiterals`, `intrinsicHooks`, `intrinsicCallbacks`); see their sections |
| ~~`useSound` (M15)~~ | done: `ComponentIR.sounds: SoundIR[]` and a `PlaySound` statement; see "Transforms and sounds" |

## Handlers

`useInput` and `useUpdate` are hooks whose handlers are
lowered to a `FunctionIR { params, body: StatementIR[] }`. Statements exist
only inside functions.

**Statements** (`StatementIR`): `ExpressionStatement` (allowlisted calls),
`LocalConst` (`const`, or `let` with `mutable`, either with an optional type
annotation: `let best: Enemy | null = null`), `If` (an `else` holding only an
`if` is written `else if`), `ForOf` (`for (const e of enemies) { … }`; the
`const` may destructure, nested, `for (const [i, { id }] of xs.entries())`),
`Switch` (written as is, falling through as in JS, its cases sharing one
scope), `Block` (`{ … }`), `Break` (inside a `for…of` or `switch`) /
`Continue` (inside a `for…of`), of the same function, `Return`, and `SetState` (`{ state, value }`, for `s.x = value`).
Parameters are `ParamRead`, locals are `LocalRead`, state is `StateRead`.
`Assign` (`=`, `+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `||=`, `&&=`, `??=`) writes
a `let` local or a value the handler owns (see "Any expression in handlers"); a write to a `useMutable` field is a `SetState`, and
`n++` / `--n` as a statement is `+= 1` / `-= 1`. Position is not
assigned: it is state. `While` (`while`, and `do…while` with `doWhile`), `For` (C-style: `let` locals or
assignments, a test that may be left out, and assignments as the update) and `Try` / `Throw` are written as
they are (2026-11-13, see "Every loop, and `try`, in handlers"). A loop can run forever and hang a frame, as
in any JavaScript.

**Expressions** added: `ParamRead`, `LocalRead`, `PropertyRead`, `Call` and
`TemplateLiteral`. Which calls and in-place changes a handler may make is in "Any expression in handlers" below (the handle
methods, `input.pressed/down/released` and the like, are in `transform/handles.ts`). `var`, labelled jumps, `this`, `await` and
closures that escape (except an arrow handed to a function, see "A cleanup from `useMount`") are diagnostics
(`TSE1301`/`TSE1401`/`TSE1402`).

**Scoping**: component scope (state) → function scope (parameters) → block scope (`const`s). Shadowing follows JS: state is
emitted as a field of `this`, so a parameter or local of the same name cannot be confused with it. Only a redeclaration in the same
scope (the function body shares its parameters' scope, as in JS) or rebinding `Math`/`clamp` is `TSE1401`.

**Storage.** `const s = useMutable({ vx: 0 })` makes one state slot per field (id
`Hero.s.vx`, field `$s_vx`, pending `#$s_vxNext`, setter `$set_s_vx`), marked
`StateIR.mutable`. A write (`s.vx += 1`) is a `SetState` of the slot: the setter records the value in the pending field and calls
`markDirty()`, and `commitState()` (run by `runRender()` just before `render()`) copies pending into current, so any number of
writes in a frame cause one render, in the frame's render phase. A read in a
handler is a `live` `StateRead` of the pending value, so a handler reads its
own writes, and every other read (render, the props it hands children) is the
committed value. A derived `const` that reads a field is lowered again where a
handler reads it, from the live values, under a memo of its own (`d@live`,
keyed on the fields' pending values), so it is worked out once until a field
it reads is written. The class gets a getter named after the mutable (`s`, or `$s`
where the root has an `s`) with the committed values, for tests and tools.

**Generated code**: one override per hook kind. A single handler is inlined:

```ts
override onInput(input: InputState): void { if (input.pressed("Space")) { … } }   // from useInput
```

Several handlers of one kind become private methods called in source order, so
a `return;` in one cannot skip the others:

```ts
override onUpdate(dt: number): void { this.#onUpdate0(dt); this.#onUpdate1(dt); }
```

`SetState` emits a call to the field's setter, so dirty marking stays in the setter.

**Runtime frame** (`World.tick(dt, input = NO_INPUT)`): `onInput` → `onUpdate` (the methods `useInput` / `useUpdate` compile to)
→ render dirty objects → commit structure. Objects register on attach only if
they override a hook (compared against `GameObject.prototype`), and the visit
lists are snapshotted at the start of the tick, so objects attached during a
frame start receiving hooks next frame and detached ones are skipped.
`InputState` is a plain interface (`pressed`, `down`, `released`, `pointerX`,
`pointerY`); the mock builds it with `createInputState({ pressed: [...], … })`.

**Collisions**: the mock has no physics. A collision system calls
`world.reportCollision(a, b)` with two colliders; each collider's own
`onCollisionEnter` callback (the `<Collider onCollisionEnter>` prop) is called
with the other collider, if it is mounted in this world. Because it is the
collider's callback and not the component's, a component with several colliders
(a hitbox and a shield) knows which one was hit. `world.reportCollisionExit(a, b)`
is the same for `onCollisionExit`, when a pair stops touching. Dispatch only;
renders happen in the next `tick`. What a handler can read on `other` is
decided in "Collider callbacks" below.

**Presses**: like collisions, the mock has no input device. An input system calls
`world.reportPress(pointer, x, y)` with a world-space point; the pointer's own
`onPress` is called if the point is inside its area, and the call returns whether
it hit. Choosing which pointers to test, and in what order for overlaps, is the
input system's job.

Input model decision: a polled per-frame `useInput` hook,
not JSX event props. Element-level events are callback props on the element
(`<Collider onCollisionEnter>`, `<Pointer onPress>`).

### Every loop, and `try`, in handlers (2026-11-13)

Handlers allowed `for…of` only, so that a handler could not hang a frame. That rule was one of the subset's costs that pushed
the games' logic out of components, and a hung frame is a bug an author finds at once, as in any
JavaScript. So a handler takes `while`, `do…while`, C-style `for` (with several `let`s and a comma list of updates),
`try` / `catch` (with a name or none) / `finally`, and `throw`. `break` and `continue` work in every loop. Each is a statement
kind of its own (`While`, `For`, `Try`, `Throw`), lowered like the rest and written out as it was written. A `for` loop's `let`s
are scoped to the loop, as in JavaScript; its head may not call a setter. Labelled jumps stay out.

### Any expression in handlers (2026-11-13)

A handler's expressions were once an allowlist (a few `Math` functions, the array, string and number methods
that change nothing, handle methods), so a local list could not be pushed to, a `Map` could not be made, and `console.log` was an
error. In a handler:

- A value the handler made itself may be changed in place. A `const` or `let` local whose value is fresh (an array or object
  literal, `new`, a template literal, or what a call returns, except `find`, `findLast` and `at`, which hand back an item of their
  array) is *owned* (`owned` on its scope binding). Any method of it, or of a member or element of it, is called as written
  (`ValueMethod`), and assignments and `++` into it are `Assign` with a `Path` target. A `let` assigned a value that is not fresh
  (`best = enemy`) stops being owned from that statement on. A local that reads state or a prop (`const list = enemies`) is
  never owned, so state is changed only by its setter: the mutating array methods on it keep their message.
- `new` (`New` in the IR, with its type arguments as written) of `Map`, `Set`, `WeakMap`, `WeakSet`, `Array`, the `Error` types,
  or a class imported from a `.ts` file. Not in a component body (it would run on every render) and not `Date` (the clock).
- The standard library, as written: `Object`, `JSON`, `Number`, `Array`, `String`, `Math` and `console` functions, and
  `parseInt`, `parseFloat`, `isNaN`, `isFinite`. The constructors and namespaces can be named as values (`e instanceof Error`).
  `Math.random()` compiles with a warning: replays, tests and the parity between hosts depend on a run repeating.
- `typeof`, `instanceof` and `in`, anywhere.
- An arrow handed to one of these calls is a function that may return a value (`returns: "any"`): `list.sort((a, b) => a.hp - b.hp)`,
  `Array.from({ length: 2 }, () => [0, 0])`. With an expression body it is written as an arrow; with a block, as a callback.

What stays out: `this`, `await`, `var`, labelled jumps, and calls of unknown globals.

### Statements in the component body (2026-11-13)

A component body once held only hooks, derived `const`s and a `return`; a `let`, a loop or a list built up was
`TSE1101`, so every list a screen drew was made by the rules (Bramble's `rules/view.ts`). A run of body statements that are
not hooks, and not all `const name = …`, is a **render block** (`RenderBlockAnalysis` in the analyzer):

- The analyzer groups consecutive non-hook statements; a run of only derived `const`s keeps each as its own derived value. A run with a hook call inside it (`if (open) { useUpdate(…) }`) is not a block: the hook is reported as not at the
  top level, and nothing else.
- The block is lowered like a handler (`lowerRenderBlock`, in a scope of its own, with `inRenderBlock` set), so loops, owned
  values, `new` and the standard library work, and then `return { a, b }` of the names it declares at its top level is added.
  Its value is `Memo(Block(fn))`: `this.$memo("$block1", [deps], () => (() => { … })())`, the deps being every state, prop and
  game-state path the block reads, so it runs again only when one of them changes (as a derived `const` that calls something).
  Each declared name is a derived value reading its member of the memo.
- It runs during render, so a setter, a sound or an action called in it is `TSE1101` ("it runs on every render"), and a `return` in it is
  refused: a component returns once, at its end.
- Declarations in it are `const` or `let` with one name each, for now; destructuring is refused with a message.

`var` stays out, and a `while (true)` in a block hangs the render as it would in React.

## Mount and unmount

`useMount(() => …)` and `useUnmount(() => …)` (M9) are handler hooks like
`useUpdate`, lowered to a `FunctionIR` with no parameters (`OnMountHookIR`,
`OnUnmountHookIR`; the overrides are `onMount()` and `onUnmount()`). There is
no `useEffect`: reacting to a state change is done where the state changes
(see "Why there is no `useEffect`"). `useMount` may return a cleanup; see "A
cleanup from `useMount`" below.

```tsx
function Banner({ text, onDone }: BannerProps) {
  const s = useMutable({ shown: false });
  useMount(() => { s.shown = true; });   // once, when it joins the world
  useUnmount(() => onDone?.());          // once, when it leaves
  return <Sprite image={s.shown ? `banner-${text}.png` : "banner-hidden.png"} />;
}
```

**When.** A component mounts when it is attached to a `World` (`World.mount`,
a parent's `addChild`, or a queued add committing: a condition turning on, a
list item added, children passed to a component) and unmounts when it is
detached (a condition turning off, an item removed, an enclosing component
leaving). Constructing an object does not mount it, so a component never put
in a world runs neither. Its first render has already committed, since the
constructor runs it. Each hook runs once per stay in a world.

**Order.** For a subtree, mounting is children first (a parent's `useMount`
sees its children mounted) and unmounting is parent first (the parent's
`useUnmount` runs while its children are still attached). Each object is still
in its world when its own hook runs.

**State.** `useMount` may set state: the setter schedules a render, which runs
in the same `World.flush()` that mounted it. `useUnmount` may not (`TSE1402`):
the component is going away, so the update could never render. It may read
state and call callback props, which is how the parent finds out
(`onDone?.()`). A callback created for a list item can still read its item
there (see "Keyed lists").

**Rules.** Top-level only, imported from the authoring module (`TSE1005`),
one arrow function with no parameters (`TSE1401`), several of a kind allowed
and run in source order.

### A cleanup from `useMount` (2026-11-12)

What a `useMount` handler returns is its cleanup, as with a React effect: a function, kept and called once when the component
leaves its world, after its `useUnmount` handlers; anything else is ignored. With it, subscribing to something outside the
game state (`settings`, `controls`) needs no mirror in a module:

```tsx
useMount(() => settings.subscribe(() => { s.volume = settings.get().music; }));   // the call's result is the cleanup
useMount(() => {
  const stop = controls.subscribe(() => { s.keys = controls.toJSON(); });
  return () => { stop(); };                                                        // or return an arrow
});
```

**Lowering.** `useMount`'s function is lowered with `returns: "cleanup"` (`FunctionOptions`): `return;` and `return value;` are
both allowed, a returned arrow is a `Callback`, and an expression body that is a call (an `ExpressionStatement`) becomes
`return call;`, as React's `() => store.subscribe(…)`. A setter, an action or a sound played in an expression body stays a
statement. Every other handler keeps `returns: "void"`, so `return value;` in `useUpdate` or `useUnmount` is still `TSE1401`.

**Callbacks as values.** The subscription needs an arrow handed to a function, although "closures that escape" are otherwise a
diagnostic. In a handler, an arrow passed to a plain function, a method of
an imported object, a callback prop or a local holding a function is a `CallbackIR` (`{ kind: "Callback", fn: FunctionIR }`):
a handler of its own, lowered like a callback prop (contextual parameters, handler statements, state set through `this`). It
may run later, after the component has left; a setter called then marks a detached object, which never renders, so nothing
breaks, but the cleanup is how to stop it. Outside handlers an arrow is only a callback prop or an array method's
argument. A handler's own local may be called (`stop()`, callee `Local`); the type-check checks it is a function.
`walkExpr` walks a callback's statements, so whatever looks for reads and calls in a handler sees inside it.

**Generated code.** A `useMount` whose statements return a value is a method of its own, typed `(() => void) | void`, and
`onMount` passes its result to `keepCleanup`:

```ts
override onMount(): void {
  this.keepCleanup(this.#onMount0());
  this.#onMount1();
}
#onMount0(): (() => void) | void {
  return settings.subscribe(() => { this.$set_s_volume(settings.get().music); });
}
```

A `useMount` that returns nothing is written like any other handler (inlined when it is the only one).

**Runtime.** `GameObject.keepCleanup(value)` keeps a function in a private list; `detachFromWorld` calls `onUnmount`, then each
kept cleanup once in the order kept, and clears the list, before it detaches the children. So a component's cleanups run before
its children's, and a second stay in a world keeps its own. A hot reload removes the old root, so its cleanups run and the new
tree subscribes again. `keepCleanup` is a reserved member name.

Bramble's settings screen is the first user: it subscribes to `settings` in `useMount` and keeps what it shows as its own state,
which replaced the module-level `settings.subscribe` that mirrored the settings into `useGame`.

### `useStore` (2026-11-13)

`const values = useStore(settings, settingsView)` is React's `useSyncExternalStore`: a value read from a store outside the game
state, read at mount and again on each notification, rendering only when the data read differs. (It is first read when the component
is made, for its first render, and since 2026-11-20 again when it mounts: the player builds the first screen and then reads the
settings' file, and a title screen showing a setting had missed that change, having not yet subscribed.) Bramble's settings screen wrote it
out by hand (two state fields and a `useMount` that subscribed and set both), which is what it replaces.

- It is a shipped hook (`hooks/library.ts`), written from `useMutable({ value: read() })` and a `useMount` that returns the
  subscription as its cleanup, so it costs nothing new in the compiler. Its type comes from the initial value:
  `ReturnType<typeof settingsView>`.
- Each notification writes `s.value = keepIfEqual(s.value, read())` (`runtime/src/equal.ts`): the setter renders when it is given a different object,
  and a read usually builds a new one, so data equal all the way down (`sameData`) keeps the old value.
- For it to work as a function, the inliner writes an argument that names an import of the calling file in place of its
  parameter, as it does for literals: `store.subscribe(…)` becomes `settings.subscribe(…)`, a method of an imported object, and
  `read()` becomes `settingsView()`, a plain function call, both of which a handler may make. Imports are module constants, so
  nothing is evaluated a different number of times.
- `read` takes no arguments; the store is anything with `subscribe(listener): () => void` (`Subscribable` in the authoring module).

### Drags and the device in use (2026-11-20)

Jam Jar's shelf is reordered by dragging, on a phone as well as with a mouse, and its prompts must not name keys to someone
holding a phone. Both were built in the game from raw input (`input.down("MouseLeft")`, `input.pointerX`, `input.lastPressed()`)
and both are what any other game would write again, so they moved here.

- **`onDragStart`, `onDrag`, `onDragEnd`** are props of every pressable (`<Flex>`, `<Pointer>` and the widgets), each told the
  pointer's place in the pressable's layer. The player already kept the pressable a press began on (`World.pressed`) and told a
  slider where the mouse was each step; that internal call is now `onHeldAt`, and the public `onDrag` is called only when the pointer
  has moved, so a handler that sets state does not render every step of a still hold. `onDragEnd` is called before the release is
  reported. A `<Flex>` with only drag handlers takes the press, as one with `onPress` does. A pressable that leaves the tree while
  held hears no more: a list that is re-keyed as it is reordered should put the handlers on the box around the items, not on an item.
- There is no drop target, payload or ghost, as the DOM's drag and drop has: a game draws what is dragged where it likes and
  works out what is under it from the point. That is the part that differs between games.
- **`useInputDevice()`** returns `"keyboard"`, `"pointer"` or `"gamepad"`: the device of the last press (`World.tick` reads the
  step's first press, whoever in the tree hears it, an inert screen included). A mouse and a finger are one device on purpose: the
  hosts report a touch as `MouseLeft`, and a game that treats them alike works on both without thinking about it. The value lives
  in the runtime module, not in a world or a component, so a screen mounted after the press starts with the right wording; the
  hook is a `useMutable` and a `useMount` that subscribes (`watchInputDevice`), like `useStore`. It starts as `"pointer"` and each
  player resets it. For the hook, an engine function may now be handed an arrow in a handler, as an imported function already could.
- **`onPressOutside`** (the same day) is a prop of every pressable: a press landed on nothing, or on a pressable that is not this
  one or inside it. Jam Jar's cards show a tooltip when tapped, and a tap anywhere else has to put it away; the game had flagged
  every card's `onPress` and compared the flag with the raw click in its update. `World.reportPressOutside(target)` walks the
  mounted pressables once a press (clicks are rare), and "inside" is by the tree, not by the box: the box around a row of cards
  takes the handler, a tap on a card is inside it, and a tap in the gap between two cards lands on nothing and is outside. It is
  called after the target's own `onPress`.
- **`useWindowSize()`** (2026-11-20) returns the window's `{ width, height }` in logical pixels. Jam Jar is laid out at 640 × 360,
  and on a phone held upright it was a small strip with bars above and below; it wanted to ask for the phone to be turned, and
  only the player knew the window's shape (`FrameBuilder.build` fits the `<Screen>` into it). The size lives in the runtime
  module (`window.ts`), as the input device does: the player sets it when it opens the window and at the start of every frame,
  before anything steps, and the hook is a `useMutable` and a `useMount` that subscribes (`watchWindowSize`). It is the window,
  not the game's resolution, so a game can choose a layout from it without the `<Screen>` changing under it.

### `playGame`: a test that waits for the game (2026-11-20)

`runScript` plays a whole script and hands back what was seen at each frame, so a test waits by counting: `Space, _*330`. Jam Jar's
tests broke twice in a day for nothing but that count, when the jar was made to settle further and when a turn stopped ending
at a pick. `playGame(config, { bindings })` (`player/src/harness.ts`) is the same headless player a piece at a time:
`input(script)` runs a script, `stepUntil(done)` steps with nothing pressed until `done()` is true (throwing after `maxSteps`),
and the test reads the game between them. `Rendered.stepUntil` already did this for one component; this is it for a game.

### Four things Jam Jar's tutorial ran into (2026-11-20)

- **`typeof this.x` after an optional chain.** A changing prop of a built-in was written to a local typed
  `(typeof this.text8)["text"]`. TypeScript 7.1 (beta) reports "Cannot find name 'this'" for such a type once an optional chain
  has been a condition anywhere earlier in the method: `if (r?.target === "x") {}` and then `const a: (typeof this.t)["text"]`
  is the whole reproduction. So `{lesson?.target === "jar" && <Spotlight />}` above any element with a changing prop broke
  `render()`, with an error pointing at the other element. The local is now typed through the built-in's class
  (`Text["text"]`), which needs no `this` and no narrowing.
- **A null check on a derived value, carried into a child's props.** `{lesson !== null && open && <Coach lesson={lesson} />}`
  with `lesson` a memo: the child's prop getter tested the memo and returned the memo, two calls TypeScript cannot narrow
  between. The getter now reads each memo its conditions read once into a local, as a callback made under a condition already
  did (`callback`), and tests and returns the local.
- **`click@Play` in an input script.** A script named a point, which was wrong the day a button moved, and wrong silently: a
  screenshot of the title when the run was wanted. A label is looked up when its frame comes up (`Player.pointOf`: the middle of
  the topmost pressable holding a `<Text>` of exactly that text, through the view it was drawn with), by the backends that
  feed scripted frames (`aimFrame`), since only then is it known what is on screen. A label that is not there throws.
- **`tse screenshot --gpu`'s error** now names the packages the desktop build needs on Debian and Ubuntu; it is how a shader is
  looked at, and it said only that the build was missing.

Not changed: a box in a row or column can already be moved without moving its neighbours, by its own `x` and `y` (LAYOUT.md,
"A child's own `x`, `y`, `rotation` and scale move it within its slot"). The game had animated a whole column for want of knowing it.

## Why there is no `useEffect` (2026-11-12)

`useEffect` is the first hook a React author reaches for, and it stays out on purpose; each of its uses has a replacement,
listed below. The question came up again on 2026-11-12, after a review of what trips new authors. It could be built: the
compiler knows what every expression reads, so it could even work out the dependencies itself. The worry is that it would be
used for everything, including what it should not be used for.

**What it would give.** It is familiar, and a few needs have no good answer without something like it: subscribing to
something outside the game state *with a cleanup* (Bramble mirrors `settings` into `useGame` at module level because
`useMount` returns nothing), and a reusable component reacting to a prop changing (a `<HealthBar hp>` that flashes when `hp`
drops, where the rules' events cannot help because the component does not know the game).

**What it would cost, here more than in React.**

- A frame late, per link: an effect runs after the render that saw the change; a setter it calls renders next frame,
  and an effect that triggers another adds a frame each. Kite's first version, which compared counters to play
  sounds, was "one step late" for exactly this reason.
- The patterns React's own docs warn against become the easy path: state copied from other state (here a derived
  `const` already does it), chains of effects that set state, and "when X changes, do Y" where Y belongs where X was changed.
- Game logic leaves the rules. Both games found that the rules as plain functions returning events, answered by
  effect stores, was the shape that worked: headless tests, replays, the same output under V8 and QuickJS. An effect is
  game logic that runs only in the component tree, at a moment set by renders.
- It cannot be taken back. Once games depend on it, removing it is a migration.

**What to write instead.** Each answer covers one legitimate use and no more:

| The need | Instead of `useEffect` | Status |
| --- | --- | --- |
| A sound, a burst or a shake when something happens | Do it where it happens: the rules return events and an action answers them through effect stores (`createSounds`, `createParticles`, `createShake`; see "Effects that happen at a moment"). This is React's own advice: do it in the handler that caused the change. | Built |
| A value computed from state or props | A derived `const`, worked out again when what it reads changes. | Built |
| Something on screen that follows state (music, an emitter, the camera) | A built-in driven by props: `<Music>`, `<Particles emitting>`, `<Camera bounds>`. A wish for an effect here means a built-in is missing. | Built; add built-ins as games ask |
| Run something when the component comes or goes | `useMount` / `useUnmount`. | Built |
| Subscribe to something outside the game state, and stop | A cleanup returned from `useMount` (`useMount(() => settings.subscribe(…))`), with a handler able to hand an arrow to a function. See "A cleanup from `useMount`". `useStore(settings, read)` (as React's `useSyncExternalStore`) does both for a value to show; see "`useStore`". | Built (2026-11-12; `useStore` 2026-11-13) |
| Start a component's state over when what it shows changes | `key` on any element, not only on a list's items (`<Dialogue key={talk.id} />`), React's own answer. See "Keyed elements". | Built (2026-11-12) |
| A reusable component reacting to a prop changing | Only if a game hits it: `useChange(value, (prev) => …)`, run in the same step as the change (no frame of lag), with no cleanup, and allowed only to call effect stores, sounds and `freeze` and to write the component's own state. Calling a game-state action in it is a diagnostic, so effects cannot chain through the store. | Not built; waits for a game |

**The diagnostic.** `useEffect` and `useLayoutEffect` are `TSE1102` with a message that names these answers (`REMOVED_HOOKS`
in `analyzer/model.ts`), not a bare "Unknown hook".

## Arrays and records

State can hold an array or a record (M5a), so a component can keep a list of
things and change it from handlers:

```tsx
interface EnemyData { id: string; hp: number }

function Swarm() {
  const s = useMutable({ enemies: [] as EnemyData[] });
  useUpdate((dt) => {
    s.enemies = s.enemies.map((e) => ({ ...e, hp: e.hp - dt })).filter((e) => e.hp > 0);
  });
  return <Entity><Sprite image={s.enemies.length > 3 ? "busy.png" : "calm.png"} /></Entity>;
}
```

**State types.** `StateIR.type` is a `TypeIR`: a `Primitive`, an `Array` of
an element type, or a `SourceType { text }` (a type written in the file:
`EnemyData`, `Item | null`), copied into the generated code as written, next
to the file's copied type declarations, so the type-check resolves it. A
primitive is inferred from the initial value; a field initialised from a prop
takes the prop's type; an empty array or a record needs its type
(`enemies: [] as EnemyData[]`; an empty array with none is `TSE1104`, as `[]`
alone would be `never[]` in TypeScript). An array field is typed `MutableList<T>`
in the authoring module (see "State: `useMutable`").

**Expressions.**

| Source | IR |
| --- | --- |
| `[a, ...rest]` | `ArrayLiteral { elements: { spread, value }[] }` |
| `{ id, hp: 2, ...e }` | `ObjectLiteral { properties: (Property \| Spread)[] }`; no methods, getters or computed names |
| `e.id`, `items.length`, `found?.hp` | `MemberRead { object, name, optional }` |
| `items.filter((e) => e.hp > 0)` | `Call` with `CalleeIR` `ArrayMethod { receiver, name }`; the callback is an `Arrow { params, body }` |

`MemberRead` is a member of any value: the compiler does not know the value's
type, and the type-check of the generated code (or of the source) validates
it. Members of a number or boolean parameter or state are still rejected
early. Members of a runtime handle parameter (`input.pointerX`) remain
`PropertyRead`, checked against the manifest.

**Array methods** (`ARRAY_METHODS` in `ir/expressions.ts`): `filter`, `map`,
`flatMap`, `some`, `every`, `find`, `findIndex` (each takes a callback), `includes`,
`indexOf`, `slice`, `concat`, `join` and the rest of the table. None changes its receiver. A mutating method
(`push`, `splice`, `sort`, …) on a `useMutable` field is lowered to a copy (see "State: `useMutable`"), and on a value a
handler made itself it is called as written ("Any expression in handlers"); anywhere else it is `TSE1301`, with the form to write.
A callback is an arrow consumed synchronously by the method, so it never escapes. Its parameters are `Contextual`: the array's
element type provides them, so `(e) => e.hp > 0` needs no annotation.

**Dependencies.** A JSX value that reads an array, including inside a
callback (`items.some((e) => e.hp < 1)`), depends on that state, so it
re-renders when the array changes.

**New values, not changed ones.** A setter renders only when it gets a new value (the `===` check in the generated setter), which
is why a write inside a field is lowered to a copy rather than made in place: `s.items = s.items` renders nothing, and
`s.items = [...s.items]` or `s.items.push(x)` renders. An arrow whose body is an object literal is parenthesised in the
generated code.

## Keyed lists

`{items.map((item) => <Element key={…} … />)}` keeps one instance of the
element per item of an array, by key (M5b):

```tsx
const s = useMutable({ enemies: [] as EnemyData[] });
return (
  <Entity name="Pack">
    <Sprite image="bg.png" />
    {s.enemies.map((e) => <Enemy key={e.id} speed={e.speed} onDefeated={() => remove(e.id)} />)}
    <Sprite image="fg.png" />
  </Entity>
);
```

**Rules** (each `TSE1209` otherwise):

* The source is a state or prop array, optionally followed by
  `.filter((e) => …)` (a derived `const` that inlines to one counts).
  (Since 2026-11-12, any array: see "Computed lists, and conditions inside
  list items".)
* `map` takes one inline arrow with the item and optionally the index as
  plain names, returning exactly one element: an expression body, or a block
  holding only `return <Element … />`. No conditionals, fragments or children
  inside it; a richer item is a component. (Conditions and children came
  later: see the sections below.)
* The element has a `key` that reads the item. A key that reads only the
  index compiles with a warning (instances then follow positions, not
  identities); a key that reads neither is an error, since every item would
  share it. `key` anywhere else is `TSE1203`.
* A callback prop on the item may read the item but not the index, which
  changes when items move.

**IR.** `KeyedListChild { source, item, index, key, element, dependencies }`.
`item` and `index` are `ParamIR`s with `Contextual` types (the array gives
them), read as `ParamRead`, so `e.speed` is a `MemberRead` the type-check
validates. The element's props and transform fields that read the item or
index are `DynamicProp`s with an `Item` dependency; `dependencies` are what
`source` reads. The element's `fieldName` names the list's fields.

**Generated code.** Fields `enemyItems: Map<string | number, Enemy>` (public,
by key) and `#enemyOrder` (the key order of the last render), plus
`#enemyRecords` (a `{ current }` holder per key, the key's current item) when
a callback reads the item.
`render()` handles the list in its own block, with `$`-prefixed temporaries
(author names may not start with `$`):

```ts
{
  const $parent = this;
  const $list = this.enemies;
  const $keys = $list.map((e) => e.id);
  const $seen = new Set<string | number>();
  for (const $key of $keys) {                       // 1. every key first: a duplicate throws before anything changes
    if ($seen.has($key)) throw new Error("Duplicate key " + JSON.stringify($key) + " in the <Enemy> list of Pack.");
    $seen.add($key);
  }
  for (const [$n, e] of $list.entries()) {
    const $key = $keys[$n]!;
    let $item = this.enemyItems.get($key);
    if ($item === undefined) {                      // 2. a new key: construct, queue at (slot, position)
      const $rec = { current: e };
      $item = new Enemy({ speed: e.speed, onDefeated: () => { this.remove($rec.current.id); } });
      this.enemyItems.set($key, $item);
      this.#enemyRecords.set($key, $rec);
      $parent.queueAddChild($item, 1, $n);
    } else {                                        // 3. an existing key: update in place
      this.#enemyRecords.get($key)!.current = e;
      $item.updateProps({ speed: e.speed });
    }
  }
  for (const [$key, $item] of this.enemyItems) {    // 4. keys that are gone
    if (!$seen.has($key)) { $parent.queueRemoveChild($item); this.enemyItems.delete($key); this.#enemyRecords.delete($key); }
  }
  if ($keys.length !== this.#enemyOrder.length || $keys.some(($k, $i) => $k !== this.#enemyOrder[$i])) {
    $parent.queueReorder(1, $keys.map(($k) => this.enemyItems.get($k)!));   // 5. only if the key sequence changed
    this.#enemyOrder = $keys;
  }
}
```

* An existing item gets `updateProps` with its
  dynamic props; `applyProps` compares with `===`, so an item whose values did
  not change is not marked dirty and does not render.
* Callbacks see the current item. A callback prop is created once, with
  the item's first value. Inside it, item reads go through a `{ current }`
  holder (`$rec.current`) that every render refreshes, so after a write
  replaces a record under the same key the callback reads the new one. The callback keeps its holder after
  the item is removed, so `useUnmount` can still call it (it runs when the
  removal commits, after the render that dropped the key).
* In a conditional subtree, the list's fields are emptied when the subtree
  unmounts, so it is built afresh when it mounts again.
* New values are what make the list re-render; a write inside a field is
  lowered to one (see "Arrays and records").

### Conditionals inside the map (2026-11-11)

The callback may return `cond && <El key … />`, `cond ? <El key … /> : null`, or `cond ? <A key={k} … /> : <B key={k} … />`:

```tsx
{pads.map((p) => (p.tower ? <Tower key={p.id} {...p.tower} id={p.id} /> : <EmptyPad key={p.id} {...p} />))}
{shots.map((s) => s.live && <Shot key={s.id} {...s} />)}
```

`KeyedListChildIR` has `condition` and `alternate`. With no `alternate` the list is the source filtered by the condition
(`source.filter((s) => s.live)`): an item whose condition is false has no instance. With one, the item's instance is `element` while the
condition is true and `alternate` while it is false, and **both branches need the same `key` expression** (otherwise `TSE1209`). The
items map holds the union of the two classes, and a `#<field>Branches` map remembers which each key was built as. On render, a key whose
branch flipped queues removal of the old instance and adds the new one at the same `(slot, position)`, with the item's current props; the
reorder that follows uses the new instance. The branches in the generated code test the condition itself, not a stored flag, so that
TypeScript narrows what it reads (`p.tower ? new Tower({ …p.tower })`). A fragment cannot be a branch, and the index parameter cannot
be used when the items are conditional (it would count the items left out). The `&&` form is a filter, which TypeScript does not narrow
through; the generated loop narrows the item with `$assume` (see "Narrowing in the generated code"), so `p.tower && <Tower {...p.tower} />`
type-checks.

### Narrowing in the generated code (2026-11-12)

What TypeScript narrows in the source, the generated code must narrow too, or the check of the generated code fails where the
source passed (found by Bramble). Three places lost it:

- A callback made under a condition (`{capturing !== null && <KeyPrompt onKey={(key) => bindKey(capturing, key)} />}`). In the
  source the arrow closes over a narrowed `const`; in the generated code it reads `this.capturing`, which TypeScript does not narrow
  inside a function even when the function is made inside `if (this.capturing !== null)`.
- A memo in such a condition (`const waiting = pick(id)`): it is generated as a call, `this.$memo(…)`, which is never narrowed.
- A list's `&&` form: the generated code filters the items, and TypeScript does not narrow through `filter`.

The generator writes `$assume(condition)`, a function the module declares when it uses it,
`function $assume(_condition: unknown): asserts _condition {}`. An assertion signature narrows what follows; the body checks nothing.
`EmitMode.conditions` holds the conditions an element being made sits under (a `ConditionalChild`'s, and a keyed list's when it does
not read the item, as a keyed element's does), and `callback` starts each callback with `$assume(c1 && c2)`. A memo a condition reads
is first read into a local (`const $m0 = this.$memo(…)`, `EmitMode.memoLocals`) that the callback then reads everywhere, since a local
can be narrowed: within one call it is the same value, because state is a snapshot and props do not change. In a list's loop the
item is narrowed by the list's own condition, after the filter that makes it true.

**It changes no behaviour.** A callback that runs after its condition stopped holding still runs, reading state as it is now: a
`useUnmount` that tells the parent `onGone()` after `label` became `null` sees `null`. (React's closure would see the value
of the render that made it; this engine's callbacks read current state, see "Props and callbacks".) Not narrowed still: a condition
on something that is not a path or a memo, which TypeScript cannot narrow in the source either.

### Children on list items (2026-11-11)

`items.map((d) => <MenuButton key={d.kind}><Icon frame={d.icon} /><Label text={d.name} /></MenuButton>)`. The item's children are plain elements
(no conditions, lists, `{children}` or children of their own) that may read the item and index like its props do (an `Item` dependency). The
list's per-key record, which already held the item's current value for callbacks, also holds the children: `{ current: Item; kids: [Icon, Label] }`.
When a key is new the generator makes the item, then each child (`const $c0 = new Icon(…)`), attaches them (`$item.attachPassedChild($c0, 0)` for a
component item, `$item.addChild($c0, 0)` for a built-in) and stores them; on later renders it applies each child's props (and transform) from the
record, so a child updates when the item's object changes. The children belong to the item's subtree, so they go with it when the item is removed.
Not built: children on an item that switches (`cond ? <A/> : <B/>`), and conditions, lists or nested children inside the children.

### Computed lists, and conditions inside list items (2026-11-12)

Found by Bramble, whose rules had to build every list the screen drew (`viewOf`) and keep it in the game state, because a list's items
could only be a state or prop array (optionally filtered), and whose inventory slot had to be a component only to hold `{filled && …}`.

**Any array is a list's items.** `{spotsOf(run).map(…)}`, `{world.enemies.map(…)}`, `{items.map((e) => ({ … })).map(…)}`, `[a, b].map(…)`:
the source is any expression the component may compute (not through `?.`), and the type-check of the generated code checks it is an
array. A source that is not a named array (state, a prop, an imported constant, each optionally `.filter`ed) is computed by a method
of the class, `$<field>List() { return <source>; }`: `render()` calls it once per render, and the list's record type names its items as
`ReturnType<C["$<field>List"]>[number]`. Its dependencies are what the expression reads, so it follows the state it was computed from,
as a React component's render does. A plain function is assumed pure, as everywhere else.

**An item's children may be nested and conditional.** The item's record keeps one field per element below the item (through static
and conditional children), each `T | null`: `{ current: Item; kids: { shape: Shape | null; text: Text | null } }`. The generator writes
the item's children with the same code as a component's conditional subtree, with the record (`$rec.kids`) where a component has
`this` (`fieldBase`): when the item is made, its static descendants are built and attached at once and its conditions are evaluated;
on each later render, its conditions mount and unmount their elements (queued on the item) and its dynamic props are applied. A
callback on a child made later reads the item through the record, as one made with the item does. Still not built inside an item: a
list, `{children}`, a `<Route>`, and children on an item that switches between two elements.

**`undefined` is a value** (`PlainRef "undefined"`), in render and in handlers: `{gate !== undefined && <Sprite … />}`,
`if (key !== undefined) bindKey(action, key)`.

**Methods of strings and numbers, destructured and memoized derived values, and state from the game state** (also 2026-11-12,
from the second Bramble review). `VALUE_METHODS` lists the string and number methods that change nothing (`padStart`, `startsWith`,
`toUpperCase`, `toFixed`, …), called as written (`CalleeIR` `ValueMethod`); `String`, `Number` and `Boolean` are allowed as
functions; `flatMap`, `join`, `at`, `lastIndexOf` and `flat` joined the array methods, and, once the type-check target moved to ES2023
(QuickJS-ng and Node 22 implement them), the copying forms `toSorted`, `toReversed`, `toSpliced`, `with`, `findLast` and `findLastIndex`. *Since 2026-11-15:* `reduce` and `reduceRight`, and `sort` or `reverse` on an array the expression made itself (`[...alive].sort(byX)`), lowered to `toSorted` / `toReversed`. A derived `const` may destructure (`const { x, y: top } = heroOf(run)`, `const [a, , c] = trio`): each
name is a member or index read of the one value. A derived value that calls a function or a method is an `ExprIR` `Memo`: the
generated code is `this.$memo(key, [deps], () => value)` (`GameObject.$memo`), the deps being the state and props it reads, so it
is worked out once per change of them wherever it is used (render, handlers, field initialisers), as React's `useMemo`; in `super(…)`'s
arguments, where `this` is not there yet, it is written in place. A call inside a nested memo does not make a memo of its own.
A `useMutable` field's initial value may read the game state (the component's snapshot of it, already a field above) and state
declared above it.

**A game-state value named like a member of the root** (`const name = useGame((s) => s.speaker)` in an `<Entity>` root) is kept in the
field `$name`; the author's name is unchanged.

**Runtime.** Children are sorted by `(slot, order)`: `addChild(child, slot,
order = 0)` and `queueAddChild(child, slot, order)` insert after every sibling
with a lower slot, or the same slot and a lower or equal order.
`queueReorder(slot, children)` queues a new order: at commit each child's
order becomes its index in `children` and the children are re-sorted (stably,
so only that slot's range moves). Static siblings before and after the list
keep their places because they have their own slots. Generated code queues
removals and adds before the reorder.

### Keyed elements (2026-11-12)

`key` on an element outside a list starts it over when the key changes, React's way to reset a component: the old instance
unmounts and a new one mounts with fresh state. While the key stays the same, changed props update it in place.

```tsx
<Dialogue key={talk.id} lines={talk.lines} />
{open && <Menu key={screen} rows={rowsOf(screen)} />}
{left ? <Sprite key={page} image="left.png" /> : <Sprite key={page} image="right.png" />}
```

**Lowering.** A keyed element is a keyed list of one item, the key itself: `lowerKeyedElement` builds a `KeyedListChild` whose
source is `[key]` (an `ArrayLiteral`), whose item is a parameter named `$keyed` (a name source code cannot write) and whose key
reads it. A keyed branch of `cond && …` or `cond ? … : …` is the same list with the branch's condition. So nothing new was
needed in the IR, the generator or the runtime: a new key is a new item, which the list mounts while it removes the old one.
As with list items, the new instance is added before the old one is removed, so its `useMount` runs before the old one's
`useUnmount`. The list's dependencies are the key's and the condition's; props that read state are applied as on any list item.

**Limits.** `key` on a component's root is `TSE1203` (it goes where the component is used). A keyed element inside a list
item's children is `TSE1209` with the same wording as a list there (make the item a component), since it is one. Beside other
children passed to a component it is a list among them, which works since 2026-11-15 (see "Forwarding"). A key that never changes (`key="x"`) compiles and does
nothing.

## Children

A parent passes elements to a component between its tags, and the component
decides where they mount (M8):

```tsx
import { type Child, Entity, Sprite } from "@tsengine/runtime/jsx";

interface PanelProps {
  title: string;
  children: Child;
}

function Panel({ title, children }: PanelProps) {
  return (
    <Entity name="Panel">
      <Sprite image={title + ".png"} />
      <Entity name="Content">{children}</Entity>
    </Entity>
  );
}

function Scoreboard() {
  const s = useMutable({ score: 0 });
  return (
    <Entity name="Scoreboard">
      <Panel title="hud">
        <Coin value={s.score} />
        {s.score > 10 && <Sprite image="star.png" />}
      </Panel>
    </Entity>
  );
}
```

**The parent owns what it passes.** The elements are fields of `Scoreboard`, built
from `Scoreboard`'s state and props and updated in `Scoreboard`'s `render()`, as if
they were `Scoreboard`'s own children: `<Coin value={score} />` follows `score`
without `Panel` knowing, and `{score > 10 && …}` is a conditional child of
`Scoreboard`. `Panel` only says where they mount, so a passed child's `x` and `y` are
relative to the container that holds `{children}`.

**Receiving** (`TSE1208`/`TSE1202` otherwise):

* The props type declares `children: Child` (`import { type Child }`).
  `children` is not a value prop: it has no `PropDeclIR`, and cannot have a
  default or be read as a value (`TSE1301`). `ComponentIR.acceptsChildren` is
  set, and the runtime props type becomes `Omit<PanelProps, "children">`, so
  `new Panel({ title })` needs no `children`.
* `{children}` (or `{props.children}`) is a direct child of a container, once.
  The container is the root, a fragment, or a static `<Entity>` below it:
  not inside a condition, a list, a block passed to another component, or a
  built-in that cannot have children. A declared `children` that is never
  rendered is an error. `{children}` may also be the whole of the children
  passed to another component (`<Box title={title}>{children}</Box>`), which
  is "Forwarding" below.
* IR: a `ChildrenSlot` child takes the slot's position among its siblings, so
  the siblings are attached with explicit slots (`addChild(child, 0)`,
  `addChild(footer, 2)`).

**Passing.** The children of a component element are lowered into its
`ElementIR.children` as static children, conditional children, or a keyed
list, owned by the parent. A list may sit among other passed children: its
items' order is a path, the list's position and then the item's index (see
"Forwarding"). A list inside a list item (`{row.cells.map(…)}`) keeps its
state (instances by key, order, records) in the outer item's record, its
source may read the outer item (a method taking it), and its callbacks read
each item around them through that item's record. `children={…}` as an attribute is `TSE1203`. Whether
the receiver renders `{children}` is its own file's business: the source
type-check catches `<Leaf>…</Leaf>` for a props type without `children`
(`TSE9002`), and the runtime throws an error if a component that does not
render `{children}` is given some.

**Generated code.** The receiver records where passed children mount, in its
constructor, after its own children are wired:

```ts
export class Panel extends Entity<Omit<PanelProps, "children">> {
  constructor(props: Omit<PanelProps, "children">) {
    super({ name: "Panel" }, props);
    this.addChild(this.sprite, 0);
    this.addChild(this.entity, 1);
    this.passedChildrenHost = this.entity;   // the container holding {children}
    this.passedChildrenSlot = 0;             // the slot's position among its children
    …
```

and the parent mounts into it by order (the child's position in the block):

```ts
this.panel.attachPassedChild(this.coin, 0);                // static, in the constructor
this.panel.queueAttachPassedChild(this.sprite, 1);         // a condition turning on
this.panel.queueDetachPassedChild(this.sprite);            // and off
```

A list passed as the children uses `queueAttachPassedChild(item, position)`,
`queueDetachPassedChild` and `queueReorderPassedChildren`. When a conditional
`<Panel>` unmounts, its passed children go with it and the parent's fields
reset, so remounting builds them afresh.

**Runtime.** `GameObject` has `passedChildrenHost` / `passedChildrenSlot`
(protected, set by the generated receiver) and `attachPassedChild`,
`queueAttachPassedChild`, `queueDetachPassedChild` and
`queueReorderPassedChildren`, which add to the host at `(slot, order)` (see
"Keyed lists"). The parent never needs the receiver's slot index, so a
component from another file works.

### Forwarding `{children}` (2026-11-11)

```tsx
function Modal({ title, children }: ModalProps) {
  return <Flex float anchor="center" to="center"><Panel title={title}>{children}</Panel></Flex>;
}
```

`Modal` does not hold what it is given: it hands each passed child to `Panel`, which holds it in its own slot (or hands it on again, so
Modal → Panel → Flex resolves in a chain). The generated constructor says `this.passedChildrenForward = this.panel;` where it would
say `passedChildrenHost` / `passedChildrenSlot`, and `GameObject`'s four passed-children methods delegate to the forward target when
it is set (`acceptsPassedChildren` is true for either). The parent's `attachPassedChild`, queued adds, removals and reorders all end up
in the innermost container, so static, conditional and list children all work through it.

**A forwarded `{children}` may sit beside other passed children, and so may a list** (2026-11-15; until then each had to be the
only child passed, option A of 2026-11-11). `<Card><Title />{children}<Footer /></Card>` and `<Panel><Head />{items.map(…)}</Panel>`
are the everyday way to build a reusable panel, and refusing them pushed authors to wrappers. All of a receiver's passed children
share one slot, so what decides their order is `order`, which is a `ChildOrder`: a number, or a path of numbers compared in
turn (`compareOrder`). A static passed child is its position (`2`); a list's items are the list's position and then their index
(`[1, 0]`, `[1, 1]`; `queueReorderPassedChildren(items, [1])`); and a component that forwards puts the position of its `{children}`
among what it passes in front (`passedChildrenForwardAt`), so what it was given sorts between its own `<Title />` and `<Footer />`,
through any number of forwards. Order ranges (`position × 2²⁰ + i`) were the other way; a path has no limit and needs no
arithmetic across levels. Plain numbers stay numbers, so children of built-ins sort as they did. A forwarding component must itself
be always present (not in a condition or a list or another component's children): otherwise `TSE1202`.

## Prefabs and scenes

A prefab is an exported component plus a description of its props, so data
files (not only TSX) can place components in a world (M6). Three pieces:

* **Registry.** Every module that exports a component gets, after its classes
  (`ComponentIR.isExported`: `export function`, or the default export):

  ```ts
  export const prefabs = {
    Enemy: {
      create: (props: ConstructorParameters<typeof Enemy>[0]) => new Enemy(props),
      props: [
        {"name":"speed","type":{"kind":"Primitive","name":"number"},"optional":false,"settable":true},
        {"name":"tint","type":{"kind":"Literals","values":["red","blue"]},"optional":true,"settable":true,"default":"red"},
      ],
    },
  } satisfies Record<string, PrefabDefinition>;
  ```

  `ConstructorParameters` types `create`, so the props interface need not be
  exported; a component without props gets `create: () => new X()`. `props` is
  built from `PropDeclIR` / `PropTypeIR`: value props only (a callback cannot
  come from data, and `children` is passed, not set). A prop whose type the
  compiler cannot describe as data (`SourceText`) is listed with
  `settable: false`: it is code-only. A default is included when it is a
  constant the compiler can evaluate (`constantValue`).
* **Project outputs.** Next to the per-file outputs, the CLI writes
  `prefabs.ts` (every module's `prefabs`, merged, for `loadScene`) and
  `prefabs.json` (`{ version, prefabs: { Name: { module, props } } }`, for
  editors and validators). Both are written only when every file compiled: with a
  failure they would silently leave a component out, so the CLI skips them and
  says so (the files that did compile are still written). It also
  checks the whole project: an exported name used in two files is `TSE1206`
  (scenes refer to prefabs by name), and a static cycle through several files is
  `TSE1205`. A flag that needs a value (`--scenes`, `--runtime`) without one, an
  unknown option, and a source or scenes directory that does not exist are usage
  errors (exit 2), not silent no-ops: CI must not pass without having checked the
  scenes it was told to check.
* **Scenes.** JSON: `{ "version": 1, "entities": [{ "id", "prefab", "props"?,
  "transform"?, "children"? }] }`. `id` is author-assigned, unique in the
  scene and stable across edits (for diffing and hot reload). `transform` is
  `x`, `y`, `z` (draw order), `rotation` (radians), `scaleX`, `scaleY`, `global`.

**Validation.** `tse-compile <src> <out> --scenes <dir>` validates every
`.json` in the directory against the compiled prefabs, after the project
compiles (a broken project would only produce unknown-prefab noise). The scene
is parsed into an AST (the JSON `ScriptKind`), so every diagnostic carries the
file, line and column of the offending value, and its JSON path in the message
(`entities[1].props.speed: Expected a number, got the string "fast"`):

| Code | Meaning |
| --- | --- |
| `TSE1501` | not valid JSON (with the parser's position) |
| `TSE1502` | not the scene format: version, missing or unknown keys, wrong container, no `id` or `prefab` |
| `TSE1503` | unknown prefab (lists the known ones) |
| `TSE1504` | unknown prop (says callbacks cannot be set) |
| `TSE1505` | missing required prop |
| `TSE1506` | wrong type: a prop value, an array element, a literal not in the union, a transform field |
| `TSE1507` | a prop data cannot express |
| `TSE1508` | duplicate `id` (nested entities included) |
| `TSE1509` | Tiled import: an unreadable map, or an object or property it cannot turn into an entity |

A problem does not stop the walk, so one run reports them all.

**Tiled.** A `.tmj` in the scenes directory is imported to
`<out>/scenes/<name>.scene.json`, which is then validated like any scene
(positions in those diagnostics point at the generated file). Object layers
only; tile layers are a renderer concern. Each object becomes an entity whose
prefab is its `class` (older Tiled: `type`) and whose props are its custom
properties (`bool`, `int`, `float`, `string`, `file`, `color`; `object` and
`class` properties are `TSE1509`). Ids are `"<layer name>/<object id>"`, stable
across edits in Tiled; group layers flatten. `rotation` is converted from
degrees to radians. A tile object (one with a `gid`) is anchored at its bottom
left in Tiled, an entity at its top left, so the importer moves the anchor
along the object's own rotated up axis. An object with no class is skipped
with a warning. A layer's `offsetx` / `offsety`, and those of every group it is in,
shift its objects, because Tiled shows them there. A layer or group hidden in Tiled, and an object with `visible: false`,
are not placed. Flip bits in an object's `gid` do not move its anchor, so they need no handling. Not handled:
whether an `int` property is whole, and properties inherited from object templates.

**Tile layers** are a second import, `importTilemap`, of the same `.tmj` into `generated/tilemaps.ts`, a table of
`TilemapData` by file name (see [PLAYER.md](PLAYER.md), "Tilemap"): the layers' ids with flip bits split off, each layer's `visible`
(a hidden group hides its layers), the first embedded tileset's `firstgid` and its tiles with the property `solid`. It is written
before the sources are type-checked, because a game's own code (its rules) imports it. A map with no tile data (an objects-only
map) writes nothing.

**Runtime.** `loadScene(world, scene, prefabs)` builds each entity with
`create(props)`, copies `transform` onto its `placement` (so the component's
own state-driven `transform` composes on top: a placed `Mover` still moves
relative to its spawn point), and gives it its `children` *before* anything is
mounted, so every object mounts once, children first. A child goes to the
`{children}` slot of a component that renders one (`acceptsPassedChildren`),
and is otherwise appended after the component's own children. It returns a
`Map` of every object, nested ones included, by scene id; an editor or hot
reload can key on that. It checks only that a prefab exists and an id is not
repeated: validating props is a build step, so the runtime stays small.

**Two ways to the same tree.** A scene is data; a component that composes
prefabs is code. Both build the same objects, and a test compares the tree a
scene builds with the one the equivalent TSX builds (type, props, transform,
children). Only a scene sets `placement`: TSX places a component with an
`<Entity>` around it.

## Text

`<Text>` (M10) is a leaf built-in for HUDs, labels and menus. Its content is
its children, and only them (2026-11-12: the `text` attribute is refused, with
where the words go, and `TextAttributes` leaves it out of the props; before, the
attribute and the children were two ways to write one thing):

```tsx
<Text size={12} color="gold" x={8} y={8}>Score: {score}</Text>
<Text size={12}>{`Score: ${score}`}</Text>
```

**Runtime.** `Text extends GameObject` with `text`, `size` (default 16) and
`color` (default `"white"`) as fields. The mock draws nothing: a renderer reads
the fields and `worldTransform()`. It is listed in the manifest's `intrinsics`
and `transformIntrinsics`, requires `text` (`intrinsicRequired`), and names the
prop its children become in the `textContent` entry (`{ Text: "text" }`),
which is what makes an intrinsic take JSX text instead of elements.

**Compiler.** JSX text is not supported anywhere else, so the transform folds
a `Text`'s children into one string prop (`#lowerTextContent`): text and
`{expressions}` become a `TemplateLiteral`, a `StaticProp` when nothing in it
varies and a `DynamicProp` (with its dependencies) when it reads state or
props. A lone `{`template`}` is used as it is; string and number literals fold
into the surrounding text; comments are ignored. Whitespace follows React: each
line is trimmed, blank lines are dropped and lines join with one space, so
whitespace containing a line break disappears (`{n}` then `points` on the next
line is `5points`; write `{n}{" "}` or keep them on one line for a space).
HTML entities (`&amp;`) are `TSE1202`, since JSX would decode them and the
compiler does not. Elements inside a `Text`, both forms at once, and neither
form are errors (`TSE1202`, `TSE1203`, `TSE1202`). The generator needs
nothing special: the content is an ordinary prop, so
`this.text.text = \`Score: ${this.score}\`` is a plain assignment in
`render()`, the `Text` keeps its identity, and a change costs the component's
one render.

**Authoring types.** `Text` takes either `text: string` or `children: string |
number | (string | number)[]` (`TextAttributes`), so the source type-check
rejects a `<Text />`, both forms, an element child, a boolean child and a
non-string `text`.

**As a root.** A component may be a `Text`
(`const Badge = ({ points }) => <Text>+{points}</Text>`): the class extends
`Text`, `text` is a required constructor prop that a dynamic root gets a
placeholder for (as `Sprite.image` does), and `text`, `size` and `color` become
names a state or prop may not use.

**Text wrappers** (2026-11-13). React shares a text style with a component, `<Label>Coins: {coins}</Label>`;
here it failed four ways (no `TextChild` type to import, `children` had to be `Child`, `{children}` inside `<Text>` meant nothing,
and a component could not take text). A props type with `children: TextChild | readonly TextChild[]` (`isTextChildrenType`,
which also takes `string`) makes `children` an ordinary value prop rather than a slot. At a use site, `childrenKind` sorts what is
between a component's tags: words, and `{expressions}` that hold no JSX and are not a forwarded `{children}` slot, are text, and
`lowerTextContent` folds them into the `children` prop as it folds a `<Text>`'s into `text`; elements are lowered as
usual; both at once is `TSE1202`, naming the two props types. Inside the wrapper `<Text>{children}</Text>` reads the prop, and
`<Button>{children}</Button>` passes it to a second wrapper the same way. Whether the component takes text is the type-check's to
say. No inherited style (`<TextStyle>`) was added: a text's look does not depend on where it is in the tree.

**Game-wide defaults.** `<Game textSize textColor>` set what a `<Text>` without its own `size` or `color` uses, as `font` sets its
font: the player calls `setTextDefaults` from the root when it starts and on each reload (and `@tsengine/testing` clears them), and
`Text.size` and `Text.color` are getters that fall back to them, then to 16 and white. `sized` counts the game's size as given,
so a bitmap font is drawn at it. Both take literals only, like the other settings.

**A built-in small font** (2026-11-16, ABI v14). `font="tse:small"` (on `<Text>` or `<Game>`) is a bitmap font built into the
engine: 3 × 5 glyphs in 4 × 6 cells, so a line is 6 pixels, where the default font is about 8. Every small-resolution game needs
one, and a file each game ships would be the same file each time. It is named like an asset with a `tse:` prefix that no file name
has, which leaves room for more built-ins; the glyphs live in libtse, so there is nothing to package ([PLAYER.md](PLAYER.md),
"Built-in fonts").

**More built-in fonts, with their own widths** (2026-11-17, ABI v15). One small font left every other resolution to a file per
game, and the bitmap-font format, equal cells, made the fonts most used in small games (m5x7, Tiny5, Micro 5) look gappy: an `i`
took the room of an `m`. So there are eleven built-ins now, two or three for each of 320 × 180, 480 × 270 and 640 × 360, and a
built-in font carries an advance per character, which drawing, measuring and wrapping use. `tse:small` became Tom Thumb's glyphs
(still 3 × 5 in 4 × 6 cells, so its sheet and line height did not change). The fonts come from CC0, public-domain and SIL OFL
originals, rasterised by `tools/fonts/make-fonts.py` into a C table (the sheet) and a TypeScript one (the advances), which a test
keeps to the same names as `BUILTIN_FONTS`. Each is named for the font it comes from, except `tse:caps` (Kite's capitals) and `tse:arcade`: Press Start 2P's
license reserves its name for the original. The OFL asks for its text to go with the fonts, so `native/FONTS.md` goes wherever
libtse does. The digits share one advance in every font (a narrow `1` is centred in it), so a score or timer does not shift as
it counts. Not done: advances for a font file. A sheet gives no widths, and reading them from its pixels would need the image
on the TypeScript side, so a game's own font still moves a cell at a time. `tse preview games/demo` shows every built-in on a
game screen at each resolution (`FontSampler` and its stories).

## Shape

`<Shape>` (M11) is a filled rectangle or circle, for debugging colliders and
prototyping before art exists:

```tsx
<Collider width={20} height={20} />
<Shape kind="rect" width={20} height={20} color={hp <= 0 ? "gray" : "red"} />
```

**Runtime.** `Shape extends GameObject` with `kind` (`"rect" | "circle"`),
`width`, `height` and `color` (default `"white"`) as fields. The mock draws
nothing: a renderer reads the fields and `worldTransform()`; the origin is the
top-left corner, as for a `Sprite`, and a circle's `width` and `height` are the
diameters across (an ellipse when they differ). `kind`, `width` and `height` are
required (`intrinsicRequired`), and the shape is in `transformIntrinsics`, so
it follows its parent like any object. Every field updates in place.

**A fixed set of values, from the manifest.** The kinds come from the runtime
(`SHAPE_KINDS`), and the manifest's `intrinsicLiterals`
(`{ Shape: { kind: SHAPE_KINDS } }`) tells the compiler which built-in props
take one of a fixed set of strings. A *literal* for such a prop is checked in
the transform, so a misspelt kind is a compiler diagnostic that names the
choices rather than a type error in generated code:

```
<Shape kind> must be one of "rect", "circle", not 'rectangle' (did you mean "rect"?).   TSE1210
```

The suggestion appears for a plausible typo: a prefix either way (`rectangle`,
`circ`) or at most two edits (`circel`), case ignored. A non-string literal
(`kind={3}`, a bare `kind`) is the same error. Any other expression
(`kind={big ? "circle" : "rect"}`) is left to the type-check: `ShapeProps` types
`kind` as the union, so a bad literal inside an expression is `TSE9002` in the
source and `TSE9001` in generated code. The rule is not specific to `Shape`:
restricting another built-in's prop is a manifest edit (a test does it to
`Sprite.image`).

**As a root.** A component may be a `Shape`
(`const Dot = ({ size }) => <Shape kind="circle" width={size} height={size} />`):
the class extends `Shape`, the required props that vary get the usual
constructor placeholders, and `kind`, `width`, `height` and `color` become names
a state or prop may not use.

## Line

`<Line x={ax} y={ay} x2={tx} y2={ty} width={1} color="#fff" />` is a straight line between two points of its parent's space,
square-ended, `width` pixels thick (default 1). `x2` and `y2` are required; `width` is the thickness, not a horizontal size, which
is why it is its own element and not a `<Shape>` kind (a `<Shape>` needs `width` and `height` as a box).

**Runtime.** `Line extends GameObject` with `x2`, `y2`, `width` and `color`. It draws nothing itself and is a leaf.

**Player.** One `TSE_OP_RECT` record, turned along the line, its corner half the thickness to the side of the start so the
thickness is centred: no native change. The draw pass takes the parent's turn and scale as the line's world transform less its
own local one (layout offset, placement, transform), so the end is where the parent puts (`x2`, `y2`) whatever the line's own
rotation and scale, and the thickness scales by the parent's (the square root of the two scales' product, for an uneven one).
Opacity is the `opacity` prop, as on any element. A line of no length, or no thickness, draws nothing.

## Pointer

`<Pointer>` (M14) is a hit area for presses, positioned with `x` and `y`:

```tsx
<Shape kind="rect" width={48} height={16} color="gray" />
<Pointer width={48} height={16} onPress={() => setOpen(!open)} />
```

`Pointer extends GameObject` with `width`, `height` (both required) and
`onPress`. It draws nothing, and its origin is the top-left corner. `contains(x, y)`
takes a world-space point back through the pointer's world position, rotation
and scale, so a moved, turned or scaled pointer is hit where it is drawn; a zero
scale is never hit, and neither is an area with no size (`width` or `height` of 0, or not a number), so a button
that collapses to nothing stops firing. The test assumes the usual composition of scales and rotations; a rotated
object under a non-uniformly scaled ancestor is sheared by a renderer that applies transforms one by one (see
`composeTransforms`), and is only approximated. `onPress` takes no parameters, and the manifest says so
(`intrinsicCallbacks`). It is a leaf.

**Cameras.** `reportPress` takes a **world-space** point. A pointer drawn through a `<Camera>` is on screen where
the camera's view puts it, so an input system converts a screen point first: `camera.viewToWorld(x, y)`.

## Game

`<Game>` is the root of a game and where its configuration lives (decided 2026-11-09): the window (`title`, `width`,
`height`, `resizable`, `vsync`, `smooth`), the `background` colour, the `assets` folder, and the game state. It is a
built-in container, an `<Entity>` with those props (and `name`), so a component whose root is `<Game …>` extends it, as
any component extends its root. **Its `width` and `height` are the window's size; a `<Screen width height>` inside it
is the game's resolution**, the size everything is drawn at before it is scaled to fit the window:

```tsx
// Main.tsx
export default function Main() {
  return (
    <Game title="tse demo" width={960} height={540} background="#10131c" assets="assets">
      <Screen width={320} height={180}>
        <Ground />
        <Camera><Player /></Camera>
        <CoinCounter />
      </Screen>
    </Game>
  );
}
```
```ts
// game.ts: nothing but the root
export const gameConfig: PlayerConfig = { root: () => new Main() };
```

**With a `<Screen>`.** Both are roots, so they nest: the `<Screen>` is the `<Game>`'s only child, and the player looks
through the `<Game>` for it (`rootScreen`), as it does for a `<Screen>` that is the root itself. Either is optional
without the other.

**Optional.** A game with an `<Entity>` or fragment root, or any root object, works without a `<Game>`: the player's own config
and the defaults apply. A `<Game>` root overrides them, each prop only where it is written; a field it does not write is
`undefined` on the object, which is how the player knows to fall back.

**Literals, and only a root.** The player reads these settings before the tree is built, so each is a literal
(`width={640}`, `smooth`, `resizable={false}`) or a constant imported from a `.ts` module (`background={WALL}`), never state
or props: anything else is `TSE1210`. Two are exceptions (below):
`timeScale` and `paused` are read every frame and may be state. `<Game>` is only ever a
component's root: as a child it is `TSE1003`. It is not placed, so it takes no `x` or `y`. A prop it does not have is
`TSE1203`, listing the ones it does. Its members are reserved names for a component that is rooted at it, like any
built-in's.

**No `state` prop** (retired 2026-11-11). It used to hand the game state to the runtime, which never needed it: the player
starts every game state in the process from its initial values (`resetGameState`), and components read it with selectors,
with or without a `<Game>`, so `state` is not one of its props.

A user component cannot be called `Game`: it is an intrinsic like `Entity` (`TSE1206`). The demo's root is `Main`.

**Fast-forward and pause: `timeScale` and `paused`** (2026-11-13). Hearth's 2× speed used to run its rules
twice per engine step, and its pause skipped them. Once the battle moved into components there was no one function to call
twice, so both now belong to the world. Each frame the player reads the current root's `timeScale` (default 1) and
`paused`: the frame's time is multiplied by `timeScale` before it reaches the fixed-step driver, so `2` runs two whole steps of
the same `dt` (a fast-forward that plays exactly as at 1; the cap on steps a frame grows with it), and `paused` sets
`World.paused`, under which `tick` runs `onInput` and the presses but no `onUpdate` (the key edges of a paused step are not kept
for later, as a freeze's are: the press that unpauses is not replayed into the first step). The compiler lets both take any
expression (`LIVE_GAME_SETTINGS` in `transform/elements.ts`); the rest stay literals. 2× costs two
whole steps a frame, renders and collisions included.

## Camera

`<Camera>` (M12) is the viewport. Its own transform is the view, `zoom`
(default 1, must be positive) magnifies, and it follows its children:

```tsx
<Camera zoom={wave > 5 ? 2 : 1}>
  <Player />
</Camera>
```

**The view.** A renderer draws the world through the inverse of the camera's
world transform, so moving the camera pans the view, turning it turns the view
the other way, and scaling it up shows more of the world; `zoom` then magnifies.
`viewTransform()` returns that map as a canvas-style matrix (`x' = a·x + c·y +
e`, `y' = b·x + d·y + f`), and `worldToView` / `viewToWorld` apply it and its
inverse (the second turns a click into a world position). The point the camera
is at lands on the centre of the viewport: the renderer knows the viewport's
size, the camera does not. Moving a camera never changes any object's
`worldTransform()`: the view is applied on top of the world.
Reading the view with a zoom that is not positive, a scale of 0, or a position,
rotation or scale that is not finite throws a `RangeError` (the view would be
singular or NaN). Assigning one does not throw: a prop that varies with state can
pass through such a value, and throwing inside `render()` would abort a flush
partway through the tree, so the error surfaces where the view is read, which is
the renderer. `viewTransform()` recomputes from the tree each call, so it is
never stale; a renderer should fetch it once per frame and apply it to
everything, rather than call `worldToView` per point.

**Following its children.** The camera is a container (`containerIntrinsics`),
and the view is centred on its children: on the player in `<Camera><Player
/></Camera>`, wherever the player's own state moves it. With several children it
centres on the middle of their world positions; conditional children and a
list (`<Camera>{units.map(…)}</Camera>`) work as anywhere, and the view moves as
they come and go. This replaces what the plan sketched, `<Camera follow={hero} />`:
that needed a way for a component to name another object, which nothing in the
language provides (state holds data, not objects), and wrapping the target says the same thing with nothing new.

**The camera is transparent to its children.** Following a child that the camera
also moves would be circular (the child's position would depend on a camera that
depends on it), so the camera does not move its children: they are placed in the
camera's *parent's* space, as if the camera were not there. This is one
runtime hook, `GameObject.childSpace()` (the space an object's children are
placed in; its own world transform by default), which `worldTransform()` uses
and `Camera` overrides. So `<Entity x={100}><Camera><Entity x={10}><Player
/></Entity></Camera></Entity>` puts the player at 110, and the
camera's own `transform`, `placement`, `zoom` and `global` never touch it.

**The camera's own transform** is an offset from the followed point: the
camera's anchor (its parent's position, or the origin when it has no parent or is
`global`) moves to the children's centre, and the camera keeps its own offset from
that anchor, transformed as usual by its parent. So the offset means the same
thing with or without children, and adding a child at the parent's own position
changes nothing. The camera's rotation, scale and zoom stay its own. With no
children it sits where its transform puts it, and a camera
*inside* an entity (`<Entity><Camera /></Entity>`) still moves with it by
ordinary transform nesting.

**Through `{children}`.** A component can wrap its children in a camera
(`const Rig = ({ children }) => <Camera zoom={3}>{children}</Camera>`), and
`<Rig><Runner /></Rig>` follows the runner: passed children mount in the camera
(M8).

**As a root.** A component may be a `Camera`
(`const View = ({ zoom }) => <Camera zoom={zoom} />`): the class extends
`Camera`, and `zoom`, `viewTransform`, `worldToView`, `viewToWorld` and
`childSpace` become names a state or prop may not use.

## AnimatedSprite

`<AnimatedSprite>` (M13) is a sprite that cycles through a list of images:

```tsx
<AnimatedSprite frames={running ? ["run1.png", "run2.png", "run3.png"] : ["idle1.png"]} fps={8} playing={running} />
```

**Runtime.** `AnimatedSprite extends GameObject` with `frames`, `fps` (default
10), `playing` (default true), and the current `frame` index and `elapsed`
time. A renderer reads `image`, the current frame, as it reads a `Sprite`'s. It
advances in its own `onUpdate(dt)`, which the `World` calls every tick because
the class overrides it (the existing registration rule); it loops, carries the
remainder of a step, and takes several frames from one long `dt`. A non-positive
or non-finite `fps`, and an empty `frames`, freeze it rather than throw, since
this runs inside `World.tick`. Playing is not state: advancing a frame
re-renders nothing, so an animation costs no renders.

**Frames.** `frames` is an array prop. The array literals M5a added make it
writable in source, and it follows the usual rule: a fixed list is built once
(a `StaticProp`), a list that reads state or props is re-assigned in `render()`
(a `DynamicProp`). A dynamic list is a *new array every render*, so `frames` is
an accessor that compares contents: different contents restart at the first
frame (and clear the carried time); equal contents change nothing, so an
unrelated state change that makes the component render again does not restart the
animation. It keeps its own copy, so mutating the caller's array later changes
nothing. `playing={false}` freezes on the current frame, saves up no time, and
resumes from there.

**A built-in that implements a hook.** This is the first built-in with an
`onUpdate` of its own, which exposed a hazard: a component *rooted* at an
`AnimatedSprite` that writes its own `useUpdate` generates `override
onUpdate(dt)`, which would replace the sprite's and silently stop the animation.
The manifest's `intrinsicHooks` (`{ AnimatedSprite: ["onUpdate"] }`) lists the
hooks a built-in implements itself, and the generated override calls `super`
first, with the hook's own parameters:

```ts
override onUpdate(dt: number): void {
  super.onUpdate(dt);          // the sprite advances its frame
  this.#onUpdate0();           // then the component's own handlers, in order
}
```

A hook the root does not implement is generated without `super`, so existing
output does not change, and a runtime test checks the list is exactly the hooks
the intrinsic classes override, so a new one cannot be forgotten. A component
rooted at the sprite also cannot name state `frames`, `fps`, `playing`, `frame`,
`elapsed` or `image`.

## Transforms and sounds

Components should read like React: what is on screen, position included, is a
function of state. So there is no transform hook: position is ordinary state,
written as `x`, `y` and the other transform props of a built-in element.

```tsx
function Mover() {
  const s = useMutable({ x: 0 });
  useUpdate((dt) => {
    s.x += 60 * dt;
  });
  return (
    <Entity name="Mover" x={s.x} y={0}>
      <Sprite image={s.x > 100 ? "run.png" : "idle.png"} />
    </Entity>
  );
}
```

```ts
export class Mover extends Entity {
  $s_x: number = 0;                  // the field as render saw it
  #$s_xNext: number = this.$s_x;     // as handlers wrote it: `s.x += …` reads and writes this
  readonly sprite: Sprite = new Sprite({ image: (this.$s_x > 100) ? "run.png" : "idle.png" });
  constructor() {
    super({ name: "Mover" });
    this.transform.y = 0;            // static fields: set once
    this.addChild(this.sprite);
    this.render();
    this.commitStructure();
  }
  $set_s_x(value: number): void { if (value === this.#$s_xNext) return; this.#$s_xNext = value; this.markDirty(); }
  override commitState(): void { this.$s_x = this.#$s_xNext; }
  override onUpdate(dt: number): void { this.$set_s_x(this.#$s_xNext + (60 * dt)); }
  override render(): void {          // dynamic fields: re-applied when what they read changed
    const $1 = this.$s_x;
    if (this.transform.x !== $1) { this.transform.x = $1; this.markMoved(); }
    const $2 = (this.$s_x > 100) ? "run.png" : "idle.png";
    if (this.sprite.image !== $2) { this.sprite.image = $2; this.sprite.markChanged(); }
  }
}
```

(Abridged from `packages/example/generated/Mover.ts`, which also has the hot-reload hooks and the `s` view a handler passes whole.)

**The transform props**: `x={…} y={0} rotation={angle}` and the rest of the
transform fields (`x`, `y`, `z`, `rotation`, `scaleX`, `scaleY`, `global`, and
`opacity` on most built-ins; see "Placing things"). Each lowers like any
prop: a field that reads no state is a `StaticProp`, set once right
after the element is constructed (and, for a child, before it is attached);
one that reads state is a `DynamicProp`, re-applied in `render()`. Fields not
listed keep the runtime defaults (`x`, `y`, `z` and `rotation` 0, scales 1, not global). The runtime
`transform` object is never replaced. Units: pixels with y down,
rotation in radians.

**Relative by default**: every runtime object (`GameObject`) has a transform,
relative to its parent's (the World's root is the identity). A
child at `{ x: 10 }` inside a parent at `{ x: 100 }` is at 110, and it turns
and scales with the parent: the child's position is scaled, then rotated, by
the parent and added to the parent's position; rotations add, scales
multiply per axis. `global: true` (default `false`) puts the transform in
world space, ignoring every ancestor; its own children are relative to it as
usual. `global` is an ordinary field, so it can come from state
(`global={pinned}`); `global` alone means `true`. The runtime resolves this in
`GameObject.worldTransform()`, which is what a renderer reads; the compiler only
writes local fields.

Every built-in element the runtime manifest lists in `transformIntrinsics`
takes the props; one left out gets `TSE1207`. A component element takes none of
them (`x` on a component is its own prop): it is placed by an `<Entity>` around it
(see "Placement" under "Props and callbacks"). A `transform` attribute on any
element is `TSE1207`, whose message says what to write instead. `useTransform` was
removed; calling it reports `TSE1102` with a pointer to the props
(`TSE1105` is retired).

**Cost**: moving every frame is a state change every frame, so the component
renders once per tick (one render however many writes there were). `render()`
re-evaluates only the parts whose inputs changed (see "Dependency-scoped `render()`").

**useSound** (M15): `const playHit = useSound("hit.wav")` binds a sound, and
`playHit()` as a statement in a handler (`useUpdate`, `useInput`, `useMount`,
`onCollisionEnter`, `onPress`, a callback inside an `if`) plays it. It is a
top-level hook like `useMutable`, with one binding per call, so two bindings of the
same path are independent. The path is a string literal (`TSE1107` otherwise),
so a missing asset can be reported at build time once there is an asset list.
`SoundIR { id, name, path }` in `ComponentIR.sounds` compiles to a field
(`readonly playHit: Sound = new Sound("hit.wav")`), and the call is a
`PlaySound` statement, emitted as `this.playHit.play()`. Playing is an effect,
not state: it happens at once, not at the next render, and marks nothing
dirty. Because it would play on every render, the function may only be called
as a statement in a handler: in JSX, a derived `const`, an expression, as a
value (`onCollisionEnter={play}`) or with arguments it is `TSE1305`. Sounds
are not placed, so they take no `x` or `y`. `Sound` has no
audio of its own: `play()` counts calls in `plays`, so game logic can be tested, and reports to the
`SoundSink` a player installs with `setSoundSink` (see "Player").
Options such as `volume` come later.

## Sharing state between components (2026-11-13)

With game code in components, an enemy that chases the player needs the player's position. React's answer holds here: the common
parent keeps it in its `useMutable`, the player reports it up through a callback prop, and the parent passes it down as a prop or
through context. The timing, pinned by `sharing.test.ts`: handlers run in tree order and read props and context live, so a value
a child reports up in a step is seen in that same step by a sibling after it, by props and through context alike; a sibling before
it sees it in the next step. That one step of lag is deterministic; a built-in that must not lag reads its child's transform
directly (`<Camera>`).

## Context (2026-11-13)

Context is React's API, compiled. It was left out while props covered every tree. Once game code moved into components, a parent
needed to share its state with a deep subtree, and context is how React does that.

- `createContext(default)` (`runtime/src/context.ts`), in a `.ts` file, returns `{ default, Provider }`; `Provider` is only for
  the type-checker (a method, so a context of any value type fits `Context<unknown>`).
- `<Theme.Provider value>` is rewritten, in the inliner's first pass (`providerEdits`), into the built-in
  `<Provider context={Theme} value>`, and `Provider` is added to the file's import from the authoring module. `Provider` extends
  `Entity`, is a container with `layoutContents` (layout sees through it), and keeps the components that read it; setting a
  different `value` marks each of them dirty.
- `useContext(Theme)` lowers to two states the component does not own (`transient`: hot reload and saves leave them out): a
  reader, `readContext(Theme)`, a handle state, so `ownedHandles` tells it its owner when the component joins a world, and it
  finds the nearest `Provider` of that context above and registers the component with it; and the value, whose `refresh`
  (`this.$context1.value`) the generated `commitState` reads every render. Because the value is state, derived values and memos
  that read it depend on it as on any state. `const { accent } = useContext(Theme)` reads members of the value.
- Objects are never re-parented, so a reader keeps its provider; a provider that goes takes its subtree with it.

## Global state (`createGameState`)

A component's own state is `useMutable`. The **game state** belongs to the game: a score, hit points, a mute switch, the screen,
shared by every component. It is one nested object: data, read with selectors that return the value, as in Zustand, and
actions, which write it directly. Only actions change it, as only a parent changes the state it passes down: an action keeps an
invariant and its side effects together, gives replays and debugging a named event, and keeps one place to answer "what can
change `run`?". Calling an action marks the store dirty, and at the end of the action the store compares its draft with the
committed state leaf by leaf and tells only the readers whose leaves changed, so nothing is added to the read path. Decided 2026-11-09 as a
Zustand store changed through `set`; since 2026-11-15 the data-and-actions form below is the only one, and the `set` form is
removed (`TSE1109` names what to write instead).

```ts
// GameState.ts, in the source directory. An ordinary module: the game runs it.
import { createGameState } from "@tsengine/runtime";

export const useGame = createGameState(
  { coins: 0, player: { hp: 10, name: "Ada" } },        // the data: a plain object
  {
    collect(s, n: number) { s.coins += n; },             // an action takes the state, then its own arguments
    hurt(s) { s.player.hp -= 1; },
  }
);
```

```tsx
// CoinCounter.tsx: access                    // Player.tsx: update
import { useGame } from "./GameState.ts";
const hp = useGame((s) => s.player.hp);          const { hurt } = useGame.actions();
                                                  useUpdate(() => { if (hit) hurt(); });
```

**Access.** `const hp = useGame((s) => s.player.hp)` returns the value, as in Zustand. A component imports the
store (`import { useGame } from "./GameState.ts"`; the only thing it may import from a relative `.ts` module,
`TSE1108` otherwise) and calls it at the top level, bound with `const` to one name. A **plain path** from its parameter
subscribes to exactly that path; any other expression is a computed selector (below). A typo is `TSE1108`
with the nearest key at the level it went wrong (`'player.hpp' … did you mean "player.hp"? 'player' has: hp, name`).
`hp` is then a snapshot of the last render, usable in JSX and handlers, with the leaf's type.

**Computed selectors** (2026-11-11). The selector may be any expression of the state:
`const selected = useGame((s) => s.cursor === id)`, `const focus = useGame((s) => focusOf(s.battle, s.cursor))`,
`useGame((s) => s.battle.pads[s.cursor]?.tower != null)`. Each path it reads (`s.cursor`, `s.battle`) becomes a snapshot of its
own, `$cursor`, `$battle` (one per path, shared with a plain selector of the same path in the component), and the expression is
a derived value over them, inlined where it is read like any `const` in the body. So the component re-renders when one of the paths
it reads changes, and works the value out again then: coarser than Zustand, which compares the selector's result, but the same
answer. A trailing `.length` (`s.enemies.length`) reads the array's snapshot, since the store reports an array's items, not its
length; before this, `useGame((s) => s.enemies.length)` subscribed to a path nothing ever reported. An action read inside a
computed selector is `TSE1301` ("select it by itself"), and `(s) => s` alone is still `TSE1103`.

**Several values at once** (2026-11-11), as Zustand allows: `const { originX, room } = useGame((s) => s.run)` (a path,
destructured), `const { a, b: c } = useGame((s) => ({ a: s.x, b: s.y.z }))` (an object literal of paths) and
`const [a, b] = useGame((s) => [s.x, s.y])` (an array). Before compiling, each picked value becomes its own selector
(`const originX = useGame((s) => s.run.originX)`), so its own subscription: the component re-renders only for the values it
reads, which is finer than Zustand's `useShallow`.

**Objects and arrays** (decided 2026-11-11). A path may name an object or an array as well as a leaf:
`const player = useGame((s) => s.player)` and then `player.hp` in JSX or a handler, or
`const enemies = useGame((s) => s.enemies)` and `{enemies.map((e) => <Enemy key={e.id} … />)}`. Its type is TypeScript's,
written into the generated code as `ReturnType<typeof useGame.getState>["player"]`, so a wrong member is a type error.
The component re-renders when any value under the path changes (the store tells the reader of `player` when
`player.hp` changes), and not when an equal copy is set: values are still compared leaf by leaf, arrays by index.
What a selector returns is read-only (`ReadonlyDeep<T>`; see "Writes are actions' only" below).

**Update: actions.** A component takes the actions it calls with `const { hurt } = useGame.actions()` and calls one as a
statement in a handler, like a sound's play function: not in JSX or a derived value (it would run on every render), not as a value
other than passed whole (`onPress={resume}`). The compiler lowers `hurt(1)` to `useGame.getState().hurt(1)`, so TypeScript checks
the arguments in the generated code as well as in your source. The action's body is plain TypeScript that the game runs; the
compiler never lowers it.

`GameStore.fromActions` builds the store. An action runs on a **draft**, a deep copy of the values (`cloneData`; QuickJS has no
`structuredClone`), and may change it in place, nested objects and lists included (`s.run.time += dt`, `s.gems.push(id)`). When the
outermost action returns, the draft is compared with the state, objects whose values did not change keep their identity
(`shareUnchanged`, so a reader comparing by `===` sees no change), and the readers of each changed path are told. An action called
from another (`useGame.actions().begin()`) shares the draft and the commit happens once, under the outer action's name in the
inspector's history; an action that throws commits nothing. While an action runs, `useGame.getState()` returns the draft with the
actions, so plain code it calls (Bramble's save `pick`) reads what it has written so far.

**Writes are actions' only.** A write into a selected value in a component (`run.time = 0`, `hp += 1` after
`const { hp } = useGame((s) => s.player)`, `items.push(x)`) is `TSE1402` or `TSE1301`, with a message that spells the action to add
(`name(s) { s.player.hp = …; }`). What a selector returns is typed `ReadonlyDeep<T>`, so a helper in a `.ts` file that takes a
mutable `Item[]` or changes an item is a type error for a selected list (it takes `readonly Item[]`, or the action does the change).
`useGame.getState()` is read-only too. `useGame.setState(partial | updater)` stays, shallow-merged as in Zustand, for code outside
the game: tests, a story's `setup`, the inspector's edits. Called while an action runs it throws, since the action's commit would
overwrite it.

**The schema is real code.** `GameState.ts` is imported by the generated files and runs in the game, under Node and
under QuickJS, so TypeScript infers every type from it, and there is no separate declaration to keep in step. The
compiler also *reads* it (it never runs it, `gamestate/schema.ts`) to know the state tree and the action names. For that, the
data must be an object literal (`as` and `satisfies` around it are fine), whose entries are number, string or boolean literals (a
negative number is fine; a leaf's type is its literal's, so `0` is a `number`) and nested objects of those. Any other value (an array,
`newRun()`, a constant) is kept as a *value*: the compiler checks paths down to it and leaves the rest to TypeScript. A function in
the data, a name in both, spreads and computed keys are `TSE1109`; so are the removed `(set) => ({ … })` form and a call with no
actions argument. Keys have no dots. The actions are an object literal of functions (`name(s, …) { … }` or `name: (s, …) => …`).

**Semantics.** Every commit compares the old and new state leaf by leaf (a function is not a leaf) and marks dirty every
mounted component that reads a leaf that changed, and only those: a replaced `player` object does not re-render the
reader of `player.name` when only `hp` differs. Those components copy the new value into their own field in
`commitState`, in the same flush, so a HUD shows a coin on the frame it was picked up, while every handler in that
frame still saw the old snapshot. An action that changes no leaf renders nothing. A component joins the subscribers when it
joins a world and leaves when it leaves, and is refreshed once on joining, so it cannot miss a change made between its
construction and its mounting. A component that only binds actions reads nothing, so it keeps no copy and is never
told of a change.

**Where it lives.** `createGameState` makes a `GameStore` (also `useGame.store`); calling `useGame(...)` itself is
compile-time only and throws, like the authoring hooks. `createPlayer` calls `resetGameState()`, which puts every store
in the process back to its initial data, so each game starts fresh; tests that build components without a
player call it between cases. Generated output for a reader and an action:

```ts
import { useGame } from "../src/GameState.ts";          // relative to the generated file; the CLI computes it
export class CoinCounter extends Text {
  hp: number = useGame.store.get<number>("player.hp");
  override readonly gameStateStore = useGame.store;
  override readonly gameStateKeys: readonly string[] = ["player.hp"];
  override commitState(): void { this.hp = useGame.store.get<number>("player.hp"); }
  …
}
// in a handler:  useGame.getState().hurt();
```

The IR marks such a state `globalKey` (the dotted path) and has a `CallAction` statement. `gameStateStore` and
`gameStateKeys` are reserved member names, like the other `GameObject` fields.

**Not yet.** Zustand's `subscribe` and middleware; a handler reading the store live (it reads what its component's last render
saw, unlike its own `useMutable` fields); and more than one store per project (one `createGameState` call per project).

### Actions: `useGame.actions()` (2026-11-13)

`const { collect, hurt } = useGame.actions()` takes the actions a component calls. It replaced
`const { advance, togglePause } = useGame((s) => s)`, the one case where a component selected the whole state, which every game
wrote and which reads like the Zustand anti-pattern it was an exception to.

- The destructuring split (`hooks/inline.ts`, `storeSelectionEdits`) turns each name into `const collect = useGame.$actions((s) => s.collect)`,
  which `matchStoreStatement` reads as a selector with `via: "actions"`. An action binding subscribes to nothing.
- A name that is a value of the state is `TSE1108` and says how to read it (`const coins = useGame((s) => s.coins)`); a typo
  names the nearest action. `useGame.actions()` must be destructured.
- Names destructured from `useGame((s) => s)` are written `useGame.$wholeN(…)` (N tells the statements apart), and the actions
  among them get one warning per statement that spells the `useGame.actions()` line to write. Values destructured that way
  stay fine: each is its own subscription.
- At run time `useGame.actions()` returns the state's functions, for plain code (`useGame.actions().collect()`). Its type is
  `ActionsOf<S>`.

## Plain functions in components

A component may import functions from a relative `.ts` file (`import { fadeThrough } from "./transitions.ts"`) and call them in any expression (a prop, a derived value, a handler) or pass them as values (`transition={fadeThrough}`). The compiler does not look inside them: TypeScript checks the call, the function is assumed pure, and a dynamic prop that calls one depends on the state in its arguments, so it is re-evaluated when those change. The function body is plain TypeScript with loops, arrays and anything else. This is the escape hatch from the restricted handler language: the logic goes in a `.ts` file, the component only wires it up.

**Constants too** (decided 2026-11-11). Anything else a `.ts` file exports is used the same way: `import { ROOM_LIST } from "./rules/rooms.ts"` and `{ROOM_LIST.filter((r) => Math.abs(r.index - room) <= 1).map((r) => <Tilemap key={r.map} … />)}` (an imported array is a list's items, as a state or prop array is; the filter's callback reads state, so the list follows it), `<Entity x={GEM_AT.x}>`, and a method of an imported object called in a handler or an expression (`fx.burst("dust", x, y)`, `sfx.play("start")`): opaque like a plain function (`CalleeIR` `Plain` with a dotted name), its arguments are all it depends on. An array method on an imported array (`ROOM_LIST.filter`) stays an array method, so its callback is lowered. An imported constant is a constant: nothing re-renders when code changes it, which is right for data and for the effect stores below, and wrong for game state (that is `useGame`).

Rules: the name must not look like a hook (`use…`; those are the game state's store, which is the only hook-named import from a `.ts` file); a function that is a prop of a component (a callback) is lowered as a handler. The generator imports the function from where it is (`../src/transitions.ts` from the generated file, through `tse-compile`'s knowledge of where it reads and writes), only if the component uses it. In the IR: `CalleeIR` kind `Plain`, `ExprIR` kind `PlainRef`, and `IRModule.plainImports`.

**`useUpdate` takes the input.** `useUpdate((dt, input) => { step(input, dt); })`: the polled input of that step (under a fixed timestep, the per-step copy with exactly-once key edges), the same object `useInput` gets, and it can be handed to a game-state action or a plain function, which reads the keys with loops and tables (Kite's `rules/controls.ts`). A canonical `onUpdate` override (several handlers, or a root that implements the hook) declares `input` only when it passes it on.

## Named input actions (2026-11-11)

A game names its actions once, in a module, and hands them to `<Game>`:

```ts
// rules/controls.ts
export const controls = createControls({ jump: ["Z", "Space", "PadA"], left: ["ArrowLeft", "A", "PadLeft"], confirm: ["Enter", "PadStart"] });
```

```tsx
<Game controls={controls}>…</Game>
useInput((input) => { if (input.pressed("confirm")) begin(); });
```

Each binding is a `KeyName`, the union of the names in `KEY_NAMES` (the player's `KEYS` is that list), so a misspelt key is a
type error where the controls are written: `Type '"Spcae"' is not assignable to type … Did you mean '"Space"'?` (2026-11-11). Action names in `input.pressed("…")` are not checked by type; an unknown name is a warning at run time.

Every `InputState` question (`pressed`, `down`, `released`) then takes an action name as well as a key name: `down` is any of
its keys held, `pressed` is one of them going down this step, `released` is one going up with none still held. Rules in plain
TypeScript read the same names (`input.down("left")`). `<Game controls>` must be an identifier imported from a `.ts` module
(`TSE1210` otherwise), since the player reads it before the tree is built; `PlayerConfig.controls` does the same for a game
without a `<Game>`. `createInputState(snapshot, controls)` gives tests the same answers, and `controls.bindings` is the shape
an input script's `bindings` takes, so a script's `jump` can hold the game's own keys. An unknown name warns once and lists
the actions. Not built: rebinding at run time, and axes (a stick's value rather than four directions).

## Motion: springs, tweens and opacity (2026-11-13)

- `useSpring(target, { duration, bounce })` and `useTween(target, { duration, ease })` are shipped hooks
  (`hooks/library.ts`): a `useMutable` field made by `startSpring` / `startTween` and a `useUpdate` that steps it with `stepSpring` /
  `stepTween` (`runtime/src/math.ts`). Each step returns the same object once settled, so the state stops changing and the component
  stops rendering. They follow the fixed step, `freeze`, replays and hot reload because they are state stepped in an update. They
  stop under `<Game paused>` too, which is right for the world and wrong for a pause menu: a clock for presentation that a pause
  does not stop is not built (Hearth's pause modal does not animate for that reason).
- The spring is set by `duration` and `bounce`, as SwiftUI and Framer Motion set one, and turned into stiffness (2π / d)² and
  damping 4π (1 − bounce) / d (unit mass; bounce 0 is critically damped) by `springFrom`. It is integrated with semi-implicit Euler
  in slices of at most 1/240 s, so a stiff spring is stable at any step, and snaps to its target once within 0.001 of it and slower
  than 0.001. A new target keeps the velocity.
- The tween starts again from its current value when the target changes, over `duration`, along one of `EASINGS` by name or a
  function.
- **Numbers only, in the hooks.** A hook's state made by a call is typed `ReturnType<typeof f>`, which cannot depend on the
  argument, so the hooks take a number (a point is two). The math functions take points in plain code.
- An initial value may read state declared above it (`useMutable({ spring: startSpring(target) })` with `target` from state),
  as in React's first render: state fields are made in declaration order.
- `transform.opacity` (0 to 1, default 1; written `opacity={…}` in JSX since 2026-11-16, see "Placing things") is pushed on the draw list's alpha stack (`pushAlpha`, as a `<Flex opacity>` is) where
  the walk enters the object and popped where it leaves, in the world walk and the HUD walk, so it multiplies down the tree and
  every record's colour alpha is scaled by it, in both backends (no ABI change). Records with an alpha in them are never copied to
  another frame: a faded object reports itself `WALK_OPAQUE`, takes no leaf fast path, and is kept out of the "it only moved" copy,
  since an opacity change is reported as a move.
- Not built: a second layer (`transition` on a built-in's transform, eased by the runtime without renders), which waits for a game
  that measures the hooks as too costly.

## Sequences, for cutscenes (2026-11-15)

`sequence([wait(0.4), tween(1.2, set, easeOut), call(fn), waitFor(pred), parallel([…])])`, in `runtime/src/sequence.ts`: a plain
library, not compiler work. A sequence is a value with `step(dt)`; the game's rules or a
component own it (Bramble's `Play` keeps one in a `useMutable` field and holds the world while it runs). Each step reports the time it
has left over when it ends, and the next step gets it, so a sequence lasts what its steps add up to at any step size, and under the
fixed timestep it is deterministic. Its `position` is plain data (`{ index, step }`, nested for `parallel`) and `restore` carries on from
it, a `call` already made not made again; the closures are rebuilt by the code that makes the sequence, so a save keeps the position
only. Building Bramble's cutscene found two things about writing one in a component: a field started at `null` cannot have its methods
called (only an object a function made for the component, a "handle", can), so the cutscene field starts from `noCutscene()`; and
`import type { Sequence } from "@tsengine/runtime"` is refused in a component, so `@tsengine/runtime/jsx` re-exports the type.

## Timers: `after`, `every`, `cancelTimer`, `cancelTimers` (2026-11-13)

React code writes `setTimeout` in a handler; before timers, each delay here was a countdown kept as state.

- **Runtime.** `GameObject.after(seconds, fn)`, `every(seconds, fn)` and `cancelTimers()` keep a list of timers on the object; the
  `World` keeps the objects that have any and calls `stepTimers(dt)` on each after the step's updates, in the update phase, so timers
  stop during `freeze` and `<Game paused>`, follow the fixed step and replay. A repeating timer runs at most once a step. Leaving the
  world clears an object's timers: a timer never calls back into a component that has gone (React's classic `setTimeout` bug).
- **One timer at a time** (2026-11-17). `after` and `every` return an id, and `cancelTimer(id)` stops that timer alone: restarting
  a hit flash with `cancelTimers()` also stopped the component's other timers. The id is a number (1, 2, 3… per object, never
  reused, never 0) rather than a handle object, because a component keeps it in `useMutable` state, which holds plain data and is
  saved and hot-reloaded. A timer cancelled by an earlier callback in the same step is skipped. Hot reload and tree saves carry the
  object's next id with its state (`$$nextTimerId`), so the object that takes the state over never hands out an id its state already
  names.
- **Compiler.** `after`, `every`, `cancelTimer` and `cancelTimers` are imported from the authoring module and are statements in handlers only
  (`TIMER_FUNCTIONS`); a call is the component's own method, `this.after(…)`, and the function passed is lowered as a handler (a
  callback, as one handed to `settings.subscribe`). Their names are reserved members, so a state called `after` takes `$after`.
- **Hot reload drops pending timers**, with a note in the log: a timer's function closes over the instance that set it, which the
  reload replaces, and it cannot be carried to the new one. (Keeping timers by call site would need the handler that set the timer
  to run again.) A save never holds a timer either: a delay that is gameplay is state.
- Sequences, for cutscenes, are a separate library: see "Sequences, for cutscenes".

## Seeing inside a running game: the overlay and the inspector (2026-11-13)

Both are development tools of `tse dev` only: the player takes `devtools` (which `playWithReload` sets),
and without it neither exists.

- **The layout overlay** (`player/src/overlay.ts`). With `devtools`, the root's `overlayKey` (F1) turns it on: the frame builder then
  lists each `<Flex>` it lays out with where it was placed (`FrameBuilder.inspecting`, `inspected`, in both the world walk and the
  HUD walk, so a floating box is where the layout put it), and the player draws, after the game's records and in window pixels
  through the frame's views, an outline of each box and its padding, each collider (a colour per layer) and each `<Pointer>`, and
  a label for the box under the mouse (its components, `componentPath`; its size; the `width` and `height` it was given). Gaps are
  not outlined.
- **The inspector** (`player-node/src/inspector.ts`): an HTTP server on 127.0.0.1 (a free port unless given) that `tse dev`
  starts and prints the address of. The page is plain HTML and script; it gets the tree, the selected object and the game states
  as server-sent events, a few times a second while it is open (`update()` from the dev loop, every tenth frame), and only what
  changed; it sends a selection or an edit as a POST. Server-sent events and a POST rather than the WebSocket the plan named:
  Node has no WebSocket server built in, and this is the same exchange.
- **What it reads** (`runtime/src/inspect.ts`): `inspectTree` (components and built-ins, with list keys and a stable id per
  object), `inspectObject` (props as data, `saveHotState` by source name, `gameStateKeys`, `renderCount`, which `runRender`
  counts). Only the selected object's details are read each time.
- **Actions and their changes.** A `GameStore` wraps each action of its creator so it knows which one is running, and while
  `recording` is on (the inspector turns it on) `setState` keeps the last 50 changes: the action's name (or `setState`) and each
  leaf changed, before and after.
- Editing sets a state through `loadHotState` (`editState`), as hot reload does, or a game-state leaf through `setState`; each
  is logged as an edit from the inspector, which a replay does not repeat.
- **The profiler** (2026-11-15; `runtime/src/profile.ts`). Speed was learned from CI's bench budgets, after the fact; the profiler
  says where a frame's script time goes while the game runs. The inspector's "profile" button calls `startProfiling()`, and while a
  profiler is active the World times each `onInput`, `onUpdate` (with its timers) and render (`renderInPass`) and adds it to a row
  per component class name, and the player times its phases: `steps` (`world.tick`), `collisions` (the walk that places colliders,
  the contacts and the renders they cause), `build` (the frame's last walk) and `draw` (`backend.frame`, which includes waiting for
  the display). Once a second the inspector sends `take()`: milliseconds a frame per component (input, update, render, total), how
  many ran at most in one frame and renders a frame, the most expensive first. Off, the World checks `activeProfiler()` once per
  tick and once per flush pass and otherwise runs its usual loops, so the bench budgets see no cost; on, each handler costs two clock
  reads. Times are inclusive of what a handler calls, and a render is the component's own (its children render on their own turn).
  Tried on Hearth's wave 10 under Node: `Tower` (16) 0.30 ms a frame, `Enemy` (110) 0.16, `Play` 0.10, collisions 0.41 of a
  1.35 ms frame: the towers' target queries, not the enemies, are the place to look.

## Rewind in `tse dev` (2026-11-13)

`player/src/rewind.ts`; `tse dev` turns it on.

- **Recording.** `Rewind` wraps the backend the player is given (a `Proxy`): live, `frame()` draws and polls as usual and keeps a copy
  of the input it wrote, which is the next frame's. Each frame's state is hashed (`hashState`: the game states' values and the
  tree's hot state, walked in order); every `snapshotEvery` frames (60) a snapshot keeps the game states (`GameStore.values`,
  cloned), a deep copy of the tree's hot state, and the player's clock (`Player.snapshotClock`: the fixed step's driver, a freeze,
  the animation clock, the next frame's input, and the hovered pointer by its path). Five minutes are kept; older frames and
  snapshots are dropped.
- **Going back.** `seek(frame)` restores the snapshot before it (`GameStore.restore`, then `Player.restoreTo`, which builds the
  root again and gives it the hot state, puts the clock back, starts a collision tracker from what touches now so no enter is
  reported twice, and makes the pointer the mouse was over the hovered one without telling it), then plays the recorded input to
  the frame with the backend fed (no drawing but the last frame, no sound). Each replayed frame's hash is compared with the
  recording's; the first that differs is the divergence.
- **What makes a replay exact.** Three things had to change for Hearth's wave 10 to replay frame for frame: `restoreHotState`
  flushes before its first pass (a root with no state of its own restored nothing, as the router builds the active route on a flush;
  this was a hot reload bug too); a state that holds a class instance (a `useBody` body) is never replaced on restore, its fields are
  put into the new component's own instance, which keeps its owner (the saved one belonged to the component that left: towers
  restored with it saw no enemies, and a body after a hot reload stopped colliding); and snapshots copy the tree's state, since a
  body changes in place.
- Paused, the last frame is drawn again with a bar over it; F2, the four arrows and F4 are rewind's. After a hot
  reload while paused, `reloaded()` seeks to the same frame with the new code. Resuming drops the recorded future.
- **Moments.** F4 writes the snapshot before the paused frame and the input after it as JSON (`Moment`; the driver as data,
  `FixedDriver.toJSON`), and `replayMoment(config, moment, { stores, observe })` plays it on a recording backend.
- **Not put back:** a built-in's own state (an animation's frame, a camera's smoothing), particles in flight, the music's position,
  and timers. A replay rebuilds the tree, so a `useMount` runs again; one that changes state can make it differ, which the hash
  check reports.
- **Cost** (Hearth, wave 10 at 2×, V8): a frame 1.46 → 1.83 ms mean while recording (p99 3.9 → 4.8); going back half a second
  46 ms, a whole second 67 ms.

## Kite's movement with `useBody`, compared (2026-11-13)

`games/kite/src/Runner.tsx`, `games/kite/test/runner.test.ts`.

- **Same pixels.** The component and `stepBody` use the same mover (`moveActorX` / `moveActorY`) and the same numbers; the body
  finds solid tiles through `<Tilemap solid>` (`World.solidIn`) where the rules call `solidAt`. Six scripts, two rooms, walls and
  ceilings: identical every step.
- `Body.blocked(dx, dy)`: whether the box moved by (dx, dy) overlaps something solid, without moving. The rules' `hitsAt`.
  A body standing on the floor has nothing to report from `move(0, 0)`, so without it the ground could not be known.
- **What the hook's `x` and `y` are in a handler:** the step's snapshot, as all state is; after a `move`, read `blocked` (which asks
  the body where it is now), or move relative to where it is (`move(side, -1)` for the corner slide), never `place(x + …)`.
- **Cost** (Node): 6.7 µs a step in the rules, 11.3 µs as a component with its world's tick and render: the price of a world, not
  of the body. A solver keeps the rules.

## Dependency-scoped `render()` (2026-11-13)

`generator/generator.ts` (the render method), `RenderGuard` in `generator/expressions.ts`, the guards in
`generator/elements.ts`.

```ts
override render(): void {
  const $r0 = this.$memo("at", [this.dist], () => pathAt(MAP.path, this.dist));   // once, not at each read
  const $i = this.$in;
  let $d = 0;
  if ($i[0] !== this.dist) { $i[0] = this.dist; $d |= 1; }
  if ($i[1] !== this.props.lane) { $i[1] = this.props.lane; $d |= 2; }
  …
  if (($d & 3) !== 0) { /* the transform, from dist and lane */ }
  if (($d & 29) !== 0) { /* the sprite: kind, dist, flash, slow */ }
```

- The mask is built in `render()`, by comparing each input with its value at the last render (`$in`, a fresh object in each slot
  at first, so the first render runs everything). Setters, `updateProps`, the game state's notifications, context and hot reload
  work as before, and a new instance (hot reload, rewind) starts unguarded.
- Inputs are what `inputsOf` finds: state fields (game-state and context fields are state fields), and props. A part that reads
  an element's own field (`route.active`), a handle, or calls the component's own function, a callback prop, an action or a
  local function is not guarded: its reads are not followed. Imported functions are pure, as everywhere in the compiler.
- **What is guarded:** the root's values, and each element that is always there: an intrinsic's values (one test per element, as
  `emitReportedWrites` groups them) and a component's `updateProps`. Under a condition or in a list nothing is: an element made in
  this render needs every value written.
- **Only when it saves something.** When every guarded part reads every input, any change runs them all, and the render is written
  again without the mask (`CodeWriter.truncate`). More than 30 inputs: the parts past the 30th run always.
- Memos the render always reads are worked out once at its top (`alwaysReadMemos`, the ones they read first), and read as locals
  where the render reads them; callbacks keep reading `$memo` (they run later). Hearth's enemy worked out its position six times a
  render through `$memo`, each with a new array and closure.
- Measured on Hearth's wave 10 (`tools/frame-time.ts`): 1.40 → 1.18 ms a frame under Node, 13.5 → 12.2 ms under QuickJS (two runs each). The
  memos alone took Node to 1.28.

## Placing things: `<Flex>` anywhere, and `x` / `y` as props (2026-11-13)

- **Props.** `x`, `y`, `z`, `rotation`, `scaleX`, `scaleY` and `global` are props of every built-in in the manifest's
  `transformIntrinsics` (`TRANSFORM_SHORTHAND`, `lowerTransform`): they lower to writes to the object's runtime transform, and no
  member is reserved. `global` alone means `true`. One on a built-in that has no transform is TSE1207. The authoring types add
  `TransformShorthand` to those built-ins only.
- **Opacity: one way, a prop** (2026-11-16). `opacity={…}` is a prop on every built-in; a component is faded by an
  `<Entity opacity>` around it. On a built-in whose manifest members have no `opacity` of its own (`isTransformShorthand`: `<Entity>`,
  `<Shape>`, `<Line>`, `<Text>`, …) the prop is lowered like `x`, to the transform's opacity, which the draw pass already
  pushes for the object and everything under it; `<Sprite>`, `<AnimatedSprite>`, `<Flex>`, `<Tilemap>` and `<Layer>` keep the
  `opacity` prop they had, which fades the same way. A field on `Entity` was not used: every component extends `Entity`, so its
  members are names no component's props or state may take, and `<Layer>` (an `Entity`) has an `opacity` that means something
  else. Scenes (`.scene.json`) keep `opacity` in their `transform`: that is data, not JSX.
- **Not on components.** The compiler compiles one file at a time and does not know whether an imported component declares an `x`,
  so on a component `x` is always its own prop: one rule, with no case that depends on another file. A component is placed by an
  `<Entity x y>` around it, or takes `x` and `y` props of its own and puts them on its root (Hearth's `Pad` and `Shot` do).
- **No `transform` attribute** (2026-11-17). Until then a built-in took its place two ways (props, or `transform={{ … }}`, and a
  field written both ways was an error), a component was placed only with `transform`, `opacity` was only a prop and `global` only
  a `transform` field: a split no rule explained. The games wrote props almost everywhere and used `transform` only to place a
  component (Kite's gem, the demo's three pickups, the example project's six). Making `x` on a component mean placement would
  break components that declare their own `x` (Hearth's `Tower` aims with it; `Pad` and `Shot` take it), so the attribute went
  instead: built-ins take every field as a prop, and a component is wrapped as it already was for `opacity`. A `transform`
  attribute is TSE1207, whose message names the props to write on a built-in and the wrapper on a component. The compiler's
  component-placement path (writes to the child's `placement`) went with it; `placement` is now set only by scenes, whose
  `transform` object is data. The cost is one `Entity` per wrapped component, which matters only for long lists, and those place
  themselves through their own props.
- `<Flex>` in world space needed nothing new: Bramble's menu is a column of rows, the cursor's bar each row's `background`, and
  it draws the same pixels as the hand-placed version (its stories' screenshots did not change).

## Diagnostics in the editor: `tse lsp` (2026-11-13)

`packages/language-server` (the server and the quick fixes), `tse lsp` (the command line starts it),
`editors/vscode` (the extension, `npm run vscode:pack`).

- **A server beside TypeScript's.** TypeScript's own server keeps the types, hovers and completions; this one adds the `TSE`
  diagnostics only the engine's compiler knows. It speaks the few messages of the Language Server Protocol it needs (whole-text
  sync, diagnostics, code actions, shutdown) directly, with no dependency.
- **One compiler per game.** A file belongs to the nearest folder above it whose package.json has an `"tse"` field or depends on
  `@tsengine/runtime`; only a `.tsx` under its source folder is analysed. `GameProject.diagnose` runs `Compiler.compile` (custom hooks,
  analysis, the IR and generation, without type checking) on the text as the editor has it: 1 to 8 ms for a small component and
  about 20 ms for Hearth's `Play.tsx` once the TypeScript process is warm, so a document is analysed 150 ms after the last change.
  `GameState.ts` and hook files are read as the editor has them too, and a change to any file of a game analyses its other open
  components again. A diagnostic the compiler found in another file is shown at the start of this one, naming where it is.
- Quick fixes are text edits, found from the diagnostic's span with a small scanner (brackets, strings, comments): a missing
  import, an import from `"react"`, `useEffect(…, [])` to `useMount`, `useMemo` and `useCallback` to the value and the function,
  `<Text text>` to children (a self-closing `<Text>` only), a whole-state selector to `.actions()`, and a name the authoring module
  does not export. A fix that cannot be made with confidence (an effect with dependencies) is not offered; the message says what
  to do.
- The extension runs the game's own `tse lsp` (the `@tsengine/cli` its folder resolves), so the messages match the engine the game
  is built with, and one server serves every game under one install. It has no dependencies either: no `vscode-languageclient`,
  and the `.vsix` is a zip written by `tools/pack-vscode.ts`.
- **Packs.** `@tsengine/language-server` is packed (the command line depends on it) and installed as a dev dependency;
  `check:outside` asks the packed `tse lsp` for a component's diagnostics.

## Previews: stories and `tse preview` (2026-11-13)

`player/src/stories.ts` (the format, and building a story's root), `player-node/src/preview.ts` (the
window, the screenshots, the comparison), `cli/src/commands/preview.ts`, and a `previews` step in `tse check`.

- **Where stories live.** A `stories/` folder beside `test/`, not beside the component in `src/`: a stories file imports the
  generated class as a test does, and the compiler leaves plain `.ts` files in `src/` where they are, so `./HealthBar.tsx` there
  would not run. Stories are listed by export name, since a module namespace lists its exports alphabetically.
- **A story's root.** `storyRoot` resets every game state, runs the story's `setup`, and builds a `<Game>` with the game's look
  (`gameLook` reads the background, assets, font, text, controls and fixed step from the game's own root, built once from
  `game.ts`; never its window, id or speed), a `<Screen>` of the story's size with `fit="contain"`, and the component in an entity
  at the story's origin. That entity's `hotKey` is the story's id, so a hot reload keeps the component's state (same path) and
  switching to another story does not (another path).
- The window is `playWithReload` with a `load` that builds the chosen story instead of importing the entry, also watching
  `stories/`. F5 and F6 ask for a reload without compiling (`onReady`'s `reload`); a file saved meanwhile is still compiled.
  The label is drawn over the frame through a backend proxy, as rewind's bar is, so it is not part of the screenshot. Rewind and
  the inspector are off.
- Screenshots go through `renderRun` (the headless build), one hidden window per story at its size times its scale, after the
  story's input and one more step for the layout. `tse check` runs `tse preview --compare` in a process of its own; any pixel that
  differs fails (`--tolerance` allows a difference per channel). The pictures are the software renderer's, and only the headless
  build is used for them: the OpenGL build blends a translucent colour (Hearth's end screen's shade) a little differently.
- **Keys.** Rewind's "a second" keys are ↑ and ↓. They were PageUp and PageDown, which are not in `KEY_NAMES`: `KEY_INDEX.get`
  gave `undefined` and the keys never worked. The change left F5 and F6 free for stories.

## Effects that happen at a moment (2026-11-11)

Not everything a game shows is state. A burst of dust where the character landed, a sound, a shake of the view: each
happens at a moment and then plays out on its own, after whatever caused it has moved on. React has no `useEffect`
here (and this compiler will not grow one: an effect that watches state to fire an event is the pattern React's own docs
warn against); the answer is the one toast libraries use. An **effect store** is made once in a `.ts` module, its
renderer is mounted once, and anything can call it: a game-state action (plain TypeScript, where events are known), a
plain function, or a component's handler.

```ts
// effects.ts
export const fx = createParticles({ dust: { burst: 9, lifetime: 0.4, speed: 55, angle: 270, spread: 75, gravity: 160, fade: true } });
export const sfx = createSounds({ land: { src: "land.wav", volume: 0.5 }, start: "start.wav" });
```

```tsx
<ParticleLayer particles={fx} />     {/* like <Toaster />: where bursts are drawn, in the world */}
```

**Once a step** (2026-11-13, for Hearth): a sound entry with `once: true` plays at most once a step, however many components ask for it.
`World.tick` counts steps (`countStep` in `Sound.ts`); the store remembers the step a `once` sound last played in. Hearth's rules
did this by hand over a step's events; with twenty towers each playing its own shot, the store has to.

```ts
// called with what a step reports, by the component that runs it
for (const e of events) if (e.type === "land") { sfx.play("land"); fx.burst("dust", e.x, e.y); }
```

- `createParticles(presets)` → `ParticleStore`: `burst(name, x, y, { angle?, count?, color?, endColor? })`, and `bursts`
  (counts by name, for tests). A burst's colours replace the preset's for that burst alone: each particle keeps a small index
  into its emitter's list of burst colours (emptied whenever no particle is alive), so one preset serves every colour. A preset is `<Particles>`'s props less `rate`, `emitting` and `space`. `<ParticleLayer particles={fx}>` holds
  one emitter per preset and attaches itself to the store while mounted (the last mounted wins); a burst's point is in the
  layer's space. It follows the world: frozen with it, gone with it. With no layer mounted a burst is counted, not drawn.
  Put the layer next to a `<Camera>`, not inside it, since a camera follows its children.
- `createSounds(entries)` → `SoundStore`: `play(name, volume?)` plays at the entry's volume times `volume`, and `plays(name)`.
  Every file is loaded when a sound sink is installed (`addSoundPreload`), so the first play does not hitch. Asset names in
  a `.ts` file are not checked at build time (only literals in components are).
- **Time since mount is state: `const time = useTime()`** (2026-11-11). An engine-shipped hook like `useSquash`: a `useMutable({ time: 0 })`
  that a `useUpdate` adds `dt` to, so the component renders each update. It is for a blink or a bob (`time % 1 < 0.66`), where a game
  would otherwise write the clock out by hand.
- **A shake is state: `const shake = useShake()`** (2026-11-11, replacing a `createShake()` object). The hook hands back its
  fields `{ strength, duration, elapsed }`; `shake.strength = 3; shake.duration = 0.25; shake.elapsed = 0` in a handler starts one, the hook's own update
  runs it down (`shakeOn`, the same object once over), and `<Camera shake={shake}>` draws it: the camera's offset is a pure
  function of the value (whole pixels from a fixed sequence, so runs repeat). The component that owns the camera owns the
  shake; a child that knows when to shake tells it with a callback prop.
- **Squash and stretch is state: `const squash = useSquash(1.75)`** (decided 2026-11-11, replacing a
  `createSquash()` object with a `start` method, which was the imperative shape). `squash.x = 0.6; squash.y = 1.4` in a
  handler, and `scaleX={squash.x} scaleY={squash.y}` on the sprite, which scales about its origin. It
  springs back to 1 at `recover` a second in the component's own `useUpdate` (`springBack`, a runtime function that returns
  the same object at rest, so the state stops changing). `useSquash` is an engine-shipped custom hook: ordinary source
  (`useMutable` + `useUpdate`, in `compiler/src/hooks/library.ts`, with `useShake`), inlined like any custom hook when a component imports it
  from `@tsengine/runtime/jsx`, where it is declared for TypeScript.
- **Per-instance objects.** A store in a module is global; an object that belongs to one entity is that component's own,
  made by a factory as a field's initial value: `const s = useMutable({ tally: makeTally() })`. The initial value is evaluated
  once per instance, typed `ReturnType<typeof makeTally>`, and a handler may call
  its methods (`s.tally.add(1)`, `CalleeIR` `ValueMethod`): only for state a factory made (a runtime `create…` function from
  the manifest, or a function from a `.ts` file), so arrays and records keep their messages. This is for objects that are
  not values; a value that changes over time is state (`useSquash`, `useShake`). The manifest's `functions` table includes
  `springBack` and `shakeOn`, which the shipped hooks call.
- **Reacting to what happened: call, and use the result.** No event emitter (one was tried, 2026-11-11, and removed as a
  workaround): the component that runs a step answers it. A handler may use a game-state action's result,
  `const events = step(input, dt)` (`CalleeIR` `Action`, only as a handler's `const`; in JSX or a derived value it would run
  on every render), and then call plain functions and write state with it. Kite's character runs the step in its own
  `useUpdate`, plays the effects (`playEvents`) and sets its squash (`squashFor(events)`).
- **Effects a game makes from the basics.** Afterimages (copies of a sprite left behind, fading) are Kite's own `<DashTrail>`
  (they were briefly an engine feature): a list of ghosts in state, drawn as `<Sprite>`s with falling `opacity`. The
  engine keeps what a game cannot build from the rest.
- `moveActorX` / `moveActorY` (runtime `move.ts`, for a game's rules): move any `{ x, y, rx, ry }` a pixel at a time
  against a `blocked(x, y)` test, carrying the sub-pixel remainder; on a block the remainder is dropped, `onBlocked(direction)`
  is called (it may move the actor, which is how a game adds corner rules) and the move stops. Kite's body uses it, with its
  corner corrections as the callbacks.
- **Continuous effects stay JSX.** A trail "while dashing" is state, so it is `<Particles emitting={dashing}>` in the component.
  The stores are for moments.
- **Rules stay pure.** Kite's `stepRun` reports events and never calls a store, so the solver and the tests step it with no
  side effects; the game state turns events into effects (`effects.ts`, `playEvents`).

## Layers (2026-11-15)

`<Layer blend clear childBlend opacity>` is a built-in container whose children are drawn off screen and then laid over what is under
it with a blend mode (ABI v10, [PLAYER.md](PLAYER.md)). Lighting and shaders are built on it: a light map is a `multiply` layer
cleared to the darkness, with the lights in it drawn with `childBlend="add"`, and a shader takes a layer as its input.

- **A container, not a prop on each drawable.** A blend mode on a sprite would be a state change in the record stream, and the frame is
  sorted by `z` after it is written, which would move a sprite away from the state it needs. A layer's records are one block between a
  begin and an end, so they move together. Inside one, `z` is ignored (`DrawList.setZ` does nothing while a layer is open) and children
  draw in tree order; the layer as a whole has its own `z`.
- **The layer covers the target** (the screen, or the canvas under a `<Screen>`): its children are placed through the same view as
  anything else, so a light follows the world under the camera. A layer in a `<Hud>` works the same way through the HUD's view.
- **Opacity applies once.** What is drawn inside a layer is drawn at full opacity; the opacity it is under, and its own, go on the end
  record, so a faded layer is not faded twice.
- **Never reused from the last frame** (`FLAG_OPAQUE | FLAG_VOLATILE` in `draw.ts`): its records are rewritten each frame, as a
  `<Flex>`'s are. An empty layer writes nothing.
- The compiler knows it from the manifest: a container, its `blend` and `childBlend` checked as literals, its props following state.
- **Shaders** (2026-11-15, ABI v11) go on a layer, run as it is laid over: `<Layer shader="cave.glsl" params={[0.12]}>`. A shader is an
  asset like an image, one GLSL function `vec4 effect(vec2 uv)` that the engine wraps for its platform, so a game's shaders are not
  tied to desktop GLSL. The software renderer runs none and says so ([PLAYER.md](PLAYER.md), "ABI v11").
- **Shaders on a sprite** (2026-11-23, ABI v16): `<Sprite shader="fruit.glsl" lookup="ramps.png" params={[…]}>`, and the same on an
  `<AnimatedSprite>`. At first a sprite with an effect was to be a layer with one child, but a layer sees the screen, not the sprite:
  it cannot tell where a sprite's middle is or how far it has turned, and a screen-sized pass per sprite is too dear for a jar of
  fruit. Lighting that stays put while a sprite rolls needs both, so a sprite's region can now go through a shader as it is drawn.
  It is the same file format as a layer's, with three more inputs: `region` (the part of the image drawn), `turn` (how the image is
  turned on the screen, a rotation or a mirror; `transpose(turn)` takes a screen direction such as "towards the light" into the
  image) and `lookup` (a second image, for a colour table: shading that steps through chosen colours, warmer in the light and cooler
  in the dark, rather than brightening). A record of its own (`SPRITE_SHADED`), not a state record around ordinary ones, for the
  reason blend modes are not on sprites: the frame is sorted by `z` after it is written. `time` is 0 on a sprite, so that a still
  sprite's record can still be copied from the last frame; a shader that moves is given the time in `params`.
- **Lights** (2026-11-15, ABI v12): `<Lighting ambient>` is a `Layer` subclass fixed to `multiply` over the world and `add` among its
  children, cleared to the ambient colour; `<Light radius color intensity>` is a leaf drawn as a native falloff (`TSE_OP_LIGHT`), so a
  light needs no image and looks the same in tests. No shadows: walls do not block light. A light outside a `<Lighting>` is drawn as a
  glow over what is under it, with normal blending (black at its edge, so it is meant for a lighting layer).
- **Flash** (2026-11-16, ABI v13): `<Sprite flash={0.8} flashColor="white">` (and on `<AnimatedSprite>`) mixes the image toward a
  colour, which a multiplying tint cannot: a hit flash. Two numbers, not a colour whose alpha is the amount, so a fade is a number and
  not a hex string built each render. Drawn as the sprite's silhouette laid over it (`TSE_SPRITE_SILHOUETTE`), not a shader, so it
  shows in headless tests and screenshots ([PLAYER.md](PLAYER.md), "Flash").

## Collider shapes (2026-11-15)

`<Collider shape="circle">` is the circle inside its box; `shape="polygon" points={[…]}` a convex polygon in its own pixels, inside
its box. Decided (2026-11-15) as the smaller of two scopes: shapes change what touches, not what stops.

- **Boxes first, then the shape.** The tracker's sweep, its bands, the native broad phase and the incremental update all still find
  pairs by box; a pair in which either collider has a shape is then tested exactly (`shapesTouch` in `collide.ts`, the separating
  axis test in `runtime/src/shapes.ts`), with each collider turned and scaled with its object. Two plain boxes skip it, so a game that
  uses no shapes pays one property read per pair, and a box against a box is still tested upright (its rotated bounds). Against a
  shape, a turned box is exact.
- **Body queries** (`touching`, `overlapping`) filter by shape the same way (`World.tagIn`, `collidersIn`), against the body's box.
- **Decided 2026-11-15: circles and polygons only, for now.** Solid shapes (a body still stops at a solid collider's box: no slopes,
  no round pillars) are not planned until a game needs them. Also not built: concave polygons, and drawing shapes in the debug
  overlay (it draws boxes).

## Custom hooks

"Hooks are compiler intrinsics" extends to the ones an author writes. A function named `use…` (not a built-in hook, not the
game state's store) whose body is what a component body may hold is a **custom hook**, and a call to it that is a statement of a
component body is replaced, before the file is compiled, by the hook's own statements (`hooks/inline.ts`; text to text, so the
rest of the compiler is unchanged and every rule and diagnostic applies to the expanded component):

```tsx
function usePlatformerBody() { const step = useGame((s) => s.step); const s = useMutable({ buttons: 0 }); useInput(…); useUpdate((dt) => { step(s.buttons, dt); }); }
export function Player() { usePlatformerBody(); … }
```

- **Names.** What the hook declares at its top level (its `const`s, its parameters) is given a prefix unique to the call, `_useName3_x`, so two calls make two separate states and nothing clashes with the component's own names. The exception is a hook's own `useMutable` (`const b = useMutable(…)`), named after the hook, `useBody` → `body`, so its state is saved as `Comp.body.x`; a second call, or a name the component already uses, numbers it (`body2`), and a hook named for a keyword (`useDefault`) keeps the prefix. A mutable the hook returns (`return s`) takes the caller's name. Properties, keys and JSX attribute names are left alone; `{ x }` becomes `{ x: _useName3_x }`.
- **Parameters.** A literal argument (a string, number or boolean) is written into the hook where the parameter is used, so a parameter can be a `useSound` path; any other argument is bound with `const _useName3_p = (argument);`. A missing argument takes the parameter's default. A destructured parameter is a diagnostic.
- **Results.** `const v = useX()`, `const { a, b } = useX()` (the hook returns an object literal) and `const [a, b] = useX()` (an array literal) become `const` declarations of the returned expressions. A name the hook declares and returns as it is (`return s`, `return [count, step]`) is not copied: the hook's own declaration takes the caller's name, so a hook can hand back its `useMutable` for the caller to read and write (decided 2026-11-11, for setters then). Anything else returned is a value (a state-derived expression).
- **Where.** In the component's file, or imported from a relative `.tsx` (`import { useClock } from "./hooks.tsx"`, read by the CLI; the hook's imports from the authoring module are added to the file that uses it). Hooks may call hooks, to a depth of six, which also stops recursion. A call anywhere but as a statement of the component body (in a condition, a callback, an expression) is `TSE1101` with the hook's name.
- **What is left.** After expansion the hook's declaration and its import are removed, so a hooks-only file compiles to an empty module. Positions in later diagnostics are those of the expanded text. An unknown `use…` name is left alone, so the retired hooks keep their messages.

The author's editor still sees ordinary typed functions: the file type-checks as written (the hook calls `useMutable` and friends, which throw only if run).

### Hooks that behave like functions, and functions in the body (2026-11-13)

Inlining stays (it is what makes a hook free at run time and lets the compiler see every state it
declares); what a function can do and a hook could not is closed:

- A destructured parameter (`function useMover({ speed, limit: max }: Options)`) binds each name to that member of the
  argument. From an object literal, each member is read where it is written (a literal or an import in place, as a plain
  argument is); from any other value, the value is bound once (`_useMover1_$arg0`) and read member by member.
- A returned name takes the caller's name for `const r = useX()`, as it does for `[a, b]` and `{ a, b }`, so a hook
  returns its `useMutable` (`return s;`) as itself, not a copy.
- **A callback argument.** An argument is bound to a `const` of the component body, and an arrow there is a function of
  the component (below), so `useEvery(1, () => { s.ticks += 1; })` works and the hook calls `fn()` in its handler.
- The recursion message names the chain (`'useA' calls itself through useA → useB → useA`), and the depth limit is 12.

**Functions in the component body.** `const add = (n: number) => { … }` was `TSE1301` ("an arrow function can only be…"); it is
an `OwnFunctionIR`: lowered as a handler (state writes, sounds, actions allowed) with the parameter types written on it
(`paramTypes: "declared"`), and kept in a field, `readonly add = (n: number) => { … };`, written before the element fields so a
child can be given it. A call in a handler or callback is `this.add(…)` (callee `Own`); passed to an element's callback prop it
becomes the arrow an author would write (`onPress: () => { this.press(); }`); passed to a component or a function it is
`this.add`. Calling one while rendering is an error: it may write state. An arrow's expression body that does something (a
sound, action or own-function call, an assignment, `++`) is a statement; any other is the value it returns (`returns: "any"`).

Not done: diagnostics inside a hook still point at the expanded text's mapping, not "the hook's line, called from the component's".


## Component state in saves (2026-11-13)

A save picked from the game state, so state a component kept itself was lost on save, one more reason
the games kept everything in the store. `createSave({ …, tree: true })` keeps the tree too:

- **The game's tree.** `gameTree.ts` holds the world and root the game runs: the player sets it when it mounts the root (and
  again on a hot reload), and `@tsengine/testing` when it renders.
- **Writing.** The entry is `{ version, data, tree }`, `tree` being `captureHotState(root)` (each component's `saveHotState`
  by path) as JSON, without the values that are not plain data (said once, naming each path and field). `pick` and `apply` are
  optional with `tree`.
- **Loading.** `apply` runs first, in the handler that called `load`, then the tree is queued (`queueTreeRestore`); the next
  `World.flush`, once the tree the applied state builds has settled, takes it and runs `restoreHotState`, as a hot reload does.
- **Keys.** A keyed list sets `hotKey` on each item it makes, and a path names such an item by its key (`Pack:0/Enemy[b]`)
  rather than by its place among siblings, so removing an earlier item does not move state between the others. Hot reload
  uses the same paths.

`version` and `migrate` apply to `data`; the tree is restored as it was saved, field by field where a value still fits
(`hotFits`), as a hot reload restores across code changes.

## Testing one component: `@tsengine/testing` (2026-11-13)

A rule is a function, so a test calls it; a component could be tested only by running the whole game
from an input script and reading the game state or the draw records, which alone was a reason to keep logic out of components.
`packages/testing` is a small package over the headless `World`:

- `render(Component, props, options)` resets the game state (`resetGameState`, unless `keepGameState`), registers
  `options.tilemaps`, makes the component and mounts it under a holder entity in a new `World`.
- `step(n)` ticks with no input; `input(script)` parses the script with `@tsengine/player`'s `parseInputScript` (the games' replay
  format), using `options.controls.toJSON()` as its bindings, and ticks once per frame with `createInputState(frame, controls)`,
  so action names mean what they mean in the game.
- `stepUntil(done, { maxSteps?, throws? })` ticks with no input until `done()` holds, asked before the first tick and after
  each, and returns the ticks run. At `maxSteps` (default 3600) it throws, or with `throws: false` returns: tests want the
  failure, a balance run wants the timeout as a result.
- `collide` / `separate` report contacts between one of the component's colliders (by tag) and a collider made for the test
  from `{ tag, data, width, height }` (made once per spec, under the holder); `press` calls `World.reportPress` at a pressable's
  middle; `setProps` calls the generated `updateProps`.
- `send(tag, where, value)` queues a value as a component's `send` does and delivers it at once (`World.deliverSends`), without a
  step, as `collide` reports a contact at once; `place({ …, onReceive })` gives a test's collider a receiver, so a test reads
  what the component sent it during a step.
- `state(component)` reads `saveHotState()` back by source name (`"Enemy.health"` becomes `health`): the accessor tests needed,
  which hot reload already had. `texts`, `find` and `findAll` read the tree.

Every method flushes the world after it, so what a test reads is what would be drawn.

**Whole subtrees that collide** (2026-11-13, for Hearth): with `collisions: true` every step ends as the player's does, with a
`CollisionTracker` over every collider under the holder, so a battle whose shots hit its enemies is tested as one component
(`render(Play, …, { collisions: true })`). `place({ tag, data, x, y, width, height })` puts another collider in the world, each in
an entity of its own (colliders with the same parent are one thing's and never touch); `remove` takes it out. Without the option
nothing collides on its own, and contacts are reported with `collide`. Not done: compiling the component from
its `.tsx` on demand (tests import the generated class, as `game.ts` does). It is packed (`npm run pack`) and a dev
dependency of every new game, whose template tests its `Hero` with it.

## Bodies: `useBody` (2026-11-13)

Collisions are found after every step and reported to `onCollisionEnter` after the step's update
("Why collisions are per step"), so a component that moved itself learned it hit a wall a step late, inside it. Kite answered by
moving in plain functions over the tile grid (`moveActorX` / `moveActorY` with a `blocked(x, y)` the rules write). A body does the
same for a component, against the world it is mounted in:

- `Body` (`runtime/src/body.ts`) is a `PixelActor`: `move(dx, dy)` runs `moveActorX` then `moveActorY` with a `blocked` that
  asks the world, and returns `{ left, right, up, down, tags }`; `touching(tag)` asks whether a collider with that tag overlaps the
  box; `place(x, y)` moves it with no collision. Its box is in its owner's parent's space, offset by the parent's world position
  (not scaled or turned: bodies are boxes on the grid).
- **What is solid.** The `World` keeps the colliders and tilemaps registered in it (`registerObject`), and answers `solidIn(box,
  ignore)`: a solid tile of a `<Tilemap solid>` (its `TileGrid.solidAt`, at the map's world position) or a `<Collider solid>` whose
  box overlaps, not under the body's own component. Both `solid` props default to false.
- **How a body knows its world.** A per-instance object a factory made (`useMutable({ body: createBody(…) })`, a "handle" state,
  marked `handle` in the IR) is listed by the generated `ownedHandles()`; `GameObject.attachToWorld` calls each one's
  `attachOwner(owner, world)` if it has one, and `detachFromWorld` its `detachOwner()`. Any runtime object may use this.
- `useBody` is a shipped hook (`hooks/library.ts`): the body, `x` and `y` in its `useMutable`, and `move`,
  `touching` and `place` as functions of the component (see "Hooks that behave like functions") that move the body and set `x` and `y`. So the component renders where
  the body is, in the step it moved.
- `overlapping(tag)` (2026-11-13, for Hearth's towers): every collider with the tag that overlaps the box, as contacts (`tag`, `owner`, `data`),
  typed by tag through `ColliderData` (`ContactOf<Tag>`; the hook's function keeps its `<Tag extends string>`, as any function of
  a component's own keeps its type parameters). A Hearth tower keeps a body as big as its longest reach and asks it which
  enemies are near; their colliders' `data` say where each is. `World` answers `tagIn`, `solidIn` and `collidersIn` from a cache
  of the colliders' world boxes, made once per update phase (dropped as a tick starts and after each flush): transforms change
  when the tree renders, so a query sees the colliders where they were when the step's updates began, the snapshot every update
  of a step sees. Without it, thirteen towers each composing a hundred enemies' transforms up the tree cost QuickJS a third of
  Hearth's step.

Not done: a body is not itself a collider that others hit (a component draws a `<Collider>` at its position), there are no
one-way platforms or slopes. Kite's `Runner` is written with it beside the rules: see "Kite's movement with `useBody`, compared".

## Balls: `useBall` (2026-11-19)

Colliders only report touching, and a body (`useBody`) is moved by its own component, a pixel at a time, against what is solid. A
pile of things that push each other (fruit in a jar, marbles, a ball pit) needs bodies the world moves together. Jam Jar, a
Suika-like roguelike built on the engine, first wrote its own solver for a jar of fruit; this is that solver, moved into the engine
so each fruit can be a component with its own state.

- **`Ball`** (`runtime/src/ball.ts`) is a handle state, as a `Body` is: `useMutable({ ball: createBall(options) })`, attached to its
  owner's world by `ownedHandles()`, which registers it with `World.addBall` (and `detachOwner` removes it). Its centre is in its
  owner's parent's space, placed by translation only, as a body's box is. A ball inside a rotated or scaled parent is therefore
  not where its picture is drawn; the player says so once (`World.turnedBall`). To draw a leaning jar, keep the balls and the
  solid colliders outside the turned entity and turn what is drawn.
- **When it moves.** `World.tick` steps every ball (`stepBalls`) once, before `beforeUpdate` and the updates, and only when the
  update runs (not frozen, not paused). So every `useUpdate` of a step sees the balls where that step put them, and `useBall`'s own
  update copies the ball's centre into the component's `x` and `y`, which render in the same step.
- **The solver** is position-based (Verlet): a ball keeps its centre and where it was a substep ago. Four substeps a step, each
  moving every ball under its gravity and drag, then three passes of pushing overlapping balls apart (by inverse mass) and out of
  solid boxes. No restitution, so piles come to rest. Being pushed out of a solid adds no speed (only the motion into it is dropped,
  and while pressed into it, `friction` of the motion along it). Being pushed out of other balls is limited to adding
  `BALL_POP_SPEED` (300 px/s) over a step: two balls made in one place pop apart instead of crossing the world, which position-based
  solvers otherwise do.
- **Order and determinism.** The pairs are found by a sweep over x, and the balls are sorted each pass by their left edge, then y,
  then radius: the order depends on where the balls are, not on the order they joined the world. A rewind rebuilds the tree, so
  join order can change between a recording and its replay; the solve order cannot. The ball's fields (`x`, `y`, `px`, `py`,
  `substep`) are plain numbers, copied by snapshots and hot state like a body's.
- **What is solid** is what bodies see: `<Collider solid>` boxes (from the same per-phase index as `solidIn`, by box: shapes are not
  used) and the solid tiles of `<Tilemap solid>`, gathered once per step near where each ball can reach in that step (its speed,
  what popping can add, and gravity). The ball's own component's colliders do not count.
- **`contacts(tag)`** answers the balls with the tag within `BALL_TOUCH_TOLERANCE` (1.5 px) of touching, nearest first, ties by
  place, each `{ tag, data, owner, x, y, radius }`: `data` typed by tag through `ColliderData` (one place where a game declares
  what its tags carry), `owner` named as a collider contact's is, and the centre in the asking ball's parent's space. A type
  argument at a call (`contacts<Data>(…)`) would be dropped by the generator, which is why the data is typed by tag.
- **Pinning and gravity** (2026-11-20). Jam Jar wanted fruit frozen in place (a Snow Pear), a peg in the jar, and fruit that float
  in juice. `pin(on)` holds a ball where it is: `Ball.pinned` gives it no inverse mass in the solver, as a ball of infinite mass
  has, so gravity and other balls do not move it and they are pushed out of it entirely; `push` does nothing to it, and it loses
  its velocity each substep, so it starts from rest when let go. `setGravity(g)` writes `Ball.gravity`, which the step already
  read each time: 0 hangs a ball, a negative one floats it. Both are plain fields, kept by snapshots and hot state.
- **A sideways pull.** `gravityX` is to the right what `gravity` is down, added in the same line of the substep; the hook's
  `setGravityX` sets it, as does `setGravity`'s optional second argument. Jam Jar's Tilted jar is a jar drawn leaning whose fruit are pulled along its floor.
- **Sticking** (2026-11-19, for Jam Jar's honey). `stick(tag)` adds every ball with that tag touching this one to its `stuck` set,
  and itself to theirs. In each solver pass, after the balls are pushed apart, each stuck pair further apart than touching is
  pulled back together along the line between them, by mass, as the pushing apart is: so a stuck lump is a set of balls that
  can roll round each other but not part. The pairs are taken in the sorted order of the pass, so a stuck pile does not depend
  on the order its balls joined. Nothing is done for it when no ball is stuck. The set is not a plain field: a snapshot or a hot
  reload does not keep it, so a component that wants to stay stuck calls `stick` every step, which is also how it catches what
  comes to touch it later. There is no rod (a fixed distance apart) or rope yet.
- **Cost.** Each pass sorts the balls and sweeps them, so a pile of n balls costs n log n plus the touching pairs, twelve times a
  step: a settled jar of 60 balls takes about 0.08 ms a step and a pile of 300 about 0.4 ms under Node (a 4-core cloud VM,
2026-11-19). `contacts` scans every ball, which is fine for a jar; a crowd of
  balls asking for contacts every step would want the grid the colliders use.

Not done, on purpose until a game needs it: bounce (restitution), rotation and rolling, friction between balls, balls that colliders
see, shaped solids, and boxes or polygons as bodies the solver moves.

## Finding and hitting colliders: `nearby` and `send` (2026-11-17)

A component has no handle on another (on purpose), so a tower defense's moves reached enemies through colliders made for
it: a creature kept a body as big as its reach to see enemies (`overlapping`), handed each landing move up to its parent, which
drew an effect whose `<Collider>` existed for one step with the blast as its `data`; every enemy it touched checked whether the
blast was meant for it (a target id, or a distance, the collider being a square) and took the damage, a step after the move
landed. Two functions of the component replace that, still through colliders:

- `nearby(tag, x, y, radius)`: the colliders with the tag whose world boxes come within a real circle, nearest first (by the
  distance from the point to the box, 0 inside it; ties in the order the colliders joined the world), each its contact (`tag`,
  `owner`, `data`, typed by `ColliderData` as `ContactOf<Tag>` is) with the middle of its box and that distance. It reads the
  same per-tag grid and per-phase box cache `useBody`'s queries use, so it costs what `overlapping` costs and sees boxes where
  they were when the step's updates began. It leaves out the colliders the asking component draws itself (the nearest component
  at or above a collider, a compiled component's class having no own `intrinsic`), not those of components inside it: a parent
  may ask about its children's colliders. Both hosts run it in JavaScript, so their results are identical.
- `send(tag, where, value)` queues `value` for the colliders with the tag in a circle (`{ x, y, radius }`, resolved as
  `nearby` resolves it) or for the one collider a `nearby` result is. A result keeps its collider in a `WeakMap`, so results stay
  plain objects, and one kept past its world, or whose collider left, reaches nothing. Addressing by a result rather than by an
  id in `data` needs no convention about `data`, and cannot reach a different collider that happens to carry the same id.
- `<Collider onReceive>` is called with each value. Its type is the tag's `ColliderMessages` entry, declared beside
  `ColliderData`; `ColliderProps` and the `Collider` class take the tag as a type parameter, the generator names a literal tag in
  an element's field type (`Collider<{}, "foe">`) and in a `<Collider>` root's `extends`, and the manifest marks the parameter
  `contextual`, so the generated callback is left unannotated and typed from the props. `onReceive` is typed as a method so a
  collider of one tag is still a `Collider`.

**When it is delivered** (decided 2026-11-17). At the end of the step's update phase, after every `useUpdate` and timer, before
the step renders: so it lands in the step it was sent, with no step of delay, and what a receiver changes is drawn that step.
In the order sent (handlers run in tree order, so the order repeats), each send's receivers nearest first. A value sent from an
`onReceive` joins the end of the queue and is delivered in the same phase; past 100,000 deliveries in one step it throws, as only
receivers sending to each other without end get there. A value sent outside a tick (from a collision callback, which the player
runs after the tick) waits for the next step's phase. It runs while the world is frozen or paused, as collisions do, since a send
from `useInput` should still land. Delivery is in `World.tick`, so the Node player, the Rust host's QuickJS and
`@tsengine/testing` all deliver at the same moment without a call of their own.

## Tilemap, assets and the other built-ins

`<Tilemap>`, `<Particles>`, `<Fade>`, `<Music>`, the `<Camera>`, `<Sprite>`, `<AnimatedSprite>` and `<Text>` props, `fixedStep` and `gamepadDeadzone` on `<Game>`, and `freeze()` are described where they act, in [PLAYER.md](PLAYER.md). On the compiler side each is a manifest entry (`intrinsics`, `intrinsicMembers`, `intrinsicRequired`, `intrinsicHooks` for those that override `onUpdate`, `intrinsicLiterals` for `Particles.space`, `functions` for `freeze`) plus `jsx.ts` declarations; no compiler code was needed for them. A `useSound` play function takes an optional volume, lowered to `.play(volume)`.

**Build-time asset check.** `tse-compile --assets <dir>` (`checkAssets`, `TSE1211`) reports every literal image, font, music file and `useSound` path that is not a file in the folder, with the nearest file name; literals inside conditionals and arrays are found (`frames={on ? [...] : [...]}`), computed paths are not. The files of a `createSounds({ … })` (a plain `.ts` module, found by scanning the source folder; `checkSoundStores`) are checked the same way, as a name or `{ src }` written as a literal. `npm run check:<game>` passes `--assets` when the package has an `assets/` folder.

## Props and callbacks

A parent passes values and callbacks to a local or imported component. A changed
value updates the existing child instance in place; the child is never recreated.

```tsx
interface EnemyProps {
  speed: number;
  tint?: "red" | "blue";
  onDefeated?: () => void;
}

function Enemy({ speed, tint = "red", onDefeated }: EnemyProps) {
  const s = useMutable({ hp: 3 });
  useUpdate(() => { if (s.hp <= 0) onDefeated?.(); });
  return <Entity name="Enemy"><Sprite image={tint === "red" ? "red.png" : "blue.png"} /></Entity>;
}

function Level() {
  const s = useMutable({ score: 0 });
  return (
    <Entity name="Level">
      <Entity x={40}>
        <Enemy speed={s.score > 10 ? 2 : 1} onDefeated={() => { s.score += 1; }} />
      </Entity>
    </Entity>
  );
}
```

**Declaring props.** One parameter, destructured, annotated with the name of
an `interface` or `type` object type in the same file (`TSE1208` otherwise: no
rest, nesting, generics or `extends`). A prop may be renamed (`{ seed: firstSeed }`, 2026-11-15): the
binding keeps both names (`PropBindingAnalysis.name` and `local`), the scope declares the local one and every read is
the prop's (`PropRead`), so a prop and the state it seeds can share a word. Defaults in the destructuring make a
prop optional and must be constants. `key`, `ref`, `transform` and `children`
are reserved and cannot be prop names. The declaration is copied into the
generated module as written (exported), so the type-check validates it. Each
member is also described structurally (`PropDeclIR`: name, optional, default,
role, and a `PropTypeIR` of number/string/boolean, literal unions, arrays,
function or source text) so a scene schema (M6) needs no type checker.

Whether a prop is a value or a callback is decided by its type: a function type or method
signature is a callback, anything else a value. A value reads as `this.props.x`
(`PropRead`). A callback is only called (`onDefeated?.()`, `CalleeIR` `Prop`)
or forwarded whole (`onDone={onDone}`); reading it as a value, or calling a
value, is `TSE1301`.

The child's class extends `Entity<EnemyProps>`, so `this.props` is
available to field initialisers, which run right after `super()` returns:

```ts
export class Enemy extends Entity<EnemyProps> {
  constructor(props: EnemyProps) {
    super({ name: "Enemy" }, props, { tint: "red" });   // props and defaults, copied by the runtime
    …
  }
  updateProps(next: Partial<EnemyProps>): void {
    if (this.applyProps(next, { tint: "red" })) this.markDirty();   // === per key; an undefined update restores the default
  }
}
```

When every prop is optional the constructor parameter defaults to `{}`, so a
parent may write `<Badge />`.

The parent builds the child with every value prop (static or dynamic) and
its callbacks in the constructor call, and re-sends only the dynamic ones, in
one call, from `render()`:

```ts
readonly enemy: Enemy = new Enemy({ speed: (this.$s_score > 10) ? 2 : 1, onDefeated: () => { this.$set_s_score(this.#$s_scoreNext + 1); } });
…
this.enemy.updateProps({ speed: (this.$s_score > 10) ? 2 : 1 });
```

A changed prop marks the child dirty, and it renders in the same `World.flush()`
as the parent: one render each, same instance. A callback is an arrow created
once in the field initialiser, so it reads state through `this` and never goes
stale; it is therefore never re-sent. Its parameters are unannotated
(`Contextual`), so TypeScript types them from the child's props type, which the
parent (compiling one file at a time) cannot see. A function passed to a
built-in, `key` and `children` are errors (`TSE1203`, `TSE1202`).

**Reads.** A prop may be read in JSX, conditions, derived values, handlers,
transform props (`x={speed}`), and the initial value of a `useMutable` field (read once,
at construction, as in React); a field initialised from a primitive prop
takes its type from the prop's declaration.

**Placement.** A parent places a component by an `<Entity>` around it:
`<Entity x={200}><Mover /></Entity>` starts the mover at 200, and it moves from
there; nothing can conflict, because the wrapper and the child write different
transforms. `global` works at either level. A `transform` attribute is `TSE1207`
(2026-11-17; before, it set the child's `placement`). `placement` stays on every
object, under its own `transform` (`world = parent × placement × transform`), for
scenes, which place prefabs by data. `key`, `ref`, `transform` and `children` stay
reserved prop names.

**Layout offset.** A third writer comes before both: `layoutX` and `layoutY`,
a position the player's layout pass writes into an object a layout container
places (`world = parent × layout × placement × transform`). `<Flex>` writes it
(see [LAYOUT.md](LAYOUT.md)). Like placement, it cannot
conflict: layout decides the slot, and the object's own `x`, `y` and the rest nudge it
within the slot, as CSS's `transform` does. Both names are reserved members.

`children` is passed between elements, `<Panel>…</Panel>`: see "Children".

### Spread props (2026-11-11)

`<Enemy key={e.id} {...e} />` and `<Box {...o} x={9} />`: on a component element an attribute may be a spread of any expression the
compiler can read (state, a prop, the list item, a game-state selection). `PropIR` has `SpreadPropIR { value, dependencies }`; the order
among the props is kept, so a later prop wins, as in React. The generated code spreads for real: `new Enemy({ ...(e) })`, and a render
sends `updateProps({ ...(e) })`. TypeScript checks the object against the props type, the source type-check reports a missing prop at the
author's line, and the runtime's `applyProps` compares key by key, so a render marks the child dirty only when a value changed: in a list,
only the items whose object was replaced (an immutable update) re-render. A spread that reads nothing is applied at construction only. When
a spread is among the props, `updateProps` carries every value prop, in order, so a named prop after the spread still wins on update
(callbacks are made once and are not re-sent). A spread in a list item reads the item and gets the `Item` dependency.

Not supported: a spread onto a built-in (`<Shape {...p} />`): its render writes each prop to a field one by one, so a spread needs the
keys, from the manifest's `intrinsicMembers`. It is `TSE1203` with that reason, until a game spreads onto a built-in (Hearth does not).
`<Box x={5} {...o} />` is TypeScript's own error (`x` is overwritten) when `o` always has `x`.

### Constants, helpers and index reads beside components (2026-11-11)

A component file may hold top-level `const` values and lower-case `function` helpers, as a React file
does: `const ROW = { bolt: 0, mortar: 1, frost: 2 } as const;`, `function labelOf(kind, n) { … }`. The analyzer keeps each as a
`ModuleDeclaration` (its text and the names it mentions), the generator copies it into the module before the components (importing
what it reads from a `.ts` file or the runtime), and components read it like a plain import, in JSX, lists, derived values and
handlers. One that holds JSX or reads the game state is `TSE1001` (that belongs in a component); `let` is `TSE1001` (a value that
changes belongs in state). Render expressions may index (`ROW[kind] * 3 + level`, `pads[cursor]`, `found?.[i]`; `IndexRead`) and
use TypeScript's `!` (`NonNull`, so the generated code type-checks as the source did). `Math.PI`, `Math.E` and `Math.SQRT2` are
values, and `atan2`, `atan`, `tan`, `pow`, `hypot` and `trunc` are among the allowed `Math` calls.

## Roots and component forms

**Forms.** A component is a `function` declaration or a `const` arrow
function; either may be `export`ed, and one per module may be the default
export (`export default function Enemy() {}`, or `export default Enemy;`
after the declaration). A default export needs a name, because the generated
class has one. The importer picks the local name: `import Monster from
"./Enemy.tsx"` (alone or with `{ Boss }`) puts `Monster` in the generated
import and in `new Monster(…)`, and the generated module ends with
`export default Enemy;`. An arrow with an expression body is its return.

**Props as an object.** `function Enemy(props: EnemyProps)` reads each prop as
`props.speed` and calls callbacks as `props.onDefeated?.()`; the bare `props`
cannot be used (no passing it on, no spreading). It lowers like
destructuring, but there is nowhere to write a default, so none is applied.
Every member of the props type is a prop.

**Roots.** The root is a built-in element, and the generated class extends it:

```tsx
const Coin = ({ value }: CoinProps) => <Sprite image={value >= 5 ? "gold.png" : "coin.png"} />;
```

```ts
export class Coin extends Sprite<CoinProps> {
  constructor(props: CoinProps) {
    super({ image: undefined as never }, props);   // a dynamic required prop: a placeholder here,
    this.render();                                  // its real value in the first render
    …
```

so a coin is a `Sprite`, with no container around it, and a parent places it
like any component. Details:

* A fragment root `<>…</>` is an implicit `Entity` with no props, and needs no
  `Entity` import because the author never wrote it.
* Every built-in passes `(hostProps, props, defaults)` up to `GameObject`,
  which owns `props` and `applyProps`, so any of them can be a root with props.
* A built-in constructor may require a prop (for example `Sprite.image`, `Collider`
  `width`/`height`; the manifest's `intrinsicRequired`). `super()` runs before
  state exists, so when such a root prop is dynamic it gets `undefined as never`
  there and its real value in the first `render()`, which the constructor runs.
* The class has the root's own fields (the manifest's `intrinsicMembers`) and every object's (`reservedMembers`). A
  state or sound whose name is one of them is kept in a field named `$name` instead, and its setter in `$setName` when
  that is one (`claimField`, 2026-11-13): the author writes `name`, the generated code reads
  `this.$name`, and the entity's own `name` is untouched. Props cannot clash: they live in `this.props`. Before, such a name
  was `TSE1103`, a rule that followed from code the author never sees. `$` names are the compiler's own. Private fields
  (`#name`) were the plan's first idea; they would have hidden state from the tests and tools that read a component's state
  from outside, so only the names that clash are renamed.
* Only containers (the manifest's `containerIntrinsics`, today `Entity` and `Camera`) may
  have JSX children; a child under a leaf such as a `Sprite`, `Collider` or `Pointer`, at the root or
  anywhere, is `TSE1202`. A fragment nested as a child is an implicit `<Entity>`. A component, a condition or `null` as the
  root is "Component, condition and null roots" below.

### A root named after its component (2026-11-13)

A root `<Entity>`, `<Game>` or fragment (and the container a component or condition root is held in) with no `name` prop gets
the component's name in its `super()` call: `function Player() { return <Entity>…</Entity>; }` generates
`super({ name: "Player" })`, the same as `<Entity name="Player">`. A written `name`, static or dynamic, wins. Nested
entities are not named. Every game wrote the component's name again on its root, and `name` is
what a collision's `other.owner` reads, so leaving it out used to change game logic without a sign in the source. The games,
the template and the guide no longer write it. Only `Entity` and `Game` take a `name` (`NAMED_ROOTS` in the generator).

### Component, condition and null roots (2026-11-11)

`return <Panel title="BUILD">…</Panel>`, `return on ? <Sprite …/> : null`, `return open && <Menu />` and `return null` are
accepted (they were `TSE1003` / `TSE1002`; found by Hearth). The component's class extends the host
intrinsic (`Entity`), holds that one child (or the condition's children, as `{…}` children are), and sets
`override readonly layoutContents = true`. `GameObject.layoutContents` is CSS's `display: contents` for `<Flex>` layout: a
`Flex` lays out such a child's children as its own (`FlexBox.kids`, flattened in `#measureChildren`; when no child is see-through,
`kids` is `children` itself, so the no-allocation path is unchanged), and a `Flex` under one is not a layout root. So
`BuildMenu` returning `<Panel>` inside the side panel's column still grows to the column's width. The wrapper sits at its
parent's origin; an `<Entity x y>` around such a component moves what it holds.

**Element callbacks.** `<Pointer onPress={() => …} />` is the same mechanism with no parameters.

**Keys that press things** (2026-11-11, from the second review of Hearth). `pressKey="wave"` on a `<Pointer>` or a `<Flex>` presses it
(calls `onPress`) when that key or action is pressed, while it is mounted and not inert: the DOM's `accessKey`, so a button owns its
shortcut and a key and a click take one path. `World.tick` does it before any `onInput`, over every `Pointer` and `Flex` in the world
(scratch lists, so nothing is allocated per tick once warm). Every mounted pressable with that key is pressed.

**Focus** (same day). `focusable` makes a pressable take the focus, as a DOM button does; `autoFocus` takes it on mount when nothing has
it; `onFocus` / `onBlur` say so. Each tick the direction actions `left` `right` `up` `down` (the arrows and the d-pad when the controls
have no such action: `InputState.isAction` tells) move it to the nearest focusable that way, measured from `focusPoint()` (a Pointer's or
a laid-out box's middle; along the direction, plus twice the distance across, so a row before the next row), and `confirm` (Enter and PadA
without one) presses the focused one. A click on a focusable one focuses it before pressing it. `World.focus(p)` / `World.focused` for
code. One focused or removed, inert or no longer focusable, loses it; the next tick an `autoFocus` one may take it.

**One mistake, one error, through an inlined hook** (2026-11-15). A custom or library hook is inlined text, and every error
found inside its expansion maps back to exactly the call's range. Without a filter, a bad argument (`useBody({ x: nowhere })`) is
the first error, and then the hook's own body fails for it: `'move' is not a method`, `'touching' is not an allowlisted call`,
about names the author never wrote. `expandCustomHooks` returns each call's range in the original text, and `compile` keeps only
the first error on each (`oneErrorPerHookCall`); warnings, and errors anywhere else, are kept.

**Buttons, menus and `onAdjust`** (2026-11-15). Every game had written its own menu: a cursor in state, `useInput` reading up and down,
a bar behind the row under the cursor. The focus already did that, so three small additions put it to work. `<Button>` is a `Flex`
with defaults (`BUTTON_DEFAULTS`: focusable, padded, centred, a colour for each state) that any prop overrides; it adds no field.
`<Menu>` is a `Flex` (a column by default) that scopes the focus: from an item inside a menu, a direction looks only at the menu's own
items (`menuOf`, the nearest `Menu` up the parents), and finding none it goes round to the farthest the other way (`loop`, default
true), so the focus never leaves the menu by the keys; `back` (or Escape and PadB) calls its `onBack`. `onAdjust` on any `Flex` is
`onNavigate` for left and right: called with -1 or 1 and used up, so a settings row changes its value in place, as a slider does.
And focus taken by a modal is put aside (`#focusBeforeInert`) and given back when the element can take it again, before any
`autoFocus`, as a browser does when a dialog closes: without it, Bramble's key prompt sent the settings cursor back to the top.

Adding built-ins called `Button` and `Menu` would have broken every game with a component of either name (`TSE1206`), and so would
any later built-in. So a name is scoped as in React: a component declared in a file, or imported from another, shadows a
built-in of that name, and `TSE1206` is only for a file that also imports the built-in (or names a component `Entity` or `Game`,
whose tags the compiler always reads as the built-ins).

**Inert and modal** (2026-11-12: nothing let a component own or consume the keys). Input stays polled;
these props decide who hears it, by subtree as in HTML. `inert` and `modal` are accessors on `GameObject` and props of
`<Entity>`, `<Flex>` and `<Hud>` (`InputScopeProps`), so a component puts them on its root (`<Entity inert={disabled}>`) and they
follow state like any prop. `inert` was already the router's mechanism (`World.setInert`, used on a screen being left); the prop
calls it when set and when the object joins or leaves a world. `modal` calls `World.setModal`, which keeps a stack in mount order;
the last modal still in the world is `World.modal`. `World.isInert(object)` holds when the object is in an inert subtree, or when a modal exists and the
object is not inside it (ancestors included, as a dialog's page is). Everything that asks `isInert` follows: `onInput` and
`onUpdate` get `NO_INPUT`, presses and hover skip it, `pressKey` and the focus look only at pressables that are not inert, so the
focus stays inside a modal and leaves what it made inert. A modal is pushed before its children attach, so an inner modal is above
an outer one. `inert` and `modal` are reserved member names; they are not in `intrinsicMembers`, which lists what an intrinsic
adds to `GameObject`.

Bramble is the first user: the pause screen is a `modal` component that closes itself on Escape (the play screen behind it no
longer hears the keys, so its `if (paused) return` in `useInput` went), and a settings row waiting for a key mounts `KeyPrompt`, a
modal with no children, so `Menu` lost its `disabled` prop. Not done: a per-key "consume" (`input.consume("confirm")`) inside one
subtree, which no game has needed beside these two.

**Small things the same review found.** `<Pointer originX originY>` places the area's origin as a Sprite's does (a pad's 10 × 10 area
centred on it). A bitmap-font `<Text>` without a `size` is drawn at the font's own cell height (`Text.sized`; setting `size` to
`undefined` goes back to that). `controls.label(action)` names the first key for a label (`"Space"`, `"Esc"`, `"Left"`). The generated
`tilemaps.ts` registers its maps as it loads, and a component module that draws a `<Tilemap>` imports it, so a game needs no
`registerTilemaps` call. A component may import types from a `.ts` file (`import type { Tower as TowerData } from "./rules/battle.ts"`,
`import { type Kind }`); the generated module imports the ones it mentions as types.

**Hover** (2026-11-11). `<Pointer>` and `<Flex>` take `onPointerEnter` and `onPointerLeave`, the DOM's
`pointerenter` / `pointerleave`: each frame the player finds the topmost pressable under the mouse (last frame's draw order,
the same search a press makes) and `World.reportHover` tells the one before it left and the new one it was entered; an inert one
counts as none, and a mouse off the screen is over nothing. Each pressable is asked where it is, which means where its parent
is: neighbours in the list with one parent (the tiles of a board) share that answer (`containsIn`), so a board of 180 tiles
walks up the tree once a frame, not 180 times. A `<Flex>` with only hover callbacks is collected for the mouse but
lets a press through to what is under it. State is the component's: `onPointerEnter={() => { s.hovered = true; }}`.

**Functions passed whole** (2026-11-11). `onPress={resume}` where `resume` is a game-state action: to a built-in, the
compiler writes the arrow the author would have (`() => useGame.getState().resume()`), with the parameters the manifest lists;
to a component, an action is the store's own function (`ActionRef`), a static prop, since an action never changes. A sound is
not a value. `<Flex onPress={onPress}>` where `onPress` is the component's own callback prop (or `props.onPress`) is the prop
itself, a dynamic prop read on render (2026-11-21; it was an arrow calling `this.props.onPress?.()`, which made every box that
forwarded an optional callback pressable, so it took presses and the mouse whether or not one was passed).

**A choice of callbacks** (2026-11-21). `onPress={open ? close : undefined}`, nested choices too: each branch is lowered as
the attribute would be alone (an arrow to a `Callback` expression, a callback prop to `PropRead`, a function of the component's
to `this.field`, an action to `ActionRef`, `undefined` or `null` to `undefined`) and the choice is a dynamic prop, worked out
again when what it reads changes, so a built-in has no handler while the branch taken is none. Its condition may test a
callback prop by its truth (`onGo ? … : …`, `!onGo`, `onGo && onStop`) as well as against `undefined`. A branch the condition
proves a callback prop was passed in (`onGo === undefined ? undefined : () => onGo()`) marks its calls of that prop `present`,
written `this.props.onGo!()`: inside the arrow TypeScript no longer sees the narrowing of `this.props.onGo`, which the source's
parameter keeps. A call the condition does not prove stays a type error. To a component each branch is passed whole: an arrow
there would be typed by the component's props, which the live-prop getters cannot see, so it is declared in the body instead.

**Collider callbacks.** `<Collider width={16} height={24} onCollisionEnter={(other) => …} />`
is a callback prop on a built-in, which the manifest lists in
`intrinsicCallbacks` along with its parameters (`other: Contact`, a handle
type; see below). It lowers to the same `CallbackProp` a component receives, with
annotated rather than contextual parameters, and the runtime calls the
collider's own callback (see "Collisions"). On a child element it is created in
the field initialiser. On a root it is assigned after `super()`
(`this.onCollisionEnter = …`), because an arrow that uses `this` cannot be made
inside the call to `super`. A function on any other built-in, or an unknown
callback name, is `TSE1203`.

**What `other` exposes** (decided 2026-11-09; `data` 2026-11-13). `other` is a `Contact`: handler
code may read `other.tag` and `other.owner`, both strings, and `other.data`, and nothing else
(`'Contact' has no readable property 'width'`, `TSE1301`). The compiler checks
the comparison like any other string.

* `data` is the `data` prop of the other `<Collider>` (any value; undefined when it has none), so a
  coin says what it is worth and an enemy how much it hurts without the game state keeping a table by id.
  Its type: `Contact` is `BaseContact` (`data: unknown`) until a game declares
  the global interface `ColliderData` (`declare global { interface ColliderData { coin: { value: number } } }`),
  then a union with one member per declared tag, so `other.tag === "coin"` narrows `other.data` in the
  generated code as in the source. A global interface rather than an augmentation of `@tsengine/runtime`, because
  TypeScript does not merge an augmentation into an interface that a module only re-exports. The `Collider`
  class implements `BaseContact`; the world casts it when it calls a callback.

* `tag` is the `tag` prop of the other `<Collider>` (`""` when it has none).
  It tells two colliders on one prefab apart, which the owner cannot.
* `owner` is the `name` of the nearest `<Entity name>` at or above the other
  collider, or, when none is named, its class name. It needs no prop, so a game
  can start with it, but renaming an entity changes game logic.
  A component's root `<Entity>` with no `name` is named after the component
  (see "A root named after its component"), so `owner` is the component's name
  unless the author wrote another.
* A `<Collider>` also takes `layer` (a string, default `""`) and `hits` (a list
  of layers, default: every layer). A pair is tested only when **each** side's
  `hits` allows the other's `layer`, so a bullet that hits only enemies ignores
  other bullets, and an enemy that left `hits` out still cannot touch a bullet
  that does not hit enemies. Filtering happens in the tracker before a pair is
  recorded, so a skipped pair costs no callbacks and no exit events.
* `onCollisionExit(other)` takes the same `Contact`. It fires once when a pair
  stops touching, because the boxes moved apart, a collider left the world, a
  collider lost its area, or the two layers stopped matching. The collider that
  itself left the world is not called (it is gone); the one still mounted is.
  Exits are reported before enters in the same frame.
* The members are the manifest's `Contact` handle type, `intrinsicMembers.Collider`
  lists the fields, and the runtime's manifest test keeps both honest.

## Code generation

Generated output for the example above (abridged):

```ts
export class Player extends Entity {
  $s_health: number = 100;
  readonly sprite: Sprite = new Sprite({ image: (this.$s_health > 50) ? "normal.png" : "hurt.png" });
  warningIcon: WarningIcon | null = null;
  constructor() {
    super({ name: "Player" });
    this.addChild(this.sprite, 0);
    this.render();
    this.commitStructure();
  }
  $set_s_health(value: number): void { … this.markDirty(); }
  override render(): void {
    this.sprite.image = (this.$s_health > 50) ? "normal.png" : "hurt.png";
    if (this.$s_health < 25) {
      if (this.warningIcon === null) { this.warningIcon = new WarningIcon(); this.queueAddChild(this.warningIcon, 1); }
    } else if (this.warningIcon !== null) {
      this.queueRemoveChild(this.warningIcon);
      this.warningIcon = null;
    }
  }
}
```

Decisions:

* **String emission via a small indenting writer, not `typescript/ast/factory`.**
  The factory builds nodes locally but printing goes through the remote
  printer, and the factory API is large and still moving in 7.x betas. A writer
  keeps the generator synchronous, dependency-free and easy to read. Every
  compound sub-expression is parenthesised when emitted from `ExprIR`, so
  precedence can never be wrong. Correctness is enforced by type-checking the output with the
  real compiler. Revisit if we need source maps (the factory/printer route
  would give them for free).
* **Static children are `readonly` field initialisers**, so "never recreated"
  is enforced by the type system, not by convention alone.
* **Conditional children are nullable fields**; descendants of a conditional
  are nullable too and are created together when it mounts and nulled when it
  unmounts.
* **Dynamic props are plain assignments** to the existing instance
  (`this.sprite.image = …`). The runtime's intrinsics expose their props as
  public fields, and the type checker validates prop names and types.
* **Structural changes are queued** (`queueAddChild` / `queueRemoveChild`) and
  applied by `World.flush()` after all dirty objects have rendered, so render
  never mutates the tree it might be iterating.
* **Children keep source order.** Child order is draw order. When a parent has
  a conditional child, every child is attached with its *slot* (its index in
  the parent's JSX children: `addChild(child, 0)`, `queueAddChild(child, 1)`),
  and the runtime inserts after every sibling with a lower or equal slot, so a
  conditional that mounts later lands between its source siblings instead of
  at the end. Children attached without a slot (`World.mount`, later scene
  loading) go after all slotted ones. Parents with only static children pass
  no slot: appending in source order is already correct. A keyed list's
  items share the list's slot and are ordered within it (`(slot, order)`, see
  "Keyed lists"). The constructor runs `render()`
  then `commitStructure()` so a freshly constructed object is complete.
* The generated class extends the root element's runtime class (`Entity` for
  an `<Entity>` or fragment root, `Sprite` for a `<Sprite>` root, …), not bare
  `GameObject`, because the root's props (e.g. `name`) belong to the instance.

## Runtime manifest

`packages/runtime/src/manifest.ts` exports `runtimeManifest`, the one place
that says what the runtime provides: the intrinsic tag names, the host
intrinsic generated classes extend, the member names of that class that
generated fields must not shadow (`reservedMembers`), the handle types handler
parameters may have (`InputState`, `GameObject`) with their readable members,
the runtime functions handler code may call (`clamp`), and which built-ins take
their JSX text as a prop (`textContent`), which of their props take one of a
fixed set of strings (`intrinsicLiterals`), and which hooks they implement
themselves (`intrinsicHooks`, so a component rooted at one calls `super`). The compiler takes
it as `CompilerConfig.manifest` (default: the runtime's own), so adding an
intrinsic or a handle type is a runtime-only edit. A runtime test fails if a
member inherited from `Entity` is missing from `reservedMembers`. The `Math.*`
allowlist is language-level and stays in the compiler (`transform/handles.ts`).

## Components across files

The analyzer records relative `.tsx` named imports; the transform resolves a
tag to `Intrinsic`, `Local` or `Imported { name, module }` (name clashes between
the three are `TSE1206`). The generator imports each name once per module and
rewrites the specifier to the generated file (`./WarningIcon.tsx` →
`./WarningIcon.ts`). The CLI compiles every file in a directory and type-checks
all outputs together, so a broken cross-file reference is caught there. A
parent needs nothing about an imported child's props: it passes what it writes,
and the project type-check validates it against the child's own props type (a
missing or mistyped prop is `TS2741` / `TS2322` in the generated parent).
Static cycles through several files (`A` contains `B` contains `A`) are found
by the CLI's whole-project check, which follows imports (`TSE1205`); the
transform still reports the ones inside a file. Only static containment
counts: a component that mounts the other conditionally is fine.

## Runtime

`packages/runtime` holds `GameObject` (tree, transforms, dirty flag, queued structure ops, passed-children slots, hook methods),
`World` (dirty queue, `flush`, `tick`, `reportCollision`, `reportPress`), the built-ins with public prop fields, `Sound` (which
reports to the sink a player installs), the game state, saves, `loadScene`, input helpers and the manifest. It has no rendering,
physics, input or audio backend of its own: that is the player's (see "Player" and [PLAYER.md](PLAYER.md)). The compiler only knows
what the manifest tells it.

`commitStructure()` also settles children it has just attached, so a freshly
constructed object whose nested conditions are true has its whole subtree
attached without a `World`.

## Player

`@tsengine/player` ([PLAYER.md](PLAYER.md)) is the pure-TypeScript half of the native
player. It draws nothing itself: it turns the object tree into one flat buffer of draw records per
frame, hands it to a `Backend` (a window, or a test recorder) and feeds the backend's input back to the
game. It imports nothing from Node, so it also runs in the embedded JavaScript engine of the shipped
executable. The record layout and the input buffers are `native/include/tse.h`; `protocol.ts` mirrors
it and a test keeps them equal.

```ts
run(hostBackend(), { root: () => new Main() });   // a root that is a <Game> carries its own window settings
run(hostBackend(), { width: 800, height: 600, title: "My game", root: () => new Level() });  // any other root, configured here
```

**Startup.** The root is built first, with the window still closed, because a root that is a `<Game>` says what window to
open (see "Game"). Sounds made while it is built only record their paths; once the window is open they are preloaded
through the backend, so a sound still never hitches on its first play. Then the window opens, the tree is mounted
and the first frame is drawn. A root that throws opens no window, unless errors are shown in the window (below). Each setting
is the `<Game>` prop where it is written, else the `PlayerConfig` field, else the default (640 × 360, title
`"tse"`, background black, assets `"assets"`); `hidden` is the player's alone.

**Errors in the window** (2026-11-11). With `showErrors`, an error thrown while building the root, mounting it or in
a step does not close the window: the player stops stepping the world and draws the error instead, on a dark red background in
window pixels: a heading, `Name: message`, the stack (dimmer, wrapped to the window, cut with a line that says so), and a note
at the bottom ("Close the window to quit."). `player.failure` holds the error while it is shown. `run` turns this on for a
visible window and, once the window is closed, throws the error, so both hosts still print it and exit with status 1. A
`hidden` window, and `createPlayer` unless asked, throw at once, which is what tests, tools, the parity runs and CI
want. Because the error screen is drawn by the TypeScript player through the ordinary draw records, the Rust host needs no
change. A host can also show its own error (`player.showError(error, note)`): the Node launcher shows a compile error this way.

**Hot reload** (2026-11-11). `player.reload(config)` builds `config.root` again, from a newer build of the game's
classes, and puts it in place of the current root in the same window and world. What carries over:

- **Each component's own state.** The compiler gives a component with `useMutable` state a `saveHotState()` (its values by
  their IR ids, `"Coin.taken"`, the pending value a setter wrote included) and a `loadHotState(saved)` that writes them back as a
  setter would and marks the component dirty. `captureHotState(root)` collects them by **tree path**: each object is named by its
  class and its index among its siblings of that class (`Main/Level:0/Player:0`), so a component keeps its state when the code
  around it changes, as long as it is still the n-th of its kind under the same parent. `restoreHotState(world, root, saved)` goes
  parents first and flushes the world after each level, so a child that exists only because of its parent's state (a condition
  that was true, a list) is built before it is looked for. A value whose kind changed (a number that became a string), a game
  object, and a function are not kept (`hotFits`): the new initial value stands.
- **The game state**, by the host: `GameStore.carryFrom(older)` takes the older store's values where they still fit (a key that
  is gone is dropped, a new key keeps its initial value, a leaf whose type changed keeps the new one) and the new build's
  actions, before any component reads it.
- **Not kept:** a built-in's internal state (an animation's frame, a camera's slide, particles in flight), and module-level
  variables in plain `.ts` files. The window's settings stay as they were opened; the controls come from the new root.

A reload that fails (the new root throws while it is built or mounted) shows the error and keeps the state of the last good tree
for the next try, so fixing the bug brings the game back where it was. A crash in a step leaves the world as the error found it,
and the next reload takes its state from there. How the Node launcher gets a newer build is in [PLAYER.md](PLAYER.md)
(`packages/player-node`).

**Reusing draw records** (decided and built 2026-11-10). Most objects stand still in a given frame, and walking them is most
of a frame's script time. So `FrameBuilder` keeps last frame's world records and, for a subtree that has not changed since,
copies the run of records (with its colliders and texts) instead of making them again. The signal is what the world already
knows, not a watch on `Transform`'s fields (plain fields are kept, because accessors made every moving scene slower under
QuickJS): a render (`runRender`), a structural change and an `AnimatedSprite` frame call `markChanged()`, which stamps the object
and its ancestors with the world's `serial`, and the builder advances the serial once a frame. A subtree is copied when nothing
in it, and no ancestor's own transform, was stamped since the frame the records came from. The contract that follows:

- **A compiled component needs nothing.** Its draw state changes only in its constructor and `render()`, and its hooks only
  call setters, so the compiler marks every class it generates `static readonly managed = true`. Its `render()` writes only what
  differs and reports it (`markMoved` for a transform, `markChanged` for anything else), and it declares `reportsChanges`, so a
  render that changes nothing keeps what was drawn, and one that only moves it lets the player move its records as a block.
- A hand-written class that overrides `onInput` or `onUpdate` and is not marked is redrawn every frame, with everything under
  it, because it may write a transform or a colour from the hook and nothing would report it. The same write with no hook (from a
  collision callback, a test, a script holding a reference) is not seen: call `object.markChanged()` after it.
- **What the walk must see every frame is never reused**: a `<Camera>`, `<Pointer>`, `<Hud>`, `<Flex>` (they feed lists besides the
  draw records, or lay out their children) and anything with a non-zero `z`. A subtree containing one is rebuilt, and so are its
  ancestors, though their other children are still copied.
- **A `<Flex>`'s records are made again every frame, but its layout is not.** The same stamps say whether anything under a layout
  root changed since it was laid out; when nothing did, the layout is kept (LAYOUT.md, "A layout that cannot have changed is
  kept").
- **Collisions follow it.** A collider in a reused subtree comes with the same `ColliderEntry` object as last frame, and one that is
  not gets a new one, so `CollisionTracker` tests again only the colliders whose entry is new (see its doc comment). An entry must not be
  changed after it is handed over.
- **Which boxes overlap is the host's to find, when it can.** A backend may implement `overlaps` (both native hosts do, with
  `tse_overlaps` in `libtse`); the tracker then hands it the boxes and applies the rules to the pairs that come back. Without
  it the tracker sweeps in script. The two find the same pairs, so a game cannot tell which ran.
- **What changed is drawn the short way.** Under an object that changed this frame, a `<Shape>`, `<Sprite>` or `<Collider>` with no
  children, z, layout offset or placement is written by its parent's loop, not by a call of its own (most of a moving component is
  such leaves). It draws the same as the general walk; the tests compare the two.
- `retain: false` (on `PlayerConfig` or `FrameBuilderOptions`) turns it off; `retain: "check"` also rebuilds each frame and
  throws when the two differ, which is how an unreported change is found. The player's tests run reuse against a full rebuild
  over random changes.

**A frame** (`createPlayer(...).step()`), in a fixed order:

1. A new left press goes to the topmost `Pointer` that was under the mouse in the frame last
   drawn (`world.reportPress`). One press, one pointer; if the topmost misses, the one below is tried.
2. `world.tick(dt, input)`: `useInput`, `useUpdate`, renders, structure (as in "Handlers"). `dt` is
   what the backend measured, clamped to `[0, 0.1]` seconds so a stall cannot teleport things; the
   first frame's `dt` is 0. With a fixed step, as many ticks as the frame holds (`FixedDriver`).
3. After each tick, its collisions: the tree is walked (`walkTree`, depth first) into draw records,
   which is where colliders get their world boxes; contacts that started or ended are reported with
   `world.reportCollision` / `reportCollisionExit` (see "Collisions" below); and if any callback ran,
   `world.flush()` renders what it changed. The walk composes world transforms on the way down and treats
   a `Camera` as transparent to its children, as `GameObject.worldTransform()` and `childSpace()`
   do, and a test holds the two equal over a real tree.
4. The last step's walk is the frame's, unless a collision callback changed something after it; then the
   tree is walked again (cheap: only what changed is rebuilt, see "Reusing draw records").
5. The backend draws and presents the frame, then writes the next frame's input. `step()` returns false once that input says the
   window was closed (the frame is still drawn).

**Why collisions are per step** (2026-11-12). They used to be found once a frame, after the walk, and their
callbacks' effects rendered by the next tick. That had three costs: the frame that showed a contact did not
show what it caused (a spike touched but the character still standing); with a fixed step, a contact that
began and ended inside one frame's steps was missed; and the step a contact was seen in depended on the frame
rate, so a replay could play differently on a slower machine. A contact is found in the step that made it,
the next step's `useUpdate` sees its effects, the frame draws them, and a run collides at the same steps at
any frame rate (`test/collide-timing.test.ts`). The cost: a frame of one step walks the tree once
(plus a cheap second walk only when a callback ran); a frame that catches up with k steps walks it k times:
2,000 moving colliders under Node went from 3.9 to 5.8 ms for a two-step frame. A walk that places only the
colliders would remove that if it matters. Two things stay as they were: a callback runs after the step's
`useUpdate`, not inside it, so movement code that must stop at a wall reads tiles; and nothing sweeps a
collider's path, so a very fast, thin one can pass through another between two steps.

**What is drawn.**

* *Order:* tree order, a parent before its children, children in their order (source order, then
  keyed-list order), unless `z` says otherwise. Later is on top. **`z`** is a transform field beside `x`
  and `y` (`<Sprite x={10} z={2} />`; scenes take it too): what has a higher `z` is drawn
  later, so on top, negative is behind, and 0 is the default. Like position it adds to the parent's
  (`placement.z + transform.z`, on top of the parent's), so raising a component raises everything in it as
  one, and `global` cuts the chain (a global `transform` is its own `z`; a global `placement`
  ignores the parent's). A camera is transparent to it, as to position. Objects with equal `z` keep
  tree order, and the order is global across the tree, not within one parent: a child at an effective
  `z` of 6 is above an unrelated sibling of its parent at 5.5. Pointers follow the same order, so the
  pointer drawn on top is pressed first. It is not a record field, so the record format has no `z`. The frame
  builder notes where `z` changes as it writes records and, if it ever did, sorts them once after the walk
  (`DrawList.sortByZ`, a stable sort by `(z, record order)`; skipped when they are already in order, as
  when a HUD sits at the top); the view stays first and a screen's border bars stay last. A `z` that is
  not a number (NaN) is 0, with one warning; an infinite one is the extreme of the order. Why it is a
  transform field, a prop of built-ins only: `z` is a common prop name (a coordinate, a layer), and an
  attribute of every element would reserve it on every component. The cost is a read of two fields per object in the tree
  walk: about 10% of the script time of the 2,000 and 5,000 moving-rect bench scenes under QuickJS
  (median of interleaved runs, noisy to about the same size). Setters on `Transform` that mark it changed would let
  a game that never sets `z` skip it.
* *Origin:* top-left, for `Sprite`, `AnimatedSprite`, `Shape` and `Text`, rotated and scaled about it.
  A negative scale flips.
* `Sprite` and `AnimatedSprite` draw `image` (the current frame) from `<assets>/<image>`; an empty
  image draws nothing. `Shape` draws a rectangle, or an ellipse filling its `width × height` box.
  `Text` draws one line with the default font at `size` pixels; empty text draws nothing.
  `Entity`, `Collider`, `Pointer` and `Camera` draw nothing.
* *Colours* are CSS: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, the named colours and
  `transparent`.
* *Never throws for art:* a texture that will not load is drawn as a magenta 16×16 square, and a
  colour that cannot be read is magenta, each with one warning. Each texture is loaded once.

**The camera.** The first `Camera` in draw order is the view (a second one is ignored, with one
warning). The point it follows (the middle of its children, or where it is) lands on the centre of the window
(of the game's screen, under a `<Screen>`). With no camera the world
origin is the window's top-left corner. An unusable camera (zoom 0) is dropped for the frame, with one
warning.

**The game's screen.** A `<Screen width={320} height={180}>` at the root of the game (the object mounted, or the
root `build` is given) sets the game's resolution: everything inside is in game pixels, and the player scales it
into the window. `fit` picks the scale: `"integer"` (the default) is the largest whole number that fits, with the
game's corner on a whole window pixel, falling back to `"contain"` for a window smaller than the game;
`"contain"` is the largest scale that fits; `"stretch"` fills each axis. The game is centred, and the window
outside it is covered with `border`. `pixelPerfect` (the default) draws the game into a texture of the game's own
size, through views in game pixels, and the first record of the frame, `TSE_OP_CANVAS`, says where in the window
the texture is shown and what colour is around it, so a game pixel is a whole block of window pixels whatever is
turned or scaled inside. `pixelPerfect={false}` draws at the window's resolution: the camera's view in game pixels,
then the screen's scale and position (`viewToWindow`), in one view, and the bars last as four rectangles through a
view in window pixels. In both modes a press on the bars reaches no `Pointer`, and `input.pointerX/pointerY` come
back through the window's map (`BuiltFrame.view`, which is the same in both modes), so handlers see game positions.
A `<Screen>` anywhere else is a plain container, with one warning; one whose
size is not positive is ignored, with one warning. Without a `<Screen>`, the game is the window.

**The HUD.** A `<Hud>` is a layer drawn after the world through a second `TSE_OP_VIEW` that ignores the camera:
its contents are in game pixels under a `<Screen>` and in window pixels without one. The tree walk records each
`Hud` and does not enter it; each is then walked on its own after the world, in tree order, from its own world
transform, with `z` ordering the contents of that layer only (a high `z` inside one layer never lifts it over the
next layer, or the world). Inside a `Hud`, sprites, shapes and text are drawn, `Pointer`s are collected, and a
`Camera` is ignored with one warning; a `Collider` takes no part in collisions; a `Hud` inside a `Hud` is a plain
container. The HUD's pointers are listed after the world's, so they are pressed first, and a press reaches them at
HUD coordinates: the window point taken back through `BuiltFrame.hudView` (the screen's placement, or the
identity), not through the camera.

**Layout (`<Flex>`).** A `Flex` is a container that places its children in a row or a column; the algorithm is in
`packages/player/src/layout.ts` and is Clay's, ported ([LAYOUT.md](LAYOUT.md) has the rules and the reasons). The walk
reaches a layout root (a `Flex` whose parent is not a `Flex`) and lays out everything under it before descending:
fit sizes bottom-up, then sharing out space top-down, widths first and then heights, then positions, each child's
`layoutX` / `layoutY` (composed before `placement` and `transform`, so a child's own `x` and `y` move it within its
slot). Sizing is per axis: `"fit"`, `"grow"`, a number or a percentage, with min and max; free space goes to the
smallest growing child first and stops at each maximum. Only a `Flex` is resized by layout; a `Shape`, `Sprite` or
`Text` keeps its own size. An `Entity` or component child is sized by the bounding box of what it draws. A root that
grows fills the game's area (the canvas, else the window). Layout runs on every frame where something under the root
changed (a root nothing has changed under keeps its layout: LAYOUT.md, "A layout that cannot have changed is kept"), so
conditional children and keyed lists reflow with no extra work, and in steady state it allocates nothing. `background` is a rectangle drawn first,
behind the children, at the box's size. Each child's offset is rounded to a whole pixel (sizes stay exact), so centred
text is not blurred. A `Flex` with an `onPress` is pressable over its laid-out box, in the same draw-order list as
`Pointer`s (both are a `Pressable`). A `<Text width={80} align="center">` is laid out as an 80-wide box and drawn
centred in it. Without `width` or `maxWidth`, outside a `Flex`, `align` aligns each line on the text's x (a damage number centred
on a point, 2026-11-17): the line widths count from a box of 0 (`textAlignBox`), and a parent's extent counts the text where it
is drawn. A `Flex` child without a width is still laid out at its own size and not moved. When children overflow a row or column, boxes that are `"fit"` or `"grow"` shrink largest first down to their
minimums; a leaf's minimum is its size unless the measurer reports a smaller one (`minWidth` / `minHeight`, for
wrapping text), so in a real game nothing shrinks yet and overflow is visible. Not built yet: floating boxes (U5), text wrapping.

**Measuring.** `FrameBuilder.measure(object)` is the size layout will place an object by: a `Shape`'s,
`Pointer`'s or `Collider`'s `width × height`, a `Text`'s measured width × its measured line height, a `Sprite`'s texture size
(an `AnimatedSprite`'s first frame, so the size does not jitter; a texture that will not load measures as the
16×16 square drawn instead), and null for containers. It asks the backend's optional `measureText` and
`textureSize` once per string and once per texture and keeps the answers (text widths up to 1,024 strings,
then the cache starts again). Both native hosts answer from libtse (ABI v2). A backend without them gets text
widths estimated (`estimateTextWidth`: 0.6 × size per character, a line as tall as `size`) and textures that measure
0 × 0, with one warning; `RecordingBackend` implements both deterministically for tests.

**Input.** `input.pressed/down/released(key)` read the backend's key flags. Keys are `"A"`–`"Z"`,
`"0"`–`"9"`, `"Space"`, `"Enter"`, `"Escape"`, `"Tab"`, `"Backspace"`, `"Shift"`, `"Control"`,
`"Alt"`, `"ArrowUp"`/`"ArrowDown"`/`"ArrowLeft"`/`"ArrowRight"`, `"F1"`–`"F12"` and the mouse buttons
`"MouseLeft"`, `"MouseRight"`, `"MouseMiddle"`; any other name is never pressed and warns once.
`input.pointerX/pointerY` are the mouse in world space: the window position taken back through the
view of the frame last drawn, so a handler never needs the camera. A pointer or collider mounted this
frame is not clickable until it has been drawn once.

**Collisions.** `CollisionTracker` (called by the player after every step) finds the moment two colliders
*start* touching and calls `world.reportCollision(a, b)`, which calls each collider's own `onCollisionEnter`
with the other. A collider is the box `width × height` with its **top-left corner at the object's position**
(like a `Sprite`), scaled and turned by its world transform; a rotated collider is approximated by the smallest
upright box around it (a quarter turn is exact). Boxes that only share an edge do not touch, and a collider
with no area (zero or negative size, zero scale) never collides. A pair that keeps overlapping is reported
once; one that separates and touches again is reported again; a collider that leaves the world is forgotten,
so one that returns already touching is a new contact (and its old partner hears `onCollisionExit`). **Colliders with the same parent never collide with each
other**, so a component with a hitbox and a shield does not hit itself. Pairs are found with a sweep over x, which keeps it cheap
(a whole frame with 2,000 moving colliders is about 0.9 ms in Node and 16 ms in the embedded interpreter; testing
every pair cost 465 ms there). A pair is skipped unless each collider's `hits` allows the other's `layer`. When a pair that touched last frame does not now,
`world.reportCollisionExit(a, b)` is called (before the frame's enters): the tracker keeps last frame's colliders by id for that, one
array entry per collider, because a `Map` entry per touching pair doubled the cost of a pile of 300 colliders under QuickJS. There is no
physics: nothing is pushed apart, and a handler reads `other.tag` and `other.owner` only.

**Sound.** `Sound` reports to a `SoundSink` (`setSoundSink`, one at a time). The player installs one
that loads each file through the backend once (when a component creates its `Sound`, so it is ready by
the time it plays) and plays by handle. A sound that cannot be loaded warns once and is silent; the
runtime still counts the play. Closing the player removes the sink.

**Hosts.** A game's entry file calls `run(hostBackend(), config)`. A host sets
`globalThis.__tseBackend` before it loads the game, so the same file runs under every host:

* **Node** (`@tsengine/player-node`, for development): koffi loads `libtse`; `npm run play:demo`.
* **The Rust host** (`host/`, what ships): QuickJS-ng (an interpreter: no JIT, so it can go where a JIT is
  banned) embedded with rquickjs, with `libtse` and raylib linked in statically. `npm run bundle` turns the
  entry into one ES module (esbuild, `platform: neutral`, ES2022) and refuses one that imports from Node or
  koffi; `tse-host game.js [--root <dir>]` runs it, resolving the game's relative `assets/` against the root.
  With no arguments it runs the `game.js` next to the executable in that folder, which is how
  `npm run package` ships a game: `dist/<name>/` holds the executable, `game.js` and `assets/`. The host
  provides `console` (QuickJS has none) and the backend; nothing else of Node is needed. An uncaught
  exception prints its stack and exits with status 1.
* **`RecordingBackend`** is the backend for tests: it keeps every frame decoded and plays scripted input back
  one frame at a time. The demo's 60-frame parity script runs under Node and under the Rust host and the two
  outputs must be byte-identical.
