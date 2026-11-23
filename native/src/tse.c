#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "internal.h"
#include "raylib.h"
#include "rlgl.h"
#include "tse.h"

/* libtse: opens a window and executes the draw records described in include/tse.h. It does no
 * game logic and no maths beyond applying the transform each record carries. */

#define RAD_TO_DEG (180.0f / 3.14159265358979323846f)

static struct {
  bool open;
  bool hidden;       /* opened with TSE_OPEN_HIDDEN: frames are captured for tse_read_pixels */
  uint8_t *pixels;   /* the last captured frame, RGBA8, top row first */
  int32_t pixels_size;
  int32_t pixels_width;
  int32_t pixels_height;
  bool bad_frame_reported;
  RenderTexture2D canvas; /* the off-screen target of TSE_OP_CANVAS; id 0 when there is none */
  RenderTexture2D upscaled; /* TSE_OPEN_SHARP: the canvas scaled up by a whole number, before the bilinear step down to the window */
  RenderTexture2D layers[TSE_LAYER_MAX]; /* TSE_OP_LAYER_BEGIN's targets, one per depth, kept between frames and remade at a new size */
  bool sharp;
  bool highdpi;      /* opened with TSE_OPEN_HIGHDPI */
  uint32_t typed[TSE_TYPED_MAX]; /* what tse_frame collected for tse_typed */
  int32_t typed_count;
} state;

#define MAX_CANVAS 16384

/* Framebuffer pixels per logical pixel of the window: 1, or the display's scale with TSE_OPEN_HIGHDPI (2 on a Retina screen). raylib
 * then keeps the screen size in logical pixels and draws to the window through a matching scale; libtse does the same for its own
 * off-screen layers over the window, and for scissors inside them, so everything the protocol says stays in logical pixels. */
static float window_scale(void) {
  if (!state.highdpi) return 1.0f;
  int32_t screen = GetScreenWidth(), render = GetRenderWidth();
  if (screen <= 0 || render <= 0) return 1.0f;
  return (float)render / (float)screen;
}

/* A render target for 2D drawing: a colour texture and no depth. raylib 6.0's LoadRenderTexture fails on some drivers (Mesa 25.x's
 * llvmpipe and softpipe): its colour texture is uploaded with no pixels, which those drivers refuse (GL_INVALID_ENUM), and its depth
 * renderbuffer takes the unsized GL_DEPTH_COMPONENT format. The framebuffer is then incomplete and everything drawn through it is
 * black. Here the texture starts from zeroed pixels, and there is no depth: nothing libtse draws tests it. */
static RenderTexture2D load_target(int32_t width, int32_t height) {
#if defined(GRAPHICS_API_OPENGL_SOFTWARE)
  return LoadRenderTexture(width, height);
#else
  RenderTexture2D target = { 0 };
  void *zeros = calloc((size_t)width * (size_t)height, 4);
  if (zeros == NULL) return target;
  target.id = rlLoadFramebuffer();
  if (target.id == 0) {
    free(zeros);
    return target;
  }
  rlEnableFramebuffer(target.id);
  target.texture.id = rlLoadTexture(zeros, width, height, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8, 1);
  free(zeros);
  target.texture.width = width;
  target.texture.height = height;
  target.texture.format = PIXELFORMAT_UNCOMPRESSED_R8G8B8A8;
  target.texture.mipmaps = 1;
  rlFramebufferAttach(target.id, target.texture.id, RL_ATTACHMENT_COLOR_CHANNEL0, RL_ATTACHMENT_TEXTURE2D, 0);
  bool complete = rlFramebufferComplete(target.id);
  rlDisableFramebuffer();
  if (!complete) {
    rlUnloadTexture(target.texture.id);
    rlUnloadFramebuffer(target.id);
    return (RenderTexture2D){ 0 };
  }
  return target;
#endif
}

int32_t tse_abi_version(void) {
  return TSE_ABI_VERSION;
}

int32_t tse_key_count(void) {
  return keys_count();
}

int32_t tse_open(int32_t width, int32_t height, const char *title, uint32_t options) {
  if (state.open) return 2;
  if (width <= 0 || height <= 0) return 3;

  unsigned int flags = 0;
  if (options & TSE_OPEN_RESIZABLE) flags |= FLAG_WINDOW_RESIZABLE;
  if (options & TSE_OPEN_VSYNC) flags |= FLAG_VSYNC_HINT;
  if (options & TSE_OPEN_HIDDEN) flags |= FLAG_WINDOW_HIDDEN;
  if (options & TSE_OPEN_HIGHDPI) flags |= FLAG_WINDOW_HIGHDPI;
  SetConfigFlags(flags);
  SetTraceLogLevel(LOG_WARNING);

  InitWindow(width, height, title != NULL ? title : "");
  if (!IsWindowReady()) return 1;

  /* A flipped sprite has a negative scale, which reverses its triangles' winding: do not cull it. */
  rlDisableBackfaceCulling();
  SetExitKey(KEY_NULL); /* Escape belongs to the game, not to the window */
  /* Without vsync, cap at 60 fps; a hidden window (tests, CI) runs flat out. */
  if (!(options & TSE_OPEN_VSYNC) && !(options & TSE_OPEN_HIDDEN)) SetTargetFPS(60);

  /* A hidden window is for tests and CI: no audio device, so no noise from machines without a sound card. */
  assets_init((options & TSE_OPEN_SMOOTH) != 0, (options & TSE_OPEN_HIDDEN) == 0);
  state.open = true;
  state.hidden = (options & TSE_OPEN_HIDDEN) != 0;
  state.sharp = (options & TSE_OPEN_SHARP) != 0;
  state.highdpi = (options & TSE_OPEN_HIGHDPI) != 0;
  state.bad_frame_reported = false;
  return 0;
}

void tse_close(void) {
  if (!state.open) return;
  if (state.canvas.id != 0) UnloadRenderTexture(state.canvas);
  if (state.upscaled.id != 0) UnloadRenderTexture(state.upscaled);
  for (int32_t i = 0; i < TSE_LAYER_MAX; i++) {
    if (state.layers[i].id != 0) UnloadRenderTexture(state.layers[i]);
    state.layers[i] = (RenderTexture2D){ 0 };
  }
  assets_shutdown();
  CloseWindow();
  free(state.pixels);
  memset(&state, 0, sizeof(state));
}

int32_t tse_set_fullscreen(int32_t on) {
  if (!state.open || state.hidden) return 1;
  bool wanted = on != 0;
  if (IsWindowState(FLAG_BORDERLESS_WINDOWED_MODE) != wanted) ToggleBorderlessWindowed();
  return 0;
}

int32_t tse_measure_text(const char *text, double size, double *out) {
  if (!state.open || text == NULL || out == NULL || !(size >= 0.0 && size <= 100000.0)) return 1;
  /* The font and spacing TSE_OP_TEXT draws with. */
  Vector2 measured = MeasureTextEx(GetFontDefault(), text, (float)size, (float)size / 10.0f);
  out[0] = (double)measured.x;
  out[1] = (double)measured.y;
  return 0;
}

int32_t tse_texture_size(int32_t handle, double *out) {
  Texture2D texture;
  if (!state.open || out == NULL || !assets_texture(handle, &texture)) return 1;
  out[0] = (double)texture.width;
  out[1] = (double)texture.height;
  return 0;
}

/* A record field as an index or an op: -1 unless it is a whole number in range. Casting NaN or an out-of-range
 * double to an integer is undefined behaviour in C, so a malformed buffer must not reach a plain cast. */
static int32_t to_index(double value) {
  return value >= 0.0 && value <= 2147483647.0 ? (int32_t)value : -1;
}

/* A packed 0xRRGGBBAA colour; anything that is not one is magenta, as the TypeScript side uses for a bad colour. */
static uint32_t to_color(double value) {
  return value >= 0.0 && value <= 4294967295.0 ? (uint32_t)value : 0xff00ffffu;
}

static Color unpack_color(uint32_t rgba) {
  return (Color){ (unsigned char)(rgba >> 24), (unsigned char)(rgba >> 16), (unsigned char)(rgba >> 8), (unsigned char)rgba };
}

static void report_bad_frame(const char *why, int32_t at) {
  if (state.bad_frame_reported) return;
  state.bad_frame_reported = true;
  TraceLog(LOG_ERROR, "TSE: malformed draw records (%s at %d): the rest of the frame is not drawn", why, at);
}

/* translate, rotate, scale: the record's world transform, applied to a drawable at the local origin. */
static void push_transform(const double *r) {
  rlPushMatrix();
  rlTranslatef((float)r[1], (float)r[2], 0.0f);
  rlRotatef((float)r[3] * RAD_TO_DEG, 0.0f, 0.0f, 1.0f);
  rlScalef((float)r[4], (float)r[5], 1.0f);
}

/* What a frame draws into: the canvas (when the frame starts with TSE_OP_CANVAS) or the window, and the layers opened on top of it.
 * The view and the scissor are kept here too, because changing the target (BeginTextureMode, EndTextureMode) resets raylib's
 * matrices and its scissor: they are put back after every change. */
static struct {
  RenderTexture2D *base; /* the canvas, or NULL for the window */
  int32_t width, height; /* of the base in its own pixels (the window's framebuffer pixels): every layer is this size */
  float scale;           /* the base's pixels per unit the records use: window_scale() for the window, 1 for the canvas */
  int32_t depth;         /* layers open */
  int32_t child_blend[TSE_LAYER_MAX + 1]; /* the blend of drawables at each depth; [0] is the base's, always normal */
  bool view_pushed;
  float view[16];
  bool scissor_on;
  int scissor[4];
} target;

/* Clip to a rectangle in target pixels, top-left origin. raylib's BeginScissorMode flips y for OpenGL, whose scissor
 * origin is bottom-left; its software renderer takes the rectangle top-left already, so there it goes through unflipped. */
static void begin_scissor(int x, int y, int width, int height) {
#if defined(GRAPHICS_API_OPENGL_SOFTWARE)
  rlDrawRenderBatchActive();
  rlEnableScissorTest();
  rlScissor(x, y, width, height);
#else
  if (target.depth > 0 && target.scale != 1.0f) {
    /* A layer over a high-DPI window: raylib scales a scissor on the window, not on a texture. Here it is scaled to the layer's pixels
     * and flipped to OpenGL's bottom-left origin by hand. */
    float s = target.scale;
    rlDrawRenderBatchActive();
    rlEnableScissorTest();
    rlScissor((int)lroundf((float)x * s), (int)lroundf((float)target.height - (float)(y + height) * s), (int)lroundf((float)width * s),
              (int)lroundf((float)height * s));
    return;
  }
  BeginScissorMode(x, y, width, height);
#endif
}

/* A bad number (NaN, infinite) is nothing; a size is at least 0. */
static float finite_or_zero(float value) {
  return isfinite(value) ? value : 0.0f;
}

/* The segments for one rounded corner of `radius` pixels. raylib works the number out itself when given none, from how far a
 * chord may stray from the arc, and for a radius of a few pixels that is one segment: a 10 pixel circle is drawn as a diamond.
 * About a segment a pixel of radius, from 4 (a corner of 4 segments is already round at that size) to 24, keeps small shapes round. */
static int corner_segments(float radius) {
  int segments = (int)ceilf(radius);
  return segments < 4 ? 4 : segments > 24 ? 24 : segments;
}

/* TSE_OP_BOX at the local origin: the fill over the whole box, then the border inside its edge (as CSS paints a background
 * under its border). The border is built from exact pieces, so no pixel is painted twice (a translucent border stays even):
 * four edge rectangles between the corners, and in each corner block (c x c, c the larger of the radius and the border
 * width) a quarter ring when the radius covers the border, else the quarter disc of the outer corner and the rest of the block. */
static void draw_box(float width, float height, uint32_t fill, uint32_t border, float border_width, float radius) {
  width = finite_or_zero(width);
  height = finite_or_zero(height);
  if (!(width > 0.0f && height > 0.0f)) return;
  float half = (width < height ? width : height) / 2.0f;
  radius = finite_or_zero(radius);
  if (radius > half) radius = half;
  if (radius < 0.0f) radius = 0.0f;
  border_width = finite_or_zero(border_width);
  if (border_width > half) border_width = half;
  if (fill & 0xffu) {
    if (radius > 0.0f) DrawRectangleRounded((Rectangle){ 0.0f, 0.0f, width, height }, radius / half, corner_segments(radius), unpack_color(fill));
    else DrawRectangleRec((Rectangle){ 0.0f, 0.0f, width, height }, unpack_color(fill));
  }
  if (!((border & 0xffu) != 0 && border_width > 0.0f)) return;
  Color c = unpack_color(border);
  float bw = border_width, r = radius;
  float k = r > bw ? r : bw; /* the corner block */
  /* The edges, between the corner blocks. */
  float run_x = width - 2.0f * k, run_y = height - 2.0f * k;
  if (run_x > 0.0f) {
    DrawRectangleRec((Rectangle){ k, 0.0f, run_x, bw }, c);
    DrawRectangleRec((Rectangle){ k, height - bw, run_x, bw }, c);
  }
  if (run_y > 0.0f) {
    DrawRectangleRec((Rectangle){ 0.0f, k, bw, run_y }, c);
    DrawRectangleRec((Rectangle){ width - bw, k, bw, run_y }, c);
  }
  /* The corners: top left, top right, bottom right, bottom left. Angles run clockwise on screen from +x (y points down). */
  for (int corner = 0; corner < 4; corner++) {
    bool right = corner == 1 || corner == 2, bottom = corner == 2 || corner == 3;
    float block_x = right ? width - k : 0.0f, block_y = bottom ? height - k : 0.0f;
    if (r <= 0.0f) { /* square: the whole block is border */
      DrawRectangleRec((Rectangle){ block_x, block_y, k, k }, c);
      continue;
    }
    Vector2 center = { right ? width - r : r, bottom ? height - r : r };
    float from = 180.0f + 90.0f * (float)corner;
    if (r >= bw) {
      DrawRing(center, r - bw, r, from, from + 90.0f, corner_segments(r), c);
    } else {
      /* The radius is smaller than the border: the outer corner's quarter disc, and the rest of the block, which is all border. */
      DrawCircleSector(center, r, from, from + 90.0f, corner_segments(r), c);
      float rest = k - r;
      /* The strip of the block beside the disc's square, across its full height, then the strip above or below that square. */
      DrawRectangleRec((Rectangle){ right ? block_x : block_x + r, block_y, rest, k }, c);
      DrawRectangleRec((Rectangle){ right ? block_x + rest : block_x, bottom ? block_y : block_y + r, r, rest }, c);
    }
  }
}

#if defined(GRAPHICS_API_OPENGL_SOFTWARE)
/* raylib's rlSetBlendMode does nothing on its software renderer, whose blending is set with this (rlsw.h); the factors are GL's. */
extern void swBlendFunc(int sfactor, int dfactor);
#define SW_GL_ONE 1
#define SW_GL_SRC_ALPHA 0x0302
#define SW_GL_ONE_MINUS_SRC_ALPHA 0x0303
#define SW_GL_ONE_MINUS_SRC_COLOR 0x0301
#define SW_GL_DST_COLOR 0x0306
#define SW_GL_ZERO 0
#endif

/* How a drawable meets what is under it: an TSE_BLEND_* as raylib's blend state. `translucent` says that what is drawn next has
 * alpha below 1 in its colour (a layer laid over at an opacity); only the software renderer needs to know. */
static void set_blend(int32_t mode, bool translucent) {
#if defined(GRAPHICS_API_OPENGL_SOFTWARE)
  /* rlsw switches blending off for a primitive whose colour is opaque and whose texture has no alpha when the blend function reads
   * alpha, which is right for normal blending only: an opaque light added with (SRC_ALPHA, ONE) would replace what is under it.
   * So when nothing drawn is translucent, add and multiply use the factors that give the same result without reading alpha, and
   * rlsw keeps blending. A sprite with alpha drawn in an add layer is then added at full strength here, as it is not on the GPU. */
  rlDrawRenderBatchActive();
  switch (mode) {
    case TSE_BLEND_ADD: swBlendFunc(translucent ? SW_GL_SRC_ALPHA : SW_GL_ONE, SW_GL_ONE); break;
    case TSE_BLEND_MULTIPLY: swBlendFunc(SW_GL_DST_COLOR, translucent ? SW_GL_ONE_MINUS_SRC_ALPHA : SW_GL_ZERO); break;
    case TSE_BLEND_SCREEN: swBlendFunc(SW_GL_ONE, SW_GL_ONE_MINUS_SRC_COLOR); break;
    default: swBlendFunc(SW_GL_SRC_ALPHA, SW_GL_ONE_MINUS_SRC_ALPHA); break;
  }
  return;
#else
  (void)translucent;
#endif
  switch (mode) {
    case TSE_BLEND_ADD: BeginBlendMode(BLEND_ADDITIVE); break;
    case TSE_BLEND_MULTIPLY: BeginBlendMode(BLEND_MULTIPLIED); break;
    case TSE_BLEND_SCREEN:
      rlSetBlendFactors(RL_ONE, RL_ONE_MINUS_SRC_COLOR, RL_FUNC_ADD);
      BeginBlendMode(BLEND_CUSTOM);
      break;
    default: BeginBlendMode(BLEND_ALPHA); break;
  }
}

static int32_t blend_of(double value) {
  int32_t mode = to_index(value);
  return mode >= TSE_BLEND_NORMAL && mode <= TSE_BLEND_SCREEN ? mode : TSE_BLEND_NORMAL;
}


static void push_view(void) {
  rlPushMatrix();
  rlMultMatrixf(target.view);
}

/* Draw into the target at the current depth: the innermost layer, or the base. */
static void begin_current_target(void) {
  if (target.depth > 0) {
    BeginTextureMode(state.layers[target.depth - 1]);
    /* raylib scales what is drawn to the window itself (its screenScale), but a texture starts unscaled: a layer is the size of the
     * framebuffer, so draw into it through the same scale. */
    if (target.scale != 1.0f) rlScalef(target.scale, target.scale, 1.0f);
  } else if (target.base != NULL) BeginTextureMode(*target.base);
}

/* Leave the target at the current depth, keeping nothing of its view or scissor on raylib's side. */
static void end_current_target(void) {
  rlDrawRenderBatchActive();
  if (target.scissor_on) EndScissorMode();
  if (target.view_pushed) rlPopMatrix();
  if (target.depth > 0 || target.base != NULL) EndTextureMode();
}

/* Put the view, the scissor and the blend back after a change of target. */
static void restore_target_state(void) {
  if (target.view_pushed) push_view();
  if (target.scissor_on) begin_scissor(target.scissor[0], target.scissor[1], target.scissor[2], target.scissor[3]);
  set_blend(target.child_blend[target.depth], false);
}

static bool begin_layer(uint32_t clear, int32_t child_blend) {
  if (target.depth >= TSE_LAYER_MAX) return false;
  /* Leave the current target first: making or unloading a texture binds the window's framebuffer, which would send what is still
   * batched for the current target to the window instead. */
  end_current_target();
  RenderTexture2D *layer = &state.layers[target.depth];
  if (layer->id != 0 && (layer->texture.width != target.width || layer->texture.height != target.height)) {
    UnloadRenderTexture(*layer);
    *layer = (RenderTexture2D){ 0 };
  }
  if (layer->id == 0) {
    *layer = load_target(target.width, target.height);
    if (layer->id != 0) SetTextureFilter(layer->texture, TEXTURE_FILTER_POINT);
  }
  if (layer->id == 0) {
    begin_current_target();
    restore_target_state();
    return false;
  }
  target.depth++;
  target.child_blend[target.depth] = child_blend;
  begin_current_target();
  ClearBackground(unpack_color(clear));
  restore_target_state();
  return true;
}

/* Start drawing through a shader and give it its inputs: the target's size, `time`, the eight parameters (0 where missing or not
 * finite), the region of the image drawn, how the image is turned (the columns of a 2x2 matrix) and the lookup texture (a white
 * pixel when there is none). What is drawn next must be flushed before EndShaderMode, which binds the lookup texture with it. */
static void begin_shader(const TseShader *shader, float time, const double *params, const float region[4], const float turn[4],
                         int32_t lookup_handle) {
  BeginShaderMode(shader->shader);
  float resolution[2] = { (float)target.width / target.scale, (float)target.height / target.scale }; /* in logical pixels */
  float p[8];
  for (int i = 0; i < 8; i++) p[i] = params != NULL && isfinite(params[i]) ? (float)params[i] : 0.0f;
  if (shader->resolution >= 0) SetShaderValue(shader->shader, shader->resolution, resolution, SHADER_UNIFORM_VEC2);
  if (shader->time >= 0) SetShaderValue(shader->shader, shader->time, &time, SHADER_UNIFORM_FLOAT);
  if (shader->params >= 0) SetShaderValueV(shader->shader, shader->params, p, SHADER_UNIFORM_FLOAT, 8);
  if (shader->region >= 0) SetShaderValue(shader->shader, shader->region, region, SHADER_UNIFORM_VEC4);
  if (shader->turn >= 0) SetShaderValue(shader->shader, shader->turn, turn, SHADER_UNIFORM_VEC4);
  if (shader->lookup >= 0) {
    Texture2D lookup;
    if (!assets_texture(lookup_handle, &lookup)) lookup = (Texture2D){ rlGetTextureIdDefault(), 1, 1, 1, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8 };
    SetShaderValueTexture(shader->shader, shader->lookup, lookup);
  }
}

static const float IDENTITY_TURN[4] = { 1.0f, 0.0f, 0.0f, 1.0f };

static void end_layer(int32_t blend, uint32_t tint, int32_t shader_handle, float time, const double *params) {
  if (target.depth == 0) return;
  RenderTexture2D *layer = &state.layers[target.depth - 1];
  end_current_target();
  target.depth--;
  begin_current_target();
  /* Lay the layer over its target exactly, in target pixels: no view. Render textures are stored bottom row first, so the
   * source is flipped. The scissor still clips it. */
  if (target.scissor_on) begin_scissor(target.scissor[0], target.scissor[1], target.scissor[2], target.scissor[3]);
  set_blend(blend, (tint & 255u) < 255u);
  /* Screen's factors read no alpha, and multiply's source colour is not scaled by it: there the opacity goes on the colour as well
   * (premultiplied), so a translucent layer is that blend part way from what is below, not screen at full strength or a multiply
   * that brightens. Add and normal read the alpha in their factors, on both renderers. */
  Color tint_color = unpack_color(tint);
  if (blend == TSE_BLEND_SCREEN || blend == TSE_BLEND_MULTIPLY) {
    tint_color.r = (unsigned char)((tint_color.r * tint_color.a + 127) / 255);
    tint_color.g = (unsigned char)((tint_color.g * tint_color.a + 127) / 255);
    tint_color.b = (unsigned char)((tint_color.b * tint_color.a + 127) / 255);
  }
  TseShader shader;
  bool shaded = assets_shader(shader_handle, &shader);
  if (shaded) {
    const float region[4] = { 0.0f, 0.0f, (float)target.width, (float)target.height };
    begin_shader(&shader, time, params, region, IDENTITY_TURN, -1);
  }
  /* The destination is in the units drawing uses here, which the window's scale (or a parent layer's) takes to its pixels. */
  DrawTexturePro(layer->texture, (Rectangle){ 0.0f, 0.0f, (float)target.width, -(float)target.height },
                 (Rectangle){ 0.0f, 0.0f, (float)target.width / target.scale, (float)target.height / target.scale }, (Vector2){ 0.0f, 0.0f },
                 0.0f, tint_color);
  rlDrawRenderBatchActive();
  if (shaded) EndShaderMode();
  if (target.scissor_on) EndScissorMode();
  restore_target_state();
}

/* A light at the local origin (TSE_OP_LIGHT): `color` premultiplied by its alpha at the middle, falling off as (1 - d)^2 to black at
 * `radius`, drawn as rings of triangles with the colour at each ring's radius (smooth enough at the sizes games draw lights). */
static void draw_light(float radius, uint32_t packed) {
  if (!(radius > 0.0f)) return;
  Color c = unpack_color(packed);
  float strength = c.a / 255.0f;
  enum { RINGS = 6, SEGMENTS = 48 };
  rlBegin(RL_TRIANGLES);
  for (int ring = 0; ring < RINGS; ring++) {
    float t0 = (float)ring / RINGS, t1 = (float)(ring + 1) / RINGS;
    float k0 = (1.0f - t0) * (1.0f - t0) * strength, k1 = (1.0f - t1) * (1.0f - t1) * strength;
    unsigned char r0 = (unsigned char)(c.r * k0), g0 = (unsigned char)(c.g * k0), b0 = (unsigned char)(c.b * k0);
    unsigned char r1 = (unsigned char)(c.r * k1), g1 = (unsigned char)(c.g * k1), b1 = (unsigned char)(c.b * k1);
    for (int s = 0; s < SEGMENTS; s++) {
      float a0 = 2.0f * PI * s / SEGMENTS, a1 = 2.0f * PI * (s + 1) / SEGMENTS;
      float x00 = cosf(a0) * radius * t0, y00 = sinf(a0) * radius * t0, x01 = cosf(a1) * radius * t0, y01 = sinf(a1) * radius * t0;
      float x10 = cosf(a0) * radius * t1, y10 = sinf(a0) * radius * t1, x11 = cosf(a1) * radius * t1, y11 = sinf(a1) * radius * t1;
      /* Counter-clockwise on screen (y down), as raylib draws its own shapes. */
      rlColor4ub(r0, g0, b0, 255); rlVertex2f(x00, y00);
      rlColor4ub(r1, g1, b1, 255); rlVertex2f(x11, y11);
      rlColor4ub(r1, g1, b1, 255); rlVertex2f(x10, y10);
      if (ring > 0) {
        rlColor4ub(r0, g0, b0, 255); rlVertex2f(x00, y00);
        rlColor4ub(r0, g0, b0, 255); rlVertex2f(x01, y01);
        rlColor4ub(r1, g1, b1, 255); rlVertex2f(x11, y11);
      }
    }
  }
  rlEnd();
}

/* A TSE_OP_SPRITE_REGION (or the region part of a TSE_OP_SPRITE_SHADED, whose fields are laid out the same up to the tint), drawn
 * from `texture` under the record's transform. */
static void draw_region(const double *r, Texture2D texture, int32_t flags) {
  float w = (float)r[9], h = (float)r[10];
  if (!(w > 0.0f && h > 0.0f)) return;
  /* A negative source size mirrors the region; the destination always starts at minus the origin. */
  Rectangle source = { (float)r[7], (float)r[8], (flags & TSE_SPRITE_FLIP_X) ? -w : w, (flags & TSE_SPRITE_FLIP_Y) ? -h : h };
  float ox = (float)r[11], oy = (float)r[12];
  if (flags & TSE_SPRITE_FLIP_X) ox = w - ox;
  if (flags & TSE_SPRITE_FLIP_Y) oy = h - oy;
  Rectangle dest = { -ox, -oy, w, h };
  push_transform(r);
  DrawTexturePro(texture, source, dest, (Vector2){ 0.0f, 0.0f }, 0.0f, unpack_color(to_color(r[14])));
  rlPopMatrix();
}

/* How a record's image is turned on the target, as the columns of a 2x2 matrix with no stretch (see `turn` in tse.h): the view's
 * linear part, then the record's rotation, then the signs of its scale and its flips, made a rotation or a reflection. */
static void sprite_turn(const double *r, int32_t flags, float out[4]) {
  float a = 1.0f, b = 0.0f, c = 0.0f, d = 1.0f; /* the view: x' = a x + c y, y' = b x + d y */
  if (target.view_pushed) {
    a = target.view[0];
    b = target.view[1];
    c = target.view[4];
    d = target.view[5];
  }
  float rot = finite_or_zero((float)r[3]);
  float cs = cosf(rot), sn = sinf(rot);
  float fx = ((float)r[4] < 0.0f ? -1.0f : 1.0f) * ((flags & TSE_SPRITE_FLIP_X) ? -1.0f : 1.0f);
  float fy = ((float)r[5] < 0.0f ? -1.0f : 1.0f) * ((flags & TSE_SPRITE_FLIP_Y) ? -1.0f : 1.0f);
  /* The image's x and y axes on the target: view * rotation * the signs. */
  float x0 = (a * cs + c * sn) * fx, x1 = (b * cs + d * sn) * fx;
  float y0 = (a * -sn + c * cs) * fy, y1 = (b * -sn + d * cs) * fy;
  float length = sqrtf(x0 * x0 + x1 * x1);
  if (!(length > 0.0f) || !isfinite(length)) {
    memcpy(out, IDENTITY_TURN, sizeof IDENTITY_TURN);
    return;
  }
  x0 /= length;
  x1 /= length;
  /* y is x turned a quarter, mirrored when the whole turns the image over. */
  float side = x0 * y1 - x1 * y0 < 0.0f ? -1.0f : 1.0f;
  out[0] = x0;
  out[1] = x1;
  out[2] = -x1 * side;
  out[3] = x0 * side;
}

/* TSE_OP_SPRITE_SHADED: the region through its shader, or plainly when the shader cannot run. */
static void draw_shaded_sprite(const double *r) {
  Texture2D texture;
  if (!assets_texture(to_index(r[6]), &texture)) return;
  int32_t flags = to_index(r[13]);
  if (flags < 0) flags = 0;
  flags &= ~TSE_SPRITE_SILHOUETTE;
  TseShader shader;
  bool shaded = assets_shader(to_index(r[15]), &shader);
  if (shaded) {
    rlDrawRenderBatchActive();
    const float region[4] = { (float)r[7], (float)r[8], (float)r[9], (float)r[10] };
    float turn[4];
    sprite_turn(r, flags, turn);
    begin_shader(&shader, 0.0f, r + 17, region, turn, to_index(r[16]));
  }
  draw_region(r, texture, flags);
  if (shaded) {
    rlDrawRenderBatchActive();
    EndShaderMode();
  }
}

static void execute_records(const double *records, int32_t length, const char *text, const int32_t *text_offsets, int32_t text_count) {
  target.depth = 0;
  target.child_blend[0] = TSE_BLEND_NORMAL;
  target.view_pushed = false;
  target.scissor_on = false;
  int32_t at = 0;
  while (at < length) {
    const double *r = records + at;
    int32_t op = to_index(r[0]);
    int32_t need = 0;
    switch (op) {
      case TSE_OP_VIEW: need = TSE_OP_VIEW_LEN; break;
      case TSE_OP_SPRITE: need = TSE_OP_SPRITE_LEN; break;
      case TSE_OP_RECT: need = TSE_OP_RECT_LEN; break;
      case TSE_OP_ELLIPSE: need = TSE_OP_ELLIPSE_LEN; break;
      case TSE_OP_TEXT: need = TSE_OP_TEXT_LEN; break;
      case TSE_OP_SPRITE_REGION: need = TSE_OP_SPRITE_REGION_LEN; break;
      case TSE_OP_BOX: need = TSE_OP_BOX_LEN; break;
      case TSE_OP_SCISSOR: need = TSE_OP_SCISSOR_LEN; break;
      case TSE_OP_SCISSOR_END: need = TSE_OP_SCISSOR_END_LEN; break;
      case TSE_OP_LAYER_BEGIN: need = TSE_OP_LAYER_BEGIN_LEN; break;
      case TSE_OP_LAYER_END: need = TSE_OP_LAYER_END_LEN; break;
      case TSE_OP_LIGHT: need = TSE_OP_LIGHT_LEN; break;
      case TSE_OP_SPRITE_SHADED: need = TSE_OP_SPRITE_SHADED_LEN; break;
      case TSE_OP_CANVAS: report_bad_frame("canvas record that is not first", at); goto done;
      default: report_bad_frame("unknown op", at); goto done;
    }
    if (at + need > length) {
      report_bad_frame("record runs past the end", at);
      goto done;
    }

    switch (op) {
      case TSE_OP_VIEW: {
        /* A later view replaces the earlier one. */
        if (target.view_pushed) rlPopMatrix();
        /* x' = a x + c y + e, y' = b x + d y + f, as a column-major 4x4. */
        const float m[16] = {
          (float)r[1], (float)r[2], 0.0f, 0.0f,
          (float)r[3], (float)r[4], 0.0f, 0.0f,
          0.0f, 0.0f, 1.0f, 0.0f,
          (float)r[5], (float)r[6], 0.0f, 1.0f,
        };
        memcpy(target.view, m, sizeof m);
        push_view();
        target.view_pushed = true;
        break;
      }
      case TSE_OP_LAYER_BEGIN:
        if (!begin_layer(to_color(r[1]), blend_of(r[2]))) {
          report_bad_frame(target.depth >= TSE_LAYER_MAX ? "layers nested too deep" : "could not make the layer texture", at);
          goto done;
        }
        break;
      case TSE_OP_LAYER_END:
        if (target.depth == 0) {
          report_bad_frame("layer end with no layer open", at);
          goto done;
        }
        end_layer(blend_of(r[1]), to_color(r[2]), to_index(r[3]), isfinite(r[4]) ? (float)r[4] : 0.0f, r + 5);
        break;
      case TSE_OP_SCISSOR: {
        /* NaN or negative sizes clip everything, which is what an empty rectangle means. */
        double w = r[3] > 0.0 && r[3] <= 1e9 ? r[3] : 0.0, h = r[4] > 0.0 && r[4] <= 1e9 ? r[4] : 0.0;
        double x = r[1] >= -1e9 && r[1] <= 1e9 ? r[1] : 0.0, y = r[2] >= -1e9 && r[2] <= 1e9 ? r[2] : 0.0;
        if (target.scissor_on) EndScissorMode();
        target.scissor[0] = (int)x;
        target.scissor[1] = (int)y;
        target.scissor[2] = (int)w;
        target.scissor[3] = (int)h;
        begin_scissor(target.scissor[0], target.scissor[1], target.scissor[2], target.scissor[3]);
        target.scissor_on = true;
        break;
      }
      case TSE_OP_SCISSOR_END:
        if (target.scissor_on) EndScissorMode();
        target.scissor_on = false;
        break;
      case TSE_OP_SPRITE: {
        Texture2D texture;
        if (assets_texture(to_index(r[6]), &texture)) {
          push_transform(r);
          DrawTexture(texture, 0, 0, WHITE);
          rlPopMatrix();
        }
        break;
      }
      case TSE_OP_SPRITE_REGION: {
        Texture2D texture;
        int32_t flags = to_index(r[13]);
        if (flags < 0) flags = 0;
        bool found = (flags & TSE_SPRITE_SILHOUETTE) ? assets_silhouette(to_index(r[6]), &texture) : assets_texture(to_index(r[6]), &texture);
        if (found) draw_region(r, texture, flags);
        break;
      }
      case TSE_OP_SPRITE_SHADED:
        draw_shaded_sprite(r);
        break;
      case TSE_OP_RECT: {
        push_transform(r);
        DrawRectangleV((Vector2){ 0.0f, 0.0f }, (Vector2){ (float)r[6], (float)r[7] }, unpack_color(to_color(r[8])));
        rlPopMatrix();
        break;
      }
      case TSE_OP_BOX: {
        push_transform(r);
        draw_box((float)r[6], (float)r[7], to_color(r[8]), to_color(r[9]), (float)r[10], (float)r[11]);
        rlPopMatrix();
        break;
      }
      case TSE_OP_LIGHT:
        push_transform(r);
        draw_light(finite_or_zero((float)r[6]), to_color(r[7]));
        rlPopMatrix();
        break;
      case TSE_OP_ELLIPSE: {
        push_transform(r);
        float w = (float)r[6], h = (float)r[7];
        DrawEllipseV((Vector2){ w / 2.0f, h / 2.0f }, w / 2.0f, h / 2.0f, unpack_color(to_color(r[8])));
        rlPopMatrix();
        break;
      }
      case TSE_OP_TEXT: {
        int32_t index = to_index(r[6]);
        if (index >= 0 && index < text_count && text != NULL && text_offsets != NULL) {
          float size = (float)r[7];
          push_transform(r);
          /* The spacing DrawText uses: a tenth of the size. */
          DrawTextEx(GetFontDefault(), text + text_offsets[index], (Vector2){ 0.0f, 0.0f }, size, size / 10.0f, unpack_color(to_color(r[8])));
          rlPopMatrix();
        }
        break;
      }
    }
    at += need;
  }
done:
  /* A layer still open is closed as if by an END: laid over its target, normal, white. */
  while (target.depth > 0) end_layer(TSE_BLEND_NORMAL, 0xFFFFFFFFu, -1, 0.0f, NULL);
  set_blend(TSE_BLEND_NORMAL, false);
  if (target.scissor_on) EndScissorMode();
  if (target.view_pushed) rlPopMatrix();
  target.scissor_on = false;
  target.view_pushed = false;
}

/* Keep the frame about to be presented, for tse_read_pixels: RGBA8, top row first. */
static void capture_frame(void) {
  rlDrawRenderBatchActive(); /* flush, so the framebuffer holds everything drawn so far */
  int32_t width = GetRenderWidth();
  int32_t height = GetRenderHeight();
  int32_t size = width * height * 4;
  if (width <= 0 || height <= 0) return;
  if (state.pixels_size != size) {
    free(state.pixels);
    state.pixels = malloc((size_t)size);
    state.pixels_size = state.pixels ? size : 0;
  }
  if (state.pixels == NULL) return;
  state.pixels_width = width;
  state.pixels_height = height;
#if defined(GRAPHICS_API_OPENGL_SOFTWARE)
  /* raylib 6.0's software renderer reads the framebuffer back top row first and as BGRA, whatever
   * format is asked for, and LoadImageFromScreen would then flip it again. Read it raw and swap. */
  rlCopyFramebuffer(0, 0, width, height, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8, state.pixels);
  for (int32_t i = 0; i < size; i += 4) {
    uint8_t blue = state.pixels[i];
    state.pixels[i] = state.pixels[i + 2];
    state.pixels[i + 2] = blue;
    state.pixels[i + 3] = 255; /* a window has no alpha: as LoadImageFromScreen gives it on the GPU */
  }
#else
  Image image = LoadImageFromScreen(); /* flipped to top row first, alpha forced to 255 */
  if (image.data == NULL) return;
  /* LoadImageFromScreen sizes the image from the screen size and the DPI scale, which need not be the render size
   * (a high-DPI display): copy only an image of exactly the size the buffer was made for. */
  if (image.format == PIXELFORMAT_UNCOMPRESSED_R8G8B8A8 && image.width == width && image.height == height) {
    memcpy(state.pixels, image.data, (size_t)size);
  }
  UnloadImage(image);
#endif
}

/* A frame that starts with TSE_OP_CANVAS: draw the rest into the off-screen texture, then copy it into the window. */
static void draw_canvas_frame(uint32_t clear_color, const double *r, int32_t length, const char *text, const int32_t *text_offsets, int32_t text_count) {
  int32_t width = to_index(r[1]), height = to_index(r[2]);
  if (length < TSE_OP_CANVAS_LEN || width <= 0 || height <= 0 || width > MAX_CANVAS || height > MAX_CANVAS) {
    report_bad_frame("bad canvas record", 0);
    ClearBackground(unpack_color(clear_color));
    return;
  }
  if (state.canvas.id != 0 && (state.canvas.texture.width != width || state.canvas.texture.height != height)) {
    UnloadRenderTexture(state.canvas);
    state.canvas.id = 0;
  }
  if (state.canvas.id == 0) {
    state.canvas = load_target(width, height);
    if (state.canvas.id != 0) SetTextureFilter(state.canvas.texture, TEXTURE_FILTER_POINT);
  }
  if (state.canvas.id == 0) {
    report_bad_frame("could not make the canvas texture", 0);
    ClearBackground(unpack_color(clear_color));
    return;
  }
  BeginTextureMode(state.canvas);
  ClearBackground(unpack_color(clear_color));
  target.base = &state.canvas;
  target.width = width;
  target.height = height;
  target.scale = 1.0f;
  execute_records(r + TSE_OP_CANVAS_LEN, length - TSE_OP_CANVAS_LEN, text, text_offsets, text_count);
  EndTextureMode();
  /* The canvas is the finished picture, and it is laid over the window opaque, as the window's own pixels are. Its alpha is not
   * coverage: blending a translucent draw blends the alpha too (0.5 over 1 leaves 0.75), and laying the canvas over with that
   * alpha would let the border colour through. Neither renderer can blend alpha apart from colour here (rlsw has no separate
   * blend factors), so blending is off until the canvas is down. */
  rlDrawRenderBatchActive();
  rlDisableColorBlend();

  ClearBackground(unpack_color(to_color(r[7])));
  /* Render textures are upside down: a negative source height flips it. */
  Rectangle source = { 0.0f, 0.0f, (float)width, -(float)height };
  Rectangle dest = { (float)r[3], (float)r[4], (float)r[5], (float)r[6] };
  Texture2D shown = state.canvas.texture;
  /* Sharp scaling: at a scale between two whole numbers, first blow the canvas up by the whole number above it with nearest
   * filtering (so every texel is a crisp block), then let bilinear filtering take that down to the exact size. */
  /* The scale in framebuffer pixels: on a high-DPI window the dest rectangle (logical pixels) covers window_scale() times as many. */
  float scale = (float)(r[5] / (double)width) * window_scale();
  if (state.sharp && scale > 1.0f && fabsf(scale - roundf(scale)) > 1e-3f) {
    int32_t k = (int32_t)ceilf(scale);
    int32_t uw = width * k, uh = height * k;
    if (uw <= MAX_CANVAS && uh <= MAX_CANVAS) {
      if (state.upscaled.id != 0 && (state.upscaled.texture.width != uw || state.upscaled.texture.height != uh)) {
        UnloadRenderTexture(state.upscaled);
        state.upscaled.id = 0;
      }
      if (state.upscaled.id == 0) state.upscaled = load_target(uw, uh);
      if (state.upscaled.id != 0) {
        BeginTextureMode(state.upscaled);
        /* Every draw of a render texture flips it (its rows are stored bottom up), into another render texture as onto the window:
         * so the canvas is flipped here, and the upscaled texture again when it is drawn to the window. */
        DrawTexturePro(state.canvas.texture, (Rectangle){ 0.0f, 0.0f, (float)width, -(float)height }, (Rectangle){ 0.0f, 0.0f, (float)uw, (float)uh }, (Vector2){ 0.0f, 0.0f }, 0.0f, WHITE);
        EndTextureMode();
        SetTextureFilter(state.upscaled.texture, TEXTURE_FILTER_BILINEAR);
        shown = state.upscaled.texture;
        source = (Rectangle){ 0.0f, 0.0f, (float)uw, -(float)uh };
      }
    }
  }
  DrawTexturePro(shown, source, dest, (Vector2){ 0.0f, 0.0f }, 0.0f, WHITE);
  rlDrawRenderBatchActive();
  rlEnableColorBlend();
}

void tse_frame(uint32_t clear_color, const double *records, int32_t records_length,
               const char *text, const int32_t *text_offsets, int32_t text_count,
               double *input, uint8_t *keys) {
  if (!state.open) return;

  assets_update_music();
  BeginDrawing();
  bool has_records = records != NULL && records_length > 0;
  if (has_records && to_index(records[0]) == TSE_OP_CANVAS) {
    draw_canvas_frame(clear_color, records, records_length, text, text_offsets, text_count);
  } else {
    ClearBackground(unpack_color(clear_color));
    target.base = NULL;
    target.width = GetRenderWidth();
    target.height = GetRenderHeight();
    target.scale = window_scale();
    if (has_records) execute_records(records, records_length, text, text_offsets, text_count);
  }
  if (state.hidden) capture_frame();
  EndDrawing(); /* presents, waits for vsync or the frame cap, and polls devices */

  if (input != NULL) {
    Vector2 mouse = GetMousePosition();
    input[TSE_IN_DT] = (double)GetFrameTime();
    input[TSE_IN_WIDTH] = (double)GetScreenWidth();
    input[TSE_IN_HEIGHT] = (double)GetScreenHeight();
    input[TSE_IN_MOUSE_X] = (double)mouse.x;
    input[TSE_IN_MOUSE_Y] = (double)mouse.y;
    input[TSE_IN_WHEEL] = (double)GetMouseWheelMove();
    input[TSE_IN_QUIT] = WindowShouldClose() ? 1.0 : 0.0;
  }
  if (keys != NULL) {
    int32_t count = keys_count();
    for (int32_t i = 0; i < count; i++) keys[i] = keys_flags(i);
  }
  /* The characters typed this frame, Backspace among them where it fell (raylib queues characters, so a Backspace goes after them). */
  state.typed_count = 0;
  for (int c = GetCharPressed(); c != 0; c = GetCharPressed()) {
    if (state.typed_count < TSE_TYPED_MAX) state.typed[state.typed_count++] = (uint32_t)c;
  }
  if ((IsKeyPressed(KEY_BACKSPACE) || IsKeyPressedRepeat(KEY_BACKSPACE)) && state.typed_count < TSE_TYPED_MAX) state.typed[state.typed_count++] = TSE_TYPED_BACKSPACE;
}

int32_t tse_typed(uint32_t *out, int32_t capacity) {
  if (out != NULL) {
    int32_t n = state.typed_count < capacity ? state.typed_count : capacity;
    for (int32_t i = 0; i < n; i++) out[i] = state.typed[i];
  }
  return state.typed_count;
}

int32_t tse_read_pixels(uint8_t *rgba, int32_t capacity) {
  if (state.pixels == NULL) return 0;
  if (rgba != NULL && capacity >= state.pixels_size) memcpy(rgba, state.pixels, (size_t)state.pixels_size);
  return state.pixels_size;
}
