# UI layout: `<Flex>`, `<Hud>` and `<Screen>`

How UI is placed: `<Flex>` lays its children out in a row or a column, `<Hud>` gives it a box that ignores the camera, and
`<Screen>` gives the whole game a fixed resolution scaled to the window. The code is `packages/runtime/src/components/Flex.ts`
(the props), `packages/player/src/layout.ts` (the algorithm) and the player's draw pass (`packages/player/src/draw.ts`). The
tests are `packages/player/test/layout*.test.ts`, `hud.test.ts`, and the compiler's `flex.test.ts` and `screen.test.ts`. For the
built-ins' place in the compiler and player as a whole, see [DESIGN.md](DESIGN.md) ("The game's screen", "The HUD", and "Buttons,
menus and `onAdjust`" for focus and keyboard navigation).

Two sizes meet here. The **game size** is the `<Screen>`'s `width` × `height` (320 × 180, say), and everything a game writes is in
those units: transforms, the camera's view, `<Hud>` and the layout inside it, the mouse position. The **window size** is only the
player's business: it scales the game into the window. Without a `<Screen>` the two are the same. So a HUD designed for 320 × 180
looks the same in a 640 × 360 window as in a full-screen 4K one.

## A HUD

```tsx
import { useMutable, Flex, Hud, Sprite, Text } from "@tsengine/runtime/jsx";

export function PlayerHud({ coins }: { coins: number }) {
  const s = useMutable({ paused: false });
  return (
    <Hud>
      <Flex width="grow" height="grow" direction="column" justifyContent="space-between" padding={16}>
        <Flex alignItems="center" gap={8}>
          <Sprite image="coin.png" />
          <Text size={20}>{coins}</Text>
          <Flex width="grow" />
        </Flex>
        <Flex justifyContent="center">
          <Flex paddingX={16} paddingY={8} background="slategray" onPress={() => { s.paused = !s.paused; }}>
            <Text>{s.paused ? "Resume" : "Pause"}</Text>
          </Flex>
        </Flex>
      </Flex>
    </Hud>
  );
}
```

The outer column grows to the HUD's box. The top row needs no `width`: the column's default `alignItems="stretch"` makes it as
wide as the column. `<Flex width="grow" />` is a spacer, as `flex: 1` on an empty `div` is in CSS. The button is a `Flex` with
`onPress`: it is pressable over its laid-out box and grows with its label, so nothing is placed by hand.

## `<Flex>` props

Every prop is a plain string, number or boolean, so each is a field set in place by `render()`. There are no object-valued props
(`padding={{ x: 8 }}`), because an object would be allocated on every render; that is why padding is spelled out side by side.
Keyword props are checked by the compiler from the manifest's `intrinsicLiterals`, with a did-you-mean (and a hint for CSS's
`"flex-start"`).

| Prop | Values | Default | Meaning |
| --- | --- | --- | --- |
| `direction` | `"row"`, `"column"` | `"row"` | The main axis |
| `alignItems` | `"start"`, `"center"`, `"end"`, `"stretch"` | `"stretch"` | Where children sit across the main axis. `stretch` makes a child `Flex` whose cross size is `"fit"` take the whole cross size |
| `justifyContent` | `"start"`, `"center"`, `"end"`, `"space-between"`, `"space-around"`, `"space-evenly"` | `"start"` | How children and free space share the main axis. `space-*` falls back to `"start"` with no free space; `center` and `end` overflow on both sides or one, as in CSS |
| `gap`, `rowGap`, `columnGap` | pixels | `0` | Between neighbouring children; `rowGap` / `columnGap` override `gap` (see "Wrapping rows") |
| `wrap` | boolean | `false` | A row breaks into lines (rows only) |
| `padding`, `paddingX`, `paddingY`, `paddingTop` … `paddingLeft` | pixels | `0` | Inside the edge; the more specific prop wins |
| `width`, `height` | `"fit"`, `"grow"`, a number, `"50%"` | `"fit"` | See "Sizing" |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | pixels | none | Bounds for `"fit"` and `"grow"` |
| `float`, `anchor`, `to`, `offsetX`, `offsetY` | boolean, one of nine points, pixels | `false`, `"top-left"`, `"top-left"`, `0` | See "Floating boxes" |
| `overflow`, `scrollX`, `scrollY`, `scrollbar`, `scrollbarColor`, `scrollbarWidth` | | `"visible"` | See "Clipping and scrolling" |
| `background`, `borderWidth`, `borderColor`, `borderRadius` | colour, pixels | none | A filled box behind the children, with a border inside the edge (it counts as padding) and rounded corners (`TSE_OP_BOX`); without border or radius it is a plain rectangle |
| `hover…`, `focus…`, `pressed…`, `disabled…` + `Background` / `BorderColor` / `BackgroundImage` | colour or image | none | The look in a state. Precedence: disabled, pressed, hover, focus, plain. Colours only, so layout never moves |
| `disabled` | boolean | `false` | No press, no focus; a click on it is swallowed |
| `transition` | seconds | `0` | Fade colours and `opacity` between states, from the player's animation clock, turning round from where a cut-short fade had got to |
| `backgroundImage`, `slice`, `sliceTop` … `sliceLeft` | image, pixels | none, `0` | A nine-slice skin (see "Nine-slice backgrounds") |
| `opacity` | 0 to 1 | `1` | See "Opacity" |
| `onPress`, `pressKey`, `focusable`, `autoFocus`, `onFocus`, `onBlur`, `onAdjust`, `onPointerEnter`, `onPointerLeave` | | | Input, shared with `Pointer`: see DESIGN.md, "Buttons, menus and `onAdjust`" |
| `onLayout` | `(box) => void` | none | Told where the box was laid out (`LayoutBox`: x, y, width, height), when that changes: see "Where a box was laid out" |

A box with any `hover*` prop, a tooltip child or `onPress` takes the mouse; one without `onPress` lets a press through to what is
under it. `<Button>`, `<Menu>`, `<Slider>`, `<Toggle>`, `<TextInput>` and `<Tooltip>` are `Flex` subclasses, so layout, state
colours, focus, clipping, opacity and the HUD all apply to them.

### Sizing

| Value | The box is | Clay |
| --- | --- | --- |
| `"fit"` (default) | Its children plus padding and gaps, clamped to `min…` / `max…` | `CLAY_SIZING_FIT` |
| `"grow"` | Its fit size plus a share of the parent's free space, up to `max…`; across the parent's main axis, the parent's whole inner size | `CLAY_SIZING_GROW` |
| `120` | Exactly 120 pixels | `CLAY_SIZING_FIXED` |
| `"50%"` | That share of the parent's inner size (minus gaps, along the parent's direction) | `CLAY_SIZING_PERCENT` |

One prop per axis, as in CSS and Clay. The compiler checks a literal through the manifest's `intrinsicSizing`: a number, `"fit"`,
`"grow"` or `"<0–100>%"`, with a did-you-mean for `"grwo"`; anything else is left to the type, `number | "fit" | "grow" |
`${number}%``.

### Rules an author can rely on

- **Children are laid out in tree order**, which follows the JSX. A conditional child that turns on takes its place among its
  siblings; one that turns off lets the rest close up; a keyed list keeps its order.
- **A child's own `x`, `y`, `rotation` and scale move it within its slot**, not the slot: as CSS's `transform`, a nudge, rotation or scale never
  pushes its neighbours. So a button can bounce on press without disturbing the row.
- **Leaves keep their size.** `grow`, `stretch`, percentages and shrinking resize only a child that is itself a `Flex`; a `Shape`,
  `Sprite` or `Text` keeps the size its props give it (resizing one from layout would fight its `render()`). To stretch a coloured
  box, use a `Flex` with a `background`.
- **Overflow is visible** unless `overflow` says otherwise.
- **Positions are whole pixels.** Each child's offset is rounded from the exact running position (so a row of odd widths does not
  drift); sizes are not rounded. Parents' offsets are whole, so centred text is never blurry.
- **Layout runs before drawing, on every frame where it could have changed.** A handler reading `worldTransform()`, and a press,
  use where things were drawn last frame, as Clay's hover test does.
- **A layout that cannot have changed is kept** (2026-11-17). A layout is a function of what is under its root (a `Flex` whose
  parent is not one), the box the root is given (the game's area) and the game's font. Everything under the root that changes
  says so with a stamp: a render that wrote something, a move, a child added or removed, `markChanged()` (DESIGN.md, "Reusing
  draw records"). So a root with no stamp since the build that laid it out, given the same box and font, is left as it is: a HUD
  that stands still costs its walk and no layout (a still panel of 100 rows went from 0.25 to 0.09 ms a frame in the bench). Two
  kinds of tree cannot promise that, and are laid out every frame as before: one with an `overflow="scroll"` box in it (the
  wheel, a scroll bar and the focus move its children without a stamp), and one with a hand-written class that overrides
  `onInput` or `onUpdate` in it or above it (its hook may write to itself and to anything under it, and report nothing: the
  rule draw records follow). The first frame that could keep a layout looks through the tree for those, once. `retain: false`
  keeps nothing; `retain: "check"` lays every kept root out after all and throws when that moves or resizes anything
  (`FrameBuilder.keptLayouts` counts them, for tests).

## How each child is measured

Layout asks each child for a box. Every drawable built-in has its top-left corner as its origin.

| Child | Box |
| --- | --- |
| `Shape`, `Pointer`, `Collider` | `width` × `height` |
| `Text` | Its `width` if it has one (else the measured width) × its lines' height, measured by libtse (`tse_measure_text`, raylib's `MeasureTextEx`); a `maxWidth` wraps it first. A bitmap `font` measures by its glyph cell, a built-in one by each character's advance |
| `Sprite` | The texture's size (`tse_texture_size`); a missing texture is its 16 × 16 magenta square |
| `AnimatedSprite` | Its first frame, so the layout does not jitter |
| `Flex` | Its sizing, worked out by the passes below |
| `Entity` or a component | The union of its own box (if it is a leaf) and its children at their `transform` + `placement` positions, ignoring rotation. A `Flex` inside counts at its fit size, and is laid out for real later as a layout root of its own. The extent's top-left goes in the slot |
| `Camera` | Nothing, with one warning |

The `Entity` rule is what makes ordinary components work as layout children with no annotation, in a HUD or in the world.
`FrameBuilder` caches the native answers: texture sizes per handle, text sizes per `(text, size)`, cleared after 1,024 strings so
a running timer does not grow the cache without end. A backend that cannot measure estimates text (0.6 × size a character) and
warns once.

`<Text align>` is relative to the text's own `width`: `<Text width={80} align="center">` is centred in 80 pixels, shifted by whole
pixels. Without a `width` (or `maxWidth`) the box is the text, so `align` has nothing to move. Shadows and outlines are drawn
copies that take no room, so a label with an outline needs padding.

## The algorithm

The algorithm is Clay's ([github.com/nicbarker/clay](https://github.com/nicbarker/clay), by Nic Barker: `Clay__CloseElement`,
`Clay__SizeContainersAlongAxis` and `Clay__CalculateFinalLayout` in `clay.h`), in the order his video "How Clay's UI Layout
Algorithm Works" teaches it, with CSS's prop names on top.

A **layout root** is a `Flex` whose parent is not a `Flex`. Its available box is the game's area (the canvas under a `<Screen>`,
else the window, read every frame, so a resized window lays out again) whether it is under a `<Hud>` or in the world; a
percentage of a non-`Flex` parent is of that area. Everything below one root is laid out together:

1. **Widths**: fit, then distribute.
2. **Heights**: fit, then distribute. Heights come after widths because a wrapped box's height depends on its width (a wrapping
   row is the case today; text wrapping by the layout's width would slot in between the two).
3. **Positions**, top-down: each box starts its children inside its padding; along its direction the free space is shared by
   `justifyContent`, across it each child is placed by `alignItems`. Each child's `layoutX` / `layoutY` is written. Floating
   children are attached last.

Steps 1 and 2 are one function parameterised by the axis: what it does to a box depends only on whether the axis is the box's
direction or across it ("UI is mostly a one-dimensional problem").

**Fit, bottom-up.** Each box's *preferred* size: along its direction, padding at both ends plus `gap × (children − 1)` plus the
sum of its children; across it, padding plus the largest child. Its *minimum* is worked out the same way from its children's
minimums (a leaf's minimum is its size). Both are clamped to `min…` / `max…`; a percentage child counts as 0 here.

**Distribute, top-down.** Percentage children take their share. Along the direction, the free space is the inner size minus the
children and gaps:

- **Positive, with growing children:** it goes to the smallest growing child until it matches the next smallest, then to both,
  and so on, each stopping at its maximum; what a capped child cannot take goes to the others. Grow is not weighted: equal
  growing siblings end up equal, which is what a row of buttons wants. (Clay's author calls this a taste decision; a `growWeight`
  can come if a game asks.)
- **Negative:** the largest shrinkable child (a `Flex` that is `"fit"` or `"grow"`) gives way first, down to the next largest,
  each stopping at its minimum, and one at its minimum drops out (the grow loop reversed). A scroll box's children never
  shrink. Leaves never shrink, so in practice nothing shrinks until a leaf can report a minimum smaller than its size
  (`MeasuredSize.minWidth` / `minHeight` exist for that; the frame builder sets none yet). What still does not fit overflows.

Across the direction, a growing child (or a fit child under `stretch`) takes the inner size, and every child is held between its
minimum and the inner size.

**Allocation.** Clay lays out with no `malloc`; here, laying out allocates nothing in steady state. A `Flex` keeps its working
numbers in one field, `box` (a `FlexBox`: fit size, minimum, final size, child arrays reused between frames), so a component
rooted at a `Flex` reserves one name for them. `box.size` is the size it was laid out at last frame. `layout-allocation.test.ts`
counts garbage collections over 20,000 layouts (it is its own file because other tests' varied inputs deoptimise the passes).

### Where the result goes

Every `GameObject` has `layoutX` / `layoutY`, composed first:

```
world = parent × layout × placement × transform
```

Layout never writes `transform` (that would fight `render()`) or `placement` (a scene sets that). They
are zero outside a `Flex`, only x and y, and reserved names (a state called `layoutX` is a compile error). `worldTransform()` and
the player's `walkTree` both apply them, and a test checks they agree.

Layout runs inside the frame builder's one walk: when the walk reaches a layout root it lays out that root's `Flex` subtree, then
draws each box's background as it reaches it and continues into the children. A game with no `Flex` pays one more `kindOf` case.

### Where a box was laid out (2026-11-25)

A component cannot read another's layout: there are no refs, and positions go up through callbacks. Jam Jar's tutorial dims
everything but the part a lesson is about, and to cut the hole it repeated the amber frame's paddings and hard-coded the rent board's
height. `<Flex onLayout={(box) => …}>` is the callback: the box's top-left corner (its world position, which is the game's pixels under a
`<Screen>` and the HUD's in a `<Hud>`) and its laid-out size, both times its scale, rotation left out (`LayoutBox`).

It is called by the world at the start of a step, before `onInput` (`World.tick`, for each registered `Flex` with an `onLayout`:
`Flex.reportLayout`), not by the frame builder: the player builds a frame more than once in some steps (culling, the retained-frame
check, placing colliders), and game code runs in steps, where a write renders as any other. So it hears where the box was in the frame
drawn since the last step, a frame late, and only when that is not what it last heard; a box with no size, never laid out, says nothing.
React Native's `onLayout` is the same shape and the same timing.

### Why a port, not a library

Yoga (React Native's flexbox) is C++ or WebAssembly: QuickJS-ng has no WebAssembly, and C++ in libtse breaks its "C over
raylib, the C side does no maths" rule. Clay is one C header that would link into libtse, but it would put layout maths on
the C side, it lays out its own element tree rather than the engine's objects, and a second, native layout engine would be one
more thing to keep byte-identical between Node and QuickJS. So the engine ports Clay's algorithm to TypeScript for the subset a
game UI needs, and keeps Clay as the reference: when an edge case comes up, Clay's answer is the default one.

## Floating boxes

`<Flex float anchor="top-right" to="top-right" offsetX={-8} offsetY={8}>` is a badge in its parent's corner. A floating box is
fitted and sized like any other (a `"grow"` or percentage size is of the parent's inner size), but is left out of its parent's
flow in every step: no space, no gap, no effect on `justifyContent`. After the parent has placed its flow, the box's `anchor`
point is attached to the parent's `to` point (one of `"top-left"`, `"top-center"` … `"bottom-right"`), against the parent's
whole box, not inside its padding, plus the offset. A floating layout root hangs off the game's area. Draw it above its
neighbours with `z`; its pointers are then pressed before what it covers. Floating is a set of props rather than a `<Float>`
built-in, so a floating box keeps all of `Flex`'s sizing.

`<Tooltip>` is a floating `Flex` with a look of its own, attached above its parent at `z` 100, drawn only while its parent is
hovered or focused (or as `show` says).

## Wrapping rows

`wrap` on a row is an inventory grid: children keep their size and fall into lines, as CSS's `flex-wrap: wrap` without the parts
that need a second sizing pass.

- Lines come from the settled widths: a child starts a new line when it and the gap before it would not fit in what is left,
  unless it is first on its line. Along the row the box prefers one line, and its minimum is its widest child, so a parent short
  of room can narrow it and it wraps more. Its height is the lines stacked, with `rowGap` between.
- Children do not grow or shrink along a wrapping row (CSS's per-line `flex-grow` is not here). Across, a stretching or
  growing child fills its line's height.
- Each line is placed on its own: `justifyContent` over the line's free space, so a short last line is not spread like a full
  one; `alignItems` within the line's height.
- `columnGap` is between a line's children, `rowGap` between lines (for a column, `rowGap` is between its children).
- A wrapping column is warned of and laid out as one line: it would need the heights before the widths.

## Clipping and scrolling

`overflow="hidden"` clips to the box; `"scroll"` also scrolls with the wheel and with a drag. This uses ABI v2's scissor record, which is in target
pixels, ignores the view and does not nest, so the player does the rest:

- A clip is a property of a draw record, like its z. The walk tags each record with its innermost clipping box. After the z
  sort, each box's corners go through the layer's final view to a pixel rectangle, cut down to the box around it, and a
  `SCISSOR` record is written wherever the clip changes (and a `SCISSOR_END` where it stops and at the end of a layer). A child's
  own z cannot lift it out of its clip. A turned box clips to the rectangle around it; a box with a border clips inside it, as
  CSS clips to the padding box.
- A scroll box's children do not shrink, and it asks its parent for no more than its edges, so it can be squeezed.
  Positioning records where the children end (`box.contentEnd`) and so how far it can scroll (`box.scrollMax`), clamps
  `scrollX` / `scrollY` and moves the children by them. `scrollY={9999}` keeps a log at its end.
- A press or hover inside a clipping box must also be inside every box that clips it. The wheel goes to the topmost
  scroll box under the mouse that can still move that way (vertical first), and a box at its end passes it on. A notch is 32
  pixels.
- A drag scrolls the topmost scroll box it began over that overflows, both ways it overflows, once the pointer has moved 6
  pixels (in the box's layer) from the press; from there the content follows the pointer, clamped to its ends. A touch is the
  left button, so this is how a phone scrolls, and a mouse can drag too. A press whose pressable takes drags (`onDragStart`,
  `onDrag`, `onDragEnd`, a slider's `onHeldAt`) does not scroll. Over a box with something to scroll, any other press is held
  back until the button is let go, so a tap there presses on release and a drag that scrolls presses nothing: not a row of the
  list, nor a card around a text that scrolls. The pressable looks pressed (`pressed*`) while held, until a scroll ends it.
  Elsewhere a press is heard as it goes down. A drag does not hand off to an outer box at an end, and there is no flick.
- A scroll box draws a thin bar along each axis it overflows, outside its own clip. When the focus
  moves to something inside a scroll box, it scrolls just enough to show it, once per change.

## Nine-slice backgrounds

`backgroundImage` with `slice` needs nothing native: it is nine `TSE_OP_SPRITE_REGION` records of one texture, each placed at its
part of the box (through the box's rotation and scale) and scaled by destination ÷ source size. Corners keep their size, edges
stretch along one axis, the middle along both. Slices come from `sliceTop` … `sliceLeft`, else `slice`; a box smaller than its
corners shrinks all of them by one factor (CSS's `border-image` rule). The slices are drawn after the colour and border,
before the children. State images follow the colours' precedence and change at once. A missing image is a magenta box (a
compile error for a literal); a backend that cannot report texture sizes draws nothing, with one warning.

## Opacity

`opacity` multiplies into every colour drawn under the box, down the tree (`DrawList.pushAlpha` / `popAlpha`, pushed before the
box's own background). At 0 nothing is written, so a faded-out menu costs no records, but the box is still laid out and still
takes the mouse and the focus. A plain sprite under a faded box is drawn as a tinted region. With a `transition`, a change fades.

This is PIXI's model (an alpha per part), not CSS's (the box flattened and blended once): exact at 0 and 1 and for parts that do
not overlap, and slightly different part way for parts that do (a text outline fades slower than its glyphs). Flattening would
draw the box into an off-screen layer; `<Layer opacity>` (DESIGN.md, "Layers") does that for a whole subtree when it matters.

## `<Hud>`

A `<Hud>` is a layer drawn after the world through its own view that ignores the camera, in game pixels. A growing `Flex`
directly under it takes the game's area, so a full-HUD column with `space-between` and spacers pins things to its edges, and a
floating box pins one thing to a corner. Pointers inside it are hit-tested in game coordinates through `worldTransform()`, which
includes the layout offset. `<Fade>` is a full-screen cover drawn on the HUD layer. The rest of what a HUD does with cameras,
colliders and nesting is in DESIGN.md, "The HUD".

## `<Screen>`: a fixed game resolution

```tsx
<Game title="My game" width={1280} height={720}>
  <Screen width={320} height={180} fit="integer" border="black">
    <World />
    <Hud>
      <PlayerHud />
    </Hud>
  </Screen>
</Game>
```

`<Game width height>` is the window the game opens (else `PlayerConfig`, else 3 × the `<Screen>`, else 640 × 360), which the
player may then resize. `<Screen width height>` is the resolution the game is drawn at, whatever the window does. They are two
components because the world must be inside the sized root but outside the camera-ignoring `<Hud>`, of which there may be several.

| Prop | Values | Default | Meaning |
| --- | --- | --- | --- |
| `width`, `height` | pixels | required | The game's resolution |
| `fit` | `"integer"`, `"contain"`, `"stretch"`, `"expand"` | `"integer"` | How the canvas is scaled into the window |
| `pixelPerfect` | boolean | `true` | Draw at the game's resolution and scale the finished frame up (chunky), or draw at the window's resolution through a scale (smooth) |
| `border` | a CSS colour | `"black"` | The bars around the canvas. Inside it, the clear colour is `<Game background>` |

**`fit`**, for a 320 × 180 canvas in a 1000 × 600 window:

- `"integer"`: the largest whole scale that fits (×3, with bars), so every game pixel is the same number of screen pixels and
  nothing shimmers. It falls back to `"contain"` in a window smaller than the canvas, so the game is never cut off.
- `"contain"`: the largest scale that fits (×3.125, bars top and bottom).
- `"stretch"`: each axis on its own; distorted, no bars.
- `"expand"`: the whole-number scale `"integer"` picks, then the canvas is widened to the window's shape (never below `width`), so
  a wide screen shows more of the world instead of bars. The game's width then changes with the window; the HUD's layout and the
  camera read it each frame.

**`pixelPerfect`.** With `true`, the frame starts with `TSE_OP_CANVAS`: libtse draws every record into a render texture of the
game's size (recreated only when the size changes, point-filtered), then clears the window to `border` and draws the texture
into the destination rectangle the player computed. A turned sprite stays made of square game pixels and half-pixel motion
snaps. With `false`, records are drawn straight into the window through views scaled by the fit's factor, and the bars are drawn
through a last view in window pixels: smooth rotation and sharp text, at the cost of "mixels". Most pixel-art games want `true`.

**The player owns the map.** Each frame `FrameBuilder.build` works out the scale and the destination rectangle, in TypeScript (the
C side only copies a rectangle where it is told), and uses them four ways: the camera centres on the canvas's centre; `<Hud>` and
its layout are in canvas units; the views (or the canvas record) are built from it; and the mouse is mapped back through it, so a
press in the bars reaches nothing. Handlers never see the window's size. Camera zoom still works inside the canvas, layout and
text measuring are in game pixels, and collisions, in world units, are untouched. Without a `<Screen>` the map is the identity
and output is byte-identical to a game without one.

`<Screen>` must be the root (or the only child of the root `<Game>`): the player looks for it there each frame, so a game can
change its resolution or `fit` from state. Anywhere else it warns once and acts as an `Entity`, which only the player can tell,
since what ends up at the root depends on another file. An `x` or `y` on it is a compile error.

Full screen is a key the player handles: `<Game fullscreenKey>` or `PlayerConfig.fullscreenKey` (default `"F11"`, `false` for
none), and Alt + Enter always (`tse_set_fullscreen`, a borderless window at the desktop's size).

## Not built, and what would pull it in

| Item | What would pull it in |
| --- | --- |
| Text wrapped by the width layout gives it (a `Text` reporting its widest word as its minimum, so boxes can shrink) | A dialogue box or label that must fit a growing box without a hand-set `maxWidth` |
| Aspect-ratio boxes | A portrait or minimap frame that keeps its shape while growing |
| Layout transitions (size and position animated) | A menu that should slide or resize smoothly; `transform` can be animated today |
| Wrapping columns, `align-content`, per-line growing, a `Grid` | A layout a wrapping row of fixed-size children cannot express |
| Dragging a scroll bar; Shift + wheel for the other axis | A long list on a mouse without a horizontal wheel |
| A flick that keeps a dragged scroll box going, and a drag that hands off to the box around it at an end | A long list on a phone that is slow to get through |
| Tiled (not stretched) nine-slice edges, a corner scale, a tint | A skin that does not stretch well |
| Vertical or two-thumb sliders, wheel adjusting | A settings menu that needs them |
| A sharp HUD over a pixel-perfect world (`<Hud pixelPerfect={false}>`) | Small text in a pixel-art HUD that is hard to read |
| Sub-pixel camera smoothing under `pixelPerfect` | A slow-scrolling game where the camera's steps show |
| Several canvases (split screen, a minimap) | A local multiplayer or minimap game |

## Ideas from Clay not used yet

From Clay's README and `clay.h` ([github.com/nicbarker/clay](https://github.com/nicbarker/clay)), for whoever picks up one of the
items above:

- **Text wrapping in the layout.** After the widths, Clay wraps each text against its final width from a cache of measured words
  (`Clay__MeasureTextCached`), so each word is measured once, and sets the height to `lineHeight × lines`. A text's minimum width
  is its widest word, which is what lets boxes shrink. Here the slot is between the width and height passes.
- **Aspect ratio** (`aspectRatio`): after the widths, `height = width / ratio`; after the heights, the width is set back.
- **Transitions:** an easing function, a duration, flags for which properties animate (position, size, colours, radius) and
  `enter` / `exit` states for elements that appear or leave. They need stable element IDs; `key` and the IR's element ids would
  play that part.
- **Visibility culling:** only elements with a pixel in the viewport produce render commands. Worth it if a UI ever has hundreds
  of items.
- **Floating boxes attached by ID** (`parentId`) to any element, not only the parent, and `expand` to grow past the parent.
- **Clip containers ignore their children's minimums** when fitting, since they hide what does not fit.
- **Retained output:** render commands carry the element's ID and are small enough to compare between frames to find what
  changed; relevant to a web backend.
