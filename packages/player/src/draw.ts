import {
  AnimatedSprite,
  Camera,
  Collider,
  composeTransforms,
  IDENTITY_TRANSFORM,
  offsetTransform,
  Pointer,
  Flex,
  Tooltip,
  TextInput,
  Game,
  GameObject,
  Hud,
  Screen,
  Shape,
  Sprite,
  isStyled,
  Text,
  Tilemap,
  Particles,
  Fade,
  Layer,
  Light,
  Line,
  type BlendMode,
  Route,
  Router,
  findTilemap,
  type TilemapData,
  TILE_FLIP_D,
  TILE_FLIP_H,
  TILE_FLIP_V,
  type Pressable,
  type ScreenFit,
  type ViewTransform,
  type WorldTransform,
  WIDGET_NONE,
  WIDGET_SLIDER,
  WIDGET_TOGGLE,
  WIDGET_TEXT,
  type Slider,
  type Toggle,
  BUILTIN_FONTS,
  isBuiltinName,
  type ShaderParams,
} from "@tsengine/runtime";

import { MAGENTA, mixColors, parseColor, type PackedColor } from "./color.ts";
import { BUILTIN_FONT_METRICS } from "./fonts.ts";
import { borderRoom, Layouter, textAlignBox, type MeasuredSize } from "./layout.ts";
import {
  TSE_BLEND_ADD,
  TSE_BLEND_MULTIPLY,
  TSE_BLEND_NORMAL,
  TSE_BLEND_SCREEN,
  TSE_OP_LAYER_BEGIN,
  TSE_OP_LAYER_BEGIN_LEN,
  TSE_OP_LAYER_END,
  TSE_OP_LAYER_END_LEN,
  TSE_OP_LIGHT,
  TSE_OP_LIGHT_LEN,
  TSE_OP_BOX,
  TSE_OP_BOX_LEN,
  TSE_OP_ELLIPSE,
  TSE_OP_ELLIPSE_LEN,
  TSE_OP_RECT,
  TSE_OP_RECT_LEN,
  TSE_OP_SPRITE,
  TSE_OP_SPRITE_LEN,
  TSE_OP_SPRITE_REGION,
  TSE_OP_SPRITE_REGION_LEN,
  TSE_OP_SPRITE_SHADED,
  TSE_OP_SPRITE_SHADED_LEN,
  TSE_SPRITE_FLIP_X,
  TSE_SPRITE_FLIP_Y,
  TSE_SPRITE_SILHOUETTE,
  TSE_SHADER_PARAMS,
  TSE_OP_TEXT,
  TSE_OP_TEXT_LEN,
  TSE_OP_VIEW,
  TSE_OP_VIEW_LEN,
  TSE_OP_SCISSOR,
  TSE_OP_SCISSOR_END,
  TSE_OP_CANVAS,
  TSE_OP_SCISSOR_LEN,
  TSE_OP_SCISSOR_END_LEN,
  TSE_OP_CANVAS_LEN,
} from "./protocol.ts";
import { borderRects, fitScreen, viewToWindow, type ScreenPlacement, type WindowRect } from "./screen.ts";
import { stepTransition, type ShownColors } from "./transition.ts";
import { Warner } from "./warn.ts";

/** A sheet a `<Tilemap>` cuts tiles from: the tiles from `firstGid` on, `columns` across, each `tw` × `th`. A handle of -1 draws nothing. */
interface TileSheet {
  readonly firstGid: number;
  readonly handle: number;
  readonly columns: number;
  readonly tw: number;
  readonly th: number;
  readonly margin: number;
  readonly spacing: number;
}

/**
 * Visit every object under `root` in draw order (a parent before its children, children in their
 * order), with the world transform `object.worldTransform()` would give it. The transforms are
 * composed on the way down instead of recomputed from the root for each object, and a camera is
 * transparent to its children, as `GameObject.childSpace()` says. `test/draw.test.ts` checks the
 * two agree over a real tree; if a built-in ever overrides `childSpace()` again, change this too.
 *
 * `visit` is also given the object's draw order, `z`: its own `transform.z` and `placement.z` added to its parent's,
 * with `global` cutting the chain as it does for position (see `Transform`). A camera is transparent here too.
 *
 * A `<Hud>` is visited but not entered, because its subtree is drawn in a layer of its own (see `FrameBuilder.build`);
 * `intoHuds` walks it as a plain container instead, which is how that layer is walked. `leave`, when given, is called for each
 * object once everything under it has been visited (not for a `<Hud>` that is not entered).
 */
export function walkTree(
  root: GameObject,
  visit: (object: GameObject, world: WorldTransform, z: number, kind: number) => WorldTransform | void,
  parentSpace: WorldTransform = IDENTITY_TRANSFORM,
  parentZ = 0,
  intoHuds = false,
  leave: ((object: GameObject, kind: number) => void) | null = null
): void {
  walk(root, visit, parentSpace, parentZ, intoHuds, leave);
}

/**
 * `FrameBuilder.colliders`' walk: every collider under `node` with the world transform the build's walk gives it, in its order (the
 * tree's, before any z sort), into `out`. The same rules as that walk: a hidden route is not entered, nor is a `<Hud>` (whose colliders
 * a build does not collect), and a camera is transparent to its children. The first camera met goes in `found`. Returns false, having
 * stopped, at a `<Flex>`: its children are placed by layout.
 */
function placeColliders(
  node: GameObject,
  parentSpace: WorldTransform,
  out: ColliderEntry[],
  last: Map<Collider, ColliderEntry>,
  next: Map<Collider, ColliderEntry>,
  found: { camera: Camera | null }
): boolean {
  const kind = (node.drawKind >= 0 ? node.drawKind : kindCode(node)) & KIND_MASK;
  // A leaf that neither collides nor is a camera (a sprite, a shape: most of a crowd) adds nothing, so its place is not worked out.
  if (node.children.length === 0 && kind !== KIND_COLLIDER && kind !== KIND_CAMERA) return true;
  const transform = node.transform;
  const placement = node.placement;
  const laidOut = node.layoutX === 0 && node.layoutY === 0 ? parentSpace : offsetTransform(parentSpace, node.layoutX, node.layoutY);
  const at = composeTransforms(
    placement.x === 0 &&
      placement.y === 0 &&
      placement.rotation === 0 &&
      placement.scaleX === 1 &&
      placement.scaleY === 1 &&
      !placement.global
      ? laidOut
      : composeTransforms(laidOut, placement),
    transform
  );
  switch (kind) {
    case KIND_COLLIDER: {
      const collider = node as Collider;
      const was = last.get(collider);
      const entry =
        was !== undefined &&
        was.world.x === at.x &&
        was.world.y === at.y &&
        was.world.rotation === at.rotation &&
        was.world.scaleX === at.scaleX &&
        was.world.scaleY === at.scaleY
          ? was
          : { collider, world: at };
      next.set(collider, entry);
      out.push(entry);
      break;
    }
    case KIND_ROUTE:
      if (!(node as Route).visible) return true;
      break;
    case KIND_HUD:
      return true;
    case KIND_FLEX:
      return false;
    case KIND_CAMERA:
      if (found.camera === null) found.camera = node as Camera;
      break;
  }
  const childSpace = kind === KIND_CAMERA ? parentSpace : at;
  const children = node.children;
  for (let i = 0; i < children.length; i++)
    if (!placeColliders(children[i] as GameObject, childSpace, out, last, next, found)) return false;
  return true;
}

/** What a `walkTree` visit returns for an object that is not drawn at all (a hidden `<Tooltip>`): its subtree is not walked, and it is not left. */
const SKIP_SUBTREE: WorldTransform = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }) as WorldTransform;

/**
 * `walkTree` without default parameters, which QuickJS pays for on every call of a recursion that runs once per object.
 * `visit` is also told the object's kind (`KIND_*`), found here once, so it does not look it up again.
 */
function walk(
  root: GameObject,
  visit: (object: GameObject, world: WorldTransform, z: number, kind: number) => WorldTransform | void,
  parentSpace: WorldTransform,
  parentZ: number,
  intoHuds: boolean,
  leave: ((object: GameObject, kind: number) => void) | null
): void {
  const transform = root.transform;
  const placement = root.placement;
  // The zero test is inline, not left to offsetTransform: QuickJS does not inline calls, and almost nothing has a layout offset.
  const laidOut = root.layoutX === 0 && root.layoutY === 0 ? parentSpace : offsetTransform(parentSpace, root.layoutX, root.layoutY);
  // Almost every placement is the identity, and then composing it gives `laidOut` back: skip the call.
  let world = composeTransforms(
    placement.x === 0 &&
      placement.y === 0 &&
      placement.rotation === 0 &&
      placement.scaleX === 1 &&
      placement.scaleY === 1 &&
      !placement.global
      ? laidOut
      : composeTransforms(laidOut, placement),
    transform
  );
  // Nearly nothing has a z, and then none of the three terms or the `global` flags matter: the answer is 0.
  const z =
    parentZ === 0 && transform.z === 0 && placement.z === 0
      ? 0
      : transform.global
        ? transform.z
        : placement.global
          ? placement.z + transform.z
          : parentZ + placement.z + transform.z;
  const kind = kindOf(root);
  // A visit may return the world to use for the children instead: a floating layout root is placed by the layout it has just run.
  const replaced = visit(root, world, z, kind);
  if (replaced === SKIP_SUBTREE) return; // not entered, and not left
  if (replaced !== undefined) world = replaced;
  if (!intoHuds && kind === KIND_HUD) return;
  const isCamera = kind === KIND_CAMERA;
  const childSpace = isCamera ? parentSpace : world;
  const childZ = isCamera ? parentZ : z;
  // Indexed, not `for…of`: QuickJS makes an iterator object for every `for…of`, and this runs for every object every frame.
  const children = root.children;
  for (let i = 0; i < children.length; i++) walk(children[i] as GameObject, visit, childSpace, childZ, intoHuds, leave);
  if (leave !== null) leave(root, kind);
}

/** How many doubles the record starting with this op takes. */
function recordLength(op: number): number {
  switch (op) {
    case TSE_OP_VIEW:
      return TSE_OP_VIEW_LEN;
    case TSE_OP_SPRITE:
      return TSE_OP_SPRITE_LEN;
    case TSE_OP_SPRITE_REGION:
      return TSE_OP_SPRITE_REGION_LEN;
    case TSE_OP_RECT:
      return TSE_OP_RECT_LEN;
    case TSE_OP_ELLIPSE:
      return TSE_OP_ELLIPSE_LEN;
    case TSE_OP_BOX:
      return TSE_OP_BOX_LEN;
    case TSE_OP_TEXT:
      return TSE_OP_TEXT_LEN;
    case TSE_OP_SCISSOR:
      return TSE_OP_SCISSOR_LEN;
    case TSE_OP_SCISSOR_END:
      return TSE_OP_SCISSOR_END_LEN;
    case TSE_OP_CANVAS:
      return TSE_OP_CANVAS_LEN;
    case TSE_OP_LAYER_BEGIN:
      return TSE_OP_LAYER_BEGIN_LEN;
    case TSE_OP_LAYER_END:
      return TSE_OP_LAYER_END_LEN;
    case TSE_OP_LIGHT:
      return TSE_OP_LIGHT_LEN;
    case TSE_OP_SPRITE_SHADED:
      return TSE_OP_SPRITE_SHADED_LEN;
    default:
      throw new Error(`Unknown draw op ${op}.`);
  }
}

const NO_PARAMS: ShaderParams = [];

/**
 * Write a shader's `params` into `TSE_SHADER_PARAMS` doubles of `r` from `at`: numbers as they are, a list's numbers one after
 * another in its place, a number that is not finite as 0, and 0 for the rest. Returns how many numbers were given, which is more
 * than were written when there were too many.
 */
export function writeShaderParams(r: Float64Array, at: number, params: ShaderParams): number {
  let n = 0;
  const put = (p: unknown): void => {
    if (n < TSE_SHADER_PARAMS) r[at + n] = typeof p === "number" && Number.isFinite(p) ? p : 0;
    n++;
  };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (typeof p === "object" && p !== null) for (let k = 0; k < p.length; k++) put(p[k]);
    else put(p);
  }
  for (let k = n; k < TSE_SHADER_PARAMS; k++) r[at + k] = 0;
  return n;
}

/** A `<Layer>`'s blend mode as the native side takes it. */
function blendCode(mode: BlendMode): number {
  return mode === "add"
    ? TSE_BLEND_ADD
    : mode === "multiply"
      ? TSE_BLEND_MULTIPLY
      : mode === "screen"
        ? TSE_BLEND_SCREEN
        : TSE_BLEND_NORMAL;
}

/**
 * The order that puts `zs` ascending and keeps the original order among equal values (a stable sort, whatever the
 * engine's own), or null when it is already in that order, which is the usual case once a HUD sits at a high `z`.
 * Every value must be a number, not NaN: a NaN would make the comparison inconsistent.
 */
function orderByZ(zs: readonly number[]): number[] | null {
  let sorted = true;
  for (let i = 1; i < zs.length; i++) {
    if ((zs[i] as number) < (zs[i - 1] as number)) {
      sorted = false;
      break;
    }
  }
  if (sorted) return null;
  const order = Array.from({ length: zs.length }, (_, i) => i);
  order.sort((a, b) => ((zs[a] as number) < (zs[b] as number) ? -1 : (zs[a] as number) > (zs[b] as number) ? 1 : a - b));
  return order;
}

/**
 * `orderByZ` for records some of which are layers: `ops` is each record's op and `zs` its z. Each run of a `TSE_OP_LAYER_BEGIN`
 * to its matching `TSE_OP_LAYER_END` is one item at the begin's z among what is around it, and what is between them is put in
 * order the same way among itself. A begin with no end runs to the end of the records.
 */
function nestedOrderByZ(ops: readonly number[], zs: readonly number[]): number[] {
  const count = ops.length;
  // Where each begin's end is (`count` when it has none), found with a stack of the begins still open.
  const ends = new Array<number>(count).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < count; i++) {
    if (ops[i] === TSE_OP_LAYER_BEGIN) open.push(i);
    else if (ops[i] === TSE_OP_LAYER_END && open.length > 0) ends[open.pop() as number] = i;
  }
  for (const begin of open) ends[begin] = count;
  const out: number[] = [];
  const place = (from: number, to: number): void => {
    const items: number[] = [];
    for (let i = from; i < to; i = ops[i] === TSE_OP_LAYER_BEGIN ? (ends[i] as number) + 1 : i + 1) items.push(i);
    const itemZs = items.map((i) => zs[i] as number);
    const order = orderByZ(itemZs);
    for (let k = 0; k < items.length; k++) {
      const i = items[order === null ? k : (order[k] as number)] as number;
      out.push(i);
      if (ops[i] !== TSE_OP_LAYER_BEGIN) continue;
      const end = ends[i] as number;
      place(i + 1, end);
      if (end < count) out.push(end);
    }
  };
  place(0, count);
  return out;
}

/** The colour with its alpha multiplied by `alpha` (0 to 1), its red, green and blue as they were. */
function fadeColor(color: PackedColor, alpha: number): PackedColor {
  return ((color & 0xffffff00) | Math.round((color & 255) * alpha)) >>> 0;
}

/** The thickest outline a `<Text>` draws, in pixels: each is a ring of more copies of the text. */
const MAX_OUTLINE = 3;

/** Where each thing about a nine-slice's three columns and three rows starts in `FrameBuilder.#parts`. */
const SRC_X = 0;
const SRC_W = 3;
const DST_X = 6;
const DST_W = 9;
const SRC_Y = 12;
const SRC_H = 15;
const DST_Y = 18;
const DST_H = 21;

/** Numbers kept per clipping box (see `DrawList.pushClip`), and where its parent's id is among them. */
const CLIP_STRIDE = 9;
const CLIP_PARENT = 7;
const CLIP_INSET = 8;
/** The most doubles of clip records a record can need ahead of it: a clip record is the longest. */
const CLIP_RECORD_ROOM = TSE_OP_SCISSOR_LEN;

/** A growable frame of draw records (see `native/include/tse.h`) and the strings its text records refer to. */
export class DrawList {
  records = new Float64Array(1024);
  length = 0;
  texts: string[] = [];
  /**
   * Where draw order stops being tree order: `[offset, z, offset, z, …]`, one pair each time `setZ` is given a
   * different value, `offset` being where the next record starts. Empty (and free) for a game that never uses `z`.
   */
  readonly #zRuns: number[] = [];
  #z = 0;
  #scratch = new Float64Array(1024);
  /**
   * The clipping boxes of a layer (see `pushClip`), from id 1: `CLIP_STRIDE` numbers each, the box's world transform (x, y,
   * rotation, scale x and y), its width and height, its parent's id (0 for none) and how far in from the edge it clips.
   */
  readonly #clipData: number[] = [];
  /** Where clipping changes, as `#zRuns` does for z: `[offset, clip id, …]`. A record is clipped to the id of the last run at or before it. */
  readonly #clipRuns: number[] = [];
  #clip = 0;
  /** Whether any clipping box was pushed since `reset`, which `sortByZ` clears for each layer: what the player checks to see if it needs to look. */
  anyClips = false;
  /**
   * How opaque what is written now is, 0 to 1 (see `pushAlpha`): the alpha of every colour a record is given is multiplied by it, and
   * at 0 nothing is written. 1 for nearly everything, and then the records are exactly what they were given.
   */
  alpha = 1;
  readonly #alphas: number[] = [];
  /**
   * The z the list was at when each open layer began (`layerBegin`), innermost last. Inside a layer `setZ` orders the layer's own
   * records among themselves; `layerEnd` puts the z back, and the layer's records move as one block, at the z it began at.
   */
  readonly #layerZs: number[] = [];

  /** Draw what is written from now on, until the matching `popAlpha`, at `alpha` times the opacity it is at: a faded box and all that is in it. */
  pushAlpha(alpha: number): void {
    this.#alphas.push(this.alpha);
    this.alpha *= alpha;
  }

  /** Back to the opacity before the last `pushAlpha`. */
  popAlpha(): void {
    this.alpha = this.#alphas.pop() as number;
  }

  reset(): void {
    this.alpha = 1;
    this.#alphas.length = 0;
    this.#layerZs.length = 0;
    this.length = 0;
    this.texts.length = 0;
    this.#zRuns.length = 0;
    this.#z = 0;
    this.#clipData.length = 0;
    this.#clipRuns.length = 0;
    this.#clip = 0;
    this.anyClips = false;
  }

  /**
   * Clip what is written from now on, until the matching `popClip`, to the box `width` × `height` at `world` (in this layer's
   * coordinates) less `inset` pixels on every side (a box clips inside its border), and to the boxes it is inside. The native clip does not nest and works in pixels the view maps to, so the
   * boxes are kept as they are, each record is tagged with its box, and `sortByZ` turns them into clip records once the layer's
   * view is known and the records are in draw order (a box stays around its own records whatever their z).
   */
  pushClip(world: WorldTransform, width: number, height: number, inset: number): void {
    const data = this.#clipData;
    data.push(world.x, world.y, world.rotation, world.scaleX, world.scaleY, width, height, this.#clip, inset);
    this.#clip = data.length / CLIP_STRIDE;
    this.#clipRuns.push(this.length, this.#clip);
    this.anyClips = true;
  }

  /** Stop clipping to the innermost box: back to the one it is inside, if any. */
  popClip(): void {
    this.#clip = this.#clipData[(this.#clip - 1) * CLIP_STRIDE + CLIP_PARENT] as number;
    this.#clipRuns.push(this.length, this.#clip);
  }

  /** The draw order of the records written from now on, among those of the layer they are in (or of none). Only a change is kept. */
  setZ(z: number): void {
    if (z === this.#z) return;
    this.#z = z;
    this.#zRuns.push(this.length, z);
  }

  /**
   * Put the records from `from` on in `z` order, lowest first, keeping tree order among equal values: what has a
   * higher `z` is drawn later, so on top. A layer's records (its begin, what is in it, its end) move as one, at the z it
   * began at, and what is in it is put in `z` order among itself. The records before `from` (the view) and any written
   * after the sort (the screen's bars) stay where they are. Text records refer to `texts` by index, so they move freely.
   */
  sortByZ(from: number, view: ViewTransform): void {
    if (this.#clipRuns.length > 0) this.#sortClipped(from, view);
    else if (this.#zRuns.length > 0) this.#sort(from);
    // The runs belong to the records just sorted; a later layer (the HUD) starts its own.
    this.#zRuns.length = 0;
    this.#z = 0;
    this.#clipData.length = 0;
    this.#clipRuns.length = 0;
    this.#clip = 0;
  }

  /**
   * `sortByZ` for a layer with clipping: the same order, then a clip record wherever the records' boxes change. `view` is the
   * layer's view (the one its view record carries), which takes a box's corners to the pixels `TSE_OP_SCISSOR` is in.
   */
  #sortClipped(from: number, view: ViewTransform): void {
    const zRuns = this.#zRuns;
    const clipRuns = this.#clipRuns;
    const starts: number[] = [];
    const zs: number[] = [];
    const clips: number[] = [];
    let zRun = 0;
    let clipRun = 0;
    let z = 0;
    let clip = 0;
    for (let at = from; at < this.length; at += recordLength(this.records[at] as number)) {
      while (zRun < zRuns.length && (zRuns[zRun] as number) <= at) {
        z = zRuns[zRun + 1] as number;
        zRun += 2;
      }
      while (clipRun < clipRuns.length && (clipRuns[clipRun] as number) <= at) {
        clip = clipRuns[clipRun + 1] as number;
        clipRun += 2;
      }
      starts.push(at);
      zs.push(z);
      clips.push(clip);
    }
    const order = zRuns.length > 0 ? this.#order(starts, zs) : null;
    const rects = this.#clipRects(view);
    const total = this.length - from;
    const room = total + CLIP_RECORD_ROOM * (starts.length + 1);
    if (this.#scratch.length < room) this.#scratch = new Float64Array(Math.max(this.#scratch.length * 2, room));
    const scratch = this.#scratch;
    const records = this.records;
    let write = 0;
    let current = 0;
    for (let i = 0; i < starts.length; i++) {
      const k = order === null ? i : (order[i] as number);
      const start = starts[k] as number;
      const length = recordLength(records[start] as number);
      const wanted = clips[k] as number;
      if (wanted !== current) {
        if (wanted === 0) scratch[write++] = TSE_OP_SCISSOR_END;
        else {
          // A later clip record replaces the one before it, so going from one box to another needs no end between.
          const r = (wanted - 1) * 4;
          scratch[write] = TSE_OP_SCISSOR;
          scratch[write + 1] = rects[r] as number;
          scratch[write + 2] = rects[r + 1] as number;
          scratch[write + 3] = rects[r + 2] as number;
          scratch[write + 4] = rects[r + 3] as number;
          write += TSE_OP_SCISSOR_LEN;
        }
        current = wanted;
      }
      for (let n = 0; n < length; n++) scratch[write + n] = records[start + n] as number;
      write += length;
    }
    // A clip does not carry over into the next layer (the next layer's view would not map it).
    if (current !== 0) scratch[write++] = TSE_OP_SCISSOR_END;
    if (from + write > this.records.length) this.grow(from + write - this.length);
    this.records.set(scratch.subarray(0, write), from);
    this.length = from + write;
  }

  /**
   * Each box as the rectangle of pixels to clip to, `[x, y, width, height]`: its corners taken through its world transform and the
   * `view` (so a box inside a zoomed camera or a scaled screen is where it is drawn; one that is turned is clipped to the
   * rectangle around it), cut down to the box it is inside. A box with a corner that is not a number clips everything.
   */
  #clipRects(view: ViewTransform): number[] {
    const data = this.#clipData;
    const count = data.length / CLIP_STRIDE;
    const out: number[] = new Array(count * 4);
    for (let id = 1; id <= count; id++) {
      const o = (id - 1) * CLIP_STRIDE;
      const x = data[o] as number;
      const y = data[o + 1] as number;
      const cos = Math.cos(data[o + 2] as number);
      const sin = Math.sin(data[o + 2] as number);
      const sx = data[o + 3] as number;
      const sy = data[o + 4] as number;
      const inset = data[o + CLIP_INSET] as number;
      const w = data[o + 5] as number;
      const h = data[o + 6] as number;
      // The corners of the part inside the border, which is nothing (a line) for a box the border fills.
      const u0 = inset;
      const v0 = inset;
      const u1 = Math.max(inset, w - inset);
      const v1 = Math.max(inset, h - inset);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let corner = 0; corner < 4; corner++) {
        const u = (corner & 1) === 0 ? u0 : u1;
        const v = (corner & 2) === 0 ? v0 : v1;
        const wx = x + sx * u * cos - sy * v * sin;
        const wy = y + sx * u * sin + sy * v * cos;
        const px = view.a * wx + view.c * wy + view.e;
        const py = view.b * wx + view.d * wy + view.f;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      let left = Math.round(x0);
      let top = Math.round(y0);
      let right = Math.round(x1);
      let bottom = Math.round(y1);
      if (!(Number.isFinite(left) && Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(bottom)))
        left = top = right = bottom = 0;
      const parent = data[o + CLIP_PARENT] as number;
      if (parent !== 0) {
        const p = (parent - 1) * 4;
        const pl = out[p] as number;
        const pt = out[p + 1] as number;
        left = Math.max(left, pl);
        top = Math.max(top, pt);
        right = Math.min(right, pl + (out[p + 2] as number));
        bottom = Math.min(bottom, pt + (out[p + 3] as number));
      }
      const r = (id - 1) * 4;
      out[r] = left;
      out[r + 1] = top;
      out[r + 2] = Math.max(0, right - left);
      out[r + 3] = Math.max(0, bottom - top);
    }
    return out;
  }

  #sort(from: number): void {
    const runs = this.#zRuns;
    const starts: number[] = [];
    const zs: number[] = [];
    let run = 0;
    let z = 0;
    for (let at = from; at < this.length; at += recordLength(this.records[at] as number)) {
      while (run < runs.length && (runs[run] as number) <= at) {
        z = runs[run + 1] as number;
        run += 2;
      }
      starts.push(at);
      zs.push(z);
    }
    const order = this.#order(starts, zs);
    if (order === null) return;
    const total = this.length - from;
    if (this.#scratch.length < total) this.#scratch = new Float64Array(Math.max(this.#scratch.length * 2, total));
    const scratch = this.#scratch;
    const records = this.records;
    let write = 0;
    for (let i = 0; i < order.length; i++) {
      const start = starts[order[i] as number] as number;
      const length = recordLength(records[start] as number);
      for (let k = 0; k < length; k++) scratch[write + k] = records[start + k] as number;
      write += length;
    }
    for (let k = 0; k < total; k++) records[from + k] = scratch[k] as number;
  }

  /**
   * The draw order of the records at `starts`, whose z values are `zs`: `orderByZ`'s, except that a layer's records keep together
   * (see `sortByZ`). Null when they are in order already. Records in z order as they stand are in order whatever layers they are
   * in, since a layer's own z is where its records begin, so only a frame that needs sorting is looked at for layers.
   */
  #order(starts: readonly number[], zs: readonly number[]): number[] | null {
    const flat = orderByZ(zs);
    if (flat === null) return null;
    const records = this.records;
    let layered = false;
    for (let i = 0; i < starts.length; i++) {
      if (records[starts[i] as number] === TSE_OP_LAYER_BEGIN) {
        layered = true;
        break;
      }
    }
    return layered
      ? nestedOrderByZ(
          starts.map((at) => records[at] as number),
          zs
        )
      : flat;
  }

  #reserve(count: number): number {
    const at = this.length;
    if (at + count > this.records.length) this.grow(count);
    this.length = at + count;
    return at;
  }

  /** Append records made earlier (a copy of a run of `records`), as they are: what a cached tilemap writes. */
  appendRecords(block: Float64Array): void {
    this.grow(block.length);
    this.records.set(block, this.length);
    this.length += block.length;
  }

  /** Make room for `count` more doubles after `length`, for a caller that writes a record into `records` itself and then moves `length` on. */
  grow(count: number): void {
    const at = this.length;
    if (at + count <= this.records.length) return;
    const grown = new Float64Array(Math.max(this.records.length * 2, at + count));
    grown.set(this.records.subarray(0, at));
    this.records = grown;
  }

  #header(op: number, count: number, world: WorldTransform): number {
    const at = this.#reserve(count);
    const r = this.records;
    r[at] = op;
    r[at + 1] = world.x;
    r[at + 2] = world.y;
    r[at + 3] = world.rotation;
    r[at + 4] = world.scaleX;
    r[at + 5] = world.scaleY;
    return at + 6;
  }

  /**
   * Append the records `[from, to)` of `source`, a copy of an earlier frame's. `textShift` is added to the text index of
   * every text record in them (the strings they refer to are re-added at new positions); pass 0 when there are none.
   */
  appendFrom(source: Float64Array, from: number, to: number, textShift: number, hasText: boolean): void {
    const count = to - from;
    const at = this.#reserve(count);
    const r = this.records;
    r.set(source.subarray(from, to), at);
    if (!hasText) return;
    const end = at + count;
    for (let p = at; p < end; p += recordLength(r[p] as number)) {
      if (r[p] === TSE_OP_TEXT) r[p + 6] = (r[p + 6] as number) + textShift;
    }
  }

  /** The canvas record, which must be first in the frame: draw into a `width` × `height` texture, shown in the window at `dest`. */
  canvas(width: number, height: number, dest: WindowRect, border: PackedColor): void {
    const at = this.#reserve(TSE_OP_CANVAS_LEN);
    const r = this.records;
    r[at] = TSE_OP_CANVAS;
    r[at + 1] = width;
    r[at + 2] = height;
    r[at + 3] = dest.x;
    r[at + 4] = dest.y;
    r[at + 5] = dest.width;
    r[at + 6] = dest.height;
    r[at + 7] = border;
  }

  view(v: ViewTransform): void {
    const at = this.#reserve(TSE_OP_VIEW_LEN);
    this.setView(at, v);
  }

  /** Overwrite the view record at `at` (the first record, written before the camera is known). */
  setView(at: number, v: ViewTransform): void {
    const r = this.records;
    r[at] = TSE_OP_VIEW;
    r[at + 1] = v.a;
    r[at + 2] = v.b;
    r[at + 3] = v.c;
    r[at + 4] = v.d;
    r[at + 5] = v.e;
    r[at + 6] = v.f;
  }

  sprite(world: WorldTransform, texture: number): void {
    // In two steps: `this.records[this.#header(…)] = …` reads `records` before the header is written, so a record that made
    // the buffer grow had its texture written into the old one, and was drawn with texture 0 for that frame.
    const at = this.#header(TSE_OP_SPRITE, TSE_OP_SPRITE_LEN, world);
    this.records[at] = texture;
  }

  /** One region of a texture (a frame of a sheet), with its origin, mirroring and tint: the record `TSE_OP_SPRITE_REGION`. */
  spriteRegion(
    world: WorldTransform,
    texture: number,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
    originX: number,
    originY: number,
    flags: number,
    tint: PackedColor
  ): void {
    this.spriteRegionAt(
      world.x,
      world.y,
      world.rotation,
      world.scaleX,
      world.scaleY,
      texture,
      srcX,
      srcY,
      srcW,
      srcH,
      originX,
      originY,
      flags,
      tint
    );
  }

  /** `spriteRegion` with the transform as numbers, for a tilemap's many records (no object per tile). */
  spriteRegionAt(
    x: number,
    y: number,
    rotation: number,
    scaleX: number,
    scaleY: number,
    texture: number,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
    originX: number,
    originY: number,
    flags: number,
    tint: PackedColor
  ): void {
    if (this.alpha !== 1) {
      if (this.alpha === 0) return;
      tint = fadeColor(tint, this.alpha);
    }
    const base = this.#reserve(TSE_OP_SPRITE_REGION_LEN);
    const r = this.records;
    r[base] = TSE_OP_SPRITE_REGION;
    r[base + 1] = x;
    r[base + 2] = y;
    r[base + 3] = rotation;
    r[base + 4] = scaleX;
    r[base + 5] = scaleY;
    const at = base + 6;
    r[at] = texture;
    r[at + 1] = srcX;
    r[at + 2] = srcY;
    r[at + 3] = srcW;
    r[at + 4] = srcH;
    r[at + 5] = originX;
    r[at + 6] = originY;
    r[at + 7] = flags;
    r[at + 8] = tint;
  }

  /**
   * A region drawn through a shader (`TSE_OP_SPRITE_SHADED`): `spriteRegion`'s fields, then the shader's handle, the lookup
   * texture's (-1 for none), the `time` it is given and its `params` (see `writeShaderParams`, whose count it returns).
   */
  spriteShaded(
    world: WorldTransform,
    texture: number,
    srcX: number,
    srcY: number,
    srcW: number,
    srcH: number,
    originX: number,
    originY: number,
    flags: number,
    tint: PackedColor,
    shader: number,
    lookup: number,
    time: number,
    params: ShaderParams
  ): number {
    if (this.alpha !== 1) {
      if (this.alpha === 0) return 0;
      tint = fadeColor(tint, this.alpha);
    }
    const at = this.#header(TSE_OP_SPRITE_SHADED, TSE_OP_SPRITE_SHADED_LEN, world);
    const r = this.records;
    r[at] = texture;
    r[at + 1] = srcX;
    r[at + 2] = srcY;
    r[at + 3] = srcW;
    r[at + 4] = srcH;
    r[at + 5] = originX;
    r[at + 6] = originY;
    r[at + 7] = flags;
    r[at + 8] = tint;
    r[at + 9] = shader;
    r[at + 10] = lookup;
    r[at + 11] = Number.isFinite(time) ? time : 0;
    return writeShaderParams(r, at + 12, params);
  }

  rect(world: WorldTransform, width: number, height: number, color: PackedColor): void {
    if (this.alpha !== 1) {
      if (this.alpha === 0) return;
      color = fadeColor(color, this.alpha);
    }
    const at = this.#header(TSE_OP_RECT, TSE_OP_RECT_LEN, world);
    this.records[at] = width;
    this.records[at + 1] = height;
    this.records[at + 2] = color;
  }

  ellipse(world: WorldTransform, width: number, height: number, color: PackedColor): void {
    if (this.alpha !== 1) {
      if (this.alpha === 0) return;
      color = fadeColor(color, this.alpha);
    }
    const at = this.#header(TSE_OP_ELLIPSE, TSE_OP_ELLIPSE_LEN, world);
    this.records[at] = width;
    this.records[at + 1] = height;
    this.records[at + 2] = color;
  }

  /** A light (`TSE_OP_LIGHT`): `color` (its alpha the strength) at `world`, falling off to black at `radius`. */
  light(world: WorldTransform, radius: number, color: PackedColor): void {
    if (this.alpha === 0) return;
    const at = this.#header(TSE_OP_LIGHT, TSE_OP_LIGHT_LEN, world);
    this.records[at] = radius;
    this.records[at + 1] = this.alpha === 1 ? color : fadeColor(color, this.alpha);
  }

  /**
   * Draw what is written from now on into a layer, until the matching `layerEnd`: cleared to `clear`, each drawable blended with
   * `childBlend` (an `TSE_BLEND_*`). What is inside is drawn at full opacity; the opacity it is at goes on the layer as a whole.
   */
  layerBegin(clear: PackedColor, childBlend: number): void {
    const at = this.#reserve(TSE_OP_LAYER_BEGIN_LEN);
    this.records[at] = TSE_OP_LAYER_BEGIN;
    this.records[at + 1] = clear;
    this.records[at + 2] = childBlend;
    this.#alphas.push(this.alpha);
    this.alpha = 1;
    this.#layerZs.push(this.#z);
  }

  /**
   * Close the innermost layer and lay it over what is under it with `blend`, at `opacity` times the opacity it is at, through `shader`
   * (a handle, or -1 for none) given `time`, its `params` (see `writeShaderParams`, whose count it returns) and the texture `lookup`
   * (a handle, or -1 for none).
   */
  layerEnd(blend: number, opacity: number, shader = -1, time = 0, params: ShaderParams = NO_PARAMS, lookup = -1): number {
    // Back to the z the layer began at, so its end record goes with its begin, and what follows is ordered as before it.
    const z = this.#layerZs.pop();
    if (z !== undefined) this.setZ(z);
    this.alpha = this.#alphas.pop() as number;
    const at = this.#reserve(TSE_OP_LAYER_END_LEN);
    const r = this.records;
    r[at] = TSE_OP_LAYER_END;
    r[at + 1] = blend;
    r[at + 2] = fadeColor(0xffffffff, Math.min(1, Math.max(0, opacity)) * this.alpha);
    r[at + 3] = shader;
    r[at + 4] = lookup;
    r[at + 5] = time;
    return writeShaderParams(r, at + 6, params);
  }

  /** A box with a border inside its edge and rounded corners: the record `TSE_OP_BOX`. A fill or border colour of 0 (no alpha) draws nothing. */
  box(
    world: WorldTransform,
    width: number,
    height: number,
    fill: PackedColor,
    border: PackedColor,
    borderWidth: number,
    radius: number
  ): void {
    if (this.alpha !== 1) {
      if (this.alpha === 0) return;
      fill = fadeColor(fill, this.alpha);
      border = fadeColor(border, this.alpha);
    }
    const at = this.#header(TSE_OP_BOX, TSE_OP_BOX_LEN, world);
    const r = this.records;
    r[at] = width;
    r[at + 1] = height;
    r[at + 2] = fill;
    r[at + 3] = border;
    r[at + 4] = borderWidth;
    r[at + 5] = radius;
  }

  text(world: WorldTransform, text: string, size: number, color: PackedColor): void {
    if (this.alpha !== 1) {
      if (this.alpha === 0) return;
      color = fadeColor(color, this.alpha);
    }
    const at = this.#header(TSE_OP_TEXT, TSE_OP_TEXT_LEN, world);
    this.records[at] = this.texts.length;
    this.records[at + 1] = size;
    this.records[at + 2] = color;
    this.texts.push(text);
  }
}

/** Whether a pressable hears a drag: it has one of `onDragStart`, `onDrag` and `onDragEnd`. */
export function draggable(pointer: Pressable): boolean {
  return pointer.onDragStart !== undefined || pointer.onDrag !== undefined || pointer.onDragEnd !== undefined;
}

/** A `<Flex>` takes the mouse when it has a press or a hover callback, or a prop that is drawn while the mouse is over it. */
function hoverable(flex: Flex): boolean {
  return (
    flex.onPress !== undefined ||
    flex.onPointerEnter !== undefined ||
    flex.onPointerLeave !== undefined ||
    draggable(flex) ||
    flex.hoverBackground !== undefined ||
    flex.hoverBorderColor !== undefined ||
    flex.hoverBackgroundImage !== undefined ||
    flex.widget !== WIDGET_NONE ||
    hasTooltip(flex)
  );
}

/** Whether a box holds a `<Tooltip>`, which shows while the mouse is over the box: so the box takes the mouse. */
function hasTooltip(flex: Flex): boolean {
  const children = flex.children;
  for (let i = 0; i < children.length; i++) if (children[i] instanceof Tooltip) return true;
  return false;
}

/** Whether a scroll box draws bars: `scrollbar`, and content that overflows it. */
function hasScrollbars(flex: Flex): boolean {
  return flex.scrollbar && ((flex.box.scrollMax[0] as number) > 0 || (flex.box.scrollMax[1] as number) > 0);
}

/** Whether a `<Flex>` draws anything of its own, in any state: a background or a border, or a colour for one in a state. */
function paints(flex: Flex): boolean {
  return (
    flex.background !== undefined ||
    flex.borderColor !== undefined ||
    flex.hoverBackground !== undefined ||
    flex.hoverBorderColor !== undefined ||
    flex.focusBackground !== undefined ||
    flex.focusBorderColor !== undefined ||
    flex.pressedBackground !== undefined ||
    flex.pressedBorderColor !== undefined ||
    flex.disabledBackground !== undefined ||
    flex.disabledBorderColor !== undefined ||
    flex.backgroundImage !== undefined ||
    flex.hoverBackgroundImage !== undefined ||
    flex.focusBackgroundImage !== undefined ||
    flex.pressedBackgroundImage !== undefined ||
    flex.disabledBackgroundImage !== undefined ||
    flex.widget !== WIDGET_NONE ||
    flex.opacity !== 1 ||
    (flex.transitionState !== null && (flex.transitionState.fromAlpha !== 1 || flex.transitionState.toAlpha !== 1))
  );
}

/** A `<Flex>`'s opacity as it is used: 0 to 1, and 1 for anything that is not a number. */
function opacityOf(flex: Flex): number {
  return usableOpacity(flex.opacity);
}

/** An opacity as it is used: 0 to 1, and 1 for anything that is not a number. */
function usableOpacity(a: number): number {
  return a >= 1 ? 1 : a > 0 ? a : a === a ? 0 : 1;
}

export interface FrameBuilderOptions {
  /** Load a texture through the backend: a handle, or -1 if it could not be loaded. */
  loadTexture(path: string): number;
  /** Load a layer's shader through the backend: a handle, -1 if it could not be loaded, -2 where shaders cannot run. Without it, none run. */
  loadShader?: (path: string) => number;
  /** The width and line height in pixels of `text` drawn at `size`, from the backend. Without it, they are estimated (`estimateTextWidth`, and a line as tall as `size`). */
  measureText?: (text: string, size: number) => Size;
  /** The size in pixels of a loaded texture, from the backend. Without it, every texture measures 0 × 0. */
  textureSize?: (handle: number) => Size;
  /** Folder that image names are relative to. Default `"assets"`. */
  assets?: string;
  /** The bitmap font of a `<Text>` without its own (`<Game font>`). Default none: the built-in font. */
  font?: string;
  /** Where warnings go. Default `console.warn`. */
  warn?: (message: string) => void;
  /**
   * Reuse last frame's draw records for subtrees that have not changed since (see "Reusing draw records" on `FrameBuilder`).
   * `false` rebuilds everything each frame; `"check"` reuses, then builds the frame again from scratch and throws if the two differ,
   * which is how the tests (and a game under development) catch a change that nothing reported. Default `true`.
   */
  retain?: boolean | "check";
}

export interface ColliderEntry {
  readonly collider: Collider;
  readonly world: WorldTransform;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface BuiltFrame {
  readonly list: DrawList;
  /**
   * The world → window map: the camera's view (identity with no camera), then, under a root `<Screen>`, the game's
   * scale and position in the window. This is what the mouse is taken back through; the view the records carry is the
   * same unless the game is pixel-perfect, which is drawn in game pixels and scaled by its canvas record.
   */
  readonly view: ViewTransform;
  /** The same for the `<Hud>` layers: HUD coordinates → window pixels (the screen's placement, or the identity). */
  readonly hudView: ViewTransform;
  /** Where a root `<Screen>` is drawn in the window; null without one, when the game is the window. */
  readonly screen: ScreenPlacement | null;
  readonly camera: Camera | null;
  /** In draw order: the last one is on top. The world's pointers, then (from `hudPointersFrom`) those inside a `<Hud>`. */
  readonly pointers: readonly Pressable[];
  /** Where the HUD's pointers start in `pointers`: they are pressed at `hudView`'s coordinates, not the world's. */
  readonly hudPointersFrom: number;
  /** The `overflow="scroll"` boxes, in draw order, the world's then (from `hudScrollersFrom`) those inside a `<Hud>`: what the mouse wheel moves. */
  readonly scrollers: readonly Flex[];
  readonly hudScrollersFrom: number;
  /** Whether anything is clipped (`overflow` on a `<Flex>`): when it is, a press must also be inside every box that clips what it lands on. */
  readonly hasClips: boolean;
  readonly colliders: readonly ColliderEntry[];
}

const IDENTITY_VIEW: ViewTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const KIND_NONE = 0;
const KIND_SPRITE = 1;
const KIND_SHAPE = 2;
const KIND_TEXT = 3;
const KIND_CAMERA = 4;
const KIND_POINTER = 5;
const KIND_COLLIDER = 6;
const KIND_SCREEN = 7;
const KIND_HUD = 8;
const KIND_FLEX = 9;
const KIND_TILEMAP = 10;
const KIND_PARTICLES = 11;
const KIND_FADE = 12;
const KIND_ROUTE = 13;
const KIND_ROUTER = 14;
/** A `<Layer>`: its children go between a layer-begin and a layer-end record. */
const KIND_LAYER = 15;
/** A `<Light>`: one light record. */
const KIND_LIGHT = 16;
/** A `<Line>`: one rect record, turned along the line. */
const KIND_LINE = 17;
/**
 * What each class is to the frame, found once per class: `instanceof` walks the prototype chain, and the walk asked up to seven
 * times per object. The low four bits are the kind (`KIND_*`); two flags say how the class affects reusing draw records.
 */
const KINDS = new Map<Function, number>();
/** The draw records of a subtree with this object in it are never reused: it is found by the walk each frame (it feeds a list besides the draw records, or is not drawn where it is). */
const FLAG_VOLATILE = 32;
/** Nothing below this object is reused either: what it does to its children is not reported (layout), or it may change itself at any time (a hook of a hand-written class). */
const FLAG_OPAQUE = 64;
/** A hand-written class with a per-tick hook, which may change anything about itself without reporting it: a layout with one in it is worked out every frame. */
const FLAG_HOOKED = 128;
/** The bits of a kind code that say what kind of object it is (`KIND_*`); the flags are above them. */
const KIND_MASK = 31;

function kindCode(object: GameObject): number {
  let code = object.drawKind;
  if (code >= 0) return code;
  code = object.drawKind = classCode(object);
  return code;
}

function classCode(object: GameObject): number {
  let code = KINDS.get(object.constructor);
  if (code === undefined) {
    const kind =
      object instanceof Sprite || object instanceof AnimatedSprite
        ? KIND_SPRITE
        : object instanceof Shape
          ? KIND_SHAPE
          : object instanceof Line
            ? KIND_LINE
            : object instanceof Text
              ? KIND_TEXT
              : object instanceof Camera
                ? KIND_CAMERA
                : object instanceof Pointer
                  ? KIND_POINTER
                  : object instanceof Collider
                    ? KIND_COLLIDER
                    : object instanceof Screen
                      ? KIND_SCREEN
                      : object instanceof Hud
                        ? KIND_HUD
                        : object instanceof Flex
                          ? KIND_FLEX
                          : object instanceof Tilemap
                            ? KIND_TILEMAP
                            : object instanceof Particles
                              ? KIND_PARTICLES
                              : object instanceof Fade
                                ? KIND_FADE
                                : object instanceof Route
                                  ? KIND_ROUTE
                                  : object instanceof Router
                                    ? KIND_ROUTER
                                    : object instanceof Layer
                                      ? KIND_LAYER
                                      : object instanceof Light
                                        ? KIND_LIGHT
                                        : KIND_NONE;
    code = kind;
    // A tilemap writes only the cells the view shows, so its records change when the camera moves without anything stamping it.
    if (
      kind === KIND_CAMERA ||
      kind === KIND_POINTER ||
      kind === KIND_HUD ||
      kind === KIND_FLEX ||
      kind === KIND_ROUTER ||
      kind === KIND_TILEMAP
    )
      code |= FLAG_VOLATILE;
    // A layer's records are its children's between two records of its own, with its opacity on the closing one: never copied.
    if (kind === KIND_FLEX || kind === KIND_LAYER) code |= FLAG_OPAQUE;
    if (kind === KIND_LAYER) code |= FLAG_VOLATILE;
    // A class that overrides a per-tick hook may write its own transform or colour from it, which nothing reports, unless it is
    // a built-in or a compiled component (the compiler marks those `managed`; the marker is an own property, so a hand-written subclass of one is not).
    const ownProperty = (name: string): boolean => Object.prototype.hasOwnProperty.call(object.constructor, name);
    // Compared with the built-in it extends, whose own hooks (a sprite springing back its squash) report what they change.
    let builtIn = Object.getPrototypeOf(object) as { constructor: unknown; onInput: unknown; onUpdate: unknown } | null;
    while (builtIn !== null && !Object.prototype.hasOwnProperty.call(builtIn.constructor, "intrinsic"))
      builtIn = Object.getPrototypeOf(builtIn) as typeof builtIn;
    const base = builtIn ?? GameObjectPrototype;
    const hooked = object.onInput !== base.onInput || object.onUpdate !== base.onUpdate;
    if (hooked && !ownProperty("intrinsic") && !ownProperty("managed")) code |= FLAG_VOLATILE | FLAG_OPAQUE | FLAG_HOOKED;
    KINDS.set(object.constructor, code);
  }
  return code;
}

const GameObjectPrototype = GameObject.prototype;

/**
 * What the builder notes on the box of a layout root it has laid out (`FlexBox.laidOut`): which pass did, in what, and whether the
 * result holds until something under the root reports a change. See `FrameBuilder`'s `#flex`.
 */
interface LaidOut {
  /** The builder's token for the frames it can reuse from: a note from another builder, or from before a new root, counts for nothing. */
  owner: object;
  /** The world's serial at the build that laid it out: a change stamped with it or later came after. */
  at: number;
  /** The box it was laid out in, and the game's font then (what a `<Text>` without its own is measured in). */
  width: number;
  height: number;
  font: string | undefined;
  /** `LAYOUT_UNSEEN` until a frame first wants to keep the layout and looks (`keepsLayout`), then `LAYOUT_KEPT` or `LAYOUT_REDONE`. */
  keeps: number;
}
const LAYOUT_UNSEEN = 0;
const LAYOUT_KEPT = 1;
const LAYOUT_REDONE = 2;

/**
 * Whether a layout of this subtree holds for as long as nothing in it reports a change (`GameObject.markChanged`, `markMoved`, a
 * render, a structural change): false with a box that scrolls in it (the wheel, a scroll bar and the focus move its children
 * without a stamp), or a hand-written class with a per-tick hook (which may write its own size or place from the hook).
 */
function keepsLayout(object: GameObject): boolean {
  const code = kindCode(object);
  if ((code & FLAG_HOOKED) !== 0) return false;
  if ((code & KIND_MASK) === KIND_FLEX && (object as Flex).overflow === "scroll") return false;
  const children = object.children;
  for (let i = 0; i < children.length; i++) if (!keepsLayout(children[i] as GameObject)) return false;
  return true;
}

/**
 * Whether `object` is under a hand-written class with a per-tick hook. Such a hook may write to anything below it and report
 * nothing (a scene class that sets its HUD's texts each update), which is why no draw record under one is reused, and why no
 * layout under one is kept. Asked every frame, as an object can be moved under one without a stamp of its own.
 */
function underHooked(object: GameObject): boolean {
  for (let up = object.parent; up !== null; up = up.parent) if ((kindCode(up) & FLAG_HOOKED) !== 0) return true;
  return false;
}

/** `object.worldTransform()` for an object whose parent's child space is `parentSpace`: what the walk works out on its way down. */
function worldIn(parentSpace: WorldTransform, object: GameObject): WorldTransform {
  const placement = object.placement;
  const laidOut = object.layoutX === 0 && object.layoutY === 0 ? parentSpace : offsetTransform(parentSpace, object.layoutX, object.layoutY);
  return composeTransforms(
    placement.x === 0 &&
      placement.y === 0 &&
      placement.rotation === 0 &&
      placement.scaleX === 1 &&
      placement.scaleY === 1 &&
      !placement.global
      ? laidOut
      : composeTransforms(laidOut, placement),
    object.transform
  );
}

/** A sprite that is drawn as a region of its image, with options, instead of as the whole image at its top left. */
function styledSprite(node: Sprite | AnimatedSprite): boolean {
  return node instanceof AnimatedSprite
    ? node.styled
    : node.frameWidth !== undefined || node.frameHeight !== undefined || node.frame !== 0 || isStyled(node);
}

/**
 * A sprite drawn through a shader: its record holds the game's time, so it is written again every frame, never copied from the last
 * (as a layer's are not).
 */
function shadedSprite(node: GameObject, kind: number): boolean {
  return kind === KIND_SPRITE && (node as Sprite | AnimatedSprite).shader !== "";
}

/** A rect and an ellipse are records of one length, which the walk relies on when it writes a shape in place: this line stops compiling if they ever differ. */
const SHAPE_LEN: typeof TSE_OP_RECT_LEN & typeof TSE_OP_ELLIPSE_LEN = TSE_OP_RECT_LEN;

/** What `FrameBuilder`'s world walk says about a subtree (see there). */
const WALK_CLEAN = 0;
const WALK_VOLATILE = 1;
const WALK_OPAQUE = 2;

function kindOf(object: GameObject): number {
  return kindCode(object) & KIND_MASK;
}

/**
 * The `<Screen>` that sets the game's resolution: `root` itself, or its only child, which is where a `World`
 * keeps the object it mounted (`world.root` is a bare container). Either may be a `<Game>` (the configuration root)
 * whose only child is the `<Screen>`. Null when the game has none.
 */
export function rootScreen(root: GameObject): Screen | null {
  const only = root.children.length === 1 ? root.children[0] : undefined;
  for (const top of [root, only]) {
    const inner = top instanceof Game && top.children.length === 1 ? top.children[0] : top;
    if (inner instanceof Screen) return inner;
  }
  return null;
}

/** A bitmap font sheet holds the characters 32 to 127 in this many columns and rows. */
const FONT_COLUMNS = 16;
const FONT_ROWS = 6;

/** A built-in font's advances (each character's own width), or undefined for a font file, which moves on a cell at a time. */
function builtinAdvances(font: string): readonly number[] | undefined {
  return isBuiltinName(font) ? BUILTIN_FONT_METRICS[font]?.advances : undefined;
}

/** How far a character moves the next one on, in a font's own pixels: what it draws, a `?` for one outside 32 to 127. */
function glyphAdvance(advances: readonly number[], ch: string): number {
  const code = ch.codePointAt(0) as number;
  return advances[code >= 32 && code < 128 ? code - 32 : 63 - 32] as number;
}

/** The size of the square drawn where a texture could not be loaded. */
const MISSING_TEXTURE_SIZE = 16;

/** How many measured strings are kept before the cache starts again, so a running timer cannot grow it without end. */
const TEXT_CACHE_LIMIT = 1024;

/**
 * A text width for a backend that cannot measure: 0.6 of the size per character, close to raylib's default font.
 * Layout through such a backend (a test recorder) is approximate but deterministic.
 */
export function estimateTextWidth(text: string, size: number): number {
  let characters = 0;
  for (const _ of text) characters++;
  return characters * size * 0.6;
}

/** The sizes this frame is drawn at: the window, the game's area in it, and whether the game is drawn in game pixels. */
interface FrameArea {
  readonly gameWidth: number;
  readonly gameHeight: number;
  readonly width: number;
  readonly height: number;
  readonly placement: ScreenPlacement | null;
  readonly pixelPerfect: boolean;
}

/** A text broken into lines: each line's text, and where it starts in the whole text, in characters (so `<Text reveal>` can say how much of it is showing). */
interface WrappedText {
  readonly lines: readonly string[];
  readonly starts: readonly number[];
}

/** Does this text draw as several lines, or part of one: wrapped, with a line break in it, or revealed a bit at a time? */
function isMultiline(text: Text): boolean {
  return text.maxWidth !== undefined || text.reveal !== undefined || text.text.includes("\n");
}

/** A rectangle of the world, in world pixels. */
interface WorldRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const NO_SIZE: Size = { width: 0, height: 0 };

/**
 * What a `FrameBuilder` remembers about an object so it can reuse the draw records it made for it (kept in `GameObject.drawCache`).
 * Offsets are relative to the parent's own start in the same frame, so that a subtree copied from last frame keeps them all valid
 * without touching them: only the root of a copied run is updated.
 */
class DrawInfo {
  /** The builder's continuity token when this was written: a different one means it belongs to an earlier life of the builder and is ignored. */
  readonly owner: object;
  /** Whether `rel`, `colRel` and `textRel` say where this object's records are in last frame's list. */
  ok = false;
  /** The serial of the frame whose records `len`, `colLen` and `textLen` describe and that are known to be current; -1 when this object's records cannot be reused. */
  built = -1;
  /** Where this object's records start in the draw records, colliders and texts, relative to its parent's start. */
  rel = 0;
  colRel = 0;
  textRel = 0;
  /** How many doubles, collider entries and strings this object and everything under it wrote. */
  len = 0;
  colLen = 0;
  textLen = 0;
  /**
   * Every record and collider this object and everything under it wrote is at this object's own world transform (a component
   * and its plain shapes, sprites and colliders), so when only that transform changes they are last frame's with the new one in each.
   */
  flat = false;

  constructor(owner: object) {
    this.owner = owner;
  }
}

/**
 * Turns an object tree into one frame of draw records. It owns what must persist between frames: the
 * texture handles (each path is loaded once), the colour cache and the warn-once set. It draws
 * nothing itself, so it runs anywhere, with no window.
 *
 * **Reusing draw records.** Most of a game's objects stand still, and a frame spends its time on them: the walk composes a
 * transform and writes a record for each. So the builder keeps last frame's world records and, for a subtree that has not
 * changed, copies the run of records instead of making them again (and its colliders, and its texts). "Changed" is what the
 * world reports: a render, a structural change, an `AnimatedSprite` frame, or `markChanged` (see `GameObject.markChanged`); each
 * stamps the object and its ancestors with the world's serial, and the builder advances the serial once a frame. A subtree is
 * copied when nothing in it was stamped since the frame its records came from, and nothing above it was either (an ancestor's
 * transform moves it). Left out, because the walk must see them each frame: a `<Camera>`, `<Pointer>`, `<Hud>` and `<Flex>`
 * (anything that feeds a list besides the draw records, or lays its children out), anything with a non-zero `z`, and a
 * hand-written class that overrides `onInput` or `onUpdate`, whose subtree is not reused either since it may change itself unseen.
 * The unchanged-object rule is the whole contract: a transform, colour or text written anywhere but a render, with no
 * `markChanged`, is not drawn until something else redraws that object. `retain: "check"` finds that out by rebuilding.
 */
export class FrameBuilder {
  readonly #list = new DrawList();
  readonly #textures = new Map<string, number>();
  readonly #colors = new Map<string, PackedColor>();
  /** The animation clock of the frame being built (see `build`). */
  #time: number | undefined = undefined;
  /** Scratch for the colours a transitioning `<Flex>` shows, so drawing allocates nothing. */
  readonly #fadeColors: ShownColors = { fill: 0, edge: 0, alpha: 1 };
  /** The scroll boxes inside a `<Hud>` with bars to draw: where each was drawn and at what z, for when the walk leaves it. */
  readonly #scrollbarAt = new Map<Flex, { world: WorldTransform; z: number }>();
  /** Scratch for where a part of a widget is (see `#partAt`). */
  readonly #part = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  /** The colour a text's shadow or outline copy is drawn in, while one is; undefined for the text itself. */
  #ink: PackedColor | undefined = undefined;
  /** Scratch for where a shadow or outline copy of a text is, so drawing the effects makes no object per copy. */
  readonly #shifted = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  /** Scratch for the nine parts of a background image (see `#paintImage`): 24 numbers, three columns or rows each of eight things. */
  readonly #parts = new Float64Array(24);
  readonly #textureSizes = new Map<number, Size>();
  readonly #textSizes = new Map<string, Size>();
  readonly #loadTexture: (path: string) => number;
  readonly #loadShader: ((path: string) => number) | undefined;
  /** Each layer shader's handle by its name under the assets folder: -1 for one that failed, -2 where none can run. */
  readonly #shaders = new Map<string, number>();
  readonly #measureText: ((text: string, size: number) => Size) | undefined;
  readonly #textureSize: ((handle: number) => Size) | undefined;
  readonly #assets: string;
  readonly #warner: Warner;
  readonly #layouter: Layouter;
  readonly #retain: boolean;
  readonly #options: FrameBuilderOptions;
  #reference: FrameBuilder | undefined;
  readonly #particle = { x: 0, y: 0, t: 0 };
  readonly #placed = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  /** Where a `<Line>`'s rect goes: its own, as `#placed` is kept upright and unscaled for the records that share it. */
  readonly #linePlaced = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  // What reusing needs from the last frame (see `DrawInfo`): its world records in tree order, before the z sort, its texts and colliders.
  #token: object = {};
  #lastRoot: GameObject | null = null;
  #lastWorld: object | null = null;
  /** The camera the last frame was drawn through: the one this frame's `<Tilemap>`s are culled by, since the walk meets them before it finds this frame's camera. */
  /** Line breaks of wrapped texts, by font, size, width and text: a text is wrapped once, not every frame. */
  readonly #wraps = new Map<string, WrappedText>();
  #cullCamera: Camera | null = null;
  /** What this frame's tilemaps were culled with, `undefined` when none were; and the world rectangle the view shows, found once per frame. */
  #culledWith: Camera | null | undefined = undefined;
  #cullRect: WorldRect | null | undefined = undefined;
  #area: FrameArea | null = null;
  #prevTree = new Float64Array(1024);
  #prevTexts: string[] = [];
  #prevColliders: ColliderEntry[] = [];
  #reused = 0;
  #moved = 0;
  /** The world's serial for the build under way (0 when nothing is reused), and how many layout roots it left as they were. */
  #serial = 0;
  #keptLayouts = 0;

  /** How many doubles of the last frame's world records were copied from the frame before instead of made again (for tests and benchmarks). */
  get reusedRecords(): number {
    return this.#reused;
  }

  /** How many doubles of the last frame's world records were the frame before's with a new transform written in: what an object that only moved had drawn (for tests and benchmarks). */
  get movedRecords(): number {
    return this.#moved;
  }

  /** How many layout roots (a `<Flex>` whose parent is not one) the last build left as the frame before laid them out, nothing under them having changed (for tests and benchmarks). */
  get keptLayouts(): number {
    return this.#keptLayouts;
  }

  /** The bitmap font of a `<Text>` without its own: the root `<Game>`'s `font`, set again on a reload. */
  font: string | undefined;

  /**
   * While true, each build lists every `<Flex>` it lays out in `inspected`, where it was placed (the development overlay draws
   * them: DESIGN.md, "Seeing inside a running game"). Off by default: a game pays nothing for it.
   */
  inspecting = false;
  /** The `<Flex>` boxes of the last build, while `inspecting`: where each was placed, and whether it is in a `<Hud>`. */
  readonly inspected: { readonly flex: Flex; readonly world: WorldTransform; readonly hud: boolean }[] = [];

  constructor(options: FrameBuilderOptions) {
    this.#options = options;
    this.#retain = options.retain !== false;
    this.#loadTexture = options.loadTexture;
    this.#loadShader = options.loadShader;
    this.#measureText = options.measureText;
    this.#textureSize = options.textureSize;
    this.#assets = options.assets ?? "assets";
    this.font = options.font;
    this.#warner = new Warner(options.warn);
    this.#layouter = new Layouter({
      measure: (object, out) => this.#measureInto(object, out),
      warn: (key, message) => this.#warner.once(key, message),
    });
  }

  /**
   * Build the frame for a window of this size. The returned `list` is reused: copy it to keep it.
   *
   * The records are, in order: the canvas (under a pixel-perfect `<Screen>`), the world's view and the world, then
   * for the `<Hud>` layers a second view (the camera ignored) and their contents, then, under a `<Screen>` that is
   * not pixel-perfect, a last view in window pixels and the border bars. A pixel-perfect game is drawn in game pixels
   * and scaled by the canvas record; any other game is drawn through views that scale to the window themselves.
   */
  /** Last step's entry for each collider `colliders` placed: kept while the collider stays put, so the tracker sees it unchanged by identity. */
  #placedColliders = new Map<Collider, ColliderEntry>();

  /**
   * The world's colliders where `build` would put them, in the same order, with nothing drawn: for a step's collisions when the frame
   * is drawn from blended transforms anyway (interpolation), which used to cost a whole build every step only to find the colliders.
   * What a build does to the first camera (the view it remembers: a change of bounds, the followed point) it does too, at the size of
   * the last frame's view. Null when a `<Flex>` is in the world outside a `<Hud>`: a box is placed by the layout a build runs, so the
   * caller builds instead.
   */
  colliders(root: GameObject): ColliderEntry[] | null {
    const out: ColliderEntry[] = [];
    const next = new Map<Collider, ColliderEntry>();
    const found = { camera: null as Camera | null };
    if (!placeColliders(root, IDENTITY_TRANSFORM, out, this.#placedColliders, next, found)) return null;
    this.#placedColliders = next;
    const camera = found.camera;
    const area = this.#area;
    if (camera !== null && area !== null) {
      camera.viewWidth = area.gameWidth;
      camera.viewHeight = area.gameHeight;
      this.#view(camera, area.gameWidth, area.gameHeight);
    }
    return out;
  }

  build(root: GameObject, width: number, height: number, time?: number): BuiltFrame {
    this.inspected.length = 0;
    // The animation clock: where a `<Flex transition>` is in its fade is worked out from it, so building the frame twice at one
    // time shows the same thing. Without one (a test, a screenshot) a transition has no time to run in, and colours snap.
    this.#time = time;
    let built = this.#buildOnce(root, width, height);
    // A tilemap is culled by last frame's camera, because the walk meets it before it finds this frame's. When the camera is not
    // the same (the first frame, a screen change, a camera mounted or removed), the cells it wrote were chosen for another view.
    if (this.#culledWith !== undefined && this.#culledWith !== built.camera) {
      this.#cullCamera = built.camera;
      built = this.#buildOnce(root, width, height);
    }
    this.#cullCamera = built.camera;
    if (this.#options.retain === "check" && this.#retain && root.world !== null) this.#check(root, width, height, built);
    return built;
  }

  #buildOnce(root: GameObject, width: number, height: number): BuiltFrame {
    const list = this.#list;
    list.reset();
    const gameRoot = rootScreen(root);
    const screen = gameRoot === null ? null : this.#usableScreen(gameRoot);
    // The size of the area the game is laid out and centred in: the game's resolution, or the window.
    const placement = screen === null ? null : fitScreen(screen.width, screen.height, width, height, this.#fit(screen));
    // (`fit="expand"` makes the game wider than the `<Screen>`'s `width`, so the placement says how wide it is.)
    const gameWidth = placement === null ? width : placement.width;
    const gameHeight = placement === null ? height : placement.height;
    const pixelPerfect = screen !== null && placement !== null && screen.pixelPerfect !== false;
    this.#area = { gameWidth, gameHeight, width, height, placement, pixelPerfect };
    this.#cullRect = undefined;
    this.#culledWith = undefined;
    const borderColor = screen === null ? 0 : this.#color(screen.border);
    if (screen !== null && placement !== null && pixelPerfect) {
      list.canvas(
        placement.width,
        placement.height,
        { x: placement.left, y: placement.top, width: placement.width * placement.scaleX, height: screen.height * placement.scaleY },
        borderColor
      );
    }
    const worldStart = list.length;
    list.view(IDENTITY_VIEW);
    // Reuse needs a world to read changes from, and the same root and world as last frame to have last frame's records to copy.
    const world = root.world;
    const reuse = this.#retain && world !== null;
    const continued = reuse && this.#lastRoot === root && this.#lastWorld === world;
    if (!continued) this.#token = {};
    this.#lastRoot = null; // until this frame is done, a failure leaves nothing to reuse
    this.#reused = 0;
    const token = this.#token;
    const serial = world !== null && reuse ? ++world.serial : 0;
    this.#serial = serial;
    this.#keptLayouts = 0;
    const lastSerial = serial - 1;
    const prevTree = this.#prevTree;
    const prevTexts = this.#prevTexts;
    const prevColliders = this.#prevColliders;
    const region = list.length;
    let reused = 0;
    let camera: Camera | null = null;
    let pointers: Pressable[] = [];
    const pointerZs: number[] = [];
    const scrollers: Flex[] = [];
    this.#scrollbarAt.clear();
    let anyClips = false;
    const colliders: ColliderEntry[] = [];
    const huds: { readonly world: WorldTransform; readonly object: GameObject }[] = [];
    const covers: Router[] = [];
    let anyZ = false;
    // The z of the records being written, kept here so a frame with no z makes no call per record.
    let listZ = 0;
    const colors = this.#colors;
    const textures = this.#textures;
    // What the `walk` that just returned says about `DrawInfo.flat` for the object it was given.
    let flatWalk = false;
    let moved = 0;

    /**
     * Copy last frame's records for `children[first]` and the siblings after it that can be copied in the same run (they were
     * adjacent last frame too), then return the index of the last one. Colliders and texts go with them; each member's offsets
     * are moved to where it now starts, which leaves everything inside it valid.
     */
    const copyRun = (
      children: GameObject[],
      first: number,
      info: DrawInfo,
      anc: number,
      oldStart: number,
      oldCol: number,
      oldText: number,
      startRel: number,
      colStart: number,
      textStart: number
    ): number => {
      const count = children.length;
      let end = info.rel + info.len;
      let colEnd = info.colRel + info.colLen;
      let textEnd = info.textRel + info.textLen;
      let last = first;
      while (last + 1 < count) {
        const next = children[last + 1] as GameObject;
        const nextInfo = next.drawCache as DrawInfo | null;
        if (
          nextInfo === null ||
          nextInfo.owner !== token ||
          !nextInfo.ok ||
          !(nextInfo.built > anc) ||
          next.subtreeChangedAt >= nextInfo.built
        )
          break;
        if (nextInfo.rel !== end || nextInfo.colRel !== colEnd || nextInfo.textRel !== textEnd) break;
        end += nextInfo.len;
        colEnd += nextInfo.colLen;
        textEnd += nextInfo.textLen;
        last++;
      }
      const from = oldStart + info.rel;
      const colFrom = oldCol + info.colRel;
      const textFrom = oldText + info.textRel;
      const destRel = list.length - region - startRel;
      const destColRel = colliders.length - colStart;
      const destTextRel = list.texts.length - textStart;
      const records = end - info.rel;
      if (records > 0) {
        reused += records;
        if (listZ !== 0) list.setZ((listZ = 0)); // reused records have no z: what they were drawn at is not what the list is at now
        list.appendFrom(prevTree, from, from + records, list.texts.length - textFrom, textEnd > info.textRel);
      }
      for (let k = colFrom, stop = oldCol + colEnd; k < stop; k++) colliders.push(prevColliders[k] as ColliderEntry);
      const texts = list.texts;
      for (let k = textFrom, stop = oldText + textEnd; k < stop; k++) texts.push(prevTexts[k] as string);
      const rel0 = info.rel;
      const col0 = info.colRel;
      const text0 = info.textRel;
      for (let k = first; k <= last; k++) {
        const member = (children[k] as GameObject).drawCache as DrawInfo;
        member.rel = destRel + (member.rel - rel0);
        member.colRel = destColRel + (member.colRel - col0);
        member.textRel = destTextRel + (member.textRel - text0);
      }
      return last;
    };

    /**
     * The world walk: `walkTree` and the visit in one, because it also decides, for each child, whether to copy its records
     * from last frame. Returns `WALK_CLEAN`, `WALK_VOLATILE` (something in this subtree must be found by the walk every frame:
     * `FLAG_VOLATILE`, a z, or a descendant like that, which is what keeps its records from being reused) or `WALK_OPAQUE`
     * (this object is `FLAG_OPAQUE`, so nothing under it is ever reused and its own position is not worth keeping).
     *
     * `anc` is the newest stamp on an ancestor's own transform (`Infinity` under something opaque): a child's records are
     * current only if they were made after it. `oldStart`, `oldCol` and `oldText` say where this object's records, colliders and
     * texts were in last frame's lists, or -1 when they are not known. (A closure, not a method: QuickJS makes a private-method call slow, and this runs per object.)
     */
    const walk = (
      node: GameObject,
      parentSpace: WorldTransform,
      parentZ: number,
      anc: number,
      oldStart: number,
      oldCol: number,
      oldText: number
    ): number => {
      const transform = node.transform;
      const placement = node.placement;
      const laidOut = node.layoutX === 0 && node.layoutY === 0 ? parentSpace : offsetTransform(parentSpace, node.layoutX, node.layoutY);
      let at = composeTransforms(
        placement.x === 0 &&
          placement.y === 0 &&
          placement.rotation === 0 &&
          placement.scaleX === 1 &&
          placement.scaleY === 1 &&
          !placement.global
          ? laidOut
          : composeTransforms(laidOut, placement),
        transform
      );
      const z =
        parentZ === 0 && transform.z === 0 && placement.z === 0
          ? 0
          : transform.global
            ? transform.z
            : placement.global
              ? placement.z + transform.z
              : parentZ + placement.z + transform.z;
      const code = node.drawKind >= 0 ? node.drawKind : kindCode(node);
      const kind = code & KIND_MASK;
      const children = node.children;
      const count = children.length;
      // `opacity={…}` (stored in the transform): this object and all under it are drawn at it, pushed here and popped where the walk leaves it.
      // Its records have the alpha in them, so neither they nor any under them are copied to another frame (as a <Flex>'s are not).
      const faded = transform.opacity !== 1;
      if (faded) list.pushAlpha(usableOpacity(transform.opacity));
      // Where this object's records start, for its children's offsets (a leaf has none).
      const startRel = count > 0 ? list.length - region : 0;
      const colStart = count > 0 ? colliders.length : 0;
      const textStart = count > 0 ? list.texts.length : 0;

      let drawZ = z;
      if (drawZ !== 0) {
        if (drawZ !== drawZ) {
          this.#warner.once("z-nan", "A transform's z is not a number: it is drawn at z 0.");
          drawZ = 0;
        } else anyZ = true;
      }
      switch (kind) {
        case KIND_SPRITE:
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#spriteNode(node as Sprite | AnimatedSprite, at);
          break;
        case KIND_SHAPE:
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#shape(node as Shape, at);
          break;
        case KIND_LINE:
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#line(node as Line, at);
          break;
        case KIND_TEXT:
          if ((node as Text).text !== "") {
            if (drawZ !== listZ) list.setZ((listZ = drawZ));
            this.#text(node as Text, at);
          }
          break;
        case KIND_TILEMAP:
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#tilemap(node as Tilemap, at, true);
          break;
        case KIND_PARTICLES:
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#particles(node as Particles, at);
          break;
        case KIND_LIGHT:
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#light(node as Light, at);
          break;
        case KIND_ROUTE:
          // A screen a transition has hidden is not drawn, pressed or collided with: its children are not walked at all.
          if (!(node as Route).visible) {
            if (faded) list.popAlpha();
            return WALK_VOLATILE;
          }
          break;
        case KIND_ROUTER:
          if ((node as Router).cover > 0) covers.push(node as Router);
          break;
        case KIND_LAYER:
          // An empty layer draws nothing; one with children opens here and closes after them, below.
          if (count > 0) {
            if (drawZ !== listZ) list.setZ((listZ = drawZ));
            list.layerBegin(this.#color((node as Layer).clear), blendCode((node as Layer).childBlend));
          }
          break;
        case KIND_FADE:
          this.#warner.once("fade-world", "A <Fade> only draws inside a <Hud>: this one, in the world, does nothing.");
          break;
        case KIND_CAMERA:
          if (camera === null) camera = node as Camera;
          else this.#warner.once("camera", "More than one <Camera> is mounted: only the first one in draw order is used.");
          break;
        case KIND_POINTER:
          pointers.push(node as Pointer);
          pointerZs.push(drawZ);
          break;
        case KIND_COLLIDER:
          colliders.push({ collider: node as Collider, world: at });
          break;
        case KIND_SCREEN:
          if (node !== gameRoot)
            this.#warner.once(
              "screen-not-root",
              "A <Screen> only sets the game's resolution as the root of the game: this one is drawn as a plain container."
            );
          break;
        case KIND_HUD:
          huds.push({ world: at, object: node });
          if (faded) list.popAlpha();
          return WALK_VOLATILE; // drawn in a layer of its own, and not entered here
        case KIND_FLEX: {
          // A tooltip whose box has neither the mouse nor the focus is not drawn or pressed: its children are not walked at all.
          if (node instanceof Tooltip && !node.shown()) {
            if (faded) list.popAlpha();
            return WALK_VOLATILE;
          }
          if (drawZ !== listZ && paints(node as Flex)) list.setZ((listZ = drawZ));
          const placed = this.#flex(node as Flex, at, gameWidth, gameHeight);
          if (hoverable(node as Flex)) {
            pointers.push(node as Flex);
            pointerZs.push(drawZ);
          }
          if (placed !== undefined) at = placed;
          if (this.inspecting) this.inspected.push({ flex: node as Flex, world: { ...at }, hud: false });
          if ((node as Flex).overflow !== "visible") {
            if ((node as Flex).overflow === "scroll") scrollers.push(node as Flex);
            // Only a box with children is paired with the pop below (a leaf returns before it).
            if (count > 0)
              list.pushClip(at, (node as Flex).box.size[0] as number, (node as Flex).box.size[1] as number, borderRoom(node as Flex));
            anyClips = true;
          }
          break;
        }
      }

      // An entity, sprite, shape or collider writes what it writes at `at`; a text may shift it, and the rest are not plain drawing.
      const plainKind =
        (kind < KIND_TEXT && !(kind === KIND_SPRITE && styledSprite(node as Sprite | AnimatedSprite))) || kind === KIND_COLLIDER;
      if (count === 0) {
        flatWalk = plainKind && !faded;
        if (faded) {
          list.popAlpha();
          return WALK_OPAQUE;
        }
        return (code & FLAG_OPAQUE) !== 0
          ? WALK_OPAQUE
          : z !== 0 || code >= FLAG_VOLATILE || shadedSprite(node, kind)
            ? WALK_VOLATILE
            : WALK_CLEAN;
      }
      const childAnc = (code & FLAG_OPAQUE) !== 0 || faded ? Infinity : node.selfChangedAt > anc ? node.selfChangedAt : anc;
      // Nothing above changed this frame: what is under is worth copying from last frame, and worth writing down for the next.
      if (reuse && childAnc < lastSerial) {
        const result = walkChildren(
          children,
          count,
          kind,
          code,
          at,
          z,
          parentSpace,
          parentZ,
          childAnc,
          oldStart,
          oldCol,
          oldText,
          startRel,
          colStart,
          textStart
        );
        flatWalk = false; // not looked into: its children may have been copied
        return result;
      }

      // This object changed this frame, or something above it did (or nothing is reused at all): everything under it is made
      // again, and nothing is written down; a child that was is told its place is no longer known.
      let volatile = z !== 0 || code >= FLAG_VOLATILE || shadedSprite(node, kind);
      const isCamera = kind === KIND_CAMERA;
      const childSpace = isCamera ? parentSpace : at;
      const childZ = isCamera ? parentZ : z;
      let flat = plainKind; // so far, everything written under this object is at `at`
      for (let i = 0; i < count; i++) {
        const child = children[i] as GameObject;
        let result = -1;
        // A leaf that draws or collides where its parent put it (the `<Shape>`, `<Sprite>` and `<Collider>` of a component that
        // moves) is most of what is here, so it is dealt with in place: what `walk` would do for it, without the call.
        // (Not under a faded box: the records below are written as they are, with no opacity in them.)
        if (
          childZ === 0 &&
          list.alpha === 1 &&
          child.children.length === 0 &&
          child.layoutX === 0 &&
          child.layoutY === 0 &&
          child.transform.opacity === 1
        ) {
          const leaf = child.drawKind >= 0 ? child.drawKind : kindCode(child);
          if (leaf === KIND_SHAPE || leaf === KIND_COLLIDER || (leaf === KIND_SPRITE && !styledSprite(child as Sprite | AnimatedSprite))) {
            const own = child.transform;
            const placed = child.placement;
            if (
              own.z === 0 &&
              placed.z === 0 &&
              placed.x === 0 &&
              placed.y === 0 &&
              placed.rotation === 0 &&
              placed.scaleX === 1 &&
              placed.scaleY === 1 &&
              !placed.global
            ) {
              const world =
                own.x === 0 && own.y === 0 && own.rotation === 0 && own.scaleX === 1 && own.scaleY === 1 && !own.global
                  ? childSpace
                  : composeTransforms(childSpace, own);
              if (world !== childSpace) flat = false;
              if (leaf === KIND_COLLIDER) colliders.push({ collider: child as Collider, world });
              else {
                if (listZ !== 0) list.setZ((listZ = 0));
                // `#sprite` and `#shape`, and the `DrawList` calls under them, written out.
                const o = list.length;
                if (leaf === KIND_SPRITE) {
                  const image = (child as Sprite | AnimatedSprite).image;
                  const handle = image === "" ? undefined : textures.get(image);
                  // Nothing to draw, a texture not asked for yet, or one that could not be loaded: the general way.
                  if (handle === undefined || handle < 0) this.#sprite(image, world);
                  else {
                    if (o + TSE_OP_SPRITE_LEN > list.records.length) list.grow(TSE_OP_SPRITE_LEN);
                    const r = list.records;
                    r[o] = TSE_OP_SPRITE;
                    r[o + 1] = world.x;
                    r[o + 2] = world.y;
                    r[o + 3] = world.rotation;
                    r[o + 4] = world.scaleX;
                    r[o + 5] = world.scaleY;
                    r[o + 6] = handle;
                    list.length = o + TSE_OP_SPRITE_LEN;
                  }
                } else {
                  const css = (child as Shape).color;
                  let color = colors.get(css);
                  if (color === undefined) color = this.#color(css);
                  if (o + SHAPE_LEN > list.records.length) list.grow(SHAPE_LEN);
                  const r = list.records;
                  r[o] = (child as Shape).kind === "circle" ? TSE_OP_ELLIPSE : TSE_OP_RECT;
                  r[o + 1] = world.x;
                  r[o + 2] = world.y;
                  r[o + 3] = world.rotation;
                  r[o + 4] = world.scaleX;
                  r[o + 5] = world.scaleY;
                  r[o + 6] = (child as Shape).width;
                  r[o + 7] = (child as Shape).height;
                  r[o + 8] = color;
                  list.length = o + SHAPE_LEN;
                }
              }
              result = WALK_CLEAN;
            }
          }
        }
        if (result < 0) {
          result = walk(child, childSpace, childZ, childAnc, -1, -1, -1);
          flat = false;
        }
        if (result !== WALK_CLEAN) volatile = true;
        if (reuse) {
          const info = child.drawCache as DrawInfo | null;
          if (info !== null) info.ok = false;
        }
      }
      flatWalk = flat && !faded;
      if (kind === KIND_LAYER) {
        this.#layerEnd(node as Layer);
        // Closing the layer put the list back at the z it began at, the layer's own.
        listZ = drawZ;
      }
      if (kind === KIND_FLEX) {
        if ((node as Flex).overflow !== "visible") list.popClip();
        // The scroll bars go over the content, outside the box's own clip (but inside any around it), at the box's opacity.
        if ((node as Flex).overflow === "scroll" && hasScrollbars(node as Flex)) {
          if (drawZ !== listZ) list.setZ((listZ = drawZ));
          this.#scrollbars(node as Flex, at);
        }
        if ((node as Flex).drawnAlpha !== 1) list.popAlpha();
      }
      if (faded) {
        list.popAlpha();
        return WALK_OPAQUE;
      }
      return (code & FLAG_OPAQUE) !== 0 ? WALK_OPAQUE : volatile ? WALK_VOLATILE : WALK_CLEAN;
    };

    /**
     * The part of `walk` for an object whose children may be copied from last frame (nothing above them changed this frame),
     * apart so that the other objects do not pay for its many locals (QuickJS sets up every local of a function at each call).
     * `childAnc` is `anc` for the children: the newest stamp on this object or above it.
     */
    const walkChildren = (
      children: GameObject[],
      count: number,
      kind: number,
      code: number,
      at: WorldTransform,
      z: number,
      parentSpace: WorldTransform,
      parentZ: number,
      childAnc: number,
      oldStart: number,
      oldCol: number,
      oldText: number,
      startRel: number,
      colStart: number,
      textStart: number
    ): number => {
      let volatile = z !== 0 || code >= FLAG_VOLATILE;
      const own = (code & FLAG_OPAQUE) !== 0 ? WALK_OPAQUE : volatile ? WALK_VOLATILE : WALK_CLEAN;
      const isCamera = kind === KIND_CAMERA;
      const childSpace = isCamera ? parentSpace : at;
      const childZ = isCamera ? parentZ : z;
      const canCopy = oldStart >= 0;
      for (let i = 0; i < count; i++) {
        const child = children[i] as GameObject;
        const info = child.drawCache as DrawInfo | null;
        const known = info !== null && info.owner === token;
        // Where this child's records were last frame, when known, so that what is under it can be copied too.
        let childOld = -1;
        let childOldCol = -1;
        let childOldText = -1;
        if (canCopy && known && info.ok) {
          if (info.built > childAnc) {
            if (child.subtreeChangedAt < info.built) {
              i = copyRun(children, i, info, childAnc, oldStart, oldCol, oldText, startRel, colStart, textStart);
              continue;
            }
            // It only moved since (nothing else of it, and nothing under it, changed), and everything it wrote is at its own
            // world transform: last frame's records with the new transform in each, and its colliders at the new transform.
            // (Not when it is faded now: its records were made at full opacity, and an opacity change is reported as a move.)
            if (
              info.flat &&
              child.contentChangedAt < info.built &&
              childZ === 0 &&
              child.transform.z === 0 &&
              child.placement.z === 0 &&
              child.transform.opacity === 1
            ) {
              const world = worldIn(childSpace, child);
              const destRel = list.length - region - startRel;
              const destColRel = colliders.length - colStart;
              const size = info.len;
              if (size > 0) {
                if (listZ !== 0) list.setZ((listZ = 0));
                list.grow(size);
                const r = list.records;
                let to = list.length;
                for (let from = oldStart + info.rel, end = from + size; from < end;) {
                  // Only sprites and shapes are in such a run: a header, then a texture, or a width, a height and a colour.
                  const op = prevTree[from] as number;
                  r[to] = op;
                  r[to + 1] = world.x;
                  r[to + 2] = world.y;
                  r[to + 3] = world.rotation;
                  r[to + 4] = world.scaleX;
                  r[to + 5] = world.scaleY;
                  r[to + 6] = prevTree[from + 6] as number;
                  if (op === TSE_OP_SPRITE) {
                    to += TSE_OP_SPRITE_LEN;
                    from += TSE_OP_SPRITE_LEN;
                  } else {
                    r[to + 7] = prevTree[from + 7] as number;
                    r[to + 8] = prevTree[from + 8] as number;
                    to += SHAPE_LEN;
                    from += SHAPE_LEN;
                  }
                }
                list.length = to;
                moved += size;
              }
              for (let k = oldCol + info.colRel, stop = k + info.colLen; k < stop; k++)
                colliders.push({ collider: (prevColliders[k] as ColliderEntry).collider, world });
              info.rel = destRel;
              info.colRel = destColRel;
              info.textRel = list.texts.length - textStart;
              info.built = serial;
              continue;
            }
          }
          childOld = oldStart + info.rel;
          childOldCol = oldCol + info.colRel;
          childOldText = oldText + info.textRel;
        }
        const before = list.length - region;
        const colBefore = colliders.length;
        const textBefore = list.texts.length;
        const result = walk(child, childSpace, childZ, childAnc, childOld, childOldCol, childOldText);
        if (result !== WALK_CLEAN) volatile = true;
        // What a later frame can use of this: all of it if it stands still, and, when it is flat, all of it with a new transform if it only moves.
        const flat = flatWalk && result === WALK_CLEAN;
        if (result === WALK_OPAQUE || (child.selfChangedAt >= lastSerial && !flat)) {
          // This object changes (or something above it does): it, and what is under it, is rebuilt now and likely next frame, so it is not written down.
          if (known) info.ok = false;
          continue;
        }
        const record = known ? info : (child.drawCache = new DrawInfo(token));
        record.ok = true;
        record.rel = before - startRel;
        record.colRel = colBefore - colStart;
        record.textRel = textBefore - textStart;
        record.flat = flat;
        // Only what stood still this frame, or only moved, can be copied next frame, so only that is written down.
        if (result === WALK_CLEAN && (flat || child.subtreeChangedAt < lastSerial)) {
          record.len = list.length - region - before;
          record.colLen = colliders.length - colBefore;
          record.textLen = list.texts.length - textBefore;
          record.built = serial;
        } else record.built = -1;
      }
      return own === WALK_OPAQUE ? WALK_OPAQUE : volatile ? WALK_VOLATILE : WALK_CLEAN;
    };

    walk(root, IDENTITY_TRANSFORM, 0, 0, continued ? 0 : -1, 0, 0);
    this.#reused = reused;
    this.#moved = moved;

    if (reuse) {
      // Next frame copies from this one's records in tree order, so take them before the z sort moves them.
      const count = list.length - region;
      if (this.#prevTree.length < count) this.#prevTree = new Float64Array(Math.max(this.#prevTree.length * 2, count));
      this.#prevTree.set(list.records.subarray(region, list.length));
      this.#prevTexts = list.texts.slice();
      this.#prevColliders = colliders;
      this.#lastRoot = root;
      this.#lastWorld = world;
    }

    // The camera centres on the middle of the game's area; a screen's placement then takes game pixels to the window.
    if (camera !== null) {
      (camera as Camera).viewWidth = gameWidth;
      (camera as Camera).viewHeight = gameHeight;
    }
    const cameraView = this.#view(camera, gameWidth, gameHeight);
    const view = placement === null ? cameraView : viewToWindow(cameraView, placement);
    const hudView = placement === null ? IDENTITY_VIEW : viewToWindow(IDENTITY_VIEW, placement);
    list.setView(worldStart, pixelPerfect ? cameraView : view);

    // Draw order: by z, tree order among equals (and the clip records of what is clipped, which need the view). A pointer that is
    // drawn on top is pressed first, so the pointers move with it.
    list.sortByZ(worldStart + TSE_OP_VIEW_LEN, pixelPerfect ? cameraView : view);
    if (anyZ) {
      const order = orderByZ(pointerZs);
      if (order !== null) pointers = order.map((i) => pointers[i] as Pressable);
    }

    // The HUD layers, after the world, each through a view the camera does not touch.
    const hudPointersFrom = pointers.length;
    const hudScrollersFrom = scrollers.length;
    if (huds.length > 0) {
      list.view(pixelPerfect ? IDENTITY_VIEW : hudView);
      for (const { world: hudWorld, object: hud } of huds) {
        // Each layer is ordered by its own z, so a high z inside one layer never lifts it over the next.
        const layerStart = list.length;
        let hudAnyZ = false;
        const hudPointerZs: number[] = [];
        const hudPointers: Pressable[] = [];
        /** The z of each layer open in this HUD, to go back to when it closes. */
        const hudLayerZs: number[] = [];
        listZ = 0;
        for (const child of hud.children) {
          walkTree(
            child,
            (object, world, objectZ, kind) => {
              if (kind === KIND_FLEX && object instanceof Tooltip && !object.shown()) return SKIP_SUBTREE;
              let z = objectZ;
              if (z !== 0) {
                if (z !== z) z = 0;
                else hudAnyZ = true;
              }
              if (object.transform.opacity !== 1) list.pushAlpha(usableOpacity(object.transform.opacity));
              switch (kind) {
                case KIND_SPRITE:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#spriteNode(object as Sprite | AnimatedSprite, world);
                  break;
                case KIND_SHAPE:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#shape(object as Shape, world);
                  break;
                case KIND_LINE:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#line(object as Line, world);
                  break;
                case KIND_TILEMAP:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#tilemap(object as Tilemap, world, false); // a HUD is drawn through a view the camera does not touch: every cell
                  break;
                case KIND_PARTICLES:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#particles(object as Particles, world);
                  break;
                case KIND_LIGHT:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#light(object as Light, world);
                  break;
                case KIND_FADE:
                  if (z !== listZ) list.setZ((listZ = z));
                  this.#fade(object as Fade, gameWidth, gameHeight);
                  break;
                case KIND_TEXT:
                  if ((object as Text).text !== "") {
                    if (z !== listZ) list.setZ((listZ = z));
                    this.#text(object as Text, world);
                  }
                  break;
                case KIND_FLEX: {
                  if (z !== listZ && paints(object as Flex)) list.setZ((listZ = z));
                  const placed = this.#flex(object as Flex, world, gameWidth, gameHeight);
                  if (hoverable(object as Flex)) {
                    hudPointers.push(object as Flex);
                    hudPointerZs.push(z);
                  }
                  if (this.inspecting) this.inspected.push({ flex: object as Flex, world: { ...(placed ?? world) }, hud: true });
                  if ((object as Flex).overflow !== "visible") {
                    if ((object as Flex).overflow === "scroll") {
                      scrollers.push(object as Flex);
                      if (hasScrollbars(object as Flex)) this.#scrollbarAt.set(object as Flex, { world: { ...(placed ?? world) }, z });
                    }
                    // Every box pushed here is popped by `leave` below, which runs for a leaf too.
                    list.pushClip(
                      placed ?? world,
                      (object as Flex).box.size[0] as number,
                      (object as Flex).box.size[1] as number,
                      borderRoom(object as Flex)
                    );
                    anyClips = true;
                  }
                  return placed;
                }
                case KIND_POINTER:
                  hudPointers.push(object as Pointer);
                  hudPointerZs.push(z);
                  break;
                case KIND_CAMERA:
                  this.#warner.once("hud-camera", "A <Camera> inside a <Hud> does nothing: the HUD is drawn through no camera.");
                  break;
                case KIND_LAYER:
                  if (object.children.length > 0) {
                    if (z !== listZ) list.setZ((listZ = z));
                    list.layerBegin(this.#color((object as Layer).clear), blendCode((object as Layer).childBlend));
                    hudLayerZs.push(z);
                  }
                  break;
              }
            },
            hudWorld,
            0,
            true,
            (object, kind) => {
              if (kind === KIND_LAYER && object.children.length > 0) {
                this.#layerEnd(object as Layer);
                listZ = hudLayerZs.pop() as number;
              }
              if (kind === KIND_FLEX) {
                if ((object as Flex).overflow !== "visible") list.popClip();
                const bars = (object as Flex).overflow === "scroll" ? this.#scrollbarAt.get(object as Flex) : undefined;
                if (bars !== undefined) {
                  if (bars.z !== listZ) list.setZ((listZ = bars.z));
                  this.#scrollbars(object as Flex, bars.world);
                }
                if ((object as Flex).drawnAlpha !== 1) list.popAlpha();
              }
              if (object.transform.opacity !== 1) list.popAlpha();
            }
          );
        }
        list.sortByZ(layerStart, pixelPerfect ? IDENTITY_VIEW : hudView);
        let ordered: Pressable[] = hudPointers;
        if (hudAnyZ) {
          const order = orderByZ(hudPointerZs);
          if (order !== null) ordered = order.map((i) => hudPointers[i] as Pressable);
        }
        for (const pointer of ordered) pointers.push(pointer);
      }
    }

    // A router's transition may cover the whole screen with a colour, over the world and the HUD.
    if (covers.length > 0) {
      list.view(pixelPerfect ? IDENTITY_VIEW : hudView);
      const place = this.#placed;
      place.x = 0;
      place.y = 0;
      for (const router of covers) {
        const color = this.#color(router.coverColor);
        const alpha = Math.round((color & 255) * Math.min(1, router.cover));
        if (alpha > 0) list.rect(place, gameWidth, gameHeight, ((color & 0xffffff00) | alpha) >>> 0);
      }
    }

    // Bars around a game that is not pixel-perfect: window pixels, drawn last. (A pixel-perfect game's canvas record clears them.)
    if (placement !== null && !pixelPerfect) this.#borders(placement, width, height, borderColor);
    const built: BuiltFrame = {
      list,
      view,
      hudView,
      screen: placement,
      camera,
      pointers,
      hudPointersFrom,
      scrollers,
      hudScrollersFrom,
      hasClips: anyClips,
      colliders,
    };
    return built;
  }

  /**
   * `retain: "check"`, for a layout that was kept: lay it out after all, and throw if that moves or resizes anything under the root.
   * Stricter than comparing the frames, which only shows a stale layout of something that draws (a `<Pointer>` draws nothing).
   */
  #checkLayout(root: Flex, availableWidth: number, availableHeight: number): void {
    const read = (): number[] => {
      const out: number[] = [];
      const visit = (object: GameObject): void => {
        out.push(object.layoutX, object.layoutY);
        if (object instanceof Flex) out.push(object.box.size[0] as number, object.box.size[1] as number);
        for (const child of object.children) visit(child);
      };
      visit(root);
      return out;
    };
    const kept = read();
    const note = root.box.laidOut;
    this.#layouter.layout(root, availableWidth, availableHeight);
    root.box.laidOut = note; // laying it out took the note off; if this was the layout over again, it still holds
    const fresh = read();
    if (kept.length !== fresh.length || kept.some((value, i) => !Object.is(value, fresh[i])))
      throw new Error(
        `A kept layout differs from a fresh one (under a ${root.constructor.name}): something changed an object without reporting it (see GameObject.markChanged).`
      );
  }

  /** `retain: "check"`: build the frame again without reusing anything, and throw if it is not the frame just built. */
  #check(root: GameObject, width: number, height: number, built: BuiltFrame): void {
    this.#reference ??= new FrameBuilder({ ...this.#options, retain: false, warn: () => {} });
    const expected = this.#reference.build(root, width, height, this.#time);
    const fail = (what: string): never => {
      throw new Error(
        `Reused draw records differ from a full rebuild (${what}): something changed an object without reporting it (see GameObject.markChanged).`
      );
    };
    const a = built.list;
    const b = expected.list;
    if (a.length !== b.length) fail(`${a.length} doubles against ${b.length}`);
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a.records[i], b.records[i])) fail(`record double ${i} is ${a.records[i]}, not ${b.records[i]}`);
    }
    if (a.texts.length !== b.texts.length || a.texts.some((text, i) => text !== b.texts[i])) fail("texts");
    if (built.colliders.length !== expected.colliders.length) fail("colliders");
    for (let i = 0; i < built.colliders.length; i++) {
      const x = built.colliders[i] as ColliderEntry;
      const y = expected.colliders[i] as ColliderEntry;
      if (
        x.collider !== y.collider ||
        x.world.x !== y.world.x ||
        x.world.y !== y.world.y ||
        x.world.rotation !== y.world.rotation ||
        x.world.scaleX !== y.world.scaleX ||
        x.world.scaleY !== y.world.scaleY
      )
        fail(`collider ${i}`);
    }
    if (built.pointers.length !== expected.pointers.length || built.pointers.some((pointer, i) => pointer !== expected.pointers[i]))
      fail("pointers");
  }

  /**
   * The size of what an object draws, for layout: a shape's, pointer's or collider's `width` × `height`, a text's
   * measured width × its measured line height, a sprite's texture size (an animated sprite's first frame, so layout does not
   * jitter as frames change; a texture that cannot be loaded is the 16 × 16 square drawn in its place). Null for
   * anything else: containers are sized by layout itself. Texture sizes and text widths are asked of the backend
   * once each and kept.
   */
  measure(object: GameObject): Size | null {
    const out = { width: 0, height: 0 };
    return this.#measureInto(object, out) ? out : null;
  }

  /** `measure`, written into `out` instead of a new object, for layout, which asks about every leaf every frame. Returns false for anything that draws nothing. */
  #measureInto(object: GameObject, out: MeasuredSize): boolean {
    let size: Size;
    if (object instanceof Shape || object instanceof Pointer || object instanceof Collider) {
      out.width = object.width;
      out.height = object.height;
      return true;
    }
    if (object instanceof Text) {
      const font = object.font ?? this.font;
      if (object.text === "") {
        out.width = object.width ?? 0;
        out.height = font === undefined ? object.size : this.#bitmapHeight(object, font);
        return true;
      }
      if (isMultiline(object)) {
        // The whole text, wrapped: the widest line by the lines' heights. A reveal does not change it, so the box stays put as text appears.
        const wrapped = this.#wrap(object, font);
        let widest = 0;
        for (const line of wrapped.lines) widest = Math.max(widest, this.#lineSize(object, font, line).width);
        const lineHeight = this.#lineSize(object, font, "").height;
        out.width = object.width ?? widest;
        out.height = wrapped.lines.length * lineHeight + (wrapped.lines.length - 1) * object.lineGap;
        return true;
      }
      size =
        font === undefined
          ? this.#textSize(object.text, object.size)
          : this.#bitmapSize(font, object.text, this.#bitmapHeight(object, font));
      if (object.width !== undefined) {
        out.width = object.width;
        out.height = size.height;
        return true;
      }
    } else if (object instanceof AnimatedSprite) {
      // A sheet measures as one frame, a set of files as the first of them (so layout does not jitter as frames change).
      if (object.isSheet)
        size =
          object.frameWidth !== undefined && object.frameHeight !== undefined
            ? { width: object.frameWidth, height: object.frameHeight }
            : this.#imageSize(object.image);
      else size = this.#imageSize(object.frames[0] ?? "");
    } else if (object instanceof Sprite)
      size =
        object.frameWidth !== undefined && object.frameHeight !== undefined
          ? { width: object.frameWidth, height: object.frameHeight }
          : this.#imageSize(object.image);
    else return false;
    out.width = size.width;
    out.height = size.height;
    return true;
  }

  /** A `<Flex>` the walk has reached: lay it out if it is a layout root, then draw its background behind its children. */
  #flex(flex: Flex, world: WorldTransform, availableWidth: number, availableHeight: number): WorldTransform | undefined {
    let placed: WorldTransform | undefined;
    // A parent that is `layoutContents` is transparent: the Flex above it lays this one out.
    let parent = flex.parent;
    while (parent !== null && parent.layoutContents) parent = parent.parent;
    if (!(parent instanceof Flex)) {
      // A layout is a function of what is under the root, the box it is given and the game's font. Everything under the root that
      // changes says so with a stamp (the same stamps draw records are reused by), so a root with no stamp since the build that laid
      // it out is still laid out right, and a HUD that stands still costs no layout. Not every tree can promise that: `keepsLayout`
      // and `underHooked`.
      const serial = this.#serial;
      const note = flex.box.laidOut as LaidOut | null;
      if (
        serial !== 0 &&
        note !== null &&
        note.owner === this.#token &&
        flex.subtreeChangedAt < note.at &&
        note.width === availableWidth &&
        note.height === availableHeight &&
        note.font === this.font &&
        (note.keeps === LAYOUT_KEPT ||
          (note.keeps === LAYOUT_UNSEEN && (note.keeps = keepsLayout(flex) ? LAYOUT_KEPT : LAYOUT_REDONE) === LAYOUT_KEPT)) &&
        !underHooked(flex)
      ) {
        this.#keptLayouts++;
        if (this.#options.retain === "check") this.#checkLayout(flex, availableWidth, availableHeight);
      } else {
        this.#layouter.layout(flex, availableWidth, availableHeight); // which takes the note off every box it places, this one too
        if (serial === 0) {
          // A builder that reuses nothing (`retain: false`, or the one `retain: "check"` compares with) writes no note of its own. One
          // another builder left is put back if this pass laid the root out in the same box and font, as that builder would have.
          if (note !== null && note.width === availableWidth && note.height === availableHeight && note.font === this.font)
            flex.box.laidOut = note;
        } else if (note === null)
          flex.box.laidOut = {
            owner: this.#token,
            at: serial,
            width: availableWidth,
            height: availableHeight,
            font: this.font,
            keeps: LAYOUT_UNSEEN,
          } satisfies LaidOut;
        else {
          note.owner = this.#token;
          note.at = serial;
          note.width = availableWidth;
          note.height = availableHeight;
          note.font = this.font;
          note.keeps = LAYOUT_UNSEEN;
          flex.box.laidOut = note;
        }
      }
      // The world was worked out before layout; a floating root's own offset is only known now.
      if (flex.floats) world = placed = flex.worldTransform();
    }
    flex.drawnAlpha = 1; // what was pushed last frame is not what this frame pops
    if (paints(flex)) this.#paintFlex(flex, world);
    return placed;
  }

  /**
   * A `<Flex>`'s own drawing: its background and border, in the colours of the state it is in. The focus colours replace the plain
   * ones, the hover colours replace those, and the pressed colours those; a disabled box shows only its disabled colours. A box with no border and square
   * corners is the plain `rect` record, as it always was; anything else is a `box`.
   */
  #paintFlex(flex: Flex, world: WorldTransform): void {
    let background = flex.background;
    let borderColor = flex.borderColor;
    let image = flex.backgroundImage;
    const host = flex.world;
    if (flex.disabled) {
      background = flex.disabledBackground ?? background;
      borderColor = flex.disabledBorderColor ?? borderColor;
      image = flex.disabledBackgroundImage ?? image;
    } else if (host !== null) {
      // Each state replaces the one before it: focus over plain, hover over focus, pressed (the button held on it, and the mouse still over it) over hover.
      if (host.focused === flex) {
        background = flex.focusBackground ?? background;
        borderColor = flex.focusBorderColor ?? borderColor;
        image = flex.focusBackgroundImage ?? image;
      }
      if (host.hovered === flex) {
        background = flex.hoverBackground ?? background;
        borderColor = flex.hoverBorderColor ?? borderColor;
        image = flex.hoverBackgroundImage ?? image;
        if (host.pressed === flex) {
          background = flex.pressedBackground ?? background;
          borderColor = flex.pressedBorderColor ?? borderColor;
          image = flex.pressedBackgroundImage ?? image;
        }
      }
    }
    let alpha = opacityOf(flex);
    const fading = flex.transition > 0 && this.#time !== undefined;
    if (fading) {
      // Fading: the colours are numbers with an alpha, so a colour that is going away fades out instead of vanishing, and the opacity goes with them.
      const shown = this.#fadeColors;
      flex.transitionState = stepTransition(
        flex.transitionState,
        background === undefined ? 0 : this.#color(background),
        borderColor === undefined ? 0 : this.#color(borderColor),
        alpha,
        flex.transition,
        this.#time as number,
        shown
      );
      alpha = shown.alpha;
    }
    // The box's own drawing is at its opacity, and so is everything under it: pushed here, popped when the walk has left the box
    // (`drawnAlpha` says it was pushed). A box with nothing under it has nothing to keep it pushed for.
    const list = this.#list;
    if (alpha !== 1) {
      list.pushAlpha(alpha);
      if (flex.children.length > 0) flex.drawnAlpha = alpha;
    }
    this.#paintColors(flex, world, background, borderColor, fading);
    // The image goes over the colours (a colour shows through where the image is transparent) and under the children.
    if (image !== undefined && image !== "") this.#paintImage(flex, world, image);
    if (flex.widget !== WIDGET_NONE) this.#paintWidget(flex, world);
    if (alpha !== 1 && flex.drawnAlpha === 1) list.popAlpha();
  }

  /** A `<Flex>`'s background colour and border, in the colours its state chose (`fading`: the ones `#paintFlex` has just worked out for a transition). */
  #paintColors(flex: Flex, world: WorldTransform, background: string | undefined, borderColor: string | undefined, fading: boolean): void {
    const width = flex.box.size[0] as number;
    const height = flex.box.size[1] as number;
    if (fading) {
      const shown = this.#fadeColors;
      const edgeWidth = flex.borderWidth > 0 && (shown.edge & 255) !== 0 ? flex.borderWidth : 0;
      const round = flex.borderRadius > 0 ? flex.borderRadius : 0;
      const filled = (shown.fill & 255) !== 0;
      if (edgeWidth === 0 && round === 0) {
        if (filled) this.#list.rect(world, width, height, shown.fill);
      } else if (filled || edgeWidth > 0)
        this.#list.box(world, width, height, shown.fill, edgeWidth === 0 ? 0 : shown.edge, edgeWidth, round);
      return;
    }
    const borderWidth = flex.borderWidth > 0 && borderColor !== undefined ? flex.borderWidth : 0;
    const radius = flex.borderRadius > 0 ? flex.borderRadius : 0;
    if (borderWidth === 0 && radius === 0) {
      if (background !== undefined) this.#list.rect(world, width, height, this.#color(background));
      return;
    }
    if (background === undefined && borderWidth === 0) return;
    this.#list.box(
      world,
      width,
      height,
      background === undefined ? 0 : this.#color(background),
      borderWidth === 0 || borderColor === undefined ? 0 : this.#color(borderColor),
      borderWidth,
      radius
    );
  }

  /** Where a part of a box is, `ox` and `oy` pixels in from its top-left corner, taken through the box's own rotation and scale: a scratch transform, good until the next call. */
  #partAt(world: WorldTransform, ox: number, oy: number): WorldTransform {
    const part = this.#part;
    const cos = world.rotation === 0 ? 1 : Math.cos(world.rotation);
    const sin = world.rotation === 0 ? 0 : Math.sin(world.rotation);
    const x = ox * world.scaleX;
    const y = oy * world.scaleY;
    part.x = world.x + x * cos - y * sin;
    part.y = world.y + x * sin + y * cos;
    part.rotation = world.rotation;
    part.scaleX = world.scaleX;
    part.scaleY = world.scaleY;
    return part;
  }

  /**
   * A scroll box's bars, one along each axis its content overflows (`scrollMax`): a `box` record inside the border, at the right (a
   * vertical bar) or the bottom, as long as the box is to its content as the bar is to the box (and never shorter than twice its
   * thickness), where the scroll offset puts it.
   */
  #scrollbars(flex: Flex, world: WorldTransform): void {
    const edge = borderRoom(flex);
    const width = (flex.box.size[0] as number) - 2 * edge;
    const height = (flex.box.size[1] as number) - 2 * edge;
    const thick = flex.scrollbarWidth;
    if (!(width > 0 && height > 0 && thick > 0)) return;
    const color = this.#color(flex.scrollbarColor);
    const maxX = flex.box.scrollMax[0] as number;
    const maxY = flex.box.scrollMax[1] as number;
    // With both bars, each stops short of the corner the other runs into.
    const longY = maxX > 0 ? height - thick : height;
    const longX = maxY > 0 ? width - thick : width;
    if (maxY > 0 && longY > 0) {
      const length = Math.min(Math.max((longY * longY) / (longY + maxY), 2 * thick), longY);
      const y = edge + (flex.scrollY / maxY) * (longY - length);
      this.#list.box(this.#partAt(world, edge + width - thick, y), thick, length, color, 0, 0, thick / 2);
    }
    if (maxX > 0 && longX > 0) {
      const length = Math.min(Math.max((longX * longX) / (longX + maxX), 2 * thick), longX);
      const x = edge + (flex.scrollX / maxX) * (longX - length);
      this.#list.box(this.#partAt(world, x, edge + height - thick), length, thick, color, 0, 0, thick / 2);
    }
  }

  /**
   * What a widget draws of its own, over its background and image and under its children: a slider's fill and thumb, a toggle's
   * track and knob. Each is a `box` record inside the border, so they fade, clip and follow the transform as the box does.
   */
  #paintWidget(flex: Flex, world: WorldTransform): void {
    const edge = borderRoom(flex);
    const width = Math.max((flex.box.size[0] as number) - 2 * edge, 0);
    const height = Math.max((flex.box.size[1] as number) - 2 * edge, 0);
    if (!(width > 0 && height > 0)) return;
    const list = this.#list;
    // The track's own rounding, less the border it sits inside.
    const radius = Math.max((flex.borderRadius > 0 ? flex.borderRadius : 0) - edge, 0);
    if (flex.widget === WIDGET_SLIDER) {
      const slider = flex as unknown as Slider;
      const thumb = slider.thumbSize();
      const x = edge + slider.fraction() * Math.max(width - thumb, 0);
      const fill = x + thumb / 2 - edge;
      if (fill > 0 && slider.fillColor !== "")
        list.box(this.#partAt(world, edge, edge), fill, height, this.#color(slider.fillColor), 0, 0, radius);
      if (thumb > 0) list.box(this.#partAt(world, x, edge), thumb, height, this.#color(slider.thumbColor), 0, 0, radius);
    } else if (flex.widget === WIDGET_TEXT) {
      // The caret, while the field has the focus: one pixel wide (scaled with the box), the label's height, after the text (where
      // the children end, less the padding after them), or before the placeholder. It blinks twice a second while the clock runs.
      const field = flex as unknown as TextInput;
      if (flex.world === null || flex.world.focused !== (flex as unknown) || field.disabled === true) return;
      if (this.#time !== undefined && Math.floor(this.#time * 2) % 2 === 1) return;
      const label = field.label;
      const x = field.showsPlaceholder()
        ? label.layoutX
        : (flex.box.contentEnd[0] as number) - (flex.paddingRight ?? flex.paddingX ?? flex.padding ?? 0) - flex.scrollX;
      const top = label.layoutY;
      const tall = Math.max((flex.box.size[1] as number) - top - (flex.paddingBottom ?? flex.paddingY ?? flex.padding ?? 0) - edge, 1);
      list.box(this.#partAt(world, Math.min(x, edge + width - 1), top), 1, tall, this.#color(field.caretColor), 0, 0, 0);
    } else if (flex.widget === WIDGET_TOGGLE) {
      const toggle = flex as unknown as Toggle;
      list.box(
        this.#partAt(world, edge, edge),
        width,
        height,
        this.#color(toggle.checked ? toggle.onColor : toggle.offColor),
        0,
        0,
        height / 2
      );
      const gap = Math.min(2, height / 4);
      const knob = Math.max(height - 2 * gap, 0);
      if (knob > 0)
        list.box(
          this.#partAt(world, toggle.checked ? edge + width - gap - knob : edge + gap, edge + gap),
          knob,
          knob,
          this.#color(toggle.thumbColor),
          0,
          0,
          knob / 2
        );
    }
  }

  /** The pixels of one side's slice (0 when it is not given, or not a number of at least 0). */
  #slice(side: number | undefined, all: number | undefined): number {
    const v = side ?? all;
    return v !== undefined && v > 0 && Number.isFinite(v) ? v : 0;
  }

  /**
   * A `<Flex>`'s background image, cut into nine by its slices: the four corners keep their size, the four edges stretch along
   * one axis and the middle stretches along both. Each part is a `TSE_OP_SPRITE_REGION` of the image, scaled to fill its place
   * (a record's own scale does the stretching, so this needs nothing of the native side), under the box's own transform. A slice
   * past the image's size is cut down to fit it. A box smaller than its corners shrinks them all in proportion, as CSS does.
   * A part with nothing in it (a middle of no width) is not drawn. An image that is missing is a magenta box, once warned of.
   */
  #paintImage(flex: Flex, world: WorldTransform, image: string): void {
    const width = flex.box.size[0] as number;
    const height = flex.box.size[1] as number;
    if (!(width > 0 && height > 0)) return;
    const handle = this.#texture(image);
    if (handle < 0) {
      this.#list.rect(world, width, height, MAGENTA);
      return;
    }
    const size = this.#imageSize(image);
    const iw = size.width;
    const ih = size.height;
    if (!(iw > 0 && ih > 0)) return; // a backend that cannot say how big the picture is cannot cut it
    let left = this.#slice(flex.sliceLeft, flex.slice);
    let right = this.#slice(flex.sliceRight, flex.slice);
    let top = this.#slice(flex.sliceTop, flex.slice);
    let bottom = this.#slice(flex.sliceBottom, flex.slice);
    if (left + right > iw) {
      const k = iw / (left + right);
      left *= k;
      right *= k;
    }
    if (top + bottom > ih) {
      const k = ih / (top + bottom);
      top *= k;
      bottom *= k;
    }
    // On the box the corners are as big as the slices, unless the box is too small for both, and then they shrink together.
    const fit = Math.min(1, left + right > 0 ? width / (left + right) : 1, top + bottom > 0 ? height / (top + bottom) : 1);
    const dl = left * fit;
    const dr = right * fit;
    const dt = top * fit;
    const db = bottom * fit;
    // Columns and rows: where each starts in the image, how wide it is there, and where and how wide it is drawn. Kept in one
    // scratch array (three of each, in this order), so that drawing a skin allocates nothing.
    const p = this.#parts;
    p[SRC_X] = 0;
    p[SRC_X + 1] = left;
    p[SRC_X + 2] = iw - right;
    p[SRC_W] = left;
    p[SRC_W + 1] = iw - left - right;
    p[SRC_W + 2] = right;
    p[DST_X] = 0;
    p[DST_X + 1] = dl;
    p[DST_X + 2] = width - dr;
    p[DST_W] = dl;
    p[DST_W + 1] = width - dl - dr;
    p[DST_W + 2] = dr;
    p[SRC_Y] = 0;
    p[SRC_Y + 1] = top;
    p[SRC_Y + 2] = ih - bottom;
    p[SRC_H] = top;
    p[SRC_H + 1] = ih - top - bottom;
    p[SRC_H + 2] = bottom;
    p[DST_Y] = 0;
    p[DST_Y + 1] = dt;
    p[DST_Y + 2] = height - db;
    p[DST_H] = dt;
    p[DST_H + 1] = height - dt - db;
    p[DST_H + 2] = db;
    const cos = world.rotation === 0 ? 1 : Math.cos(world.rotation);
    const sin = world.rotation === 0 ? 0 : Math.sin(world.rotation);
    for (let row = 0; row < 3; row++) {
      const sh = p[SRC_H + row] as number;
      const dh = p[DST_H + row] as number;
      if (!(sh > 0 && dh > 0)) continue;
      for (let col = 0; col < 3; col++) {
        const sw = p[SRC_W + col] as number;
        const dw = p[DST_W + col] as number;
        if (!(sw > 0 && dw > 0)) continue;
        // The part's corner in the box, taken through the box's own scale and rotation to where it is in the world.
        const ox = (p[DST_X + col] as number) * world.scaleX;
        const oy = (p[DST_Y + row] as number) * world.scaleY;
        this.#list.spriteRegionAt(
          world.x + ox * cos - oy * sin,
          world.y + ox * sin + oy * cos,
          world.rotation,
          world.scaleX * (dw / sw),
          world.scaleY * (dh / sh),
          handle,
          p[SRC_X + col] as number,
          p[SRC_Y + row] as number,
          sw,
          sh,
          0,
          0,
          0,
          0xffffffff
        );
      }
    }
  }

  /** The size of one line of `object` in `font` (undefined: the built-in font). An empty line has the height of a line. */
  #lineSize(object: Text, font: string | undefined, line: string): Size {
    if (font === undefined) {
      if (line === "") return { width: 0, height: this.#textSize("M", object.size).height };
      return this.#textSize(line, object.size);
    }
    return this.#bitmapSize(font, line, this.#bitmapHeight(object, font));
  }

  /**
   * Break a text into lines: at each `\n`, and, with a `maxWidth`, at the spaces where a line would be too wide; a word wider than
   * `maxWidth` by itself is broken inside, as late as it fits. The spaces at a break are not drawn. Cached by font, size, width and text.
   */
  #wrap(object: Text, font: string | undefined): WrappedText {
    const maxWidth = object.maxWidth;
    const key = `${font ?? ""}|${object.size}|${object.sized ? 1 : 0}|${maxWidth ?? ""}|${object.text}`;
    let wrapped = this.#wraps.get(key);
    if (wrapped !== undefined) return wrapped;
    const lines: string[] = [];
    const starts: number[] = [];
    let offset = 0; // in characters (code points) of the whole text
    for (const paragraph of object.text.split("\n")) {
      const paragraphLength = [...paragraph].length;
      if (maxWidth === undefined || !(maxWidth > 0)) {
        lines.push(paragraph);
        starts.push(offset);
      } else {
        // Words with where each starts, in characters of the paragraph; runs of spaces count as one separator.
        let line = "";
        let lineStart = 0;
        let position = 0;
        const fits = (text: string): boolean => this.#lineSize(object, font, text).width <= maxWidth;
        for (const word of paragraph.split(" ")) {
          const wordLength = [...word].length;
          if (word === "") {
            position += 1;
            continue;
          }
          const candidate = line === "" ? word : `${line} ${word}`;
          if (fits(candidate)) {
            if (line === "") lineStart = position;
            line = candidate;
          } else {
            if (line !== "") {
              lines.push(line);
              starts.push(offset + lineStart);
              line = "";
            }
            if (fits(word)) {
              line = word;
              lineStart = position;
            } else {
              // A word wider than the box alone: break it by characters, each piece as long as fits.
              let piece = "";
              let pieceStart = position;
              let index = position;
              for (const ch of word) {
                if (piece !== "" && !fits(piece + ch)) {
                  lines.push(piece);
                  starts.push(offset + pieceStart);
                  piece = "";
                  pieceStart = index;
                }
                piece += ch;
                index++;
              }
              line = piece;
              lineStart = pieceStart;
            }
          }
          position += wordLength + 1;
        }
        lines.push(line);
        starts.push(offset + lineStart);
      }
      offset += paragraphLength + 1; // the "\n"
    }
    wrapped = { lines, starts };
    if (this.#wraps.size >= TEXT_CACHE_LIMIT) this.#wraps.clear();
    this.#wraps.set(key, wrapped);
    return wrapped;
  }

  /** How much of a wrapped line shows: all of it, or the part of it that comes before `reveal` characters of the whole text. */
  #shown(object: Text, line: string, start: number): string {
    const reveal = object.reveal;
    if (reveal === undefined) return line;
    const count = Math.max(0, Math.min([...line].length, Math.floor(reveal) - start));
    return count >= [...line].length ? line : [...line].slice(0, count).join("");
  }

  #textSize(text: string, size: number): Size {
    const key = `${size}:${text}`;
    let measured = this.#textSizes.get(key);
    if (measured === undefined) {
      measured = this.#measureText ? this.#measureText(text, size) : { width: estimateTextWidth(text, size), height: size };
      if (this.#textSizes.size >= TEXT_CACHE_LIMIT) this.#textSizes.clear();
      this.#textSizes.set(key, measured);
    }
    return measured;
  }

  #imageSize(image: string): Size {
    if (image === "") return NO_SIZE;
    const handle = this.#texture(image);
    if (handle < 0) return { width: MISSING_TEXTURE_SIZE, height: MISSING_TEXTURE_SIZE };
    let size = this.#textureSizes.get(handle);
    if (size === undefined) {
      if (this.#textureSize) size = this.#textureSize(handle);
      else {
        this.#warner.once("texture-size", "This backend cannot report texture sizes: sprites measure 0 × 0 for layout.");
        size = NO_SIZE;
      }
      this.#textureSizes.set(handle, size);
    }
    return size;
  }

  /** A root `<Screen>` with a size it can be drawn at, or null (warning once) to draw the game at the window's size. */
  #usableScreen(screen: Screen): Screen | null {
    if (screen.width > 0 && screen.height > 0 && Number.isFinite(screen.width) && Number.isFinite(screen.height)) return screen;
    this.#warner.once(
      `screen-size:${screen.width}x${screen.height}`,
      `A <Screen> needs a positive width and height, not ${screen.width} × ${screen.height}: drawing at the window's size instead.`
    );
    return null;
  }

  #fit(screen: Screen): ScreenFit {
    const fit = screen.fit;
    if (fit === "integer" || fit === "contain" || fit === "stretch" || fit === "expand") return fit;
    this.#warner.once(
      `screen-fit:${String(fit)}`,
      `Unknown <Screen fit> '${String(fit)}': using "integer". The choices are "integer", "contain", "stretch" and "expand".`
    );
    return "integer";
  }

  /** Cover the window outside the game with `color`: a view in window pixels, then up to four rectangles. */
  #borders(placement: ScreenPlacement, width: number, height: number, color: PackedColor): void {
    const rects = borderRects(placement, width, height);
    if (rects.length === 0) return;
    this.#list.view(IDENTITY_VIEW);
    for (const rect of rects) this.#list.rect({ x: rect.x, y: rect.y, rotation: 0, scaleX: 1, scaleY: 1 }, rect.width, rect.height, color);
  }

  #shape(shape: Shape, world: WorldTransform): void {
    const color = this.#color(shape.color);
    if (shape.kind === "circle") this.#list.ellipse(world, shape.width, shape.height, color);
    else this.#list.rect(world, shape.width, shape.height, color);
  }

  /**
   * A `<Line>` at `world` (where its start is): one rect record from there to (`x2`, `y2`) in its parent's space, turned along
   * the line, its thickness centred on it. The parent's turn and scale are `world`'s less the line's own (its layout offset,
   * placement and transform), so the end is where the parent puts (`x2`, `y2`) whatever the line's own rotation and scale.
   */
  #line(line: Line, world: WorldTransform): void {
    const local = composeTransforms(
      composeTransforms(offsetTransform(IDENTITY_TRANSFORM, line.layoutX, line.layoutY), line.placement),
      line.transform
    );
    if (local.scaleX === 0 || local.scaleY === 0) return;
    const parentRotation = world.rotation - local.rotation;
    const parentScaleX = world.scaleX / local.scaleX;
    const parentScaleY = world.scaleY / local.scaleY;
    // The line in the parent's space, scaled as the parent scales, then turned as it turns.
    const lx = (line.x2 - local.x) * parentScaleX;
    const ly = (line.y2 - local.y) * parentScaleY;
    const cos = Math.cos(parentRotation);
    const sin = Math.sin(parentRotation);
    const dx = lx * cos - ly * sin;
    const dy = lx * sin + ly * cos;
    const length = Math.hypot(dx, dy);
    const thickness = line.width * Math.sqrt(Math.abs(parentScaleX * parentScaleY));
    if (!(length > 0) || !(thickness > 0)) return;
    const angle = Math.atan2(dy, dx);
    // The rect's corner: half the thickness to the left of the start, across the line.
    const half = thickness / 2;
    const place = this.#linePlaced;
    place.x = world.x + Math.sin(angle) * half;
    place.y = world.y - Math.cos(angle) * half;
    place.rotation = angle;
    this.#list.rect(place, length, thickness, this.#color(line.color));
  }

  /** A bitmap text's height: its size, or without one given the font's cell height. */
  #bitmapHeight(text: Text, font: string): number {
    if (text.sized) return text.size;
    const sheet = this.#imageSize(font);
    return sheet.height > 0 ? sheet.height / FONT_ROWS : text.size;
  }

  /**
   * The size of a text drawn with a bitmap font: each character's advance (a built-in font's own, else a cell's width), the size
   * as its height.
   */
  #bitmapSize(font: string, text: string, size: number): Size {
    const sheet = this.#imageSize(font);
    if (sheet.width === 0 || sheet.height === 0) return { width: estimateTextWidth(text, size), height: size };
    const cellW = sheet.width / FONT_COLUMNS;
    const scale = size / (sheet.height / FONT_ROWS);
    const advances = builtinAdvances(font);
    let width = 0;
    for (const ch of text) width += advances === undefined ? cellW : glyphAdvance(advances, ch);
    return { width: width * scale, height: size };
  }

  /** Text drawn from a bitmap font: one region of the font sheet for each character, in the text's colour. Wrapped and revealed text draws line by line. */
  #bitmapText(text: Text, at: WorldTransform): void {
    const font = (text.font ?? this.font) as string;
    const handle = this.#texture(font);
    const sheet = this.#imageSize(font);
    if (handle < 0 || sheet.width === 0 || sheet.height === 0) {
      if (handle >= 0)
        this.#warner.once(
          `font-size:${font}`,
          `The font '${font}' has no known size (this backend cannot report texture sizes): its text is not drawn.`
        );
      return;
    }
    const cellW = sheet.width / FONT_COLUMNS;
    const cellH = sheet.height / FONT_ROWS;
    const scale = (text.sized ? text.size : cellH) / cellH;
    const advances = builtinAdvances(font);
    const color = this.#ink ?? this.#color(text.color);
    const cos = Math.cos(at.rotation);
    const sin = Math.sin(at.rotation);
    const multiline = isMultiline(text);
    const wrapped = multiline ? this.#wrap(text, font) : null;
    const lineHeight = this.#bitmapHeight(text, font);
    const box = textAlignBox(text);
    const lines = wrapped === null ? [text.text] : wrapped.lines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      const shown = wrapped === null ? line : this.#shown(text, line, wrapped.starts[i] as number);
      if (shown === "") continue;
      let x = 0;
      if (box !== undefined && text.align !== "left") {
        const room = box - this.#bitmapSize(font, line, lineHeight).width;
        x = text.align === "center" ? Math.round(room / 2) : Math.round(room);
      }
      const y = i * (lineHeight + text.lineGap);
      for (const ch of shown) {
        const code = ch.codePointAt(0) as number;
        const glyph = code >= 32 && code < 128 ? code - 32 : 63 - 32; // anything else is a "?"
        if (glyph !== 0) {
          const lx = x * at.scaleX;
          const ly = y * at.scaleY;
          this.#list.spriteRegionAt(
            at.x + cos * lx - sin * ly,
            at.y + sin * lx + cos * ly,
            at.rotation,
            at.scaleX * scale,
            at.scaleY * scale,
            handle,
            (glyph % FONT_COLUMNS) * cellW,
            Math.floor(glyph / FONT_COLUMNS) * cellH,
            cellW,
            cellH,
            0,
            0,
            0,
            color
          );
        }
        x += (advances === undefined ? cellW : glyphAdvance(advances, ch)) * scale;
      }
    }
  }

  /**
   * A `<Text>`, with its shadow and outline if it has them: the text is drawn again, under itself, in the shadow's colour and in
   * the outline's, a pixel at a time around where it is, and then once in its own colour. Each is the whole text drawn the ordinary
   * way (a record for each line, a region for each glyph of a bitmap font), shifted in the text's own axes so that it turns and
   * scales with it. They are before the text in draw order, so the same `z`, and they take no room: layout measured the text alone.
   */
  #text(text: Text, world: WorldTransform): void {
    if (text.shadow === undefined && text.outline === undefined) {
      this.#drawText(text, world);
      return;
    }
    const reach = text.outline === undefined || !(text.outlineWidth >= 1) ? 0 : Math.min(MAX_OUTLINE, Math.round(text.outlineWidth));
    const cos = Math.cos(world.rotation);
    const sin = Math.sin(world.rotation);
    const at = this.#shifted;
    at.rotation = world.rotation;
    at.scaleX = world.scaleX;
    at.scaleY = world.scaleY;
    // The shadow falls from the outlined shape, so it is a copy of the outline's every offset, and of the text itself, moved by its own.
    if (text.shadow !== undefined) {
      this.#ink = this.#color(text.shadow);
      const sx = Number.isFinite(text.shadowX) ? text.shadowX : 0;
      const sy = Number.isFinite(text.shadowY) ? text.shadowY : 0;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx * dx + dy * dy > reach * reach + reach) continue;
          const lx = (sx + dx) * world.scaleX;
          const ly = (sy + dy) * world.scaleY;
          at.x = world.x + cos * lx - sin * ly;
          at.y = world.y + sin * lx + cos * ly;
          this.#drawText(text, at);
        }
      }
    }
    if (reach > 0) {
      this.#ink = this.#color(text.outline as string);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if ((dx === 0 && dy === 0) || dx * dx + dy * dy > reach * reach + reach) continue;
          const lx = dx * world.scaleX;
          const ly = dy * world.scaleY;
          at.x = world.x + cos * lx - sin * ly;
          at.y = world.y + sin * lx + cos * ly;
          this.#drawText(text, at);
        }
      }
    }
    this.#ink = undefined;
    this.#drawText(text, world);
  }

  /** The text itself, once, in `#ink` if an effect is being drawn and in its own colour if not. */
  #drawText(text: Text, world: WorldTransform): void {
    const font = text.font ?? this.font;
    if (font !== undefined) {
      this.#bitmapText(text, world);
      return;
    }
    const color = this.#ink ?? this.#color(text.color);
    if (isMultiline(text)) {
      // Wrapped, broken or revealed: a record for each line, one line height (and the gap) below the last, aligned by itself.
      const wrapped = this.#wrap(text, undefined);
      const box = textAlignBox(text);
      const lineHeight = this.#lineSize(text, undefined, "").height;
      const cos = Math.cos(world.rotation);
      const sin = Math.sin(world.rotation);
      for (let i = 0; i < wrapped.lines.length; i++) {
        const line = wrapped.lines[i] as string;
        const shown = this.#shown(text, line, wrapped.starts[i] as number);
        if (shown === "") continue;
        let shift = 0;
        if (box !== undefined && text.align !== "left") {
          const room = box - this.#textSize(line, text.size).width;
          shift = text.align === "center" ? Math.round(room / 2) : Math.round(room);
        }
        const lx = shift * world.scaleX;
        const ly = i * (lineHeight + text.lineGap) * world.scaleY;
        this.#list.text(
          {
            x: world.x + cos * lx - sin * ly,
            y: world.y + sin * lx + cos * ly,
            rotation: world.rotation,
            scaleX: world.scaleX,
            scaleY: world.scaleY,
          },
          shown,
          text.size,
          color
        );
      }
      return;
    }
    let at = world;
    const box = textAlignBox(text);
    if (box !== undefined && text.align !== "left") {
      // Aligned inside its own width, or on its point (a box of 0): shift along the text's own x axis, by whole pixels.
      const room = box - this.#textSize(text.text, text.size).width;
      const shift = text.align === "center" ? Math.round(room / 2) : text.align === "right" ? Math.round(room) : 0;
      if (shift !== 0) {
        const along = shift * world.scaleX;
        at = {
          x: world.x + Math.cos(world.rotation) * along,
          y: world.y + Math.sin(world.rotation) * along,
          rotation: world.rotation,
          scaleX: world.scaleX,
          scaleY: world.scaleY,
        };
      }
    }
    this.#list.text(at, text.text, text.size, color);
  }

  /** Window origin at the top-left with no camera; with one, the followed point lands on the centre of a `width` × `height` view (the window, or the game's screen). */
  #view(camera: Camera | null, width: number, height: number): ViewTransform {
    if (camera === null) return IDENTITY_VIEW;
    try {
      const v = camera.viewTransform();
      return { a: v.a, b: v.b, c: v.c, d: v.d, e: v.e + width / 2, f: v.f + height / 2 };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      this.#warner.once("camera-range", `The camera is unusable, so the frame is drawn without it: ${error.message}`);
      return IDENTITY_VIEW;
    }
  }

  /** The texture handle for an image name, loading it the first time (-1, warned about once, if it cannot be loaded). */
  /** A `<Light>`: its colour at its intensity (0 to 1) as the record's alpha. Nothing for no radius or no intensity. */
  #light(node: Light, at: WorldTransform): void {
    const intensity = node.intensity >= 1 ? 1 : node.intensity > 0 ? node.intensity : 0;
    if (!(node.radius > 0) || intensity === 0) return;
    this.#list.light(at, node.radius, fadeColor(this.#color(node.color), intensity));
  }

  /** The handle of a layer's or a sprite's shader, loaded the first time it is named: -1 for none (or one that failed), with a warning once. */
  #shader(name: string): number {
    if (name === "") return -1;
    let handle = this.#shaders.get(name);
    if (handle === undefined) {
      const path = `${this.#assets}/${name}`;
      handle = this.#loadShader ? this.#loadShader(path) : -2;
      this.#shaders.set(name, handle);
      if (handle === -1)
        this.#warner.once(
          `shader:${name}`,
          `The shader '${path}' could not be loaded (a missing file, or GLSL that does not compile): what it shades is drawn without it.`
        );
      else if (handle === -2)
        this.#warner.once(
          "shaders-unsupported",
          "This renderer runs no shaders (the software renderer): layers and sprites are drawn without them."
        );
    }
    return handle < 0 ? -1 : handle;
  }

  /** Close a `<Layer>`: its blend, its opacity, and its shader with its params and lookup. */
  #layerEnd(layer: Layer): void {
    const shader = this.#shader(layer.shader);
    const lookup = shader >= 0 && layer.lookup !== "" ? this.#texture(layer.lookup) : -1;
    const given = this.#list.layerEnd(
      blendCode(layer.blend),
      layer.opacity,
      shader,
      shader < 0 ? 0 : (this.#time ?? 0),
      layer.params,
      lookup < 0 ? -1 : lookup
    );
    if (given > TSE_SHADER_PARAMS) this.#tooManyParams(`'${layer.shader}'`, given);
  }

  /** Say once for a shader (`'wall.glsl'`, or `of the sprite 'fruit.png'`) that it was given more numbers than a shader takes. */
  #tooManyParams(shader: string, given: number): void {
    this.#warner.once(
      `params:${shader}`,
      `The shader ${shader} was given ${given} params: a shader takes ${TSE_SHADER_PARAMS}, so the rest are left out.`
    );
  }

  #texture(image: string): number {
    // By image name, not by path: the path would be put together again for every sprite of every frame.
    let handle = this.#textures.get(image);
    if (handle === undefined) {
      // A `tse:` name is built into libtse, not a file in the assets folder.
      if (isBuiltinName(image)) {
        if ((BUILTIN_FONTS as readonly string[]).includes(image)) handle = this.#loadTexture(image);
        else {
          handle = -1;
          this.#warner.once(`texture:${image}`, `There is no built-in '${image}' (there is: ${BUILTIN_FONTS.join(", ")}).`);
        }
        this.#textures.set(image, handle);
        if (handle < 0 && (BUILTIN_FONTS as readonly string[]).includes(image))
          this.#warner.once(`texture:${image}`, `This libtse has no '${image}' (it needs ABI v15 or newer).`);
        return handle;
      }
      const path = `${this.#assets}/${image}`;
      handle = this.#loadTexture(path);
      this.#textures.set(image, handle);
      if (handle < 0) this.#warner.once(`texture:${path}`, `Could not load the texture '${path}': drawing a magenta square instead.`);
    }
    return handle;
  }

  /** A sprite or animated sprite: the whole image, or, when it has a sheet frame or options, a region of it. */
  #spriteNode(node: Sprite | AnimatedSprite, world: WorldTransform): void {
    if (!styledSprite(node)) {
      this.#sprite(node.image, world);
      return;
    }
    let tint = node.tint === undefined ? 0xffffffff : this.#color(node.tint);
    const opacity = node.opacity;
    if (opacity !== 1) {
      const alpha = Math.round((tint & 255) * Math.min(1, Math.max(0, opacity !== opacity ? 1 : opacity)));
      tint = ((tint & 0xffffff00) | alpha) >>> 0;
    }
    const at = world;
    const sheet = node instanceof AnimatedSprite ? node.isSheet : node.frameWidth !== undefined || node.frameHeight !== undefined;
    const frame = node instanceof AnimatedSprite ? node.sheetFrame : node.frame;
    const shader = node.shader === "" ? -1 : this.#shader(node.shader);
    const lookup = shader >= 0 && node.lookup !== "" ? this.#texture(node.lookup) : -1;
    this.#region(
      node.image,
      sheet,
      node.frameWidth,
      node.frameHeight,
      frame,
      node.originX,
      node.originY,
      node.flipX,
      node.flipY,
      tint,
      at,
      0,
      shader,
      lookup < 0 ? -1 : lookup,
      node.params
    );
    // `flash`: the same region again, as its shape filled with the flash colour at that fraction (and the sprite's opacity), so
    // the opaque pixels are mixed toward the colour and the transparent ones stay so.
    const flash = node.flash;
    if (flash > 0) {
      const color = this.#color(node.flashColor);
      const amount = Math.min(1, flash) * Math.min(1, Math.max(0, opacity !== opacity ? 1 : opacity));
      const alpha = Math.round((color & 255) * amount);
      if (alpha > 0) {
        const silhouette = ((color & 0xffffff00) | alpha) >>> 0;
        this.#region(
          node.image,
          sheet,
          node.frameWidth,
          node.frameHeight,
          frame,
          node.originX,
          node.originY,
          node.flipX,
          node.flipY,
          silhouette,
          at,
          TSE_SPRITE_SILHOUETTE
        );
      }
    }
  }

  /** One frame of an image (or all of it), as a sprite-region record; through `shader` (a handle, -1 for none) as a shaded one. */
  #region(
    image: string,
    sheet: boolean,
    sheetWidth: number | undefined,
    sheetHeight: number | undefined,
    frame: number,
    originX: number,
    originY: number,
    flipX: boolean,
    flipY: boolean,
    tint: number,
    at: WorldTransform,
    flags = 0,
    shader = -1,
    lookup = -1,
    params: ShaderParams = NO_PARAMS
  ): void {
    if (image === "") return;
    const handle = this.#texture(image);
    if (handle < 0) {
      this.#list.rect(at, MISSING_TEXTURE_SIZE, MISSING_TEXTURE_SIZE, MAGENTA);
      return;
    }
    const texture = this.#imageSize(image);
    const frameWidth = sheet ? (sheetWidth ?? texture.width) : texture.width;
    const frameHeight = sheet ? (sheetHeight ?? texture.height) : texture.height;
    let srcX = 0;
    let srcY = 0;
    if (sheet && frame > 0 && frameWidth > 0) {
      const columns = Math.max(1, Math.floor(texture.width / frameWidth));
      srcX = (frame % columns) * frameWidth;
      srcY = Math.floor(frame / columns) * frameHeight;
    }
    if (!(frameWidth > 0 && frameHeight > 0)) {
      this.#warner.once(
        `sprite-size:${image}`,
        `The sprite '${image}' has no known size (this backend cannot report texture sizes and no frameWidth and frameHeight are set): it is not drawn.`
      );
      return;
    }
    flags |= (flipX ? TSE_SPRITE_FLIP_X : 0) | (flipY ? TSE_SPRITE_FLIP_Y : 0);
    if (shader >= 0) {
      const given = this.#list.spriteShaded(
        at,
        handle,
        srcX,
        srcY,
        frameWidth,
        frameHeight,
        originX,
        originY,
        flags,
        tint,
        shader,
        lookup,
        this.#time ?? 0,
        params
      );
      if (given > TSE_SHADER_PARAMS) this.#tooManyParams(`of the sprite '${image}'`, given);
    } else this.#list.spriteRegion(at, handle, srcX, srcY, frameWidth, frameHeight, originX, originY, flags, tint);
  }

  /**
   * The part of the world the view shows, as a rectangle in world pixels: the window (or, for a pixel-perfect game, the game's
   * area) taken back through the view. Null when the view cannot be inverted. Found once per frame, through last frame's camera.
   */
  #visibleRect(): WorldRect | null {
    if (this.#cullRect !== undefined) return this.#cullRect;
    const area = this.#area as FrameArea;
    const camera = this.#cullCamera;
    let cameraView = IDENTITY_VIEW;
    if (camera !== null) {
      camera.viewWidth = area.gameWidth;
      camera.viewHeight = area.gameHeight;
      cameraView = this.#view(camera, area.gameWidth, area.gameHeight);
    }
    this.#culledWith = camera;
    const v = area.pixelPerfect || area.placement === null ? cameraView : viewToWindow(cameraView, area.placement);
    const w = area.pixelPerfect ? area.gameWidth : area.width;
    const h = area.pixelPerfect ? area.gameHeight : area.height;
    const det = v.a * v.d - v.b * v.c;
    let rect: WorldRect | null = null;
    if (Math.abs(det) > 1e-12 && Number.isFinite(det)) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < 4; k++) {
        const px = (k & 1) === 0 ? 0 : w;
        const py = (k & 2) === 0 ? 0 : h;
        const wx = (v.d * (px - v.e) - v.c * (py - v.f)) / det;
        const wy = (v.a * (py - v.f) - v.b * (px - v.e)) / det;
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy;
        if (wy > y1) y1 = wy;
      }
      if (Number.isFinite(x0 + x1 + y0 + y1)) rect = { x0, y0, x1, y1 };
    }
    this.#cullRect = rect;
    return rect;
  }

  /** Each tilemap's records from the last time it was drawn, and what they were made from (see `#tilemap`). */
  readonly #tileCache = new WeakMap<
    Tilemap,
    { grid: object; layer: string | undefined; handles: string; key: Float64Array; records: Float64Array }
  >();
  readonly #tileKey = new Float64Array(11);

  /**
   * A `<Tilemap>`: one sprite-region record for each filled cell of each visible layer. A map that is not turned or scaled, in the
   * world, writes only the cells the view shows (and one more cell round them), so a map of any size costs what its view does.
   * With `image`, every tile is cut from that one sheet; without it, each tile from its own tileset's sheet, as the map names them.
   */
  #tilemap(node: Tilemap, at: WorldTransform, cull: boolean): void {
    const grid = findTilemap(node.map);
    if (grid === undefined) {
      this.#warner.once(
        `tilemap:${node.map}`,
        `<Tilemap map="${node.map}">: no map of that name is registered (registerTilemaps(tilemaps) with the compiler's generated table, before the game starts).`
      );
      return;
    }
    const tw = grid.tileWidth;
    const th = grid.tileHeight;
    if (!(tw > 0 && th > 0)) return;
    const sheets = this.#tileSheets(node, grid.data);
    if (sheets.length === 0) return;
    const cos = Math.cos(at.rotation);
    const sin = Math.sin(at.rotation);
    const sx = at.scaleX;
    const sy = at.scaleY;
    let tint = 0xffffffff;
    if (node.opacity !== 1) tint = ((tint & 0xffffff00) | Math.round(255 * Math.min(1, Math.max(0, node.opacity)))) >>> 0;
    const width = grid.width;
    const height = grid.height;
    let col0 = 0;
    let col1 = width - 1;
    let row0 = 0;
    let row1 = height - 1;
    if (cull && at.rotation === 0 && sx === 1 && sy === 1) {
      const visible = this.#visibleRect();
      if (visible !== null) {
        // A tile taller or wider than a cell is drawn up and to the right of its cell (Tiled's bottom-left anchor), so cells that
        // far below or to the left of the view can still show.
        let extraCols = 0;
        let extraRows = 0;
        for (const sheet of sheets) {
          extraCols = Math.max(extraCols, Math.ceil(sheet.tw / tw) - 1);
          extraRows = Math.max(extraRows, Math.ceil(sheet.th / th) - 1);
        }
        col0 = Math.max(0, Math.floor((visible.x0 - at.x) / tw) - 1 - extraCols);
        col1 = Math.min(width - 1, Math.floor((visible.x1 - at.x) / tw) + 1);
        row0 = Math.max(0, Math.floor((visible.y0 - at.y) / th) - 1);
        row1 = Math.min(height - 1, Math.floor((visible.y1 - at.y) / th) + 1 + extraRows);
      }
    }
    // The records depend on nothing else: the same as last frame (a map that has not moved, under a view that has not), they are
    // copied as one block. Under QuickJS that is most of a tilemap's cost in a busy frame. Only when the builder reuses work
    // (`retain`), so `retain: "check"`'s reference build draws every cell afresh and catches a stale copy.
    const list = this.#list;
    let handles = "";
    for (const sheet of sheets) handles += `${sheet.handle},`;
    const key = this.#tileKey;
    key[0] = at.x;
    key[1] = at.y;
    key[2] = at.rotation;
    key[3] = sx;
    key[4] = sy;
    key[5] = col0;
    key[6] = col1;
    key[7] = row0;
    key[8] = row1;
    key[9] = tint;
    key[10] = list.alpha;
    const cached = this.#tileCache.get(node);
    if (
      this.#retain &&
      cached !== undefined &&
      cached.grid === grid &&
      cached.layer === node.layer &&
      cached.handles === handles &&
      sameNumbers(cached.key, key)
    ) {
      list.appendRecords(cached.records);
      return;
    }
    const start = list.length;
    const single = sheets.length === 1 ? sheets[0]! : null;
    for (const layer of grid.data.layers) {
      if (!layer.visible || (node.layer !== undefined && layer.name !== node.layer)) continue;
      const data = layer.data;
      const flips = layer.flips;
      for (let row = row0; row <= row1; row++) {
        for (let col = col0; col <= col1; col++) {
          const i = row * width + col;
          const gid = data[i] as number;
          if (gid === 0) continue;
          let sheet = single;
          if (sheet === null) {
            // The tileset with the largest first id not above this one; a map has a handful, so a walk from the end is enough.
            for (let k = sheets.length - 1; k >= 0; k--) {
              if ((sheets[k] as TileSheet).firstGid <= gid) {
                sheet = sheets[k] as TileSheet;
                break;
              }
            }
            if (sheet === null) continue;
          }
          const frame = gid - sheet.firstGid;
          if (frame < 0 || sheet.handle < 0) continue;
          const stw = sheet.tw;
          const sth = sheet.th;
          const srcX = sheet.margin + (frame % sheet.columns) * (stw + sheet.spacing);
          const srcY = sheet.margin + Math.floor(frame / sheet.columns) * (sth + sheet.spacing);
          const flip = flips === undefined ? 0 : (flips[i] as number);
          let lx = col * tw;
          let ly = row * th + th - sth; // a tile sits on the bottom of its cell, as Tiled draws one of another size
          let rotation = at.rotation;
          let flags = 0;
          let ox = 0;
          let oy = 0;
          if (flip !== 0) {
            // Mirrored tiles turn about their middle. Tiled applies the diagonal flip first, then horizontal, then vertical; each
            // combination is a quarter turn and at most one mirror, which is what a record can say.
            lx += stw / 2;
            ly += sth / 2;
            ox = stw / 2;
            oy = sth / 2;
            const h = (flip & TILE_FLIP_H) !== 0;
            const v = (flip & TILE_FLIP_V) !== 0;
            if ((flip & TILE_FLIP_D) === 0) flags = (h ? TSE_SPRITE_FLIP_X : 0) | (v ? TSE_SPRITE_FLIP_Y : 0);
            else if (!h && !v) {
              rotation += Math.PI / 2;
              flags = TSE_SPRITE_FLIP_Y;
            } else if (h && !v) rotation += Math.PI / 2;
            else if (!h && v) rotation += (3 * Math.PI) / 2;
            else {
              rotation += (3 * Math.PI) / 2;
              flags = TSE_SPRITE_FLIP_Y;
            }
          }
          const px = at.x + cos * lx * sx - sin * ly * sy;
          const py = at.y + sin * lx * sx + cos * ly * sy;
          this.#list.spriteRegionAt(px, py, rotation, sx, sy, sheet.handle, srcX, srcY, stw, sth, ox, oy, flags, tint);
        }
      }
    }
    if (this.#retain)
      this.#tileCache.set(node, {
        grid,
        layer: node.layer,
        handles,
        key: Float64Array.from(key),
        records: list.records.slice(start, list.length),
      });
  }

  /**
   * The sheets a `<Tilemap>` draws from, by first global id: its `image` for the whole map, or each of the map's tilesets. Empty,
   * with a warning, when there is nothing to draw from. A tileset that cannot be drawn (no sheet) is kept with a handle of -1, so
   * its tiles are skipped rather than cut from the wrong sheet.
   */
  #tileSheets(node: Tilemap, map: TilemapData): TileSheet[] {
    const tw = map.tileWidth;
    const th = map.tileHeight;
    if (node.image !== "") {
      const handle = this.#texture(node.image);
      if (handle < 0) return [];
      const size = this.#imageSize(node.image);
      if (!(size.width >= tw)) {
        this.#warner.once(
          `tilemap-sheet:${node.image}`,
          `The tile sheet '${node.image}' (${size.width} × ${size.height}) is smaller than one ${tw} × ${th} tile (or this backend cannot report texture sizes): the map is not drawn.`
        );
        return [];
      }
      return [{ firstGid: map.firstGid, handle, columns: Math.floor(size.width / tw), tw, th, margin: 0, spacing: 0 }];
    }
    const sets = map.tilesets ?? [];
    if (!sets.some((set) => set.image !== "")) {
      this.#warner.once(
        `tilemap-no-sheet:${node.map}`,
        `<Tilemap map="${node.map}"> has no \`image\`, and the map names no tile sheet in the assets folder: the map is not drawn. Give it an \`image\`, or keep the tilesets' images in the assets folder.`
      );
      return [];
    }
    return sets.map((set) => {
      const handle = set.image === "" || !(set.columns > 0) ? -1 : this.#texture(set.image);
      return {
        firstGid: set.firstGid,
        handle,
        columns: Math.max(1, set.columns),
        tw: set.tileWidth,
        th: set.tileHeight,
        margin: set.margin,
        spacing: set.spacing,
      };
    });
  }

  /** A `<Particles>`: a small filled square for each live particle, aged toward its end colour, smaller or fainter. */
  #particles(node: Particles, at: WorldTransform): void {
    const count = node.count;
    if (count === 0) return;
    const ownStart = this.#color(node.color);
    const ownEnd = node.endColor === undefined ? ownStart : this.#color(node.endColor);
    // Bursts given their own colours (`fx.burst(name, x, y, { color })`) say so per particle; most emitters have none.
    const painted = node.hasOwnColors;
    const scratch = this.#particle;
    const place = this.#placed;
    const world = node.space === "world";
    for (let i = 0; i < count; i++) {
      node.read(i, scratch);
      const t = scratch.t;
      const size = node.shrink ? node.size * (1 - t) : node.size;
      if (!(size > 0.01)) continue;
      let start = ownStart;
      let end = ownEnd;
      if (painted) {
        const own = node.colorsOf(i);
        if (own !== null) {
          start = this.#color(own.color);
          end = own.endColor === undefined ? start : this.#color(own.endColor);
        }
      }
      let color = start;
      if (end !== start) color = mixColors(start, end, t);
      if (node.fade) color = ((color & 0xffffff00) | Math.round((color & 255) * (1 - t))) >>> 0;
      if ((color & 255) === 0) continue;
      // Whole pixels, so particles stay crisp under a pixel-perfect screen.
      place.x = Math.round((world ? scratch.x : at.x + scratch.x * at.scaleX) - size / 2);
      place.y = Math.round((world ? scratch.y : at.y + scratch.y * at.scaleY) - size / 2);
      this.#list.rect(place, Math.max(1, Math.round(size)), Math.max(1, Math.round(size)), color);
    }
  }

  /** A `<Fade>` in a `<Hud>`: the colour, as faint as the fade is far along, over the whole screen. */
  #fade(node: Fade, width: number, height: number): void {
    if (!(node.amount > 0)) return;
    const color = this.#color(node.color);
    const alpha = Math.round((color & 255) * Math.min(1, node.amount));
    if (alpha === 0) return;
    const place = this.#placed;
    place.x = 0;
    place.y = 0;
    this.#list.rect(place, width, height, ((color & 0xffffff00) | alpha) >>> 0);
  }

  #sprite(image: string, world: WorldTransform): void {
    if (image === "") return;
    const handle = this.#texture(image);
    if (handle < 0) {
      this.#list.rect(world, MISSING_TEXTURE_SIZE, MISSING_TEXTURE_SIZE, MAGENTA);
      return;
    }
    // A plain sprite record has no colour to fade, so under a faded box the picture is a region of itself, with a tint that has the alpha.
    if (this.#list.alpha !== 1) {
      if (this.#list.alpha === 0) return;
      const size = this.#imageSize(image);
      if (size.width > 0 && size.height > 0) {
        this.#list.spriteRegion(world, handle, 0, 0, size.width, size.height, 0, 0, 0, 0xffffffff);
        return;
      }
    }
    this.#list.sprite(world, handle);
  }

  #color(css: string): PackedColor {
    let color = this.#colors.get(css);
    if (color === undefined) {
      const parsed = parseColor(css);
      if (parsed === null) this.#warner.once(`color:${css}`, `Cannot read the colour '${css}': using magenta.`);
      color = parsed ?? MAGENTA;
      this.#colors.set(css, color);
    }
    return color;
  }
}

/** Whether two arrays of numbers are equal, element by element (NaN never is: it is not drawn the same way twice). */
function sameNumbers(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
