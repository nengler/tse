// The IR of expressions: reads, literals, calls, array methods and operators.
import { type StateId, type LocalId } from "./ids.ts";
import { type FunctionIR, type ParamIR } from "./values.ts";

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type ExprIR =
  | PlainRefIR
  | ElementReadIR
  | NumberLiteralIR
  | StringLiteralIR
  | BooleanLiteralIR
  | NullLiteralIR
  | StateReadIR
  | LocalReadIR
  | ParamReadIR
  | PropertyReadIR
  | PropReadIR
  | MemberReadIR
  | IndexReadIR
  | NonNullIR
  | ActionRefIR
  | ArrayLiteralIR
  | ObjectLiteralIR
  | ArrowIR
  | CallbackIR
  | CallIR
  | TemplateLiteralIR
  | UnaryExprIR
  | BinaryExprIR
  | ConditionalExprIR
  | NewExprIR
  | BlockExprIR
  | MemoIR;

/**
 * Statements in the component body worked out together (a render block): a function of no parameters, run where it is read and
 * returning an object of the names the block declares. Always inside a `Memo`, so it runs again only when what it reads changes.
 */
export interface BlockExprIR {
  readonly kind: "Block";
  readonly fn: FunctionIR;
}

/**
 * `new Map<string, number>()`, `new Error("…")`, `new Enemy(…)` in a handler: a global constructor or a class imported from a `.ts`
 * file, by name, with its type arguments as written.
 */
export interface NewExprIR {
  readonly kind: "New";
  readonly callee: string;
  readonly typeArguments: string | null;
  readonly args: readonly ExprIR[];
}

/**
 * A derived value that calls something (`const hero = heroOf(run)`, `const alive = enemies.filter(…)`), worked out once and again
 * only when what it reads changes, as React's `useMemo`: the generated code is `this.$memo(key, [deps], () => value)`, the deps
 * being the state and props `value` reads. `key` names it among the component's memos.
 */
export interface MemoIR {
  readonly kind: "Memo";
  readonly key: string;
  readonly value: ExprIR;
}

/**
 * A field of one of this component's own elements, by its field name: `this.route2.active`. Only the compiler writes it (a
 * `<Route>`'s children are shown while the route is active); it is read fresh on every render, so it has no dependencies.
 */
export interface ElementReadIR {
  readonly kind: "ElementRead";
  readonly field: string;
  readonly member: string;
}

/**
 * A game-state action passed whole to a component's callback prop (`onPress={resume}`): the store's own function, which
 * never changes, so it is a static prop.
 */
export interface ActionRefIR {
  readonly kind: "ActionRef";
  readonly name: string;
}

/**
 * A function imported from a relative `.ts` file, or a top-level constant of the file, used as a value (`<Router transition={crossfade} />`): the generated code writes
 * the imported name. The compiler does not look inside it.
 * Also `undefined` and `Math.PI`-style constants.
 */
export interface PlainRefIR {
  readonly kind: "PlainRef";
  readonly name: string;
}

export interface NumberLiteralIR {
  readonly kind: "NumberLiteral";
  readonly value: number;
}

export interface StringLiteralIR {
  readonly kind: "StringLiteral";
  readonly value: string;
}

export interface BooleanLiteralIR {
  readonly kind: "BooleanLiteral";
  readonly value: boolean;
}

export interface NullLiteralIR {
  readonly kind: "NullLiteral";
}

export interface StateReadIR {
  readonly kind: "StateRead";
  readonly state: StateId;
  /**
   * A handler's read of a `useMutable` field: the value as this handler (or an earlier one this step) last wrote it, not the
   * committed one render sees.
   */
  readonly live?: true;
}

/** A `const` local declared in a function body. */
export interface LocalReadIR {
  readonly kind: "LocalRead";
  readonly local: LocalId;
  readonly name: string;
}

/** A function parameter. */
export interface ParamReadIR {
  readonly kind: "ParamRead";
  readonly param: LocalId;
  readonly name: string;
}

/** `input.pointerX`: only on a parameter of a runtime handle type, checked in transform. */
export interface PropertyReadIR {
  readonly kind: "PropertyRead";
  readonly object: ParamReadIR;
  readonly name: string;
}

/** A declared prop's current value: `this.props.speed`. A callback prop is only read when forwarded as a whole attribute value (`onX={onX}`). */
export interface PropReadIR {
  readonly kind: "PropRead";
  readonly name: string;
  /** In a handler: the prop as the parent has it now (`liveProp`), not as its last render copied it. */
  readonly live?: true;
}

/**
 * `e.id`, `enemies.length`, `found?.hp`: a member of a value (a record, an
 * array). The compiler does not know the value's type; the type-check of the
 * generated code does. Members of runtime handle parameters are
 * `PropertyRead`, which the manifest checks.
 */
export interface MemberReadIR {
  readonly kind: "MemberRead";
  readonly object: ExprIR;
  readonly name: string;
  /** `?.` */
  readonly optional: boolean;
}

/**
 * `TABLE[kind]`, `pads[cursor]`, `found?.[i]`: an element of an array or a record, by an index or a key worked out at run
 * time. Like `MemberRead`, the type-check of the generated code checks it.
 */
export interface IndexReadIR {
  readonly kind: "IndexRead";
  readonly object: ExprIR;
  readonly index: ExprIR;
  /** `?.[` */
  readonly optional: boolean;
}

/** `table[key]!`: TypeScript's non-null assertion, kept so the generated code type-checks as the source did. */
export interface NonNullIR {
  readonly kind: "NonNull";
  readonly expression: ExprIR;
}

/** `[a, ...rest]`. */
export interface ArrayLiteralIR {
  readonly kind: "ArrayLiteral";
  readonly elements: readonly ArrayElementIR[];
}

export interface ArrayElementIR {
  /** `...value`. */
  readonly spread: boolean;
  readonly value: ExprIR;
}

/** `{ id, speed: 2, ...e }`. Later properties override earlier ones, as in JS. */
export interface ObjectLiteralIR {
  readonly kind: "ObjectLiteral";
  readonly properties: readonly ObjectPropertyIR[];
  /** A `useMutable` read whole (`total(s)`): its fields, each a `StateRead`. In render, a copy of them. */
  readonly mutableCopy?: true;
  /**
   * With `mutableCopy`, read in a handler: not a copy but the component's object for that `useMutable` (`takeHit(s)`), made the
   * first time it is passed and kept, whose fields read and write the component's. The properties still list what it reads (a memo's dependencies).
   */
  readonly live?: true;
}

export type ObjectPropertyIR =
  | { readonly kind: "Property"; readonly name: string; readonly value: ExprIR }
  | { readonly kind: "Spread"; readonly value: ExprIR };

/**
 * `(e) => e.id !== id`: an expression-bodied arrow, only valid as the
 * argument of an allowlisted array method, which calls it synchronously (it
 * never escapes). Parameters are `Contextual`: the array's element type
 * provides them.
 */
export interface ArrowIR {
  readonly kind: "Arrow";
  readonly params: readonly ParamIR[];
  readonly body: ExprIR;
}

/**
 * `() => setView(read())` passed to a function or a method of an imported object in a handler
 * (`settings.subscribe(() => …)`), or returned from `useMount` as its cleanup: a handler of its own, which may run later
 * (it escapes), lowered like a callback prop. Its parameters are `Contextual`: the function it is passed to types them.
 */
export interface CallbackIR {
  readonly kind: "Callback";
  readonly fn: FunctionIR;
}

/** Array methods handler code may call. None mutates its receiver (state updates must be immutable). */
export const ARRAY_METHODS = {
  filter: { args: [1, 1], callback: true },
  map: { args: [1, 1], callback: true },
  some: { args: [1, 1], callback: true },
  every: { args: [1, 1], callback: true },
  find: { args: [1, 1], callback: true },
  findIndex: { args: [1, 1], callback: true },
  includes: { args: [1, 1], callback: false },
  indexOf: { args: [1, 1], callback: false },
  slice: { args: [0, 2], callback: false },
  concat: { args: [1, Infinity], callback: false },
  flatMap: { args: [1, 1], callback: true },
  join: { args: [0, 1], callback: false },
  at: { args: [1, 1], callback: false },
  lastIndexOf: { args: [1, 1], callback: false },
  flat: { args: [0, 1], callback: false },
  // ES2023's copying forms of the in-place methods: a new array each time, so state stays immutable.
  toSorted: { args: [0, 1], callback: true },
  toReversed: { args: [0, 0], callback: false },
  toSpliced: { args: [1, Infinity], callback: false },
  with: { args: [2, 2], callback: false },
  findLast: { args: [1, 1], callback: true },
  findLastIndex: { args: [1, 1], callback: true },
  // A fold: its callback takes the running value and an item, and returns the next value; it changes nothing.
  reduce: { args: [1, 2], callback: true },
  reduceRight: { args: [1, 2], callback: true },
  // Iterators for a handler's `for (const [i, item] of items.entries())`.
  entries: { args: [0, 0], callback: false },
  keys: { args: [0, 0], callback: false },
  values: { args: [0, 0], callback: false },
} as const satisfies Record<string, { readonly args: readonly [number, number]; readonly callback: boolean }>;

export type ArrayMethodName = keyof typeof ARRAY_METHODS;

/**
 * Methods of strings and numbers, none of which changes anything: `name.toUpperCase()`, `String(n).padStart(2, "0")`,
 * `id.startsWith("bind:")`, `speed.toFixed(1)`. They are called as written (`ValueMethod`), and the type-check of the generated code
 * checks the receiver has them. (`slice`, `includes`, `indexOf`, `concat`, `at` are shared with arrays, in `ARRAY_METHODS`.)
 */
export const VALUE_METHODS: ReadonlySet<string> = new Set([
  "padStart",
  "padEnd",
  "startsWith",
  "endsWith",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "trimStart",
  "trimEnd",
  "split",
  "replace",
  "replaceAll",
  "repeat",
  "charAt",
  "charCodeAt",
  "substring",
  "localeCompare",
  "normalize",
  "toFixed",
  "toPrecision",
  "toString",
]);

/** Global conversions, called as functions: `String(n)`, `Number(text)`, `Boolean(x)`. Argument count. */
export const GLOBAL_FUNCTIONS: Readonly<Record<string, number>> = { String: 1, Number: 1, Boolean: 1 };

/** Array methods that change the array in place: reported with the immutable alternative. */
export const MUTATING_ARRAY_METHODS: Readonly<Record<string, string>> = {
  push: "`setItems([...items, item])`",
  unshift: "`setItems([item, ...items])`",
  pop: "`setItems(items.slice(0, -1))`",
  shift: "`setItems(items.slice(1))`",
  splice: "`toSpliced`, `filter`, `slice` and spreads",
  sort: "`toSorted`, which returns a sorted copy",
  reverse: "`toReversed`, which returns a reversed copy",
  fill: "`map`, or `with(index, value)` for one element",
  copyWithin: "`map`",
  forEach: "a `for (const item of items) { … }` loop in a handler, or `map`, `filter` or `some`",
};

/** A call to a fixed allowlist (`Math.*`, `clamp`) or a method of a runtime handle parameter. */
export interface CallIR {
  readonly kind: "Call";
  readonly callee: CalleeIR;
  readonly args: readonly ExprIR[];
}

export type CalleeIR =
  | { readonly kind: "Function"; readonly name: string }
  /**
   * A call of a function imported from a relative `.ts` file, or of a method of a value imported from one (`fx.burst`, the
   * name then has a dot): opaque, so its arguments are all it depends on.
   */
  | { readonly kind: "Plain"; readonly name: string }
  | { readonly kind: "Method"; readonly receiver: ParamReadIR; readonly name: string }
  /** `enemies.filter((e) => …)`: an allowlisted, non-mutating array method (`ARRAY_METHODS`) on any value. */
  | { readonly kind: "ArrayMethod"; readonly receiver: ExprIR; readonly name: ArrayMethodName }
  /** `const events = step(input, dt)` in a handler: a game-state action whose result the handler uses. */
  | { readonly kind: "Action"; readonly name: string }
  /** `squash.start(0.6, 1.4)`: a method of a per-instance object, state made by a factory (`useMutable({ body: createBody(…) })`). Opaque. */
  | { readonly kind: "ValueMethod"; readonly receiver: ExprIR; readonly name: string; readonly optional?: boolean }
  /** A function declared in the component body, by its field: `this.handleHit(id)`. */
  | { readonly kind: "Own"; readonly name: string }
  /**
   * A callback prop: `onDefeated()` or `onDefeated?.()`. Argument counts and types are left to the type-check. `present`: the
   * source proved it was passed where the call's arrow was made (`onGo === undefined ? undefined : () => onGo()`), which the
   * generated code, reading it from `this.props` inside the arrow, cannot show TypeScript, so the call asserts it.
   */
  | { readonly kind: "Prop"; readonly name: string; readonly optional: boolean; readonly present?: boolean }
  /** A handler's own `const` or `let` holding a function: `const stop = settings.subscribe(…); … stop();`. The type-check checks it is one. */
  | { readonly kind: "Local"; readonly name: string };

export interface TemplateLiteralIR {
  readonly kind: "TemplateLiteral";
  /** `quasis.length === expressions.length + 1`. */
  readonly quasis: readonly string[];
  readonly expressions: readonly ExprIR[];
}

/** `typeof` is written with a space after it. */
export type UnaryOperator = "!" | "-" | "+" | "typeof";

export interface UnaryExprIR {
  readonly kind: "Unary";
  readonly operator: UnaryOperator;
  readonly operand: ExprIR;
}

export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "**"
  | "<"
  | "<="
  | ">"
  | ">="
  | "==="
  | "!=="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "??"
  | "instanceof"
  | "in";

export interface BinaryExprIR {
  readonly kind: "Binary";
  readonly operator: BinaryOperator;
  readonly left: ExprIR;
  readonly right: ExprIR;
}

export interface ConditionalExprIR {
  readonly kind: "Conditional";
  readonly test: ExprIR;
  readonly whenTrue: ExprIR;
  readonly whenFalse: ExprIR;
}
