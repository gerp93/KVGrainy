/** An 8-bit sRGB image, tightly packed RGBA. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Format = 'jpeg' | 'webp' | 'avif' | 'png';
/** What an output can be: a still format, or GIF for animated input. */
export type OutputFormat = Format | 'gif';

export const FORMAT_INFO: Record<OutputFormat, { mime: string; extension: string; label: string; hasQuality: boolean }> = {
  jpeg: { mime: 'image/jpeg', extension: 'jpg', label: 'JPEG', hasQuality: true },
  webp: { mime: 'image/webp', extension: 'webp', label: 'WebP', hasQuality: true },
  avif: { mime: 'image/avif', extension: 'avif', label: 'AVIF', hasQuality: true },
  png: { mime: 'image/png', extension: 'png', label: 'PNG', hasQuality: false },
  gif: { mime: 'image/gif', extension: 'gif', label: 'GIF', hasQuality: false },
};

export interface Candidate {
  bytes: Uint8Array;
  format: OutputFormat;
  /** Absent for formats without a quality knob (PNG, GIF). */
  quality?: number;
  /** GIF only: palette size. */
  colors?: number;
  /** GIF only: 1 keeps every frame, 2 every second frame, and so on. */
  frameStep?: number;
  scale: number;
  /** Similarity to the original, 0..1 (a cheap proxy, not SSIMULACRA2). */
  score: number;
}

/** What one format's search produced. */
export interface FormatResult {
  best?: Candidate;
  /** Size of the smallest output tried, in bytes. */
  smallest: number;
  /** The smallest output tried, kept so it can be offered when nothing fits. */
  smallestBytes?: Uint8Array;
  smallestFormat?: Format;
}

export type OptimizeResult =
  | { ok: true; candidate: Candidate }
  | { ok: false; limit: number; smallest: number; bestEffort?: { bytes: Uint8Array; format: OutputFormat } };

/**
 * The codec layer the search runs on. Search, scoring and selection are
 * codec-agnostic; everything that touches an image codec goes through this
 * (same seam as the Rust `Encoder` trait in kvgrainy-core).
 */
export interface Codec {
  encode(format: Format, raster: Raster, quality: number): Promise<Uint8Array>;
  /** Resample to `factor` of the current size (never below 1x1). */
  scale(raster: Raster, factor: number): Promise<Raster>;
  /** Decode an output this codec produced, drawn at `width` x `height`. `null` if undecodable. */
  decode(format: Format, bytes: Uint8Array, width: number, height: number): Promise<Raster | null>;
}

export interface SearchHooks {
  cancelled(): boolean;
  /** Called with the number of scale steps just completed. */
  report(steps: number): void;
}
