# TODO

This app's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and its `REPO_SCOPE.md` entry for that). Just what's not built yet. The plan these come from is
[PLAN.md](PLAN.md).

## Needs the owner (I can't do these from here)

- Windows code-signing certificate and Apple Developer account; add the secrets in
  [docs/release.md](docs/release.md). Until then installers are unsigned (SmartScreen and Gatekeeper warn).
- First winget submission, a Homebrew tap repository and (optionally) a Scoop bucket.
- Domain, Cloudflare Pages, analytics, and every ad account (PLAN.md Phase 6).
- Decide the brand and domain (PLAN.md D4) and whether the web tool launches (Phase 7).

## Features

- Native GIF (gifski) and video (ffmpeg decode, MP4/WebM output by bitrate search) in the Rust core
  and desktop app (PLAN.md 4.2, 4.3). Today GIFs and clips run through the TypeScript search in the
  webview, which cannot decode `.mkv` or `.avi`.
- Tauri's updater plugin, once it can be built (docs/release.md explains the `zip` yank that blocks it).
- Copy the result to the clipboard (web and desktop).
- A macOS Intel build; arm64 only today.
- A palette-PNG quantizer in the browser (the web build is lossless PNG only).
- Speed: AVIF encoding dominates a Best search of a large photo (about 95 s for 12 MP on 24 threads).

## Verification gaps

- Browser memory: a 12 MP photo peaks near 2.4 GB and a 24 MP photo (the current cap) near 3.6 GB in desktop Chromium
  (docs/web.md). Try a real iPhone and an Android phone; if they crash, search on a downscaled copy instead of holding
  full-resolution pixels in every format worker, rather than only lowering the cap.

- Safari, Firefox and phones for the web tool; only Chromium is tested. Large-photo memory limits.
- macOS and Linux desktop builds, a real right-click in Explorer, and the native Save dialog. (The NSIS installer, its registry entries, the installed app and the uninstall were verified on Windows; see docs/desktop.md.)
- Compare size and quality against Squoosh and TinyPNG on 20 real images (PLAN.md Phase 3 acceptance),
  and against cjpeg, cwebp, avifenc, oxipng, pngquant, gifski and ffmpeg (PLAN.md 0.3 and 2.5). None
  of those tools are installed on the dev machine; `scripts/benchmark.py` is ready for them.
- Real screenshots and graphics for the metric study and for palette PNG (only synthetic ones so far).

## Fixes

-
