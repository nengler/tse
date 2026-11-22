import { ModifierFlags, NodeFlags, type Node, type SourceFile } from "typescript/ast";
import {
  isArrowFunction,
  isExportAssignment,
  isFunctionDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isTypeAliasDeclaration,
  isStringLiteral,
  isVariableStatement,
} from "typescript/ast/is";

import { DiagnosticCode, error, type CompilerDiagnostic } from "../diagnostics/diagnostics.ts";
import { spanOf } from "../parser/parser.ts";
import { analyzeNamedImport, analyzeComponent } from "./component.ts";
import {
  type SourceAnalysis,
  type ImportAnalysis,
  type TypeDeclarationAnalysis,
  type ComponentAnalysis,
  type ModuleDeclarationAnalysis,
} from "./model.ts";
import { HOOK_NAME } from "./model.ts";
import { RELATIVE_TS, relativeTsImportNames, unwrapParens, visit } from "./util.ts";

/**
 * @param fileName Name used in spans and diagnostics. Defaults to the parsed
 * file's (absolute, normalised) name.
 * @param authoringModule The module hooks, built-ins and runtime functions are
 * imported from (the runtime manifest's `authoringModule`). Without it, only
 * component imports are accepted.
 */
export function analyzeSourceFile(
  sourceFile: SourceFile,
  fileName: string = sourceFile.fileName,
  authoringModule: string | null = null
): SourceAnalysis {
  const diagnostics: CompilerDiagnostic[] = [];
  const components: ComponentAnalysis[] = [];
  const imports: ImportAnalysis[] = [];
  const authoringImports: ImportAnalysis[] = [];
  const relativeImports: ImportAnalysis[] = [];
  const typeDeclarations: TypeDeclarationAnalysis[] = [];
  const moduleDeclarations: ModuleDeclarationAnalysis[] = [];
  /**
   * A constant or helper function at the top of the file: plain TypeScript, copied into the generated module. It may read
   * imports from `.ts` files and other constants, but not JSX or the game state (that belongs in a component).
   */
  const moduleDeclaration = (name: string, node: Node): void => {
    const reads = new Set<string>();
    let ok = true;
    visit(node, (n) => {
      if (isJsxElement(n) || isJsxSelfClosingElement(n) || isJsxFragment(n)) {
        if (ok)
          diagnostics.push(
            error(
              DiagnosticCode.UnsupportedSyntax,
              `'${name}' holds JSX: JSX belongs in a component (\`function ${name.charAt(0).toUpperCase() + name.slice(1)}() { return <…/>; }\`).`,
              span(n)
            )
          );
        ok = false;
      } else if (isIdentifier(n)) {
        if (storeNames.has(n.text)) {
          if (ok)
            diagnostics.push(
              error(
                DiagnosticCode.UnsupportedSyntax,
                `'${name}' reads the game state ('${n.text}'): read it in a component with a selector.`,
                span(n)
              )
            );
          ok = false;
        }
        reads.add(n.text);
      }
    });
    if (ok) moduleDeclarations.push({ name, node, text: node.getText(sourceFile), reads: [...reads] });
  };
  const defaultExports: { name: string; node: Node }[] = [];
  const span = (node: Node) => spanOf(node, sourceFile, fileName);

  // The names a relative `.ts` import binds, known before any component is read (imports may follow the components in source).
  const storeNames = new Set([...relativeTsImportNames(sourceFile)].filter((name) => HOOK_NAME.test(name)));
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      // Two kinds of import are understood: components from relative `.tsx` files, and hooks, built-ins and
      // runtime functions from the authoring module. Anything else would be silently dropped, so it is an error.
      const specifier = isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
      if (specifier !== null && /^\.\.?\/.*\.tsx$/.test(specifier)) {
        analyzeNamedImport(
          statement,
          specifier,
          imports,
          diagnostics,
          span,
          "Component imports",
          `import { Name } from "${specifier}"`,
          true
        );
      } else if (specifier !== null && RELATIVE_TS.test(specifier)) {
        analyzeNamedImport(
          statement,
          specifier,
          relativeImports,
          diagnostics,
          span,
          "Imports from a .ts file",
          `import { useGame } from "${specifier}"`,
          false,
          true
        );
      } else if (specifier !== null && specifier === authoringModule) {
        analyzeNamedImport(
          statement,
          specifier,
          authoringImports,
          diagnostics,
          span,
          "Imports from the authoring module",
          `import { useMutable, Entity, type Child } from "${specifier}"`,
          false,
          true,
          // A runtime function may be renamed (`textOf as runtimeText`); the transform says so for anything else.
          true
        );
      } else {
        diagnostics.push(
          error(
            DiagnosticCode.UnsupportedSyntax,
            `Import of ${specifier === null ? "this module" : `"${specifier}"`} is not supported: component source imports components from "./Name.tsx", the game state from "./GameState.ts"${authoringModule ? ` and hooks and built-in elements from "${authoringModule}"` : ""}.`,
            span(statement)
          )
        );
      }
      continue;
    }
    if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
      if (statement.typeParameters && statement.typeParameters.length > 0) {
        diagnostics.push(
          error(DiagnosticCode.UnsupportedSyntax, `Type '${statement.name.text}': generic props types are not supported.`, span(statement))
        );
        continue;
      }
      typeDeclarations.push({ name: statement.name.text, node: statement, text: statement.getText(sourceFile).replace(/^export\s+/, "") });
      continue;
    }
    if (isFunctionDeclaration(statement) && statement.name && /^[A-Z]/.test(statement.name.text)) {
      if (statement.typeParameters && statement.typeParameters.length > 0) {
        diagnostics.push(
          error(
            DiagnosticCode.UnsupportedSyntax,
            `Component '${statement.name.text}' has type parameters: generic components are not supported (a component compiles to one class, whose props have one type). Give the props a concrete type, a union of the kinds it takes, or \`unknown\` with a plain .ts function that reads it.`,
            span(statement.typeParameters[0]!)
          )
        );
        continue;
      }
      const isDefault = (statement.modifierFlags & ModifierFlags.Default) !== 0;
      const component = analyzeComponent(
        {
          name: statement.name.text,
          node: statement,
          parameters: statement.parameters,
          body: statement.body,
          exported: (statement.modifierFlags & ModifierFlags.Export) !== 0,
          isDefault,
        },
        span,
        diagnostics,
        storeNames
      );
      if (component) components.push(component);
      continue;
    }
    if (isFunctionDeclaration(statement) && statement.name && (statement.modifierFlags & ModifierFlags.Default) === 0 && statement.body) {
      moduleDeclaration(statement.name.text, statement);
      continue;
    }
    if (isFunctionDeclaration(statement) && (statement.modifierFlags & ModifierFlags.Default) !== 0) {
      diagnostics.push(
        error(
          DiagnosticCode.UnsupportedSyntax,
          "A default-exported component needs a capitalised name: `export default function Enemy() {}`.",
          span(statement)
        )
      );
      continue;
    }
    // `const Enemy = ({ speed }: EnemyProps) => { … }` (optionally exported): an arrow-function component.
    if (isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
      const declaration = statement.declarationList.declarations[0]!;
      const arrow = declaration.initializer ? unwrapParens(declaration.initializer) : undefined;
      if (isIdentifier(declaration.name) && /^[A-Z]/.test(declaration.name.text) && arrow && isArrowFunction(arrow)) {
        if ((statement.declarationList.flags & NodeFlags.Const) === 0) {
          diagnostics.push(
            error(
              DiagnosticCode.UnsupportedSyntax,
              `Component '${declaration.name.text}' must be declared with \`const\`.`,
              span(statement)
            )
          );
          continue;
        }
        if (arrow.typeParameters && arrow.typeParameters.length > 0) {
          diagnostics.push(
            error(
              DiagnosticCode.UnsupportedSyntax,
              `Component '${declaration.name.text}' has type parameters: generic components are not supported (a component compiles to one class, whose props have one type). Give the props a concrete type, a union of the kinds it takes, or \`unknown\` with a plain .ts function that reads it.`,
              span(arrow.typeParameters[0]!)
            )
          );
          continue;
        }
        const component = analyzeComponent(
          {
            name: declaration.name.text,
            node: declaration,
            parameters: arrow.parameters,
            body: arrow.body,
            exported: (statement.modifierFlags & ModifierFlags.Export) !== 0,
            isDefault: false,
          },
          span,
          diagnostics,
          storeNames
        );
        if (component) components.push(component);
        continue;
      }
    }
    // `const COLORS = { … };`: a constant the components read, as a React file would hold one beside its components.
    if (
      isVariableStatement(statement) &&
      statement.declarationList.declarations.length === 1 &&
      isIdentifier(statement.declarationList.declarations[0]!.name)
    ) {
      const declaration = statement.declarationList.declarations[0]!;
      const name = (declaration.name as { text: string }).text;
      if ((statement.declarationList.flags & NodeFlags.Const) === 0) {
        diagnostics.push(
          error(
            DiagnosticCode.UnsupportedSyntax,
            `'${name}': a top-level value must be a \`const\` (state that changes belongs in \`useMutable\` or the game state).`,
            span(statement)
          )
        );
        continue;
      }
      if (declaration.initializer) {
        moduleDeclaration(name, statement);
        continue;
      }
    }
    // `export default Enemy;` makes an already-declared component the module's default export.
    if (isExportAssignment(statement) && !statement.isExportEquals) {
      const target = unwrapParens(statement.expression);
      if (isIdentifier(target)) {
        defaultExports.push({ name: target.text, node: statement });
        continue;
      }
    }
    diagnostics.push(
      error(
        DiagnosticCode.UnsupportedSyntax,
        "Only imports, `interface` / `type` declarations, components (`function Name() {}` or `const Name = () => {}`, capitalised), constants (`const SPEED = 4;`), helper functions and `export default Name;` are supported at the top level.",
        span(statement)
      )
    );
  }

  // A props type written in a component's parameter is declared as an interface of its own, named for the component, unless the
  // file declares that name already (then it says so).
  for (const component of components) {
    const inline = component.props?.inline;
    if (inline === undefined) continue;
    const name = component.props!.typeName;
    if (typeDeclarations.some((t) => t.name === name)) {
      diagnostics.push(
        error(
          DiagnosticCode.InvalidProps,
          `Component '${component.name}': its props type is written in its parameter, and this file also declares '${name}'. Use one: \`({ … }: ${name})\`, or rename the interface.`,
          span(inline)
        )
      );
      continue;
    }
    typeDeclarations.push({ name, node: inline, text: `interface ${name} ${inline.getText(sourceFile)}` });
  }
  // Resolve `export default Enemy;` against the components declared in this file.
  let resolved = components;
  for (const { name, node } of defaultExports) {
    const index = resolved.findIndex((c) => c.name === name);
    if (index === -1) {
      diagnostics.push(
        error(DiagnosticCode.UnsupportedSyntax, `\`export default ${name};\` must name a component declared in this file.`, span(node))
      );
    } else if (resolved.some((c) => c.isDefault)) {
      diagnostics.push(error(DiagnosticCode.UnsupportedSyntax, "A module has one default export.", span(node)));
    } else {
      resolved = resolved.map((c, i) => (i === index ? { ...c, isDefault: true } : c));
    }
  }

  // From a relative .ts file come the game state (a name that looks like a hook, `useGame`) and plain functions, which components may call.
  const typeImports = relativeImports.filter((i) => i.isTypeOnly);
  const storeImports = relativeImports.filter((i) => !i.isTypeOnly && HOOK_NAME.test(i.name));
  const plainImports = relativeImports.filter((i) => !i.isTypeOnly && !HOOK_NAME.test(i.name));
  return {
    fileName,
    sourceFile,
    components: resolved,
    imports,
    authoringImports,
    storeImports,
    plainImports,
    typeImports,
    typeDeclarations,
    moduleDeclarations,
    diagnostics,
  };
}

export * from "./model.ts";
export * from "./util.ts";
export * from "./matchers.ts";
export * from "./component.ts";
