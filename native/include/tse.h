#ifndef TSE_H
#define TSE_H
/*
 * The boundary between the TypeScript player and the native library. This header is the single
 * source of truth: packages/player/src/protocol.ts mirrors it, and a test fails if they differ.
 * Change this file first, bump TSE_ABI_VERSION, then update protocol.ts. See docs/PLAYER.md.
 */
#include <stdint.h>

#define TSE_ABI_VERSION 16

/* ---------- Draw records ----------
 * A frame is a flat array of doubles: records back to back, each starting with its op.
 * Every drawable record then has a common header: x, y, rotation (radians), scaleX, scaleY
 * (the element's resolved world transform), followed by its payload.
 * The C side draws each drawable at the local origin under translate(x, y), rotate, scale(sx, sy).
 * Colours are packed 0xRRGGBBAA stored in a double (exact).
 *
 *   TSE_OP_VIEW     op, a, b, c, d, e, f         world -> screen affine, already including the
 *                                                viewport-centre offset. It applies to the drawables after it,
 *                                                and a later VIEW record replaces it (it does not compose with it):
 *                                                the HUD is drawn through a second view that ignores the camera.
 *                                                Drawables before the first VIEW are drawn in target pixels.
 *   TSE_OP_SPRITE   op, x, y, rot, sx, sy, texture
 *   TSE_OP_RECT     op, x, y, rot, sx, sy, width, height, color
 *   TSE_OP_ELLIPSE  op, x, y, rot, sx, sy, width, height, color   (fills the width x height box)
 *   TSE_OP_TEXT     op, x, y, rot, sx, sy, textIndex, size, color
 *   TSE_OP_SCISSOR  op, x, y, width, height      clip what follows to this rectangle, in target pixels (the window's
 *                                                logical pixels, or the canvas when there is one), top-left origin,
 *                                                ignoring the view.
 *                                                A later SCISSOR replaces it; they do not nest.
 *   TSE_OP_SCISSOR_END  op                       stop clipping
 *   TSE_OP_SPRITE_REGION  op, x, y, rot, sx, sy, texture, srcX, srcY, srcW, srcH, originX, originY, flags, tint
 *                                                one srcW x srcH region of a texture (a frame of a sheet), drawn with
 *                                                its origin (originX, originY, in region pixels) at the record's local
 *                                                origin; flags: TSE_SPRITE_FLIP_X, TSE_SPRITE_FLIP_Y, mirroring the
 *                                                region about the origin; tint is packed 0xRRGGBBAA, which multiplies
 *                                                the texel colours (alpha included, so it is also opacity).
 *                                                With TSE_SPRITE_SILHOUETTE (since ABI v13) the texels' colours are
 *                                                taken as white, keeping their alpha: the region's shape filled with
 *                                                the tint. Drawn over the same region with the tint's alpha at f, it
 *                                                mixes the opaque pixels a fraction f toward the tint (a hit flash).
 *   TSE_OP_BOX      op, x, y, rot, sx, sy, width, height, fill, borderColor, borderWidth, radius
 *                                                A width x height box at the local origin: filled with `fill`, then an
 *                                                outline of `borderWidth` drawn inside its edge in `borderColor`, with
 *                                                corners rounded by `radius` pixels (clamped to half the shorter side).
 *                                                A fill or border colour with alpha 0, or a borderWidth <= 0, draws
 *                                                nothing for that part; a radius <= 0 is square.
 *   TSE_OP_CANVAS   op, width, height, destX, destY, destW, destH, borderColor
 *                                                Only as the first record of a frame. Everything after it is drawn
 *                                                into an off-screen width x height texture (point filtered, cleared to
 *                                                the frame's clear colour); the window is cleared to borderColor and
 *                                                the texture is copied into the dest rectangle, right way up.
 *   TSE_OP_LIGHT    op, x, y, rot, sx, sy, radius, color
 *                                                A light: a disc of `radius` at the local origin, `color` (its alpha the
 *                                                strength) at the middle, falling off smoothly to black at the edge
 *                                                ((1 - d)^2 of the way out). Its colours are premultiplied by the
 *                                                strength and its alpha is opaque, so it is meant for a layer whose
 *                                                childBlend is TSE_BLEND_ADD (a light map): there, black adds nothing.
 *   TSE_OP_LAYER_BEGIN  op, clearColor, childBlend
 *                                                Draw what follows into an off-screen layer the size of the current
 *                                                target (the canvas, the window, or the layer it is in), cleared to
 *                                                clearColor, each drawable blended with childBlend (an TSE_BLEND_*)
 *                                                onto what the layer holds. The view and any scissor carry on, in the
 *                                                same pixels. Layers nest, TSE_LAYER_MAX deep; a deeper one is an error
 *                                                that stops the frame.
 *   TSE_OP_LAYER_END    op, blend, tint, shader, time, p0, p1, p2, p3, p4, p5, p6, p7
 *                                                Stop drawing into the innermost layer and lay it over the target it is
 *                                                in, covering it exactly, blended with `blend` (an TSE_BLEND_*) and its
 *                                                colours multiplied by tint (packed 0xRRGGBBAA, so its alpha is the
 *                                                layer's opacity). With `shader` a handle from tse_load_shader (-1 for
 *                                                none), each of its pixels goes through the shader, given `time` and the
 *                                                eight parameters (see tse_load_shader). Drawing then carries on in that
 *                                                target, with the blend mode it had. A layer still open when the frame
 *                                                ends is closed as if by an END with TSE_BLEND_NORMAL, white, no shader.
 *   TSE_OP_SPRITE_SHADED  op, x, y, rot, sx, sy, texture, srcX, srcY, srcW, srcH, originX, originY, flags, tint, shader, lookup,
 *                         p0, p1, p2, p3, p4, p5, p6, p7
 *                                                (since ABI v16) A TSE_OP_SPRITE_REGION whose pixels each go through `shader` (a
 *                                                handle from tse_load_shader), given the eight parameters, the region (`region`),
 *                                                how the image is turned on the target (`turn`) and the texture `lookup` (a
 *                                                handle from tse_load_texture, -1 for none: a white pixel). `time` is 0: a sprite's
 *                                                record changes only when the sprite does, so a shader that moves with time is
 *                                                given the time in a parameter. With no shader (-1, or one that did not load) it is
 *                                                drawn as the region record would be. TSE_SPRITE_SILHOUETTE is ignored.
 */
#define TSE_OP_VIEW     1
#define TSE_OP_SPRITE   2
#define TSE_OP_RECT     3
#define TSE_OP_ELLIPSE  4
#define TSE_OP_TEXT     5
#define TSE_OP_SCISSOR      6
#define TSE_OP_SCISSOR_END  7
#define TSE_OP_CANVAS       8
#define TSE_OP_SPRITE_REGION 9
#define TSE_OP_BOX          10
#define TSE_OP_LAYER_BEGIN  11
#define TSE_OP_LAYER_END    12
#define TSE_OP_LIGHT        13
#define TSE_OP_SPRITE_SHADED 14

/* Record lengths in doubles, op included. */
#define TSE_OP_VIEW_LEN    7
#define TSE_OP_SPRITE_LEN  7
#define TSE_OP_RECT_LEN    9
#define TSE_OP_ELLIPSE_LEN 9
#define TSE_OP_TEXT_LEN    9
#define TSE_OP_SCISSOR_LEN     5
#define TSE_OP_SCISSOR_END_LEN 1
#define TSE_OP_CANVAS_LEN      8
#define TSE_OP_SPRITE_REGION_LEN 15
#define TSE_OP_BOX_LEN     12
#define TSE_OP_LAYER_BEGIN_LEN 3
#define TSE_OP_LAYER_END_LEN   13
#define TSE_OP_LIGHT_LEN       8
#define TSE_OP_SPRITE_SHADED_LEN 25

/* Blend modes of TSE_OP_LAYER_BEGIN and TSE_OP_LAYER_END, as the source s (what is drawn, alpha a) meets the destination d:
 *   NORMAL    s * a + d * (1 - a)       painting over
 *   ADD       s * a + d                 light: overlapping lights brighten
 *   MULTIPLY  s * d + d * (1 - a)       shade: white leaves d as it is, black darkens it to black
 *   SCREEN    s + d * (1 - s)           a softer light that never passes white */
#define TSE_BLEND_NORMAL   0
#define TSE_BLEND_ADD      1
#define TSE_BLEND_MULTIPLY 2
#define TSE_BLEND_SCREEN   3

/* How deep TSE_OP_LAYER_BEGIN nests. */
#define TSE_LAYER_MAX 4

/* TSE_OP_SPRITE_REGION flags. */
#define TSE_SPRITE_FLIP_X 1
#define TSE_SPRITE_FLIP_Y 2
#define TSE_SPRITE_SILHOUETTE 4

/* ---------- Input, written by tse_frame ---------- */
#define TSE_IN_DT       0  /* seconds since the previous frame */
#define TSE_IN_WIDTH    1  /* window size in logical pixels */
#define TSE_IN_HEIGHT   2
#define TSE_IN_MOUSE_X  3  /* window coordinates, origin top-left */
#define TSE_IN_MOUSE_Y  4
#define TSE_IN_WHEEL    5
#define TSE_IN_QUIT     6  /* 1 when the window was asked to close */
#define TSE_IN_LEN      7

/* Per-key flags in the keys buffer (one byte per entry of TSE_KEYS, in order). */
#define TSE_KEY_DOWN     1
#define TSE_KEY_PRESSED  2
#define TSE_KEY_RELEASED 4

/* The key table: X(kind, raylib code, name). Kind K is a keyboard key, M a mouse button, G a button of the first
 * gamepad, S a direction (code 0 left, 1 right, 2 up, 3 down) that is down for the d-pad or the left stick beyond the
 * dead zone (see tse_set_gamepad_deadzone). A gamepad that is not connected reads as nothing held.
 * The order here is the order of the keys buffer. Append only.
 * "Shift", "Control" and "Alt" are down when either the left or the right key is. */
#define TSE_KEYS(X) \
  X(K, KEY_SPACE, "Space") X(K, KEY_ENTER, "Enter") X(K, KEY_ESCAPE, "Escape") X(K, KEY_TAB, "Tab") \
  X(K, KEY_BACKSPACE, "Backspace") X(K, KEY_LEFT_SHIFT, "Shift") X(K, KEY_LEFT_CONTROL, "Control") X(K, KEY_LEFT_ALT, "Alt") \
  X(K, KEY_UP, "ArrowUp") X(K, KEY_DOWN, "ArrowDown") X(K, KEY_LEFT, "ArrowLeft") X(K, KEY_RIGHT, "ArrowRight") \
  X(K, KEY_A, "A") X(K, KEY_B, "B") X(K, KEY_C, "C") X(K, KEY_D, "D") \
  X(K, KEY_E, "E") X(K, KEY_F, "F") X(K, KEY_G, "G") X(K, KEY_H, "H") \
  X(K, KEY_I, "I") X(K, KEY_J, "J") X(K, KEY_K, "K") X(K, KEY_L, "L") \
  X(K, KEY_M, "M") X(K, KEY_N, "N") X(K, KEY_O, "O") X(K, KEY_P, "P") \
  X(K, KEY_Q, "Q") X(K, KEY_R, "R") X(K, KEY_S, "S") X(K, KEY_T, "T") \
  X(K, KEY_U, "U") X(K, KEY_V, "V") X(K, KEY_W, "W") X(K, KEY_X, "X") \
  X(K, KEY_Y, "Y") X(K, KEY_Z, "Z") X(K, KEY_ZERO, "0") X(K, KEY_ONE, "1") \
  X(K, KEY_TWO, "2") X(K, KEY_THREE, "3") X(K, KEY_FOUR, "4") X(K, KEY_FIVE, "5") \
  X(K, KEY_SIX, "6") X(K, KEY_SEVEN, "7") X(K, KEY_EIGHT, "8") X(K, KEY_NINE, "9") \
  X(K, KEY_F1, "F1") X(K, KEY_F2, "F2") X(K, KEY_F3, "F3") X(K, KEY_F4, "F4") \
  X(K, KEY_F5, "F5") X(K, KEY_F6, "F6") X(K, KEY_F7, "F7") X(K, KEY_F8, "F8") \
  X(K, KEY_F9, "F9") X(K, KEY_F10, "F10") X(K, KEY_F11, "F11") X(K, KEY_F12, "F12") \
  X(M, MOUSE_BUTTON_LEFT, "MouseLeft") X(M, MOUSE_BUTTON_RIGHT, "MouseRight") X(M, MOUSE_BUTTON_MIDDLE, "MouseMiddle") \
  X(G, GAMEPAD_BUTTON_RIGHT_FACE_DOWN, "PadA") X(G, GAMEPAD_BUTTON_RIGHT_FACE_RIGHT, "PadB") \
  X(G, GAMEPAD_BUTTON_RIGHT_FACE_LEFT, "PadX") X(G, GAMEPAD_BUTTON_RIGHT_FACE_UP, "PadY") \
  X(G, GAMEPAD_BUTTON_LEFT_TRIGGER_1, "PadLB") X(G, GAMEPAD_BUTTON_RIGHT_TRIGGER_1, "PadRB") \
  X(G, GAMEPAD_BUTTON_MIDDLE_LEFT, "PadBack") X(G, GAMEPAD_BUTTON_MIDDLE_RIGHT, "PadStart") \
  X(S, 0, "PadLeft") X(S, 1, "PadRight") X(S, 2, "PadUp") X(S, 3, "PadDown")

/* ---------- Window options for tse_open ---------- */
#define TSE_OPEN_RESIZABLE 1
#define TSE_OPEN_VSYNC     2
#define TSE_OPEN_HIDDEN    4  /* no visible window and no audio device: tests and CI. Frames are captured for tse_read_pixels */
#define TSE_OPEN_SMOOTH    8  /* bilinear texture filtering; the default is nearest (pixel art) */
#define TSE_OPEN_SHARP    16  /* a canvas shown at a scale that is not a whole number is scaled up by the next whole number with nearest filtering, then down to size with bilinear: edges stay crisp and no pixel is uneven */
#define TSE_OPEN_HIGHDPI  32  /* (since ABI v14) draw at the display's own pixel density (a Retina screen, a scaled Windows desktop). Every
                               * size and position in the protocol stays in logical pixels (the window's size as tse_frame reports it,
                               * the mouse, views, scissors, the canvas's dest rectangle); libtse scales what it draws to the
                               * framebuffer, so shapes, text and a smooth canvas are sharp. Without it the system stretches a
                               * logical-size image, which blurs on such a display */

/* ---------- Functions ---------- */
int32_t tse_abi_version(void);
int32_t tse_key_count(void);
int32_t tse_open(int32_t width, int32_t height, const char *title, uint32_t options); /* 0 ok, nonzero error */
void    tse_close(void);
/* Full screen on (nonzero) or off (0), as a borderless window at the desktop's size, so the video mode never changes.
 * Returns 0, or nonzero when there is no window or it is hidden (tests, CI). The next tse_frame reports the new size. */
int32_t tse_set_fullscreen(int32_t on);

/* A texture from an image file, or a font built into libtse by its "tse:" name (since ABI v14; all but "tse:small" since v15): a
 * bitmap font sheet of the characters 32 to 127 in 16 columns and 6 rows of equal cells, white on transparent. "tse:small" is
 * 3x5 glyphs in 4x6 cells (64x36); the names and sheet sizes are TSE_BUILTIN_FONT_SHEETS in protocol.ts.
 * Returns a handle >= 0, or -1 if it could not be loaded (a missing file, or a "tse:" name that is not built in). */
int32_t tse_load_texture(const char *path);
/* A shader for TSE_OP_LAYER_END (since ABI v11) or TSE_OP_SPRITE_SHADED (since ABI v16), from a file holding one function, in GLSL:
 *
 *     vec4 effect(vec2 uv) { vec4 c = texture(image, uv); return vec4(c.rgb * (1.0 - 0.5 * length(pixel / resolution - 0.5)), c.a); }
 *
 * It is given `image` (the layer, a sampler2D; sample it at `uv`), `pixel` (where the pixel is, in target pixels from the top left),
 * `resolution` (the target's size in pixels), `time` (seconds, as the record gives it) and `params` (float[8], the record's
 * p0..p7), and returns the pixel's colour, which the tint then multiplies. Since ABI v16 it is also given `region` (a vec4: the
 * part of `image` drawn, x, y, width and height in its pixels; on a layer, all of it), `turn` (a mat2 taking a direction in the
 * image's pixels to the direction it is drawn in on the target, y down, with the record's rotation, the signs of its scale, its
 * flips and the view's rotation, and no stretch: its transpose takes a direction on the target back into the image; on a layer,
 * the identity) and `lookup` (a sampler2D, the record's lookup texture; on a layer, a white pixel). A file must not declare these
 * names itself. libtse wraps the function in the shader language of the
 * platform, so the same file can serve another one. Returns a handle >= 0; -1 when the file is missing or does not compile (the
 * compiler's message is logged); TSE_SHADER_UNSUPPORTED when this build cannot run shaders (the software renderer), and a layer with
 * that handle is laid over without one. */
int32_t tse_load_shader(const char *path);
#define TSE_SHADER_UNSUPPORTED (-2)
int32_t tse_load_sound(const char *path);   /* handle >= 0, or -1 */
void    tse_play_sound(int32_t handle);     /* ignores -1 */
/* Play a sound at `volume` (0 to 1, clamped) over any plays of it still going: up to TSE_SOUND_VOICES at once, then the
 * oldest is cut off. Ignores -1. */
void    tse_play_sound_ex(int32_t handle, double volume);
#define TSE_SOUND_VOICES 4

/* Music streams from the file and loops; one `handle` can play at a time per stream, and it keeps playing between
 * frames (tse_frame feeds the stream) until stopped. Without an audio device these load and play silently. */
int32_t tse_load_music(const char *path);                           /* handle >= 0, or -1 */
void    tse_music_play(int32_t handle, double volume, int32_t loop); /* from the start; loop nonzero repeats */
void    tse_music_set_volume(int32_t handle, double volume);        /* 0 to 1, takes effect at once */
void    tse_music_stop(int32_t handle);                             /* stops it; a later play starts again from the start */
/* The stick's dead zone for the PadLeft/Right/Up/Down keys: a stick pushed less than this far (0 to 1) reads as
 * centred. Default 0.35. */
void    tse_set_gamepad_deadzone(double deadzone);

/* Layout needs sizes. Both return 0 and write two doubles to `out`, or return nonzero (and write nothing) when
 * they cannot answer: no window is open, the handle is invalid, or an argument is NULL. */
int32_t tse_measure_text(const char *text, double size, double *out); /* out: width, line height, as TSE_OP_TEXT draws it */
int32_t tse_texture_size(int32_t handle, double *out);                /* out: width, height in pixels */

/* Draw one frame and present it, then poll devices and fill `input` (TSE_IN_LEN doubles) and
 * `keys` (tse_key_count() bytes). `text` holds `textCount` NUL-terminated UTF-8 strings back to
 * back; `textOffsets[i]` is the byte offset of string i, which TSE_OP_TEXT's textIndex refers to. */
void tse_frame(uint32_t clearColor,
               const double *records, int32_t recordsLength,
               const char *text, const int32_t *textOffsets, int32_t textCount,
               double *input, uint8_t *keys);

/* Text typed in the last tse_frame, for text fields: the characters the keyboard layout made (Unicode code points, with the
 * system's key repeat), not keys, and TSE_TYPED_BACKSPACE for each press or repeat of Backspace. Copies up to `capacity` of
 * them to `out` and returns how many there were (at most TSE_TYPED_MAX; more in one frame are dropped). Since ABI v9. */
int32_t tse_typed(uint32_t *out, int32_t capacity);
#define TSE_TYPED_BACKSPACE 8
#define TSE_TYPED_MAX 64

/* Collisions: which boxes overlap. `boxes` holds `count` boxes of four doubles each (minX, minY, maxX, maxY), all
 * finite, with maxX > minX and maxY > minY. Two boxes overlap when they share an area: boxes that only share an edge
 * or a corner do not. Each overlapping pair is found once and written to `pairs` as two box indices, in no promised
 * order except that the pairs of one first index come together; at most `capacity` pairs are written (`pairs` holds
 * 2 * capacity entries), and the return value is how many there are, which may be more: call again with more room.
 *
 * `order` is `count` entries the caller keeps from one call to the next: on return it is the box indices by minX
 * (ties by index), and a call that finds last frame's order there sorts it in about linear time. It may hold anything
 * on entry. Needs no window. With boxes that are not finite it still returns and writes only valid indices, but
 * which pairs it finds is not defined. */
int32_t tse_overlaps(const double *boxes, int32_t count, int32_t *order, int32_t *pairs, int32_t capacity);

/* Saved data: small named entries in the platform's user data folder, each written whole and atomically. Needs no window.
 *
 * The folder is $TSE_DATA_DIR if that is set (tests and CI), else $XDG_DATA_HOME/<game_id>, else ~/.local/share/<game_id>
 * (the macOS and Windows folders are written but unverified). `game_id` and every entry name are 1 to 64 of A-Z a-z 0-9 _ -,
 * so neither can become a path; anything else is refused. An entry is the file <name>.dat. A write goes to <name>.tmp, is
 * flushed to disk and renamed over the old file, so a crash leaves the old entry or the new one, never half of one. */
int32_t tse_storage_open(const char *game_id);                               /* 0 ok (makes the folder if it is missing), else nonzero; before any other storage call */
int32_t tse_storage_read(const char *name, uint8_t *out, int32_t capacity);  /* the bytes the entry holds, or -1 if there is none (or the call is refused); copies only when they fit in `capacity` */
int32_t tse_storage_write(const char *name, const uint8_t *data, int32_t length); /* 0 ok, nonzero if refused or it could not be written */
int32_t tse_storage_remove(const char *name);                                /* 0 ok, also when the entry did not exist */

/* Tests only: copy the last presented frame as RGBA8, top row first. Returns the bytes needed
 * (0 when there is no frame to read); copies only when capacity is enough. Frames are captured only
 * when the window was opened with TSE_OPEN_HIDDEN, so ordinary windows pay nothing for it. */
int32_t tse_read_pixels(uint8_t *rgba, int32_t capacity);

#endif
