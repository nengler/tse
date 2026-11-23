import { GameObject } from "../GameObject.ts";

/** What can change how a sprite is drawn, beyond which image it is. All optional; a sprite that sets none is drawn plainly, as it always was. */
export interface SpriteOptions {
  /** Mirror left to right, about the origin. */
  flipX?: boolean;
  /** Mirror top to bottom, about the origin. */
  flipY?: boolean;
  /** The point of the image, in its pixels (of one frame, for a sheet), that sits at the object's position and that flipping and rotating turn about. Default 0, the top left. */
  originX?: number;
  originY?: number;
  /** A CSS colour that multiplies the image's colours: white (the default) changes nothing, `"red"` keeps only the red. Its alpha is opacity too. */
  tint?: string;
  /** 0 (invisible) to 1 (the default); multiplies the tint's alpha. */
  opacity?: number;
  /**
   * 0 (the default) to 1: how far the image's colours are mixed toward `flashColor`, where it is drawn (its transparent pixels
   * stay so). A tint only darkens, so this is how a sprite flashes white when hit: `flash={hit ? 0.8 : 0}`.
   */
  flash?: number;
  /** The colour `flash` mixes toward, a CSS colour. Default white. */
  flashColor?: string;
  /**
   * A shader each of the sprite's pixels goes through as it is drawn (ABI v16): a file under `assets/` holding one GLSL function,
   * `vec4 effect(vec2 uv)`, as a `<Layer>`'s shader is, given the sprite's image as `image`, the part of it drawn as `region` (x, y,
   * width, height in its pixels), how it is turned on the screen as `turn` (a mat2 from a direction in the image to one on the
   * screen; `transpose(turn)` takes a screen direction into the image, which is how a light that stays put on the screen is found
   * on a sprite that rolls), `lookup` and `params`. `time` is 0 here: pass the time in `params` for a shader that moves with it.
   * The software renderer runs none, and draws the sprite as it is.
   */
  shader?: string;
  /** Up to eight numbers the shader reads as `params[0]` to `params[7]`; the rest are 0. */
  params?: readonly number[];
  /** An image under `assets/` the shader reads as `lookup` (a colour table, say); without one, `lookup` is a white pixel. */
  lookup?: string;
}

export interface SpriteProps extends SpriteOptions {
  image: string;
  /** Draw one frame of a sheet: the size of a frame, in pixels. The sheet is read left to right, then down. */
  frameWidth?: number;
  frameHeight?: number;
  /** Which frame of the sheet, counting from 0 (a sheet needs `frameWidth` and `frameHeight`). Default 0. */
  frame?: number;
}

/** The fields every sprite-like object (a `Sprite`, an `AnimatedSprite` playing a sheet) has to say how it is drawn. */
export interface SpriteLook {
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly originX: number;
  readonly originY: number;
  readonly tint: string | undefined;
  readonly opacity: number;
  readonly flash: number;
  readonly flashColor: string;
  readonly shader: string;
  readonly params: readonly number[];
  readonly lookup: string;
}

/** Whether a sprite's look is anything but the plain, whole-image, top-left one. */
export function isStyled(look: SpriteLook): boolean {
  return (
    look.flipX ||
    look.flipY ||
    look.originX !== 0 ||
    look.originY !== 0 ||
    look.tint !== undefined ||
    look.opacity !== 1 ||
    look.flash > 0 ||
    look.shader !== ""
  );
}

export class Sprite<P extends object = {}> extends GameObject<P> implements SpriteLook {
  static override readonly intrinsic = true;

  image: string;
  frameWidth: number | undefined;
  frameHeight: number | undefined;
  frame: number;
  flipX: boolean;
  flipY: boolean;
  originX: number;
  originY: number;
  tint: string | undefined;
  opacity: number;
  flash: number;
  flashColor: string;
  shader: string;
  params: readonly number[];
  lookup: string;

  /** `props` and `defaults` are the component's own (see `GameObject`); `hostProps` are this element's. */
  constructor(hostProps: SpriteProps, props?: P, defaults?: Partial<P>) {
    super(props, defaults);
    this.image = hostProps.image;
    this.frameWidth = hostProps.frameWidth;
    this.frameHeight = hostProps.frameHeight;
    this.frame = hostProps.frame ?? 0;
    this.flipX = hostProps.flipX ?? false;
    this.flipY = hostProps.flipY ?? false;
    this.originX = hostProps.originX ?? 0;
    this.originY = hostProps.originY ?? 0;
    this.tint = hostProps.tint;
    this.opacity = hostProps.opacity ?? 1;
    this.flash = hostProps.flash ?? 0;
    this.flashColor = hostProps.flashColor ?? "white";
    this.shader = hostProps.shader ?? "";
    this.params = hostProps.params ?? [];
    this.lookup = hostProps.lookup ?? "";
  }
}
