# KVGrainy public-release plan

**Goal:** the best tool for one job: take an image, GIF, or clip and get it
under a size limit with the best quality possible. Everything else is
secondary. Free, local-first, nothing leaves your device.

**Core competency:** output quality at a target size, and how fast we find it.
Stack and priorities follow from that, not from the UI.

**Two ways to use it, one codebase:**

- **Desktop app** (downloadable): images, animated GIF, video, batch, right-click.
- **Web tool** (static site, runs in the browser, display-ad supported later):
  still images only. Nothing is uploaded; the privacy claim is enforced by a test.

**Non-goals:** a general-purpose image editor, cloud features, accounts, uploads
to any server.

## Target stack

```
ui/       shared TypeScript UI (drop zone, presets, before/after, results)
core/     Rust: search, scoring, colour, resize. No C code. Builds native AND wasm32
desktop/  Tauri 2 shell. Native codecs, ffmpeg, rayon threads
web/      Static site. Core compiled to WASM + browser WASM codecs, Web Worker pool
```

| Layer | Desktop | Web |
|-------|---------|-----|
| UI | TypeScript (shared) | TypeScript (same code) |
| Shell | Tauri 2 | none; plain static site |
| Engine | Rust `kvgrainy-core`, native | same core compiled to WASM, in Web Workers |
| Encoders | mozjpeg (or jpegli), libwebp, AVIF (`ravif`/rav1e), oxipng + libimagequant, gifski, ffmpeg | browser-ready WASM codecs (jSquash family, to be verified) |
| Metric | SSIMULACRA2 | cheap proxy for the search; SSIMULACRA2 to verify the final pick |
| CLI | Rust binary over the core crate | n/a |
| Python code | Reference engine until Rust reaches parity, then retired | n/a |

**The key design rule:** search, scoring, colour management and resize live in
`core/` as pure Rust behind an `Encoder` trait. Only the codec layer differs per
target (native C encoders on desktop, JS-provided WASM codecs on web). The
search is the part that makes KVGrainy better than other tools, so it exists
once.

**Fallback:** if the Phase 1 spike shows the shared core cannot build for
`wasm32` or is far too slow in a browser, the web build uses a TypeScript
search loop calling existing browser codecs. The UI and the engine interface
stay the same; the cost is a second copy of the search logic.

**No threaded WASM.** Cross-origin isolation (COOP/COEP) can break third-party
ad iframes, and ads are the web revenue plan. The web build parallelises with a
pool of single-threaded workers, each with its own WASM instance.

**Repo layout:** a monorepo, so the shared UI and core are one source of truth.
`auto-release.yml` currently fires on every push to `main`; it needs a `paths:`
filter so web-only or docs-only changes do not cut a desktop release. That is
a release-workflow change and needs the owner's explicit OK.

**Licence:** the Rust workspace declares `license = "MIT"` but the repo is
AGPL-3.0 and KVG_Standards makes AGPL-3.0 the default. The core is now shared
by a public site, so resolve this before the web work: recommended AGPL-3.0.
Check every dependency's licence (`KVG_Standards/licensing.md`) and record them
in `THIRD_PARTY.md`.

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

## Phase 1 — Engine spike: can the core run in a browser?

Timebox about 2 days. The output is a document (`docs/engine-spike.md`) with
measured numbers, not a product. Needs a Rust toolchain on the dev machine
(`rustup`, `nasm`, `cmake`, plus `wasm-pack` or `wasm-bindgen-cli`); installing
it is the owner's call.

| # | Task | Done when |
|---|------|-----------|
| 1.1 | Split `kvgrainy-core` into codec-agnostic logic and an `Encoder` trait; native encoders move behind it | `cargo test` unchanged and green; no behaviour change |
| 1.2 | Build the pure-Rust parts (search, scoring, resize, colour) for `wasm32-unknown-unknown`; note exactly what fails | Builds, or the failure is documented |
| 1.3 | Time one SSIMULACRA2 score and a full search in a browser worker on a real 12 MP photo and a screenshot; note memory and largest working image, on desktop and, if possible, a phone | Numbers in the spike doc |
| 1.4 | Cheap proxy metric (for example SSIM on a downscaled luma plane), in pure Rust. Compare its ranking of candidates to SSIMULACRA2 on a real corpus | Proxy picks a candidate within about 2 SSIMULACRA2 points of the true best in at least 90% of cases (adjust the target as the data suggests) |
| 1.5 | Prototype browser codecs (jSquash family: verify package names, versions and licences first) behind the `Encoder` interface | JPEG/WebP/AVIF/PNG encode timings in the spike doc |
| 1.6 | Recommend: shared core in WASM, or the TypeScript fallback | Owner confirms from the numbers |

**Gate:** owner confirms the web engine route from the measured numbers. If it
is the fallback, the plan below still holds; Phase 3 gains a TypeScript search
port that mirrors `search.rs` (same inputs, `Options`, progress, cancel, and
`NothingFits` error).

## Phase 2 — Shared core: speed, quality, correctness

Benefits desktop and web alike; the native engine is currently too slow.

| # | Task | Done when |
|---|------|-----------|
| 2.1 | Score on a 1 MP copy; cheaper search (guided parallel probes, skipped hopeless scales, Quick mode). The luma-SSIM proxy is not used for ranking until validated on graphics; see `docs/metric-study.md` | A 12 MP photo finishes in a stated time budget on a mid-range laptop (set the number after Phase 1; don't promise one before) |
| 2.2 | Palette PNG path (oxipng + quantization) | The flat-colour screenshot no longer loses to pngquant/avifenc |
| 2.3 | Load: wide-gamut and CMYK colour checks on real images; unreadable-ICC fallback | Fidelity tests cover them |
| 2.4 | Clear failure result when nothing fits: best-effort smallest file plus message | No silent no-output cases; best-effort file is written |
| 2.5 | Re-tune scoring on a real corpus; rerun the benchmark against Phase 0 | Table shows we win or tie on size at equal quality; published in `docs/` |
| 2.6 | Resolve the licence mismatch; add `THIRD_PARTY.md` | Workspace licence matches the repo |
| 2.7 | Determinism: same input and settings give byte-identical output | Test passes |

**Gate:** if 2.5 shows we lose badly, fix that before the UI.

## Phase 3 — Web MVP

A new `web/` and `ui/` in this repo. Preview deploys only (Cloudflare Pages),
no ads, `noindex` until the owner says launch.

- Stack (needs the owner's approval before scaffolding, per KVG_Standards "new tech stacks"): Astro + TypeScript + Vite, Web Workers, Vitest, Playwright. Fallback: plain Vite multi-page.
- Input: JPEG, PNG, WebP, static GIF, BMP; drag and drop, picker, paste; batch.
- Target: free text (`500kb`, `1.5mb`, raw bytes, same rules as `parse_size_limit`) plus presets from a data file; each preset has `verified_on` and `source_url`. Never state a third-party limit without a cited source and date.
- Output: Auto, or forced JPEG / PNG / WebP / AVIF (forced JPEG flattens transparency on white and says so).
- Correctness: EXIF orientation, sRGB, metadata stripped by default.
- Result UI: before/after slider, new size and percent saved, download one or all (ZIP), copy to clipboard, progress with cancel, honest failure state.
- Quick / Best effort switch with estimated time.
- Keyboard accessible, works at phone width, light/dark/neon themes (default dark) with a header switcher.
- Strict CSP from day one. **A Playwright test asserts that no request carries image data and none goes to a third-party host; keep it green forever.**
- CI: typecheck, Vitest, build, Playwright (privacy and corpus tests), bundle-size budgets (initial JS small, codecs lazy-loaded per format).
- Mobile Safari canvas and memory limits: check early; decode large images downscaled.

**Acceptance:** golden-corpus tests (photo, screenshot, transparent PNG, rotated phone photo, CMYK, already-under-limit, impossible limit, cancel mid-search), privacy test green, and a documented quality and time comparison against Squoosh and TinyPNG on at least 20 real images.

## Phase 4 — Desktop: Tauri shell, GIF, video

Rust commands wrap `kvgrainy-core`; progress and cancel flow over events. The
UI is the shared `ui/` package. Keep all logic in the core crate so the shell
stays thin.

| # | Task | Done when |
|---|------|-----------|
| 4.1 | Tauri 2 shell around `ui/`, native `Encoder`, drag and drop, paste, preset picker, before/after, real progress and cancel | Image flow works end to end on all three OSes' webviews (WebView2, WKWebView, WebKitGTK) |
| 4.2 | Animated output: GIF (gifski), animated WebP, later AVIF; frame-drop, colour and scale ladders; manual Fine-Tune tab ported from `gui.py` | Animated GIF in, smaller better GIF out |
| 4.3 | Video input: ffmpeg decode (rotation honoured, streamed/downscaled, clip length cap); MP4/WebM output to a target size via bitrate search | 2-min 1080p clip stays within a sane memory budget; video in, video under N MB out |
| 4.4 | Desktop extras: copy result to clipboard, reveal in folder, Windows right-click "Reduce with KVGrainy" | Works from Explorer |
| 4.5 | Theming: apply VisualAssault tokens if consumable as CSS/JSON; otherwise document the exception in KVG_Standards | Decision recorded |

## Phase 5 — Trust and distribution (desktop)

| # | Task | Done when |
|---|------|-----------|
| 5.1 | Release workflow for Tauri builds on all three OSes; code-sign Windows and notarize macOS | No SmartScreen/Gatekeeper warning |
| 5.2 | Self-update via Tauri updater (replaces `updater.py`); record the change in KVG_Standards | Update from N-1 to N works on all OSes |
| 5.3 | Bundled ffmpeg and encoders pass a smoke test in release artifacts | Smoke test in CI |
| 5.4 | `paths:` filter on `auto-release.yml` (owner approval) so web/docs changes do not cut desktop releases | Verified on a web-only change |
| 5.5 | Publish to winget, Scoop, Homebrew | `winget install` works |
| 5.6 | Retire the Python app; update README, CLAUDE.md, TODO.md | Docs match behavior |

## Phase 6 — Web content, SEO, ads

- Real, original pages (roughly 10 to 15 to start): tool home; a few size pages ("compress to 100 KB", "to 1 MB", "to 2 MB"); a few format pages ("JPG under 50 KB"); How it works; FAQ; About (naming a real person); Contact; Privacy. No mass-generated pages; any limit or requirement quoted needs a cited, dated source.
- `sitemap.xml`, `robots.txt`, canonical URLs, accurate structured data, Lighthouse targets.
- Privacy-friendly, cookieless analytics (owner picks).
- Ads follow KVG_Standards `static-sites.md` (PR #27) and mirror `directory-engine` (`docs/SPEC.md` "Ads"): labelled placeholders first with reserved space, build fails while placeholders are on, **never near the drop zone or buttons**, none on pages without publisher content, `ads.txt` once the publisher id exists, a certified consent tool for EEA/UK/Swiss visitors.
- The owner creates every account (Cloudflare, analytics, AdSense), buys the domain, and enters all identity, bank and tax details. Placeholders only until then.
- Re-check that the privacy claim stays true and the privacy page discloses any ad cookies.

## Phase 7 — Launch

- Post where the pain is: Discord/streamer communities, r/DataHoarder, docs/README-GIF authors, Show HN.
- Lead with the benchmark table and a 10-second demo, not a feature list.
- Collect feedback in GitHub issues; feed `TODO.md`.
- Suggested stop-or-change trigger: no meaningful organic impressions and no repeat use about 3 months after launch; define the numbers with the owner first.
- Revisit goal (free OSS vs paid pro tier) only after there's real usage.

---

## Decisions

| # | Decision | Recommended | Status |
|---|----------|-------------|--------|
| D1 | Web stack | Astro + TypeScript + Vite | Open |
| D2 | Repo | Monorepo (this repo) | Recommended, not yet confirmed |
| D3 | Web engine | Shared Rust core in WASM; TypeScript fallback | Decided at the Phase 1 gate |
| D4 | Brand and domain | Reuse KVGrainy; owner picks and buys the domain | Open |
| D5 | Hosting | Cloudflare Pages | Open |
| D6 | Theme | Visitor-selectable light/dark/neon, default dark | Open |
| D7 | Licence | AGPL-3.0 | Recommended |
| D8 | Rust workspace MIT vs repo AGPL | Resolve to AGPL-3.0 in Phase 2 | Open |

## Risks

- **Browser speed (the main risk):** the native engine takes 12 to 77 s per ~1 MP image on 4 cores, mostly SSIMULACRA2 scoring. WASM on single-threaded workers will be slower. Mitigated by the proxy metric and the Phase 1 spike; nothing is promised until measured.
- **Does the core build for the browser:** unverified. C dependencies (`mozjpeg`, `libwebp`) have no confirmed `wasm32-unknown-unknown` build; the design avoids them in the shared core.
- **Proxy metric accuracy:** unproven until Phase 1.
- **Benchmark loss:** the quality gap vs the best encoders and Squoosh/TinyPNG is a big unknown; mitigated by the Phase 2 gate before the UI.
- **Differentiation and demand:** many sites already offer "compress to N KB". The edge (quality at the target size, no upload or signup, forced format) is a claim to prove. Nobody has measured demand.
- **Ad approval and revenue:** AdSense can restrict ads on thin or templated content; revenue per page view varies widely and is unmeasured.
- **Mobile limits:** memory and canvas size on iOS Safari; test early.
- **Rewrite cost:** the engine and tests are rewritten. Keep the Python engine as the behaviour reference and port its tests.
- **Two languages:** Rust (engine) plus TypeScript (UI). Keep the boundary small: a handful of commands and events.
- **Webview differences:** WebKitGTK on Linux is the weakest. Test early and keep the UI simple.
- **Binary bloat/AV false positives:** bundled ffmpeg plus encoders; mitigate with signing.
- **Licences:** HEIC/HEVC and ffmpeg.wasm (both later) need a legal check; third-party limit claims on web pages need cited sources.
- **Standards drift:** Tauri, Rust CI, the web stack and the updater differ from the Python/Tkinter standards in KVG_Standards; resolve each before it ships.

## Suggested first PR

Phase 1.1: split `kvgrainy-core` into codec-agnostic logic and an `Encoder`
trait, no behaviour change. It is small, low-risk, and unblocks both the
WASM spike and the web fallback.
