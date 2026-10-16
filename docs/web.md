# The web tool

A static site (Astro + TypeScript, `web/`) that fits an image, GIF or short clip under a size limit
in the browser. Nothing is uploaded: there is no server for it to go to.

## One search, two front ends

The search for stills is the same Rust code the desktop CLI runs, `crates/kvgrainy-core`, compiled
to WebAssembly by `crates/kvgrainy-wasm`. The core does the scale walk, the quality search,
SSIMULACRA2 scoring on a 1 MP copy, resizing and colour handling. The one thing a browser build
cannot bring is the native C codecs, so JavaScript supplies them:

```
main thread                       one Web Worker per format (jpeg / webp / avif / png)
  loads the image with the          wasm: searchFormat(source, codec, format, limit, effort)
  browser (EXIF + sRGB), starts       -> Rust loops over scales and qualities, calling
  the workers, shows progress           codec.encode(...) and codec.decodeAvif(...) synchronously
  picks the winner (chooseBest)       -> codec = jSquash mozjpeg / libwebp / libavif / oxipng
```

- **Synchronous codecs.** The Rust loop cannot `await`. jSquash is async only because it awaits
  module start-up, so `web/src/engine/syncCodec.ts` starts each format's modules once and then
  hands the core a codec whose methods never yield. This depends on jSquash internals (deep
  imports of its Emscripten glue); the version is pinned in `package-lock.json`, and
  `web/tests/core.test.ts` runs the real codecs through the real core in Node, so an upgrade that
  breaks the bridge fails CI.
- **Parallelism without threads.** One worker per format, each with its own WASM instance and its
  own copy of the pixels. Threaded WASM would need cross-origin isolation (COOP/COEP), which breaks
  third-party ad iframes, and ads are the web revenue plan.
- **Cancel** terminates the workers: the core never yields to the event loop, so it can't be asked.
- **No palette PNG in the browser.** The core's `Encoder::supports` lets the codec say which formats
  it has; the web build has no quantizer, so PNG there is lossless only (oxipng-recompressed).
- **Small TypeScript helpers mirror the core** (`formatsFor`, `chooseBest`) so the main thread can
  pick workers and a winner without loading WASM. `web/tests/core.test.ts` checks them against the
  core (`candidateFormats`, `pickBest`) so they cannot drift.
- GIFs and clips still use the TypeScript GIF and animated-WebP search (`gif.ts`, `webpanim.ts`);
  the Rust core handles stills only.

## Building

```bash
# once: the wasm32 target and a wasm-bindgen CLI matching Cargo.lock
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked

cd web
npm ci
npm run dev        # builds the Rust core first (src/wasm/, generated, not committed)
npm test           # unit tests, including the real core + real codecs in Node
npm run build && npm run budgets
npm run test:e2e   # Playwright in Chromium; builds and serves the site itself
```

The browser build uses the `wasm` Cargo profile (LTO, one codegen unit, abort on panic) and leaves
out the GIF, BMP and TIFF decoders (`extra-formats` feature) because the browser decodes inputs
itself. The Rust core is about 636 KB gzipped.

## Privacy is tested, not just promised

`web/e2e/privacy.spec.ts` runs the app under the production Content-Security-Policy from
`web/public/_headers` and asserts that no request carries a body, none is anything but GET/HEAD,
none goes to another host, and the browser itself refuses a request to a foreign origin. It must
stay green: if a change makes it fail, the change is wrong, not the test.

## Budgets

`web/budgets.json` caps the gzipped size of every built asset and of the initial page load;
`npm run budgets` fails the build when one is exceeded. Codecs load on demand per format, so only
the formats a search uses are downloaded.

## Memory

Measured in desktop Chromium on a 4-core machine: whole-browser resident memory (the idle page alone is about 715 MB of it), Quick
effort, a 500 KB limit, the same output every time.

| | 12 MP photo | 24 MP photo |
|---|---|---|
| Before any of this | 2417 MB, 63 s | 3649 MB, 54 s |
| Strip probe (all devices) | 1969 MB, 51 s | 2415 MB, 42 s |
| Strip probe + one worker at a time (phone, low memory) | 1276 MB, 105 s | 1443 MB, 83 s |

Two separate changes, both leaving the chosen result untouched:

- **Strip probe** (`strip_encoded_len` in `crates/kvgrainy-core/src/search.rs`). For a source over 3 MP, the search used to encode the
  whole image at full size and floor quality just to learn that it could not fit, the most memory-hungry thing it did. It now adds up
  the encoded sizes of about 2 MP horizontal strips instead, and encodes the whole image only when that total says full size might
  fit. Measured with the real encoders at 6 to 24 MP: the strip total is within 1.1% of the whole for JPEG, WebP and lossless PNG,
  and 8.5% above it for AVIF (the check allows for that). Palette PNG, which is native-only, keeps encoding whole: per-strip palettes
  made its total 9.5% low and its quantizer twice as slow. Images up to 3 MP take exactly the old path. A/B against the previous
  binary over 20 image and limit combinations at Quick effort (a real photo, an upscaled real photo, a 4K screenshot, RGBA, a 45 MP
  image, 100 KB to 8 MB limits): every output file was byte-identical, with equal or slightly better times. One Best-effort run
  (AVIF included; 12 MP, 500 KB) was byte-identical too, 407 s against 386 s (about 5% slower) on this 4-core machine.
- **One worker at a time** (`web/src/engine/parallelism.ts`). Each format worker holds about 550 MB at 12 MP whatever the format
  (scoring alone is about 240 MB), and they run in parallel, so the sum is the peak. For an image over 4 MP on a phone or a device
  reporting 4 GB or less, the workers now run one after another (a desktop runs two at a time above 16 MP). Same result, about twice the time.

**Not verified:** a real phone. The 1.3 to 1.4 GB figures are desktop Chromium posing as an iPhone, and the whole-browser number
overstates one tab's memory, but nothing here shows what mobile Safari or an Android browser will allow a tab. Safari and Firefox are untested. See TODO.md.

## Not verified yet

- Only Chromium. Safari (JavaScriptCore, stricter memory limits) and phones are untested.
- The memory ceiling on large photos: each worker holds the source pixels, so four formats on a
  48 MP image is several hundred MB per worker. The page refuses inputs above 24 MP; a 45 MP flat PNG passed 4.7 GB and had not finished after 4 minutes, which is why the cap was
  lowered from 50 MP. See "Memory" below for what is measured and what is not.
- Speed against Squoosh and TinyPNG on real images (PLAN.md Phase 3 acceptance).
