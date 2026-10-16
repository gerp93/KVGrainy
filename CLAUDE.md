# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Rust engine and CLI (Windows native builds need NASM 2.16.x and Perl on PATH: docs/engine-spike.md)
cargo test --workspace
cargo run --release -p kvgrainy-cli -- photo.jpg --limit 500kb --output ./reduced [--quick] [--format jpeg|png|webp|avif]

# Web tool (static site; the search is the Rust core compiled to WASM, see docs/web.md)
# Needs: rustup target add wasm32-unknown-unknown; cargo install wasm-bindgen-cli --version <Cargo.lock's wasm-bindgen> --locked
cd web && npm ci && npm test && npm run build && npm run budgets && npm run check-ads && npm run test:ads && npm run test:e2e

# Desktop app (Tauri around the same UI, native core; Windows e2e; see docs/desktop.md)
cd desktop && npm ci && npx tauri build --debug --no-bundle && npx playwright test

# Release-manifest generator (stdlib unittest, no pytest dependency)
python -m unittest discover -s tests -v
```

There is no linter or formatter configured in this repo.

The old Python app (`kvgrainy.py`, `gui.py`, Tkinter) was deleted on 2026-10-16; it is in git history if the
reference behaviour is ever needed. The remaining Python is tooling only: `scripts/packaging.py` (release
manifests, tested in `tests/`), `scripts/third_party.py`, `scripts/generate_icons.py` and `scripts/benchmark.py`.

## Architecture

KVGrainy is one search engine with three front ends:

- **`crates/kvgrainy-core`**: the engine. For a size limit it searches `(format, scale, quality)` for the
  best-scoring candidate that fits, scoring with SSIMULACRA2 on a 1 MP copy. Codecs sit behind an `Encoder`
  trait; native builds use mozjpeg, libwebp, rav1e (AVIF), imagequant and oxipng, and the browser build
  supplies WASM codecs from JavaScript. Stills only.
- **`crates/kvgrainy-cli`**: the command line over the core.
- **`crates/kvgrainy-wasm`**: the core compiled to WebAssembly for the web tool.
- **`web/`**: the static site (Astro + TypeScript). One Web Worker per output format; the privacy claim is
  enforced by `web/e2e/privacy.spec.ts`. GIFs and clips use a TypeScript search (`gif.ts`, `webpanim.ts`, and the
  manual Fine-Tune GIF tuner in `tuner.ts`). See [docs/web.md](docs/web.md); content, SEO and the ad rules:
  [docs/web-content.md](docs/web-content.md).
- **`desktop/`**: Tauri 2 shell around the same UI, calling the core natively; GIFs use gifski. See
  [docs/desktop.md](docs/desktop.md).

Project plan and status: [PLAN.md](PLAN.md). Open work: [TODO.md](TODO.md). Launch checklist: [docs/launch.md](docs/launch.md).

### Release pipeline (`.github/workflows/auto-release.yml` + `cut-release.yml`)

Both release triggers are active, per KVG_Standards convention:
`auto-release.yml` fires on every push to `main` (conventional-commit
patch/minor/major bump, `default_bump: patch`), and `cut-release.yml` stays
available in the Actions tab for a deliberately-numbered release
(`workflow_dispatch`, explicit `vX.Y.Z` input) when you want one instead of
the auto-bump. Both call the local `release-desktop.yml`, which creates the
GitHub Release and attaches the Tauri installers (see `docs/release.md`).
Pushes that only touch docs, any `*.md`, tests, e2e specs or `*-ci.yml` workflows do not release
(`paths:` filter, PLAN.md 5.4); UI changes do, because the desktop app embeds the web UI. To force a release with
no other code change, edit `VERSION_BUMP.md` instead of pushing an empty commit. The old Python app is no longer
built or released (and its source is deleted).

## Standards

This repo follows [gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards)
for theming, release/CI, self-update, licensing, logo & branding, release
notes, `VERSION_BUMP.md`, and `TODO.md` conventions. See that repo's
`README.md` and `REPO_SCOPE.md` (KVGrainy's row) for the current standards
and this repo's scope against them — don't assume this file has the full,
current picture.








