import { type HostElementIR, type PropDeclIR } from "./elements.ts";
import { type ExprIR } from "./expressions.ts";
// The IR of a module and its declarations: components, hooks, state, refs and sounds.
import { type StateId, type SoundId, type SourceSpan } from "./ids.ts";
import { type TypeIR, type FunctionIR } from "./values.ts";

// ---------------------------------------------------------------------------
// Module / component
// ---------------------------------------------------------------------------

export interface IRModule {
  readonly kind: "Module";
  readonly sourceFile: string;
  /**
   * Top-level `interface` / `type` declarations (a component's props type),
   * copied into the generated module as written, so the type-check validates them.
   */
  readonly typeDeclarations: readonly TypeDeclarationIR[];
  readonly components: readonly ComponentIR[];
  /** Functions imported from relative `.ts` files that components call or pass: the generator imports them from where they are. */
  readonly plainImports: readonly PlainImportIR[];
  /**
   * Top-level constants and helper functions of the component file (`const COLORS = { … }`, `function frameOf(kind) { … }`),
   * copied into the generated module as written, before the components, which read them as they read a plain import.
   */
  readonly moduleDeclarations: readonly ModuleDeclarationIR[];
  /**
   * Runtime functions the file imports under another name (`import { textOf as runtimeText }`): what a top-level helper copied into
   * the generated module calls them by, so it imports them the same way. Calls in components are written by the function's own name.
   */
  readonly runtimeAliases?: readonly { readonly name: string; readonly importedName: string }[];
  /** Types imported from relative `.ts` files: the generated module imports them as types, from where they are. */
  readonly typeImports: readonly { readonly name: string; readonly importedName?: string; readonly module: string }[];
}

/** `const ICON = { gold: 3 } as const;` or `function towerFrame(kind: TowerKind, level: number) { … }` at the top of a component file. */
export interface ModuleDeclarationIR {
  readonly kind: "ModuleDeclaration";
  readonly name: string;
  /** The declaration's source text, as written. */
  readonly text: string;
  /** Every name its text mentions, so the generator imports what it reads (a function from a `.ts` file, a runtime function). */
  readonly reads: readonly string[];
}

/** `import { crossfade } from "./transitions.ts"`. */
export interface PlainImportIR {
  readonly name: string;
  /** The specifier as written (`./transitions.ts`); the generator points it at the source folder. */
  readonly module: string;
  /** `import * as K from "./constants.ts"`: imported whole, under this name. */
  readonly namespace?: boolean;
}

/** A source `interface Name { … }` or `type Name = { … }`, kept as text. */
export interface TypeDeclarationIR {
  readonly kind: "TypeDeclaration";
  readonly name: string;
  /** The declaration's source text, without `export`. */
  readonly text: string;
}

/** `const handleHit = (id: string) => { … }` in a component body: a handler kept in the field `name`, called or passed as a value. */
export interface OwnFunctionIR {
  readonly kind: "OwnFunction";
  /** The field it is kept in (the author's name, or `$name` where the root built-in has that member). */
  readonly name: string;
  readonly fn: FunctionIR;
}

export interface ComponentIR {
  readonly kind: "Component";
  readonly name: string;
  readonly span: SourceSpan;
  /** Hook declarations, in source order. */
  readonly hooks: readonly HookIR[];
  /** Persistent storage slots created by hooks. */
  readonly state: readonly StateIR[];
  /** `useSound` bindings: a sound each, played by calling its function in a handler. */
  readonly sounds: readonly SoundIR[];
  /** Functions declared in the body (`const handleHit = (id: string) => { … }`): handlers of the component's own, kept in fields. */
  readonly functions: readonly OwnFunctionIR[];
  /** Declared props, from the destructured parameter. Empty for a component without props. */
  readonly props: readonly PropDeclIR[];
  /** The name of the props type (`EnemyProps`), or null for a component without props. */
  readonly propsType: string | null;
  /** `export default function Enemy() {}` or `export default Enemy;`: the module also exports it as its default. */
  readonly isDefaultExport: boolean;
  /**
   * Exported (`export function`, or the module's default export): a prefab, which
   * scenes can place by name. A component that is not exported is private to its file.
   */
  readonly isExported: boolean;
  /**
   * The props type declares `children: Child` and the JSX has a `{children}`
   * slot: a parent may pass elements, which mount at the slot. Such a
   * component's runtime props are the props type without `children`.
   */
  readonly acceptsChildren: boolean;
  /** The root `<Entity>`: describes the component instance itself. */
  readonly root: HostElementIR;
}

// ---------------------------------------------------------------------------
// Hooks and state
// ---------------------------------------------------------------------------

/** Hook declarations. */
export type HookIR = StateSlotHookIR | OnUpdateHookIR | OnInputHookIR | OnMountHookIR | OnUnmountHookIR;

/**
 * The fields of a transform (runtime `Entity.transform`), each written as a prop of a built-in (`<Entity x={…} global />`).
 * Pixels, y down; `rotation` in radians. Relative to the parent unless `global` is true. `opacity` is lowered to the same write.
 */
export const TRANSFORM_FIELDS = ["x", "y", "z", "rotation", "scaleX", "scaleY", "global", "opacity"] as const;

export type TransformField = (typeof TRANSFORM_FIELDS)[number];

/**
 * `const playHit = useSound("hit.wav")`: a sound this component can play. The
 * path is a literal so a missing asset can be reported at build time once
 * there is an asset list. Calling the binding is only valid in a handler.
 */
export interface SoundIR {
  readonly kind: "Sound";
  readonly id: SoundId;
  /** Also the generated field name. */
  readonly name: string;
  readonly path: string;
  readonly span: SourceSpan;
}

/** One state slot the component declares: a `useMutable` field, a value of the game state (`useGame`) or of a context. */
export interface StateSlotHookIR {
  readonly kind: "StateSlot";
  readonly state: StateId;
  /** Name of the generated setter method, or null if the setter was not bound. */
  readonly setterName: string | null;
  readonly span: SourceSpan;
}

/**
 * A handler hook, by when the runtime calls it:
 *
 * - `OnUpdate` (`useUpdate((dt) => …)`): once per `World.tick(dt, input)`, after `OnInput`.
 * - `OnInput` (`useInput((input) => …)`): once per tick with the polled `InputState`, before `OnUpdate`.
 * - `OnMount` (`useMount(() => …)`): once when the component joins a `World`, after its children have mounted (and its first
 *   render, which the constructor runs). Setting state here renders in the same flush.
 * - `OnUnmount` (`useUnmount(() => …)`): once when the component leaves its `World`. It cannot set state (the component is going
 *   away); refs and callback props work.
 */
export interface HandlerHookIR<K extends HandlerHookKind = HandlerHookKind> {
  readonly kind: K;
  readonly handler: FunctionIR;
  readonly span: SourceSpan;
}

export const HANDLER_HOOK_KINDS = ["OnUpdate", "OnInput", "OnMount", "OnUnmount"] as const;

export type HandlerHookKind = (typeof HANDLER_HOOK_KINDS)[number];

export type OnUpdateHookIR = HandlerHookIR<"OnUpdate">;
export type OnInputHookIR = HandlerHookIR<"OnInput">;
export type OnMountHookIR = HandlerHookIR<"OnMount">;
export type OnUnmountHookIR = HandlerHookIR<"OnUnmount">;

export function isHandlerHook(hook: HookIR): hook is HandlerHookIR {
  return (HANDLER_HOOK_KINDS as readonly string[]).includes(hook.kind);
}

export interface StateIR {
  readonly kind: "State";
  readonly id: StateId;
  /** Field name on the generated class. */
  readonly name: string;
  /** A primitive, an array (`enemies: [] as EnemyData[]`) or a source type. */
  readonly type: TypeIR;
  /** Must not depend on any state. For a game-state leaf, the value it starts with. */
  readonly initialValue: ExprIR;
  /**
   * Set for `const hp = useGame((s) => s.player.hp)`: the dotted path (`"player.hp"`) of the game-state leaf this state
   * mirrors. The generated field is a snapshot of it, refreshed on render; it has no setter (actions change it).
   * Absent for a `useMutable` field.
   */
  readonly globalKey?: string;
  /**
   * A per-instance object a factory made (`useMutable({ body: createBody(…) })`): its methods may be called, and it is told when the
   * component joins and leaves a world (`ownedHandles`), if it wants to know.
   */
  readonly handle?: true;
  /**
   * Not the component's own state, so not kept by hot reload or saves: a context's reader, and the value it reads
   * (`useContext`), which is found again from the tree.
   */
  readonly transient?: true;
  /** Worked out again in `commitState` each time the component renders: a context's value, read from its reader. */
  readonly refresh?: ExprIR;
  /** A field of a `useMutable` (`s.vx`): which one, and the getter that shows them all (`component.s`). */
  readonly mutable?: MutableFieldIR;
}

/** Where a `useMutable` field belongs: `s.vx` is `{ name: "s", view: "s", field: "vx" }`; `view` is `$s` where the root has an `s`. */
export interface MutableFieldIR {
  /** The name in the source. */
  readonly name: string;
  /** The generated getter's name. */
  readonly view: string;
  readonly field: string;
}
