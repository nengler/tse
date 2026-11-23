import { SyntaxKind, type ArrowFunction, type Node } from "typescript/ast";
import {
  isArrowFunction,
  isBlock,
  isIdentifier,
  isFunctionTypeNode,
  isTypeLiteralNode,
  isInterfaceDeclaration,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
} from "typescript/ast/is";

import {
  unwrapParens,
  type TypeDeclarationAnalysis,
  type UseMutableCallAnalysis,
  type UseSoundCallAnalysis,
  type UseStoreCallAnalysis,
  type UseContextCallAnalysis,
} from "../analyzer/analyzer.ts";
// Layer 2 of ComponentLowering: props declarations, hooks (useMutable, useSound, useGameState, handlers) and state types.
import { runtimeAlias } from "../analyzer/util.ts";
import { DiagnosticCode, warning, type CompilerDiagnostic } from "../diagnostics/diagnostics.ts";
import { type GameStateEntry } from "../gamestate/schema.ts";
import { HANDLER_SIGNATURES } from "../ir/handlers.ts";
import {
  type StateId,
  type TypeIR,
  collectDependencies,
  childExpressions,
  soundId,
  stateId,
  type PropDeclIR,
  type PropTypeIR,
  type ExprIR,
  type HookIR,
  type MutableFieldIR,
  type StateIR,
} from "../ir/types.ts";
import { ExpressionLowering } from "./expressions.ts";
import { HANDLER_KIND, RESERVED_PROP_NAMES, unwrapTypeParens, nearest, propTypeToType } from "./helpers.ts";
import { lowerFunction, lowerRenderBlock } from "./statements.ts";

export class HookLowering extends ExpressionLowering {
  /** Render blocks lowered so far, to name their memos (`$block1`). */
  private renderBlocks = 0;
  /** `useContext` calls lowered so far, to name their readers (`$context1`). */
  private contexts = 0;
  /** Actions taken from the whole state, by the statement they were written in: one warning each (see `lowerStoreHook`). */
  private readonly wholeStateActions = new Map<string, { index: number; names: string[] }>();
  /**
   * Resolve the props parameter against the props type declared in this file,
   * declare each destructured prop in scope, and describe every member of the
   * type (destructured or not) for the prefab registry.
   */
  protected lowerPropDecls(): PropDeclIR[] {
    const analysis = this.component.props;
    if (!analysis) return [];
    const code = DiagnosticCode.InvalidProps;
    const decl = this.typeDecls.get(analysis.typeName);
    if (!decl) {
      this.report(
        code,
        `Props type '${analysis.typeName}' is not declared in this file (declare an \`interface ${analysis.typeName} { … }\`).`,
        analysis.typeNode
      );
      return [];
    }
    const members = this.propMembers(decl);
    if (!members) return [];

    const bindings = new Map(analysis.bindings.map((b) => [b.name, b] as const));
    if (analysis.objectName !== null) this.componentScope.declare(analysis.objectName, { kind: "propsObject", name: analysis.objectName });
    for (const binding of analysis.bindings) {
      if (!members.has(binding.name)) {
        this.report(code, `'${binding.name}' is not a prop of ${analysis.typeName}.`, binding.node);
      }
    }

    const out: PropDeclIR[] = [];
    for (const [name, member] of members) {
      // `children: TextChild | readonly TextChild[]`: the words between the component's tags, passed as one string (a text
      // wrapper: `<Label>Coins: {coins}</Label>`). An ordinary value prop, which its `<Text>{children}</Text>` reads.
      const textChildren =
        name === "children" && member.role === "value" && member.type.kind === "SourceText" && isTextChildrenType(member.type.text);
      if (name === "children" && !textChildren) {
        // Not a value prop: the elements a parent passes mount at `{children}`. Typed `Child` so the TSX type-checks.
        const binding = bindings.get(name);
        if (member.role !== "value" || member.type.kind !== "SourceText" || member.type.text !== "Child") {
          this.report(
            code,
            `\`children\` must be typed \`Child\` (elements: \`children: Child;\`) or \`TextChild | readonly TextChild[]\` (text, as \`<Text>\` takes it), with \`import { type Child, type TextChild } from "${this.manifest.authoringModule}"\`.`,
            member.node
          );
        } else if (binding?.defaultValue) {
          this.report(code, "`children` cannot have a default value.", binding.node);
        } else {
          this.declaredChildren = true;
          if (binding) this.componentScope.declare(binding.local, { kind: "children", name });
        }
        continue;
      }
      if (RESERVED_PROP_NAMES.has(name) && !textChildren) {
        this.report(code, `'${name}' is reserved by the framework and cannot be a prop name.`, member.node);
        continue;
      }
      const binding = bindings.get(name);
      let defaultValue: ExprIR | null = null;
      if (binding?.defaultValue) {
        if (member.role === "callback") {
          this.report(code, `Callback prop '${name}' cannot have a default value; call it with \`${name}?.()\` instead.`, binding.node);
        } else {
          defaultValue = this.lowerNode(binding.defaultValue);
          if (defaultValue && collectDependencies(defaultValue).length > 0) {
            this.report(code, `The default for '${name}' must be a constant: it cannot read state or other props.`, binding.defaultValue);
            defaultValue = null;
          }
        }
      }
      out.push({
        kind: "PropDecl",
        name,
        optional: member.optional || binding?.defaultValue != null,
        defaultValue,
        role: member.role,
        type: member.type,
      });
      if (binding) {
        if (this.componentScope.hasOwn(binding.local)) {
          this.report(code, `'${binding.local}' is already declared in this component.`, binding.node);
        } else {
          this.componentScope.declare(binding.local, { kind: "prop", name, role: member.role });
        }
      }
    }
    return out;
  }

  /** The members of a props type: an `interface` or a `type` alias of an object type, with plain named members. */
  protected propMembers(
    decl: TypeDeclarationAnalysis
  ): Map<string, { optional: boolean; role: "value" | "callback"; type: PropTypeIR; node: Node }> | null {
    const code = DiagnosticCode.InvalidProps;
    const node = decl.node;
    let elements: readonly Node[];
    if (isTypeLiteralNode(node)) elements = node.members;
    else if (isInterfaceDeclaration(node)) {
      if (node.heritageClauses && node.heritageClauses.length > 0) {
        this.report(code, `Props type '${decl.name}' cannot extend another type: list the props in one interface.`, node);
        return null;
      }
      elements = node.members;
    } else if (isTypeLiteralNode(node.type)) {
      elements = node.type.members;
    } else {
      this.report(code, `Props type '${decl.name}' must be an object type: \`type ${decl.name} = { … }\`.`, node);
      return null;
    }
    const out = new Map<string, { optional: boolean; role: "value" | "callback"; type: PropTypeIR; node: Node }>();
    for (const element of elements) {
      const member = element as unknown as { kind: SyntaxKind; name?: Node; type?: Node; postfixToken?: Node };
      const isProperty = member.kind === SyntaxKind.PropertySignature;
      const isMethod = member.kind === SyntaxKind.MethodSignature;
      if ((!isProperty && !isMethod) || !member.name || !isIdentifier(member.name)) {
        this.report(code, `Props type '${decl.name}': members must be plain \`name: type\` or \`name(): void\`.`, element);
        continue;
      }
      const optional = member.postfixToken?.kind === SyntaxKind.QuestionToken;
      const typeNode = member.type ? unwrapTypeParens(member.type) : null;
      const role = isMethod || (typeNode !== null && isFunctionTypeNode(typeNode)) ? "callback" : "value";
      const type: PropTypeIR = role === "callback" ? { kind: "Function" } : this.propType(typeNode);
      out.set(member.name.text, { optional, role, type, node: element });
    }
    return out;
  }

  protected lowerHooks(): { hooks: HookIR[]; state: StateIR[] } {
    const hooks: HookIR[] = [];
    const state: StateIR[] = [];
    for (const hook of this.component.hooks) {
      if (hook.kind !== "const" && hook.kind !== "block" && hook.kind !== "useStore") this.requireImport(hook.kind, hook.call);
      switch (hook.kind) {
        case "useStore":
          this.lowerStore(hook, state, hooks);
          break;
        case "useUpdate":
        case "useInput":
        case "useMount":
        case "useUnmount": {
          const kind = HANDLER_KIND[hook.kind];
          const signature = HANDLER_SIGNATURES[kind];
          // In `useUnmount` the component is going away: it can no longer render, so there is nothing for a setter to do.
          const handler = this.within({ inHandler: true, inUnmount: hook.kind === "useUnmount" }, () =>
            lowerFunction(this, hook.handler, {
              paramTypes: signature.params.map((p) => p.type),
              returns: hook.kind === "useMount" ? "cleanup" : "void",
              what: `${hook.kind} handler`,
            })
          );
          if (handler) hooks.push({ kind, handler, span: this.span(hook.statement) });
          break;
        }
        case "useContext":
          this.lowerUseContext(hook, state, hooks);
          break;
        case "useSound":
          this.lowerUseSound(hook);
          break;
        case "block": {
          // Statements that compute together: one memo, worked out again when what the block reads changes; each name it declares
          // is a derived value that reads its member.
          const fn = this.within({ inRenderBlock: true }, () => lowerRenderBlock(this, hook.statements, hook.names, hook.first));
          if (!fn) break;
          const key = `$block${++this.renderBlocks}`;
          const value: ExprIR = { kind: "Memo", key, value: { kind: "Block", fn } };
          // In a handler, the block is worked out from `useMutable` fields as they are now: under a memo of its own, so once until a
          // field it reads is written.
          const relowerBlock = (): ExprIR | null => {
            const live = this.within({ inRenderBlock: true }, () => lowerRenderBlock(this, hook.statements, hook.names, hook.first));
            return live && { kind: "Memo", key: `${key}@live`, value: { kind: "Block", fn: live } };
          };
          for (const name of hook.names) {
            if (this.componentScope.hasOwn(name) || this.isCallableName(name)) {
              this.report(
                DiagnosticCode.InvalidComponentBody,
                `'${name}' is already declared in this component (or reserved).`,
                hook.first
              );
              continue;
            }
            const pick = (object: ExprIR): ExprIR => ({ kind: "MemberRead", object, name, optional: false });
            this.componentScope.declare(name, {
              kind: "derived",
              name,
              value: pick(value),
              relower: () => {
                const live = relowerBlock();
                return live && pick(live);
              },
            });
          }
          break;
        }
        case "const": {
          // `const handleHit = (id: string) => { … }`: a handler of the component's own, kept in a field.
          if (hook.pattern === null && isArrowFunction(unwrapParens(hook.initializer))) {
            this.lowerOwnFunction(hook.name, unwrapParens(hook.initializer) as ArrowFunction, hook.declaration);
            break;
          }
          // `const squash = s`: another name for the same fields, read and written as `squash.x`. This is how a custom hook hands its
          // `useMutable` back: its `return s` is inlined as `const squash = <the hook's s>`.
          const aliased = unwrapParens(hook.initializer);
          const target = hook.pattern === null && isIdentifier(aliased) ? this.componentScope.get(aliased.text) : undefined;
          if (target?.kind === "mutable") {
            if (this.componentScope.hasOwn(hook.name) || this.isCallableName(hook.name)) {
              this.report(
                DiagnosticCode.InvalidComponentBody,
                `'${hook.name}' is already declared in this component (or reserved).`,
                hook.declaration.name
              );
              break;
            }
            this.componentScope.declare(hook.name, { ...target, name: hook.name });
            break;
          }
          // Lowered now, against what is declared above it (state, refs, earlier consts), outside any handler.
          const lowered = this.lowerNode(hook.initializer);
          if (!lowered) break;
          const value = memoized(hook.name, lowered);
          // In a handler, worked out from `useMutable` fields as they are now (`@live`: a memo of its own, with the fields' live values as
          // what it depends on, so once until a field it reads is written).
          const initializer = hook.initializer;
          const relowerValue = (): ExprIR | null => {
            const live = this.lowerNode(initializer);
            return live && memoized(`${hook.name}@live`, live);
          };
          if (hook.pattern === null) {
            if (this.componentScope.hasOwn(hook.name) || this.isCallableName(hook.name)) {
              this.report(
                DiagnosticCode.InvalidComponentBody,
                `'${hook.name}' is already declared in this component (or reserved).`,
                hook.declaration.name
              );
              break;
            }
            this.componentScope.declare(hook.name, { kind: "derived", name: hook.name, value, relower: relowerValue });
            break;
          }
          // `const { x, y } = heroOf(run)`: each name is a member of the one value, which is worked out once (a memo) when it calls something.
          const entries =
            hook.pattern.kind === "object"
              ? hook.pattern.entries.map((e) => ({
                  name: e.name,
                  node: e.node,
                  pick: (object: ExprIR): ExprIR => ({ kind: "MemberRead", object, name: e.key, optional: false }),
                }))
              : hook.pattern.entries.flatMap((e, i) =>
                  e === null
                    ? []
                    : [
                        {
                          name: e.name,
                          node: e.node,
                          pick: (object: ExprIR): ExprIR => ({
                            kind: "IndexRead",
                            object,
                            index: { kind: "NumberLiteral", value: i },
                            optional: false,
                          }),
                        },
                      ]
                );
          for (const entry of entries) {
            if (this.componentScope.hasOwn(entry.name) || this.isCallableName(entry.name)) {
              this.report(
                DiagnosticCode.InvalidComponentBody,
                `'${entry.name}' is already declared in this component (or reserved).`,
                entry.node
              );
              continue;
            }
            const relower = (): ExprIR | null => {
              const live = relowerValue();
              return live && entry.pick(live);
            };
            this.componentScope.declare(entry.name, { kind: "derived", name: entry.name, value: entry.pick(value), relower });
          }
          break;
        }
        case "useMutable":
          this.lowerUseMutable(hook, state, hooks);
          break;
      }
    }
    return { hooks, state };
  }

  /**
   * `const s = useMutable({ vx: 0, vy: 0 })`: each field is a state slot of its own; `s.vx` reads it
   * and `s.vx = …` writes it. What differs is the handler's view: it reads its own writes at once (a `live` read), while render
   * and everything else sees the committed value, as with any state. The name is claimed as a field (`s`, or `$s` where the root
   * built-in has that member), since the class gets a getter of that name (`component.s.vx`). Each slot's id is `Hero.s.vx`: hot
   * reload, saves, the inspector and `@tsengine/testing` know it as `s.vx`, and a dot cannot be part of a name, so it is unambiguous.
   */
  protected lowerUseMutable(hook: UseMutableCallAnalysis, state: StateIR[], hooks: HookIR[]): void {
    if (this.componentScope.hasOwn(hook.name) || this.isCallableName(hook.name)) {
      this.report(DiagnosticCode.InvalidUseMutable, `'${hook.name}' is already declared in this component.`, hook.declaration);
      return;
    }
    const view = this.claimField(hook.name, hook.declaration);
    if (view === null) return;
    const fields = new Map<string, StateId>();
    for (const field of hook.fields) {
      if (fields.has(field.name)) {
        this.report(DiagnosticCode.InvalidUseMutable, `useMutable has '${field.name}' twice.`, hook.declaration);
        return;
      }
      const mutable: MutableFieldIR = { name: hook.name, view, field: field.name };
      const id = this.lowerMutableField(hook, field, state, hooks, mutable);
      if (id === null) return;
      this.mutableStates.add(id);
      fields.set(field.name, id);
    }
    this.componentScope.declare(hook.name, { kind: "mutable", name: hook.name, fields });
  }

  /**
   * One field of a `useMutable`: kept in `$s_vx`, set by `$set_s_vx`, and not in scope by a name of its own (it is read as `s.vx`).
   * The state's id, or null after reporting.
   */
  protected lowerMutableField(
    hook: UseMutableCallAnalysis,
    source: UseMutableCallAnalysis["fields"][number],
    state: StateIR[],
    hooks: HookIR[],
    mutable: MutableFieldIR
  ): StateId | null {
    const field = this.claimField(`$${mutable.view}_${mutable.field}`, hook.declaration);
    if (field === null) return null;
    const setterMethod = this.claimField(`$set_${mutable.view}_${mutable.field}`, hook.declaration);
    if (setterMethod === null) return null;
    const id = stateId(this.component.name, `${mutable.name}.${mutable.field}`);
    if (!source.initializer) {
      this.report(DiagnosticCode.InvalidUseMutable, "A useMutable field needs an initial value.", hook.call);
      return null;
    }
    // Initial values are evaluated before any state exists: lower with the scope as it is so far,
    // then reject any state reads. A field `useMutable({ body: () => make() })` reads like React's lazy initializer: the generated field is evaluated
    // once per instance anyway, so the arrow's body is the initial value (a per-instance object, such as an effect).
    const lazy = unwrapParens(source.initializer);
    let initializer = source.initializer;
    if (isArrowFunction(lazy)) {
      if (lazy.parameters.length > 0 || isBlock(lazy.body)) {
        this.report(
          DiagnosticCode.InvalidUseMutable,
          "A field's lazy initial value is an arrow with no parameters returning the value: `squash: () => createSquash()`.",
          lazy
        );
        return null;
      }
      initializer = lazy.body as typeof initializer;
    }
    const initialValue = this.lowerNode(initializer);
    if (!initialValue) return null;
    // It may read props, the game state (`{ cursor: start }` with `const start = useGame((s) => s.titleCursor)`) and the
    // component's state declared above it (`{ spring: startSpring(target) }`): all are there when the component is made,
    // which is when the initial value is taken, as in a React first render. (The scope holds only what is declared above.)
    const type = this.hookStateType(source.typeNode, initialValue, hook.call);
    if (!type) return null;
    // Made by a function: a per-instance object, which a handler may call methods of (`st.tally.add(1)`). A runtime factory's
    // (`createBody()`) is only called; one of the game's own (`makeHero()`) may also be written through, as data is
    // (`s.hero.hp -= 1`, a copy with the change made).
    const handle =
      type.kind === "SourceType" &&
      initialValue.kind === "Call" &&
      (initialValue.callee.kind === "Function" || initialValue.callee.kind === "Plain");
    if (handle) this.handleStates.add(id);
    if (handle && initialValue.callee.kind === "Function") this.runtimeHandleStates.add(id);
    state.push({ kind: "State", id, name: field, type, initialValue, ...(handle ? { handle: true as const } : {}), mutable });
    this.stateTypes.set(id, type);
    hooks.push({ kind: "StateSlot", state: id, setterName: setterMethod, span: this.span(hook.declaration) });
    return id;
  }

  /**
   * `const hp = useGame((s) => s.player.hp)`: a state mirroring one leaf of the game state (a snapshot, refreshed
   * when the leaf changes), or `const collect = useGame((s) => s.collect)`: an action, called as a statement in a
   * handler. The path is checked against the state tree `GameState.ts` declares.
   *
   * A computed selector (`useGame((s) => s.cursor === id)`) is a derived value: each path it reads becomes a snapshot of
   * its own (shared with any other read of the same path in this component), and the expression reads those, so it is
   * worked out again whenever one of them changes, as a React selector is.
   */
  protected lowerStore(hook: UseStoreCallAnalysis, state: StateIR[], hooks: HookIR[]): void {
    const definition = this.gameState;
    if (!definition || !this.storeImports.has(hook.storeName)) return; // already reported where the import was checked
    if (hook.body !== null) {
      if (this.componentScope.hasOwn(hook.valueName) || this.isCallableName(hook.valueName)) {
        this.report(
          DiagnosticCode.InvalidUseMutable,
          `'${hook.valueName}' is already declared in this component (or reserved).`,
          hook.declaration
        );
        return;
      }
      const body = hook.body;
      const value = this.inScope((scope) => {
        scope.declare(hook.parameter, { kind: "storeRoot", name: hook.parameter });
        return this.within({ storeReads: { state, hooks, storeName: hook.storeName } }, () => this.lowerNode(body));
      });
      if (value)
        this.componentScope.declare(hook.valueName, { kind: "derived", name: hook.valueName, value: memoized(hook.valueName, value) });
      return;
    }
    if (this.componentScope.hasOwn(hook.valueName)) {
      this.report(DiagnosticCode.InvalidUseMutable, `'${hook.valueName}' is already declared in this component.`, hook.declaration);
      return;
    }
    const first = hook.path[0] as string;
    const isAction = hook.path.length === 1 && definition.actions.includes(first);
    if (hook.via === "actions" && !isAction) {
      const near = nearest(first, definition.actions);
      const known = Object.hasOwn(definition.tree.children, first);
      this.report(
        DiagnosticCode.InvalidGameState,
        known
          ? `'${first}' is a value of the game state, not an action: read it with \`const ${hook.valueName} = ${hook.storeName}((s) => s.${first})\`.`
          : `'${first}' is not an action of the game state${near ? ` (did you mean "${near}"?)` : ""}. Actions: ${definition.actions.length > 0 ? definition.actions.join(", ") : "none"}.`,
        hook.declaration
      );
      return;
    }
    if (hook.via === "whole" && isAction) {
      // One warning for the statement, naming every action it took (each name reaches here as its own selector).
      const span = this.span(hook.declaration);
      const statement = `${hook.storeName}:${hook.group}`;
      const earlier = this.wholeStateActions.get(statement);
      const names = [...(earlier?.names ?? []), hook.valueName];
      const diagnostic = warning(
        DiagnosticCode.InvalidGameState,
        `Take actions with \`const { ${names.join(", ")} } = ${hook.storeName}.actions()\` rather than from the whole state (\`${hook.storeName}((s) => s)\`).`,
        span
      );
      if (earlier) this.diagnostics[earlier.index] = diagnostic;
      else this.diagnostics.push(diagnostic);
      this.wholeStateActions.set(statement, { index: earlier?.index ?? this.diagnostics.length - 1, names });
    }
    if (isAction) {
      if (!this.claimName(hook.valueName, hook.declaration)) return;
      this.componentScope.declare(hook.valueName, { kind: "action", name: hook.valueName, action: first });
      return;
    }
    // A value read from the game state is kept in a field of the component. When its name is a member the runtime already has
    // (`const name = useGame((s) => s.speaker)` in an `<Entity>` root, whose `name` is the entity's), the field is `$name`: the
    // author's name stays as written, and `$` names are the compiler's alone.
    let field = hook.valueName;
    if (this.usedNames.has(field)) {
      if (!this.isRuntimeMember(field)) {
        this.report(
          DiagnosticCode.InvalidUseMutable,
          `'${hook.valueName}' is already declared or is reserved by the runtime.`,
          hook.declaration
        );
        return;
      }
      field = `$${field}`;
    }
    const id = this.storePathState(hook.path, field, hook.selector, state, hooks);
    if (id) this.componentScope.declare(hook.valueName, { kind: "state", id });
  }

  /**
   * The snapshot of one path of the game state, named `name` (claimed here), after checking the path against the schema.
   * Null when the path is wrong (reported).
   */
  protected storePathState(path: readonly string[], name: string, at: Node, state: StateIR[], hooks: HookIR[]): StateId | null {
    const definition = this.gameState!;
    // Walk the state tree; a typo is reported with the nearest key at the level it went wrong. Below a value the compiler
    // cannot see into (an array, `newRun()`), the path is left to the type-check of the generated code.
    let node: GameStateEntry = definition.tree;
    const walked: string[] = [];
    for (const key of path) {
      if (node.kind === "value") break;
      if (node.kind === "leaf") {
        this.report(DiagnosticCode.InvalidGameState, `'${walked.join(".")}' is a ${node.type}, so it has no '${key}'.`, at);
        return null;
      }
      const child: GameStateEntry | undefined = Object.hasOwn(node.children, key) ? node.children[key] : undefined;
      if (!child) {
        const options = [...Object.keys(node.children), ...(walked.length === 0 ? definition.actions : [])];
        const near = nearest(key, options);
        this.report(
          DiagnosticCode.InvalidGameState,
          `'${[...walked, key].join(".")}' is not in the game state${near ? ` (did you mean "${[...walked, near].join(".")}"?)` : ""}. ${walked.length === 0 ? "State" : `'${walked.join(".")}' has`}: ${options.length > 0 ? options.join(", ") : "nothing"}.`,
          at
        );
        return null;
      }
      walked.push(key);
      node = child;
    }
    if (!this.claimName(name, at)) return null;
    const id = stateId(this.component.name, name);
    // A leaf the schema knows keeps its primitive type; an object, an array, a computed value or a leaf written with a type
    // (`"meadow" as MapId`, which would otherwise widen to `string`) is typed by TypeScript, from the store itself: an object
    // re-renders when any value under it changes.
    const leaf = node.kind === "leaf" && walked.length === path.length ? node : null;
    const initialValue: ExprIR =
      leaf === null
        ? { kind: "NullLiteral" }
        : leaf.type === "number"
          ? { kind: "NumberLiteral", value: leaf.initial as number }
          : leaf.type === "string"
            ? { kind: "StringLiteral", value: leaf.initial as string }
            : { kind: "BooleanLiteral", value: leaf.initial as boolean };
    const type: TypeIR =
      leaf === null || leaf.typed
        ? {
            kind: "SourceType",
            text: `ReturnType<typeof ${definition.name}.getState>${path.map((k) => `[${JSON.stringify(k)}]`).join("")}`,
          }
        : { kind: "Primitive", name: leaf.type };
    const globalKey = path.join(".");
    state.push({ kind: "State", id, name, type, initialValue, globalKey });
    this.stateTypes.set(id, type);
    hooks.push({ kind: "StateSlot", state: id, setterName: null, span: this.span(at) });
    if (!this.storePaths.has(globalKey)) this.storePaths.set(globalKey, id);
    this.storeNames.set(name, globalKey);
    return id;
  }

  /**
   * `s.battle.gold` inside a computed selector: the snapshot of that path (made the first time this component reads it).
   * A trailing `.length` reads the array's snapshot, since the store tells readers about an array's items, not its length.
   */
  protected override lowerStoreRead(path: readonly string[], at: Node): ExprIR | null {
    const reads = this.mode.storeReads;
    if (!reads || path.length === 0) {
      this.report(DiagnosticCode.UnsupportedExpression, "Read a path of the game state (`s.player.hp`), not the whole state.", at);
      return null;
    }
    if (path.length > 1 && path[path.length - 1] === "length") {
      const array = this.lowerStoreRead(path.slice(0, -1), at);
      return array && { kind: "MemberRead", object: array, name: "length", optional: false };
    }
    if (path.length === 1 && this.gameState!.actions.includes(path[0]!)) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `'${path[0]}' is an action: select it by itself (\`const ${path[0]} = ${reads.storeName}((s) => s.${path[0]})\`) and call it in a handler.`,
        at
      );
      return null;
    }
    const key = path.join(".");
    let id = this.storePaths.get(key);
    if (!id) {
      const base = "$" + path.map((k, i) => (i === 0 ? k : k.charAt(0).toUpperCase() + k.slice(1))).join("");
      let name = base;
      for (let n = 2; this.usedNames.has(name); n++) name = `${base}${n}`;
      id = this.storePathState(path, name, at, reads.state, reads.hooks) ?? undefined;
      if (!id) return null;
    }
    return { kind: "StateRead", state: id };
  }
  /**
   * `const playHit = useSound("hit.wav")`: the path is a string literal, so a
   * missing asset can be reported at build time once there is an asset list.
   * The binding is a function that is only called, as a statement in a handler.
   */
  protected lowerUseSound(hook: UseSoundCallAnalysis): void {
    const code = DiagnosticCode.InvalidUseSound;
    const argument = hook.arguments.length === 1 ? unwrapParens(hook.arguments[0]!) : null;
    if (!argument || !(isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument))) {
      this.report(code, 'useSound takes one file path, written as a string literal: `const playHit = useSound("hit.wav")`.', hook.call);
      return;
    }
    if (!this.checkHandleName(hook.name, code, hook.declaration.name)) return;
    const field = this.claimField(hook.name, hook.declaration, code);
    if (field === null) return;
    const id = soundId(this.component.name, hook.name);
    this.sounds.push({ kind: "Sound", id, name: field, path: argument.text, span: this.span(hook.declaration) });
    this.componentScope.declare(hook.name, { kind: "sound", id, name: hook.name });
  }

  /**
   * A function declared in the component body, as React code declares its handlers: lowered as a handler (it may set state, play
   * sounds and call actions), with the parameter types written on it, and kept in a field of the component. It is declared before
   * it is lowered, so it may call itself; it may read only what is declared above it, as a derived value may.
   */
  protected lowerOwnFunction(name: string, arrow: ArrowFunction, at: Node): void {
    if (this.componentScope.hasOwn(name) || this.isCallableName(name)) {
      this.report(DiagnosticCode.InvalidComponentBody, `'${name}' is already declared in this component (or reserved).`, at);
      return;
    }
    const field = this.claimField(name, at, DiagnosticCode.InvalidComponentBody);
    if (field === null) return;
    const params = arrow.parameters.some((p) => p.dotDotDotToken !== undefined) ? Infinity : arrow.parameters.length;
    this.componentScope.declare(name, { kind: "function", name, field, params });
    const fn = this.within({ inHandler: true }, () =>
      lowerFunction(this, arrow, { paramTypes: "declared", returns: "any", what: `The function '${name}'` })
    );
    if (fn) this.functions.push({ kind: "OwnFunction", name: field, fn });
  }

  /**
   * `const theme = useContext(Theme)`: two states the component does not own. A reader (`readContext(Theme)`, told its owner
   * when the component joins a world, so it finds the nearest provider) and the value, read from it in `commitState` each render.
   * The provider marks the component dirty when its value changes. A destructuring reads members of the value.
   */
  protected lowerUseContext(hook: UseContextCallAnalysis, state: StateIR[], hooks: HookIR[]): void {
    const code = DiagnosticCode.InvalidUseMutable;
    const context = this.lowerNode(hook.context);
    if (!context) return;
    if (context.kind !== "PlainRef") {
      this.report(
        code,
        "useContext takes a context made with `createContext` in a `.ts` file and imported: `useContext(Theme)`.",
        hook.context
      );
      return;
    }
    const n = ++this.contexts;
    const readerField = this.claimField(`$context${n}`, hook.declaration, code);
    if (readerField === null) return;
    const readerId = stateId(this.component.name, readerField);
    const valueType: TypeIR = { kind: "SourceType", text: `(typeof ${context.name})["default"]` };
    state.push({
      kind: "State",
      id: readerId,
      name: readerField,
      type: {
        kind: "SourceType",
        text: `{ readonly value: (typeof ${context.name})["default"]; readonly live: (typeof ${context.name})["default"] }`,
      },
      initialValue: { kind: "Call", callee: { kind: "Function", name: "readContext" }, args: [context] },
      handle: true,
      transient: true,
    });
    const read: ExprIR = { kind: "MemberRead", object: { kind: "StateRead", state: readerId }, name: "value", optional: false };
    const valueName = hook.name ?? `$contextValue${n}`;
    if (hook.name !== null && (this.componentScope.hasOwn(hook.name) || this.isCallableName(hook.name))) {
      this.report(code, `'${hook.name}' is already declared in this component.`, hook.declaration);
      return;
    }
    const valueField = this.claimField(valueName, hook.declaration, code);
    if (valueField === null) return;
    const valueId = stateId(this.component.name, valueName);
    state.push({ kind: "State", id: valueId, name: valueField, type: valueType, initialValue: read, transient: true, refresh: read });
    this.stateTypes.set(valueId, valueType);
    this.contextValues.add(valueId);
    hooks.push({ kind: "StateSlot", state: valueId, setterName: null, span: this.span(hook.declaration) });
    if (hook.name !== null) {
      this.componentScope.declare(hook.name, { kind: "state", id: valueId });
      return;
    }
    for (const entry of hook.entries ?? []) {
      if (this.componentScope.hasOwn(entry.name) || this.isCallableName(entry.name)) {
        this.report(code, `'${entry.name}' is already declared in this component.`, hook.declaration);
        continue;
      }
      this.componentScope.declare(entry.name, {
        kind: "derived",
        name: entry.name,
        value: { kind: "MemberRead", object: { kind: "StateRead", state: valueId }, name: entry.key, optional: false },
        // In a handler, the provider's value as it is now.
        relower: () => ({
          kind: "MemberRead",
          object: { kind: "StateRead", state: valueId, live: true },
          name: entry.key,
          optional: false,
        }),
      });
    }
  }

  protected checkHandleName(name: string, code: CompilerDiagnostic["code"], at: Node): boolean {
    if (this.componentScope.has(name) || this.isCallableName(name)) {
      this.report(code, `'${name}' is already declared in this component (or reserved).`, at);
      return false;
    }
    return true;
  }

  /**
   * The type of a `useMutable` field: its `as` type (a primitive, an array,
   * or any type written in this file, such as a record interface), or
   * inferred from the initial value. An array or record needs the type
   * argument unless it comes from a prop, as in TypeScript, where `[]` alone
   * would be `never[]`.
   */
  protected hookStateType(typeArgument: Node | null, initial: ExprIR, at: Node): TypeIR | null {
    if (typeArgument) return this.typeFromNode(typeArgument);
    const primitive = this.inferType(initial);
    if (primitive) return { kind: "Primitive", name: primitive };
    if (initial.kind === "PropRead") {
      const decl = this.propDecls.find((p) => p.name === initial.name);
      if (decl?.role === "value") return propTypeToType(decl.type);
    }
    // A value of the game state (`{ battle }` with `const battle = useGame(…)`): its type, as the store gives it.
    if (initial.kind === "StateRead") {
      const type = this.stateTypes.get(initial.state);
      if (type) return type;
    }
    // Made by a function (a runtime factory, or one from a .ts file): typed by what the function returns.
    if (
      initial.kind === "Call" &&
      (initial.callee.kind === "Function" || initial.callee.kind === "Plain") &&
      !initial.callee.name.startsWith("Math.")
    ) {
      return { kind: "SourceType", text: `ReturnType<typeof ${this.calleeLocal(initial.callee)}>` };
    }
    // `pos: { x: 0, y: 0 }`: the literal's type, as TypeScript infers it (`{ x: number; y: number }`).
    const literal = this.literalType(initial);
    if (literal !== null) return { kind: "SourceType", text: literal };
    const code = DiagnosticCode.UnsupportedStateType;
    if (initial.kind === "ArrayLiteral" || initial.kind === "ObjectLiteral") {
      this.report(
        code,
        initial.kind === "ArrayLiteral" && initial.elements.length === 0
          ? "An empty array needs its type, as in TypeScript, where `[]` alone is `never[]`: `enemies: [] as EnemyData[]`."
          : `This ${initial.kind === "ArrayLiteral" ? "array" : "object"}'s type cannot be worked out from its values: write it, \`${initial.kind === "ArrayLiteral" ? "enemies: [] as EnemyData[]" : "enemy: { … } as EnemyData"}\`, with the type declared in this file.`,
        at
      );
    } else {
      this.report(
        code,
        "Cannot infer this value's type: a literal, a prop, an imported constant or a call of an imported function can be inferred; for anything else, write the type with `as` (`{ speed: base * 2 as number }`).",
        at
      );
    }
    return null;
  }

  /**
   * The type TypeScript would infer for a literal of numbers, strings and booleans, objects of them and non-empty arrays of one
   * type of them (`{ x: 0, tags: ["a"] }` is `{ x: number; tags: string[] }`); null for anything else, which needs its type
   * written. An imported constant has its declared type, widened as a `let` would widen it (`START_GOLD`, declared
   * `= 100`, is `number`), and a call of an imported function has the type it returns.
   */
  /**
   * What the generated module calls a function by: a plain import by its name, and a runtime function by its own name, or by
   * `runtimeAlias` where the file uses that name for something of its own (the generator imports it so).
   */
  protected calleeLocal(callee: { readonly kind: string; readonly name: string }): string {
    return callee.kind === "Function" && this.plainImports.has(callee.name) ? runtimeAlias(callee.name) : callee.name;
  }

  protected literalType(e: ExprIR): string | null {
    const primitive = this.inferType(e);
    if (primitive !== null) return primitive;
    if (e.kind === "PlainRef" && this.plainImports.has(e.name)) {
      const t = `typeof ${e.name}`;
      return `(${t} extends number ? number : ${t} extends string ? string : ${t} extends boolean ? boolean : ${t})`;
    }
    if (e.kind === "Call" && (e.callee.kind === "Function" || e.callee.kind === "Plain") && !e.callee.name.startsWith("Math.")) {
      return `ReturnType<typeof ${this.calleeLocal(e.callee)}>`;
    }
    if (e.kind === "ObjectLiteral") {
      const fields: string[] = [];
      for (const p of e.properties) {
        if (p.kind !== "Property") return null;
        const type = this.literalType(p.value);
        if (type === null) return null;
        fields.push(`${/^[A-Za-z_$][\w$]*$/.test(p.name) ? p.name : JSON.stringify(p.name)}: ${type}`);
      }
      return `{ ${fields.join("; ")} }`;
    }
    if (e.kind === "ArrayLiteral") {
      if (e.elements.length === 0) return null;
      const types = new Set<string>();
      for (const element of e.elements) {
        if (element.spread) return null;
        const type = this.literalType(element.value);
        if (type === null) return null;
        types.add(type);
      }
      if (types.size !== 1) return null;
      const [type] = types;
      return type!.startsWith("{") ? `(${type})[]` : `${type}[]`;
    }
    return null;
  }
}

/**
 * A derived value that calls a function or a method (`heroOf(run)`, `enemies.filter(…)`, `name.toUpperCase()`) is a memo: worked out
 * once, and again only when what it reads changes, rather than at each place it is used. One that only reads and combines values
 * (`health < 25`, `hero.x`) is written where it is used, which costs nothing.
 */
function memoized(key: string, value: ExprIR): ExprIR {
  if (value.kind === "Memo") return value;
  // A call inside another memo (`const cost = focus.upgrade`, `focus` being one) is already worked out once: reading it costs nothing.
  const calls = (e: ExprIR): boolean =>
    e.kind !== "Memo" &&
    ((e.kind === "Call" && (e.callee.kind === "Plain" || e.callee.kind === "ArrayMethod" || e.callee.kind === "ValueMethod")) ||
      childExpressions(e).some(calls));
  // `const cost = kind === null ? null : price(kind)`, `const name = hero?.name ?? ""`, `const offer = offers[cursor]`: a value that
  // may be null or undefined is tested before it is used (`cost !== null && gold >= cost`, `offer !== undefined && TABLE[offer]`).
  // Written out at each use, TypeScript could not narrow one copy by testing another; as a memo it is one `const`, which narrows as
  // the source does. An element read by index may be undefined (`noUncheckedIndexedAccess`), and so may an optional read.
  const mayBeNull =
    value.kind === "Conditional" ||
    (value.kind === "Binary" && value.operator === "??") ||
    value.kind === "IndexRead" ||
    (value.kind === "MemberRead" && value.optional);
  return calls(value) || mayBeNull ? { kind: "Memo", key, value } : value;
}

/** `TextChild | readonly TextChild[]` (either order, either alone, `string` too): a props type's text children. */
function isTextChildrenType(text: string): boolean {
  const parts = text.split("|").map((part) => part.replace(/\s+/g, " ").trim());
  return (
    parts.length > 0 &&
    parts.every((part) => ["TextChild", "readonly TextChild[]", "TextChild[]", "string", "readonly string[]", "string[]"].includes(part))
  );
}
