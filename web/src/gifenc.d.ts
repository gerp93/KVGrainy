// gifenc ships no types. Only the parts we use.
declare module 'gifenc' {
  export type Palette = number[][];
  export interface WriteFrameOptions {
    palette?: Palette;
    /** Milliseconds; GIF stores centiseconds. */
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    /** 1 = leave in place (needed for frame diffing). */
    dispose?: number;
    /** 0 = loop forever, -1 = once. */
    repeat?: number;
  }
  export interface GIFEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' },
  ): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: 'rgb565' | 'rgb444' | 'rgba4444'): Uint8Array;
}
