// Layer 1 of ComponentLowering: lowers TypeScript expressions into ExprIR (reads, calls, array methods, handles).
import {
  SyntaxKind,
  type Node,
  type ObjectLiteralExpression,
  type CallExpression,
  type Expression,
  type PropertyAccessExpression,
} from "typescript/ast";
import {
  isBinaryExpression,
  isCallExpression,
  isPropertyAccessExpression,
  isTemplateExpression,
  isConditionalExpression,
  isIdentifier,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isArrowFunction,
  isParenthesizedExpression,
  isPrefixUnaryExpression,
  isStringLiteral,
  isNoSubstitutionTemplateLiteral,
  isArrayLiteralExpression,
  isSpreadElement,
  isSpreadAssignment,
  isBlock,
  isElementAccessExpression,
  isNonNullExpression,
  isAsExpression,
  isSatisfiesExpression,
  isTypeOfExpression,
  isNewExpression,
} from "typescript/ast/is";

import { unwrapParens } from "../analyzer/analyzer.ts";
import { DiagnosticCode } from "../diagnostics/diagnostics.ts";
import { warning } from "../diagnostics/diagnostics.ts";
import {
  assertNever,
  stateReads,
  ARRAY_METHODS,
  GLOBAL_FUNCTIONS,
  MUTATING_ARRAY_METHODS,
  VALUE_METHODS,
  type ArrayMethodName,
  type ArrayElementIR,
  type ObjectPropertyIR,
  type AssignTargetIR,
  type CalleeIR,
  type ExprIR,
  type ParamReadIR,
} from "../ir/types.ts";
import { MATH_CONSTANTS, MATH_FUNCTIONS } from "./handles.ts";

/** Constructors a handler may call with `new`, besides classes imported from `.ts` files. Not `Date`: it reads the clock. */
const HANDLER_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Array",
]);
/** Namespaces whose functions a handler may call as written. */
const HANDLER_NAMESPACES: ReadonlySet<string> = new Set(["Object", "JSON", "Number", "Array", "String", "Math", "console"]);
/** Global functions a handler may call as written. */
const HANDLER_GLOBALS: ReadonlySet<string> = new Set(["parseInt", "parseFloat", "isNaN", "isFinite"]);
import { TIMER_FUNCTIONS, WORLD_FUNCTIONS, BINARY_OPERATORS, UNARY_OPERATORS, nearest } from "./helpers.ts";
import { LoweringBase } from "./lowering.ts";
import { lowerCallbackValue, lowerFunction, lowerFunctionValue } from "./statements.ts";

/** The comparisons that may test an optional callback prop against `undefined` or `null`. */
const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(["===", "!==", "==", "!="]);

/** What to write instead of a call the browser or Node has and a component does not: the game's clock and its replays decide. */
const TIMERS_INSTEAD =
  "runs on the game's clock in a component: `after(seconds, () => …)` calls once and `every(seconds, () => …)` repeats, both pausing with the game and stopping when the component leaves. Each returns an id: `cancelTimer(id)` stops that one sooner, `cancelTimers()` all of them.";
const INSTEAD: Readonly<Record<string, string>> = {
  setTimeout: `There is no \`setTimeout\`: a delay ${TIMERS_INSTEAD}`,
  setInterval: `There is no \`setInterval\`: a repeat ${TIMERS_INSTEAD}`,
  clearTimeout:
    "There is no `clearTimeout`: `cancelTimer(id)` stops the timer whose id `after` returned (`cancelTimers()` stops them all).",
  clearInterval:
    "There is no `clearInterval`: `cancelTimer(id)` stops the timer whose id `every` returned (`cancelTimers()` stops them all).",
  requestAnimationFrame: "There is no `requestAnimationFrame`: `useUpdate((dt, input) => …)` runs every step, with the step's time.",
  "Math.random":
    "`Math.random` would make every replay and test play differently. Roll from a seed you keep in state, with a function in a `.ts` file (Hearth's `rules/rng.ts`), so the same input plays the same game.",
  "Date.now": "`Date.now` is the wall clock, which replays do not repeat: add up the `dt` that `useUpdate((dt) => …)` is given.",
  "performance.now":
    "`performance.now` is the wall clock, which replays do not repeat: add up the `dt` that `useUpdate((dt) => …)` is given.",
  fetch: "`fetch` is not available in a game: load data from the `assets` folder, or from a `.ts` file that imports it.",
};

export class ExpressionLowering extends LoweringBase {
  protected lowerNode(node: Expression): ExprIR | null {
    if (isParenthesizedExpression(node)) return this.lowerNode(node.expression);
    if (isNumericLiteral(node)) return { kind: "NumberLiteral", value: Number(node.text) };
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return { kind: "StringLiteral", value: node.text };
    switch (node.kind) {
      case SyntaxKind.TrueKeyword:
        return { kind: "BooleanLiteral", value: true };
      case SyntaxKind.FalseKeyword:
        return { kind: "BooleanLiteral", value: false };
      case SyntaxKind.NullKeyword:
        return { kind: "NullLiteral" };
    }
    if (isIdentifier(node)) {
      const binding = this.scope.get(node.text);
      // A function imported from a relative .ts file, used as a value (a prop that takes a function).
      if (!binding && this.plainImports.has(node.text)) return { kind: "PlainRef", name: node.text };
      // `x !== undefined`, `cond ? undefined : x`: the global, which no import or declaration can shadow here.
      if (!binding && node.text === "undefined") return { kind: "PlainRef", name: "undefined" };
      // `e instanceof Error`: a global constructor or namespace a handler may name as a value.
      if (!binding && this.computes() && (HANDLER_CONSTRUCTORS.has(node.text) || HANDLER_NAMESPACES.has(node.text)))
        return { kind: "PlainRef", name: node.text };
      if (!binding) {
        // Declared, but its declaration was refused above: that error is the one to read.
        if (this.declaredAfterError(node.text)) return null;
        // A `useMutable` field is read through its owner (`count` → `s.count`), the slip of someone used to `useState`.
        const fields = new Map<string, string>();
        for (const name of this.scope.names()) {
          const owner = this.scope.get(name);
          if (owner?.kind === "mutable")
            for (const field of owner.fields.keys()) if (!fields.has(field)) fields.set(field, `${name}.${field}`);
        }
        const names = [...new Set([...this.scope.names(), ...this.plainImports])];
        const near = nearest(node.text, [...names, ...[...fields.keys()].filter((f) => !names.includes(f))]);
        const suggestion = near !== null && fields.has(near) && !names.includes(near) ? fields.get(near)! : near;
        this.report(
          DiagnosticCode.UnknownIdentifier,
          `'${node.text}' is not a state value of this component${suggestion ? ` (did you mean '${suggestion}'?)` : ""}.`,
          node
        );
        return null;
      }
      switch (binding.kind) {
        case "local":
          return { kind: "LocalRead", local: binding.id, name: binding.name };
        case "param":
          return { kind: "ParamRead", param: binding.id, name: binding.name };
        // A loop's item that the loop writes through: the list's element as it is now, `s.foes[i]!`.
        case "item": {
          const list = this.lowerNode(binding.list);
          return (
            list && {
              kind: "NonNull",
              expression: { kind: "IndexRead", object: list, index: binding.index, optional: false },
            }
          );
        }
        case "state":
          return {
            kind: "StateRead",
            state: binding.id,
            ...(this.mode.inHandler && this.contextValues.has(binding.id) ? { live: true as const } : {}),
          };
        // Read whole (`takeHit(s)`, `<Camera shake={shake}>`). In a handler it is the component's own object for this `useMutable`,
        // whose fields read and write the component's (`takeHit(s)` changes them, as `s.hp -= 1` would). In render, where nothing
        // writes, it is a copy of the fields as the frame committed them, typed `Readonly`. The properties say which fields it reads.
        case "mutable":
          return {
            kind: "ObjectLiteral",
            mutableCopy: true,
            ...(this.mode.inHandler ? { live: true as const } : {}),
            properties: [...binding.fields].map(([name, state]) => ({
              kind: "Property" as const,
              name,
              value: { kind: "StateRead" as const, state, ...(this.mode.inHandler ? { live: true as const } : {}) },
            })),
          };
        case "propsObject":
          this.report(
            DiagnosticCode.UnsupportedExpression,
            `'${node.text}' is the props object: read a prop as \`${node.text}.name\`.`,
            node
          );
          return null;
        case "children":
          this.report(
            DiagnosticCode.UnsupportedExpression,
            "`children` can only be used as a JSX child, `{children}`: it is the elements a parent passes, not a value.",
            node
          );
          return null;
        case "prop":
          if (binding.role === "callback" && !this.mode.allowCallbackRead) {
            this.report(
              DiagnosticCode.UnsupportedExpression,
              `'${node.text}' is a callback prop: call it (\`${node.text}?.()\`) or forward it whole (\`onX={${node.text}}\`).`,
              node
            );
            return null;
          }
          return {
            kind: "PropRead",
            name: binding.name,
            ...(this.mode.inHandler && binding.role === "value" ? { live: true as const } : {}),
          };
        // Inlined: in JSX it re-evaluates on render (its state reads become the prop's dependencies);
        // in a handler it reads the current state, like recomputing it there.
        case "derived": {
          // In a handler, a value that depends on a `useMutable` field is worked out from the fields as they are now.
          // Lowered against the component's scope, so a handler's own locals cannot shadow what the `const` reads.
          if (
            this.mode.inHandler &&
            binding.relower !== undefined &&
            stateReads(binding.value).some((id) => this.mutableStates.has(id) || this.contextValues.has(id))
          ) {
            const outer = this.scope;
            this.scope = this.componentScope;
            try {
              return binding.relower();
            } finally {
              this.scope = outer;
            }
          }
          return binding.value;
        }
        case "sound":
          this.report(
            DiagnosticCode.SoundOutsideHandler,
            `'${node.text}' is a sound: call it as a statement in a handler (\`${node.text}();\`). It cannot be read or passed as a value.`,
            node
          );
          return null;
        case "action":
          this.report(
            DiagnosticCode.UnsupportedExpression,
            `'${node.text}' is a game-state action: call it as a statement in a handler (\`${node.text}();\`). It cannot be read or passed as a value.`,
            node
          );
          return null;
        case "storeRoot":
          return this.lowerStoreRead([], node);
        // A function of the component's own, passed as a value (`settings.subscribe(refresh)`, `useEvery(1, tick)`).
        case "function":
          return { kind: "PlainRef", name: `this.${binding.field}` };
        default:
          return assertNever(binding, "binding");
      }
    }
    if (isTypeOfExpression(node)) {
      const operand = this.lowerNode(node.expression);
      return operand && { kind: "Unary", operator: "typeof", operand };
    }
    if (isNewExpression(node)) return this.lowerNew(node);
    if (isPrefixUnaryExpression(node)) {
      const operator = UNARY_OPERATORS.get(node.operator);
      if (!operator) {
        this.report(DiagnosticCode.UnsupportedExpression, `Unsupported unary operator.`, node);
        return null;
      }
      const operand = this.lowerNode(node.operand);
      return operand && { kind: "Unary", operator, operand };
    }
    if (isBinaryExpression(node)) {
      const operator = BINARY_OPERATORS.get(node.operatorToken.kind);
      if (!operator) {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          `Unsupported binary operator '${node.operatorToken.getText(this.sourceFile)}'.`,
          node
        );
        return null;
      }
      // `onAdjust === undefined`: whether an optional callback prop was passed may be tested, though its value is not read otherwise.
      const absent = (side: Expression): boolean =>
        side.kind === SyntaxKind.NullKeyword || (isIdentifier(side) && side.text === "undefined" && !this.scope.has("undefined"));
      const named = (side: Expression): boolean =>
        isIdentifier(side) || (isPropertyAccessExpression(side) && isIdentifier(side.expression));
      const tested = (side: Expression, other: Expression): ExprIR | null =>
        EQUALITY_OPERATORS.has(operator) && absent(other) && named(side)
          ? this.within({ allowCallbackRead: true }, () => this.lowerNode(side))
          : this.lowerNode(side);
      const left = tested(unwrapParens(node.left), unwrapParens(node.right));
      const right = tested(unwrapParens(node.right), unwrapParens(node.left));
      return left && right && { kind: "Binary", operator, left, right };
    }
    if (isConditionalExpression(node)) {
      const test = this.lowerNode(node.condition);
      const whenTrue = this.lowerNode(node.whenTrue);
      const whenFalse = this.lowerNode(node.whenFalse);
      return test && whenTrue && whenFalse && { kind: "Conditional", test, whenTrue, whenFalse };
    }
    if (isTemplateExpression(node)) {
      const quasis = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      const expressions: ExprIR[] = [];
      for (const span of node.templateSpans) {
        const e = this.lowerNode(span.expression);
        if (!e) return null;
        expressions.push(e);
      }
      return { kind: "TemplateLiteral", quasis, expressions };
    }
    if (isPropertyAccessExpression(node)) return this.lowerPropertyRead(node);
    if (isNonNullExpression(node)) {
      const expression = this.lowerNode(node.expression);
      return expression && { kind: "NonNull", expression };
    }
    if (isAsExpression(node)) {
      // A cast overrides the type-checker, so it is kept out of components: in a `.ts` module it is easy to find and to test.
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `A component has no \`as\`: move the cast into a function in a \`.ts\` module and call that (\`toPoint(value)\`). \`satisfies\` and \`!\` are fine here.`,
        node
      );
      return null;
    }
    // `value satisfies Type` checks the source and changes nothing: the value alone is kept.
    if (isSatisfiesExpression(node)) return this.lowerNode(node.expression);
    if (isElementAccessExpression(node)) {
      // `TABLE[kind]`, `pads[cursor]`: any index; the type-check of the generated code checks the element's type.
      const object = this.lowerNode(node.expression);
      const index = this.lowerNode(node.argumentExpression);
      return object && index && { kind: "IndexRead", object, index, optional: node.questionDotToken !== undefined };
    }
    if (isCallExpression(node)) return this.lowerCall(node);
    if (isArrayLiteralExpression(node)) {
      const elements: ArrayElementIR[] = [];
      for (const element of node.elements) {
        const spread = isSpreadElement(element);
        const value = this.lowerNode(spread ? element.expression : element);
        if (!value) return null;
        elements.push({ spread, value });
      }
      return { kind: "ArrayLiteral", elements };
    }
    if (isObjectLiteralExpression(node)) return this.lowerObjectLiteral(node);
    if (isArrowFunction(node)) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "An arrow function can only be a callback prop (`onX={() => …}`) or the argument of an array method (`items.filter((e) => …)`).",
        node
      );
      return null;
    }
    if (node.kind === SyntaxKind.AwaitExpression) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "`await` is not supported: a component runs in the game's steps, which do not wait. Wait with `after(seconds, () => …)`, or keep asynchronous work in a `.ts` file and set state when it is done.",
        node
      );
      return null;
    }
    if (
      (node.kind === SyntaxKind.PostfixUnaryExpression || node.kind === SyntaxKind.PrefixUnaryExpression) &&
      [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes((node as unknown as { operator: SyntaxKind }).operator)
    ) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "`++` and `--` are statements of their own, on a `let`, a ref property or a `useMutable` field (`s.n++`, `s.foes[i].hp--`); they are not available inside an expression, nor through another name for state's own value.",
        node
      );
      return null;
    }
    this.report(DiagnosticCode.UnsupportedExpression, `Unsupported expression (${SyntaxKind[node.kind]}).`, node);
    return null;
  }

  /**
   * `new Map<string, number>()`, `new Error("…")`, `new Enemy(…)`: in a handler only, of a global constructor (`HANDLER_CONSTRUCTORS`)
   * or a class imported from a `.ts` file. A constructor in a component body would run on every render.
   */
  protected lowerNew(node: Expression & { kind: SyntaxKind.NewExpression }): ExprIR | null {
    const created = node as unknown as { expression: Expression; typeArguments?: readonly Node[]; arguments?: readonly Expression[] };
    const callee = unwrapParens(created.expression);
    if (!this.computes()) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "`new` is only valid in a handler or in statements of the component body (which are worked out again only when what they read changes), not in a single expression: it would run on every render. Make it once as a `useMutable` field from a function that returns it (`useMutable({ seen: makeSeen() })`, with `function makeSeen() { return new Set<string>(); }`), or in a `.ts` file.",
        node
      );
      return null;
    }
    const known =
      isIdentifier(callee) && !this.scope.has(callee.text) && (HANDLER_CONSTRUCTORS.has(callee.text) || this.plainImports.has(callee.text));
    if (!known || !isIdentifier(callee)) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `\`new\` takes a class imported from a \`.ts\` file or one of ${[...HANDLER_CONSTRUCTORS].join(", ")}.`,
        callee
      );
      return null;
    }
    const args = this.lowerPlainArgs(created.arguments ?? []);
    if (!args) return null;
    const typeArguments =
      created.typeArguments && created.typeArguments.length > 0
        ? `<${created.typeArguments.map((t) => t.getText(this.sourceFile)).join(", ")}>`
        : null;
    return { kind: "New", callee: callee.text, typeArguments, args };
  }

  /** In a handler, or in statements of the component body: where code computes with loops, its own values and the standard library. */
  protected computes(): boolean {
    return this.mode.inHandler || this.mode.inRenderBlock;
  }

  /**
   * Whether an expression is a handler's own local, or a member or element of one (`list`, `best.hits`, `grid[y]![x]`): a value the
   * handler made, which it may change in place, call any method of and assign into. State and props are never this.
   */
  protected ownsValue(node: Expression): boolean {
    let at: Expression = unwrapParens(node);
    for (;;) {
      if (isPropertyAccessExpression(at) || isElementAccessExpression(at) || isNonNullExpression(at)) at = unwrapParens(at.expression);
      else break;
    }
    if (!this.computes() || !isIdentifier(at)) return false;
    const binding = this.scope.get(at.text);
    return binding?.kind === "local" && binding.owned === true;
  }

  /** Lowers each expression in order; null (after reporting) at the first that fails. */
  lowerAll(nodes: readonly Expression[]): ExprIR[] | null {
    const out: ExprIR[] = [];
    for (const node of nodes) {
      const lowered = this.lowerNode(node);
      if (!lowered) return null;
      out.push(lowered);
    }
    return out;
  }

  /**
   * The arguments of a plain function, a method of an imported object, a callback prop or a handler's local. In a handler an argument may be an arrow, a
   * handler of its own that the function may call later (`settings.subscribe(() => setView(read()))`).
   */
  protected lowerPlainArgs(nodes: readonly Expression[]): ExprIR[] | null {
    const out: ExprIR[] = [];
    for (const node of nodes) {
      const fn = unwrapParens(node);
      const lowered = isArrowFunction(fn) && this.mode.inHandler ? lowerCallbackValue(this, fn, "this place") : this.lowerNode(node);
      if (!lowered) return null;
      out.push(lowered);
    }
    return out;
  }

  /** Arguments of a method of a handler's own value or a standard library call: an arrow is a function that may return a value. */
  protected lowerFunctionArgs(nodes: readonly Expression[]): ExprIR[] | null {
    const out: ExprIR[] = [];
    for (const node of nodes) {
      const fn = unwrapParens(node);
      const lowered = isArrowFunction(fn)
        ? isBlock(fn.body)
          ? lowerFunctionValue(this, fn)
          : this.lowerArrow(fn, "function")
        : this.lowerNode(node);
      if (!lowered) return null;
      out.push(lowered);
    }
    return out;
  }

  /** `{ id, speed: 2, ...e }`: plain, shorthand and spread properties. */
  protected lowerObjectLiteral(node: ObjectLiteralExpression): ExprIR | null {
    const properties: ObjectPropertyIR[] = [];
    let ok = true;
    for (const property of node.properties) {
      let entry: ObjectPropertyIR | null = null;
      if (isPropertyAssignment(property) && (isIdentifier(property.name) || isStringLiteral(property.name))) {
        const value = this.lowerNode(property.initializer);
        entry = value && { kind: "Property", name: property.name.text, value };
      } else if (isShorthandPropertyAssignment(property) && isIdentifier(property.name) && !property.objectAssignmentInitializer) {
        const value = this.lowerNode(property.name);
        entry = value && { kind: "Property", name: property.name.text, value };
      } else if (isSpreadAssignment(property)) {
        const value = this.lowerNode(property.expression);
        entry = value && { kind: "Spread", value };
      } else {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          "Object properties must be `name: value`, `name` (shorthand) or `...spread`; no methods, getters or computed names.",
          property
        );
      }
      if (entry) properties.push(entry);
      else ok = false;
    }
    return ok ? { kind: "ObjectLiteral", properties } : null;
  }

  /**
   * The callback of an array method: an expression-bodied arrow, lowered in
   * its own scope. Its parameters are typed by the array, so they carry no
   * annotation. A block body could set state or call callbacks while the
   * array is being walked, so it is not allowed.
   */
  protected lowerArrow(node: Expression, method: string): ExprIR | null {
    const fn = unwrapParens(node);
    if (!isArrowFunction(fn)) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `\`${method}\` takes an inline arrow function: \`items.${method}((item) => …)\`.`,
        node
      );
      return null;
    }
    if (isBlock(fn.body)) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `The \`${method}\` callback must be a single expression (\`(item) => item.alive\`), not a block.`,
        fn.body
      );
      return null;
    }
    const lowered = lowerFunction(this, fn, { paramTypes: "contextual", returns: "value", what: `${method} callback` });
    if (!lowered) return null;
    const only = lowered.body[0];
    if (lowered.body.length !== 1 || only?.kind !== "Return" || !only.value)
      throw new Error("expression-bodied arrow lowered to statements");
    return { kind: "Arrow", params: lowered.params, body: only.value };
  }

  /** `param.name` where `param` is a handler parameter of a runtime handle type. */
  protected lowerPropertyRead(node: PropertyAccessExpression): ExprIR | null {
    // `s.battle.gold` in a computed selector: the snapshot of that path.
    const storePath: string[] = [];
    let root: Expression = node;
    while (isPropertyAccessExpression(root)) {
      storePath.unshift(root.name.text);
      root = unwrapParens(root.expression);
    }
    if (isIdentifier(root) && this.scope.get(root.text)?.kind === "storeRoot") return this.lowerStoreRead(storePath, node);
    // `Math.PI`: a constant, written as it is.
    if (
      isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      !this.scope.has("Math") &&
      MATH_CONSTANTS.has(`Math.${node.name.text}`)
    ) {
      return { kind: "PlainRef", name: `Math.${node.name.text}` };
    }
    const propsObject = this.propsObjectMember(node);
    if (propsObject !== undefined) {
      if (propsObject === null) return null;
      if (propsObject.role === "callback" && !this.mode.allowCallbackRead) {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          `'${propsObject.name}' is a callback prop: call it (\`props.${propsObject.name}?.()\`) or forward it whole (\`onX={props.${propsObject.name}}\`).`,
          node
        );
        return null;
      }
      return {
        kind: "PropRead",
        name: propsObject.name,
        ...(this.mode.inHandler && propsObject.role === "value" ? { live: true as const } : {}),
      };
    }
    const mutable = this.mutableField(node);
    if (mutable === "error") return null;
    if (mutable) return { kind: "StateRead", state: mutable, ...(this.mode.inHandler ? { live: true as const } : {}) };
    const receiver = this.handleParam(node.expression);
    const name = node.name.text;
    if (receiver) {
      if (!this.manifest.handleTypes[receiver.type]!.properties.includes(name)) {
        this.report(DiagnosticCode.UnsupportedExpression, `'${receiver.type}' has no readable property '${name}'.`, node.name);
        return null;
      }
      return { kind: "PropertyRead", object: receiver.read, name };
    }
    // A member of a value (`e.id`, `enemies.length`): the type-check of the generated code validates it.
    // Numbers and booleans have no members worth reading, so those are caught here.
    const primitive = this.knownPrimitive(node.expression);
    if (primitive === "number" || primitive === "boolean") {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `'${node.expression.getText(this.sourceFile)}' is a ${primitive}; it has no member '${name}'.`,
        node.name
      );
      return null;
    }
    const object = this.lowerNode(node.expression);
    return object && { kind: "MemberRead", object, name, optional: node.questionDotToken !== undefined };
  }

  /** `Math.max(...)`, `clamp(...)`, or `param.method(...)` on a runtime handle parameter. */
  protected lowerCall(node: CallExpression): ExprIR | null {
    const callee = node.expression;
    // `props.onDefeated?.()` on the props object.
    if (isPropertyAccessExpression(callee)) {
      const member = this.propsObjectMember(callee);
      if (member === null) return null;
      if (member) {
        if (member.role !== "callback") {
          this.report(DiagnosticCode.UnsupportedExpression, `Prop '${member.name}' is not a function, so it cannot be called.`, callee);
          return null;
        }
        const args = this.lowerPlainArgs(node.arguments);
        if (!args) return null;
        return {
          kind: "Call",
          callee: {
            kind: "Prop",
            name: member.name,
            optional: node.questionDotToken !== undefined,
            ...(this.presentCallbacks.has(member.name) ? { present: true as const } : {}),
          },
          args,
        };
      }
    }
    // A callback prop: `onDefeated()` or `onDefeated?.()`. Arguments are not counted here; the type-check does that.
    if (isIdentifier(callee)) {
      const binding = this.scope.get(callee.text);
      if (binding?.kind === "sound") {
        this.report(
          DiagnosticCode.SoundOutsideHandler,
          `'${callee.text}()' plays a sound, so it is only valid as a statement in a handler: in JSX, a derived value or an expression it would play on every render.`,
          node
        );
        return null;
      }
      if (binding?.kind === "action") {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          `'${callee.text}()' is a game-state action, so it is only valid as a statement in a handler: in JSX or a derived value it would run on every render.`,
          node
        );
        return null;
      }
      // A function declared in the component body: a handler, so it is called in handlers, not while rendering.
      if (binding?.kind === "function") {
        if (!this.mode.inHandler) {
          this.report(
            DiagnosticCode.UnsupportedExpression,
            `'${callee.text}' is a function of this component, which may set state: call it in a handler or a callback, not while rendering. A value to show goes in a derived \`const\` or a function in a \`.ts\` file.`,
            node
          );
          return null;
        }
        const args = this.lowerPlainArgs(node.arguments);
        if (!args) return null;
        return { kind: "Call", callee: { kind: "Own", name: binding.field }, args };
      }
      // A handler's own local holding a function (`const stop = settings.subscribe(…)`, then `stop()` in the cleanup).
      if (binding?.kind === "local" && this.mode.inHandler) {
        const args = this.lowerPlainArgs(node.arguments);
        if (!args) return null;
        return { kind: "Call", callee: { kind: "Local", name: binding.name }, args };
      }
      if (binding?.kind === "prop") {
        if (binding.role !== "callback") {
          this.report(DiagnosticCode.UnsupportedExpression, `Prop '${callee.text}' is not a function, so it cannot be called.`, callee);
          return null;
        }
        const args = this.lowerPlainArgs(node.arguments);
        if (!args) return null;
        return {
          kind: "Call",
          callee: {
            kind: "Prop",
            name: binding.name,
            optional: node.questionDotToken !== undefined,
            ...(this.presentCallbacks.has(binding.name) ? { present: true as const } : {}),
          },
          args,
        };
      }
    }
    // A function imported from a relative .ts file: any arguments, opaque to the compiler and assumed pure.
    if (isIdentifier(callee) && this.plainImports.has(callee.text) && !this.scope.has(callee.text)) {
      const args = this.lowerPlainArgs(node.arguments);
      if (!args) return null;
      return { kind: "Call", callee: { kind: "Plain", name: callee.text }, args };
    }
    // A method of a value imported from a relative .ts file (`fx.burst("dust", x, y)`): opaque too. An array method on an
    // imported array (`ROOMS.filter(…)`) stays an array method, so its callback is lowered.
    if (
      isPropertyAccessExpression(callee) &&
      isIdentifier(callee.expression) &&
      this.plainImports.has(callee.expression.text) &&
      !this.scope.has(callee.expression.text) &&
      !Object.hasOwn(ARRAY_METHODS, callee.name.text)
    ) {
      const args = this.lowerPlainArgs(node.arguments);
      if (!args) return null;
      return { kind: "Call", callee: { kind: "Plain", name: `${callee.expression.text}.${callee.name.text}` }, args };
    }
    // In a handler, the standard library as written: `Object.keys(…)`, `JSON.stringify(…)`, `Number.isFinite(…)`, `Array.from(…)`,
    // any `Math` function, `console.log(…)`, `parseInt(…)`.
    if (this.computes()) {
      const namespace =
        isPropertyAccessExpression(callee) &&
        isIdentifier(callee.expression) &&
        HANDLER_NAMESPACES.has(callee.expression.text) &&
        !this.scope.has(callee.expression.text) &&
        !this.plainImports.has(callee.expression.text)
          ? `${callee.expression.text}.${callee.name.text}`
          : null;
      const global =
        isIdentifier(callee) && HANDLER_GLOBALS.has(callee.text) && !this.scope.has(callee.text) && !this.plainImports.has(callee.text)
          ? callee.text
          : null;
      const name = namespace ?? global;
      if (
        name !== null &&
        !(namespace !== null && callee.kind === SyntaxKind.PropertyAccessExpression && Object.hasOwn(MATH_FUNCTIONS, name))
      ) {
        if (name === "Math.random") {
          this.diagnostics.push(
            warning(
              DiagnosticCode.UnsupportedExpression,
              "`Math.random()` is different on every run, so replays, tests and the parity between hosts will not repeat it. Seed your own generator in a `.ts` file for game logic.",
              this.span(node)
            )
          );
        }
        const args = this.lowerFunctionArgs(node.arguments);
        if (!args) return null;
        return { kind: "Call", callee: { kind: "Function", name }, args };
      }
    }
    // A timer (`after(0.15, () => setFlash(false))`): the component's own, so it is cancelled when the component goes.
    if (
      isIdentifier(callee) &&
      Object.hasOwn(TIMER_FUNCTIONS, callee.text) &&
      !this.scope.has(callee.text) &&
      !this.plainImports.has(callee.text)
    ) {
      this.requireImport(callee.text, callee);
      if (!this.mode.inHandler) {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          `'${callee.text}()' sets a timer, so it is only valid as a statement in a handler (\`useInput\`, \`useUpdate\`, \`useMount\`, a callback prop), not while rendering.`,
          node
        );
        return null;
      }
      const expected = TIMER_FUNCTIONS[callee.text]!;
      if (node.arguments.length !== expected) {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          `${callee.text} expects ${expected} argument(s)${expected === 2 ? ": the seconds, and the function to call (`() => …`)" : ""}.`,
          node
        );
        return null;
      }
      // The function it calls is a handler of its own, run later: setters, actions and sounds, as in any handler.
      const args = this.lowerPlainArgs(node.arguments);
      if (!args) return null;
      return { kind: "Call", callee: { kind: "Own", name: callee.text }, args };
    }
    // `nearby(tag, x, y, radius)` and `send(tag, where, value)`: the component's own, so they reach its world and skip its colliders.
    if (
      isIdentifier(callee) &&
      Object.hasOwn(WORLD_FUNCTIONS, callee.text) &&
      !this.scope.has(callee.text) &&
      !this.plainImports.has(callee.text)
    ) {
      this.requireImport(callee.text, callee);
      if (!this.mode.inHandler) {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          callee.text === "send"
            ? "'send()' delivers to colliders, so it is only valid in a handler (`useUpdate`, `useInput`, a callback prop), not while rendering."
            : "'nearby()' asks where colliders are this step, so it is only valid in a handler (`useUpdate`, `useInput`, a callback prop), not while rendering: keep what it found in a `useMutable` field to draw it.",
          node
        );
        return null;
      }
      const expected = WORLD_FUNCTIONS[callee.text]!;
      if (node.arguments.length !== expected) {
        this.report(
          DiagnosticCode.UnsupportedExpression,
          callee.text === "send"
            ? "send expects 3 arguments: the tag, where (`{ x, y, radius }` or a `nearby` result), and the value."
            : "nearby expects 4 arguments: the tag, x, y and the radius.",
          node
        );
        return null;
      }
      const args = this.lowerPlainArgs(node.arguments);
      if (!args) return null;
      return { kind: "Call", callee: { kind: "Own", name: callee.text }, args };
    }
    let result: { callee: CalleeIR; expected: number; label: string } | null = null;
    if (
      isPropertyAccessExpression(callee) &&
      isIdentifier(callee.expression) &&
      callee.expression.text === "Math" &&
      !this.scope.has("Math")
    ) {
      const name = `Math.${callee.name.text}`;
      const expected = MATH_FUNCTIONS[name];
      if (expected !== undefined) result = { callee: { kind: "Function", name }, expected, label: name };
    } else if (
      isIdentifier(callee) &&
      Object.hasOwn(GLOBAL_FUNCTIONS, callee.text) &&
      !this.scope.has(callee.text) &&
      !this.plainImports.has(callee.text)
    ) {
      result = { callee: { kind: "Function", name: callee.text }, expected: GLOBAL_FUNCTIONS[callee.text]!, label: callee.text };
    } else if (isIdentifier(callee) && this.manifest.functions[callee.text] !== undefined && !this.scope.has(callee.text)) {
      this.requireImport(callee.text, callee);
      result = { callee: { kind: "Function", name: callee.text }, expected: this.manifest.functions[callee.text]!, label: callee.text };
    } else if (isPropertyAccessExpression(callee) && !this.handleParam(callee.expression)) {
      return this.lowerArrayMethod(node, callee);
    } else if (isPropertyAccessExpression(callee)) {
      const receiver = this.lowerHandle(callee.expression);
      if (!receiver) return null;
      const expected = this.manifest.handleTypes[receiver.type]!.methods[callee.name.text];
      if (expected === undefined) {
        this.report(DiagnosticCode.UnsupportedExpression, `'${receiver.type}' has no callable method '${callee.name.text}'.`, callee.name);
        return null;
      }
      result = { callee: { kind: "Method", receiver: receiver.read, name: callee.name.text }, expected, label: callee.name.text };
    }
    if (!result) {
      const said = isIdentifier(callee)
        ? callee.text
        : isPropertyAccessExpression(callee) && isIdentifier(callee.expression)
          ? `${callee.expression.text}.${callee.name.text}`
          : null;
      const instead = said === null ? undefined : INSTEAD[said];
      if (instead !== undefined) {
        this.report(DiagnosticCode.UnsupportedExpression, instead, node);
        return null;
      }
      if (isIdentifier(callee) && !this.scope.has(callee.text)) {
        if (this.declaredAfterError(callee.text)) return null;
        const near = nearest(callee.text, [
          ...this.plainImports,
          ...Object.keys(this.manifest.functions),
          ...Object.keys(GLOBAL_FUNCTIONS),
        ]);
        this.report(
          DiagnosticCode.UnsupportedExpression,
          `'${callee.text}' is not a function the compiler knows${near !== null ? ` (did you mean '${near}'?)` : ""}. A component calls functions imported from a \`.ts\` file (\`import { ${callee.text} } from "./rules.ts"\`), its own functions, \`Math\`'s, \`String\`/\`Number\`/\`Boolean\`, and the engine's (\`clamp\`, \`freeze\`, …).`,
          node
        );
        return null;
      }
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "Only these calls work in a component: functions imported from a `.ts` file, its own functions, `Math`'s, `String`/`Number`/`Boolean`, the engine's (`clamp`, `freeze`, …), and the methods of a handler's parameters.",
        node
      );
      return null;
    }
    const count = node.arguments.length;
    // The manifest's arity: a count, -1 for at least one, -2 for any.
    if (result.expected !== -2 && (result.expected === -1 ? count < 1 : count !== result.expected)) {
      this.report(
        DiagnosticCode.UnsupportedExpression,
        `${result.label} expects ${result.expected === -1 ? "at least one" : result.expected} argument(s).`,
        node
      );
      return null;
    }
    // An engine function may be handed an arrow to call later, in a handler (`watchInputDevice(() => …)`), as an imported one may.
    const args = this.lowerPlainArgs(node.arguments);
    if (!args) return null;
    return { kind: "Call", callee: result.callee, args };
  }

  /** `enemies.filter((e) => e.alive)`: an allowlisted array method that does not mutate its receiver. */
  protected lowerArrayMethod(node: CallExpression, callee: PropertyAccessExpression): ExprIR | null {
    const name = callee.name.text;
    const code = DiagnosticCode.UnsupportedExpression;
    // Any method of a value the handler made itself (`list.push(e)`, `seen.add(id)`, `best.sort(…)`): it may change it in place.
    if (this.ownsValue(callee.expression) && !Object.hasOwn(ARRAY_METHODS, name)) {
      const receiver = this.lowerNode(callee.expression);
      if (!receiver) return null;
      const args = this.lowerFunctionArgs(node.arguments);
      if (!args) return null;
      return {
        kind: "Call",
        callee: {
          kind: "ValueMethod",
          receiver,
          name,
          optional: callee.questionDotToken !== undefined || node.questionDotToken !== undefined,
        },
        args,
      };
    }
    // A method of a per-instance object (state a factory made, or a `useMutable` field holding one: `b.body.move(dx, dy)`): opaque,
    // like a plain function.
    if (!Object.hasOwn(ARRAY_METHODS, name)) {
      const handleReceiver = unwrapParens(callee.expression);
      const binding = isIdentifier(handleReceiver) ? this.scope.get(handleReceiver.text) : undefined;
      const field = isPropertyAccessExpression(handleReceiver) ? this.mutableField(handleReceiver) : undefined;
      if (field === "error") return null;
      if ((binding?.kind === "state" && this.handleStates.has(binding.id)) || (field !== undefined && this.handleStates.has(field))) {
        const receiver = this.lowerNode(callee.expression);
        if (!receiver) return null;
        const args = this.lowerAll(node.arguments);
        if (!args) return null;
        return { kind: "Call", callee: { kind: "ValueMethod", receiver, name }, args };
      }
    }
    // A method of a string or a number (`name.toUpperCase()`, `id.startsWith("bind:")`): changes nothing, so it is called as written.
    if (VALUE_METHODS.has(name) && !Object.hasOwn(ARRAY_METHODS, name)) {
      if (callee.questionDotToken || node.questionDotToken) {
        this.report(code, `Optional calls of \`${name}\` are not supported: check the value first.`, node);
        return null;
      }
      const receiver = this.lowerNode(callee.expression);
      if (!receiver) return null;
      const args = this.lowerAll(node.arguments);
      if (!args) return null;
      return { kind: "Call", callee: { kind: "ValueMethod", receiver, name }, args };
    }
    if (name === "forEach") {
      // It changes nothing itself; its function does, through the variables around it, which the compiler does not follow there.
      this.report(
        code,
        "`forEach` is not supported: write a `for (const item of items) { … }` loop, which works in the component body and in handlers, or `map`, `filter` or `some` for a value.",
        callee.name
      );
      return null;
    }
    if (Object.hasOwn(MUTATING_ARRAY_METHODS, name)) {
      // On a `useMutable` field (`s.enemies.push(e)`): the field is assigned a new array, written as the author would write it.
      const receiver = unwrapParens(callee.expression);
      const mutable = isPropertyAccessExpression(receiver) ? this.mutableField(receiver) : undefined;
      if (mutable === "error") return null;
      if (mutable !== undefined) {
        const list = receiver.getText(this.sourceFile);
        const item = node.arguments[0]?.getText(this.sourceFile) ?? "item";
        const instead: Readonly<Record<string, string>> = {
          push: `${list} = [...${list}, ${item}]`,
          unshift: `${list} = [${item}, ...${list}]`,
          pop: `${list} = ${list}.slice(0, -1)`,
          shift: `${list} = ${list}.slice(1)`,
          splice: `${list} = ${list}.toSpliced(…)`,
          sort: `${list} = ${list}.toSorted(…)`,
          reverse: `${list} = ${list}.toReversed()`,
          fill: `${list} = ${list}.map(…)`,
          copyWithin: `${list} = ${list}.map(…)`,
        };
        this.report(
          code,
          `\`${name}\` changes \`${list}\` in place: write it as a statement of its own (\`${list}.${name}(…);\`), which the compiler turns into a new array. As a value it is not available; for the new array: \`${instead[name] ?? `${list} = …`}\`.`,
          callee.name
        );
        return null;
      }
      // `[...alive].sort(byX)`, `items.filter(f).reverse()`: on an array made right here, nothing else holds it, so sorting it in place
      // is sorting a copy. Written as the copying form, which is what it means.
      const fresh = unwrapParens(callee.expression);
      const copying = name === "sort" ? "toSorted" : name === "reverse" ? "toReversed" : null;
      if (copying !== null && this.isFreshArray(fresh) && !callee.questionDotToken && !node.questionDotToken) {
        const lowered = this.lowerNode(fresh);
        return lowered && this.lowerArrayCall(lowered, copying, node.arguments, node);
      }
      const store = this.storeWrite(receiver, name);
      this.report(
        code,
        store ??
          `\`${name}\` changes the array in place, which never re-renders. Build a new array instead: ${MUTATING_ARRAY_METHODS[name]}, or keep the list in a \`useMutable\` field, where \`s.items.${name}(…)\` works.`,
        callee.name
      );
      return null;
    }
    if (!Object.hasOwn(ARRAY_METHODS, name)) {
      const near = nearest(name, [...Object.keys(ARRAY_METHODS), ...VALUE_METHODS, ...Object.keys(MUTATING_ARRAY_METHODS)]);
      if (near !== null) {
        this.report(code, `'${name}' is not a method the compiler knows: did you mean '${near}'?`, callee.name);
        return null;
      }
      this.report(
        code,
        `'${name}' is not a method a component can call. Array methods that make a new value (\`map\`, \`filter\`, \`find\`, \`reduce\`, \`toSorted\`, …) and string and number methods (\`padStart\`, \`toFixed\`, …) work, and in a handler so do the methods of a value the handler made itself. For anything else, write a function in a .ts file and import it.`,
        callee.name
      );
      return null;
    }
    if (callee.questionDotToken || node.questionDotToken) {
      this.report(code, `Optional calls of array methods are not supported: check the value first.`, node);
      return null;
    }
    const receiver = this.lowerNode(callee.expression);
    if (!receiver) return null;
    return this.lowerArrayCall(receiver, name as ArrayMethodName, node.arguments, node);
  }

  /**
   * An array made by the expression itself, which nothing else holds: a literal (`[...items]`) or what a copying method returns
   * (`items.filter(…)`, `items.slice()`, `items.map(…)`).
   */
  protected isFreshArray(node: Expression): boolean {
    if (isArrayLiteralExpression(node)) return true;
    if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return false;
    return ["filter", "map", "slice", "concat", "flatMap", "flat", "toSorted", "toReversed", "toSpliced", "with"].includes(
      node.expression.name.text
    );
  }

  /** An allowlisted array method called on a receiver already lowered: its arguments counted and lowered (an arrow for a callback). */
  lowerArrayCall(receiver: ExprIR, name: ArrayMethodName, argNodes: readonly Expression[], at: Node): ExprIR | null {
    const method = ARRAY_METHODS[name];
    const [min, max] = method.args;
    const count = argNodes.length;
    if (count < min || count > max) {
      const expected = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
      this.report(DiagnosticCode.UnsupportedExpression, `\`${name}\` expects ${expected} argument(s).`, at);
      return null;
    }
    const args: ExprIR[] = [];
    for (const [i, argument] of argNodes.entries()) {
      const lowered = method.callback && i === 0 ? this.lowerArrow(argument, name) : this.lowerNode(argument);
      if (!lowered) return null;
      args.push(lowered);
    }
    return { kind: "Call", callee: { kind: "ArrayMethod", receiver, name }, args };
  }

  /** Resolves an expression that must be a handler parameter of a named runtime type. */
  protected lowerHandle(node: Expression): { type: string; read: ParamReadIR } | null {
    const handle = this.handleParam(node);
    if (!handle)
      this.report(
        DiagnosticCode.UnsupportedExpression,
        "Members can only be accessed on handler parameters of a runtime type (e.g. `input`).",
        node
      );
    return handle;
  }

  /** `s.battle.gold` in a computed selector; overridden where the hooks are lowered. */
  protected lowerStoreRead(_path: readonly string[], at: Node): ExprIR | null {
    this.report(DiagnosticCode.UnsupportedExpression, "The game state is read with a selector.", at);
    return null;
  }

  // -- LoweringContext --------------------------------------------------------

  lowerExpression(node: Expression): ExprIR | null {
    return this.lowerNode(node);
  }

  /**
   * The message for a write into a value read from the game state (`run.time = 0`, `items.push(x)`), or null when `node` is not
   * one: only its actions change it, so the message names the action to add.
   */
  protected storeWrite(node: Expression, method?: string): string | null {
    let root: Expression = unwrapParens(node);
    while (isPropertyAccessExpression(root) || isElementAccessExpression(root) || isNonNullExpression(root))
      root = unwrapParens(root.expression);
    if (!isIdentifier(root) || this.scope.get(root.text)?.kind !== "state") return null;
    const path = this.storeNames.get(root.text);
    if (path === undefined) return null;
    const written = node.getText(this.sourceFile);
    const inState = `s.${path}${written.slice(root.text.length)}`;
    const write = method === undefined ? `${inState} = …;` : `${inState}.${method}(…);`;
    return `'${root.text}' is read from the game state, which only its actions change: add an action to GameState.ts that writes it (\`name(s) { ${write} }\`) and call that here (\`const { name } = useGame.actions();\`).`;
  }

  lowerAssignTarget(node: Expression): AssignTargetIR | null {
    // `best.hits = 0`, `grid[y]![x] = 1`: into a value the handler made.
    if ((isPropertyAccessExpression(node) || isElementAccessExpression(node)) && this.ownsValue(node)) {
      const target = this.lowerNode(node);
      return target && { kind: "Path", target };
    }
    const binding = isIdentifier(node) ? this.scope.get(node.text) : undefined;
    if (binding?.kind === "local") {
      if (binding.mutable) return { kind: "Local", local: binding.id, name: binding.name };
      this.report(DiagnosticCode.UnsupportedStatement, `'${binding.name}' is a \`const\`: declare it with \`let\` to assign to it.`, node);
      return null;
    }
    // A name whose declaration was refused already has its error (`useRef`, a failed `const`): the write is not reported again.
    let root: Expression = node;
    while (isPropertyAccessExpression(root) || isElementAccessExpression(root) || isNonNullExpression(root))
      root = unwrapParens(root.expression);
    if (isIdentifier(root) && !this.scope.has(root.text) && this.declaredAfterError(root.text)) return null;
    const store = this.storeWrite(node);
    if (store !== null) {
      this.report(DiagnosticCode.UnsupportedStatement, store, node);
      return null;
    }
    this.report(
      DiagnosticCode.UnsupportedStatement,
      "Only `let` locals and the members of a handler's own values can be assigned. To change state, write through its `useMutable` field (`s.foes[i].hp = 0`, `s.pos.x = 3`) or give the field a new value (`s.foes = s.foes.map(…)`): a name for one of its items (`const e = s.foes[0]`) or a loop variable is a read, not a way to write.",
      node
    );
    return null;
  }
}
