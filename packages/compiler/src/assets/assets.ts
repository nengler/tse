import { BUILTIN_FONTS, isBuiltinName } from "@tsengine/runtime";
import type { Expression } from "typescript/ast";
/**
 * Build-time check of asset paths: every image and sound a component names with a literal (`<Sprite image="a.png">`,
 * `useSound("jump.wav")`, `<AnimatedSprite frames sheet>`, `<Tilemap image>`, `<Flex backgroundImage>`, `<Text font>`) must be a file in the assets folder,
 * so a typo is a compile error with the nearest file name, not a magenta square or a silent sound at run time. Paths that are
 * computed (a prop passed in, a string built from state) cannot be checked, and are not.
 */
import {
  isAsExpression,
  isCallExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteral,
} from "typescript/ast/is";

import { visit } from "../analyzer/util.ts";
import { DiagnosticCode, error, type CompilerDiagnostic } from "../diagnostics/diagnostics.ts";
import type { ChildIR, ElementIR, ExprIR, HostElementIR, IRModule, PropIR, SourceSpan } from "../ir/types.ts";
import { spanOf, type TsxParser } from "../parser/parser.ts";
import { nearest } from "../transform/helpers.ts";

/** Props whose literal strings are asset names, by built-in. */
export const ASSET_PROPS: Readonly<Record<string, readonly string[]>> = {
  Sprite: ["image", "shader", "lookup"],
  AnimatedSprite: ["frames", "sheet", "shader", "lookup"],
  Tilemap: ["image"],
  Flex: ["backgroundImage", "hoverBackgroundImage", "focusBackgroundImage", "pressedBackgroundImage", "disabledBackgroundImage"],
  Text: ["font"],
  Game: ["font"],
  Music: ["src"],
  Layer: ["shader", "lookup"],
};

export interface AssetCheckOptions {
  /** Whether a file exists, by its name relative to the assets folder. */
  readonly exists: (name: string) => boolean;
  /** Every file name there is, for the "did you mean" (relative names, `/` separated). */
  readonly list: () => readonly string[];
  /** The assets folder, for the message. */
  readonly folder: string;
}

/** A reporter for a file name that is not in the assets folder: one message, with the nearest file name when there is one. */
function missingAssetReporter(
  options: AssetCheckOptions,
  diagnostics: CompilerDiagnostic[]
): (what: string, name: string, span: SourceSpan | null) => void {
  let files: readonly string[] | null = null;
  return (what, name, span) => {
    if (isBuiltinName(name)) {
      if ((BUILTIN_FONTS as readonly string[]).includes(name) && what === "font") return;
      diagnostics.push(
        error(
          DiagnosticCode.MissingAsset,
          what === "font"
            ? `There is no built-in font '${name}' (there is: ${BUILTIN_FONTS.join(", ")}).`
            : `'${name}' names a font built into the engine; a ${what} is a file in ${options.folder}/.`,
          span
        )
      );
      return;
    }
    if (options.exists(name)) return;
    files ??= options.list();
    const near = nearest(name, files);
    diagnostics.push(
      error(
        DiagnosticCode.MissingAsset,
        `The ${what} '${name}' is not in ${options.folder}/${near === null ? "" : ` (did you mean '${near}'?)`}.`,
        span
      )
    );
  };
}

/** One file of the game's source, by the name its diagnostics use. */
export interface SourceText {
  readonly fileName: string;
  readonly text: string;
}

/**
 * The sound files of every `createSounds({ … })` in `sources`, checked against the assets folder. A sound store is made in a
 * plain `.ts` module (`export const sfx = createSounds({ … })`), which the compiler does not otherwise read, so without this a
 * misspelt file is found only when it is first played, as silence. Each entry is a file name or `{ src: "file name" }`; a
 * name that is not written as a literal cannot be checked, and is not. Only a call written `createSounds(…)` is seen.
 */
export function checkSoundStores(parser: TsxParser, sources: readonly SourceText[], options: AssetCheckOptions): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const report = missingAssetReporter(options, diagnostics);
  for (const { fileName, text } of sources) {
    if (!text.includes("createSounds")) continue;
    const parsed = parser.parse(fileName, text);
    try {
      const sourceFile = parsed.sourceFile;
      const check = (expression: Expression): void => {
        const value = unwrapValue(expression);
        if (isStringLiteral(value) || isNoSubstitutionTemplateLiteral(value)) {
          if (value.text !== "") report("sound", value.text, spanOf(value, sourceFile, fileName));
        } else if (isObjectLiteralExpression(value)) {
          for (const member of value.properties)
            if (isPropertyAssignment(member) && propertyName(member.name) === "src") check(member.initializer);
        }
      };
      visit(sourceFile, (node) => {
        if (!isCallExpression(node) || !isIdentifier(node.expression) || node.expression.text !== "createSounds") return;
        const entries = node.arguments[0] === undefined ? undefined : unwrapValue(node.arguments[0]);
        if (entries === undefined || !isObjectLiteralExpression(entries)) return;
        for (const entry of entries.properties) if (isPropertyAssignment(entry)) check(entry.initializer);
      });
    } finally {
      parsed.dispose();
    }
  }
  return diagnostics;
}

function unwrapValue(expression: Expression): Expression {
  let current = expression;
  while (isParenthesizedExpression(current) || isAsExpression(current) || isSatisfiesExpression(current)) current = current.expression;
  return current;
}

/** The name a property is written with, when that is an identifier or a string. */
function propertyName(name: object): string | undefined {
  return "text" in name && typeof name.text === "string" ? name.text : undefined;
}

/**
 * The string literals an expression can evaluate to: itself, either branch of a `?:`, either side of `||` and `??`, the right of
 * `&&`, the elements of an array (a list of frames), through a memo. Not a literal that is only compared or passed along (`phase === "order" ? a : b`, `imageFor("cherry")`):
 * that is not a file name, and with derived values inlined it may come from a `const` the prop reads.
 */
function valueStrings(e: ExprIR): string[] {
  switch (e.kind) {
    case "StringLiteral":
      return e.value === "" ? [] : [e.value];
    case "Conditional":
      return [...valueStrings(e.whenTrue), ...valueStrings(e.whenFalse)];
    case "Binary":
      if (e.operator === "||" || e.operator === "??") return [...valueStrings(e.left), ...valueStrings(e.right)];
      return e.operator === "&&" ? valueStrings(e.right) : [];
    case "Memo":
      return valueStrings(e.value);
    case "NonNull":
      return valueStrings(e.expression);
    // `<AnimatedSprite frames={["a1.png", "a2.png"]}>`: each element is a name.
    case "ArrayLiteral":
      return e.elements.flatMap((element) => valueStrings(element.value));
    default:
      return [];
  }
}

export function checkAssets(modules: readonly IRModule[], options: AssetCheckOptions): CompilerDiagnostic[] {
  const diagnostics: CompilerDiagnostic[] = [];
  const report = missingAssetReporter(options, diagnostics);
  const props = (tag: string, list: readonly PropIR[], span: HostElementIR["span"]): void => {
    const names = ASSET_PROPS[tag];
    if (names === undefined) return;
    for (const prop of list) {
      if ((prop.kind !== "StaticProp" && prop.kind !== "DynamicProp") || !names.includes(prop.name)) continue;
      for (const name of valueStrings(prop.value))
        report(
          tag === "Text" || tag === "Game" ? "font" : tag === "Music" ? "music file" : prop.name === "shader" ? "shader" : "image",
          name,
          span
        );
    }
  };
  const child = (c: ChildIR): void => {
    if (c.kind === "StaticChild" || c.kind === "ConditionalChild" || c.kind === "KeyedListChild") element(c.element);
    if (c.kind === "KeyedListChild" && c.alternate) element(c.alternate);
  };
  const element = (e: ElementIR): void => {
    if (e.component.kind === "Intrinsic") props(e.component.name, e.props, e.span);
    e.children.forEach(child);
  };
  for (const module of modules) {
    for (const component of module.components) {
      for (const sound of component.sounds) report("sound", sound.path, sound.span);
      props(component.root.component.name, component.root.props, component.root.span);
      component.root.children.forEach(child);
    }
  }
  return diagnostics;
}
