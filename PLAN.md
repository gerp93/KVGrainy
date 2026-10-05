# KVGrainy public-release plan

**Goal:** the best tool for one job: take an image, GIF, or clip and get it
under a size limit with the best quality possible. Everything else is
secondary. Free, local-first, nothing leaves your PC.

**Core competency:** output quality at a target size, and how fast we find it.
Stack and priorities follow from that, not from the UI.

**Non-goals:** a general-purpose image editor, cloud features, accounts.

## Target stack

| Layer | Choice | Why |
|-------|--------|-----|
| Engine | **Rust library** (`kvgrainy-core`) | Calls the best native encoders directly, real multithreading for the search, single small binary, reusable from CLI/GUI/WASM |
| Encoders | mozjpeg (or jpegli), libwebp, AVIF (`ravif`/rav1e), oxipng + libimagequant (pngquant), gifski, ffmpeg for video | Beat Pillow defaults on size at equal quality |
| Metric | SSIMULACRA2 (butteraugli as fallback) | Pick what *looks* best, not what has lowest pixel error |
| CLI | Rust binary over the core crate | Scriptable, same engine as the app |
| UI | **Tauri 2** (web front end, TypeScript) | Modern look, small installers, system webview |
| Python code | Becomes the **reference engine** | Behavior baseline and benchmark comparison until the Rust engine reaches parity, then retired |

Phases are ordered by dependency and risk. Each ships (merges to `main`) on its
own; don't batch them.

---

## Phase 0 — Correctness of the reference engine and a baseline

Done or in progress in the Python code; this is the yardstick for everything
after.

| # | Task | Done when |
|---|------|-----------|
| 0.1 | EXIF orientation, sRGB conversion, fidelity tests (PR #23) | Merged |
| 0.2 | Benchmark corpus: photo, screenshot, transparent PNG, CMYK, rotated phone photo, animated GIF, short video; committed or fetchable by script | `scripts/benchmark.py --list` shows the corpus |
| 0.3 | `scripts/benchmark.py`: for each file × size limit, run the Python engine and CLI equivalents of the competition (cjpeg/mozjpeg, cwebp, avifenc, oxipng, pngquant, gifski, ffmpeg), score each output with SSIMULACRA2 | Produces a table of size and quality per tool |
| 0.4 | Read the table: where do we lose, by how much | Written summary in `docs/benchmark-baseline.md` (first pass on a synthetic corpus is in; rerun on real images) |

**Gate:** if the baseline shows we can't plausibly beat the best encoders with a
better search and encoders, rethink the pitch before building more.

## Phase 1 — Rust engine core (`kvgrainy-core`)

| # | Task | Done when |
|---|------|-----------|
| 1.1 | Cargo workspace; `kvgrainy-core` + `kvgrainy-cli` crates; CI builds on Linux/Windows/macOS | `cargo test` green in CI on all three (green on all three, PR #23) |
| 1.2 | Load: EXIF orientation, ICC to sRGB (CMYK included), strip metadata (GPS especially) by default | Port of the Phase 0.1 fidelity tests passes (orientation, metadata, bad-ICC fallback done; real wide-gamut and CMYK color checks still to add) |
| 1.3 | Encoders: JPEG (mozjpeg), WebP, PNG (oxipng + quantization), AVIF | Each encodes at a requested quality (JPEG, WebP, AVIF, plain PNG done; oxipng and quantization to do). Build needs `nasm` and `cmake` |
| 1.4 | Search: size-limit binary search over quality and scale, parallelized, with a cooperative cancel and a progress callback | Beats the Python engine on the corpus at equal limits (search, cancel, progress done; 3-30x faster, but quality not yet at parity) |
| 1.5 | Large-input effort cap (coarser scale ladder, early exit when utilization is high) | 20 MP photo finishes in a few seconds |
| 1.6 | Clear failure result when nothing fits (best-effort smallest plus message) | No silent no-output cases (error reports the smallest size tried; best-effort file not written yet) |
| 1.7 | CLI parity with `kvgrainy.py` flags | Existing README examples work |

## Phase 2 — Perceptual search, animation, video, presets

| # | Task | Done when |
|---|------|-----------|
| 2.1 | Replace RMS with SSIMULACRA2 in the search; re-tune the score weighting on the corpus | Chosen candidates look better than Phase 1 on the corpus (Rust engine now scores with SSIMULACRA2 only; the old size-utilization weight is dropped, re-tune still to do on a real corpus) |
| 2.2 | Animated output: GIF (gifski), animated WebP, later AVIF; frame-drop, color and scale ladders | Animated GIF in, smaller better GIF out |
| 2.3 | Video input: ffmpeg decode (rotation honored, streamed/downscaled, clip length cap); MP4/WebM output to a target size via bitrate search | 2-min 1080p clip stays within a sane memory budget; video in, video under N MB out |
| 2.4 | Target presets (Discord, email, GitHub, Slack, custom) and a smart default output type per preset | One flag or click sets the limit; happy path needs no format choice |
| 2.5 | Benchmark rerun against Phase 0 | Table shows we win or tie on size at equal quality; published in `docs/` |

**Gate:** if 2.5 shows we lose badly, fix that before the UI.

## Phase 3 — Tauri UI

Rust commands wrap `kvgrainy-core`; progress and cancel flow over events. Keep
all logic in the core crate so the UI stays thin.

- Drag and drop and paste from clipboard
- Preset picker, then done: drop file, pick target, get result
- Before/after slider and live size estimate (downscaled previews, not full-size decode in the webview)
- Real progress and cancel
- Manual fine-tune for GIFs (port of the current Fine-Tune tab)
- Copy result to clipboard; reveal in folder
- Theming: apply VisualAssault tokens if they can be consumed as CSS/JSON; otherwise document the exception in KVG_Standards
- Test on all three OS webviews (WebView2, WKWebView, WebKitGTK)

## Phase 4 — Trust and distribution

| # | Task | Done when |
|---|------|-----------|
| 4.1 | Release workflow for Tauri builds on all three OSes; code-sign Windows and notarize macOS | No SmartScreen/Gatekeeper warning |
| 4.2 | Self-update via Tauri updater (replaces `updater.py`); record the change in KVG_Standards | Update from N-1 to N works on all OSes |
| 4.3 | Bundled ffmpeg and encoders pass a smoke test in release artifacts | Smoke test in CI |
| 4.4 | Publish to winget, Scoop, Homebrew | `winget install` works |
| 4.5 | Windows right-click "Reduce with KVGrainy" entry | Works from Explorer |
| 4.6 | Landing page: before/after demo, privacy pitch, benchmark table, download button | Page live |
| 4.7 | Retire the Python app; update README, CLAUDE.md, TODO.md | Docs match behavior |

## Phase 5 — Launch

- Post where the pain is: Discord/streamer communities, r/DataHoarder, docs/README-GIF authors, Show HN.
- Lead with the benchmark table and a 10-second demo, not a feature list.
- Collect feedback in GitHub issues; feed `TODO.md`.
- Revisit goal (free OSS vs paid pro tier) only after there's real usage.

---

## Risks

- **Benchmark loss:** the quality gap vs the best encoders and Squoosh/TinyPNG is the biggest unknown; mitigated by doing Phase 0 and the Phase 2 gate before the UI.
- **Rewrite cost:** the engine and tests are rewritten. Mitigate by keeping the Python engine as the behavior reference and porting its tests.
- **Two languages:** Rust (engine) plus TypeScript (UI). Keep the boundary small: a handful of commands and events.
- **Webview differences:** WebKitGTK on Linux is the weakest. Test early and keep the UI simple.
- **Binary bloat/AV false positives:** bundled ffmpeg plus encoders; mitigate with signing.
- **Standards drift:** Tauri, Rust CI and updater differ from the Python/Tkinter standards in KVG_Standards; resolve before Phase 3.
