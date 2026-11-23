# The native player

How a compiled game is drawn, heard and played: the pure-TypeScript player, the hosts that run it, `libtse` (C over raylib) and the
ABI between them. [DESIGN.md](DESIGN.md), "Player", covers what the game sees of the player (startup, errors in the window, hot
reload, reusing draw records). The exact record layouts, key table and current ABI version are in
[`native/include/tse.h`](../native/include/tse.h), which is the source of truth; this note explains why they are shaped that way.

## Goals

1. One body of game code runs in three places: the Node tests (no window), the Node dev player (a window, hot reload) and a
   packaged game (V8 or QuickJS-ng). Nothing in the compiler knows which.
2. The player is testable without a GPU. Almost all player logic is TypeScript and is tested against a recording backend. Native drawing is
   tested by pixel checks on raylib's software renderer, and on a GPU renderer under a virtual display (`tse screenshot --gpu`).
3. The pieces can be swapped. Drawing code lives in one place, `libtse`. The boundary between script and native is one call per
   frame with plain arrays, so a host is a thin adapter.

## Architecture

```
            game source (.tsx)  ──tse compile──▶  generated .ts
                                                      │ imports
                                                      ▼
  @tsengine/runtime   GameObject, World, the built-ins. Draws nothing; backends plug in through sinks (sound, storage).
                                                      ▲ reads the tree
  @tsengine/player    pure TypeScript, no Node APIs, no native dependencies
                 • draw.ts      FrameBuilder: the tree → one Float64Array of draw records (+ texts, pointers, colliders)
                 • layout.ts    <Flex> layout;  screen.ts  the <Screen> canvas;  transition.ts  <Router> transitions
                 • input.ts     native input buffers → InputState; presses → World.reportPress
                 • collide.ts   CollisionTracker: contacts → World.reportCollision
                 • loop.ts      createPlayer / run: the frame loop;  fixed.ts  the fixed timestep
                 • backend.ts   the Backend interface;  recording.ts  RecordingBackend, for tests
                 • script.ts, harness.ts, rewind.ts, overlay.ts, stories.ts   scripted runs, rewind, the inspector's overlay, previews
                                                      │ Backend interface
                    ┌─────────────────────────────────┴──────────────────────────────┐
                    ▼                                                                ▼
  @tsengine/player-node (tse dev, and the V8 package)                    host/ (Rust, the QuickJS package)
  koffi → libtse.so                                                 rquickjs (QuickJS-ng) + libtse linked statically
                    └─────────────────────────────────┬──────────────────────────────┘
                                                      ▼
  native/libtse  C, the only drawing code. Wraps raylib 6.0: window, textures, text, shaders, sound, music, input, storage.
                 ABI: native/include/tse.h
```

The tree walk, colour parsing, camera maths, layout, pointer hit testing and collision rules are where the bugs
are, so they live in TypeScript, where tests run them without a window. The native side executes a list of draw records and reports
input, through a boundary that costs the same in every host.

### The frame

`createPlayer` (`loop.ts`) owns the loop. Each `step()`:

1. **Press.** A new left press goes to the topmost `Pointer` drawn under the mouse last frame (`world.reportPress`), through the
   inverse of last frame's view: that is what the player was looking at when they clicked.
2. **Steps.** `world.tick(dt, input)` (`useInput`, `useUpdate`, renders, structure), once a frame or as many times as the fixed step
   holds. `dt` is clamped to `[0, MAX_DT]` (0.1 s), so a stall does not teleport things. After each step the tree is walked (which
   places the colliders), contacts that started or ended are reported, and what the callbacks changed is rendered at once, so
   contacts are found at the same steps whatever the frame rate.
3. **Walk.** The draw records are the last step's walk, or a new one when a collision callback changed something since, so a
   contact and what it caused are drawn in the same frame.
4. **Present.** `backend.frame(...)` draws the records, presents (blocking on vsync), polls devices and writes the next frame's
   input into the shared buffers.

`run()` is `createPlayer`, then `step()` until the window asks to close, then `close`. It is a plain blocking loop, which suits both
engines: game code is synchronous. Under `tse dev` the Node launcher drives `step()` itself, one per turn of the event loop, so it can
hear file events (see "The Node dev host").

## Ground rules

These sit beside the compiler's ([DESIGN.md](DESIGN.md#ground-rules-and-settled-decisions)):

- **The runtime stays backend-free.** `@tsengine/runtime` never draws, plays or polls anything. It has only hooks a backend plugs into (the
  sound sink, the storage sink).
- **`@tsengine/player` and `@tsengine/runtime` import no `node:` modules and no native packages**, because they run in QuickJS. A test enforces
  it.
- **`tse.h` is the single source of truth for the protocol.** `packages/player/src/protocol.ts` mirrors it, and a test parses `tse.h`
  and fails if any constant or key name differs. Change the header first, bump `TSE_ABI_VERSION`, then `protocol.ts`. Both hosts
  check `tse_abi_version()` and `tse_key_count()` when they load the library.
- **Logic goes in TypeScript unless it needs the GPU, the OS or audio.** The C side applies the transform it is given and draws the
  shape a record describes; a world position, a view, a colour or a layout is worked out in TypeScript. One exception:
  `tse_overlaps`, the broad phase of collisions, which decides nothing about the game and is in C only because the interpreter spent
  more of a busy frame on it than on anything else (see "Performance").
- **Keep `native/` (C) and `host/` (Rust) small.**

## Decisions

| Decision                        | Choice                                                                                                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graphics library                | raylib 6.0, pinned to the `6.0` tag                                                                                                                                                                                                                              | Each built-in maps to one or two raylib calls; one C library with no extra libraries for images, fonts or audio; a CPU-only software renderer makes headless tests possible. raylib can run on SDL as its platform layer, so moving to SDL later does not change our code |
| Not SDL3                        | Rejected for now                                                                                                                                                                                                                                                 | Better platform reach, but it needs SDL_image, SDL_ttf and SDL_mixer and our own batching for the same features. Revisit if consoles become a goal                                                                                                                        |
| Where drawing lives             | C, in `libtse`, once                                                                                                                                                                                                                                             | Both hosts link the same library: Node loads it as a shared library, the Rust host links it statically                                                                                                                                                                    |
| Native boundary                 | One call per frame: a `Float64Array` of records, plus an array of strings                                                                                                                                                                                        | The FFI cost does not grow with the number of sprites. `Float64Array`, not `Float32Array`: a packed `0xRRGGBBAA` colour and every handle fit exactly. Records refer to text by index, so they are byte-identical in every host                                            |
| Dev host                        | Node + koffi (`@tsengine/player-node`)                                                                                                                                                                                                                           | `node:ffi` is still experimental. The koffi calls stay in `ffi.ts`, so moving later is a one-file change                                                                                                                                                                  |
| Engine of a packaged game       | V8 by default (a Node single executable application), QuickJS-ng (`--engine quickjs`, the Rust host) as the fallback                                                                                                                                             | V8 is 10 to 30 times faster on a busy frame (see "Performance"). QuickJS-ng is a few MB, has no JIT and can go where a JIT is banned                                                                                                                                      |
| Bundling                        | esbuild, one ESM file (`--format=esm --target=es2022`)                                                                                                                                                                                                           | It resolves workspace packages and `.ts` imports; the Rust host loads one file and needs no module resolver                                                                                                                                                               |
| Draw order                      | Tree order, depth first, parent before children, later on top; `z` overrides it                                                                                                                                                                                  | It matches how JSX reads (DESIGN.md, "What is drawn")                                                                                                                                                                                                                     |
| Origin                          | Top-left for every drawn element and `Collider`; rotation and scale are about it                                                                                                                                                                                 | Consistency across built-ins                                                                                                                                                                                                                                              |
| Active camera                   | The first `Camera` in draw order (more than one: warn once). None: identity view, world origin at the top-left                                                                                                                                                   | With a camera the followed point is centred; without one, top-left is what a 2D API is expected to do                                                                                                                                                                     |
| `input.pointerX/Y`              | World space, through the active camera; `screenX/Y` in screen pixels                                                                                                                                                                                             | Components only know world space                                                                                                                                                                                                                                          |
| Coordinates                     | Logical pixels everywhere in the protocol; a visible window draws at the display's density (`TSE_OPEN_HIGHDPI`, 2026-11-16)                                                                                                                                      | A game never sees the display's scale, and shapes, text and a smooth canvas are sharp on a Retina screen. A `<Screen>` canvas gives a fixed resolution                                                                                                                    |
| Key names                       | `"A"`–`"Z"`, `"0"`–`"9"`, `"Space"`, `"Enter"`, `"Escape"`, `"Tab"`, `"Backspace"`, `"Shift"`, `"Control"`, `"Alt"`, the arrows, `"F1"`–`"F12"`, mouse buttons as keys (`"MouseLeft"`, …) and the first gamepad (`"PadA"`…`"PadStart"`, `"PadLeft"`…`"PadDown"`) | Mouse and pad buttons as keys mean `input.pressed("MouseLeft")` needs no new API. The table is `TSE_KEYS` in `tse.h`, append only                                                                                                                                         |
| Asset paths                     | Relative to the `assets` option (default `"assets"`), joined with `/` in TypeScript                                                                                                                                                                              | `@tsengine/player` must run in QuickJS, with no `node:path`                                                                                                                                                                                                               |
| A missing asset or a bad colour | Never throw: warn once per value, draw a 16 × 16 magenta rect for a missing texture, magenta for a colour that does not parse                                                                                                                                    | A typo should not stop a game during development, and magenta is easy to spot                                                                                                                                                                                             |
| Sound                           | A module-level sound sink in the runtime: a `Sound` asks it to load when it is made and to play from `play()`                                                                                                                                                    | `Sound` instances are fields on components, which the player cannot find from the tree                                                                                                                                                                                    |
| Saved data                      | One implementation, in `libtse`, for both hosts; `Backend.storage` is where a web build's `localStorage` would go                                                                                                                                                | The same files whichever engine runs the game                                                                                                                                                                                                                             |

## The ABI

`native/include/tse.h` defines, in this order:

- **Draw records.** A frame is a flat array of doubles, records back to back, each starting with its op. A drawable record carries
  the element's world transform (`x, y, rot, sx, sy`) and then its payload; the C side draws it at the local origin under translate,
  rotate, scale. Colours are packed `0xRRGGBBAA`. The ops: `VIEW` (the world → screen affine; a later one replaces it, which is how
  the HUD is drawn through a view that ignores the camera), `SPRITE`, `SPRITE_REGION` (a region of a sheet, with an origin, flips and
  a tint), `SPRITE_SHADED` (a region drawn through a shader, ABI v16), `RECT`, `ELLIPSE`, `BOX` (fill, border inside the edge, rounded corners), `TEXT`, `LIGHT`, `SCISSOR` / `SCISSOR_END`,
  `CANVAS` (only first: draw the frame into a fixed-size texture and scale it into the window) and `LAYER_BEGIN` / `LAYER_END`
  (an off-screen layer, blended over its target, optionally through a shader).
- **Input buffers**, written by `tse_frame`: `dt`, window size, mouse position, wheel and quit as doubles, and one byte of flags
  (down, pressed, released) per entry of the key table.
- **The key table** `TSE_KEYS(X)`: keyboard keys, mouse buttons, gamepad buttons and gamepad directions (the d-pad or the left stick
  past the dead zone). Its order is the order of the keys buffer.
- **Window options** for `tse_open`: resizable, vsync, hidden (no window and no audio device: tests and CI), smooth (bilinear
  filtering; the default is nearest, for pixel art), sharp (see "Scaling a canvas") and high DPI (see "High-DPI displays").
- **Functions**: open and close the window and switch full screen; load textures, shaders, sounds and music; play a sound at a
  volume; play, fade and stop music; measure text and textures (for layout); `tse_frame`; the characters typed last frame
  (`tse_typed`); the broad phase (`tse_overlaps`); saved data (`tse_storage_*`); and `tse_read_pixels` for tests.

A new record keeps old ones unchanged where it can, so a game that uses no new feature writes the same bytes as before (the parity
tests stay byte-identical): `SPRITE_REGION` sits beside `SPRITE`, a `<Flex>` with only a background is still a `RECT`, and so on.

### Notes on the C side

- **Transforms.** For each drawable: push, translate, rotate, scale, draw at the origin, pop. rlgl applies the matrix to vertices while
  batching, so batching survives. Backface culling is off: a negative scale (a flipped sprite) reverses the winding.
- **Malformed input stops the frame.** An unknown op, a short buffer or a layer nested too deep is logged once and the frame stops
  drawing; a bad index draws nothing; a bad colour is magenta. Doubles are checked before they are cast to integers (a cast of NaN
  is undefined behaviour in C). libtse never reads past `recordsLength`.
- **Handles** index into growable arrays; TypeScript caches by path, so C never sees a path twice.
- **Opening** sets `SetExitKey(KEY_NULL)`, so Escape reaches the game instead of closing the window.
- **The software renderer** (`TSE_PLATFORM=Memory`, raylib's rlsw) reads the framebuffer back top row first and as BGRA, so the capture
  swaps red and blue there and sets every alpha to 255, as the GPU capture does. `rlSetBlendMode` does nothing in rlsw, so libtse
  sets rlsw's blend function itself; and since rlsw switches blending off for an opaque primitive when the function reads alpha,
  add and multiply use `(ONE, ONE)` and `(DST_COLOR, ZERO)` there when nothing is translucent. A translucent sprite in an add layer
  is therefore added at full strength by the software renderer. A translucent layer (opacity below 1) is added with `(SRC_ALPHA, ONE)`,
  so it still only brightens; for screen and multiply, whose factors do not scale the layer's colour by its alpha, `end_layer`
  premultiplies the opacity into the tint on both renderers. rlsw stores a blended channel past 1 without clamping it, so it
  wrapped (an add past white went dark, and an add layer at an opacity turned a canvas's pixels transparent, showing the border
  through as black discs): `native/cmake/patch-rlsw.cmake`, raylib's `PATCH_COMMAND`, clamps it as the GPU does. rlsw has no shaders: `tse_load_shader` returns
  `TSE_SHADER_UNSUPPORTED` (-2) and the layer is laid over without one, or the shaded sprite drawn as its region, with a warning.
- **Render targets.** raylib 6.0's `LoadRenderTexture` is refused by Mesa 25.x's llvmpipe and softpipe (an empty upload and an unsized
  depth buffer), so the GPU build makes its own targets (`load_target` in `tse.c`): a colour texture uploaded from zeroed pixels and
  no depth. Making or unloading a texture binds the window's framebuffer, so a layer's target is made only after the current target
  is left. `BeginTextureMode` and `EndTextureMode` reset the matrices and the scissor, so libtse keeps the view and scissor itself
  (`target` in `tse.c`) and puts them back after every change of target.
- **Layers** nest `TSE_LAYER_MAX` (4) deep; each depth keeps one target between frames, remade when the size changes. A layer left
  open is closed at the end of the frame. Blend modes are normal, add, multiply and screen (`TSE_BLEND_*`).
- **Shaders.** A shader file holds one GLSL function, `vec4 effect(vec2 uv)`. libtse wraps it in GLSL 3.30 with `image`, `pixel` (from
  the top-left), `resolution`, `time` and `params[8]`, with `#line 1` so compiler messages count lines in the author's file. Only the
  function is the author's, so a WebGL build could wrap the same file in GLSL ES. `time` is the player's animation clock, so a replay
  draws the same frames.
- **Shaded sprites** (ABI v16). `SPRITE_SHADED` is a `SPRITE_REGION` with a shader handle, a lookup texture handle and eight
  parameters. The same file format serves a layer and a sprite: the wrapper also declares `region` (the part of the image drawn, in
  its pixels), `turn` and `lookup` (a second texture on unit 1, raylib's default white texture when there is none). `turn` is how
  the image is turned on the target with no stretch: the view's linear part times the record's rotation times the signs of its
  scale and flips, its first column normalised and its second that turned a quarter (mirrored when the determinant is negative), so
  it is always a rotation or a reflection and `transpose(turn)` inverts it. raylib has no mat2 uniform, so it goes up as a vec4
  (`tseTurn`) and `turn` is a macro that builds the matrix. A layer gets the whole target as its region, the identity and a white
  lookup. `time` is 0 on a sprite: a sprite's records are copied from the last frame while it does not change, and a time in the
  record would have to change them every frame; a shader that moves takes the time through `params`. Each shaded sprite is its own
  draw call (the batch is flushed before and after it), which is fine for tens of sprites, not thousands. The silhouette flag is
  ignored on it: a flash is written as its own silhouette region after it.
- **Lights** are discs drawn in rlgl's immediate mode as rings with a `(1 − d)²` falloff, premultiplied by their strength, so they need
  no texture and look the same on both renderers.
- **Boxes** are built from exact pieces (edge rectangles, ring quarters in the corners), not raylib's rounded outline, which draws
  outside the rectangle; no pixel is painted twice, so a translucent border is one even colour. A corner gets about one segment per
  pixel of radius (4 to 24), because raylib's own count draws a small circle as a diamond.
- **Sound.** A sound already playing is played again on an alias, up to `TSE_SOUND_VOICES` (4) at once; with all busy the oldest is cut
  off. Music is streamed and fed by `tse_frame`; fading is the player's job (`<Music>` moves the volume each step), which keeps time
  out of libtse.
- **Typed text** is raylib's `GetCharPressed` queue (as the keyboard layout and key repeat make it) plus `TSE_TYPED_BACKSPACE` for each
  press or repeat of Backspace, at most `TSE_TYPED_MAX` (64) a frame. It is its own function so the input buffer keeps a fixed size.
- **Saved data.** Small named files in one folder per game: `$TSE_DATA_DIR` when set (tests), else `$XDG_DATA_HOME/<game_id>`, else
  `~/.local/share/<game_id>` (macOS and Windows paths are written but unverified). The game id and names are 1 to 64 of
  `A-Z a-z 0-9 _ -`, so neither can become a path. A write goes to a `.tmp` file, is `fsync`ed and renamed over the old one: a crash
  leaves the old entry or the new one.
- **Scaling a canvas.** With `TSE_OPEN_SHARP` (`<Game upscale="sharp">`), a canvas shown at a scale that is not a whole number is first
  copied at the next whole scale with nearest filtering, then down to size with bilinear: edges stay crisp and every game pixel is
  the same size. Every draw of a render texture flips it, so both copies do. The canvas is laid over the window with blending off,
  opaque, as the window's own pixels are: blending a translucent draw into it blends its alpha too (0.5 over 1 leaves 0.75), and
  laid over with that alpha the border showed through. Blending alpha apart from colour would need separate blend factors, which
  rlsw does not have.
- **High-DPI displays** (ABI v14). `TSE_OPEN_HIGHDPI` asks raylib for a framebuffer at the display's density; the player sets it for
  every visible window (`WindowConfig.highDpi`, default true unless hidden, so screenshots and tests are the same size everywhere).
  raylib keeps the screen size and the mouse in logical pixels and draws to the window through a scale; libtse does the same for what
  raylib does not: a layer over the window is the framebuffer's size and drawn into through the same scale, a scissor inside one is
  scaled to its pixels by hand, a layer's shader is given its `resolution` in logical pixels, and sharp scaling counts the canvas's
  scale in framebuffer pixels. The C smoke test checks all of it at scale 2 on a virtual display that claims 192 dpi (CI's "C smoke
  test on a 2x display"); it has not yet been seen on a real Retina screen.
- **`tse_overlaps`** is the script's broad phase in C: an insertion sort over the order the caller keeps from last frame, then
  horizontal bands swept one by one. It trusts nothing (the order is checked to be a permutation, counts are clipped, boxes that are
  not finite still return valid indices) and its tests run under the address and undefined-behaviour sanitizers.

## The pieces

### `@tsengine/player`

**`Backend`** (`backend.ts`) is what every host implements: `open`, `close`, `loadTexture`, `loadSound`, `playSound`, `frame`, and
optional members a host may lack (`setFullscreen`, `loadShader`, music, `setGamepadDeadzone`, `measureText`, `textureSize`, `typed`,
`overlaps`, `storage`). A missing optional member falls back (an estimate for text, the script's broad phase, no music with one
warning). `RecordingBackend` keeps every frame's records, texts and loads, scripts input frame by frame, decodes records for
assertions, and keeps saved data in memory.

**`hostBackend()`** (`host.ts`) returns `globalThis.__tseBackend` and throws a clear error if no host installed one. A game's entry
is `run(hostBackend(), { … })`; the Node launcher and the Rust host each install their backend before the entry runs, so one entry
runs under both and the bundle never contains koffi.

**The tree walk** (`FrameBuilder`, `draw.ts`) gives the same world transform as `GameObject.worldTransform()` without recomputing
from the root for each object, using the runtime's `composeTransforms`; a parity test over a real tree keeps the two equal. It emits
`VIEW` first and fills it in after the walk, once the active camera is known (a camera's view that throws, on a zero zoom, is
identity with a warning). Textures load through the backend the first time a name is seen. How it reuses last frame's records for
what did not change is in DESIGN.md, "Reusing draw records".

**Colours** (`color.ts`): `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` and the CSS named colours plus `transparent`,
cached by string.

**Headless tools.** `parseInputScript` turns `right*30, jump, right*20+dash` into input frames (items in order, `+` starts terms
together, `name*N` holds N frames, `_` waits); it is also the replay format. `runScript` steps a game on a `RecordingBackend` and
returns what an observer reads after each step. `renderRun` (`@tsengine/player-node`) renders chosen steps of a scripted run to PNG
through a hidden window; `tse screenshot --gpu` does it with the desktop libtse under Xvfb (Mesa's llvmpipe, real shaders) and
`--compare` checks frames against stored PNGs within a tolerance.

### The Node dev host (`@tsengine/player-node`)

- `ffi.ts` is the only file that imports koffi. It finds the library (`TSE_NATIVE_LIB`, else the prebuilt one in `@tsengine/native`, else
  `native/build` or `native/build-headless`), declares the functions of `tse.h` and checks the ABI version and key count.
- `backend.ts`: `createNodeBackend()`. `frame` encodes the texts into a reused buffer plus offsets and passes typed arrays as
  pointers.
- `play.ts` installs the backend and plays an entry; `tse dev` runs it. With `--no-watch` it imports the entry as the packaged game
  does.
- `dev.ts`: hot reload. The launcher drives the frame loop itself, between turns of Node's event loop, and watches `src/` and
  `scenes/`. A save (debounced 80 ms) compiles the game in a child process while it keeps running; a compile error is shown in the
  window. A good build is imported again: a `module.registerHooks` resolve hook gives every file in the game's folder, but not its
  `node_modules`, a new version in its URL (`?v=3`), so the game is evaluated afresh while the engine and the window stay. Each game
  state is carried to its new build by file and export name (`carryFrom`), then `player.reload` swaps the root (DESIGN.md, "Hot
  reload"). Images and sounds load once per path, so a changed asset needs a restart, and each build stays in memory. The Rust host
  does not reload.
- `inspector.ts`, `preview.ts`, `screenshot.ts`, `png.ts`: the inspector, `tse preview`, `tse screenshot` and PNG writing.

### `native/` (C)

`CMakeLists.txt` fetches raylib at the `6.0` tag and builds libtse as a shared library (Node) and a static one (Rust). `src/tse.c`
(window, frame, records, layers, capture), `assets.c` (textures, shaders, sounds, music), `keys.c` (the key table), `overlaps.c`,
`storage.c`; `test/smoke.c` is the pixel and behaviour test of every function.

- `npm run native:build`: a real window, in `native/build`. On Linux it needs the X11 and GL development packages.
- `npm run native:build:headless`: raylib's software renderer (`-DRGE_PLATFORM=Memory`), in `native/build-headless`: no window,
  no GPU, no system libraries. Tests and CI use it.
- `npm run native:test` builds and runs the smoke test on the headless build.

### `host/` (Rust)

`tse-host [<game.js>] [--root <dir>]` runs one bundled ES module in QuickJS-ng (rquickjs) with libtse linked statically
(`build.rs` builds `../native` with the cmake crate; the macOS and Windows link lists are written from raylib's own and unverified).
`backend.rs` implements `Backend` over typed arrays, `console.rs` gives QuickJS a console on stderr. With no arguments it runs the
`game.js` beside the executable, which is how a packaged game starts. An uncaught exception prints its stack and exits with status 1.

### The web host (`@tsengine/player-web`)

A package of its own, which only `tse package --engine web` bundles: a native game (Node, the V8 package, the Rust host) does not
import it, and nothing in the player, the runtime or libtse changed for it.

`WebBackend` implements `Backend` in a browser, and `startWebHost` installs it and a frame loop on `globalThis` (`HOST_BACKEND_KEY`,
`HOST_RUN_KEY`), so a game's entry file runs unchanged: `run` hands the loop the player, which steps once a `requestAnimationFrame`.

- **Drawing** (`renderer.ts`) is `tse.c` again in WebGL2: every record becomes triangles transformed on the CPU (the view, then the
  record's translate, rotate and scale) and batched until the texture, blend or target changes. The canvas and layers are
  framebuffers, blended with raylib's factors; a layer's or a shaded sprite's shader is the author's `effect` wrapped for GLSL ES 3.00
  with the same names (`image`, `pixel`, `resolution`, `time`, `params`, `region`, `turn`, `lookup`). Boxes, rings and lights are built as `draw_box` and `draw_light` build
  them. Tower Defense's title screen comes out pixel for pixel as libtse draws it on the GPU.
- **Assets** are fetched and decoded before the game starts (`preloadAssets`), because the player asks for a texture and its size in
  one synchronous call. Images are decoded without premultiplying or colour conversion. The built-in fonts are the sheets of
  `native/src/fonts_data.h`, copied to `fonts-data.ts` by `tools/make-web-fonts.ts` (a test fails when they differ). A text record
  without a bitmap font is drawn with the browser's monospace, since raylib's default font is not there.
- **Input** comes from DOM events gathered between frames: keys by their `code`, a pointer (mouse, pen or finger) as `MouseLeft` at
  its position, the standard gamepad mapping. A press and release inside one frame still reads as a press. The window's size and the
  pointer start in CSS pixels, drawn at the screen's density, as libtse's high-DPI window; once a frame comes through a `<Screen>`
  canvas they switch to device pixels, so a `fit="integer"` screen fills a phone at a whole multiple of its own pixels.
- **Sound** is Web Audio (four voices a sound), music an `<audio>` element. Browsers start audio only from a gesture's own handler (Safari: a
  finger lifting, not landing), so the page's "Tap to play" and every pointer-up resume it. **Saved data** is localStorage, under `tse:<game id>:`.
- Not there: `overlaps` (the player sweeps in script), the software renderer's fallbacks, sharp scaling of a canvas at a scale that
  is not whole.

### Packaging

`tse package [folder] [--engine node|quickjs|web] [--headless]` writes `dist/<name>/` in the game's folder:

- **`node`** (the default): a Node single executable application (Node's binary with the game bundled in, injected with `postject`),
  `lib/libtse.so`, `node_modules/koffi` (its addon is found by paths relative to its own files, so it cannot be bundled) and
  `assets/`. About 125 MB, nearly all of it Node.
- **`quickjs`**: the Rust host, `game.js` and `assets/`. A few MB.
- **`web`**: `dist/<name>-web/`, a page any static host serves: `index.html`, `game.js` (the game, the player and
  `@tsengine/player-web`, bundled for the browser), `assets/` and a web app manifest (full screen, landscape), so a phone can add it to
  its home screen. It compiles the game first. The page shows "Tap to play" before the game starts: browsers allow sound, full screen
  and turning to landscape only from a press. It cannot be opened as a file; it loads its assets over HTTP.

Both run from their own folder. The parity scripts check that the demo prints byte for byte the same under Node, the V8 package and
the Rust host; CI's `native` and `native-desktop` jobs run them. The macOS and Windows steps follow Node's documentation and are
unverified.

## Built-ins the player drives

What each prop means is in the guide's reference (`docs/reference.html`); these are the implementation decisions.

- **Fixed timestep** (`<Game fixedStep={60}>`). An accumulator runs whole steps of `1 / rate`, at most `MAX_STEPS_PER_FRAME` (8) a
  frame; the leftover after that is dropped, so a stall is not followed by a burst. It compares with a 1e-9 epsilon, so sixty sums
  of 1/60 s give sixty steps. No input is lost: key edges accumulate across polls and go to the next step only, and a tap that
  began and ended between two steps reaches the next one as down, pressed and released at once. A frame that ran no step settles
  pending renders.
- **Interpolation** (`<Game interpolate>`, 2026-11-16; on by default in a visible window with a fixed step). After each step
  `Interpolator.capture` keeps every object's `transform` and `placement` (in `GameObject.interpolation`, ten numbers for the step
  before and ten for the last) and each camera's view state (`Camera.saveView`: the slide, the followed point and what it remembers
  of the last view). Before a frame is drawn, `blend` puts each object that moved `FixedDriver.alpha` of the way from the step
  before to the last step, and the frame is built from that. `restore` then writes back exactly what the step left. A blended
  object is marked moved both times, so the frame builder neither reuses records from before the blend nor keeps the blended ones.
  Every camera's view state is put back too, because drawing a view writes it. The game never sees a blended value, so a run steps
  the same with it on or off (a test checks both the steps and the camera). It draws up to one step behind: at alpha 0 the step
  before. An object is drawn unblended when it has no step before (new), when a frame with no step changed it since, or when one
  field jumped further than `INTERPOLATE_SNAP` (64 px) or half a turn in one step. A camera is drawn unblended when its bounds
  changed. Particles, sprite frames and the shake are not blended: they are discrete or short. The cost is a second build of the
  frame, and a pass over what moved: each object records whether its subtree had settled (nothing in it moved in its last step),
  and a settled subtree is skipped by `blend`, and by `capture` too while nothing in it has been changed since (`subtreeChangedAt`).
  Hearth's tenth wave: about 0.15 ms on a 1.2 ms frame. A hidden window turns it off, so tests and screenshots draw the latest
  step exactly as before.
- **Forgiving input** (2026-11-16). `PlayerInput.beginStep(dt)` runs before every `world.tick`: it moves a game clock on by the
  step's `dt`, writes down when each key that went down in the step did (`pressedWithin` compares with that, `consumePress` forgets
  it), and makes a left click that a pressable took since the last step this step's `pressHandled`. Under a fixed step a frame with
  no step leaves all three for the next step, as it does the key edges. `grace` is a plain function in `math.ts`. A snapshot from
  `createInputState` (tests, `@tsengine/testing`) is one step: its presses are within any window until consumed.
- **Sprite sheets.** `<Sprite frame…>` and `<AnimatedSprite animations…>` write `SPRITE_REGION`; a sprite with no options still writes
  `SPRITE` through the fast path. A flip mirrors about the origin, so a character turned left stays on its feet.
- **Flash** (ABI v13). A sprite's `flash` writes its region a second time with `TSE_SPRITE_SILHOUETTE`: libtse draws the region's
  shape (white, the image's alpha) in the tint, which is `flashColor` at `flash` times the opacity, so opaque pixels end up mixed that
  far toward the colour and transparent ones stay. No shader, so the software renderer draws it too. The silhouette texture is made
  the first time a texture is flashed, from its file read again (not every renderer can read a texture back), and
  freed with the textures. On a pixel with partial alpha the mix is approximate (it lays the colour over, rather than mixing inside).
- **`<Tilemap>`** writes one region record per filled cell, no game object per tile, and the same `TilemapData` is the solid grid
  movement code reads (`getTilemap(name)`), so what is drawn and what blocks cannot disagree. In the world it writes only the cells
  the view shows (plus one round them), from the previous frame's camera; a frame is built twice when that camera turns out to be
  another. Its run of records is copied while nothing about it changed. Importer limits: one embedded tileset, CSV layers, finite
  maps.
- **`<Camera>`**: `bounds` keep the view inside an area (a smaller area is centred); `slide` eases to new bounds; `deadzone` and
  `smoothing` follow a character; `shake` is a counter whose change throws the view along a fixed sequence. All are stepped in
  `onUpdate`, so a replay repeats exactly.
- **`<Particles>`** keeps its particles in one flat `Float64Array`, runs from a seeded generator (mulberry32) so a run repeats, and
  stamps itself changed only on ticks where it has particles, so an idle emitter costs a copied record.
- **Bitmap fonts** (`<Text font>`): a sheet of characters 32 to 127 in 16 × 6 cells, a region record per character, tinted by the
  text's colour; `size` is the cell's height. A font file moves the next character on by a cell; a built-in font by the
  character's own advance (below), and layout measures and wraps by the same widths.
- **Built-in fonts** (ABI v14; all but `tse:small` since v15). A `tse:` name is a font sheet built into libtse, not a file:
  `tse_load_texture("tse:m5x7")` makes its sheet from a one-bit table in `native/src/fonts_data.h`, white on transparent, so the
  Node and Rust hosts both have it and a game ships no file for it. There are eleven, from 3 × 5 (`tse:small`, Tom Thumb) to
  8 × 16 (`tse:unscii-tall`); `BUILTIN_FONTS` (runtime) lists them. Each character's advance is in `packages/player/src/fonts.ts`
  (`BUILTIN_FONT_METRICS`); `tools/fonts/make-fonts.py` writes both files from the original fonts and gives the digits one
  width, so a counting number does not shift. The player passes a `tse:` name as it is, not under the assets folder, and refuses
  one that is not in `BUILTIN_FONTS` with a warning naming them; the compiler's asset check does the same.
  `TSE_BUILTIN_FONT_SHEETS` (protocol.ts) gives the sheet sizes libtse makes, which `RecordingBackend` reports. The fonts' own
  licenses (CC0, public domain and the SIL OFL) are in `native/FONTS.md`, which `npm run pack` puts in `@tsengine/native` and
  `tse package` puts beside a game.
- **`freeze(steps)`** skips `onUpdate` for that many ticks; input and renders still run, and key edges are kept for the step after.
- **`<Router>`**. Only the shown `<Route>` is in the world; a route's components are made when it comes and dropped when it has gone
  (as React Router does), unless `keepAlive`. During a transition the screen being left is inert (`World.setInert`): it draws but
  takes no input, so a press during a fade acts only on the screen being entered. A transition is a plain function from progress to
  where each screen is and how far a cover colour is drawn.
- **Frame-rate counter** (`<Game showFps>`, `F3`): the frame rate between frames and the script time of the step. A slow frame with a
  small script time is the backend's (vsync, drawing); one with a large script time is the game's.

## Performance

### How it is measured

`packages/player/bench/frame.ts` times `player.step()` on scenes of up to 5,000 objects, against a backend
that draws nothing: engine script time, not the GPU. `npm run bench:check` runs it under Node and fails when a scene is over its
budget in `packages/player/bench/budget.json` (about 2.5 to 3 times a 4-core 2.1 GHz cloud VM's numbers on 2026-11-10), or when a
scene with four times the objects takes much more than four times as long (which catches quadratic growth on any machine). There are
no QuickJS budgets; the bench can be bundled and run under the Rust host by hand. Each game has a `tools/frame-time.ts` that replays
it and times every step. The inspector's profiler gives each component's time per frame (DESIGN.md, "Seeing inside a running game").

### V8 against QuickJS

Measured on 2026-11-10 on the same VM, the packaged Node build against the Rust host:

| Scene                                             | QuickJS-ng | V8      |
| ------------------------------------------------- | ---------- | ------- |
| 2,000 moved by state, each with a collider        | 9.5 ms     | 0.65 ms |
| 5,000 moving rects                                | 12.6 ms    | 0.73 ms |
| 300 colliders in one pile (44,850 touching pairs) | 11.3 ms    | 0.39 ms |
| mount 20,000 objects                              | 310 ms     | 41 ms   |

What is left in a busy frame under QuickJS is mostly the interpreter's price per statement, about 1 µs per object per phase; that is
why V8 is the default.

### The games

Script time only, on the recording backend:

- Kite, the whole game under Node (2026-11-16): mean 0.25 ms, 99th percentile 1.2 ms. The slowest steps after start-up (about 2 ms)
  are collisions on a room's first step; the room-change spike of about 25 ms measured earlier is gone.
- Bramble, the replay to the cave under Node (2026-11-12): mean 0.9 ms, 99th percentile 5 ms; a step that changes map costs 1.2 to
  1.5 ms. A 200 × 200 map scrolled across costs 0.12 ms a frame under Node and 1.8 ms under QuickJS.
- Hearth's wave 10 (109 enemies; 2026-11-15): Node mean about 1.0 ms; QuickJS mean 11.1 ms, 99th percentile about 29 ms (a garbage
  collection). Most of it is every enemy re-rendering every step, then the walk; if the Rust host hitches in the last waves, that is
  where to look.
- Swarm's stress scene (2026-11-17, in a run in which Hearth's wave 10 took 0.9 ms), a crowd walking after the player and keeping
  apart with `nearby` every step: median step 6.0 ms with 1,000 enemies, 9.3 ms with 1,500, 14.5 ms with 2,000; with every weapon
  (enemies hit, dying and replaced every step) 9.3, 14.8 and 18.1 ms. About 6 µs an enemy, spread over its three objects' update,
  render, two draw walks, collisions and interpolation. The tables, a breakdown and what is left are in
  [games/swarm/DESIGN.md](../games/swarm/DESIGN.md), "Performance".
- 200 styled animated sprites, re-rendered every step: 0.2 ms under Node, 2.2 ms under QuickJS (about 11 µs each, three times a plain
  rect), comfortable for games of this size.

### What is in place, and why

- **Collisions.** The tracker sorts boxes by left edge with an insertion sort over last frame's order and sweeps; when the sweep tests
  more than 8 pairs a box it switches to horizontal bands twice the mean box height, and goes back when bands save little. When at
  most an eighth of the colliders changed (by entry identity, which reused draw records provide) it tests only those. When a full
  sweep finds last sweep's pairs in the same order, the touching set is left alone (the pile went from 28 to 11 ms under QuickJS). Pair
  keys are small scrambled integers, because QuickJS-ng hashes an integer by one multiply and keeps the low bits. The broad phase runs
  in libtse when the host has `overlaps`; the script's sweep is the same algorithm and gives the same reports in the same order.
- **Body queries** (`useBody`) and `nearby` are answered from an index per tag (`World`'s `ColliderIndex`) made on the first query in
  an update phase; fewer than 16 colliders are scanned. Each collider is in one cell of a grid, the one its box's middle is in,
  and a query looks at the cells its area covers, half a box wider. The boxes' edges are in one typed array in cell order, so a
  row of cells is one run of it and a query reads memory that is next to itself. Cells are about one and a half times the median
  box (16 to 64 pixels); colliders more than two cells wide go on a coarser grid of their own, and so on. Answers are sorted into
  join order (`nearby`: nearest first, then join order), so replays do not move. Before 2026-11-17 a collider was an object in
  every cell it touched: Swarm's `nearby` went from about 1,100 to 450 ns a query, and its step with 1,500 enemies from about 9.3 to
  7.9 ms (games/swarm/DESIGN.md).
- **Draw records** are reused for subtrees that did not change, a component that only moved has its records copied with the new
  transform, plain leaves are written in their parent's loop, and a still tilemap's records are copied in one `set`. See DESIGN.md,
  "Reusing draw records". Every reuse path is checked by `retain: "check"`, which builds each frame from nothing beside it and
  compares.
- **Layouts are kept** (2026-11-17) for a `<Flex>` root nothing has changed under, by the stamps draw records are reused by (see
  LAYOUT.md, "A layout that cannot have changed is kept"). Laying out the HUD every frame was the largest single cost of the
  engine in two games' profiles: 10 % of a step of a tower defence on a 20 × 9 board, 12 % of Hearth's. `retain: "check"` lays
  each kept root out after all and compares.
- **Hover asks siblings together** (2026-11-17). The topmost pressable under the mouse is found every frame, and each one asked
  walked up the tree to find where it is: 14 % of a step with a press target on each of 180 tiles. A run of pressables with one
  parent now shares the parent's place (`Pressable.containsIn`). With both, that game's step went from 0.245 to 0.164 ms; the
  bench has a scene for each ("a HUD of 100 rows, still", "900 press targets in a grid").
- **A list item finds itself by key once per list** (2026-11-17). A handler reading a list item's prop live found the item in the
  parent's list with `findIndex` on every read, so a thousand enemies each reading the player's position was a million comparisons a
  step. The generated module keeps a map of each list array's keys (`$indexOfKey`, made the first time the array is asked about),
  and a prop written after a spread has a getter of its own instead of building every prop. 25 % of a step of 2,000 enemies.
- **A prop read in a handler is a getter of the component's own** (2026-11-17). `this.$live_px` reads the parent's getter for `px`
  by name; before, every component read every prop through one function (`GameObject.liveProp`) and an object of getters, which
  V8 could not specialise. A list item's getters remember where the item was at the last read and look there first, before the
  map of keys. Swarm with 1,500 enemies from 7.9 to 6.9 ms, armed from 12.6 to 11.2 (A/B, same VM).
- **`nearby` in one pass, with no garbage** (2026-11-17). A result carries its collider in a private field for `send`
  (`NearbyResult`): registering each in a `WeakMap` cost about 200 times making it, and kept every result alive past the young
  generation. `ColliderIndex.within` walks the cells once into reused arrays, sorted by insertion, with no object per candidate.
  An index's cells are about one and a half times its boxes' median side (16 to 64 pixels): 32-pixel cells under 10-pixel enemies
  looked at fifty entries to find four. Boxes are worked out with each ancestor's child space remembered, not composed up the
  whole tree for every collider. `distanceToBox` uses `Math.sqrt`; `Math.hypot` is about four times slower in V8.
- **Collisions without a build, when drawing between steps** (2026-11-17). With interpolation on, a step's frame is built again
  from blended transforms anyway, so the build `collide()` made to find the colliders was thrown away. `FrameBuilder.colliders`
  places them without drawing: the build's walk, its order and its rules (a hidden route is not entered, nor is a `<Hud>`, a camera is
  transparent), skipping leaves that neither collide nor are cameras. It keeps a collider's entry while it stays put, so the tracker's
  incremental path still sees it unchanged, and it calls the first camera's `viewTransform` at the last frame's view size, as the
  build did: drawing is what moves a camera's remembered view on (a change of bounds, the start of a slide), and the frame drawn
  from blended transforms is put back. A `<Flex>` outside a `<Hud>` is placed by layout, so a world with one is built as before.
  `retain: "check"` builds as well and requires the same colliders. Swarm with 1,500 enemies 0.1 to 1 ms faster; Hearth's wave 10
  about 0.08 ms.
- **Blending reads a list, not the tree** (2026-11-17). The capture after a step lists the objects whose own transform or placement
  the step changed, and `blend` moves those; it used to walk every object that was not settled to find them. 0.42 to 0.18 ms a
  frame with Swarm's 1,500 enemies.
- **A keyed list whose keys did not change skips its bookkeeping** (2026-11-17): the duplicate check, the scan for removed items and
  the reorder, when the keys are the same, in the same order, as at its last render. `applyProps` walks props with `for…in`, not
  `Object.keys`. A reorder writes the slot's run of children in place instead of sorting them all, and which hooks an object has is a
  field on it (`worldHandlers`), so making the order handlers run in again (every step something mounts or unmounts) looks nothing
  up. Together with the `nearby` work: Swarm with 1,500 enemies from 14.0 to 11.0 ms, armed from 19.0 to 16.3 ms; Hearth's wave
  10 from 1.27 to 1.16 ms, 99th percentile 4.5 to 3.7 ms (A/B, same VM).
- **Mounting** appends without scanning siblings when the child sorts last; it was quadratic before.
- **A transform's numbers start as doubles** (2026-11-16). V8 picks a field's representation from its first value: a `Transform`
  whose `x` started at 0 (a small integer) and later held a fraction changed shape, and the walk that composes thousands of them kept
  deoptimising. 2,000 objects moving by fractions took 2.7 ms a frame to build under a fixed step instead of 0.6, and the
  interpolated scene 5.5 ms instead of 1.8. The fields are first set to 0.5, then to their defaults in the constructor.
- **Mounting and unmounting while the game runs** (2026-11-16). A run of removals from one parent (a list dropping many items, shots
  leaving the screen) compacts the children array once instead of searching and splicing it per child. An object makes no arrays
  for structural changes, `useMount` cleanups or timers until it has one. 200 rects made and 200 dropped a frame went from 1.3 to
  about 1.0 ms in the bench ("200 rects spawned and removed a frame"), and from 1.0 to 0.5 ms with plain entities.
- **`findPath`** (2026-11-16) keeps its heap in typed arrays and asks `blocked` once per cell (it was asked up to three times a
  cell with diagonals). It returns the same paths, checked against the old search on 3,000 random maps; the bench's 100 searches
  went from about 146 to 78 ms.
- The remaining spikes under V8 are full garbage collections (10 to 20 ms, a few times a minute in Hearth's tenth wave under the
  recording backend, which decodes every frame and allocates much more than a real one). A larger young generation
  (`--max-semi-space-size`) halved the scavenges but not the full collections.
- **Small savings under an interpreter**: no default parameters on recursive calls, indexed loops instead of `for…of`
  (QuickJS allocates an iterator), a class's draw kind cached on the object.

### Tried and rejected

- **A hashed grid as the collision broad phase** (2026-11-10): under QuickJS it cost as much as the sweep for 2,000 colliders and four
  times as much for a pile, because the interpreter pays for each bookkeeping step. The bands are the cheap half of it.
- **Accessors on `Transform` with cached world transforms** (2026-11-10): still scenes gained about 1 ms, every moving scene lost
  about 4 ms, because QuickJS calls a getter for every read. Plain fields stay.
- **Extending the moved-as-a-block copy to styled sprites**: not needed, nothing is over budget.
