import { type RuntimeManifest } from "@tsengine/runtime";
// The base of the component lowering: fields, names, diagnostics and type helpers. Layer 0 of ComponentLowering (see transform.ts).
import { SyntaxKind, type Expression, type PropertyAccessExpression, type Node, type SourceFile } from "typescript/ast";
import {
  isPropertyAccessExpression,
  isIdentifier,
  isArrayTypeNode,
  isUnionTypeNode,
  isBindingElement,
  isFunctionDeclaration,
  isImportClause,
  isImportSpecifier,
  isNamespaceImport,
  isParameterDeclaration,
  isVariableDeclaration,
} from "typescript/ast/is";

import { unwrapParens, type TypeDeclarationAnalysis, type ComponentAnalysis } from "../analyzer/analyzer.ts";
import { DiagnosticCode, error, type CompilerDiagnostic } from "../diagnostics/diagnostics.ts";
import { type GameStateDefinition } from "../gamestate/schema.ts";
import {
  type OwnFunctionIR,
  type TypeIR,
  type ParamIR,
  type ValuePropIR,
  type PropIR,
  readsParam,
  functionReadsParam,
  collectDependencies,
  type SoundIR,
  type PropDeclIR,
  type PropTypeIR,
  type ElementIR,
  type ExprIR,
  type ParamReadIR,
  type SourceSpan,
  type StateId,
  type ValueType,
  type StateIR,
  type HookIR,
} from "../ir/types.ts";
import { spanOf } from "../parser/parser.ts";
import { type AuthoringImports, rootTag, unwrapTypeParens, literalValue, nearest } from "./helpers.ts";
import { Scope } from "./scope.ts";

/** The CSS names of keyword values that the runtime spells differently. */
const CSS_ALIASES: Readonly<Record<string, string>> = { "flex-start": "start", "flex-end": "end" };

/**
 * Where the lowering is, which decides what the code there may do. Each field is set for a stretch of lowering with `within`
 * (never assigned directly), so leaving the stretch always restores it.
 */
export interface LoweringMode {
  /** In a handler or callback body: where a handler's own `let` locals live. */
  readonly inHandler: boolean;
  /** In a `useUnmount` handler: the component is going away, so a setter could never render. */
  readonly inUnmount: boolean;
  /**
   * In a render block (statements in the component body): it computes like a handler (loops, its own values, the standard
   * library) but runs during render, so it may not set state, play sounds, call actions or read refs.
   */
  readonly inRenderBlock: boolean;
  /** Lowering the value of `onX={onX}`, where a callback prop may be forwarded whole. */
  readonly allowCallbackRead: boolean;
  /** In a computed selector: where the snapshots of the paths it reads go. */
  readonly storeReads: { readonly state: StateIR[]; readonly hooks: HookIR[]; readonly storeName: string } | null;
}

const TOP_LEVEL: LoweringMode = { inHandler: false, inUnmount: false, inRenderBlock: false, allowCallbackRead: false, storeReads: null };

/** What every component of a module is lowered against: built once per file in `buildModuleIR`, shared by its components. */
export interface ModuleContext {
  readonly sourceFile: SourceFile;
  readonly fileName: string;
  readonly manifest: RuntimeManifest;
  /** The built-ins this file can use: the manifest's, less any its own components shadow. */
  readonly intrinsics: ReadonlySet<string>;
  /** Components declared in this file. */
  readonly locals: ReadonlySet<string>;
  /** Components imported from other `.tsx` files, by local name. */
  readonly imported: ReadonlyMap<string, { module: string; isDefault: boolean }>;
  readonly authoring: AuthoringImports;
  readonly typeDecls: ReadonlyMap<string, TypeDeclarationAnalysis>;
  /** Shared by every component: each pushes its diagnostics here. */
  readonly diagnostics: CompilerDiagnostic[];
  /** The analysis found an error already (a props parameter not in the supported form): names it left undeclared are not reported again. */
  readonly analysisFailed: boolean;
  readonly gameState: GameStateDefinition | undefined;
  readonly storeImports: ReadonlySet<string>;
  /** Functions and constants from relative `.ts` files and the file's own top-level declarations. */
  readonly plainImports: ReadonlySet<string>;
}

export class LoweringBase {
  readonly componentName: string;
  /** Component scope; function lowering nests scopes beneath it via `scope`. */
  protected readonly componentScope = new Scope();
  protected readonly stateTypes = new Map<StateId, TypeIR>();
  /** The state slots that are fields of a `useMutable`: a handler reads them as they are now (a `live` read). */
  protected readonly mutableStates = new Set<StateId>();
  /** The values a `useContext` reads: a handler reads one live, as its provider's parent has it now (`ContextReader.live`). */
  protected readonly contextValues = new Set<StateId>();
  protected serial = 0;
  scope: Scope = this.componentScope;
  protected readonly usedNames: Set<string>;
  protected readonly component: ComponentAnalysis;
  protected readonly sourceFile: SourceFile;
  protected readonly fileName: string;
  protected readonly manifest: RuntimeManifest;
  protected readonly intrinsics: ReadonlySet<string>;
  protected readonly locals: ReadonlySet<string>;
  protected readonly imported: ReadonlyMap<string, { module: string; isDefault: boolean }>;
  protected readonly hostIntrinsic: string;
  protected readonly authoring: AuthoringImports;
  protected readonly typeDecls: ReadonlyMap<string, TypeDeclarationAnalysis>;
  protected propDecls: readonly PropDeclIR[] = [];
  protected readonly diagnostics: CompilerDiagnostic[];
  protected errorCount = 0;
  /** Where the lowering is now, and so what the code there may do. Changed only through `within`. */
  protected mode: LoweringMode = TOP_LEVEL;
  /** The props type declares `children: Child`. */
  protected declaredChildren = false;
  /** A `{children}` slot has been lowered (there may be one). */
  protected slotSeen = false;
  /** A `{children}` was written where it cannot go (already reported, so the missing slot is not reported again). */
  protected slotRejected = false;
  protected readonly sounds: SoundIR[] = [];
  /** Functions declared in the body (`const handleHit = (id: string) => { … }`). */
  protected readonly functions: OwnFunctionIR[] = [];
  /** Callback props known to be passed where the arrow being lowered is made: see `lowerCallbackChoice`. */
  protected presentCallbacks: ReadonlySet<string> = new Set();
  protected readonly gameState: GameStateDefinition | undefined;
  protected readonly storeImports: ReadonlySet<string>;
  /** Names of functions imported from relative `.ts` files, which a component may call and pass. */
  protected readonly plainImports: ReadonlySet<string>;
  /** State made once per instance by a factory (`useMutable({ body: createBody(…) })`), whose methods handlers may call. */
  protected readonly handleStates = new Set<string>();
  /** The handles a runtime factory made (`createBody()`): only called, never written through. */
  protected readonly runtimeHandleStates = new Set<string>();
  /** Every path of the game state this component reads, to the snapshot that holds it (see `storePathState`). */
  protected readonly storePaths = new Map<string, StateId>();
  /** Each name a selector gave a value of the game state (`const run = useGame((s) => s.run)`), with its path: never written. */
  protected readonly storeNames = new Map<string, string>();

  constructor(component: ComponentAnalysis, module: ModuleContext) {
    this.gameState = module.gameState;
    this.storeImports = module.storeImports;
    this.plainImports = module.plainImports;
    this.typeDecls = module.typeDecls;
    this.authoring = module.authoring;
    this.component = component;
    this.componentName = component.name;
    this.sourceFile = module.sourceFile;
    this.fileName = module.fileName;
    this.manifest = module.manifest;
    this.intrinsics = module.intrinsics;
    this.imported = module.imported;
    // A component extends its root element's class, so it may not reuse that class's own field names.
    this.usedNames = new Set([
      ...module.manifest.reservedMembers,
      ...(module.intrinsics.has(rootTag(component.jsx, module.manifest.hostIntrinsic))
        ? (module.manifest.intrinsicMembers[rootTag(component.jsx, module.manifest.hostIntrinsic)] ?? [])
        : []),
    ]);
    this.locals = module.locals;
    this.hostIntrinsic = module.manifest.hostIntrinsic;
    this.diagnostics = module.diagnostics;
    this.analysisFailed = module.analysisFailed;
  }

  /** A prop type as the compiler understands it; anything else is carried as source text. */
  protected propType(node: Node | null): PropTypeIR {
    if (node === null) return { kind: "SourceText", text: "unknown" };
    const t = unwrapTypeParens(node);
    switch (t.kind) {
      case SyntaxKind.NumberKeyword:
        return { kind: "Primitive", name: "number" };
      case SyntaxKind.StringKeyword:
        return { kind: "Primitive", name: "string" };
      case SyntaxKind.BooleanKeyword:
        return { kind: "Primitive", name: "boolean" };
    }
    if (isArrayTypeNode(t)) {
      const element = this.propType(t.elementType);
      return element.kind === "SourceText" ? { kind: "SourceText", text: t.getText(this.sourceFile) } : { kind: "Array", element };
    }
    const literals = isUnionTypeNode(t) ? t.types.map((u) => literalValue(u)) : [literalValue(t)];
    if (literals.every((v) => v !== null)) return { kind: "Literals", values: literals as (string | number)[] };
    return { kind: "SourceText", text: t.getText(this.sourceFile) };
  }

  /** A type argument: primitives and arrays are understood; anything else is kept as source text for the type-check. */
  typeFromNode(node: Node): TypeIR {
    const t = unwrapTypeParens(node);
    switch (t.kind) {
      case SyntaxKind.NumberKeyword:
        return { kind: "Primitive", name: "number" };
      case SyntaxKind.StringKeyword:
        return { kind: "Primitive", name: "string" };
      case SyntaxKind.BooleanKeyword:
        return { kind: "Primitive", name: "boolean" };
    }
    if (isArrayTypeNode(t)) return { kind: "Array", element: this.typeFromNode(t.elementType) };
    return { kind: "SourceType", text: t.getText(this.sourceFile) };
  }

  /**
   * The type of an initial value, as TypeScript would infer it: literals, a
   * primitive prop (from its declaration in the props type), and operators
   * over those (`props.speed * 10` is a number, `n > 0` a boolean). Null
   * when it cannot be told, and the author writes the type with `as`.
   */
  protected inferType(expr: ExprIR): ValueType | null {
    switch (expr.kind) {
      case "NumberLiteral":
        return "number";
      case "StringLiteral":
      case "TemplateLiteral":
        return "string";
      case "BooleanLiteral":
        return "boolean";
      /** `Math.PI`, `Math.E`: the constants a component may write. */
      case "PlainRef":
        return /^Math\.[A-Z][A-Z0-9_]*$/.test(expr.name) ? "number" : null;
      case "StateRead": {
        const type = this.stateTypes.get(expr.state);
        return type?.kind === "Primitive" ? (type.name as ValueType) : null;
      }
      case "PropRead": {
        const decl = this.propDecls.find((p) => p.name === expr.name);
        return decl?.role === "value" && decl.type.kind === "Primitive" ? decl.type.name : null;
      }
      case "Unary":
        return expr.operator === "!"
          ? "boolean"
          : expr.operator === "typeof"
            ? "string"
            : this.inferType(expr.operand) === "number"
              ? "number"
              : null;
      case "Binary": {
        switch (expr.operator) {
          case "<":
          case "<=":
          case ">":
          case ">=":
          case "===":
          case "!==":
          case "==":
          case "!=":
          case "instanceof":
          case "in":
            return "boolean";
          case "-":
          case "*":
          case "/":
          case "%":
          case "**":
            return this.inferType(expr.left) === "number" && this.inferType(expr.right) === "number" ? "number" : null;
          case "+": {
            const [left, right] = [this.inferType(expr.left), this.inferType(expr.right)];
            if (left === "string" || right === "string") return left && right ? "string" : null;
            return left === "number" && right === "number" ? "number" : null;
          }
          case "&&":
          case "||":
          case "??": {
            const [left, right] = [this.inferType(expr.left), this.inferType(expr.right)];
            return left !== null && left === right ? left : null;
          }
          default:
            return null;
        }
      }
      case "Conditional": {
        const [a, b] = [this.inferType(expr.whenTrue), this.inferType(expr.whenFalse)];
        return a !== null && a === b ? a : null;
      }
      default:
        return null;
    }
  }

  /** Only a container (`<Entity>`) may hold JSX children; other built-ins are leaves. */
  protected checkContainer(tag: string, childCount: number, at: Node): void {
    if (childCount > 0 && !this.manifest.containerIntrinsics.includes(tag)) {
      this.report(DiagnosticCode.UnsupportedJsxChild, `<${tag}> cannot have children; wrap them in <${this.hostIntrinsic}>.`, at);
    }
  }

  /**
   * A list item's props that read the item or index are re-applied for every
   * item on each render (an `Item` dependency); a callback prop may read the
   * item (generated code looks up its current value by key) but not the
   * index, which changes when items move.
   */
  protected asListItem(el: ElementIR, item: ParamIR, index: ParamIR | null): ElementIR | null {
    const readsItem = (e: ExprIR): boolean => readsParam(e, item.id) || (index !== null && readsParam(e, index.id));
    const dynamic = <T extends ValuePropIR>(p: T): T => {
      if (!readsItem(p.value)) return p;
      return {
        kind: "DynamicProp",
        name: p.name,
        value: p.value,
        dependencies: [...collectDependencies(p.value), { kind: "Item" }],
      } as unknown as T;
    };
    let ok = true;
    const props = el.props.map((p): PropIR => {
      if (p.kind === "SpreadProp") return readsItem(p.value) ? { ...p, dependencies: [...p.dependencies, { kind: "Item" }] } : p;
      if (p.kind !== "CallbackProp") return dynamic(p);
      if (index !== null && functionReadsParam(p.handler, index.id)) {
        this.diagnostics.push(
          error(
            DiagnosticCode.InvalidList,
            `Callback '${p.name}' cannot read the index '${index.name}': it changes when items move. Read the item (\`${item.name}.id\`) instead.`,
            el.span
          )
        );
        this.errorCount++;
        ok = false;
      }
      return p;
    });
    return ok ? { ...el, props, transform: el.transform.map(dynamic) } : null;
  }

  /**
   * A built-in prop that takes one of a fixed set of strings (the manifest's
   * `intrinsicLiterals`, such as `<Shape kind>`): a literal is checked here,
   * with the choices (and the nearest one, for a typo) in the message. Any other
   * expression is left to the type-check, so `kind={big ? "rect" : "circle"}` works.
   */
  protected checkLiteralChoice(tag: string, name: string, value: ExprIR, at: Node): boolean {
    if (this.manifest.intrinsicSizing[tag]?.includes(name)) return this.checkSizingLiteral(tag, name, value, at);
    const allowed = this.manifest.intrinsicLiterals[tag]?.[name];
    if (!allowed) return true;
    if (value.kind === "StringLiteral" && allowed.includes(value.value)) return true;
    if (value.kind !== "StringLiteral" && value.kind !== "NumberLiteral" && value.kind !== "BooleanLiteral" && value.kind !== "NullLiteral")
      return true;
    const given = value.kind === "StringLiteral" ? `'${value.value}'` : value.kind === "NullLiteral" ? "null" : String(value.value);
    // CSS spells start and end `flex-start` and `flex-end`; say so rather than guess from the letters.
    const css = value.kind === "StringLiteral" ? CSS_ALIASES[value.value] : undefined;
    const near = value.kind === "StringLiteral" ? (css !== undefined && allowed.includes(css) ? css : nearest(value.value, allowed)) : null;
    this.report(
      DiagnosticCode.InvalidPropValue,
      `<${tag} ${name}> must be one of ${allowed.map((v) => `"${v}"`).join(", ")}, not ${given}${near ? ` (did you mean "${near}"?)` : ""}.`,
      at
    );
    return false;
  }

  /**
   * A size prop (`<Flex width>`): a literal is a number, `"fit"`, `"grow"`, or a percentage between 0 and 100 such as
   * `"50%"`. Any other expression is left to the type-check.
   */
  protected checkSizingLiteral(tag: string, name: string, value: ExprIR, at: Node): boolean {
    if (value.kind === "NumberLiteral") return true;
    if (value.kind !== "StringLiteral" && value.kind !== "BooleanLiteral" && value.kind !== "NullLiteral") return true;
    if (value.kind === "StringLiteral") {
      if (value.value === "fit" || value.value === "grow") return true;
      const percent = /^(\d+(?:\.\d+)?)%$/.exec(value.value);
      if (percent && Number(percent[1]) <= 100) return true;
    }
    const given = value.kind === "StringLiteral" ? `'${value.value}'` : value.kind === "NullLiteral" ? "null" : String(value.value);
    const near = value.kind === "StringLiteral" ? nearest(value.value, ["fit", "grow"]) : null;
    this.report(
      DiagnosticCode.InvalidPropValue,
      `<${tag} ${name}> must be a number of pixels, "fit", "grow", or a percentage from "0%" to "100%", not ${given}${near ? ` (did you mean "${near}"?)` : ""}.`,
      at
    );
    return false;
  }

  /** `children` or `props.children`, where it names the `children` prop of this component. */
  protected isChildrenReference(node: Expression): boolean {
    if (isIdentifier(node)) return this.scope.get(node.text)?.kind === "children";
    if (isPropertyAccessExpression(node) && node.name.text === "children") {
      const object = unwrapParens(node.expression);
      return isIdentifier(object) && this.scope.get(object.text)?.kind === "propsObject";
    }
    return false;
  }

  /** Checks that `{children}` is somewhere a slot can be. A slot must be in a container that is always there, once. */
  protected lowerChildrenSlot(
    at: Node,
    context: { readonly slot: boolean; readonly passed: boolean; readonly forward?: boolean }
  ): boolean {
    const code = DiagnosticCode.UnsupportedJsxChild;
    this.slotRejected = true;
    if (context.passed && !context.forward) {
      this.report(
        code,
        "`{children}` can be forwarded to a component only when that component is always present: not inside a condition, a list, or another component's children.",
        at
      );
      return false;
    }
    if (!context.slot && !context.passed) {
      this.report(
        code,
        "`{children}` must be a direct child of a container that is always present: not inside a condition, a list, or another component's children.",
        at
      );
      return false;
    }
    if (this.slotSeen) {
      this.report(code, "`{children}` can appear only once in a component.", at);
      return false;
    }
    this.slotSeen = true;
    this.slotRejected = false;
    return true;
  }

  /**
   * `props.speed` for a component that takes `(props: EnemyProps)`. Undefined if
   * `node` is not on the props object (the caller carries on); null after
   * reporting a member the props type does not have.
   */
  protected propsObjectMember(node: PropertyAccessExpression): { name: string; role: "value" | "callback" } | null | undefined {
    const object = unwrapParens(node.expression);
    const binding = isIdentifier(object) ? this.scope.get(object.text) : undefined;
    if (binding?.kind !== "propsObject") return undefined;
    const decl = this.propDecls.find((p) => p.name === node.name.text);
    if (!decl && node.name.text === "children" && this.declaredChildren) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "`children` can only be used as a JSX child, `{props.children}`: it is the elements a parent passes, not a value.",
        node.name
      );
      return null;
    }
    if (!decl) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `'${node.name.text}' is not a prop of ${this.component.props?.typeName ?? "this component"}.`,
        node.name
      );
      return null;
    }
    return { name: decl.name, role: decl.role };
  }

  /** A runtime handle (`createBody()`), whose members are called, not written. */
  isHandleState(state: StateId): boolean {
    return this.runtimeHandleStates.has(state);
  }

  /** Resolves `s.vx` for a `useMutable` value `s` to its state slot. Undefined if `node` is not on one, "error" after reporting. */
  mutableField(node: PropertyAccessExpression): StateId | "error" | undefined {
    const object = unwrapParens(node.expression);
    const binding = isIdentifier(object) ? this.scope.get(object.text) : undefined;
    if (binding?.kind !== "mutable") return undefined;
    const id = binding.fields.get(node.name.text);
    if (id === undefined) {
      const near = nearest(node.name.text, [...binding.fields.keys()]);
      this.report(
        DiagnosticCode.UnknownIdentifier,
        `'${binding.name}' has no field '${node.name.text}'${near ? ` (did you mean '${near}'?)` : ""}. Its fields: ${[...binding.fields.keys()].join(", ")}.`,
        node.name
      );
      return "error";
    }
    return id;
  }

  /** The primitive type of a name, if it is a parameter or state slot whose type is known to be primitive. */
  protected knownPrimitive(node: Expression): ValueType | null {
    const target = unwrapParens(node);
    const binding = isIdentifier(target) ? this.scope.get(target.text) : undefined;
    let type: TypeIR | undefined;
    if (binding?.kind === "param") type = binding.type;
    else if (binding?.kind === "state") type = this.stateTypes.get(binding.id);
    else if (isPropertyAccessExpression(target)) {
      // `s.n`: a `useMutable` field.
      const owner = unwrapParens(target.expression);
      const mutable = isIdentifier(owner) ? this.scope.get(owner.text) : undefined;
      const field = mutable?.kind === "mutable" ? mutable.fields.get(target.name.text) : undefined;
      if (field !== undefined) type = this.stateTypes.get(field);
    }
    return type?.kind === "Primitive" && type.name !== "void" ? type.name : null;
  }

  /** The handler parameter of a runtime handle type (`input`) that `node` names, or null (no diagnostic). */
  protected handleParam(node: Expression): { type: string; read: ParamReadIR } | null {
    const target = unwrapParens(node);
    const binding = isIdentifier(target) ? this.scope.get(target.text) : undefined;
    if (binding?.kind !== "param" || binding.type.kind !== "Named") return null;
    return { type: binding.type.name, read: { kind: "ParamRead", param: binding.id, name: binding.name } };
  }

  /** A hook, built-in element or runtime function must be imported from the authoring module before it is used. */
  protected requireImport(name: string, at: Node): void {
    if (this.authoring.names.has(name) || this.authoring.reported.has(name)) return;
    this.authoring.reported.add(name);
    this.report(
      DiagnosticCode.MissingImport,
      `'${name}' is not imported: add \`import { ${name} } from "${this.manifest.authoringModule}"\`.`,
      at
    );
  }

  protected claimName(name: string, at: Node, code: CompilerDiagnostic["code"] = DiagnosticCode.InvalidUseMutable): boolean {
    if (this.usedNames.has(name)) {
      this.report(code, `'${name}' is already declared or is reserved by the runtime.`, at);
      return false;
    }
    this.usedNames.add(name);
    return true;
  }

  /**
   * The field a state or sound named `name` is kept in: `name` itself, or, when that is a member the runtime's object
   * already has (`name` of an `<Entity>` root, `image` of a `<Sprite>`, `parent`), `$name`, so the author's name never clashes
   * with the root built-in. `$` names are the compiler's own. Null (after reporting) when this component already declared it.
   */
  protected claimField(name: string, at: Node, code: CompilerDiagnostic["code"] = DiagnosticCode.InvalidUseMutable): string | null {
    if (!this.usedNames.has(name)) return this.claimName(name, at, code) ? name : null;
    if (!this.isRuntimeMember(name)) {
      this.report(code, `'${name}' is already declared in this component.`, at);
      return null;
    }
    let field = `$${name}`;
    for (let n = 2; this.usedNames.has(field); n++) field = `$${name}${n}`;
    this.usedNames.add(field);
    return field;
  }

  /** A member of the runtime's object (`name` of an `<Entity>` root, `render`), as opposed to a name this component declared. */
  protected isRuntimeMember(name: string): boolean {
    return (
      this.manifest.reservedMembers.includes(name) ||
      (this.manifest.intrinsicMembers[rootTag(this.component.jsx, this.manifest.hostIntrinsic)] ?? []).includes(name)
    );
  }

  /** A free field name for an element; with a suffix (a list's `enemyItems`), the suffixed name is claimed too. */
  protected allocateFieldName(tag: string, suffix: string | null = null): string {
    const base = tag.charAt(0).toLowerCase() + tag.slice(1);
    const taken = (name: string): boolean => this.usedNames.has(name) || (suffix !== null && this.usedNames.has(name + suffix));
    let candidate = base;
    for (let n = 2; taken(candidate); n++) candidate = `${base}${n}`;
    this.usedNames.add(candidate);
    if (suffix !== null) this.usedNames.add(candidate + suffix);
    return candidate;
  }

  stateType(state: StateId): TypeIR {
    const type = this.stateTypes.get(state);
    if (!type) throw new Error(`Unknown state ${state}`);
    return type;
  }

  isCallableName(name: string): boolean {
    return name === "Math" || this.manifest.functions[name] !== undefined;
  }

  /** Lower something in a changed mode (`{ inHandler: true }`); the mode before is back afterwards, whatever happens. */
  within<T>(patch: Partial<LoweringMode>, lower: () => T): T {
    const outer = this.mode;
    this.mode = { ...outer, ...patch };
    try {
      return lower();
    } finally {
      this.mode = outer;
    }
  }

  /** Lower something in a new scope beneath the current one, which is back afterwards. */
  inScope<T>(lower: (scope: Scope) => T): T {
    const outer = this.scope;
    const scope = new Scope(outer);
    this.scope = scope;
    try {
      return lower(scope);
    } finally {
      this.scope = outer;
    }
  }

  canSetState(): boolean {
    return !this.mode.inUnmount;
  }

  inRenderBlock(): boolean {
    return this.mode.inRenderBlock;
  }

  canPassCallback(): boolean {
    return this.mode.inHandler;
  }

  nextSerial(): number {
    return ++this.serial;
  }

  error(code: CompilerDiagnostic["code"], message: string, node: Node): void {
    this.report(code, message, node);
  }

  protected span(node: Node): SourceSpan {
    return spanOf(node, this.sourceFile, this.fileName);
  }

  /** Every name declared in the component (its locals, state, parameters, functions) or imported by the file. */
  #declared: Set<string> | null = null;
  protected readonly analysisFailed: boolean;

  /**
   * Whether a name the scope does not know is one the author did declare: after an error, the declaration that failed (a `const`
   * whose value was refused, a `useMutable` field without its type) left it out of the scope, and every read of it would be reported
   * again as unknown. Those reads are not: one mistake, one error.
   */
  protected declaredAfterError(name: string): boolean {
    if (this.errorCount === 0 && !this.analysisFailed) return false;
    if (this.#declared === null) {
      const names = new Set<string>();
      const visit = (node: Node): void => {
        if (
          isVariableDeclaration(node) ||
          isParameterDeclaration(node) ||
          isBindingElement(node) ||
          isFunctionDeclaration(node) ||
          isImportClause(node) ||
          isNamespaceImport(node) ||
          isImportSpecifier(node)
        ) {
          const name = (node as { name?: Node }).name;
          if (name !== undefined && isIdentifier(name)) names.add(name.text);
        }
        node.forEachChild(visit);
      };
      visit(this.sourceFile);
      this.#declared = names;
    }
    return this.#declared.has(name);
  }

  protected report(code: CompilerDiagnostic["code"], message: string, node: Node): void {
    this.errorCount++;
    this.diagnostics.push(error(code, message, this.span(node)));
  }
}
