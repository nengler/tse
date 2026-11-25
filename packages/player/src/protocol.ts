/**
 * The boundary between the player and a native library, mirroring
 * `native/include/tse.h`, which is the source of truth: change the header first.
 * `test/protocol.test.ts` parses the header and fails if anything here differs.
 */
import { KEY_NAMES, type KeyName } from "@tsengine/runtime";

import { BUILTIN_FONT_METRICS } from "./fonts.ts";

export const TSE_ABI_VERSION = 17;

// Draw records: a flat array of doubles, each record starting with its op.
export const TSE_OP_VIEW = 1;
export const TSE_OP_SPRITE = 2;
export const TSE_OP_RECT = 3;
export const TSE_OP_ELLIPSE = 4;
export const TSE_OP_TEXT = 5;
export const TSE_OP_SCISSOR = 6;
export const TSE_OP_SCISSOR_END = 7;
export const TSE_OP_CANVAS = 8;
export const TSE_OP_SPRITE_REGION = 9;
export const TSE_OP_BOX = 10;
export const TSE_OP_LAYER_BEGIN = 11;
export const TSE_OP_LAYER_END = 12;
export const TSE_OP_LIGHT = 13;
/** A sprite region drawn through a shader (ABI v16). */
export const TSE_OP_SPRITE_SHADED = 14;

// Record lengths in doubles, op included.
export const TSE_OP_VIEW_LEN = 7;
export const TSE_OP_SPRITE_LEN = 7;
export const TSE_OP_RECT_LEN = 9;
export const TSE_OP_ELLIPSE_LEN = 9;
export const TSE_OP_TEXT_LEN = 9;
export const TSE_OP_SCISSOR_LEN = 5;
export const TSE_OP_SCISSOR_END_LEN = 1;
export const TSE_OP_CANVAS_LEN = 8;
export const TSE_OP_SPRITE_REGION_LEN = 15;
export const TSE_OP_BOX_LEN = 12;
export const TSE_OP_LAYER_BEGIN_LEN = 3;
export const TSE_OP_LAYER_END_LEN = 38;
export const TSE_OP_LIGHT_LEN = 8;
export const TSE_OP_SPRITE_SHADED_LEN = 50;

/** What `tse_load_shader` gives in a build that cannot run shaders (the software renderer). Not in `PROTOCOL`: the header writes it in parentheses. */
export const TSE_SHADER_UNSUPPORTED = -2;

// Blend modes of a layer (ABI v10): how what is drawn meets what is under it.
export const TSE_BLEND_NORMAL = 0;
export const TSE_BLEND_ADD = 1;
export const TSE_BLEND_MULTIPLY = 2;
export const TSE_BLEND_SCREEN = 3;

/** How many numbers a shader is given as `params` (ABI v17; eight before): the last fields of a shaded record. */
export const TSE_SHADER_PARAMS = 32;

/** How deep layers nest. */
export const TSE_LAYER_MAX = 4;

/**
 * The sheet libtse makes for each built-in font name (since ABI v14; the fonts other than `tse:small` since v15): a bitmap font
 * sheet, 16 × 6 cells. Each font's advances are in fonts.ts, which tools/fonts/make-fonts.py writes with the sheets.
 */
export const TSE_BUILTIN_FONT_SHEETS: Readonly<Record<string, { readonly width: number; readonly height: number }>> = Object.fromEntries(
  Object.entries(BUILTIN_FONT_METRICS).map(([name, { width, height }]) => [name, { width, height }])
);

// Flags of a sprite region record.
export const TSE_SPRITE_FLIP_X = 1;
export const TSE_SPRITE_FLIP_Y = 2;
export const TSE_SPRITE_SILHOUETTE = 4;

/** Voices a sound can play on at once: the native side's `TSE_SOUND_VOICES`. */
export const TSE_SOUND_VOICES = 4;

// Input buffer, written by the backend's `frame`.
export const TSE_IN_DT = 0;
export const TSE_IN_WIDTH = 1;
export const TSE_IN_HEIGHT = 2;
export const TSE_IN_MOUSE_X = 3;
export const TSE_IN_MOUSE_Y = 4;
export const TSE_IN_WHEEL = 5;
export const TSE_IN_QUIT = 6;
export const TSE_IN_LEN = 7;

// Per-key flags in the keys buffer.
export const TSE_KEY_DOWN = 1;
export const TSE_KEY_PRESSED = 2;
export const TSE_KEY_RELEASED = 4;

/** In what `tse_typed` gives (ABI v9): a press or repeat of Backspace, among the characters typed. */
export const TSE_TYPED_BACKSPACE = 8;
/** The most characters `tse_typed` keeps from one frame. */
export const TSE_TYPED_MAX = 64;

// Window options for `open`.
export const TSE_OPEN_RESIZABLE = 1;
export const TSE_OPEN_VSYNC = 2;
export const TSE_OPEN_HIDDEN = 4;
export const TSE_OPEN_SMOOTH = 8;
export const TSE_OPEN_SHARP = 16;
/** Draw at the display's pixel density, every size staying in logical pixels (ABI v14). */
export const TSE_OPEN_HIGHDPI = 32;

/** Every numeric `#define TSE_*` in the header, by its name there. The parity test walks this. */
export const PROTOCOL = {
  TSE_ABI_VERSION,
  TSE_OP_VIEW,
  TSE_OP_SPRITE,
  TSE_OP_RECT,
  TSE_OP_ELLIPSE,
  TSE_OP_TEXT,
  TSE_OP_SCISSOR,
  TSE_OP_SCISSOR_END,
  TSE_OP_CANVAS,
  TSE_OP_SPRITE_REGION,
  TSE_OP_BOX,
  TSE_OP_LAYER_BEGIN,
  TSE_OP_LAYER_END,
  TSE_OP_LIGHT,
  TSE_OP_SPRITE_SHADED,
  TSE_OP_VIEW_LEN,
  TSE_OP_SPRITE_LEN,
  TSE_OP_RECT_LEN,
  TSE_OP_ELLIPSE_LEN,
  TSE_OP_TEXT_LEN,
  TSE_OP_SCISSOR_LEN,
  TSE_OP_SCISSOR_END_LEN,
  TSE_OP_CANVAS_LEN,
  TSE_OP_SPRITE_REGION_LEN,
  TSE_OP_BOX_LEN,
  TSE_OP_LAYER_BEGIN_LEN,
  TSE_OP_LAYER_END_LEN,
  TSE_OP_LIGHT_LEN,
  TSE_OP_SPRITE_SHADED_LEN,
  TSE_BLEND_NORMAL,
  TSE_BLEND_ADD,
  TSE_BLEND_MULTIPLY,
  TSE_BLEND_SCREEN,
  TSE_SHADER_PARAMS,
  TSE_LAYER_MAX,
  TSE_SPRITE_FLIP_X,
  TSE_SPRITE_FLIP_Y,
  TSE_SPRITE_SILHOUETTE,
  TSE_SOUND_VOICES,
  TSE_TYPED_BACKSPACE,
  TSE_TYPED_MAX,
  TSE_IN_DT,
  TSE_IN_WIDTH,
  TSE_IN_HEIGHT,
  TSE_IN_MOUSE_X,
  TSE_IN_MOUSE_Y,
  TSE_IN_WHEEL,
  TSE_IN_QUIT,
  TSE_IN_LEN,
  TSE_KEY_DOWN,
  TSE_KEY_PRESSED,
  TSE_KEY_RELEASED,
  TSE_OPEN_RESIZABLE,
  TSE_OPEN_VSYNC,
  TSE_OPEN_HIDDEN,
  TSE_OPEN_SMOOTH,
  TSE_OPEN_SHARP,
  TSE_OPEN_HIGHDPI,
} as const;

/**
 * Key names, in the order of the keys buffer (the header's `TSE_KEYS`, which is append only).
 * What `input.pressed("Space")` accepts. Mouse buttons are keys too. The list lives in the runtime as `KEY_NAMES`, so a
 * game's `createControls` can be typed against it (`KeyName`); a test keeps it equal to the header.
 */
export const KEYS: readonly KeyName[] = KEY_NAMES;

/** Index of each key name in the keys buffer. */
export const KEY_INDEX: ReadonlyMap<string, number> = new Map(KEYS.map((name, index) => [name, index]));
