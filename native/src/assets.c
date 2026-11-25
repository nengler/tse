#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "internal.h"
#include "rlgl.h"
#include "tse.h"

/* Textures and sounds are kept in growable tables; a handle is an index and is never reused. The
 * TypeScript side loads each path once, so this side does not look paths up. */

typedef struct {
  Texture2D *items;
  /* Per texture: the file it was loaded from (for its silhouette), and its silhouette once one is asked for (id 0 until then). */
  char **paths;
  Texture2D *silhouettes;
  int32_t count;
  int32_t capacity;
} TextureTable;

typedef struct {
  Sound *items;
  bool *loaded; /* false for a sound that exists but cannot play (no audio device) */
  Sound **voices; /* per sound: aliases of it, made on first use, so one sound can play over itself */
  int32_t *voice_count;
  int32_t *next_voice; /* which voice to take when all are playing: the oldest */
  int32_t count;
  int32_t capacity;
} SoundTable;

typedef struct {
  Music *items;
  bool *loaded;
  int32_t count;
  int32_t capacity;
} MusicTable;

typedef struct {
  TseShader *items;
  int32_t count;
  int32_t capacity;
} ShaderTable;

static TextureTable textures;
static ShaderTable shaders;
static SoundTable sounds;
static MusicTable musics;
static bool smooth_filter;
static bool audio_ready;

void assets_init(bool smooth, bool audio) {
  smooth_filter = smooth;
  audio_ready = false;
  if (!audio) return;
  InitAudioDevice();
  audio_ready = IsAudioDeviceReady();
  if (!audio_ready) TraceLog(LOG_WARNING, "TSE: no audio device: sounds will be silent");
}

bool assets_audio_ready(void) {
  return audio_ready;
}

void assets_shutdown(void) {
  for (int32_t i = 0; i < textures.count; i++) {
    UnloadTexture(textures.items[i]);
    if (textures.silhouettes[i].id != 0) UnloadTexture(textures.silhouettes[i]);
    free(textures.paths[i]);
  }
  free(textures.paths);
  free(textures.silhouettes);
  for (int32_t i = 0; i < shaders.count; i++) UnloadShader(shaders.items[i].shader);
  free(shaders.items);
  shaders = (ShaderTable){0};
  for (int32_t i = 0; i < sounds.count; i++) {
    if (!sounds.loaded[i]) continue;
    for (int32_t v = 0; v < sounds.voice_count[i]; v++) UnloadSoundAlias(sounds.voices[i][v]);
    free(sounds.voices[i]);
    UnloadSound(sounds.items[i]);
  }
  for (int32_t i = 0; i < musics.count; i++) if (musics.loaded[i]) UnloadMusicStream(musics.items[i]);
  free(musics.items);
  free(musics.loaded);
  musics = (MusicTable){0};
  free(sounds.voices);
  free(sounds.voice_count);
  free(sounds.next_voice);
  free(textures.items);
  free(sounds.items);
  free(sounds.loaded);
  textures = (TextureTable){0};
  sounds = (SoundTable){0};
  if (audio_ready) CloseAudioDevice();
  audio_ready = false;
}

bool assets_texture(int32_t handle, Texture2D *out) {
  if (handle < 0 || handle >= textures.count) return false;
  *out = textures.items[handle];
  return true;
}

/* A texture's pixels: a built-in font sheet for a "tse:" name, else the file. image.data is NULL when there is none. */
static Image load_image(const char *path) {
  Image image = {0};
  if (strncmp(path, "tse:", 4) == 0) {
    builtin_font_image(path, &image);
    return image;
  }
  return FileExists(path) ? LoadImage(path) : image;
}

bool assets_silhouette(int32_t handle, Texture2D *out) {
  if (handle < 0 || handle >= textures.count) return false;
  Texture2D *silhouette = &textures.silhouettes[handle];
  if (silhouette->id == 0) {
    /* Made the first time it is drawn, from the file again (reading a texture back is not something every renderer can do):
     * white where the image is, with the image's alpha. A file that cannot be read again gives none, and nothing is drawn. */
    if (textures.paths[handle] == NULL) return false;
    Image image = load_image(textures.paths[handle]);
    if (image.data == NULL) return false;
    ImageFormat(&image, PIXELFORMAT_UNCOMPRESSED_R8G8B8A8);
    unsigned char *pixels = image.data;
    for (int32_t i = 0, n = image.width * image.height; i < n; i++) {
      pixels[i * 4] = 255;
      pixels[i * 4 + 1] = 255;
      pixels[i * 4 + 2] = 255;
    }
    *silhouette = LoadTextureFromImage(image);
    UnloadImage(image);
    if (silhouette->id == 0) return false;
    SetTextureFilter(*silhouette, smooth_filter ? TEXTURE_FILTER_BILINEAR : TEXTURE_FILTER_POINT);
  }
  *out = *silhouette;
  return true;
}

bool assets_shader(int32_t handle, TseShader *out) {
  if (handle < 0 || handle >= shaders.count) return false;
  *out = shaders.items[handle];
  return true;
}

#if !defined(GRAPHICS_API_OPENGL_SOFTWARE)
/* What wraps an author's `effect` function: the inputs it is given, and the main function that calls it. GLSL 3.30, as raylib's
 * desktop build speaks; `#line 1` makes the compiler's messages count lines in the author's file. */
static const char *SHADER_HEAD =
  "#version 330\n"
  "in vec2 fragTexCoord;\n"
  "in vec4 fragColor;\n"
  "uniform sampler2D texture0;\n"
  "uniform vec4 colDiffuse;\n"
  "uniform vec2 resolution;\n"
  "uniform float time;\n"
  "uniform float params[32];\n"
  "uniform vec4 region;\n"
  "uniform vec4 tseTurn;\n"
  "uniform sampler2D lookup;\n"
  "uniform float tseScale;\n"
  "uniform vec4 tseView;\n"
  "uniform vec2 tseShift;\n"
  "out vec4 finalColor;\n"
  "vec2 pixel;\n"
  "vec2 place;\n"
  "#define image texture0\n"
  "#define turn mat2(tseTurn.xy, tseTurn.zw)\n"
  "vec2 uvOf(vec2 p) { vec2 at = mat2(tseView.xy, tseView.zw) * p + tseShift; return vec2(at.x / resolution.x, 1.0 - at.y / resolution.y); }\n"
  "vec2 param2(int i) { return vec2(params[i], params[i + 1]); }\n"
  "vec3 param3(int i) { return vec3(params[i], params[i + 1], params[i + 2]); }\n"
  "vec4 param4(int i) { return vec4(params[i], params[i + 1], params[i + 2], params[i + 3]); }\n"
  "#line 1\n";
static const char *SHADER_TAIL =
  "\nvoid main() {\n"
  "  pixel = vec2(gl_FragCoord.x, resolution.y * tseScale - gl_FragCoord.y) / tseScale;\n"
  "  place = inverse(mat2(tseView.xy, tseView.zw)) * (pixel - tseShift);\n"
  "  finalColor = effect(fragTexCoord) * colDiffuse * fragColor;\n"
  "}\n";
#endif

int32_t tse_load_shader(const char *path) {
  if (path == NULL || !FileExists(path)) return -1;
#if defined(GRAPHICS_API_OPENGL_SOFTWARE)
  return TSE_SHADER_UNSUPPORTED;
#else
  char *body = LoadFileText(path);
  if (body == NULL) return -1;
  size_t size = strlen(SHADER_HEAD) + strlen(body) + strlen(SHADER_TAIL) + 1;
  char *source = malloc(size);
  if (source == NULL) {
    UnloadFileText(body);
    return -1;
  }
  snprintf(source, size, "%s%s%s", SHADER_HEAD, body, SHADER_TAIL);
  UnloadFileText(body);
  Shader shader = LoadShaderFromMemory(NULL, source);
  free(source);
  /* raylib falls back to its default shader when compiling fails: that is a failure here. */
  if (shader.id == 0 || shader.id == rlGetShaderIdDefault()) {
    TraceLog(LOG_WARNING, "TSE: the shader %s did not compile (the message above says why): what it shades is drawn without it", path);
    return -1;
  }
  if (shaders.count == shaders.capacity) {
    int32_t capacity = shaders.capacity ? shaders.capacity * 2 : 8;
    TseShader *grown = realloc(shaders.items, (size_t)capacity * sizeof(TseShader));
    if (grown == NULL) {
      UnloadShader(shader);
      return -1;
    }
    shaders.items = grown;
    shaders.capacity = capacity;
  }
  shaders.items[shaders.count] = (TseShader){
    .shader = shader,
    .resolution = GetShaderLocation(shader, "resolution"),
    .time = GetShaderLocation(shader, "time"),
    .params = GetShaderLocation(shader, "params"),
    .region = GetShaderLocation(shader, "region"),
    .turn = GetShaderLocation(shader, "tseTurn"),
    .lookup = GetShaderLocation(shader, "lookup"),
    .scale = GetShaderLocation(shader, "tseScale"),
    .view = GetShaderLocation(shader, "tseView"),
    .shift = GetShaderLocation(shader, "tseShift"),
  };
  return shaders.count++;
#endif
}

static double clamp_volume(double volume) {
  return volume >= 0.0 && volume <= 1.0 ? volume : (volume > 1.0 ? 1.0 : 0.0); /* NaN reads as 0 */
}

/* Play a sound on a voice that is free: the sound itself, then aliases of it made as needed, up to TSE_SOUND_VOICES; with
 * all of them busy the oldest is cut off and used again. */
void assets_play(int32_t handle, double volume) {
  if (handle < 0 || handle >= sounds.count || !sounds.loaded[handle]) return;
  Sound *voice = &sounds.items[handle];
  if (IsSoundPlaying(*voice)) {
    voice = NULL;
    for (int32_t v = 0; v < sounds.voice_count[handle]; v++) {
      if (!IsSoundPlaying(sounds.voices[handle][v])) {
        voice = &sounds.voices[handle][v];
        break;
      }
    }
    if (voice == NULL && sounds.voice_count[handle] < TSE_SOUND_VOICES - 1) {
      Sound *grown = realloc(sounds.voices[handle], (size_t)(sounds.voice_count[handle] + 1) * sizeof(Sound));
      if (grown != NULL) {
        sounds.voices[handle] = grown;
        grown[sounds.voice_count[handle]] = LoadSoundAlias(sounds.items[handle]);
        voice = &grown[sounds.voice_count[handle]++];
      }
    }
    if (voice == NULL) {
      /* Every voice is busy: the primary and the aliases take turns being cut off. */
      int32_t total = sounds.voice_count[handle] + 1;
      int32_t pick = sounds.next_voice[handle] % total;
      sounds.next_voice[handle] = (pick + 1) % total;
      voice = pick == 0 ? &sounds.items[handle] : &sounds.voices[handle][pick - 1];
      StopSound(*voice);
    }
  }
  SetSoundVolume(*voice, (float)clamp_volume(volume));
  PlaySound(*voice);
}

void assets_update_music(void) {
  for (int32_t i = 0; i < musics.count; i++) if (musics.loaded[i] && IsMusicStreamPlaying(musics.items[i])) UpdateMusicStream(musics.items[i]);
}

int32_t tse_load_music(const char *path) {
  if (path == NULL || !FileExists(path)) return -1;
  Music music = {0};
  bool loaded = false;
  if (audio_ready) {
    music = LoadMusicStream(path);
    if (!IsMusicValid(music)) return -1;
    loaded = true;
  }
  if (musics.count == musics.capacity) {
    int32_t capacity = musics.capacity ? musics.capacity * 2 : 4;
    Music *grown_items = realloc(musics.items, (size_t)capacity * sizeof(Music));
    if (grown_items == NULL) {
      if (loaded) UnloadMusicStream(music);
      return -1;
    }
    musics.items = grown_items;
    bool *grown_loaded = realloc(musics.loaded, (size_t)capacity * sizeof(bool));
    if (grown_loaded == NULL) {
      if (loaded) UnloadMusicStream(music);
      return -1;
    }
    musics.loaded = grown_loaded;
    musics.capacity = capacity;
  }
  musics.items[musics.count] = music;
  musics.loaded[musics.count] = loaded;
  return musics.count++;
}

void tse_music_play(int32_t handle, double volume, int32_t loop) {
  if (handle < 0 || handle >= musics.count || !musics.loaded[handle]) return;
  Music *music = &musics.items[handle];
  music->looping = loop != 0;
  StopMusicStream(*music);
  SetMusicVolume(*music, (float)clamp_volume(volume));
  PlayMusicStream(*music);
}

void tse_music_set_volume(int32_t handle, double volume) {
  if (handle < 0 || handle >= musics.count || !musics.loaded[handle]) return;
  SetMusicVolume(musics.items[handle], (float)clamp_volume(volume));
}

void tse_music_stop(int32_t handle) {
  if (handle < 0 || handle >= musics.count || !musics.loaded[handle]) return;
  StopMusicStream(musics.items[handle]);
}

int32_t tse_load_texture(const char *path) {
  if (path == NULL) return -1;
  Image image = load_image(path);
  if (image.data == NULL) return -1;
  Texture2D texture = LoadTextureFromImage(image);
  UnloadImage(image);
  if (texture.id == 0) return -1;
  SetTextureFilter(texture, smooth_filter ? TEXTURE_FILTER_BILINEAR : TEXTURE_FILTER_POINT);
  if (textures.count == textures.capacity) {
    int32_t capacity = textures.capacity ? textures.capacity * 2 : 16;
    Texture2D *grown = realloc(textures.items, (size_t)capacity * sizeof(Texture2D));
    if (grown != NULL) textures.items = grown;
    char **grown_paths = realloc(textures.paths, (size_t)capacity * sizeof(char *));
    if (grown_paths != NULL) textures.paths = grown_paths;
    Texture2D *grown_silhouettes = realloc(textures.silhouettes, (size_t)capacity * sizeof(Texture2D));
    if (grown_silhouettes != NULL) textures.silhouettes = grown_silhouettes;
    if (grown == NULL || grown_paths == NULL || grown_silhouettes == NULL) {
      UnloadTexture(texture);
      return -1;
    }
    textures.capacity = capacity;
  }
  textures.items[textures.count] = texture;
  size_t length = strlen(path) + 1;
  textures.paths[textures.count] = malloc(length);
  if (textures.paths[textures.count] != NULL) memcpy(textures.paths[textures.count], path, length);
  textures.silhouettes[textures.count] = (Texture2D){0};
  return textures.count++;
}

int32_t tse_load_sound(const char *path) {
  if (path == NULL || !FileExists(path)) return -1;
  Sound sound = {0};
  bool loaded = false;
  if (audio_ready) {
    sound = LoadSound(path);
    if (!IsSoundValid(sound)) return -1;
    loaded = true;
  }
  /* Without an audio device the sound is remembered but silent, so a headless run still counts it as found. */
  if (sounds.count == sounds.capacity) {
    int32_t capacity = sounds.capacity ? sounds.capacity * 2 : 16;
    Sound *grown_items = realloc(sounds.items, (size_t)capacity * sizeof(Sound));
    if (grown_items == NULL) {
      if (loaded) UnloadSound(sound);
      return -1;
    }
    sounds.items = grown_items;
    bool *grown_loaded = realloc(sounds.loaded, (size_t)capacity * sizeof(bool));
    if (grown_loaded == NULL) {
      if (loaded) UnloadSound(sound);
      return -1;
    }
    sounds.loaded = grown_loaded;
    Sound **grown_voices = realloc(sounds.voices, (size_t)capacity * sizeof(Sound *));
    int32_t *grown_counts = realloc(sounds.voice_count, (size_t)capacity * sizeof(int32_t));
    int32_t *grown_next = realloc(sounds.next_voice, (size_t)capacity * sizeof(int32_t));
    if (grown_voices != NULL) sounds.voices = grown_voices;
    if (grown_counts != NULL) sounds.voice_count = grown_counts;
    if (grown_next != NULL) sounds.next_voice = grown_next;
    if (grown_voices == NULL || grown_counts == NULL || grown_next == NULL) {
      if (loaded) UnloadSound(sound);
      return -1;
    }
    sounds.capacity = capacity;
  }
  sounds.items[sounds.count] = sound;
  sounds.loaded[sounds.count] = loaded;
  sounds.voices[sounds.count] = NULL;
  sounds.voice_count[sounds.count] = 0;
  sounds.next_voice[sounds.count] = 0;
  return sounds.count++;
}

void tse_play_sound(int32_t handle) {
  assets_play(handle, 1.0);
}

void tse_play_sound_ex(int32_t handle, double volume) {
  assets_play(handle, volume);
}
