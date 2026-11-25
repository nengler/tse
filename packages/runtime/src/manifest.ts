import { FLEX_ALIGN_ITEMS, FLEX_ANCHORS, FLEX_DIRECTIONS, FLEX_JUSTIFY_CONTENT, FLEX_OVERFLOW } from "./components/Flex.ts";
import { BLEND_MODES } from "./components/Layer.ts";
import { PARTICLE_SPACES } from "./components/Particles.ts";
import { SCREEN_FITS } from "./components/Screen.ts";
import { SHAPE_KINDS } from "./components/Shape.ts";
import { TEXT_ALIGNS } from "./components/Text.ts";
import { COLLIDER_SHAPES } from "./shapes.ts";

/**
 * Everything the compiler needs to know about this runtime, in one place.
 * The compiler takes a manifest as config, so adding an intrinsic or a handle
 * type here needs no compiler edit.
 */
export interface RuntimeManifest {
  /**
   * The module component source imports hooks, built-in elements and runtime
   * functions from. The compiler accepts imports from it (and from `.tsx`
   * components) and nothing else.
   */
  readonly authoringModule: string;
  /** Tag names usable in JSX without a declaration. */
  readonly intrinsics: readonly string[];
  /** The intrinsic a fragment root (`<>…</>`) becomes. A component whose root is another built-in extends that one instead. */
  readonly hostIntrinsic: string;
  /** Intrinsics whose JSX may contain children. Others (a `Sprite`, a `Collider`) are leaves. */
  readonly containerIntrinsics: readonly string[];
  /**
   * Intrinsics whose JSX text and expression children are one string prop
   * (`<Text>Score: {score}</Text>` sets `text`), by intrinsic, naming the prop.
   * They are not containers: elements cannot be their children.
   */
  readonly textContent: Readonly<Record<string, string>>;
  /**
   * The fields and methods each intrinsic defines on itself, beyond
   * `GameObject`'s. A component rooted at one extends it, so its state, refs and
   * props may not reuse these names. A runtime test checks the list is exactly
   * what the class defines.
   */
  readonly intrinsicMembers: Readonly<Record<string, readonly string[]>>;
  /**
   * Hooks (`onInput`, `onUpdate`, `onMount`, `onUnmount`) an intrinsic
   * implements itself, by intrinsic (`AnimatedSprite.onUpdate` advances its
   * frame). A component rooted at one that writes the same hook overrides it, so
   * the generated override calls `super` first. A runtime test checks the list
   * is exactly the hooks the classes override.
   */
  readonly intrinsicHooks: Readonly<Record<string, readonly string[]>>;
  /**
   * Props each intrinsic's constructor requires. A component rooted at one
   * must pass them to `super()`, before any state exists, so a dynamic value
   * gets a placeholder there and its real value in the first `render()`.
   */
  readonly intrinsicRequired: Readonly<Record<string, readonly string[]>>;
  /**
   * Props of an intrinsic that take one of a fixed set of string values
   * (`<Shape kind="rect">`), by intrinsic then prop name. The compiler checks a
   * literal against the set and says what the choices are; any other
   * expression is left to the type-check.
   */
  readonly intrinsicLiterals: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
  /**
   * Props of an intrinsic that take a size: a number, `"fit"`, `"grow"` or a percentage string such as `"50%"` (`<Flex
   * width>`), by intrinsic. The compiler checks a literal and suggests the nearest keyword for a typo; any other
   * expression is left to the type-check.
   */
  readonly intrinsicSizing: Readonly<Record<string, readonly string[]>>;
  /**
   * Callback props an intrinsic accepts, by intrinsic then prop name, with
   * the parameters its callback receives (a runtime handle type each).
   */
  readonly intrinsicCallbacks: Readonly<Record<string, Readonly<Record<string, readonly CallbackParamManifest[]>>>>;
  /**
   * Member names of the host class (and `Object.prototype`) that generated
   * fields, setters and handlers must not shadow.
   */
  readonly reservedMembers: readonly string[];
  /**
   * Intrinsics that take `x`, `y` and the other transform props. Every runtime
   * object has a transform; an intrinsic left out here (say, a sound with no
   * position) simply cannot be placed from JSX.
   */
  readonly transformIntrinsics: readonly string[];
  /** Runtime types handler parameters may have, with the members handler code may use. */
  readonly handleTypes: Readonly<Record<string, HandleTypeManifest>>;
  /**
   * Runtime functions component code may call, imported from the runtime module. Name → argument count: -1 at least one,
   * -2 any.
   */
  readonly functions: Readonly<Record<string, number>>;
}

/** The plain values a callback prop may be given as a parameter, besides a handle type: a slider's `onChange(value: number)`. */
export const CALLBACK_PRIMITIVES = ["number", "boolean", "string"] as const;

/**
 * A callback parameter whose type the element's own props give (`onReceive`'s value, typed by the collider's tag): left
 * unannotated in the generated code, and read like any value.
 */
export const CALLBACK_CONTEXTUAL = "contextual";

export interface CallbackParamManifest {
  readonly name: string;
  /** A key of `handleTypes`, one of `CALLBACK_PRIMITIVES`, or `CALLBACK_CONTEXTUAL`. */
  readonly type: string;
}

export interface HandleTypeManifest {
  /** Method name → exact argument count. */
  readonly methods: Readonly<Record<string, number>>;
  readonly properties: readonly string[];
}

/** What a `<Flex>` has as fields (its methods are listed after them), which `Slider` and `Toggle` have too. */
/** The drag callbacks every pressable takes, each told where the pointer is, and `onPressOutside`, told nothing. */
const DRAG_POINT = [
  { name: "x", type: "number" },
  { name: "y", type: "number" },
];
const DRAG_CALLBACKS = { onDragStart: DRAG_POINT, onDrag: DRAG_POINT, onDragEnd: DRAG_POINT, onPressOutside: [] };

const FLEX_FIELDS = [
  "direction",
  "alignItems",
  "justifyContent",
  "gap",
  "wrap",
  "rowGap",
  "columnGap",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "background",
  "opacity",
  "drawnAlpha",
  "backgroundImage",
  "slice",
  "sliceTop",
  "sliceRight",
  "sliceBottom",
  "sliceLeft",
  "hoverBackgroundImage",
  "focusBackgroundImage",
  "pressedBackgroundImage",
  "disabledBackgroundImage",
  "overflow",
  "scrollX",
  "scrollY",
  "scrollbar",
  "scrollbarColor",
  "scrollbarWidth",
  "scrollFocus",
  "borderWidth",
  "borderColor",
  "borderRadius",
  "hoverBackground",
  "hoverBorderColor",
  "focusBackground",
  "focusBorderColor",
  "pressedBackground",
  "pressedBorderColor",
  "transition",
  "transitionState",
  "disabledBackground",
  "disabledBorderColor",
  "disabled",
  "float",
  "anchor",
  "to",
  "offsetX",
  "offsetY",
  "left",
  "right",
  "top",
  "bottom",
  "onPress",
  "onPointerEnter",
  "onPointerLeave",
  "onDragStart",
  "onDrag",
  "onDragEnd",
  "onPressOutside",
  "pressKey",
  "focusable",
  "autoFocus",
  "onFocus",
  "onBlur",
  "onAdjust",
  "box",
  "widget",
] as const;

export const runtimeManifest: RuntimeManifest = {
  authoringModule: "@tsengine/runtime/jsx",
  intrinsics: [
    "Entity",
    "Game",
    "Sprite",
    "Collider",
    "Text",
    "Shape",
    "Line",
    "Camera",
    "AnimatedSprite",
    "Pointer",
    "Screen",
    "Hud",
    "Flex",
    "Slider",
    "Toggle",
    "Button",
    "Menu",
    "Tooltip",
    "TextInput",
    "Tilemap",
    "Particles",
    "ParticleLayer",
    "Fade",
    "Music",
    "Router",
    "Route",
    "Provider",
    "Layer",
    "Light",
    "Lighting",
  ],
  hostIntrinsic: "Entity",
  containerIntrinsics: [
    "Entity",
    "Game",
    "Camera",
    "Screen",
    "Hud",
    "Flex",
    "Button",
    "Menu",
    "Tooltip",
    "Router",
    "Route",
    "Provider",
    "Layer",
    "Lighting",
  ],
  textContent: { Text: "text" },
  intrinsicMembers: {
    Entity: ["name"],
    Game: [
      "name",
      "id",
      "title",
      "width",
      "height",
      "background",
      "assets",
      "resizable",
      "vsync",
      "smooth",
      "fullscreenKey",
      "fixedStep",
      "interpolate",
      "gamepadDeadzone",
      "upscale",
      "showFps",
      "fpsKey",
      "font",
      "controls",
      "timeScale",
      "paused",
      "textSize",
      "textColor",
      "overlayKey",
    ],
    Sprite: [
      "image",
      "frameWidth",
      "frameHeight",
      "frame",
      "flipX",
      "flipY",
      "originX",
      "originY",
      "tint",
      "opacity",
      "flash",
      "flashColor",
      "shader",
      "params",
      "lookup",
    ],
    Collider: [
      "width",
      "height",
      "tag",
      "layer",
      "hits",
      "solid",
      "shape",
      "points",
      "data",
      "onCollisionEnter",
      "onCollisionExit",
      "onReceive",
      "owner",
      "hitsLayer",
    ],
    Pointer: [
      "width",
      "height",
      "originX",
      "originY",
      "onPress",
      "onPointerEnter",
      "onPointerLeave",
      "onDragStart",
      "onDrag",
      "onDragEnd",
      "onPressOutside",
      "pressKey",
      "focusable",
      "autoFocus",
      "disabled",
      "onFocus",
      "onBlur",
      "contains",
      "containsIn",
      "focusPoint",
    ],
    Text: [
      "text",
      "size",
      "sized",
      "color",
      "width",
      "align",
      "font",
      "shadow",
      "shadowX",
      "shadowY",
      "outline",
      "outlineWidth",
      "maxWidth",
      "lineGap",
      "reveal",
    ],
    Shape: ["kind", "width", "height", "color"],
    Line: ["x2", "y2", "width", "color"],
    Camera: [
      "zoom",
      "shake",
      "bounds",
      "slide",
      "deadzone",
      "smoothing",
      "slideX",
      "slideY",
      "viewWidth",
      "viewHeight",
      "shakeOffset",
      "viewTransform",
      "worldToView",
      "viewToWorld",
      "saveView",
      "restoreView",
      "blendView",
    ],
    AnimatedSprite: [
      "fps",
      "playing",
      "frame",
      "elapsed",
      "frames",
      "image",
      "sheet",
      "frameWidth",
      "frameHeight",
      "loop",
      "flipX",
      "flipY",
      "originX",
      "originY",
      "tint",
      "opacity",
      "flash",
      "flashColor",
      "shader",
      "params",
      "lookup",
      "animations",
      "animation",
      "isSheet",
      "current",
      "sheetFrame",
      "styled",
      "finished",
    ],
    Screen: ["width", "height", "fit", "pixelPerfect", "border"],
    Hud: [],
    Tilemap: ["map", "image", "layer", "opacity", "solid"],
    Particles: [
      "rate",
      "burst",
      "lifetime",
      "speed",
      "angle",
      "spread",
      "gravity",
      "color",
      "endColor",
      "size",
      "shrink",
      "fade",
      "emitting",
      "max",
      "space",
      "seed",
      "width",
      "height",
      "prewarm",
      "count",
      "read",
      "hasOwnColors",
      "colorsOf",
      "emit",
      "emitAt",
    ],
    ParticleLayer: ["particles", "emitBurst"],
    Fade: ["color", "on", "duration", "amount"],
    Music: ["src", "playing", "volume", "loop", "fade", "level", "started"],
    Router: ["transition", "duration", "coverColor", "cover", "route", "current", "transitioning"],
    Route: ["name", "keepAlive", "visible", "active"],
    Provider: ["name", "context", "value", "addReader", "removeReader"],
    Layer: ["name", "blend", "childBlend", "clear", "opacity", "shader", "params", "lookup"],
    Light: ["radius", "color", "intensity"],
    Lighting: ["name", "blend", "childBlend", "clear", "opacity", "shader", "params", "lookup", "ambient"],
    Flex: [...FLEX_FIELDS, "floats", "contains", "containsIn", "boxPoint", "focusPoint", "onNavigate"],
    // A widget is a Flex with more: its members are Flex's fields, and what it adds (the methods Flex has are its prototype's, not its own).
    Slider: [
      ...FLEX_FIELDS,
      "value",
      "min",
      "max",
      "step",
      "onChange",
      "fillColor",
      "thumbColor",
      "thumbWidth",
      "fraction",
      "thumbSize",
      "valueAt",
      "moveTo",
      "onPressAt",
      "onHeldAt",
      "onNavigate",
    ],
    Toggle: [...FLEX_FIELDS, "checked", "onChange", "onColor", "offColor", "thumbColor", "flip"],
    Button: [...FLEX_FIELDS],
    Menu: [...FLEX_FIELDS, "loop", "onBack"],
    Tooltip: [...FLEX_FIELDS, "show", "shown"],
    TextInput: [
      ...FLEX_FIELDS,
      "value",
      "placeholder",
      "maxLength",
      "onChange",
      "onSubmit",
      "color",
      "placeholderColor",
      "textSize",
      "caretColor",
      "label",
      "showsPlaceholder",
      "takeText",
      "submit",
      "onNavigate",
    ],
  },
  intrinsicRequired: {
    Entity: [],
    Game: [],
    Sprite: ["image"],
    Collider: ["width", "height"],
    Pointer: ["width", "height"],
    Text: ["text"],
    Shape: ["kind", "width", "height"],
    Line: ["x2", "y2"],
    Camera: [],
    AnimatedSprite: [],
    Screen: ["width", "height"],
    Hud: [],
    Flex: [],
    Slider: [],
    Toggle: [],
    Button: [],
    Menu: [],
    Tooltip: [],
    TextInput: [],
    Tilemap: ["map"],
    Particles: [],
    ParticleLayer: ["particles"],
    Fade: [],
    Music: ["src"],
    Router: ["route"],
    Route: ["name"],
    Provider: ["context", "value"],
    Layer: [],
    Light: ["radius"],
    Lighting: [],
  },
  intrinsicHooks: {
    AnimatedSprite: ["onUpdate"],
    Camera: ["onUpdate"],
    Particles: ["onUpdate"],
    ParticleLayer: ["onMount", "onUnmount"],
    Fade: ["onUpdate"],
    Music: ["onUpdate"],
    Router: ["onUpdate"],
  },
  intrinsicLiterals: {
    Shape: { kind: SHAPE_KINDS },
    Screen: { fit: SCREEN_FITS },
    Text: { align: TEXT_ALIGNS },
    Game: { upscale: ["nearest", "sharp"] },
    Particles: { space: PARTICLE_SPACES },
    Layer: { blend: BLEND_MODES, childBlend: BLEND_MODES },
    Collider: { shape: COLLIDER_SHAPES },
    Flex: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
    Slider: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
    Toggle: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
    Button: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
    Menu: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
    Tooltip: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
    TextInput: {
      direction: FLEX_DIRECTIONS,
      alignItems: FLEX_ALIGN_ITEMS,
      justifyContent: FLEX_JUSTIFY_CONTENT,
      anchor: FLEX_ANCHORS,
      to: FLEX_ANCHORS,
      overflow: FLEX_OVERFLOW,
    },
  },
  intrinsicSizing: {
    Flex: ["width", "height"],
    Slider: ["width", "height"],
    Toggle: ["width", "height"],
    Button: ["width", "height"],
    Menu: ["width", "height"],
    Tooltip: ["width", "height"],
    TextInput: ["width", "height"],
  },
  intrinsicCallbacks: {
    Collider: {
      onCollisionEnter: [{ name: "other", type: "Contact" }],
      onCollisionExit: [{ name: "other", type: "Contact" }],
      // What was sent: its type comes from the collider's tag (`ColliderMessages`), so the parameter is left to the props type.
      onReceive: [{ name: "value", type: CALLBACK_CONTEXTUAL }],
    },
    Pointer: { onPress: [], onPointerEnter: [], onPointerLeave: [], ...DRAG_CALLBACKS, onFocus: [], onBlur: [] },
    Flex: {
      onPress: [],
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
    },
    Button: {
      onPress: [],
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
    },
    Menu: {
      onPress: [],
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
      onBack: [],
    },
    Tooltip: {
      onPress: [],
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
    },
    TextInput: {
      onPress: [],
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
      onChange: [{ name: "value", type: "string" }],
      onSubmit: [{ name: "value", type: "string" }],
    },
    Slider: {
      onPress: [],
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
      onChange: [{ name: "value", type: "number" }],
    },
    Toggle: {
      onPointerEnter: [],
      onPointerLeave: [],
      ...DRAG_CALLBACKS,
      onFocus: [],
      onBlur: [],
      onAdjust: [{ name: "direction", type: "number" }],
      onChange: [{ name: "checked", type: "boolean" }],
    },
  },
  reservedMembers: [
    // Entity / GameObject instance fields and methods. A test fails if one is missing here.
    // `updateProps` is generated into every component that has props, so a field may not take the name.
    "interpolation",
    "name",
    "props",
    "applyProps",
    "updateProps",
    "transform",
    "placement",
    "layoutX",
    "layoutY",
    "worldTransform",
    "worldTransformIn",
    "parent",
    "children",
    "world",
    "isDirty",
    "hasPendingStructure",
    "gameStateStore",
    "gameStateKeys",
    "layoutContents",
    "addChild",
    "removeChild",
    "queueAddChild",
    "queueRemoveChild",
    "queueReorder",
    "commitStructure",
    "childSpace",
    "passedChildrenHost",
    "passedChildrenSlot",
    "passedChildrenForward",
    "passedChildrenForwardAt",
    "acceptsPassedChildren",
    "attachPassedChild",
    "queueAttachPassedChild",
    "queueDetachPassedChild",
    "queueReorderPassedChildren",
    "markDirty",
    "markChanged",
    "markMoved",
    "after",
    "every",
    "cancelTimer",
    "cancelTimers",
    "nearby",
    "send",
    "pendingTimers",
    "nextTimerId",
    "resumeTimerIds",
    "stepTimers",
    "renderCount",
    "worldHandlers",
    "reportsChanges",
    "selfChangedAt",
    "subtreeChangedAt",
    "contentChangedAt",
    "drawCache",
    "drawKind",
    "runRender",
    "renderInPass",
    "commitState",
    "render",
    "saveHotState",
    "loadHotState",
    "hotFits",
    "onInput",
    "onUpdate",
    "onMount",
    "onUnmount",
    "keepCleanup",
    "inert",
    "modal",
    "attachToWorld",
    "detachFromWorld",
    "ownedHandles",
    "hotKey",
    "$memo",
    "$mayWrite",
    "propGetters",
    "liveProp",
    "withPropGetters",
    // Object.prototype
    "constructor",
    "toString",
    "valueOf",
    "toLocaleString",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
  ],
  transformIntrinsics: [
    "Entity",
    "Layer",
    "Light",
    "Lighting",
    "Sprite",
    "Collider",
    "Text",
    "Shape",
    "Line",
    "Camera",
    "AnimatedSprite",
    "Pointer",
    "Hud",
    "Flex",
    "Slider",
    "Toggle",
    "Button",
    "Menu",
    "Tooltip",
    "TextInput",
    "Tilemap",
    "Particles",
    "ParticleLayer",
  ],
  handleTypes: {
    InputState: {
      methods: { pressed: 1, down: 1, released: 1, lastPressed: 0, pressedWithin: 2, consumePress: 1 },
      properties: ["pointerX", "pointerY", "typed", "pressHandled"],
    },
    Contact: { methods: {}, properties: ["tag", "owner", "data"] },
  },
  functions: {
    clamp: 3,
    grace: 4,
    textOf: 1,
    freeze: 1,
    springBack: 3,
    shakeOn: 2,
    startSpring: 1,
    stepSpring: 4,
    startTween: 1,
    stepTween: 4,
    keepIfEqual: 2,
    createBody: 1,
    createBall: 1,
    readContext: 1,
    getInputDevice: 0,
    watchInputDevice: 1,
    getWindowSize: 0,
    watchWindowSize: 1,
  },
};
