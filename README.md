<p align="center">
  <img src="assets/readme-header.png" alt="KVGrainy logo" width="200" />
</p>

# KVGrainy

KVGrainy fits an image, GIF or short clip under a size limit with the best quality that limit allows.
You pick the size ("under 100 KB"); it searches formats, scales and quality for the best-looking result that
fits. Local-first: nothing is uploaded.

## Ways to use it

- **Web tool** (`web/`): a static site that runs entirely in your browser. Still images, GIFs and short clips.
  See [docs/web.md](docs/web.md).
- **Desktop app** (`desktop/`): the same interface in a [Tauri](https://tauri.app) shell, running the
  search natively on every core. See [docs/desktop.md](docs/desktop.md); installers are on the
  [releases page](https://github.com/gerp93/KVGrainy/releases).
- **Command line** (`crates/kvgrainy-cli`): still images, in batches.

The search itself is written once in Rust (`crates/kvgrainy-core`): it runs natively in the CLI and the desktop
app, and as WebAssembly in the web tool.

## Command line

```bash
cargo run --release -p kvgrainy-cli -- photo.jpg --limit 500kb --output ./reduced [--quick]
```

- `paths`: image files and/or folders (folders are scanned recursively)
- `--limit`: max output size for each image (`500kb`, `1.5mb`, or raw bytes)
- `--output`: destination directory for the optimized images (default `./reduced`)
- `--format`: force `jpeg`, `png`, `webp` or `avif` (default: pick the best)
- `--quick`: skip AVIF, the slowest codec: several times faster, usually slightly larger output

Windows native builds need NASM 2.16.x and Perl on PATH (see [docs/engine-spike.md](docs/engine-spike.md)).

## Develop

```bash
cargo test --workspace                       # the Rust core and CLI
cd web && npm ci && npm test                 # web unit tests (run the real core in WebAssembly)
cd web && npm run build && npm run test:e2e  # production build and the Playwright browser tests
cd desktop && npm ci && npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json && npx playwright test   # desktop (e2e: Windows)
python -m unittest discover -s tests -v      # release-manifest generator
```

Project plan and status: [PLAN.md](PLAN.md); open work: [TODO.md](TODO.md); releases: [docs/release.md](docs/release.md).

## Licence

AGPL-3.0-only. Third-party licences: [THIRD_PARTY.md](THIRD_PARTY.md).
