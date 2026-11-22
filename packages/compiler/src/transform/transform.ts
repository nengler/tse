import { type RuntimeManifest } from "@tsengine/runtime";
import { type Node } from "typescript/ast";

import { AUTHORING_HOOKS, AUTHORING_TYPES, type SourceAnalysis } from "../analyzer/analyzer.ts";
import { REMOVED_HOOKS } from "../analyzer/model.ts";
import { DiagnosticCode, error, type CompilerDiagnostic } from "../diagnostics/diagnostics.ts";
import { type GameStateDefinition } from "../gamestate/schema.ts";
import { type TypeDeclarationIR, type ComponentIR, type IRModule, type SourceSpan } from "../ir/types.ts";
import { spanOf } from "../parser/parser.ts";
import { ElementLowering } from "./elements.ts";
import { GAME_TAG, TIMER_FUNCTIONS, WORLD_FUNCTIONS, SOUND_CLASS, type AuthoringImports, checkStaticCycles } from "./helpers.ts";
import { type ModuleContext } from "./lowering.ts";
import { type LoweringContext } from "./statements.ts";

export interface TransformOptions {
  /** What the runtime provides: intrinsic tags, the host class, reserved member names, handle types, functions. */
  readonly manifest: RuntimeManifest;
  /** The project's game state (`GameState.ts`): what a selector on the imported store may name. Absent: the project has none. */
  readonly gameState?: GameStateDefinition;
}

export interface TransformResult {
  readonly module: IRModule;
  readonly diagnostics: readonly CompilerDiagnostic[];
}

export function buildModuleIR(analysis: SourceAnalysis, options: TransformOptions): TransformResult {
  const diagnostics: CompilerDiagnostic[] = [];
  const sourceFile = analysis.sourceFile;
  const span = (node: Node): SourceSpan => spanOf(node, sourceFile, analysis.fileName);
  const manifest = options.manifest;
  // A component declared in or imported into this file shadows a built-in of the same name, as a name does in React, unless the file
  // also imports that built-in from the authoring module: so a game's own `Menu` or `Button` keeps working when the runtime adds one.
  const authoredHere = new Set(analysis.authoringImports.filter((i) => !i.isTypeOnly).map((i) => i.name));
  const intrinsics = new Set(manifest.intrinsics);
  // The host element and `<Game>` are never shadowed: the compiler gives those tags their own meaning wherever they are.
  const builtIn = (name: string): boolean =>
    intrinsics.has(name) && (authoredHere.has(name) || name === manifest.hostIntrinsic || name === GAME_TAG);

  const locals = new Set<string>();
  for (const c of analysis.components) {
    if (builtIn(c.name)) {
      diagnostics.push(
        error(
          DiagnosticCode.DuplicateComponent,
          `Component '${c.name}' conflicts with the built-in <${c.name}>${authoredHere.has(c.name) ? ` this file imports from "${manifest.authoringModule}": rename the component, or drop the import` : ", which is never shadowed: rename the component"}.`,
          span(c.declaration)
        )
      );
    } else if (c.name === SOUND_CLASS) {
      diagnostics.push(
        error(
          DiagnosticCode.DuplicateComponent,
          `Component '${c.name}' conflicts with the runtime's ${SOUND_CLASS} class, which generated code imports for useSound.`,
          span(c.declaration)
        )
      );
    } else if (locals.has(c.name)) {
      diagnostics.push(error(DiagnosticCode.DuplicateComponent, `Component '${c.name}' is declared more than once.`, span(c.declaration)));
    }
    locals.add(c.name);
  }
  const imported = new Map<string, { module: string; isDefault: boolean }>();
  for (const i of analysis.imports) {
    if (builtIn(i.name) || i.name === SOUND_CLASS || locals.has(i.name) || imported.has(i.name)) {
      diagnostics.push(
        error(
          DiagnosticCode.DuplicateComponent,
          `Imported component '${i.name}' conflicts with another component or a runtime intrinsic.`,
          span(i.node)
        )
      );
    } else {
      imported.set(i.name, { module: i.module, isDefault: i.isDefault });
    }
  }

  // Names imported from the authoring module must be ones the compiler understands.
  const authored = new Set([
    ...manifest.intrinsics,
    ...AUTHORING_HOOKS,
    ...Object.keys(manifest.functions),
    ...Object.keys(TIMER_FUNCTIONS),
    ...Object.keys(WORLD_FUNCTIONS),
  ]);
  const authoredTypes = new Set(AUTHORING_TYPES);
  for (const i of analysis.authoringImports) {
    if (i.importedName !== undefined && !i.isTypeOnly && manifest.functions[i.importedName] === undefined) {
      // Only a runtime function may be renamed: hooks and built-in elements are recognised by their own names.
      diagnostics.push(
        error(
          DiagnosticCode.UnsupportedSyntax,
          `Only a runtime function may be renamed when imported from "${manifest.authoringModule}" (\`textOf as runtimeText\`): import '${i.importedName}' as it is.`,
          span(i.node)
        )
      );
    } else if (i.isTypeOnly && !authoredTypes.has(i.name)) {
      diagnostics.push(
        error(
          DiagnosticCode.UnknownImport,
          `'${i.name}' is not a type exported by "${manifest.authoringModule}" (its types: ${AUTHORING_TYPES.join(", ")}): import it without \`type\`.`,
          span(i.node)
        )
      );
    } else if (!i.isTypeOnly && authoredTypes.has(i.name)) {
      diagnostics.push(
        error(
          DiagnosticCode.UnknownImport,
          `'${i.name}' is a type: write \`import { type ${i.name} } from "${manifest.authoringModule}"\`.`,
          span(i.node)
        )
      );
    } else if (!i.isTypeOnly && REMOVED_HOOKS[i.name] !== undefined) {
      // A hook that was replaced (`useState`, `useEffect`): where the file calls it, that call says what to write instead, once; an
      // import with no call says it here.
      const called = new RegExp(`\\b${i.name}\\s*[<(]`).test(analysis.sourceFile.text.slice(i.node.getEnd()));
      if (!called) diagnostics.push(error(DiagnosticCode.UnknownImport, REMOVED_HOOKS[i.name]!, span(i.node)));
    } else if (!i.isTypeOnly && !authored.has(i.importedName ?? i.name)) {
      diagnostics.push(
        error(
          DiagnosticCode.UnknownImport,
          `'${i.importedName ?? i.name}' is not exported by "${manifest.authoringModule}". It exports: ${[...authored].sort().join(", ")}.`,
          span(i.node)
        )
      );
    }
  }

  // Hooks, built-in elements and runtime functions must be imported, as in React. Each missing name is reported once per file.
  const authoring: AuthoringImports = {
    names: new Set(analysis.authoringImports.filter((i) => !i.isTypeOnly).map((i) => i.importedName ?? i.name)),
    aliases: new Map(
      analysis.authoringImports
        .filter((i) => !i.isTypeOnly && i.importedName !== undefined && manifest.functions[i.importedName] !== undefined)
        .map((i) => [i.name, i.importedName!] as const)
    ),
    reported: new Set(),
  };

  // Names imported from a relative `.ts` module must be the project's game state: nothing else from such a module is understood.
  const storeImports = new Set<string>();
  for (const i of analysis.storeImports) {
    if (options.gameState && i.name === options.gameState.name) storeImports.add(i.name);
    else {
      diagnostics.push(
        error(
          DiagnosticCode.InvalidGameState,
          options.gameState
            ? `'${i.name}' is not the game state: the only thing a component may import from "${i.module}" is \`${options.gameState.name}\`, declared by \`createGameState\` in GameState.ts.`
            : `This project has no game state to import \`${i.name}\` from: add GameState.ts next to the components, \`export const useGame = createGameState<State>()((set) => ({ coins: 0 }))\`.`,
          span(i.node)
        )
      );
    }
  }

  // A top-level constant or helper function is read like a plain import (it is in the generated module itself).
  const plainNames = new Set([...analysis.plainImports.map((i) => i.name), ...analysis.moduleDeclarations.map((d) => d.name)]);
  const moduleDeclarations = analysis.moduleDeclarations.map((d) => ({
    kind: "ModuleDeclaration" as const,
    name: d.name,
    text: d.text,
    reads: d.reads,
  }));
  const plainImports = analysis.plainImports.map((i) => ({
    name: i.name,
    module: i.module,
    ...(i.isNamespace === true ? { namespace: true as const } : {}),
  }));

  const typeDecls = new Map(analysis.typeDeclarations.map((t) => [t.name, t] as const));
  const typeDeclarations: TypeDeclarationIR[] = analysis.typeDeclarations.map((t) => ({
    kind: "TypeDeclaration",
    name: t.name,
    text: t.text,
  }));

  for (const name of [...locals, ...imported.keys()]) if (!builtIn(name)) intrinsics.delete(name);
  const context: ModuleContext = {
    sourceFile,
    fileName: analysis.fileName,
    manifest,
    intrinsics,
    locals,
    imported,
    authoring,
    typeDecls,
    diagnostics,
    analysisFailed: analysis.diagnostics.some((d) => d.severity === "error"),
    gameState: options.gameState,
    storeImports,
    plainImports: plainNames,
  };
  const components: ComponentIR[] = [];
  for (const c of analysis.components) {
    const lowered = new ComponentLowering(c, context).lower();
    if (lowered) components.push(lowered);
  }

  checkStaticCycles(components, diagnostics);

  return {
    module: {
      kind: "Module",
      sourceFile: analysis.fileName,
      typeDeclarations,
      components,
      plainImports,
      moduleDeclarations,
      ...(authoring.aliases.size > 0
        ? { runtimeAliases: [...authoring.aliases].map(([name, importedName]) => ({ name, importedName })) }
        : {}),
      typeImports: analysis.typeImports.map((i) => ({
        name: i.name,
        module: i.module,
        ...(i.importedName !== undefined ? { importedName: i.importedName } : {}),
      })),
    },
    diagnostics,
  };
}

/** The component lowering: each layer in its own file (lowering, expressions, hooks, elements), each extending the one before. */
class ComponentLowering extends ElementLowering implements LoweringContext {
  lower(): ComponentIR | null {
    const name = this.component.name;
    const props = this.lowerPropDecls();
    this.propDecls = props;
    const { hooks, state } = this.lowerHooks();
    const root = this.lowerRoot(this.component.jsx);
    if (this.declaredChildren && !this.slotSeen && !this.slotRejected) {
      this.report(
        DiagnosticCode.InvalidProps,
        "The props type declares `children`, but the component never renders `{children}`: put it where passed elements belong, or remove the prop.",
        this.component.declaration
      );
    }
    if (!root || this.errorCount > 0) return null;
    return {
      kind: "Component",
      name,
      span: this.span(this.component.declaration),
      hooks,
      state,
      sounds: this.sounds,
      functions: this.functions,
      props,
      propsType: this.component.props?.typeName ?? null,
      isDefaultExport: this.component.isDefault,
      isExported: this.component.exported || this.component.isDefault,
      acceptsChildren: this.declaredChildren,
      root,
    };
  }
}
