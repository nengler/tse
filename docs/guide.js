/* The guide's script, shared by every page of docs/: the element reference, the keys and diagnostics tables, code blocks, and the
 * searchable navigation. Each page loads search-index.js first, then this. */
(function () {
  "use strict";

  /* ---------- element reference data ---------- */
  var ELEMENTS = [
    { name: "Entity", kind: "container", sum: "A named container. The usual root of a component.",
      props: [["name", "string", '""', "Shown as <code>other.owner</code> in collisions."], ["opacity", "number", "1", "0 to 1, applied to the whole group at once (a popup or a card fading in) and multiplied with faded parents. A prop on every element."], ["inert", "boolean", "false", "The subtree hears no input, as the HTML attribute: its <code>useInput</code> and <code>useUpdate</code> get no keys, and its buttons cannot be pressed, hovered or focused. It still updates and draws. See <a href=\"effects.html#who-hears\">Who hears the keys</a>."], ["modal", "boolean", "false", "While mounted, everything outside this subtree is inert, as a <code>&lt;dialog&gt;</code> opened with <code>showModal()</code>: a pause screen or a prompt takes the keys and the focus. The modal mounted last wins."]] },
    { name: "Game", kind: "container, root only", sum: "The game's root and configuration. Optional; each prop overrides a default only where written. Settings are literals.",
      props: [
        ["id", "string", "none", "The game's id (letters, digits, <code>_</code>, <code>-</code>): the folder its save and settings are kept in. Without it nothing is kept. See <a href=\"effects.html#saved\">Saved data</a>."],
        ["title", "string", '"tse"', "Window title."],
        ["width", "number", "640", "Window width in pixels (resolution is <code>&lt;Screen&gt;</code>)."],
        ["height", "number", "360", "Window height in pixels."],
        ["background", "CSS colour", '"black"', "Window background."],
        ["assets", "string", '"assets"', "Folder that image, font and sound names are relative to."],
        ["resizable", "boolean", "true", "Allow resizing the window."],
        ["vsync", "boolean", "true", "Sync to the display."],
        ["smooth", "boolean", "false", "Bilinear filtering. Off keeps pixel art sharp."],
        ["upscale", '"nearest" | "sharp"', '"nearest"', "How a pixel-perfect <code>Screen</code> scales by a non-whole factor. <code>sharp</code> keeps edges crisp and pixels even."],
        ["fullscreenKey", "string | false", '"F11"', "Full-screen key. <code>false</code> disables it."],
        ["fixedStep", "number", "off", "Run <code>useUpdate</code> at this many steps per second. See <a href=\"effects.html#input\">Input and timing</a>."],
        ["interpolate", "boolean", "true (false hidden)", "With <code>fixedStep</code>, draw each frame between the last two steps, so motion is smooth on a 120 Hz, 144 Hz or variable-rate display. The game only sees whole steps. See <a href=\"effects.html#input\">Input and timing</a>."],
        ["timeScale", "number", "1", "How fast game time runs: with <code>fixedStep</code>, <code>2</code> runs two steps a frame (fast-forward, played exactly as at 1). May be state."],
        ["paused", "boolean", "false", "While true no <code>useUpdate</code> runs; input, presses and the focus still work. May be state."],
        ["textSize", "number", "16", "The size of every <code>&lt;Text&gt;</code> that sets none. Not inherited from containers."],
        ["textColor", "CSS colour", "\"white\"", "The colour of every <code>&lt;Text&gt;</code> that sets none."],
        ["overlayKey", "string | false", '"F1"', "Under <code>tse dev</code>: the key that outlines every box, collider and pointer. Never in a packaged game."],
        ["controls", "Controls", "–", "Named actions, imported from a <code>.ts</code> module: <code>controls={controls}</code>."],
        ["gamepadDeadzone", "number", "0.35", "How far the left stick must go before <code>PadLeft/Right/Up/Down</code> count as held."],
        ["showFps", "boolean", "false", "Show frame rate and script time, top-left."],
        ["fpsKey", "string | false", '"F3"', "Key that toggles the counter."],
        ["font", "string", "–", "The bitmap font of every <code>&lt;Text&gt;</code> without its own <code>font</code>: an image, or a built-in such as <code>\"tse:m5x7\"</code> (see Built-in fonts)."],
        ["name", "string", '""', "As on <code>Entity</code>."]
      ] },
    { name: "Screen", kind: "container, root only", sum: "A fixed game resolution, scaled to the window. The only child of <code>&lt;Game&gt;</code>.",
      props: [
        ["width", "number", "–", "Game pixels.", 1],
        ["height", "number", "–", "Game pixels.", 1],
        ["fit", '"integer" | "contain" | "stretch" | "expand"', '"integer"', "How it scales into the window. See <a href=\"systems.html#ui\">UI</a>."],
        ["pixelPerfect", "boolean", "true", "Draw at game resolution, then scale up."],
        ["border", "CSS colour", '"black"', "Colour of the bars around the game."]
      ] },
    { name: "Sprite", kind: "leaf", sum: "Draws an image, or one frame of a sheet.",
      props: [
        ["image", "string", "–", "File name under <code>assets</code>. A missing file draws magenta.", 1],
        ["frameWidth / frameHeight", "number", "–", "Size of one frame, to draw from a sheet (read left to right, then down)."],
        ["frame", "number", "0", "Which frame of the sheet."],
        ["flipX / flipY", "boolean", "false", "Mirror about the origin."],
        ["originX / originY", "number", "0", "The image pixel that sits at the object's position; flips and rotation turn about it."],
        ["tint", "CSS colour", "white", "Multiplies the image's colours. Its alpha is opacity too."],
        ["opacity", "number", "1", "0 to 1."],
        ["flash", "number", "0", "0 to 1: how far the image's colours are mixed toward <code>flashColor</code>; transparent pixels stay so. A hit flash: <code>flash={hit ? 0.8 : 0}</code> (a tint only darkens)."],
        ["flashColor", "CSS colour", "white", "The colour <code>flash</code> mixes toward."],
        ["shader", "string", "–", "A file under <code>assets</code> holding <code>vec4 effect(vec2 uv)</code> in GLSL: each of the sprite's pixels goes through it as it is drawn, with how the sprite is turned on the screen. See <a href=\"effects.html#sprite-shaders\">Shaders on a sprite</a>. The software renderer runs no shaders."],
        ["params", "number[]", "[]", "Up to eight numbers the shader reads as <code>params[0]</code> to <code>params[7]</code>."],
        ["lookup", "string", "–", "An image under <code>assets</code> the shader reads as <code>lookup</code>: a colour table, say. Without one it is a white pixel."]
      ] },
    { name: "AnimatedSprite", kind: "leaf", sum: "Plays a list of images, or named animations from a sheet. Takes the sprite options of <code>Sprite</code>.",
      props: [
        ["frames", "string[]", "–", "One image per frame. A different list restarts it."],
        ["fps", "number", "10", "Frames per second for <code>frames</code>."],
        ["playing", "boolean", "true", "<code>false</code> freezes on the current frame."],
        ["sheet", "string", "–", "One image holding every frame, instead of <code>frames</code>."],
        ["frameWidth / frameHeight", "number", "–", "Frame size on the sheet."],
        ["animations", "table | string", "–", "<code>{ idle: { frames: \"0-1\", fps: 4 }, die: { frames: \"8-12\", once: true } }</code>, or <code>\"idle:0-1@4, die:8-12@10~\"</code> (<code>~</code> plays once)."],
        ["animation", "string", "–", "Which one plays. A new name restarts it; the same name does nothing."],
        ["loop", "boolean", "true", "<code>false</code> plays each once."],
        ["flipX, flipY, originX, originY, tint, opacity, flash, flashColor, shader, params, lookup", "", "", "As on <code>Sprite</code>."]
      ] },
    { name: "Tilemap", kind: "leaf", sum: "A grid of tiles from a sheet, with no object per tile. See <a href=\"systems.html#tilemaps\">Tilemaps</a>.",
      props: [
        ["map", "string", "–", "Name of a registered Tiled map.", 1],
        ["image", "string", "the map's", "One sheet for the whole map. Leave it out to draw each tile from its own tileset's sheet, as saved in Tiled (the sheet must be in the assets folder)."],
        ["layer", "string", "all", "Draw only this layer."],
        ["opacity", "number", "1", "0 to 1."]
      ] },
    { name: "Text", kind: "leaf (text children)", sum: "One line of text, written as its children: <code>&lt;Text size={12}&gt;Score: {score}&lt;/Text&gt;</code>. There is no <code>text</code> attribute. As in React, <code>{null}</code>, <code>{undefined}</code> and booleans draw nothing, so <code>{maybe}</code> and <code>{done &amp;&amp; \"!\"}</code> work.",
      props: [
        ["text", "string", "–", "Set by the children, never written as an attribute: <code>&lt;Text&gt;{label}&lt;/Text&gt;</code>.", 1],
        ["size", "number", "16", "Pixels."],
        ["color", "CSS colour", '"white"', ""],
        ["width", "number", "text width", "Box width for layout and <code>align</code>."],
        ["align", '"left" | "center" | "right"', '"left"', "Where each line sits inside <code>width</code> (else inside <code>maxWidth</code>). Without a width, <code>x</code> is the left edge, middle or right edge of each line: <code>&lt;Text x={x} align=\"center\"&gt;</code> centres a damage number on a point. A text a <code>&lt;Flex&gt;</code> lays out without a width keeps its own place."],
        ["maxWidth", "number", "none", "Wrap to lines no wider than this: breaks at spaces, inside a word only when the word alone is too wide; <code>\\n</code> always breaks. One text record (or run of glyphs) per line."],
        ["lineGap", "number", "0", "Extra pixels between wrapped lines."],
        ["reveal", "number", "all", "Draw only the first <em>n</em> characters but lay out the whole text, so a box does not grow or rewrap as a page types out. Your game's code counts it up."],
        ["font", "string", "default", "A bitmap font image: ASCII 32–127 in 16 × 6 cells. <code>size</code> is then the cell height. A <code>tse:</code> name is a font built in, no file needed: <code>\"tse:small\"</code> (6 px a line, for 320 × 180), <code>\"tse:m5x7\"</code> (480 × 270), <code>\"tse:unscii\"</code> (640 × 360) and more (see Built-in fonts)."],
        ["shadow", "CSS colour", "none", "Draw the text again under itself in this colour, <code>shadowX</code> and <code>shadowY</code> pixels away. Takes no room in a layout, so leave padding for it."],
        ["shadowX / shadowY", "number", "1 / 1", "Where the shadow falls, in pixels right and down from the text (negative goes left and up). In the text's own axes, so it turns and scales with it."],
        ["outline", "CSS colour", "none", "Draw the text under itself in this colour at every pixel within <code>outlineWidth</code>, so each letter has an edge. Use an opaque colour. A shadow falls from the outlined shape. Takes no room."],
        ["outlineWidth", "number", "1", "How many pixels thick the outline is, 1 to 3 (more is drawn as 3: each pixel is more copies of the text)."]
      ] },
    { name: "Shape", kind: "leaf", sum: "A filled rectangle or ellipse, for debugging and prototyping.",
      props: [
        ["kind", '"rect" | "circle"', "–", "A circle is an ellipse filling its box.", 1],
        ["width", "number", "–", "Pixels.", 1],
        ["height", "number", "–", "Pixels.", 1],
        ["color", "CSS colour", '"white"', ""],
        ["opacity", "number", "1", "0 to 1: this and everything inside it, multiplied with faded parents. A prop on every element."]
      ] },
    { name: "Line", kind: "leaf", sum: "A straight line from where it is placed (<code>x</code>, <code>y</code>) to (<code>x2</code>, <code>y2</code>), both in the parent's space: a shot's trace, a tether. Square ends. Its own rotation and scale do not move the end, but a parent's rotation and scale apply to the whole line, thickness included.",
      props: [
        ["x2", "number", "–", "Where it ends, in the parent's space.", 1],
        ["y2", "number", "–", "", 1],
        ["width", "number", "1", "How thick, in pixels, centred on the line."],
        ["color", "CSS colour", '"white"', ""],
        ["opacity", "number", "1", "0 to 1: this and everything inside it, multiplied with faded parents. A prop on every element."]
      ] },
    { name: "Collider", kind: "leaf", sum: "An invisible box for collisions. See <a href=\"systems.html#collisions\">Collisions</a>.",
      props: [
        ["width", "number", "–", "Pixels.", 1],
        ["height", "number", "–", "Pixels.", 1],
        ["tag", "string", '""', "A label for handlers: <code>other.tag</code>."],
        ["layer", "string", '""', "The group it belongs to."],
        ["hits", "string[]", "all", "Layers it can touch."],
        ["shape", '"box" | "circle" | "polygon"', '"box"', "Its shape inside its box: the circle inside it, or the convex polygon of <code>points</code>. A pair with a shape is tested exactly, turned with its objects; bodies still stop at a solid collider's box."],
        ["points", "number[]", "[]", "A polygon's corners in order, <code>[x0, y0, x1, y1, …]</code>, in its own pixels, inside its box."],
        ["onCollisionEnter", "(other) =&gt; void", "–", "Starts touching. <code>other</code> has <code>tag</code> and <code>owner</code>."],
        ["onCollisionExit", "(other) =&gt; void", "–", "Stops touching."],
        ["onReceive", "(value) =&gt; void", "–", "What <code>send(tag, where, value)</code> sent it, at the end of the step's update phase; typed by its <code>tag</code> through <code>ColliderMessages</code>. A component's own sends never reach its own colliders. See <a href=\"systems.html#nearby-send\">nearby and send</a>."]
      ] },
    { name: "Pointer", kind: "leaf", sum: "An invisible clickable area. Pair with a <code>Sprite</code> or <code>Shape</code> to make a button.",
      props: [
        ["width", "number", "–", "Pixels.", 1],
        ["height", "number", "–", "Pixels.", 1],
        ["pressKey", "string", "–", "A key or action that presses it, while it is mounted: the button's own shortcut."],
        ["focusable", "boolean", "false", "Takes the focus: the arrows (or the <code>left</code>/<code>right</code>/<code>up</code>/<code>down</code> actions) move it, <code>confirm</code> (or Enter) presses it."],
        ["autoFocus", "boolean", "false", "Take the focus when mounted, if nothing has it."],
        ["onFocus", "() =&gt; void", "–", "Called when it takes the focus."],
        ["onBlur", "() =&gt; void", "–", "Called when it loses the focus."],
        ["onPointerEnter", "() =&gt; void", "–", "Called when the mouse comes over it (the topmost pressable under the mouse)."],
        ["onPointerLeave", "() =&gt; void", "–", "Called when the mouse leaves it, or something drawn over it takes the mouse."],
        ["onDragStart", "(x, y) =&gt; void", "–", "Called when a press lands on it, with where (a mouse and a finger alike)."],
        ["onDrag", "(x, y) =&gt; void", "–", "Called while that press is held, each time the pointer has moved, off the box included."],
        ["onDragEnd", "(x, y) =&gt; void", "–", "Called when that press is let go, with where. A tap is a start and an end with no <code>onDrag</code> between."],
        ["onPressOutside", "() =&gt; void", "–", "Called when a click or a tap lands anywhere but on it or on something inside it: what closes a menu or clears a choice."],
        ["originX / originY", "number", "0", "Where the area's origin is, from its top-left corner: <code>originX={5} originY={5}</code> centres a 10 × 10 area."],
        ["onPress", "() =&gt; void", "–", "Called when a press lands inside it, its <code>pressKey</code> is pressed, or it has the focus and <code>confirm</code> is pressed."]
      ] },
    { name: "Camera", kind: "container", sum: "The viewport. Follows its children. See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["zoom", "number", "1", "Magnification. Must be positive."],
        ["bounds", "[x, y, w, h]", "–", "The view never shows outside this world area (a smaller area is centred)."],
        ["slide", "number", "0", "Seconds to ease to new <code>bounds</code> (a room change)."],
        ["deadzone", "[width, height]", "none", "A box around the view's centre the followed point can move in without moving the view; past its edge it drags the view."],
        ["smoothing", "number", "0", "Seconds the view takes to catch up with what it follows (eases, stepped, so replays repeat). A change of <code>bounds</code> snaps the view at once."],
        ["shake", "ShakeState", "–", "From <code>useShake()</code>: <code>&lt;Camera shake={shake}&gt;</code>."]
      ] },
    { name: "Hud", kind: "container", sum: "A layer that stays on screen while the camera moves, drawn after the world. See <a href=\"systems.html#ui\">UI</a>.",
      props: [["inert", "boolean", "false", "The subtree hears no input, as the HTML attribute: its <code>useInput</code> and <code>useUpdate</code> get no keys, and its buttons cannot be pressed, hovered or focused. It still updates and draws. See <a href=\"effects.html#who-hears\">Who hears the keys</a>."], ["modal", "boolean", "false", "While mounted, everything outside this subtree is inert, as a <code>&lt;dialog&gt;</code> opened with <code>showModal()</code>: a pause screen or a prompt takes the keys and the focus. The modal mounted last wins."]] },
    { name: "Flex", kind: "container", sum: "Places children in a row or column. Also a button when given <code>onPress</code>. See <a href=\"systems.html#placing\">Placing things</a>.",
      props: [
        ["direction", '"row" | "column"', '"row"', "The main axis."],
        ["inert", "boolean", "false", "The subtree hears no input, as the HTML attribute: its <code>useInput</code> and <code>useUpdate</code> get no keys, and its buttons cannot be pressed, hovered or focused. It still updates and draws. See <a href=\"effects.html#who-hears\">Who hears the keys</a>."],
        ["modal", "boolean", "false", "While mounted, everything outside this subtree is inert, as a <code>&lt;dialog&gt;</code> opened with <code>showModal()</code>: a pause screen or a prompt takes the keys and the focus. The modal mounted last wins."],
        ["alignItems", '"start" | "center" | "end" | "stretch"', '"stretch"', "Where children sit across the main axis."],
        ["justifyContent", '"start" | "center" | "end" | "space-between" | "space-around" | "space-evenly"', '"start"', "How children and free space share the main axis."],
        ["gap", "number", "0", "Pixels between children."],
        ["wrap", "boolean", "false", "Start a new line when the next child will not fit (<code>direction=\"row\"</code> only; a column with <code>wrap</code> gets a warning and does not wrap): an inventory or a row of tags. Give the box a width (a number, a percentage or <code>\"grow\"</code>; a box that fits its children is one line). Lines stack downward, each as tall as its tallest child; <code>justifyContent</code> places each line's children and <code>alignItems</code> each child in its line's height. Children keep their size: a <code>\"grow\"</code> one is its content, none shrink, and one wider than the box is alone on its line."],
        ["rowGap / columnGap", "number", "<code>gap</code>", "Pixels between the lines of a wrapping row, and between the children of a line; each overrides <code>gap</code> (for a column, <code>rowGap</code> is between its children)."],
        ["padding", "number", "0", "All four sides."],
        ["paddingX / paddingY", "number", "–", "Horizontal / vertical. Override <code>padding</code>."],
        ["paddingTop / Right / Bottom / Left", "number", "–", "One side. Overrides the above."],
        ["width / height", '"fit" | "grow" | number | "N%"', '"fit"', "Sizing per axis."],
        ["minWidth / maxWidth / minHeight / maxHeight", "number", "–", "Bounds for a fit or grow size, in pixels."],
        ["background", "CSS colour", "none", "Filled rectangle behind the children, the size of the box."],
        ["opacity", "number", "1", "How opaque the box and everything in it is drawn, 0 (gone) to 1: a panel that fades in and out. It multiplies into every colour under the box (a box in a box at 0.5 is at 0.25). Each part is drawn at that opacity by itself, so while the box is partly transparent, overlapping parts show through each other. A box at 0 draws nothing but is still laid out and takes the mouse. With a <code>transition</code> a change of opacity fades."],
        ["backgroundImage", "image name", "–", "An image from the assets folder as the box's background, over <code>background</code> and under the children, cut into nine by <code>slice</code> so its corners keep their size and its edges and middle stretch: a bordered panel or button skin from one small picture. Without <code>slice</code> the whole image is stretched. A missing file is a compile error (and a magenta box if the name is computed)."],
        ["slice", "number", "0", "Pixels in from each edge of the image that are the corners and edges that do not stretch. A slice past the image is cut down to fit it, and a box smaller than its corners shrinks them together."],
        ["sliceTop / sliceRight / sliceBottom / sliceLeft", "number", "<code>slice</code>", "One side's slice. The four can differ: a panel with a deep bottom edge."],
        ["hoverBackgroundImage / focusBackgroundImage / pressedBackgroundImage / disabledBackgroundImage", "image name", "–", "<code>backgroundImage</code> in that state, in the same order as the colours (disabled over pressed over hover over focus). The slices stay; images change at once, a <code>transition</code> fades colours only."],
        ["overflow", '"visible" | "hidden" | "scroll"', '"visible"', "What happens to children outside the box. <code>\"hidden\"</code> clips them to it (a child cannot be pressed where it is cut off). <code>\"scroll\"</code> also lets the mouse wheel or a drag (a finger's, or the mouse's) move the content, and stops the children shrinking to fit; give the box a size, or a <code>maxHeight</code>, smaller than its content."],
        ["scrollX / scrollY", "number", "0", "How far a scroll box's content is moved left / up, in pixels. The wheel and a drag change it; setting the prop moves it there, clamped to the content (<code>scrollY={9999}</code> keeps a log at its end)."],
        ["scrollbar", "boolean", "true", "A scroll box shows a thin bar along each axis its content overflows. The bar's length is to the box as the box is to its content, and its position shows how far the box is scrolled. When the focus moves to something inside a scroll box (a menu's next item), the box scrolls it into view."],
        ["scrollbarColor / scrollbarWidth", "CSS colour / number", '"#ffffff80" / 3', "The scroll bar's colour and thickness in pixels."],
        ["borderWidth", "number", "0", "Pixels of border, drawn inside the edge in <code>borderColor</code>. It takes room: it counts as padding on every side. No border without a colour."],
        ["borderColor", "CSS colour", "none", "The border's colour."],
        ["borderRadius", "number", "0", "Pixels of corner rounding on the background and the border, at most half the shorter side."],
        ["hoverBackground / hoverBorderColor", "CSS colour", "–", "<code>background</code> / <code>borderColor</code> while the mouse is over it. A box with one takes the mouse, and lets a press through to what is under it unless it has an <code>onPress</code>."],
        ["focusBackground / focusBorderColor", "CSS colour", "–", "<code>background</code> / <code>borderColor</code> while it has the focus (<code>focusable</code>). Hover wins when both apply."],
        ["pressedBackground / pressedBorderColor", "CSS colour", "–", "<code>background</code> / <code>borderColor</code> while the mouse button is held on it (a press that began on it, the mouse still over it). Over hover and focus."],
        ["disabled", "boolean", "false", "Switched off, as a DOM button's: <code>onPress</code> is not called by a click, <code>pressKey</code> or confirm, it cannot take the focus, and a click on it is swallowed, not passed to what is under it. The pointer callbacks still run."],
        ["disabledBackground / disabledBorderColor", "CSS colour", "–", "<code>background</code> / <code>borderColor</code> while it is <code>disabled</code>. Over every other state: a disabled box never looks hovered or pressed."],
        ["transition", "number", "0", "Seconds to fade <code>background</code> and <code>borderColor</code> when the state changes (hover, press, focus, disabled), and <code>opacity</code> when it changes, instead of snapping. A fade cut short turns round from the colour it had reached. Only colours fade, so nothing moves."],
        ["onPress", "() =&gt; void", "–", "Called when a press lands on the laid-out box."],
        ["pressKey", "string", "–", "A key or action that presses it, while it is mounted: the button's own shortcut."],
        ["focusable", "boolean", "false", "Takes the focus: the arrows (or the <code>left</code>/<code>right</code>/<code>up</code>/<code>down</code> actions) move it, <code>confirm</code> (or Enter) presses it."],
        ["onAdjust", "(direction: number) =&gt; void", "–", "With the focus, left (-1) and right (1) call it and the focus stays: a settings row. Up and down still move the focus."],
        ["autoFocus", "boolean", "false", "Take the focus when mounted, if nothing has it."],
        ["onFocus", "() =&gt; void", "–", "Called when it takes the focus."],
        ["onBlur", "() =&gt; void", "–", "Called when it loses the focus."],
        ["onPointerEnter", "() =&gt; void", "–", "Called when the mouse comes over it (the topmost pressable under the mouse)."],
        ["onPointerLeave", "() =&gt; void", "–", "Called when the mouse leaves it, or something drawn over it takes the mouse."],
        ["onDragStart", "(x, y) =&gt; void", "–", "Called when a press lands on it, with where (a mouse and a finger alike)."],
        ["onDrag", "(x, y) =&gt; void", "–", "Called while that press is held, each time the pointer has moved, off the box included."],
        ["onDragEnd", "(x, y) =&gt; void", "–", "Called when that press is let go, with where. A tap is a start and an end with no <code>onDrag</code> between."],
        ["onPressOutside", "() =&gt; void", "–", "Called when a click or a tap lands anywhere but on it or on something inside it: what closes a menu or clears a choice."],
        ["float", "boolean", "false", "Take the box out of its parent's flow."],
        ["anchor", "9-point anchor", '"top-left"', "Which point of this box is attached. One of <code>top-left top-center top-right center-left center center-right bottom-left bottom-center bottom-right</code>."],
        ["to", "9-point anchor", '"top-left"', "Which point of the parent it attaches to."],
        ["offsetX / offsetY", "number", "0", "Pixels right / down from where the points meet."]
      ] },
    { name: "Slider", kind: "leaf, a Flex", sum: "A horizontal slider: a press puts the thumb under the mouse, a drag moves it, and with the focus the left and right keys move it. It is a <code>Flex</code> in every other way, so it takes every <code>Flex</code> prop that is not about children (size, <code>background</code> for the track, border, radius, <code>opacity</code>, <code>disabled</code>, a colour for each state). See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["value", "number", "min", "Where the thumb is. The slider moves it itself and tells <code>onChange</code>; setting the prop moves it there."],
        ["min / max", "number", "0 / 1", "The values at the left and right ends."],
        ["step", "number", "0", "A value is a whole number of these from <code>min</code> (0: any value). A key moves it one step, or a twentieth of the range with no step."],
        ["onChange", "(value: number) =&gt; void", "–", "Called with the new value when the user moves the thumb, and only for a different value."],
        ["fillColor", "CSS colour", "blue", "The track left of the thumb. <code>\"transparent\"</code> for none."],
        ["thumbColor", "CSS colour", "white", "The thumb."],
        ["thumbWidth", "number", "8", "Pixels."],
        ["width / height", '"fit" | "grow" | number | "N%"', "100 / 14", "Sizing, as for a <code>Flex</code>."]
      ] },
    { name: "Toggle", kind: "leaf, a Flex", sum: "An on and off switch: a pill-shaped track with a knob at its right end when on and its left when off. A press, the confirm key with the focus, or its <code>pressKey</code> flips it. It is a <code>Flex</code> in every other way (a <code>borderWidth</code> and <code>focusBorderColor</code> make a focus ring). See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["checked", "boolean", "false", "Whether it is on. The toggle flips it itself and tells <code>onChange</code>; setting the prop sets it."],
        ["onChange", "(checked: boolean) =&gt; void", "–", "Called with the new state when the user flips it."],
        ["onColor / offColor", "CSS colour", "green / grey", "The track when on and when off."],
        ["thumbColor", "CSS colour", "white", "The knob."],
        ["width / height", '"fit" | "grow" | number | "N%"', "36 / 18", "Sizing, as for a <code>Flex</code>."]
      ] },
    { name: "Button", kind: "container, a Flex", sum: "A button: a <code>Flex</code> that takes the focus, with a look for each state (plain, hover, focus, pressed, disabled) and its label as children: <code>&lt;Button onPress={start}&gt;&lt;Text&gt;Play&lt;/Text&gt;&lt;/Button&gt;</code>. A click, the confirm key with the focus, or its <code>pressKey</code> presses it. Every <code>Flex</code> prop works and replaces the default look. See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["onPress", "() =&gt; void", "–", "Called when it is clicked, its <code>pressKey</code> is pressed, or confirm is pressed while it has the focus."],
        ["onAdjust", "(direction: number) =&gt; void", "–", "Left (-1) or right (1) while it has the focus: a settings row that changes its value. The focus stays."],
        ["focusable", "boolean", "true", "Takes the focus. A button does unless it says <code>false</code>."],
        ["background / hoverBackground / focusBackground / pressedBackground / disabledBackground", "CSS colour", "a dark blue set", "Its look in each state; any one replaces the default."],
        ["paddingX / paddingY", "number", "6 / 3", "Room round the label."],
        ["alignItems / justifyContent", "as Flex", '"center"', "The label is centred."]
      ] },
    { name: "Menu", kind: "container, a Flex", sum: "A menu: a <code>Flex</code> column whose focusable children (usually <code>Button</code>s) are its items. While one has the focus, the direction keys move it among the menu's items only, going round at the ends, and <code>back</code> (or Escape, PadB) calls <code>onBack</code>. <code>autoFocus</code> on an item starts there. It adds no look: style it as a <code>Flex</code>. See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["loop", "boolean", "true", "The focus goes round from the last item to the first and back. <code>false</code> stops at the ends."],
        ["onBack", "() =&gt; void", "–", "Called when <code>back</code> is pressed while one of its items has the focus: close the menu."],
        ["direction", '"row" | "column"', '"column"', "A menu is a column unless it says otherwise."]
      ] },
    { name: "Tooltip", kind: "container, a Flex", sum: "A tip that shows while the mouse is over the box it is in, or that box has the focus: a floating <code>Flex</code> above its parent (z 100) that takes no space. Put it among the box's children: <code>&lt;Button&gt;&lt;Text&gt;Sell&lt;/Text&gt;&lt;Tooltip&gt;&lt;Text&gt;5 gold&lt;/Text&gt;&lt;/Tooltip&gt;&lt;/Button&gt;</code>. Its parent takes the mouse for it, so any <code>Flex</code> can have one. Every <code>Flex</code> prop changes its look (<code>TOOLTIP_DEFAULTS</code>). See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["show", "boolean", "–", "<code>true</code> shows it always, <code>false</code> never; left out, it shows while its box has the mouse or the focus."],
        ["anchor / to", "nine points", '"bottom-center" / "top-center"', "Where it is attached: by default its bottom middle to its parent's top middle, 2 pixels above. <code>anchor=\"center-left\" to=\"center-right\"</code> puts it beside."]
      ] },
    { name: "TextInput", kind: "a Flex, no children", sum: "A one-line text field: <code>&lt;TextInput value={s.name} placeholder=\"Your name\" maxLength={12} onChange={(v) =&gt; { s.name = v; }} onSubmit={start} /&gt;</code>. Focus it (a click, or the arrows) and type: characters go in at the end, Backspace takes the last one off, Enter calls <code>onSubmit</code>, and a caret shows while it has the focus. While it has the focus, letters do not trigger the game's <code>confirm</code>, <code>back</code> or <code>pressKey</code>s. Text longer than the field scrolls to show its end. Every <code>Flex</code> prop changes its look (<code>TEXT_INPUT_DEFAULTS</code>). See <a href=\"systems.html#ui\">UI</a>.",
      props: [
        ["value", "string", '""', "The text. Typing changes it and calls <code>onChange</code>; setting the prop puts it there, so state can change or refuse what is typed."],
        ["placeholder / placeholderColor", "string / CSS colour", '– / "#8088a0"', "Shown while the field is empty."],
        ["maxLength", "number", "no limit", "The most characters it takes."],
        ["onChange", "(value: string) =&gt; void", "–", "Called with the new text when typing or Backspace changes it."],
        ["onSubmit", "(value: string) =&gt; void", "–", "Called with the text when Enter is pressed while it has the focus."],
        ["color / textSize / caretColor", "CSS colour / number / CSS colour", "the game's / the game's / \"#f2d17a\"", "The text's colour and size, and the caret's colour."]
      ] },
    { name: "Router", kind: "container, not placed", sum: "Shows one <code>Route</code> at a time, with an optional transition. See <a href=\"systems.html#router\">Screens</a>.",
      props: [
        ["route", "string", "–", "Name of the <code>Route</code> to show. Changing it switches screens.", 1],
        ["transition", "function", "none", "<code>(progress, from, to) =&gt; frame</code>, from a <code>.ts</code> file."],
        ["duration", "number", "0.4", "Seconds a transition takes."],
        ["coverColor", "CSS colour", '"black"', "Colour a transition's <code>cover</code> fades to."]
      ] },
    { name: "Route", kind: "container, not placed", sum: "One screen of a <code>Router</code>. In the world only while shown, being left, or being entered.",
      props: [
        ["name", "string", "–", "What the router's <code>route</code> calls it.", 1],
        ["keepAlive", "boolean", "false", "Keep its components and their state while hidden. Off: each visit starts fresh."]
      ] },
    { name: "Provider", kind: "container, not placed", sum: "Written <code>&lt;Theme.Provider value={…}&gt;</code>: gives a context's value to every <code>useContext(Theme)</code> below it. Layout sees through it; it draws nothing.",
      props: [
        ["context", "Context", "–", "The context (<code>createContext</code> in a <code>.ts</code> file). Written as the tag: <code>&lt;Theme.Provider&gt;</code>.", 1],
        ["value", "the context's type", "–", "What its readers read. A new value renders every reader again.", 1]
      ] },
    { name: "Particles", kind: "leaf", sum: "An emitter of small squares for dust, trails or snow. It makes no game object per particle, and it draws from a seeded generator, so runs repeat.",
      props: [
        ["rate", "number", "0", "Particles per second while <code>emitting</code>."],
        ["burst", "number", "0", "Made at once when <code>emitting</code> turns on, or on mount."],
        ["emitting", "boolean", "true", "Whether it makes particles. Those in the air carry on."],
        ["lifetime", "number", "0.5", "Seconds a particle lives."],
        ["speed", "number", "40", "Start speed, pixels per second."],
        ["angle", "number", "270", "Degrees: 0 right, 90 down, 180 left, 270 up."],
        ["spread", "number", "30", "Degrees either side of <code>angle</code>. 180 is every direction."],
        ["gravity", "number", "0", "Pixels per second² down. Negative floats up."],
        ["color / endColor", "CSS colour", "white", "Start colour, and the colour it ages to."],
        ["size", "number", "2", "Side of the square, in pixels."],
        ["shrink / fade", "boolean", "false", "Shrink or fade to nothing over its life."],
        ["max", "number", "64", "Most alive at once; the oldest is replaced."],
        ["space", '"local" | "world"', '"local"', "<code>world</code> leaves particles where they were made (a trail)."],
        ["width / height", "number", "0", "Area particles start in, right and down from the emitter."],
        ["prewarm", "boolean", "false", "Start as if already emitting for a lifetime."],
        ["seed", "number", "1", "Seeds the randomness."]
      ] },
    { name: "ParticleLayer", kind: "leaf", sum: "Where a particle store's bursts are drawn, like a toast library's <code>&lt;Toaster /&gt;</code>. See <a href=\"effects.html#effects\">Effects</a>.",
      props: [["particles", "ParticleStore", "–", "From <code>createParticles({ … })</code> in a <code>.ts</code> module.", 1]] },
    { name: "Layer", kind: "container", sum: "Its children are drawn off screen, into a layer the size of the screen, which is then laid over what is under it with a blend mode: <code>&lt;Layer blend=\"multiply\" clear=\"#1a1a2e\" childBlend=\"add\"&gt;</code> with light sprites in it is a dark cave lit by lanterns. Layers nest four deep. Inside a layer children are drawn in tree order (a <code>z</code> there is ignored); the layer is drawn at its own <code>z</code>.",
      props: [
        ["blend", '"normal" | "add" | "multiply" | "screen"', '"normal"', "How the layer is laid over what is under it: <code>multiply</code> shades (white leaves it, black darkens it), <code>add</code> brightens, <code>screen</code> brightens but never past white."],
        ["childBlend", '"normal" | "add" | "multiply" | "screen"', '"normal"', "How each child is drawn onto the layer: <code>add</code> makes overlapping lights add up."],
        ["clear", "CSS colour", '"transparent"', "What the layer holds before its children are drawn, each frame: black for a light map."],
        ["opacity", "number", "1", "How strongly the layer is laid over what is under it."],
        ["shader", "string", "–", "A file under <code>assets</code> holding <code>vec4 effect(vec2 uv)</code> in GLSL. Each of the layer's pixels goes through it as the layer is laid over; see Shaders. The software renderer runs no shaders."],
        ["params", "number[]", "[]", "Up to eight numbers the shader reads as <code>params[0]</code> to <code>params[7]</code>."],
      ] },
    { name: "Light", kind: "leaf", sum: "A soft disc of light, brightest at its middle, falling off smoothly to nothing at <code>radius</code>. Put it in a <code>&lt;Lighting&gt;</code>, where lights that overlap add up; placed with <code>x</code> and <code>y</code> at its middle.",
      props: [
        ["radius", "number", "–", "How far it reaches, in pixels.", 1],
        ["color", "CSS colour", '"#fff3dc"', "Its colour at the middle: a warm white by default."],
        ["intensity", "number", "1", "How strong it is, 0 to 1."],
      ] },
    { name: "Lighting", kind: "container", sum: "The world as light reaches it: everything under it is darkened to <code>ambient</code>, except where its <code>&lt;Light&gt;</code> children shine. It is a <code>&lt;Layer blend=\"multiply\" childBlend=\"add\" clear={ambient}&gt;</code> set up for you. Put it after what it lights, before the HUD.",
      props: [
        ["ambient", "CSS colour", '"#101018"', "The darkness where no light reaches; black for none at all."],
        ["opacity", "number", "1", "How strongly the darkness is laid over the world."],
        ["shader", "string", "–", "A shader the light map goes through, as on a <code>&lt;Layer&gt;</code>."],
        ["params", "number[]", "[]", "The shader's eight numbers."],
      ] },
    { name: "Fade", kind: "leaf, not placed", sum: "A full-screen cover that fades to a colour and back. Put it in a <code>&lt;Hud&gt;</code>.",
      props: [
        ["on", "boolean", "false", "<code>true</code> fades to <code>color</code>; <code>false</code> fades back."],
        ["color", "CSS colour", '"black"', ""],
        ["duration", "number", "0.25", "Seconds a full fade takes. 0 switches at once."],
        ["from", "number", "0", "How covered it starts, 0 to 1. <code>from={1}</code> fades in as the screen begins."]
      ] },
    { name: "Music", kind: "leaf, not placed", sum: "Streamed, looping music. It plays while mounted, so put it in the root, where screen changes do not unmount it.",
      props: [
        ["src", "string", "–", "File under <code>assets</code> (<code>.ogg</code>, <code>.mp3</code>, <code>.wav</code>).", 1],
        ["playing", "boolean", "true", "Off fades out then stops; on restarts from the beginning."],
        ["volume", "number", "1", "0 to 1. A change fades over <code>fade</code>."],
        ["loop", "boolean", "true", ""],
        ["fade", "number", "0.5", "Seconds a full fade takes. 0 switches at once."]
      ] }
  ];

  var TRANSFORM_NOTE = { Game: 0, Screen: 0, Router: 0, Route: 0, Fade: 0, Music: 0 };

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  var idx = document.getElementById("element-index");
  var docs = document.getElementById("element-docs");
  if (docs) ELEMENTS.forEach(function (el) {
    var c = document.createElement("a");
    c.className = "card"; c.href = "#el-" + el.name; c.style.textDecoration = "none"; c.style.color = "inherit";
    c.innerHTML = "<b>&lt;" + el.name + "&gt;</b><p>" + el.sum.split(". ")[0].replace(/\.$/, "") + "</p>";
    idx.appendChild(c);

    var d = document.createElement("div");
    d.id = "el-" + el.name;
    d.setAttribute("data-search", el.name + " " + el.sum + " " + el.props.map(function (p) { return p[0] + " " + p[3]; }).join(" "));
    var rows = el.props.map(function (p) {
      return "<tr><td><code>" + p[0] + "</code>" + (p[4] ? '<span class="req">required</span>' : "") + '</td><td class="type">' + esc(p[1]).replace(/&amp;lt;/g, "&lt;") + '</td><td class="type">' + esc(p[2]) + "</td><td>" + p[3] + "</td></tr>";
    }).join("");
    var tr = (el.name in TRANSFORM_NOTE) ? "Not placed: no <code>x</code> or <code>y</code>." : "Placed with <code>x</code>, <code>y</code>, <code>z</code>, <code>rotation</code>, <code>scaleX</code>, <code>scaleY</code> and <code>global</code>.";
    d.innerHTML = '<h3 data-nav="&lt;' + el.name + "&gt;\">&lt;" + el.name + '&gt; <span class="tag">' + el.kind + "</span></h3><p>" + el.sum + " " + tr + "</p>" +
      (rows ? '<div class="tablewrap"><table><tr><th>Prop</th><th>Type</th><th>Default</th><th>Notes</th></tr>' + rows + "</table></div>" : "");
    docs.appendChild(d);
  });

  /* ---------- keys ---------- */
  var keys = ["Space", "Enter", "Escape", "Tab", "Backspace", "Shift", "Control", "Alt", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  var letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  var digits = "0123456789".split("");
  var fkeys = []; for (var i = 1; i <= 12; i++) fkeys.push("F" + i);
  var mouse = ["MouseLeft", "MouseRight", "MouseMiddle"];
  var pad = ["PadA", "PadB", "PadX", "PadY", "PadLB", "PadRB", "PadBack", "PadStart", "PadLeft", "PadRight", "PadUp", "PadDown"];
  function chips(list) { return list.map(function (k) { return "<code>" + k + "</code>"; }).join(" "); }
  var keysEl = document.getElementById("keys");
  if (keysEl) keysEl.innerHTML =
    '<div class="tablewrap"><table><tr><th>Group</th><th>Names (case-sensitive)</th></tr>' +
    "<tr><td>Control</td><td>" + chips(keys) + "</td></tr>" +
    "<tr><td>Letters</td><td>" + chips(letters) + " <small>(uppercase: <code>input.down(\"D\")</code>)</small></td></tr>" +
    "<tr><td>Digits</td><td>" + chips(digits) + "</td></tr>" +
    "<tr><td>Function</td><td>" + chips(fkeys) + "</td></tr>" +
    "<tr><td>Mouse</td><td>" + chips(mouse) + " <small>(mouse buttons are keys too)</small></td></tr>" +
    "<tr><td>Gamepad</td><td>" + chips(pad) + " <small>(first pad; the d-pad or left stick gives the four directions)</small></td></tr></table></div>";

  /* ---------- diagnostics ---------- */
  var DIAG = [
    ["Project and syntax", [
      ["TSE1001", "Unsupported syntax, an import that is not from the authoring module, a <code>.tsx</code> component or a <code>.ts</code> file, or a top-level value that is not a <code>const</code> (or holds JSX or the game state)."],
      ["TSE1002", "A component body that is not hooks, derived <code>const</code>s, then one <code>return</code>."],
      ["TSE1003", "The root is not a built-in element, a component, a fragment, a condition of elements or <code>null</code>."],
      ["TSE1004", "A name imported from <code>@tsengine/runtime/jsx</code> that it does not export, or <code>type</code> misused."],
      ["TSE1005", "A hook, element or runtime function used without importing it."]]],
    ["Hooks and state", [
      ["TSE1101", "A hook, or a custom hook, not called as a statement of the component body."],
      ["TSE1102", "An unknown <code>use*</code> call. For <code>onUpdate</code>, <code>onInput</code> or <code>onCollisionEnter</code> called as a hook, the message names its replacement; for <code>useEffect</code>, it says what to write instead."],
      ["TSE1103", "<code>useMutable</code> not in the form <code>const s = useMutable({ a: 0 })</code>, or a name declared twice."],
      ["TSE1104", "A <code>useMutable</code> field whose type the compiler cannot infer. Give it with <code>as</code>: <code>spawns: [] as Spawn[]</code>."],
      ["TSE1106", "<code>ref={…}</code> on an element: what is on screen follows state and props."],
      ["TSE1107", "<code>useSound</code> with a non-literal path, or a name already taken."],
      ["TSE1108", "A <code>useGame</code> selector that is not a valid path, or a bad import from <code>.ts</code>."],
      ["TSE1109", "A <code>GameState.ts</code> the compiler cannot read."]]],
    ["JSX and props", [
      ["TSE1201", "An unknown component tag."],
      ["TSE1202", "An unsupported JSX child (text, fragment, arbitrary expression)."],
      ["TSE1203", "An unsupported attribute, or <code>key</code> on a component's root (it goes where the component is used)."],
      ["TSE1205", "A component that contains itself, directly or through other files."],
      ["TSE1206", "Two files export the same component name."],
      ["TSE1207", "A <code>transform</code> attribute: there is none. Write <code>x</code>, <code>y</code> and the rest as props of a built-in, and wrap a component in <code>&lt;Entity x={…} y={…}&gt;</code> to place it. Also <code>x</code> and the rest on a built-in that cannot be placed."],
      ["TSE1208", "A props parameter or props type not in the supported form, or a prop passed the wrong way."],
      ["TSE1209", "A keyed list not in the supported form."],
      ["TSE1210", "A literal that is not allowed for a prop (<code>&lt;Shape kind=\"oval\"&gt;</code>), or <code>&lt;Game controls&gt;</code> that is not an imported name. Lists the choices."],
      ["TSE1211", "An image, font, music or <code>useSound</code> path that is not a file in the <code>--assets</code> folder. Suggests the nearest name."]]],
    ["Expressions and handlers", [
      ["TSE1301", "An unsupported expression."],
      ["TSE1302", "An unknown identifier."],
      ["TSE1305", "A sound function called outside a handler."],
      ["TSE1401", "An invalid handler (wrong parameters, redeclaration, rebinding <code>Math</code>)."],
      ["TSE1402", "An unsupported statement, an assignment to anything but a <code>useMutable</code> field or a <code>let</code>, or writing a field in <code>useUnmount</code>."]]],
    ["Scenes", [
      ["TSE1501", "A scene that is not valid JSON."],
      ["TSE1502", "A scene with the wrong shape."],
      ["TSE1503", "An unknown prefab."],
      ["TSE1504", "An unknown prop for a prefab."],
      ["TSE1505", "A required prop is missing."],
      ["TSE1506", "A prop of the wrong type."],
      ["TSE1507", "A prop data cannot set (it is code-only)."],
      ["TSE1508", "A duplicate scene id."],
      ["TSE1509", "A Tiled import problem."]]],
    ["Type checks", [
      ["TSE9001", "A type error in generated code, reported at the line of the <code>.tsx</code> it was written for (and where it was found in the generated file)."],
      ["TSE9002", "A type error in your TSX source."]]],
    ["Retired codes (never reported, never reused)", [
      ["TSE1105", "<code>useTransform</code>. Place an element with its <code>x</code> and <code>y</code> props."],
      ["TSE1204", "Props on a local or imported component. They are allowed."],
      ["TSE1303", "A non-constant initial state. An initial value may read state declared above it."],
      ["TSE1403", "A duplicate handler. A component may have several of one kind; they run in source order."]]]
  ];
  var dh = "";
  DIAG.forEach(function (g) {
    dh += "<h3>" + g[0] + '</h3><div class="tablewrap"><table><tr><th>Code</th><th>Meaning</th></tr>' +
      g[1].map(function (r) { return "<tr id=\"" + r[0] + "\"><td><code>" + r[0] + "</code></td><td>" + r[1] + "</td></tr>"; }).join("") + "</table></div>";
  });
  var diagEl = document.getElementById("diag"); if (diagEl) diagEl.innerHTML = dh;

  /* ---------- tables: on a phone, a row of three or more columns reads as a card ---------- */
  document.querySelectorAll(".tablewrap table").forEach(function (table) {
    var head = table.rows[0];
    if (!head || head.cells.length < 3 || head.cells[0].tagName !== "TH") return;
    var labels = [].map.call(head.cells, function (c) { return c.textContent.trim(); });
    table.parentNode.classList.add("stack");
    [].slice.call(table.rows, 1).forEach(function (row) {
      [].forEach.call(row.cells, function (cell, i) {
        if (i > 0 && labels[i]) cell.setAttribute("data-label", labels[i]);
        if (i > 0 && /^[\s–]*$/.test(cell.textContent)) cell.classList.add("blank");
      });
    });
  });

  /* ---------- code blocks ---------- */
  var KW = /^(import|from|export|default|function|const|let|return|if|else|interface|type|new|as|true|false|null|undefined|extends|typeof|async|await)$/;
  var TOKEN = /(\{\s*\/\*[\s\S]*?\*\/\s*\}|\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*(?=\n|$))|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(<\/?[A-Z][A-Za-z0-9]*|\/>|<>|<\/>)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)/g;
  function highlight(src, lang) {
    if (lang === "sh") {
      return esc(src).replace(/(#[^\n]*)/g, '<span class="c">$1</span>');
    }
    var out = "", last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(src))) {
      out += esc(src.slice(last, m.index));
      var t = m[0];
      if (m[1]) out += '<span class="c">' + esc(t) + "</span>";
      else if (m[2]) out += '<span class="s">' + esc(t) + "</span>";
      else if (m[3]) out += '<span class="t">' + esc(t) + "</span>";
      else if (m[4]) out += '<span class="n">' + t + "</span>";
      else if (m[5] && KW.test(t)) out += '<span class="k">' + t + "</span>";
      else out += esc(t);
      last = m.index + t.length;
    }
    return out + esc(src.slice(last));
  }
  document.querySelectorAll("pre.code").forEach(function (pre) {
    var s = pre.querySelector("script");
    if (!s) return;
    var lang = pre.getAttribute("data-lang") || "";
    var src = s.textContent.replace(/^\n+|\s+$/g, "");
    pre.innerHTML = "<code>" + highlight(src, lang) + "</code>";
    var box = document.createElement("div"); box.className = "codebox";
    box.innerHTML = '<div class="codebar"><span class="lang">' + lang + '</span><button type="button" class="copy">Copy</button></div>';
    pre.parentNode.insertBefore(box, pre); box.appendChild(pre);
    box.querySelector("button").addEventListener("click", function (e) {
      var b = e.currentTarget;
      function done(ok) { b.textContent = ok ? "Copied" : "Press Ctrl+C"; setTimeout(function () { b.textContent = "Copy"; }, 1500); }
      try {
        navigator.clipboard.writeText(src).then(function () { done(true); }, function () { sel(); });
      } catch { sel(); }
      function sel() {
        var r = document.createRange(); r.selectNodeContents(pre.querySelector("code"));
        var g = window.getSelection(); g.removeAllRanges(); g.addRange(r); done(false);
      }
    });
  });

  /* ---------- navigation ---------- */
  /* MANIFEST, the sections of every page and their search text, is defined by search-index.js, loaded before this file. */
  var CUR = location.pathname.split("/").pop() || "index.html";
  if (!MANIFEST.some(function (m) { return m.page === CUR; })) CUR = "index.html";
  var nav = document.getElementById("nav");
  var links = [], lastGroup = null;
  MANIFEST.forEach(function (m) {
    if (m.group !== lastGroup) { var h = document.createElement("h4"); h.textContent = m.group; nav.appendChild(h); lastGroup = m.group; }
    var a = document.createElement("a");
    a.href = (m.page === CUR ? "" : m.page) + "#" + m.id; a.textContent = m.title; a.dataset.group = m.group;
    nav.appendChild(a);
    links.push({ a: a, m: m, sec: m.page === CUR ? document.getElementById(m.id) : null, text: m.text });
  });
  var sections = links.filter(function (l) { return l.sec; }).map(function (l) { return l.sec; });
  var none = document.createElement("div"); none.className = "none"; none.hidden = true; none.textContent = "Nothing matches."; nav.appendChild(none);

  var q = document.getElementById("q");
  var menu = document.getElementById("menu");
  menu.addEventListener("click", function () { nav.classList.toggle("open"); });
  nav.addEventListener("click", function (e) { if (e.target.tagName === "A") nav.classList.remove("open"); });

  q.addEventListener("input", function () {
    var v = q.value.trim().toLowerCase();
    var shown = 0, hasGroup = {};
    links.forEach(function (l) {
      var ok = !v || l.text.indexOf(v) !== -1 || l.a.textContent.toLowerCase().indexOf(v) !== -1;
      l.a.hidden = !ok; if (l.sec) l.sec.style.display = ok ? "" : "none";
      if (ok) { shown++; hasGroup[l.a.dataset.group] = true; }
    });
    nav.querySelectorAll("h4").forEach(function (h) { h.hidden = !hasGroup[h.textContent]; });
    none.hidden = shown !== 0;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== q && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
    if (e.key === "Escape" && document.activeElement === q) { q.value = ""; q.dispatchEvent(new Event("input")); q.blur(); }
  });

  /* highlight current section while scrolling */
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (l) { l.a.classList.toggle("on", l.sec === en.target); });
        }
      });
    }, { rootMargin: "-10% 0px -80% 0px" });
    sections.forEach(function (s) { io.observe(s); });
  }
})();
