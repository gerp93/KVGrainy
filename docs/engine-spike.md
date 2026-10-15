# Engine spike: can the shared Rust core run in a browser?

PLAN.md Phase 1, tasks 1.2 and 1.3 (partly). Date: 2026-10-15.

**Question:** can `kvgrainy-core` (search, SSIMULACRA2 scoring, resize, colour) be
compiled to WebAssembly and used by the web tool, so desktop and web share one search?

**Short answer so far:** yes on build, correctness and raw speed. **Memory is the
blocker**: SSIMULACRA2 scoring needs roughly 170-190 MB of WASM memory per megapixel,
so full-resolution scoring cannot work on large photos or on phones. The fix (score a
size-capped copy) is also what the native engine needs for speed, but it is not
validated yet (Phase 1.4).

## What was done

- Put the C-backed codecs (`mozjpeg`, `webp`, `ravif`, `avif-decode`) behind a `native`
  Cargo feature and `rayon` behind `parallel`. Both are on by default, so native builds
  and the CLI are unchanged (all 13 fidelity tests and the unit tests pass).
- `cargo check -p kvgrainy-core --no-default-features --target wasm32-unknown-unknown`
  builds in about 13 s. Before the change it failed in `libaom-sys` (cmake: "System is
  unknown", `-std=c99` unsupported). A CI job (`wasm-core`) now keeps this building.
- Added `crates/kvgrainy-wasm-spike`: a throwaway harness exposing load, reference
  prep, encode, score and a full single-format search to JS via `wasm-bindgen`. It uses
  the `image` crate's own pure-Rust encoders as stand-in codecs, so the same code runs
  natively and as WASM. `examples/native_timing.rs` and `run.mjs` / `mem.mjs` are the
  two sides of the comparison.

## Measurements

Machine: Windows 11, 24 logical cores. Native is a release build; WASM is a release
build run in Node 24 (V8, the engine Chrome uses). JPEG only, stand-in encoder.
Single runs, not averaged.

| Step | Image | Native | WASM (Node) | WASM / native |
|---|---|---|---|---|
| Score one candidate | 0.5 MP | 129 ms | 294 ms | 2.3x |
| Score one candidate | 1.0 MP | 225 ms (236 ms pinned to 1 thread) | 515 ms | 2.3x |
| Score one candidate | 12 MP | 2.46 s | 6.45 s | 2.6x |
| Full search | 0.43 MP (CMYK) | 0.67 s | 1.09 s | 1.6x |
| Full search | 0.54 MP | 1.43 s | 2.43 s | 1.7x |
| Full search | 1.0 MP | 2.44 s | 4.32 s | 1.8x |
| Full search | 12 MP | 10.6 s | 19.8 s | 1.9x |
| Decode (incl. ICC) | 12 MP | 43 ms | 103 ms | 2.4x |

WASM memory (linear memory high-water mark, MB):

| Image | after load | after reference | after one score | after search |
|---|---|---|---|---|
| 0.5 MP | 5 | 12 | 93 | 103 |
| 1.0 MP | 8 | 19 | 164 | 182 |
| 12 MP | 76 | 214 | 2011 | 2286 |

Other facts:

- **Results are identical.** Native and WASM chose the same candidate (format, quality,
  scale, score, byte count) on every image tested. Scores match to four decimals.
- **`ssimulacra2` uses `rayon` internally, and it still runs without threads.** It does
  not panic on `wasm32-unknown-unknown`. Native scoring is not faster with threads
  either (225 ms vs 236 ms single-threaded on this machine), so the WASM penalty is
  about 2x, not a threading gap.
- **Binary size:** 2.6 MB raw, 0.87 MB gzipped, with no real codecs and no `wasm-opt`.
- The 12 MP search finished at the first scale, so it is a best case. A search that has
  to walk down the scale ladder scores several candidates; at 6.5 s each in WASM that
  would run to a minute or more (extrapolation, not measured).

## What this means

1. **Building for the browser works.** The pure-Rust core needs no changes beyond the
   feature gating. The `Encoder` trait is the right seam.
2. **Speed is acceptable per step, not per search.** About 2x native. The expensive part
   is scoring, as on native.
3. **Memory rules out full-resolution scoring.** A 12 MP photo needs about 2.3 GB, a
   48 MP phone photo would exceed the 4 GB WASM32 limit, and phone browsers kill tabs
   far earlier than that. Scoring must run on a copy capped at about 1 MP (about
   180 MB, about 0.5 s per score in WASM). That would also speed up native.
4. **Open question:** does scoring a downscaled copy rank candidates the same as scoring
   full-size? That is Phase 1.4 and decides whether the shared-core route is sound.

## Not done (limits of this spike)

- No real browser: Node/V8 is a proxy. Safari (JavaScriptCore) and phones are untested.
- No real photos: the machine had none in a corpus; the 12 MP image is a synthetic
  upscale of a synthetic image plus noise. Real photos need a folder to run against.
- No production codecs in WASM (Phase 1.5): AVIF and lossy WebP encode were not timed,
  and rav1e/libwebp in WASM are expected to be the slow part of a full search.
- No Web Worker pool, and no `wasm-opt`.
- No proxy metric yet (Phase 1.4). The existing `web/src/engine/metric.ts` is a candidate
  to compare against SSIMULACRA2.

## Reproduce

```bash
# one-time: nasm 2.16 (3.x breaks libaom), perl, cmake, wasm-bindgen-cli matching the lockfile
cargo install wasm-bindgen-cli --version 0.2.129 --locked
python scripts/benchmark.py --make-corpus            # synthetic images

cargo build -p kvgrainy-wasm-spike --example native_timing --release
./target/release/examples/native_timing.exe benchmark/corpus/photo_like.jpg 100000 jpeg

cargo build -p kvgrainy-wasm-spike --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/kvgrainy_wasm_spike.wasm \
  --target nodejs --out-dir target/wasm-spike-pkg
node crates/kvgrainy-wasm-spike/run.mjs benchmark/corpus/photo_like.jpg 100000 jpeg
node crates/kvgrainy-wasm-spike/mem.mjs benchmark/corpus/photo_like.jpg 100000
```

Windows native builds of the full workspace also need NASM 2.16.x and Perl on `PATH`
(Git for Windows ships `perl.exe` under `usr\bin`).
