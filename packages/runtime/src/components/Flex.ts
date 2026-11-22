import { GameObject, type InputScopeProps } from "../GameObject.ts";
import type { WorldTransform } from "../Transform.ts";
import type { PressableProps } from "./Pointer.ts";

/** The main axis of a `<Flex>`. The manifest's `intrinsicLiterals` reads these lists, so the compiler cannot drift from them. */
export const FLEX_DIRECTIONS = ["row", "column"] as const;
export type FlexDirection = (typeof FLEX_DIRECTIONS)[number];

/** Where children sit across the main axis. `"stretch"` makes a `<Flex>` child with a `"fit"` cross size take the whole cross size. */
export const FLEX_ALIGN_ITEMS = ["start", "center", "end", "stretch"] as const;
export type FlexAlignItems = (typeof FLEX_ALIGN_ITEMS)[number];

/** How children and the free space share the main axis. */
export const FLEX_JUSTIFY_CONTENT = ["start", "center", "end", "space-between", "space-around", "space-evenly"] as const;
export type FlexJustifyContent = (typeof FLEX_JUSTIFY_CONTENT)[number];

/**
 * What happens to children that stick out of a `<Flex>`'s box: `"visible"` (they draw outside it, as ever), `"hidden"` (they are
 * clipped to it) or `"scroll"` (clipped, and the mouse wheel or a drag moves them: see `scrollX` and `scrollY`). The manifest's
 * `intrinsicLiterals` reads this list.
 */
export const FLEX_OVERFLOW = ["visible", "hidden", "scroll"] as const;
export type FlexOverflow = (typeof FLEX_OVERFLOW)[number];

/** The nine points of a box that a floating `<Flex>` is attached by (`anchor`) and to (`to`). */
export const FLEX_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type FlexAnchor = (typeof FLEX_ANCHORS)[number];

/**
 * How big a `<Flex>` is along one axis: `"fit"` (its children plus padding and gaps), `"grow"` (its fit size plus a
 * share of its parent's free space), a number of pixels, or a percentage of its parent's inner size (`"50%"`).
 */
export type FlexSizing = number | "fit" | "grow" | `${number}%`;

/**
 * The colours a `<Flex>` with a `transition` is fading between, as packed 0xRRGGBBAA numbers, and when the fade began on the
 * player's animation clock. Written by the player's draw pass and nothing else.
 */
export interface FlexTransition {
  fromFill: number;
  fromEdge: number;
  toFill: number;
  toEdge: number;
  /** The box's opacity, 0 to 1, from and to (a number, not packed in a colour). */
  fromAlpha: number;
  toAlpha: number;
  since: number;
}

export interface FlexProps extends Omit<PressableProps, "onPress">, InputScopeProps {
  /** The main axis: children go left to right (`"row"`, the default) or top to bottom. */
  direction?: FlexDirection;
  /** Where children sit across the main axis. Default `"stretch"`. */
  alignItems?: FlexAlignItems;
  /** How children and free space share the main axis. Default `"start"`. */
  justifyContent?: FlexJustifyContent;
  /** Pixels between neighbouring children. Default 0. */
  gap?: number;
  /**
   * Start a new line when the next child will not fit in the rest of this one (`direction="row"` only): a row of things that wraps
   * into rows, such as an inventory or a palette. Give the box a width (a number, a percentage, or `"grow"`; a box that fits its
   * children is one line). Lines stack downward, each as tall as its tallest child; `justifyContent` places the children of each line,
   * and `alignItems` places each in its line's height. The children keep their own size: a `"grow"` one is its content, and none shrink.
   * A child wider than the box is alone on a line and sticks out. Default false.
   */
  wrap?: boolean;
  /** Pixels between neighbouring lines of a wrapping row (and between the children of a column); overrides `gap`. */
  rowGap?: number;
  /** Pixels between the children of a row (and between the lines of a wrapping column); overrides `gap`. */
  columnGap?: number;
  /** Pixels inside the edge, on all four sides. Default 0. */
  padding?: number;
  /** Left and right padding; overrides `padding`. */
  paddingX?: number;
  /** Top and bottom padding; overrides `padding`. */
  paddingY?: number;
  /** One side's padding; overrides `paddingX` / `paddingY` / `padding`. */
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** Default `"fit"`. */
  width?: FlexSizing;
  height?: FlexSizing;
  /** Bounds in pixels for a `"fit"` or `"grow"` size. */
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /**
   * Take the box out of its parent's flow: it takes no space and moves no sibling, and is attached to a point of its
   * parent instead (`anchor`, `to`, `offsetX`, `offsetY`). It is still sized like any `<Flex>`, and a `"grow"` or
   * percentage size is of its parent's inner size. Draw it above its neighbours with `z`. Under a `<Hud>` or any
   * parent that is not a `<Flex>`, the parent's box is the game's area (the `<Screen>`, or the window).
   */
  float?: boolean;
  /** Which point of this box is attached. Default `"top-left"`. */
  anchor?: FlexAnchor;
  /** Which point of the parent it is attached to. Default `"top-left"`. */
  to?: FlexAnchor;
  /** Pixels to move it right / down from where the two points meet (negative moves it left / up). Default 0. */
  offsetX?: number;
  offsetY?: number;
  /**
   * Pin the box to its parent's edges, as CSS's `left`, `right`, `top` and `bottom` do an absolutely placed box: each is the
   * gap, in pixels, between that edge of the parent and the same edge of this box. Giving any of them takes the box out of the
   * flow, as `float` does. With both edges of an axis and no size on it, the box stretches between them. An axis with neither
   * is placed by `anchor`, `to` and the offset, as a floating box is. The parent's box is measured as for `float`: its whole
   * box, padding included, or the game's area when the parent is not a `<Flex>`.
   */
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  /**
   * What happens to children outside the box (see `FlexOverflow`). `"hidden"` clips to the inside of the box's border (so content never paints over it);
   * `"scroll"` also lets the mouse wheel or a drag (a finger's, or the mouse's) move the content, and stops the children shrinking
   * to fit, so there is something to scroll. A drag that begins on a box that takes drags itself (a slider, `onDrag`) is that box's.
   * Over a box with something to scroll, a press (`onPress`) is heard when the button is let go, and not if the drag scrolled.
   * A clipped child cannot be pressed where it is cut off. Give a `"scroll"` box a size (or a `maxHeight`) smaller than its content.
   * Default `"visible"`.
   */
  overflow?: FlexOverflow;
  /**
   * How far a `"scroll"` box's content is moved left and up, in pixels. The wheel and a drag change it; setting the prop moves it there
   * (clamped to the content): `scrollY={9999}` keeps a log at its end. Default 0.
   */
  scrollX?: number;
  scrollY?: number;
  /**
   * Whether a `"scroll"` box shows a scroll bar along each axis its content overflows: a thin bar inside the right (or bottom) edge,
   * as long as the box is to its content as the bar is to the box, and where the bar sits shows how far it is scrolled. Default true.
   */
  scrollbar?: boolean;
  /** The scroll bar's CSS colour. Default `"#ffffff80"` (half-transparent white). */
  scrollbarColor?: string;
  /** The scroll bar's thickness in pixels. Default 3. */
  scrollbarWidth?: number;
  /**
   * How opaque the box and everything in it is drawn, 0 (gone) to 1 (the default): a panel that fades in and out. It multiplies into
   * every colour under the box, so a box inside a box at 0.5 is at 0.25. Each part is drawn at that opacity on its own, so where
   * parts overlap one shows through the other a little while the box is part way (a whole-box layer would not; see docs/LAYOUT.md, "Opacity").
   * With a `transition` a change of opacity fades. A box at 0 draws nothing, but is still laid out and still takes the mouse.
   */
  opacity?: number;
  /** A CSS colour: draw a filled rectangle behind the children, the size of the box. Default none. */
  background?: string;
  /**
   * An image from the assets folder to draw as the box's background, over `background`, under the children, cut into nine parts
   * by `slice` so that its corners keep their size and its edges and middle stretch to fill the box: a bordered panel or button
   * skin from one small picture. Without `slice` the whole image is stretched. Drawn with no smoothing unless the game has it.
   */
  backgroundImage?: string;
  /** `slice`: how many pixels of the image, in from each edge, are the corners and edges that do not stretch. Default 0. */
  slice?: number;
  /** One side's slice; overrides `slice`. The four sides can differ: a panel with a deep bottom edge. */
  sliceTop?: number;
  sliceRight?: number;
  sliceBottom?: number;
  sliceLeft?: number;
  /** `backgroundImage` in a state, as `hoverBackground` is for `background`: the image changes, the slices stay. Images change at once (a `transition` fades colours only). */
  hoverBackgroundImage?: string;
  focusBackgroundImage?: string;
  pressedBackgroundImage?: string;
  disabledBackgroundImage?: string;
  /**
   * Pixels of border, drawn inside the edge of the box in `borderColor`. The border takes room: it counts as padding on every
   * side, so the children never sit on it. Default 0: none.
   */
  borderWidth?: number;
  /** A CSS colour for the border. Default none: a box with no border colour (plain, hovered or focused) has no border, whatever `borderWidth` says. */
  borderColor?: string;
  /** Pixels of rounding on all four corners of the background and the border, at most half the shorter side. Default 0: square. */
  borderRadius?: number;
  /** `background` while the mouse is over the box (see `World.hovered`). Only what a prop says changes; the rest stays. A box with a hover prop takes the mouse, and lets a press through unless it has an `onPress`. */
  hoverBackground?: string;
  /** `borderColor` while the mouse is over the box. */
  hoverBorderColor?: string;
  /** `background` while the box has the focus (`focusable`). Under a hover prop: when both apply, the hover colour wins. */
  focusBackground?: string;
  /** `borderColor` while the box has the focus. */
  focusBorderColor?: string;
  /** `background` while the mouse button is held down on the box (a press that began on it, and the mouse still over it). Over the hover and focus colours. */
  pressedBackground?: string;
  /** `borderColor` while the box is pressed. */
  pressedBorderColor?: string;
  /**
   * Seconds to fade the background and border colour when the state changes (hover, press, focus, disabled), and `opacity` when it changes, instead of snapping.
   * A fade cut short turns round from the colour it had reached. Default 0: snap. Only colours fade, so nothing moves.
   */
  transition?: number;
  /** `background` while the box is `disabled`. Over every other state. */
  disabledBackground?: string;
  /** `borderColor` while the box is `disabled`. */
  disabledBorderColor?: string;
  /** Called when a press lands on the laid-out box (see `World.reportPress`), or as `PressableProps` says. The box is the size it was laid out at, last frame. */
  onPress?: () => void;
  /**
   * Called with -1 or 1 when left or right is pressed while the box has the focus (`focusable`): a settings row that changes its
   * value, as a slider does. The direction is used up, so the focus stays on the box; up and down still move it.
   */
  onAdjust?: (direction: number) => void;
}

/**
 * What layout works out for a `<Flex>` and keeps between frames, so that laying out allocates nothing per box. Written
 * by the player's layout pass and nothing else; every number is per axis (index 0 is x, 1 is y).
 */
export class FlexBox {
  /** The size the box ended up with. */
  readonly size = new Float64Array(2);
  /**
   * The lines of a wrapping row (see `FlexProps.wrap`), found by layout: how many there are, where each one ends (the index in `kids`
   * of the first child of the next line, or the number of children for the last), and how tall each is. Valid for the layout pass
   * that wrote them.
   */
  lineCount = 0;
  lineEnd = new Int32Array(8);
  lineCross = new Float64Array(8);
  /** Where the children's far edges end, with the padding after them, before any scrolling, and how far the content can scroll (0 when it fits). Written by layout. */
  readonly contentEnd = new Float64Array(2);
  readonly scrollMax = new Float64Array(2);
  /** Its preferred size from its content (fit), and the smallest it can be. */
  readonly preferred = new Float64Array(2);
  readonly minimum = new Float64Array(2);
  /** Scratch for the children, one entry each; grown when a box gets more children. */
  childSize: Float64Array[] = [new Float64Array(8), new Float64Array(8)];
  childMinimum: Float64Array[] = [new Float64Array(8), new Float64Array(8)];
  /** Where a leaf child's own drawing starts relative to its origin (a sprite drawn centred, say), per axis. */
  childOrigin: Float64Array[] = [new Float64Array(8), new Float64Array(8)];
  /**
   * The children layout places, in order: `children` itself, or (when one is `layoutContents`, see `GameObject`) `flat`, the
   * children with each such child replaced by its own.
   */
  kids: readonly GameObject[] = [];
  readonly flat: GameObject[] = [];
  /** 0 a leaf, 1 a `<Flex>`. */
  childKind = new Uint8Array(8);
  /** Indices of the children still taking part in sharing out space. */
  active = new Int32Array(8);
  /** The raw size props last parsed, and what they parsed to, per axis: a string such as "50%" is read once. */
  readonly rawSizing: unknown[] = [undefined, undefined];
  readonly sizingMode = new Uint8Array(2);
  readonly sizingValue = new Float64Array(2);
  /**
   * The player's note of the pass that last laid this box out as a layout root, by which it leaves the layout alone while nothing
   * under the box changes. Owned by `FrameBuilder`; nothing else reads or writes it.
   */
  laidOut: object | null = null;

  ensure(count: number): void {
    if (count <= this.childKind.length) return;
    const capacity = Math.max(count, this.childKind.length * 2);
    const grow = (old: Float64Array): Float64Array => {
      const next = new Float64Array(capacity);
      next.set(old);
      return next;
    };
    this.childSize = [grow(this.childSize[0] as Float64Array), grow(this.childSize[1] as Float64Array)];
    this.childMinimum = [grow(this.childMinimum[0] as Float64Array), grow(this.childMinimum[1] as Float64Array)];
    this.childOrigin = [grow(this.childOrigin[0] as Float64Array), grow(this.childOrigin[1] as Float64Array)];
    const kinds = new Uint8Array(capacity);
    kinds.set(this.childKind);
    this.childKind = kinds;
    this.lineEnd = new Int32Array(capacity);
    this.lineCross = new Float64Array(capacity);
    this.active = new Int32Array(capacity);
  }
}

/**
 * A container that places its children in a row or a column, with the props of CSS flexbox and the sizing of Clay
 * (see docs/LAYOUT.md). The player lays it out before drawing, on each frame where something under its layout root has
 * changed: each child's `layoutX` / `layoutY` is written, so a child's own `transform` still moves it within its slot.
 * A `Shape`, `Sprite` or `Text` keeps its own size; only a `<Flex>` is resized by layout.
 */
/**
 * The pixels of border a `<Flex>` keeps room for on each side: its `borderWidth` when it has a border colour in any state (so the
 * room is kept whichever state it is in and nothing moves when the mouse does), else 0. Layout counts it as padding, a clip stops
 * inside it, and a widget's parts sit inside it.
 */
export function flexBorderRoom(f: Flex): number {
  const coloured =
    f.borderColor !== undefined ||
    f.hoverBorderColor !== undefined ||
    f.focusBorderColor !== undefined ||
    f.pressedBorderColor !== undefined ||
    f.disabledBorderColor !== undefined;
  return f.borderWidth > 0 && Number.isFinite(f.borderWidth) && coloured ? f.borderWidth : 0;
}

/** What a `<Flex>` is besides a box, in `Flex.widget`: the draw pass paints the parts of a widget (a slider's fill and thumb) over its background. */
export const WIDGET_NONE = 0;
export const WIDGET_SLIDER = 1;
export const WIDGET_TOGGLE = 2;
export const WIDGET_TEXT = 3;

export class Flex<P extends object = {}> extends GameObject<P> {
  static override readonly intrinsic = true;

  direction: FlexDirection;
  alignItems: FlexAlignItems;
  justifyContent: FlexJustifyContent;
  gap: number;
  wrap: boolean;
  rowGap: number | undefined;
  columnGap: number | undefined;
  padding: number | undefined;
  paddingX: number | undefined;
  paddingY: number | undefined;
  paddingTop: number | undefined;
  paddingRight: number | undefined;
  paddingBottom: number | undefined;
  paddingLeft: number | undefined;
  width: FlexSizing;
  height: FlexSizing;
  minWidth: number | undefined;
  maxWidth: number | undefined;
  minHeight: number | undefined;
  maxHeight: number | undefined;
  background: string | undefined;
  /** `WIDGET_NONE` for a plain box; a widget subclass sets its own, so the draw pass knows to paint its parts and to let it take the mouse. */
  widget = WIDGET_NONE;
  opacity: number;
  /** The opacity the draw pass last pushed for this box's children (1: none), so it pops what it pushed. Written by the draw pass and nothing else. */
  drawnAlpha = 1;
  backgroundImage: string | undefined;
  slice: number | undefined;
  sliceTop: number | undefined;
  sliceRight: number | undefined;
  sliceBottom: number | undefined;
  sliceLeft: number | undefined;
  hoverBackgroundImage: string | undefined;
  focusBackgroundImage: string | undefined;
  pressedBackgroundImage: string | undefined;
  disabledBackgroundImage: string | undefined;
  overflow: FlexOverflow;
  scrollX: number;
  scrollY: number;
  scrollbar: boolean;
  scrollbarColor: string;
  scrollbarWidth: number;
  /** What had the focus when layout last looked (a scroll box scrolls a newly focused child into view once, so the wheel can still move away from it). */
  scrollFocus: object | null = null;
  borderWidth: number;
  borderColor: string | undefined;
  borderRadius: number;
  hoverBackground: string | undefined;
  hoverBorderColor: string | undefined;
  focusBackground: string | undefined;
  focusBorderColor: string | undefined;
  pressedBackground: string | undefined;
  pressedBorderColor: string | undefined;
  transition: number;
  /** What the draw pass keeps for a `transition`: the colours it is fading between. Null until the box is first drawn with one. */
  transitionState: FlexTransition | null = null;
  disabledBackground: string | undefined;
  disabledBorderColor: string | undefined;
  disabled: boolean;
  float: boolean;
  anchor: FlexAnchor;
  to: FlexAnchor;
  offsetX: number;
  offsetY: number;
  left: number | undefined;
  right: number | undefined;
  top: number | undefined;
  bottom: number | undefined;
  onPress: (() => void) | undefined;
  onPointerEnter: (() => void) | undefined;
  onPointerLeave: (() => void) | undefined;
  onDragStart: ((x: number, y: number) => void) | undefined;
  onDrag: ((x: number, y: number) => void) | undefined;
  onDragEnd: ((x: number, y: number) => void) | undefined;
  onPressOutside: (() => void) | undefined;
  pressKey: string | undefined;
  focusable: boolean;
  autoFocus: boolean;
  onFocus: (() => void) | undefined;
  onBlur: (() => void) | undefined;
  onAdjust: ((direction: number) => void) | undefined;
  /** Layout's working numbers (see `FlexBox`); `box.size` is the size the box was laid out at, last frame. */
  readonly box = new FlexBox();

  /** `props` and `defaults` are the component's own (see `GameObject`); `hostProps` are this element's. */
  constructor(hostProps: FlexProps = {}, props?: P, defaults?: Partial<P>) {
    super(props, defaults);
    this.direction = hostProps.direction ?? "row";
    this.inert = hostProps.inert ?? false;
    this.modal = hostProps.modal ?? false;
    this.alignItems = hostProps.alignItems ?? "stretch";
    this.justifyContent = hostProps.justifyContent ?? "start";
    this.gap = hostProps.gap ?? 0;
    this.wrap = hostProps.wrap ?? false;
    this.rowGap = hostProps.rowGap;
    this.columnGap = hostProps.columnGap;
    this.padding = hostProps.padding;
    this.paddingX = hostProps.paddingX;
    this.paddingY = hostProps.paddingY;
    this.paddingTop = hostProps.paddingTop;
    this.paddingRight = hostProps.paddingRight;
    this.paddingBottom = hostProps.paddingBottom;
    this.paddingLeft = hostProps.paddingLeft;
    this.width = hostProps.width ?? "fit";
    this.height = hostProps.height ?? "fit";
    this.minWidth = hostProps.minWidth;
    this.maxWidth = hostProps.maxWidth;
    this.minHeight = hostProps.minHeight;
    this.maxHeight = hostProps.maxHeight;
    this.background = hostProps.background;
    this.opacity = hostProps.opacity ?? 1;
    this.backgroundImage = hostProps.backgroundImage;
    this.slice = hostProps.slice;
    this.sliceTop = hostProps.sliceTop;
    this.sliceRight = hostProps.sliceRight;
    this.sliceBottom = hostProps.sliceBottom;
    this.sliceLeft = hostProps.sliceLeft;
    this.hoverBackgroundImage = hostProps.hoverBackgroundImage;
    this.focusBackgroundImage = hostProps.focusBackgroundImage;
    this.pressedBackgroundImage = hostProps.pressedBackgroundImage;
    this.disabledBackgroundImage = hostProps.disabledBackgroundImage;
    this.overflow = hostProps.overflow ?? "visible";
    this.scrollX = hostProps.scrollX ?? 0;
    this.scrollY = hostProps.scrollY ?? 0;
    this.scrollbar = hostProps.scrollbar ?? true;
    this.scrollbarColor = hostProps.scrollbarColor ?? "#ffffff80";
    this.scrollbarWidth = hostProps.scrollbarWidth ?? 3;
    this.borderWidth = hostProps.borderWidth ?? 0;
    this.borderColor = hostProps.borderColor;
    this.borderRadius = hostProps.borderRadius ?? 0;
    this.hoverBackground = hostProps.hoverBackground;
    this.hoverBorderColor = hostProps.hoverBorderColor;
    this.focusBackground = hostProps.focusBackground;
    this.focusBorderColor = hostProps.focusBorderColor;
    this.pressedBackground = hostProps.pressedBackground;
    this.pressedBorderColor = hostProps.pressedBorderColor;
    this.transition = hostProps.transition ?? 0;
    this.disabledBackground = hostProps.disabledBackground;
    this.disabledBorderColor = hostProps.disabledBorderColor;
    this.disabled = hostProps.disabled ?? false;
    this.float = hostProps.float ?? false;
    this.anchor = hostProps.anchor ?? "top-left";
    this.to = hostProps.to ?? "top-left";
    this.offsetX = hostProps.offsetX ?? 0;
    this.offsetY = hostProps.offsetY ?? 0;
    this.left = hostProps.left;
    this.right = hostProps.right;
    this.top = hostProps.top;
    this.bottom = hostProps.bottom;
    this.onPress = hostProps.onPress;
    this.onPointerEnter = hostProps.onPointerEnter;
    this.onPointerLeave = hostProps.onPointerLeave;
    this.onDragStart = hostProps.onDragStart;
    this.onDrag = hostProps.onDrag;
    this.onDragEnd = hostProps.onDragEnd;
    this.onPressOutside = hostProps.onPressOutside;
    this.pressKey = hostProps.pressKey;
    this.focusable = hostProps.focusable ?? false;
    this.autoFocus = hostProps.autoFocus ?? false;
    this.onFocus = hostProps.onFocus;
    this.onBlur = hostProps.onBlur;
    this.onAdjust = hostProps.onAdjust;
  }

  /** A direction was pressed while it has the focus: left and right go to `onAdjust` when it has one (and are used up); otherwise the focus moves. */
  onNavigate(dx: number, _dy: number): boolean {
    if (dx === 0 || this.onAdjust === undefined) return false;
    this.onAdjust(dx);
    return true;
  }

  /** Out of its parent's flow: `float`, or pinned to an edge (`left`, `right`, `top`, `bottom`). */
  get floats(): boolean {
    return this.float || this.left !== undefined || this.right !== undefined || this.top !== undefined || this.bottom !== undefined;
  }

  /**
   * Whether the world-space point is on the box as it was laid out and drawn: taken back through the box's position,
   * rotation and scale, like `Pointer.contains`. A box with no size, or a zero scale, is never hit. With an `inset`, only the
   * part that many pixels in from every edge counts (what a clipping box shows: inside its border).
   */
  contains(x: number, y: number, inset = 0): boolean {
    return boxContains(this, this.worldTransform(), x, y, inset);
  }

  /** `contains`, for a caller that already holds the `childSpace()` of this box's parent (see `Pressable.containsIn`). */
  containsIn(parentSpace: WorldTransform, x: number, y: number): boolean {
    return boxContains(this, this.worldTransformIn(parentSpace), x, y, 0);
  }

  /**
   * Where the world-space point is in the box's own pixels, from its top-left corner (taken back through its position, rotation and
   * scale, as `contains` does), written into `out` as x then y. For a box with a zero scale, 0 and 0.
   */
  boxPoint(x: number, y: number, out: Float64Array): void {
    const t = this.worldTransform();
    if (t.scaleX === 0 || t.scaleY === 0) {
      out[0] = 0;
      out[1] = 0;
      return;
    }
    const dx = x - t.x;
    const dy = y - t.y;
    const cos = Math.cos(t.rotation);
    const sin = Math.sin(t.rotation);
    out[0] = (dx * cos + dy * sin) / t.scaleX;
    out[1] = (dy * cos - dx * sin) / t.scaleY;
  }

  /** The middle of the laid-out box, in its layer's coordinates (scale and rotation ignored). */
  focusPoint(): { x: number; y: number } {
    const t = this.worldTransform();
    return { x: t.x + (this.box.size[0] as number) / 2, y: t.y + (this.box.size[1] as number) / 2 };
  }
}

/**
 * Whether the point is on `flex`'s laid-out box, with the box at `t` in the world. (A function, not a private method: QuickJS makes
 * a private-method call slow, and hover asks every box that can be pressed each frame.)
 */
function boxContains(flex: Flex, t: WorldTransform, x: number, y: number, inset: number): boolean {
  const width = flex.box.size[0] as number;
  const height = flex.box.size[1] as number;
  if (!(width > 0 && height > 0) || t.scaleX === 0 || t.scaleY === 0) return false;
  const dx = x - t.x;
  const dy = y - t.y;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const localX = (dx * cos + dy * sin) / t.scaleX;
  const localY = (dy * cos - dx * sin) / t.scaleY;
  return localX >= inset && localX <= width - inset && localY >= inset && localY <= height - inset;
}
