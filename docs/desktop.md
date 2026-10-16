# The desktop app

A [Tauri 2](https://tauri.app) shell (`desktop/`) around the **same UI** as the web tool
(`web/`), running the shared Rust core (`crates/kvgrainy-core`) **natively**: mozjpeg, libwebp,
rav1e (AVIF), imagequant and oxipng, on every CPU core. Nothing is uploaded; there is no server.

## One UI, two hosts

`web/` builds the UI twice. `npm run build` is the website; `npm run build:desktop`
(`KVG_TARGET=desktop`, see `web/astro.config.mjs`) is the same pages for Tauri. Three aliases pick
the host-specific module, and the UI code never knows which it got:

| alias | web build | desktop build |
|---|---|---|
| `@stills` | `stills.web.ts`: Rust core as WebAssembly in workers | `stills.desktop.ts`: Tauri command `optimize_image` (native core) |
| `@shell` | `shell.web.ts`: nothing needed | `shell.desktop.ts`: native Save as, Show in folder, files opened with the app |
| `@core-wasm` | the generated `src/wasm/kvgrainy_wasm.js` | `wasm.stub.ts`: the desktop ships no WebAssembly core |

The plan called for a shared `ui/` package; one project built for two targets gives the same single
source of truth with less indirection, so the UI stays in `web/src/ui`.

GIFs and clips still run through the TypeScript search in the webview (the same code as the web
tool); only stills are native so far (PLAN.md 4.2 and 4.3 are not done).

## How a still is reduced

```
UI (webview)                         Rust (desktop/src-tauri/src/lib.rs)
  invoke('optimize_image', file bytes,   decode (EXIF, ICC)  ->  kvgrainy_core::optimize
         headers: job id, limit, ...)      on all cores, native codecs, cancel flag
  listen('optimize-progress')        <-  progress events (job id, fraction)
  reply: [json length][json][bytes]  <-  Ok / nothing fits (best effort) / cancelled
  invoke('cancel_optimize', id)      ->  sets the job's AtomicBool
```

The file goes over as raw bytes (Tauri's binary IPC), so the Rust side decodes it: full resolution,
no canvas limits, and the output is never a re-encode of a lossy browser decode. Unlike the web build
the desktop can also produce palette PNGs (`Format::PngPalette`).

## What the shell adds (PLAN.md 4.4)

- **Save as / Show in folder.** The UI's `<a download>` links are intercepted; a click opens the
  native save dialog, then a notice offers "Show in folder".
- **Explorer right-click "Reduce with KVGrainy"** for images and videos, installed by the NSIS
  installer hook (`desktop/src-tauri/windows/hooks.nsh`). The app is single-instance: each launch
  with a file path forwards it to the open window.
- **Drag and drop** from Explorer works because Tauri's own file-drop handling is off
  (`dragDropEnabled: false`) so the UI's HTML5 drop handlers see the files. Paste works as on the web.
- Not done: copy-result-to-clipboard.

## Security

The window loads only the bundled UI. Its CSP allows `'self'` and Tauri's own IPC origins
(`ipc:`, `http(s)://ipc.localhost`), nothing else, and forbids remote content. Commands that touch
the disk are narrow: `read_file` only returns files the app was launched with, and saving always
goes through a user-chosen path in a native dialog.

## Theming (PLAN.md 4.5)

The web UI consumes the VisualAssault themes as vendored CSS and JSON (`web/scripts/update-visual-assault.mjs`,
pinned to a tag), and the desktop app is the same UI, so it gets them with no extra work. Decision:
no separate desktop theme code and no KVG_Standards exception needed.

## Build and test

```bash
# Windows: NASM 2.16.x and Perl on PATH, as for the Rust workspace (docs/engine-spike.md)
cd web && npm ci && cd ../desktop && npm ci
cd desktop
npx tauri dev                          # UI dev server + native window
npx tauri build --debug --no-bundle    # embeds the UI, builds desktop/src-tauri/target/debug/kvgrainy-desktop.exe
npx playwright test                    # drives that exe over WebView2's DevTools port (Windows)
cd src-tauri && cargo test             # Rust unit tests
```

`desktop/src-tauri` is deliberately **not** a member of the root Cargo workspace: Tauri needs system
libraries (WebKitGTK on Linux) that the Rust CI job does not install. `.github/workflows/desktop-ci.yml`
builds and tests it on Windows.

## Not verified

- macOS and Linux: the release workflow builds them, but nothing here has run on either (see docs/release.md).
- Saving through the native dialog: the dialog cannot be automated; the Rust path is covered by review only.
- The end-to-end tests do not run on a hosted GitHub runner: the app starts there but WebView2 never opens
  its DevTools port. They pass on a developer machine, and the CI job is informational.

## Verified on Windows 11 (2026-10-16)

The NSIS installer was built (`npx tauri build --debug --bundles nsis`, 9.4 MB) and exercised: a silent per-user install
registered "Reduce with KVGrainy" for both images and videos, pointing at the installed exe; the installed app passed
`--smoke-test`; launching it the way Explorer does (`kvgrainy-desktop.exe "<file>"`) opened the window, loaded that file and
reduced it; and a silent uninstall removed the registry entries and the install directory. Not exercised: the Explorer
right-click menu itself (the registry entries and the launch it triggers were checked, not a click on a real file), and
signed installers.
