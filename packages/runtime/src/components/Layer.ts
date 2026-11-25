import { Entity, type EntityProps } from "./Entity.ts";

/**
 * What a shader is given as `params`: numbers, or lists of numbers (a point, a colour, a list of ripples), laid end to end, up to
 * 32 numbers in all (ABI v17; eight before). `[split, [x, y], [x2, y2]]` is `params[0]` to `params[4]`; a shader reads a list back
 * with `param2(i)`, `param3(i)` or `param4(i)`, or in a loop over `params[i]`.
 */
export type ShaderParams = readonly (number | readonly number[])[];

/** How what is drawn meets what is under it. */
export type BlendMode = "normal" | "add" | "multiply" | "screen";

/** Every blend mode, for the compiler's check of a literal (`blend="mulitply"` is an error). */
export const BLEND_MODES: readonly BlendMode[] = ["normal", "add", "multiply", "screen"];

export interface LayerProps extends EntityProps {
  /**
   * How the layer is laid over what is under it, once its children are drawn into it. Default `"normal"`.
   * - `"normal"`: painted over, as any drawing is.
   * - `"multiply"`: shade. White leaves what is under it as it is, black makes it black: a dark layer with lights cut into it is night.
   * - `"add"`: light. Its colours are added to what is under it, so it only brightens.
   * - `"screen"`: a softer light that never passes white.
   */
  blend?: BlendMode;
  /** How each child is drawn onto the layer itself: `"add"` makes overlapping lights add up. Default `"normal"`. */
  childBlend?: BlendMode;
  /** The colour the layer starts from each frame, before its children are drawn: `"black"` for a light map. Default transparent. */
  clear?: string;
  /** How strongly the layer is laid over what is under it, 0 (not at all) to 1 (fully, the default). */
  opacity?: number;
  /**
   * A shader each of the layer's pixels goes through as it is laid over (ABI v11): a file under `assets/` holding one GLSL function,
   * `vec4 effect(vec2 uv)`, given `image` (the layer: `texture(image, uv)`), `pixel` (from the top left), `resolution`, `time` (the
   * game's seconds), `params` and `lookup`. Since ABI v17 also `place`: where the pixel is in the coordinates the layer's children
   * are placed in (under a `<Screen>`, the game's own pixels, wherever the screen sits in the window), and `uvOf(place)`, the `uv`
   * at which `image` holds what is at a place (the layer's image is held bottom row first, so `uv.y` grows upwards: `uvOf` is how
   * to sample somewhere else without minding that). The software renderer runs none, and lays the layer over as it is.
   */
  shader?: string;
  /** Up to 32 numbers the shader reads as `params[0]` to `params[31]` (the rest are 0); a list among them is laid out in place. See `ShaderParams`. */
  params?: ShaderParams;
  /** An image under `assets/` the shader reads as `lookup` (a palette, a colour table); without one, `lookup` is a white pixel. */
  lookup?: string;
}

/**
 * A container whose children are drawn off screen, into a layer the size of the screen, which is then laid over what is under it
 * with a blend mode: the way to darken a cave and light it again (`<Layer blend="multiply" clear="#202038" childBlend="add">`, its
 * children the lights), or to add a glow. Layers nest, four deep. Inside a layer, children are drawn in `z` order among themselves, as
 * anywhere else, and the layer as a whole is drawn at its own `z` among what is around it.
 */
export class Layer<P extends object = {}> extends Entity<P> {
  static override readonly intrinsic = true;

  blend: BlendMode;
  childBlend: BlendMode;
  clear: string;
  opacity: number;
  shader: string;
  params: ShaderParams;
  lookup: string;

  constructor(hostProps: LayerProps = {}, props?: P, defaults?: Partial<P>) {
    super(hostProps, props, defaults);
    this.blend = hostProps.blend ?? "normal";
    this.childBlend = hostProps.childBlend ?? "normal";
    this.clear = hostProps.clear ?? "transparent";
    this.opacity = hostProps.opacity ?? 1;
    this.shader = hostProps.shader ?? "";
    this.params = hostProps.params ?? [];
    this.lookup = hostProps.lookup ?? "";
  }
}
