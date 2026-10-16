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

## Not verified yet

- Only Chromium. Safari (JavaScriptCore, stricter memory limits) and phones are untested.
- The memory ceiling on large photos: each worker holds the source pixels, so four formats on a
  48 MP image is several hundred MB per worker. The page refuses inputs above 24 MP. Measured in desktop Chromium on a 4-core machine (whole-browser memory, Quick effort, 500 KB
  limit): a 12 MP photo peaks near 2.4 GB (about 63 s), a 24 MP photo near 3.6 GB (about 54 s), and a 45 MP flat PNG passed 4.7 GB
  and had not finished after 4 minutes, which is why the cap was lowered from 50 MP. **The cap is not a phone-safe limit:** even a
  typical 12 MP photo is heavy. A phone has not been tried; see TODO.md.
- Speed against Squoosh and TinyPNG on real images (PLAN.md Phase 3 acceptance).
