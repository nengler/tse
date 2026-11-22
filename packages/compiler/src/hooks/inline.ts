/**
 * Custom hooks, inlined at compile time. A hook is an ordinary function whose name starts with `use`, whose body is what a
 * component body may hold (`useMutable`, `useSound`, `useInput`, `useUpdate`, `useMount`, `useUnmount`, a selector on the
 * game state, derived constants, other custom hooks) and that ends in an optional `return`:
 *
 *     function usePlatformerBody(speed: number) {
 *       const s = useMutable({ x: 0 });
 *       useUpdate((dt) => { s.x += speed * dt; });
 *       return { x: s.x };
 *     }
 *     function Player() {
 *       const { x } = usePlatformerBody(90);
 *       return <Entity name="Player" x={x} />;
 *     }
 *
 * "Hooks are compiler intrinsics": the call does not exist at run time. Before a file is compiled, each call that is a statement
 * of a component body is replaced by the hook's own statements, with the names the hook declares given a prefix that is
 * unique to that call (so two calls make two separate states), its parameters bound by `const` to the arguments, and the
 * `return` turned into the declarations the call site asked for (`const v = …`, `const { a, b } = …`). The result is the
 * component the author could have written by hand, and goes through the same compiler, so every rule of a component body
 * applies to it, and every diagnostic is the usual one.
 *
 * Where hooks may be: in the same file as the component, or in a relative `.tsx` file (`import { useThing } from "./hooks.tsx"`).
 * Not supported, each with a diagnostic: a hook call that is not a statement of the component body (in a condition, a
 * callback, an expression), a return that is not a value, an object literal or an array literal, and a parameter that is
 * destructured. Recursion (a hook that calls itself) stops at a depth limit.
 *
 * It is text to text: the replaced file is what the rest of the compiler sees, so positions in later diagnostics are those of the
 * expanded source.
 */
import {
  NodeFlags,
  SyntaxKind,
  type Block,
  type CallExpression,
  type Expression,
  type FunctionDeclaration,
  type Node,
  type SourceFile,
  type Statement,
} from "typescript/ast";
import {
  isArrayBindingPattern,
  isArrayLiteralExpression,
  isBindingElement,
  isCallExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isJsxAttribute,
  isJsxClosingElement,
  isJsxElement,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isNamedImports,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isReturnStatement,
  isShorthandPropertyAssignment,
  isStringLiteral,
  isVariableStatement,
  isIfStatement,
  isBlock,
} from "typescript/ast/is";

import { AUTHORING_HOOKS, HOOK_NAME } from "../analyzer/model.ts";
import { relativeTsImportNames, runtimeAlias } from "../analyzer/util.ts";
import { DiagnosticCode, error, type CompilerDiagnostic } from "../diagnostics/diagnostics.ts";
import { spanOf, type ParsedSource, type TsxParser } from "../parser/parser.ts";
import { applyEdits, EditMap, type Edit } from "./edits.ts";
import { LIBRARY_FILE, LIBRARY_HOOKS, LIBRARY_SOURCE } from "./library.ts";

/** The module the library's own source imports from; rewritten to the project's authoring module when they differ. */
const LIBRARY_AUTHORING_MODULE = "@tsengine/runtime/jsx";

export interface HookSource {
  readonly fileName: string;
  readonly text: string;
}

/** Finds the source of a relative `.tsx` module (`"./hooks.tsx"`) imported by `fromFile`, or null. */
export type HookResolver = (specifier: string, fromFile: string) => HookSource | null;

const HOOK = HOOK_NAME;
const MAX_DEPTH = 12;

interface Hook {
  readonly name: string;
  readonly fileName: string;
  readonly text: string;
}

/** Is a name one an author may have defined (so not a built-in hook, and not the game state's own `useGame`)? */
function isCustomName(name: string, stores: ReadonlySet<string>): boolean {
  return HOOK.test(name) && !AUTHORING_HOOKS.includes(name) && !stores.has(name);
}

/** The names bound by relative `.ts` imports: the game state's store, which looks like a hook and is not one. */
const storeNames = relativeTsImportNames;

/** What the inliner made of a file: its text with every custom hook written out, and how to trace positions back. */
export interface ExpandedSource {
  readonly text: string;
  /** The edits from the original text to `text`: `map.span(…)` moves a span in `text` back to the original. */
  readonly map: EditMap;
  /** `text`, already parsed, when the inliner's last parse was of exactly this text (the caller owns it and disposes it). */
  readonly parsed: ParsedSource | null;
  /**
   * Where each inlined hook call was, in the original text. A diagnostic found inside an expansion maps to exactly its call's
   * range, so the compiler can tell what came from a hook's body (see `Compiler.compile`, one mistake, one error).
   */
  readonly calls: readonly { readonly start: number; readonly end: number }[];
}

/**
 * Inline the custom hooks used in `text`. Returns the text unchanged when it uses none. Problems are pushed to `diagnostics`
 * (their spans already in the original text) and leave the text as it was, for the compiler to report on as it would.
 */
export function inlineCustomHooks(
  parser: TsxParser,
  fileName: string,
  text: string,
  resolve: HookResolver | null,
  diagnostics: CompilerDiagnostic[],
  authoringModule = LIBRARY_AUTHORING_MODULE
): string {
  const expanded = expandCustomHooks(parser, fileName, text, resolve, diagnostics, authoringModule);
  expanded.parsed?.dispose();
  return expanded.text;
}

/** `inlineCustomHooks`, keeping the edit map and the last parse for the compiler, which goes on to analyze the result. */
export function expandCustomHooks(
  parser: TsxParser,
  fileName: string,
  text: string,
  resolve: HookResolver | null,
  diagnostics: CompilerDiagnostic[],
  authoringModule: string
): ExpandedSource {
  const map = new EditMap();
  const calls: { start: number; end: number }[] = [];
  const files = new HookFiles(parser);
  const library =
    authoringModule === LIBRARY_AUTHORING_MODULE
      ? LIBRARY_SOURCE
      : LIBRARY_SOURCE.replace(JSON.stringify(LIBRARY_AUTHORING_MODULE), JSON.stringify(authoringModule));
  let current = text;
  let counter = 0;
  let split = false;
  // What a hook from another file imports from the authoring module (`useMutable`, `useUpdate`): its expansion needs those here.
  const needed = new Map<string, Set<string>>();
  // Diagnostics found in a pass point into that pass's text: move them back to the original.
  const remap = (from: number, passes: number): void => {
    for (let i = from; i < diagnostics.length; i++) {
      const d = diagnostics[i]!;
      if (d.span) diagnostics[i] = { ...d, span: map.span(d.span, fileName, text, passes) };
    }
  };
  // The hooks expanded at each depth, for the message when the expansion does not end (`useA → useB → useA`).
  const chain: string[][] = [];
  try {
    for (let depth = 0; depth <= MAX_DEPTH;) {
      const parsed = parser.parse(fileName, current);
      const reported = diagnostics.length;
      const passes = map.passes;
      let keep = false;
      try {
        const sf = parsed.sourceFile;
        const stores = storeNames(sf);
        // First, once: a destructured selection on the game state becomes one selector per name (it may hold no hook at all).
        if (!split) {
          split = true;
          const edits = [
            ...storeSelectionEdits(sf, fileName, current, stores, diagnostics),
            ...providerEdits(sf, current, authoringModule),
            ...earlyReturnEdits(sf),
          ];
          if (edits.length > 0) {
            current = map.apply(current, edits);
            continue;
          }
        }
        depth++;
        const hooks = collectHooks(files, sf, fileName, current, resolve, stores, authoringModule, library);
        const edits: Edit[] = [];
        const expandedHere: string[] = [];
        let found = false;
        for (const statement of sf.statements) {
          for (const body of componentBodies(statement)) {
            // Every name the component uses: what a hook's `useMutable` is named after the hook must not be one of them.
            const fileNames = new Set((body.parent ?? body).getText(sf).match(/[A-Za-z_$][\w$]*/g));
            const bodyNames = new Set<string>();
            for (const stmt of body.statements) {
              const call = hookCall(stmt, stores);
              if (call === null) {
                reportNested(stmt, sf, fileName, stores, diagnostics);
                continue;
              }
              const hook = hooks.get(call.name);
              // A name that is no hook of this file is left for the compiler's own report (it knows the retired hooks and suggests the nearest).
              if (hook === undefined) continue;
              found = true;
              if (!expandedHere.includes(call.name)) expandedHere.push(call.name);
              const expanded = expandCall(
                files,
                stmt,
                call,
                hook,
                sf,
                fileName,
                `_${call.name}${++counter}_`,
                (name) => !fileNames.has(name) && !bodyNames.has(name),
                bodyNames,
                diagnostics
              );
              if (hook.fileName !== fileName)
                collectImports(files, hook, needed, importClashes(files.get(hook.fileName, hook.text), hook.name, sf));
              if (expanded !== null) {
                edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: expanded });
                const start = map.toOriginal(stmt.getStart(sf), map.passes, "start");
                const end = map.toOriginal(stmt.getEnd(), map.passes, "end");
                if (!calls.some((c) => c.start === start && c.end === end)) calls.push({ start, end });
              }
            }
          }
        }
        if (!found) {
          // No call is left to expand: the hook declarations and their imports were only for the calls.
          const removed = map.apply(current, removeHookDeclarations(sf, stores, authoringModule));
          const result = map.apply(removed, importEdits(sf, needed));
          keep = result === current;
          return { text: result, map, parsed: keep ? parsed : null, calls };
        }
        if (edits.length === 0) {
          keep = true; // every call failed; the diagnostics say why
          return { text: current, map, parsed, calls };
        }
        chain.push(expandedHere);
        current = map.apply(current, edits);
      } finally {
        remap(reported, passes);
        if (!keep) parsed.dispose();
      }
    }
  } finally {
    files.dispose();
  }
  // Name the chain: each depth's hooks, from the first the component calls. A name seen twice is a hook that calls itself.
  const steps = chain.map((names) => names.join(" / "));
  const firstRepeat = steps.findIndex((step, i) => steps.indexOf(step) !== i);
  const shown = firstRepeat >= 0 ? steps.slice(0, firstRepeat + 1) : steps;
  const how =
    firstRepeat >= 0
      ? `'${steps[firstRepeat]}' calls itself through ${shown.join(" → ")}`
      : `they call each other more than ${MAX_DEPTH} levels deep: ${shown.join(" → ")} → …`;
  diagnostics.push(error(DiagnosticCode.UnsupportedSyntax, `Custom hooks are inlined, so they cannot recurse: ${how}.`, null));
  return { text, map: new EditMap(), parsed: null, calls: [] };
}

/** The hook sources parsed for one file's inlining, each once (a hook called three times was parsed three times). */
class HookFiles {
  readonly #parser: TsxParser;
  readonly #parsed = new Map<string, ParsedSource>();

  constructor(parser: TsxParser) {
    this.#parser = parser;
  }

  get(fileName: string, text: string): SourceFile {
    const key = `${fileName}\0${text}`;
    let parsed = this.#parsed.get(key);
    if (parsed === undefined) {
      parsed = this.#parser.parse(fileName, text);
      this.#parsed.set(key, parsed);
    }
    return parsed.sourceFile;
  }

  dispose(): void {
    for (const parsed of this.#parsed.values()) parsed.dispose();
    this.#parsed.clear();
  }
}

/**
 * Several values from the game state at once, as Zustand allows, each becoming its own selector (so its own subscription, and
 * a component re-renders only for the values it reads):
 *
 *     const { originX, room } = useGame((s) => s.run);              → const originX = useGame((s) => s.run.originX); …
 *     const { a, b: c } = useGame((s) => ({ a: s.x, b: s.y.z }));   → const a = useGame((s) => s.x); const c = useGame((s) => s.y.z);
 *     const [a, b] = useGame((s) => [s.x, s.y]);                    → const a = useGame((s) => s.x); const b = …
 *     const { collect } = useGame.actions();                        → const collect = useGame.$actions((s) => s.collect);
 *
 * `$actions` and `$wholeN` (names picked from `(s) => s`) are the compiler's own spellings, read by `matchStoreStatement`.
 */
function storeSelectionEdits(
  sf: SourceFile,
  fileName: string,
  text: string,
  stores: ReadonlySet<string>,
  diagnostics: CompilerDiagnostic[]
): Edit[] {
  const edits: Edit[] = [];
  const src = (n: Node): string => text.slice(n.getStart(sf), n.getEnd());
  for (const statement of sf.statements) {
    for (const body of componentBodies(statement)) {
      for (const stmt of body.statements) {
        if (!isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) continue;
        const d = stmt.declarationList.declarations[0]!;
        const init = d.initializer;
        const fail = (message: string): void => {
          diagnostics.push(error(DiagnosticCode.InvalidGameState, message, spanOf(stmt, sf, fileName)));
        };
        // `const { collect, hurt } = useGame.actions()`: each name is an action, selected on its own (`$actions` checks it is one).
        if (init && isCallExpression(init) && isPropertyAccessExpression(init.expression) && init.expression.name.text === "actions") {
          const target = init.expression.expression;
          if (!isIdentifier(target) || !stores.has(target.text) || !HOOK.test(target.text)) continue;
          const store = target.text;
          if (init.arguments.length !== 0) {
            fail(`${store}.actions() takes no arguments: \`const { collect, hurt } = ${store}.actions()\`.`);
            continue;
          }
          if (!isObjectBindingPattern(d.name)) {
            fail(`Destructure the actions you call from ${store}.actions(): \`const { collect, hurt } = ${store}.actions()\`.`);
            continue;
          }
          const lines: string[] = [];
          for (const element of d.name.elements) {
            if (element.name === undefined || !isIdentifier(element.name) || element.dotDotDotToken) {
              fail(`Each action picked from ${store}.actions() is a plain name: \`const { a, b: c } = ${store}.actions()\`.`);
              continue;
            }
            const key = element.propertyName !== undefined ? (element.propertyName as unknown as { text: string }).text : element.name.text;
            lines.push(`const ${element.name.text} = ${store}.$actions((s) => s.${key});`);
          }
          edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: lines.join("\n  ") });
          continue;
        }
        if (
          !init ||
          !isCallExpression(init) ||
          !isIdentifier(init.expression) ||
          !stores.has(init.expression.text) ||
          !HOOK.test(init.expression.text)
        )
          continue;
        if (!isObjectBindingPattern(d.name) && !isArrayBindingPattern(d.name)) continue;
        const store = init.expression.text;
        const selector = init.arguments[0];
        const fn = selector !== undefined ? unwrap(selector) : undefined;
        if (fn === undefined || fn.kind !== SyntaxKind.ArrowFunction) continue;
        const arrow = fn as unknown as { parameters: readonly { name: Node }[]; body: Node };
        const param = arrow.parameters[0];
        if (arrow.parameters.length !== 1 || param === undefined || !isIdentifier(param.name)) continue;
        const p = param.name.text;
        const body = unwrap(arrow.body);
        const lines: string[] = [];
        // `const { advance } = useGame((s) => s)`: names from the whole state, which `$wholeN` marks (N tells statements apart) so the
        // actions picked this way can be pointed at `useGame.actions()`, in one warning per statement.
        const whole = isIdentifier(body) && body.text === p;
        if (isObjectBindingPattern(d.name)) {
          const picked = isObjectLiteralExpression(body) ? new Map<string, string>() : null;
          if (picked !== null && isObjectLiteralExpression(body)) {
            for (const property of body.properties) {
              if (isPropertyAssignment(property) && isIdentifier(property.name)) picked.set(property.name.text, src(property.initializer));
              else if (isShorthandPropertyAssignment(property)) {
                const n = (property.name as unknown as { text: string }).text;
                picked.set(n, n);
              }
            }
          }
          for (const element of d.name.elements) {
            if (element.name === undefined || !isIdentifier(element.name) || element.dotDotDotToken) {
              fail(`Each value picked from ${store} is a plain name: \`const { a, b: c } = ${store}(…)\`.`);
              continue;
            }
            const key = element.propertyName !== undefined ? (element.propertyName as unknown as { text: string }).text : element.name.text;
            const path = picked !== null ? picked.get(key) : `${src(body)}.${key}`;
            if (path === undefined) {
              fail(`The selector does not pick '${key}'.`);
              continue;
            }
            lines.push(`const ${element.name.text} = ${store}${whole ? `.$whole${edits.length}` : ""}((${p}) => ${path});`);
          }
        } else {
          const items =
            body.kind === SyntaxKind.ArrayLiteralExpression ? (body as unknown as { elements: readonly Node[] }).elements : null;
          if (items === null) {
            fail(`\`const [a, b] = ${store}(…)\` needs a selector that returns an array of paths: \`(${p}) => [${p}.a, ${p}.b]\`.`);
            continue;
          }
          d.name.elements.forEach((element, i) => {
            const item = items[i];
            if (!isBindingElement(element) || element.name === undefined || !isIdentifier(element.name) || item === undefined) return;
            lines.push(`const ${element.name.text} = ${store}((${p}) => ${src(item)});`);
          });
        }
        edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: lines.join("\n  ") });
      }
    }
  }
  return edits;
}

/**
 * `<Theme.Provider value={v}>…</Theme.Provider>`, React's way to provide a context, is the built-in `<Provider context={Theme}
 * value={v}>…</Provider>`: the tag is rewritten, and `Provider` is added to the file's import from the authoring module.
 */
function providerEdits(sf: SourceFile, text: string, authoringModule: string): Edit[] {
  const edits: Edit[] = [];
  const visit = (node: Node): void => {
    if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node) || isJsxClosingElement(node)) {
      const tag = node.tagName;
      if (isPropertyAccessExpression(tag) && tag.name.text === "Provider" && isIdentifier(tag.expression)) {
        const replacement = isJsxClosingElement(node) ? "Provider" : `Provider context={${tag.expression.text}}`;
        edits.push({ start: tag.getStart(sf), end: tag.getEnd(), text: replacement });
      }
    }
    node.forEachChild(visit);
  };
  sf.forEachChild(visit);
  if (edits.length === 0) return edits;
  const authoring = sf.statements.find(
    (st) => isImportDeclaration(st) && isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === authoringModule
  );
  const named = authoring !== undefined && isImportDeclaration(authoring) ? authoring.importClause?.namedBindings : undefined;
  if (named !== undefined && isNamedImports(named)) {
    if (!named.elements.some((e) => e.name.text === "Provider")) {
      const last = named.elements[named.elements.length - 1];
      const at = last !== undefined ? last.getEnd() : named.getStart(sf) + 1;
      edits.push({ start: at, end: at, text: last !== undefined ? ", Provider" : " Provider " });
    }
  } else {
    edits.push({ start: 0, end: 0, text: `import { Provider } from ${JSON.stringify(authoringModule)}; ` });
  }
  void text;
  return edits.sort((a, b) => a.start - b.start);
}

/** Parentheses (and `as`) around an expression do not change it. */
function unwrap(node: Node): Node {
  let at = node;
  while (at.kind === SyntaxKind.ParenthesizedExpression || at.kind === SyntaxKind.AsExpression)
    at = (at as unknown as { expression: Node }).expression;
  return at;
}

/** The blocks that are component bodies: a capitalised function, or an arrow assigned to a capitalised const, at the top level. */
/**
 * React's early return, `if (!hero) return null;` before the component's last `return`, as one return of its JSX: each
 * `if (c) return A;` at the top of the body goes, and the last `return B;` becomes `return (c) ? (A) : (B);`, the first early
 * return first. What the body declares is worked out where it is read, so a `const hp = hero.hp;` after the guard runs only in
 * the branch where the guard did not return, as it does in React.
 */
function earlyReturnEdits(sf: SourceFile): Edit[] {
  const edits: Edit[] = [];
  for (const statement of sf.statements) {
    for (const body of componentBodies(statement)) {
      const statements = body.statements;
      const last = statements[statements.length - 1];
      if (last === undefined || !isReturnStatement(last) || last.expression === undefined) continue;
      const early: { readonly condition: string; readonly value: string; readonly statement: Statement }[] = [];
      for (const s of statements.slice(0, -1)) {
        if (!isIfStatement(s) || s.elseStatement !== undefined) continue;
        let then: Statement = s.thenStatement;
        if (isBlock(then)) {
          if (then.statements.length !== 1) continue;
          then = then.statements[0]!;
        }
        if (!isReturnStatement(then) || then.expression === undefined) continue;
        early.push({ condition: s.expression.getText(sf), value: branch(then.expression, sf), statement: s });
      }
      if (early.length === 0) continue;
      for (const e of early) edits.push({ start: e.statement.getStart(sf), end: e.statement.getEnd(), text: "" });
      const final = last.expression;
      // A root takes one condition, whose branches are elements or null; a further one goes in a fragment (`<>{c ? A : B}</>`).
      let returned = branch(final, sf);
      for (let i = early.length - 1; i >= 0; i--) {
        const e = early[i]!;
        const otherwise = i === early.length - 1 ? returned : `<>{${returned}}</>`;
        returned = `(${e.condition}) ? (${e.value}) : (${otherwise})`;
      }
      edits.push({ start: final.getStart(sf), end: final.getEnd(), text: returned });
    }
  }
  return edits;
}

/** A returned value as a branch of a root's condition: an element, a fragment or `null` as written; anything else in a fragment. */
function branch(value: Expression, sf: SourceFile): string {
  let node: Node = value;
  while (node.kind === SyntaxKind.ParenthesizedExpression) node = (node as unknown as { expression: Node }).expression;
  const plain =
    isJsxElement(node) || isJsxSelfClosingElement(node) || node.kind === SyntaxKind.JsxFragment || node.kind === SyntaxKind.NullKeyword;
  return plain ? value.getText(sf) : `<>{${value.getText(sf)}}</>`;
}

function componentBodies(statement: Statement): Block[] {
  if (isFunctionDeclaration(statement) && statement.name && /^[A-Z]/.test(statement.name.text) && statement.body) return [statement.body];
  if (isVariableStatement(statement)) {
    const out: Block[] = [];
    for (const d of statement.declarationList.declarations) {
      if (isIdentifier(d.name) && /^[A-Z]/.test(d.name.text) && d.initializer && d.initializer.kind === SyntaxKind.ArrowFunction) {
        const body = (d.initializer as unknown as { body: Node }).body;
        if (body.kind === SyntaxKind.Block) out.push(body as Block);
      }
    }
    return out;
  }
  return [];
}

interface HookCall {
  readonly name: string;
  readonly call: CallExpression;
  /** How the result is bound: not at all, `const v = …`, `const { a, b } = …` or `const [a, b] = …`. */
  readonly binding:
    | { readonly kind: "none" }
    | { readonly kind: "name"; readonly name: string; readonly keyword: string }
    | { readonly kind: "object" | "array"; readonly node: Node; readonly keyword: string };
}

/** A statement that is a call of a custom hook (alone, or as the initializer of one `const`), or null. */
function hookCall(statement: Statement, stores: ReadonlySet<string>): HookCall | null {
  if (
    isExpressionStatement(statement) &&
    isCallExpression(statement.expression) &&
    isIdentifier(statement.expression.expression) &&
    isCustomName(statement.expression.expression.text, stores)
  ) {
    return { name: statement.expression.expression.text, call: statement.expression, binding: { kind: "none" } };
  }
  if (isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const d = statement.declarationList.declarations[0]!;
    const init = d.initializer;
    if (init && isCallExpression(init) && isIdentifier(init.expression) && isCustomName(init.expression.text, stores)) {
      const keyword = (statement.declarationList.flags & NodeFlags.Const) !== 0 ? "const" : "let";
      if (isIdentifier(d.name)) return { name: init.expression.text, call: init, binding: { kind: "name", name: d.name.text, keyword } };
      if (isObjectBindingPattern(d.name))
        return { name: init.expression.text, call: init, binding: { kind: "object", node: d.name, keyword } };
      if (isArrayBindingPattern(d.name))
        return { name: init.expression.text, call: init, binding: { kind: "array", node: d.name, keyword } };
    }
  }
  return null;
}

/** A custom hook called somewhere a hook cannot be (in a condition, a callback, an expression) is reported where it is. */
function reportNested(
  statement: Statement,
  sf: SourceFile,
  fileName: string,
  stores: ReadonlySet<string>,
  diagnostics: CompilerDiagnostic[]
): void {
  const stack: Node[] = [statement];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      isCustomName(node.expression.text, stores) &&
      node !== (statement as unknown as { expression?: Node }).expression
    ) {
      // A call that is the whole initializer of a `const` is a hook call; anything else is nested.
      const direct = isVariableStatement(statement) && statement.declarationList.declarations.some((d) => d.initializer === node);
      if (!direct) {
        diagnostics.push(
          error(
            DiagnosticCode.HookNotAtTopLevel,
            `The custom hook '${node.expression.text}' must be a statement of the component body (\`${node.expression.text}(…);\` or \`const v = ${node.expression.text}(…);\`): hooks are inlined into the component, so they cannot be called in a condition, a callback or an expression.`,
            spanOf(node, sf, fileName)
          )
        );
      }
    }
    node.forEachChild((child) => {
      stack.push(child);
      return undefined;
    });
  }
}

/** The custom hooks visible in this file: declared here, or imported from a relative `.tsx` file (their source read through `resolve`). */
function collectHooks(
  files: HookFiles,
  sf: SourceFile,
  fileName: string,
  text: string,
  resolve: HookResolver | null,
  stores: ReadonlySet<string>,
  authoringModule: string,
  library: string
): Map<string, Hook> {
  const hooks = new Map<string, Hook>();
  for (const statement of sf.statements) {
    if (isFunctionDeclaration(statement) && statement.name && isCustomName(statement.name.text, stores))
      hooks.set(statement.name.text, { name: statement.name.text, fileName, text });
    // The engine's own hooks, imported from the authoring module.
    if (
      isImportDeclaration(statement) &&
      isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === authoringModule
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && isNamedImports(bindings)) {
        for (const element of bindings.elements)
          if (LIBRARY_HOOKS.includes(element.name.text))
            hooks.set(element.name.text, { name: element.name.text, fileName: LIBRARY_FILE, text: library });
      }
    }
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.moduleSpecifier) ||
      !/^\.\.?\/.*\.tsx$/.test(statement.moduleSpecifier.text)
    )
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !isNamedImports(bindings)) continue;
    const wanted = bindings.elements.map((e) => e.name.text).filter((n) => isCustomName(n, stores));
    if (wanted.length === 0 || resolve === null) continue;
    const source = resolve(statement.moduleSpecifier.text, fileName);
    if (source === null) continue;
    for (const s of files.get(source.fileName, source.text).statements) {
      if (isFunctionDeclaration(s) && s.name && wanted.includes(s.name.text))
        hooks.set(s.name.text, { name: s.name.text, fileName: source.fileName, text: source.text });
    }
  }
  return hooks;
}

/** Take hook declarations out of the file, and the hooks out of imports (and an import that is left empty), once nothing calls them. */
function removeHookDeclarations(sf: SourceFile, stores: ReadonlySet<string>, authoringModule: string): Edit[] {
  const edits: Edit[] = [];
  for (const statement of sf.statements) {
    if (isFunctionDeclaration(statement) && statement.name && isCustomName(statement.name.text, stores)) {
      edits.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
    } else if (
      isImportDeclaration(statement) &&
      isStringLiteral(statement.moduleSpecifier) &&
      (/^\.\.?\/.*\.tsx$/.test(statement.moduleSpecifier.text) || statement.moduleSpecifier.text === authoringModule)
    ) {
      const library = statement.moduleSpecifier.text === authoringModule;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !isNamedImports(bindings)) continue;
      const keep = bindings.elements.filter((e) => (library ? !LIBRARY_HOOKS.includes(e.name.text) : !isCustomName(e.name.text, stores)));
      if (keep.length === bindings.elements.length) continue;
      if (keep.length === 0 && !statement.importClause?.name)
        edits.push({ start: statement.getFullStart(), end: statement.getEnd(), text: "" });
      // Each kept name as it was written: `type Child` stays a type import, `a as b` stays renamed.
      else edits.push({ start: bindings.getStart(sf), end: bindings.getEnd(), text: `{ ${keep.map((e) => e.getText(sf)).join(", ")} }` });
    }
  }
  return edits;
}

/** Words a hook's name cannot be shortened to (`useDefault` is not `default`). */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "await",
  "async",
  "of",
]);

/** The text that replaces a hook call, or null (with a diagnostic) when it cannot be expanded. */
function expandCall(
  files: HookFiles,
  statement: Statement,
  call: HookCall,
  hook: Hook,
  callSf: SourceFile,
  callFile: string,
  prefix: string,
  isFree: (name: string) => boolean,
  claimed: Set<string>,
  diagnostics: CompilerDiagnostic[]
): string | null {
  const at = spanOf(statement, callSf, callFile);
  const sf = files.get(hook.fileName, hook.text);
  const declaration = sf.statements.find((s): s is FunctionDeclaration => isFunctionDeclaration(s) && s.name?.text === hook.name);
  if (declaration === undefined || declaration.body === undefined) {
    diagnostics.push(error(DiagnosticCode.UnknownHook, `The hook '${hook.name}' has no body to inline.`, at));
    return null;
  }
  // What the hook declares at its top level, which is renamed so two calls (or the component's own names) cannot meet.
  const declared = new Set<string>();
  const params = declaration.parameters;
  // A parameter is a plain name, or `{ speed, range: r }` of plain names (each bound to that member of the argument).
  const destructured = new Map<number, { local: string; key: string }[]>();
  for (const [index, p] of params.entries()) {
    if (isIdentifier(p.name)) {
      declared.add(p.name.text);
      continue;
    }
    const entries: { local: string; key: string }[] = [];
    const ok =
      isObjectBindingPattern(p.name) &&
      p.name.elements.every((element) => {
        if (element.dotDotDotToken || element.initializer || !element.name || !isIdentifier(element.name)) return false;
        const key =
          element.propertyName === undefined ? element.name.text : isIdentifier(element.propertyName) ? element.propertyName.text : null;
        if (key === null) return false;
        entries.push({ local: element.name.text, key });
        return true;
      });
    if (!ok) {
      diagnostics.push(
        error(
          DiagnosticCode.UnsupportedSyntax,
          `The hook '${hook.name}': a parameter is a plain name or \`{ a, b: c }\` of plain names (no defaults, rests or nesting).`,
          spanOf(p, sf, hook.fileName)
        )
      );
      return null;
    }
    for (const entry of entries) declared.add(entry.local);
    destructured.set(index, entries);
  }
  const bodyStatements = declaration.body.statements;
  let returnStatement: Statement | null = null;
  const kept: Statement[] = [];
  for (let i = 0; i < bodyStatements.length; i++) {
    const s = bodyStatements[i] as Statement;
    if (isReturnStatement(s)) {
      if (i !== bodyStatements.length - 1) {
        diagnostics.push(
          error(
            DiagnosticCode.UnsupportedSyntax,
            `The hook '${hook.name}': a \`return\` must be the last statement of the hook.`,
            spanOf(s, sf, hook.fileName)
          )
        );
        return null;
      }
      returnStatement = s;
    } else kept.push(s);
  }
  for (const s of kept) if (isVariableStatement(s)) for (const d of s.declarationList.declarations) bindingNames(d.name, declared);
  // A literal argument is written into the hook where its parameter is used, so what needs a literal (a `useSound` path) gets
  // one. So is a name the calling file imports from a `.ts` module (`useStore(settings, settingsView)`): it is a module constant,
  // so writing it in place changes nothing, and the hook can call it and its methods as the component could. Any other argument
  // is bound to a constant.
  const literals = new Map<string, string>();
  {
    const given = call.call.arguments;
    const imported = relativeTsImportNames(callSf);
    for (let i = 0; i < params.length && i < given.length; i++) {
      const arg = given[i] as Node;
      const members = destructured.get(i);
      if (members !== undefined) {
        // `useMover({ speed: 2, range: SIZE })`: a member that is a literal or an import is written in place, as a plain argument is.
        if (isObjectLiteralExpression(arg)) {
          for (const property of arg.properties) {
            if (!isPropertyAssignment(property) || !isIdentifier(property.name)) continue;
            const entry = members.find((m) => m.key === (property.name as { text: string }).text);
            const value = property.initializer;
            const inPlace =
              (isIdentifier(value) && imported.has(value.text) && !declared.has(value.text)) ||
              isStringLiteral(value) ||
              value.kind === SyntaxKind.NumericLiteral ||
              value.kind === SyntaxKind.TrueKeyword ||
              value.kind === SyntaxKind.FalseKeyword;
            if (entry !== undefined && inPlace) literals.set(entry.local, callSf.text.slice(value.getStart(callSf), value.getEnd()));
          }
        }
        continue;
      }
      const importedName = isIdentifier(arg) && imported.has(arg.text) && !declared.has(arg.text);
      if (
        importedName ||
        isStringLiteral(arg) ||
        arg.kind === SyntaxKind.NumericLiteral ||
        arg.kind === SyntaxKind.TrueKeyword ||
        arg.kind === SyntaxKind.FalseKeyword
      ) {
        literals.set((params[i]!.name as { text: string }).text, callSf.text.slice(arg.getStart(callSf), arg.getEnd()));
      }
    }
  }
  // A name the hook returns as it is (`return s`, `return [squash, shake]`) takes the caller's name instead of a copy, so a hook
  // can hand back its own `useMutable`, and the caller reads and writes it as its own state.
  const aliases = new Map<string, string>();
  const returned = returnStatement !== null && isReturnStatement(returnStatement) ? returnStatement.expression : undefined;
  if (
    returned !== undefined &&
    call.binding.kind === "name" &&
    isIdentifier(returned) &&
    declared.has(returned.text) &&
    params.every((p) => !isIdentifier(p.name) || p.name.text !== returned.text) &&
    ![...destructured.values()].some((entries) => entries.some((e) => e.local === returned.text))
  ) {
    aliases.set(returned.text, call.binding.name);
  } else if (returned !== undefined && call.binding.kind === "array" && isArrayLiteralExpression(returned)) {
    const targets = (call.binding.node as unknown as { elements: readonly Node[] }).elements;
    returned.elements.forEach((value, i) => {
      const target = targets[i] as unknown as { name?: Node } | undefined;
      if (
        target?.name !== undefined &&
        isIdentifier(target.name) &&
        isIdentifier(value) &&
        declared.has(value.text) &&
        !params.some((p) => isIdentifier(p.name) && p.name.text === value.text) &&
        !aliases.has(value.text)
      ) {
        aliases.set(value.text, target.name.text);
      }
    });
  } else if (returned !== undefined && call.binding.kind === "object" && isObjectLiteralExpression(returned)) {
    const wanted = new Map<string, string>();
    for (const element of (call.binding.node as unknown as { elements: readonly { name: Node; propertyName?: Node }[] }).elements) {
      if (!isIdentifier(element.name)) continue;
      wanted.set(
        element.propertyName !== undefined ? (element.propertyName as unknown as { text: string }).text : element.name.text,
        element.name.text
      );
    }
    for (const property of returned.properties) {
      const key =
        isShorthandPropertyAssignment(property) || (isPropertyAssignment(property) && isIdentifier(property.name))
          ? (property.name as unknown as { text: string }).text
          : null;
      const value = isShorthandPropertyAssignment(property) ? property.name : isPropertyAssignment(property) ? property.initializer : null;
      const target = key === null ? undefined : wanted.get(key);
      if (
        target !== undefined &&
        value !== null &&
        isIdentifier(value) &&
        declared.has(value.text) &&
        !params.some((p) => isIdentifier(p.name) && p.name.text === value.text) &&
        !aliases.has(value.text)
      ) {
        aliases.set(value.text, target);
      }
    }
  }
  // A `useMutable` the hook keeps to itself is named after the hook (`useBody` → `body`, so its state is `Comp.body.x`, not `_useBody1_b.x`),
  // with a number after it where the name is taken. One the hook returns is named by the call (above).
  const mutableNames = new Map<string, string>();
  {
    const own = kept
      .flatMap((s) => (isVariableStatement(s) ? s.declarationList.declarations : []))
      .filter(
        (d) =>
          isIdentifier(d.name) &&
          d.initializer !== undefined &&
          isCallExpression(d.initializer) &&
          isIdentifier(d.initializer.expression) &&
          d.initializer.expression.text === "useMutable"
      );
    const stem = hook.name.slice(3, 4).toLowerCase() + hook.name.slice(4);
    if (own.length > 0 && stem !== "" && !RESERVED_NAMES.has(stem)) {
      for (const d of own) {
        const local = (d.name as { text: string }).text;
        if (aliases.has(local)) continue;
        const base = own.length === 1 ? stem : `${stem}_${local}`;
        let name = base;
        for (let n = 2; !isFree(name) || RESERVED_NAMES.has(name); n++) name = `${base}${n}`;
        claimed.add(name);
        mutableNames.set(local, name);
      }
    }
  }
  // A function the hook imports that the calling file has one of its own by that name (`textOf` from a `.ts` file): the hook's
  // calls go to the hook's, under `runtimeAlias` (see `importClashes`).
  const clashes = hook.fileName === callFile ? new Map<string, Clash>() : importClashes(sf, hook.name, callSf);
  const rename = (name: string): string => {
    const clash = clashes.get(name);
    if (clash !== undefined) return runtimeAlias(clash.imported);
    return aliases.get(name) ?? literals.get(name) ?? mutableNames.get(name) ?? `${prefix}${name}`;
  };
  const renamedNames = new Set([...declared, ...clashes.keys()]);

  const args = call.call.arguments;
  if (args.length > params.length) {
    diagnostics.push(
      error(
        DiagnosticCode.InvalidProps,
        `The hook '${hook.name}' takes ${params.length} argument${params.length === 1 ? "" : "s"}, but the call passes ${args.length}.`,
        at
      )
    );
    return null;
  }
  const lines: string[] = [`// ${hook.name}, inlined`];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const arg = args[i];
    const members = destructured.get(i);
    if (members !== undefined) {
      if (arg === undefined) {
        diagnostics.push(error(DiagnosticCode.InvalidProps, `The hook '${hook.name}' needs an argument for its parameter ${i + 1}.`, at));
        return null;
      }
      // An object literal's members are read where they are written; any other argument is bound once, then read member by member.
      const object = isObjectLiteralExpression(arg) ? null : `${prefix}$arg${i}`;
      if (object !== null) lines.push(`const ${object} = (${callSf.text.slice(arg.getStart(callSf), arg.getEnd())});`);
      for (const member of members) {
        if (literals.has(member.local)) continue;
        let value: string;
        if (object !== null) value = `${object}.${member.key}`;
        else {
          const property = (arg as unknown as { properties: readonly Node[] }).properties.find(
            (q) =>
              (isPropertyAssignment(q) && isIdentifier(q.name) && q.name.text === member.key) ||
              (isShorthandPropertyAssignment(q) && (q.name as unknown as { text: string }).text === member.key)
          );
          if (property === undefined) {
            diagnostics.push(
              error(
                DiagnosticCode.InvalidProps,
                `The hook '${hook.name}' reads '${member.key}', which the object passed to it does not have.`,
                at
              )
            );
            return null;
          }
          const valueNode = isPropertyAssignment(property) ? property.initializer : (property as unknown as { name: Node }).name;
          value = `(${callSf.text.slice(valueNode.getStart(callSf), valueNode.getEnd())})`;
        }
        lines.push(`const ${rename(member.local)} = ${value};`);
      }
      continue;
    }
    const valueText =
      arg !== undefined
        ? `(${callSf.text.slice(arg.getStart(callSf), arg.getEnd())})`
        : p.initializer
          ? renameIn(p.initializer, sf, hook.text, renamedNames, rename)
          : null;
    if (valueText === null) {
      diagnostics.push(
        error(DiagnosticCode.InvalidProps, `The hook '${hook.name}' needs an argument for '${(p.name as { text: string }).text}'.`, at)
      );
      return null;
    }
    if (!literals.has((p.name as { text: string }).text)) lines.push(`const ${rename((p.name as { text: string }).text)} = ${valueText};`);
  }
  for (const s of kept) lines.push(renameIn(s, sf, hook.text, renamedNames, rename));

  if (call.binding.kind !== "none") {
    const expr = returnStatement !== null && isReturnStatement(returnStatement) ? returnStatement.expression : undefined;
    if (expr === undefined) {
      diagnostics.push(error(DiagnosticCode.UnsupportedSyntax, `The hook '${hook.name}' returns nothing, but its result is used.`, at));
      return null;
    }
    const renamed = (n: Node): string => renameIn(n, sf, hook.text, renamedNames, rename);
    if (call.binding.kind === "name") {
      if (!(isIdentifier(expr) && aliases.get(expr.text) === call.binding.name))
        lines.push(`${call.binding.keyword} ${call.binding.name} = ${renamed(expr)};`);
    } else if (call.binding.kind === "object") {
      if (!isObjectLiteralExpression(expr)) {
        diagnostics.push(
          error(
            DiagnosticCode.UnsupportedSyntax,
            `The hook '${hook.name}' must return an object literal (\`return { a, b };\`) to be used as \`const { a, b } = ${hook.name}()\`.`,
            at
          )
        );
        return null;
      }
      const values = new Map<string, string>();
      for (const property of expr.properties) {
        if (isShorthandPropertyAssignment(property))
          values.set((property.name as unknown as { text: string }).text, renamed(property.name));
        else if (isPropertyAssignment(property) && isIdentifier(property.name))
          values.set(property.name.text, renamed(property.initializer));
        else {
          diagnostics.push(
            error(
              DiagnosticCode.UnsupportedSyntax,
              `The hook '${hook.name}': the returned object may only have \`name\` and \`name: value\` entries.`,
              spanOf(property, sf, hook.fileName)
            )
          );
          return null;
        }
      }
      for (const element of (
        call.binding.node as unknown as { elements: readonly { name: Node; propertyName?: Node; initializer?: Node }[] }
      ).elements) {
        const key =
          element.propertyName !== undefined
            ? (element.propertyName as unknown as { text: string }).text
            : (element.name as unknown as { text: string }).text;
        const value = values.get(key);
        if (value === (element.name as unknown as { text: string }).text) continue; // the hook's own name, renamed to this one
        if (value === undefined) {
          diagnostics.push(error(DiagnosticCode.UnsupportedSyntax, `The hook '${hook.name}' does not return '${key}'.`, at));
          return null;
        }
        lines.push(`${call.binding.keyword} ${(element.name as unknown as { text: string }).text} = ${value};`);
      }
    } else {
      if (!isArrayLiteralExpression(expr)) {
        diagnostics.push(
          error(
            DiagnosticCode.UnsupportedSyntax,
            `The hook '${hook.name}' must return an array literal (\`return [a, b];\`) to be used as \`const [a, b] = ${hook.name}()\`.`,
            at
          )
        );
        return null;
      }
      const elements = (call.binding.node as unknown as { elements: readonly Node[] }).elements;
      for (let i = 0; i < elements.length; i++) {
        const target = elements[i] as unknown as { name?: { text: string } };
        const value = expr.elements[i];
        if (target.name === undefined || value === undefined) continue;
        if (isIdentifier(value) && aliases.get(value.text) === target.name.text) continue; // renamed in place
        lines.push(`${call.binding.keyword} ${target.name.text} = ${renameIn(value, sf, hook.text, renamedNames, rename)};`);
      }
    }
  }
  return lines.join("\n  ");
}

/** Every name a binding declares (a plain name, or those inside a destructuring pattern). */
function bindingNames(name: Node, out: Set<string>): void {
  if (isIdentifier(name)) out.add(name.text);
  else if (isObjectBindingPattern(name) || isArrayBindingPattern(name)) {
    for (const element of name.elements) if (isBindingElement(element) && element.name !== undefined) bindingNames(element.name, out);
  }
}

/** The source of `node`, with each identifier in `names` that refers to a binding renamed: property names and attribute names are left alone. */
function renameIn(node: Node, sf: SourceFile, text: string, names: ReadonlySet<string>, rename: (name: string) => string): string {
  const base = node.getStart(sf);
  const edits: Edit[] = [];
  const walk = (n: Node, parent: Node | null): void => {
    if (isIdentifier(n) && names.has(n.text) && !isNotAReference(n, parent)) {
      if (parent !== null && isShorthandPropertyAssignment(parent))
        edits.push({ start: n.getStart(sf) - base, end: n.getEnd() - base, text: `${n.text}: ${rename(n.text)}` });
      else edits.push({ start: n.getStart(sf) - base, end: n.getEnd() - base, text: rename(n.text) });
    }
    n.forEachChild((child) => {
      walk(child, n);
      return undefined;
    });
  };
  walk(node, null);
  return applyEdits(text.slice(base, node.getEnd()), edits);
}

/** Is this identifier a name that only looks like the variable: `o.x`'s `x`, `{ x: 1 }`'s key, `<A x={…} />`'s attribute? */
function isNotAReference(id: Node, parent: Node | null): boolean {
  if (parent === null) return false;
  if (isPropertyAccessExpression(parent) && parent.name === id) return true;
  if (isPropertyAssignment(parent) && parent.name === id) return true;
  if (isJsxAttribute(parent) && parent.name === id) return true;
  if (isBindingElement(parent) && parent.propertyName === id) return true;
  return false;
}

/**
 * The names a hook's file imports from non-relative modules, by module. One the calling file has its own of (`clashes`) is
 * imported under `runtimeAlias` (`textOf as $runtime_textOf`), the name the inlined hook calls it by.
 */
function collectImports(files: HookFiles, hook: Hook, into: Map<string, Set<string>>, clashes: ReadonlyMap<string, Clash>): void {
  for (const statement of files.get(hook.fileName, hook.text).statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier) || /^\.\.?\//.test(statement.moduleSpecifier.text))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !isNamedImports(bindings)) continue;
    const set = into.get(statement.moduleSpecifier.text) ?? new Set<string>();
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const clash = clashes.get(element.name.text);
      set.add(clash === undefined ? element.name.text : `${clash.imported} as ${runtimeAlias(clash.imported)}`);
    }
    into.set(statement.moduleSpecifier.text, set);
  }
}

/** A name a hook imports from a non-relative module that the calling file binds to something else: what the hook imports it as. */
interface Clash {
  readonly module: string;
  readonly imported: string;
}

/**
 * The names the hook `hookName` (declared in `hookSf`) uses from its file's non-relative imports, where the calling file binds the
 * same name to something else: an import from another module (`import { textOf } from "./cards.ts"`) or its own top-level
 * declaration. Inlined as they are, the hook's calls would reach the caller's function.
 */
function importClashes(hookSf: SourceFile, hookName: string, callSf: SourceFile): Map<string, Clash> {
  const clashes = new Map<string, Clash>();
  const declaration = hookSf.statements.find((s): s is FunctionDeclaration => isFunctionDeclaration(s) && s.name?.text === hookName);
  if (declaration?.body === undefined) return clashes;
  const used = new Set(declaration.body.getText(hookSf).match(/[A-Za-z_$][\w$]*/g));
  // What each name means in the calling file: the module it is imported from, or "" for its own declaration.
  const bound = new Map<string, string>();
  for (const statement of callSf.statements) {
    if (isImportDeclaration(statement) && isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && isNamedImports(bindings))
        for (const element of bindings.elements) bound.set(element.name.text, statement.moduleSpecifier.text);
      if (statement.importClause?.name) bound.set(statement.importClause.name.text, statement.moduleSpecifier.text);
    } else if (isFunctionDeclaration(statement) && statement.name !== undefined) bound.set(statement.name.text, "");
    else if (isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) if (isIdentifier(d.name)) bound.set(d.name.text, "");
    }
  }
  for (const statement of hookSf.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier) || /^\.\.?\//.test(statement.moduleSpecifier.text))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const local = element.name.text;
      const there = bound.get(local);
      if (element.isTypeOnly || !used.has(local) || there === undefined || there === statement.moduleSpecifier.text) continue;
      clashes.set(local, { module: statement.moduleSpecifier.text, imported: element.propertyName?.getText(hookSf) ?? local });
    }
  }
  return clashes;
}

/** Add to the file the imports its inlined hooks need and it lacks, on its first line (so no line moves). */
function importEdits(sf: SourceFile, needed: ReadonlyMap<string, ReadonlySet<string>>): Edit[] {
  if (needed.size === 0) return [];
  const have = new Set<string>();
  for (const statement of sf.statements) {
    if (!isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && isNamedImports(bindings)) for (const element of bindings.elements) have.add(element.name.text);
  }
  const lines: string[] = [];
  for (const [specifier, names] of needed) {
    // `textOf as $runtime_textOf` is had when its alias is.
    const missing = [...names].filter((n) => !have.has(n.split(" as ").at(-1)!));
    if (missing.length > 0) lines.push(`import { ${missing.join(", ")} } from ${JSON.stringify(specifier)};`);
  }
  return lines.length === 0 ? [] : [{ start: 0, end: 0, text: `${lines.join(" ")} ` }];
}
