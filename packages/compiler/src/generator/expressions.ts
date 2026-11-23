import { runtimeAlias } from "../analyzer/util.ts";
// Base of the component generator: the fields, the expression and field-reference emitters. Layer 0 of ComponentGenerator (see generator.ts).
import {
  assertNever,
  type ComponentIR,
  type ExprIR,
  type FunctionIR,
  type SoundId,
  type StateId,
  type StateIR,
  type LocalId,
} from "../ir/types.ts";
import { collectDependencies, walkExpr } from "../ir/walk.ts";
import { param, escapeTemplate, mutableObject, pendingRef, propertyKey, typeText } from "./helpers.ts";
import { CodeWriter } from "./writer.ts";

/** How some IR is written where the emitter is. Each field is set for a stretch of emitting with `within`. */
export interface EmitMode {
  /**
   * While emitting keyed lists: inside a callback prop, a read of a list's item is its current value, kept in the item's record
   * (`text`), because the callback was created with the item's first value. One per list being emitted, the outermost first.
   */
  readonly itemLookups: readonly { readonly id: LocalId; readonly text: string }[];
  /** Emitting a callback prop's body. */
  readonly inCallback: boolean;
  /** Writing `super(…)`'s arguments, where `this` cannot be used: a memo is worked out in place (it reads nothing that changes there). */
  readonly inlineMemos: boolean;
  /** Where element fields live: on the component (`this.sprite`), or, while a list item's children are written, in its record. */
  readonly fieldBase: string;
  /**
   * The conditions an element being made sits under (`{capturing !== null && <Prompt … />}`). Its callbacks start with
   * `$assume(condition)`, so TypeScript narrows in them what the source narrowed (see `callback`).
   */
  readonly conditions: readonly ExprIR[];
  /** Memos a callback read once into a local (`const $m0 = this.$memo(…)`), by key: read as that local, which TypeScript can narrow. */
  readonly memoLocals: ReadonlyMap<string, string>;
  /** Memos `render()` works out once at its top (`const $r0 = this.$memo(…)`), by key; never read from a callback, which runs later. */
  readonly renderMemos: ReadonlyMap<string, string>;
  /**
   * While writing the parts of `render()` that are always there (not under a condition, not a list item): the inputs they read, each
   * a bit of the render's dirty mask `$d`. Null elsewhere, where nothing is guarded.
   */
  readonly guard: RenderGuard | null;
}

/**
 * The inputs of one `render()`: each state field, prop and game-state field a guarded part reads, with its bit in the dirty mask.
 * The render starts by comparing each with its value at the last render (`===`); a part runs only when one of its inputs changed.
 */
export class RenderGuard {
  /** The expression of each input, by bit: `this.dist`, `this.props.lane`. */
  readonly inputs: string[] = [];
  /** At most 30, so a mask is a small integer; a part that would need more is not guarded. */
  static readonly MAX = 30;

  /** The mask of each part guarded so far. */
  readonly masks: number[] = [];

  /**
   * Whether guarding saves anything: some input's change leaves some part out. When every part reads every input (one part, or
   * parts that all read the same things), each would run on any change anyway, and the comparisons would only cost.
   */
  get useful(): boolean {
    const all = this.masks.reduce((a, m) => a | m, 0);
    return this.masks.some((m) => m !== all);
  }

  /** The mask of these inputs, adding bits for new ones; null when there are too many. */
  maskOf(inputs: readonly string[]): number | null {
    let mask = 0;
    for (const input of inputs) {
      let bit = this.inputs.indexOf(input);
      if (bit === -1) {
        if (this.inputs.length >= RenderGuard.MAX) return null;
        bit = this.inputs.length;
        this.inputs.push(input);
      }
      mask |= 1 << bit;
    }
    this.masks.push(mask);
    return mask;
  }
}

export class ExpressionEmitter {
  protected readonly c: ComponentIR;
  protected readonly requiredHostProps: Readonly<Record<string, readonly string[]>>;
  protected readonly intrinsicHooks: Readonly<Record<string, readonly string[]>>;
  protected w: CodeWriter;
  protected readonly stateById: ReadonlyMap<StateId, StateIR>;
  /** Where the emitter is now, and so how some IR is written. Changed only through `within`. */
  protected mode: EmitMode = {
    itemLookups: [],
    inCallback: false,
    inlineMemos: false,
    fieldBase: "this",
    conditions: [],
    memoLocals: new Map(),
    renderMemos: new Map(),
    guard: null,
  };
  /** Whether a callback was written with `$assume`, so the module declares it. */
  usesAssume = false;
  /** Whether a list item's prop getter finds its item through `$indexOfKey`, which the module then declares. */
  usesKeyIndex = false;
  /** The `useMutable`s a handler has passed whole (`takeHit(s)`), by view name: the class gets an object for each (see the generator). */
  protected readonly mutableObjects = new Set<string>();
  /** How many temporaries the `render()` being written has used (see `emitReportedWrites`). */
  protected renderTemps = 0;
  /** The imported game state (`useGame`), when the module uses one. */
  protected readonly storeName: string;
  /** Runtime functions the module imports under `runtimeAlias`, because the file has its own of that name: called by the alias. */
  protected readonly runtimeRenamed: ReadonlySet<string>;

  constructor(
    component: ComponentIR,
    writer: CodeWriter,
    requiredHostProps: Readonly<Record<string, readonly string[]>>,
    intrinsicHooks: Readonly<Record<string, readonly string[]>>,
    storeName: string,
    runtimeRenamed: ReadonlySet<string> = new Set()
  ) {
    this.storeName = storeName;
    this.runtimeRenamed = runtimeRenamed;
    this.requiredHostProps = requiredHostProps;
    this.intrinsicHooks = intrinsicHooks;
    this.c = component;
    this.w = writer;
    this.stateById = new Map(component.state.map((s) => [s.id, s]));
  }

  /**
   * What a value written by `render()` depends on, as the expressions to compare: each state field and prop it reads (through memos,
   * blocks and nested functions too). Null when it reads something whose changes are not seen that way: an element's own field (a
   * route being active), a ref, a handle, or a call that may read anything (one of the component's own functions, a callback prop,
   * a game-state action, a local function). Functions imported from `.ts` files are pure, as the compiler assumes everywhere.
   */
  protected inputsOf(values: readonly ExprIR[]): string[] | null {
    const out: string[] = [];
    let unknown = false;
    for (const value of values) {
      walkExpr(value, (e) => {
        switch (e.kind) {
          case "StateRead": {
            const input = `this.${this.state(e.state).name}`;
            if (!out.includes(input)) out.push(input);
            break;
          }
          case "PropRead": {
            const input = `this.props.${e.name}`;
            if (!out.includes(input)) out.push(input);
            break;
          }
          case "ElementRead":
          case "PropertyRead":
            unknown = true;
            break;
          case "Call":
            if (
              e.callee.kind === "Own" ||
              e.callee.kind === "Prop" ||
              e.callee.kind === "Local" ||
              e.callee.kind === "Action" ||
              e.callee.kind === "Method"
            )
              unknown = true;
            break;
          default:
            break;
        }
      });
    }
    return unknown ? null : out;
  }

  /** The dirty-mask test for a part of `render()` that writes these values, or null when it is not guarded (it always runs). */
  protected guardTest(values: readonly ExprIR[]): string | null {
    const guard = this.mode.guard;
    if (guard === null) return null;
    const inputs = this.inputsOf(values);
    if (inputs === null || inputs.length === 0) return null;
    const mask = guard.maskOf(inputs);
    return mask === null ? null : `($d & ${mask}) !== 0`;
  }

  /** Emit something in a changed mode; the mode before is back afterwards, whatever happens. */
  protected within<T>(patch: Partial<EmitMode>, emit: () => T): T {
    const outer = this.mode;
    this.mode = { ...outer, ...patch };
    try {
      return emit();
    } finally {
      this.mode = outer;
    }
  }

  /** The lines `emit` writes, written to a writer of their own (relative to column 0) instead of the current one. */
  protected capture(emit: () => void): string[] {
    const outer = this.w;
    const inner = new CodeWriter();
    this.w = inner;
    try {
      emit();
    } finally {
      this.w = outer;
    }
    return inner.toString().trimEnd().split("\n");
  }

  /**
   * An arrow function with a block body, from the statements already written
   * (relative to column 0). One statement stays on one line. Several are laid
   * out under the line that will contain the arrow, unless a string in them
   * spans lines, where adding indentation would change its contents.
   */
  protected arrow(params: string, lines: readonly string[], fn: FunctionIR): string {
    const generic = fn.typeParams ?? "";
    if (lines.length === 1) return `${generic}(${params}) => { ${lines[0]} }`;
    const base = JSON.stringify(fn.body).includes("\\n") ? "" : this.w.indentation;
    return `${generic}(${params}) => {\n${lines.map((l) => `${base}  ${l}`).join("\n")}\n${base}}`;
  }

  /** A handler passed as a value (`settings.subscribe(() => …)`): written by the handler layer, which writes statements. */
  protected callback(_fn: FunctionIR): string {
    throw new Error(`A callback in ${this.c.name} reached the expression layer`);
  }

  /** A sound's name is its field. */
  protected soundField(id: SoundId): string {
    const sound = this.c.sounds.find((s) => s.id === id);
    if (!sound) throw new Error(`Unknown sound ${id} in component ${this.c.name}`);
    return sound.name;
  }

  protected state(id: StateId): StateIR {
    const s = this.stateById.get(id);
    if (!s) throw new Error(`Unknown state ${id} in component ${this.c.name}`);
    return s;
  }

  /** The body of an expression-bodied arrow: an object literal needs parentheses, or it would read as a block. */
  protected arrowBody(e: ExprIR): string {
    const body = this.expr(e, true);
    return e.kind === "ObjectLiteral" ? `(${body})` : body;
  }

  /** Compound sub-expressions are always parenthesised, so operator precedence can never be wrong. */
  protected expr(e: ExprIR, top = false): string {
    const wrap = (s: string): string => (top ? s : `(${s})`);
    switch (e.kind) {
      case "PlainRef":
        return e.name;
      case "ActionRef":
        return `${this.storeName}.getState().${e.name}`;
      case "ElementRead":
        return `this.${e.field}.${e.member}`;
      case "NumberLiteral":
        return String(e.value);
      case "StringLiteral":
        return JSON.stringify(e.value);
      case "BooleanLiteral":
        return String(e.value);
      case "NullLiteral":
        return "null";
      case "StateRead":
        if (e.live) {
          const s = this.state(e.state);
          // A context's value, read by a handler: as the provider's parent has it now (`ContextReader.live`).
          if (s.refresh !== undefined && s.refresh.kind === "MemberRead") return `${this.expr(s.refresh.object)}.live`;
          return pendingRef(s);
        }
        return `this.${this.state(e.state).name}`;
      case "LocalRead":
        return e.name;
      case "ParamRead":
        return (this.mode.inCallback && this.mode.itemLookups.find((l) => l.id === e.param)?.text) || e.name;
      case "PropertyRead":
        return `${e.object.name}.${e.name}`;
      case "PropRead": {
        // A prop with a default is never undefined (the runtime applies the default at construction and on update),
        // but its declared type is optional; `!` says what the runtime guarantees.
        const guaranteed = this.c.props.find((p) => p.name === e.name)?.defaultValue != null;
        return `${e.live ? `this.$live_${e.name}` : `this.props.${e.name}`}${guaranteed ? "!" : ""}`;
      }
      case "MemberRead":
        return `${this.expr(e.object)}${e.optional ? "?." : "."}${e.name}`;
      case "NonNull":
        return `${this.expr(e.expression)}!`;
      case "IndexRead":
        return `${this.expr(e.object)}${e.optional ? "?." : ""}[${this.expr(e.index, true)}]`;
      case "ArrayLiteral":
        return `[${e.elements.map((el) => `${el.spread ? "..." : ""}${this.expr(el.value, true)}`).join(", ")}]`;
      case "ObjectLiteral": {
        if (e.properties.length === 0) return "{}";
        // A `useMutable` read whole in a handler: the component's own object for it (see `mutableObject` in the generator).
        if (e.mutableCopy && e.live) {
          const first = e.properties[0]!;
          const view =
            first.kind === "Property" && first.value.kind === "StateRead" ? this.state(first.value.state).mutable?.view : undefined;
          if (view !== undefined) {
            this.mutableObjects.add(view);
            return `this.${mutableObject(view)}`;
          }
        }
        const literal = `{ ${e.properties.map((p) => (p.kind === "Spread" ? `...${this.expr(p.value, true)}` : `${propertyKey(p.name)}: ${this.expr(p.value, true)}`)).join(", ")} }`;
        if (!e.mutableCopy) return literal;
        // A `useMutable` read whole in render: a copy, typed as its fields (so it is not checked as a fresh literal: `total(s)` with
        // more fields than `total` takes is fine in the source, where `s` is a variable) and `Readonly`, since render writes nothing.
        const fields = e.properties.map((p) =>
          p.kind === "Property" && p.value.kind === "StateRead" ? `${propertyKey(p.name)}: ${typeText(this.state(p.value.state).type)}` : ""
        );
        return `(${literal} as Readonly<{ ${fields.join("; ")} }>)`;
      }
      case "Arrow":
        return wrap(`(${e.params.map(param).join(", ")}) => ${this.arrowBody(e.body)}`);
      case "Callback":
        return this.callback(e.fn);
      case "Block":
        return `(${this.callback(e.fn)})()`;
      case "Call": {
        const args = e.args.map((a) => this.expr(a, true)).join(", ");
        switch (e.callee.kind) {
          case "Function":
            return `${this.runtimeRenamed.has(e.callee.name) ? runtimeAlias(e.callee.name) : e.callee.name}(${args})`;
          case "Plain":
            return `${e.callee.name}(${args})`;
          case "Local":
            return `${e.callee.name}(${args})`;
          case "Method":
            return `${e.callee.receiver.name}.${e.callee.name}(${args})`;
          case "Prop":
            return `this.props.${e.callee.name}${e.callee.optional ? "?." : e.callee.present === true ? "!" : ""}(${args})`;
          case "ArrayMethod":
            return `${this.expr(e.callee.receiver)}.${e.callee.name}(${args})`;
          case "ValueMethod":
            return `${this.expr(e.callee.receiver)}${e.callee.optional ? "?." : "."}${e.callee.name}(${args})`;
          case "Action":
            return `${this.storeName}.getState().${e.callee.name}(${args})`;
          case "Own":
            return `this.${e.callee.name}(${args})`;
          default:
            return assertNever(e.callee, "callee");
        }
      }
      case "TemplateLiteral":
        return (
          "`" +
          e.quasis
            .map((q, i) => escapeTemplate(q) + (i < e.expressions.length ? `\${${this.expr(e.expressions[i]!, true)}}` : ""))
            .join("") +
          "`"
        );
      case "Unary":
        return wrap(e.operator === "typeof" ? `typeof ${this.expr(e.operand)}` : `${e.operator}${this.expr(e.operand)}`);
      case "New":
        return `new ${e.callee}${e.typeArguments ?? ""}(${e.args.map((a) => this.expr(a, true)).join(", ")})`;
      case "Binary":
        return wrap(`${this.expr(e.left)} ${e.operator} ${this.expr(e.right)}`);
      case "Conditional":
        return wrap(`${this.expr(e.test)} ? ${this.expr(e.whenTrue)} : ${this.expr(e.whenFalse)}`);
      case "Memo": {
        if (this.mode.inlineMemos) return this.expr(e.value, top);
        const local = this.mode.memoLocals.get(e.key) ?? (this.mode.inCallback ? undefined : this.mode.renderMemos.get(e.key));
        if (local !== undefined) return local;
        // Worked out again only when a state or prop it reads is a different value (`===`), as React's useMemo.
        // A memo a handler works out from `useMutable` fields as they are now (`spawns@live`) depends on their live values.
        const live = new Set<StateId>();
        const liveProps = new Set<string>();
        walkExpr(e.value, (x) => {
          if (x.kind === "StateRead" && x.live) live.add(x.state);
          if (x.kind === "PropRead" && x.live) liveProps.add(x.name);
        });
        const deps = collectDependencies(e.value).map((d) =>
          d.kind === "State"
            ? live.has(d.state)
              ? pendingRef(this.state(d.state))
              : `this.${this.state(d.state).name}`
            : d.kind === "Prop"
              ? liveProps.has(d.name)
                ? `this.$live_${d.name}`
                : `this.props.${d.name}`
              : null
        );
        if (deps.includes(null)) throw new Error(`A memo of ${this.c.name} reads a list item`);
        // Read under a condition (`return hero ? <Hp value={hp} /> : null` from `if (!hero) return null;`): TypeScript does not carry
        // the narrowing into the memo's function, so it starts by assuming the condition again, which holds where it is read.
        // A condition that reads this memo (`{boss && <Text>{boss.hp}</Text>}`, `boss` a memo) is not one it can assume: it is what the
        // memo works out, and writing it there would write the memo inside itself, without end.
        const readsSelf = (c: ExprIR): boolean => {
          let found = false;
          walkExpr(c, (x) => {
            if (x.kind === "Memo" && x.key === e.key) found = true;
          });
          return found;
        };
        // A conjunct the memo tests again (`kind === "blast"` over `kind === "aura" ? a : b`) is left out: assumed first, it would
        // narrow `kind` to "blast", and TypeScript would call the memo's own `kind === "aura"` a comparison that cannot be true.
        const compared = comparedReads(e.value);
        const retested = (c: ExprIR): boolean => [...readsOf(c)].some((read) => compared.has(read));
        const conditions = this.mode.inCallback
          ? []
          : this.mode.conditions
              .filter((c) => !readsSelf(c))
              .flatMap(conjuncts)
              .filter((c) => !retested(c));
        if (conditions.length > 0) {
          this.usesAssume = true;
          return `this.$memo(${JSON.stringify(e.key)}, [${deps.join(", ")}], () => { $assume(${conditions.map((c) => this.expr(c)).join(" && ")}); return ${this.expr(e.value, true)}; })`;
        }
        return `this.$memo(${JSON.stringify(e.key)}, [${deps.join(", ")}], () => ${this.arrowBody(e.value)})`;
      }
      default:
        return assertNever(e, "expression");
    }
  }
}

/** The parts of `a && b && c`, or the expression itself. */
function conjuncts(e: ExprIR): ExprIR[] {
  return e.kind === "Binary" && e.operator === "&&" ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
}

/** What an expression reads that a condition could narrow: state, props, locals, parameters and memos, each as one key. */
function readsOf(e: ExprIR): Set<string> {
  const reads = new Set<string>();
  walkExpr(e, (x) => {
    if (x.kind === "StateRead") reads.add(`state:${String(x.state)}`);
    else if (x.kind === "PropRead") reads.add(`prop:${x.name}`);
    else if (x.kind === "LocalRead") reads.add(`local:${String(x.local)}`);
    else if (x.kind === "ParamRead") reads.add(`param:${String(x.param)}`);
    else if (x.kind === "Memo") reads.add(`memo:${x.key}`);
  });
  return reads;
}

/** What an expression compares with `===`, `!==`, `==` or `!=` (either side), as `readsOf` keys. */
function comparedReads(e: ExprIR): Set<string> {
  const compared = new Set<string>();
  walkExpr(e, (x) => {
    if (x.kind === "Binary" && (x.operator === "===" || x.operator === "!==" || x.operator === "==" || x.operator === "!=")) {
      for (const read of readsOf(x.left)) compared.add(read);
      for (const read of readsOf(x.right)) compared.add(read);
    }
  });
  return compared;
}
