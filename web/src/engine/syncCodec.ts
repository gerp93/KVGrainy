import { defaultOptions as avifDefaults } from '@jsquash/avif/meta.js';
import { defaultOptions as jpegDefaults } from '@jsquash/jpeg/meta.js';
import { defaultOptions as webpDefaults } from '@jsquash/webp/meta.js';
import type { Format } from './types';

/**
 * The codecs the shared Rust core calls while it searches.
 *
 * The core (crates/kvgrainy-core, compiled to WebAssembly by crates/kvgrainy-wasm) runs the
 * whole search loop, so it needs `encode` to return bytes **synchronously**. jSquash's public
 * API is async only because it awaits module start-up; once an Emscripten module is up, its
 * `encode` is a plain synchronous call. So each format initialises its modules once, with
 * `await`, and then hands the core a codec whose methods never yield.
 */
export interface SyncCodec {
  /** `rgba` is a view into the core's memory, valid only during the call: it is copied, never kept. */
  encode(format: string, width: number, height: number, rgba: Uint8Array, quality: number): Uint8Array;
  /** The core decodes JPEG, WebP and PNG itself; AVIF goes through here. */
  decodeAvif(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } | null;
  supports(format: string): boolean;
}

/**
 * Pre-compiled WebAssembly modules, for hosts that cannot fetch them by URL (Node in tests).
 * In a browser leave this empty and each codec fetches its own `.wasm`.
 */
export interface WasmModules {
  jpeg?: WebAssembly.Module;
  webp?: WebAssembly.Module;
  avif?: WebAssembly.Module;
  avifDecode?: WebAssembly.Module;
  png?: WebAssembly.Module;
  oxipng?: WebAssembly.Module;
}

/** Speed 8 trades a little size for search throughput, as in the native engine. */
const AVIF_SPEED = 8;

type EmscriptenFactory = (options?: object) => Promise<unknown>;
interface Encoding {
  encode(data: Uint8Array, width: number, height: number, options: object): Uint8Array | null;
}

/** Start an Emscripten codec the way jSquash does, optionally from a pre-compiled module. */
async function startEmscripten<T>(factory: EmscriptenFactory, wasmModule?: WebAssembly.Module): Promise<T> {
  const instantiateWasm = wasmModule
    ? (imports: WebAssembly.Imports, callback: (instance: WebAssembly.Instance) => void) => {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        callback(instance);
        return instance.exports;
      }
    : undefined;
  return (await factory({ noInitialRun: true, instantiateWasm })) as T;
}

function copy(bytes: Uint8Array | null | undefined, what: string): Uint8Array {
  if (!bytes) throw new Error(`${what} encoding failed`);
  return new Uint8Array(bytes);
}

/** A codec for one format. Only that format's modules are downloaded and started. */
export async function createSyncCodec(format: Format, modules: WasmModules = {}): Promise<SyncCodec> {
  let encodeOne: (width: number, height: number, rgba: Uint8Array, quality: number) => Uint8Array;
  let decodeAvif: SyncCodec['decodeAvif'] = () => null;

  switch (format) {
    case 'jpeg': {
      const { default: factory } = await import('@jsquash/jpeg/codec/enc/mozjpeg_enc.js');
      const codec = await startEmscripten<Encoding>(factory as unknown as EmscriptenFactory, modules.jpeg);
      encodeOne = (w, h, rgba, quality) => copy(codec.encode(rgba, w, h, { ...jpegDefaults, quality }), 'JPEG');
      break;
    }
    case 'webp': {
      // Prefer the SIMD build when the browser has it, as jSquash does.
      const { simd } = await import('wasm-feature-detect');
      const { default: factory } = (await simd())
        ? await import('@jsquash/webp/codec/enc/webp_enc_simd.js')
        : await import('@jsquash/webp/codec/enc/webp_enc.js');
      const codec = await startEmscripten<Encoding>(factory as unknown as EmscriptenFactory, modules.webp);
      encodeOne = (w, h, rgba, quality) => copy(codec.encode(rgba, w, h, { ...webpDefaults, quality }), 'WebP');
      break;
    }
    case 'avif': {
      // Always the single-threaded build: the multi-threaded one needs cross-origin isolation.
      const [{ default: encoder }, { default: decoder }] = await Promise.all([
        import('@jsquash/avif/codec/enc/avif_enc.js'),
        import('@jsquash/avif/codec/dec/avif_dec.js'),
      ]);
      const codec = await startEmscripten<Encoding>(encoder as unknown as EmscriptenFactory, modules.avif);
      const decoding = await startEmscripten<{ decode(data: Uint8Array, bitDepth: number): { width: number; height: number; data: Uint8ClampedArray } | null }>(
        decoder as unknown as EmscriptenFactory,
        modules.avifDecode,
      );
      encodeOne = (w, h, rgba, quality) => copy(codec.encode(rgba, w, h, { ...avifDefaults, quality, speed: AVIF_SPEED }), 'AVIF');
      decodeAvif = (bytes) => {
        const image = decoding.decode(bytes, 8);
        return image ? { width: image.width, height: image.height, data: new Uint8Array(image.data) } : null;
      };
      break;
    }
    case 'png': {
      const [png, oxipng] = await Promise.all([
        import('@jsquash/png/codec/pkg/squoosh_png.js'),
        import('@jsquash/oxipng/codec/pkg/squoosh_oxipng.js'),
      ]);
      // Single-threaded oxipng: the threaded build needs cross-origin isolation.
      if (modules.png) png.initSync(modules.png);
      else await png.default();
      if (modules.oxipng) oxipng.initSync(modules.oxipng);
      else await oxipng.default();
      encodeOne = (w, h, rgba) => copy(oxipng.optimise(png.encode(rgba, w, h, 8), 2, false, false), 'PNG');
      break;
    }
  }

  return {
    encode: (requested, width, height, rgba, quality) => {
      if (requested !== format) throw new Error(`this codec only encodes ${format}, not ${requested}`);
      return encodeOne(width, height, rgba, quality);
    },
    decodeAvif,
    supports: (requested) => requested === format,
  };
}
