// Syntax-tree helpers for the analyzer: unwrapping parentheses and visiting every node.
import { type Expression, type Node, type SourceFile } from "typescript/ast";
import { isImportDeclaration, isNamedImports, isParenthesizedExpression, isStringLiteral } from "typescript/ast/is";

/** A relative import of a plain `.ts` module (`./GameState.ts`, `../rules/battle.ts`). */
export const RELATIVE_TS = /^\.\.?\/.*\.ts$/;

/**
 * The name a runtime function goes by where the game already uses its own name for something else (`textOf` from a `.ts` file):
 * the generated module imports it as `textOf as $runtime_textOf`, and an inlined hook calls it by that name.
 */
export function runtimeAlias(name: string): string {
  return `$runtime_${name}`;
}

/**
 * The local names a file's named imports from relative `.ts` modules bind. The game state's store (`useGame`) is among them:
 * it looks like a hook and is not one, so it is known before any component body is read (imports may follow the components).
 */
export function relativeTsImportNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier) || !RELATIVE_TS.test(statement.moduleSpecifier.text))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text);
  }
  return names;
}

export function unwrapParens(expression: Expression): Expression {
  let current = expression;
  while (isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/** Pre-order walk. The callback's return value is ignored (forEachChild stops on truthy returns). */
export function visit(node: Node, callback: (node: Node) => void): void {
  callback(node);
  node.forEachChild((child) => {
    visit(child, callback);
    return undefined;
  });
}
