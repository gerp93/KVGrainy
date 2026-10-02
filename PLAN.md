# KVGrainy public-release plan

**Goal:** a free, local-first "make it fit under N MB" tool that strangers pick
over Squoosh / TinyPNG / ezgif / ffmpeg for a specific job.

**Positioning (the wedge):** drop in an image or clip, pick a target
(Discord, email, GitHub, custom), get the best version that fits. Nothing
leaves your PC.

**Non-goals:** a general-purpose image editor, cloud features, accounts.

Phases are ordered by dependency. Each phase should ship (merge to `main`,
auto-release) on its own; don't batch them.

---

## Phase 1 — Correctness and safety net

Protects everything built later. Mostly invisible to users, but these are the
bugs that would produce bad first impressions.

| # | Task | Done when |
|---|------|-----------|
| 1.1 | Apply EXIF orientation (`ImageOps.exif_transpose`) on load | Rotated phone photos come out upright |
| 1.2 | Preserve/convert ICC color profile (convert to sRGB, embed or strip deliberately) | Wide-gamut photo has no visible color shift |
| 1.3 | Add "strip metadata" option (default on for privacy, GPS especially) | Output has no EXIF/GPS when enabled |
| 1.4 | Video: honor rotation metadata; decode downscaled / stream instead of holding every full-res RGBA frame; cap clip length with a clear error | 2-min 1080p clip doesn't exceed a sane memory budget |
| 1.5 | Cooperative cancel + progress callback in the engine (`optimize_image`, `GifTuner`) | GUI/CLI can abort mid-search |
| 1.6 | Cap search effort for large inputs (coarser scale ladder, early exit once utilization is high) | 20 MP photo finishes in a few seconds |
| 1.7 | Test corpus + tests: CMYK, transparent PNG, animated GIF, rotated phone photo, rotated phone video, tiny image already under limit, impossible limit | `python -m unittest` covers GIF, video, `GifTuner`, and failure paths |
| 1.8 | Clear failure result when nothing fits (best-effort smallest + message) instead of silence | No silent no-output cases |

## Phase 2 — The wedge: presets and video output

| # | Task | Done when |
|---|------|-----------|
| 2.1 | Target presets (Discord 10 MB, email 25 MB, GitHub 10 MB, Slack, custom) in CLI (`--preset`) and GUI | One click sets the limit |
| 2.2 | MP4/WebM output for video input, targeting a size (bitrate search / two-pass) | Video in → video under N MB out |
| 2.3 | Animated WebP (and later AVIF) output for animated input | User can choose GIF / WebP / MP4 |
| 2.4 | Smart default: recommend the output type per preset (e.g. video → MP4 unless GIF requested) | Happy path needs no format choice |
| 2.5 | Update README/CLAUDE.md: video, presets, GUI, Fine-Tune tab | Docs match behavior |

## Phase 3 — Be measurably better

| # | Task | Done when |
|---|------|-----------|
| 3.1 | Swap in stronger encoders: mozjpeg (JPEG), oxipng/pngquant (PNG), gifski or gifsicle (GIF), AVIF | Sizes beat Pillow defaults at equal quality |
| 3.2 | Replace RMS with a perceptual metric (SSIM first; SSIMULACRA2 if practical) and re-tune `VISUAL_WEIGHT` / `SIZE_UTILIZATION_WEIGHT` against eyeballed results | Chosen candidates look better on the corpus |
| 3.3 | Benchmark script: fixed corpus vs TinyPNG / Squoosh / ffmpeg, output a table | `scripts/benchmark.py` produces publishable numbers |
| 3.4 | Packaging check: bundled encoder binaries work in the PyInstaller build on all 3 OSes | Release artifacts pass a smoke test |

Gate: if 3.3 shows we lose badly, fix that before polishing UI — the
comparison table is the marketing.

## Phase 4 — UI that feels current

**Decision needed before starting:** which UI stack.

| Option | Notes |
|--------|-------|
| Polish Tkinter | Cheapest; ceiling on look. |
| **PySide6 (Qt) — recommended default** | Native, still Python, reuses the engine unchanged. Check against KVG_Standards theming (currently `visual-assault-tkinter`) — may need a Qt theme package or a documented exception. |
| Tauri/Electron shell over the Python engine | Best look; biggest effort and binary. |
| WASM/browser build | Best reach (zero install) but heavy codec work; consider as a separate follow-up, not a replacement. |

Regardless of stack, the feature list is the same:

- Drag and drop and paste from clipboard
- Before/after slider and live size estimate
- Real progress and cancel
- "Copy result to clipboard"
- Windows right-click "Reduce with KVGrainy" entry
- Sensible default flow: drop file → pick preset → done

## Phase 5 — Trust and distribution

| # | Task | Done when |
|---|------|-----------|
| 5.1 | Code-sign the Windows build (and notarize macOS) via the KVG_Standards release workflow | No SmartScreen/Gatekeeper warning |
| 5.2 | Reduce download size / startup time (consider onedir + installer over onefile) | Cold start measured and acceptable |
| 5.3 | Publish to winget, Scoop, Homebrew | `winget install` works |
| 5.4 | Landing page: demo before/after (made with the app), privacy pitch, benchmark table, download button | Page live |
| 5.5 | Verify self-update end to end on signed builds | Update from N-1 → N works on all OSes |

## Phase 6 — Launch

- Post where the pain is: Discord/streamer communities, r/DataHoarder, docs/README-GIF authors, Show HN.
- Lead with the benchmark table and a 10-second demo, not a feature list.
- Collect feedback in GitHub issues; feed `TODO.md`.
- Revisit goal (free OSS vs paid pro tier) only after there's real usage.

---

## Risks

- **Benchmark loss:** stock-quality gap vs TinyPNG/Squoosh is the biggest unknown — mitigated by doing Phase 3 early.
- **Binary bloat/AV false positives:** bundled ffmpeg + encoders in PyInstaller; mitigated by signing and onedir.
- **UI rewrite scope:** the largest single chunk of work; keep the engine UI-agnostic so it can't block earlier phases.
- **Standards drift:** a non-Tkinter UI touches KVG_Standards theming; resolve before Phase 4.

## Suggested first PR

Phase 1.1 + 1.2 + 1.7 (EXIF, color profile, tests for them): small, low-risk,
and sets the pattern for the rest.
