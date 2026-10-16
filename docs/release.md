# Releasing KVGrainy

## What a release is

Every push to `main` that changes the product tags a new patch version and runs
`.github/workflows/auto-release.yml`:

1. **version**: bumps the tag (`v1.2.3`).
2. **desktop**: `release-desktop.yml` creates the GitHub release, builds the Tauri app on Windows,
   macOS (Apple silicon) and Linux, **smoke-tests the packaged binary**, and attaches the installers
   to the release. Then it renders Scoop, winget and Homebrew manifests from the uploaded files and
   attaches those too.

The Python app is no longer built or released. Its source is still in the repo (see below), and
changes to it alone do not cut a release. Copies of the Python app already installed will not find
newer releases, because those no longer carry its files.

`cut-release.yml` does the same for a version you choose (Actions tab, "Run workflow").

Changes that don't change the product do not cut a release (PLAN.md 5.4): docs, any `*.md`,
tests, e2e specs, `web/src/content/**` (the future content pages) and `*-ci.yml` workflows. To force
a release anyway, add a line to `VERSION_BUMP.md`. UI changes do release: the desktop app embeds
the same UI as the web tool.

## The smoke test (PLAN.md 5.3)

The packaged binary supports `kvgrainy-desktop --smoke-test <report file>`. It opens no window; it
encodes and decodes a small image with every native codec (JPEG, WebP, AVIF, lossless and palette
PNG) and runs a whole search, writes a report, and exits non-zero on any failure. The workflow
runs it on each OS before uploading, so a build with a missing or broken codec stops the release.
The same test runs in `cargo test` in `desktop/src-tauri`. ffmpeg is not bundled yet (native video is
PLAN.md 4.3, not done), so there is nothing to smoke-test for it.

## Signing: you need to add secrets

The installers are **unsigned** until you add these repository secrets (Settings, Secrets and
variables, Actions). The workflow prints a warning for each missing set; it never fails for lack of one.

| Secret | What it is |
|---|---|
| `WINDOWS_CERTIFICATE` | a code-signing certificate as a base64-encoded `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | its password |
| `APPLE_CERTIFICATE` | a "Developer ID Application" certificate as a base64-encoded `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | its password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | your Apple ID, an app-specific password, and the team id, for notarization |
| `WINGET_TOKEN` | a GitHub classic PAT with `public_repo`, to submit new versions to winget |

Until then: Windows SmartScreen will warn on the installer ("Windows protected your PC", More
info, Run anyway) and macOS Gatekeeper will block the app until the user allows it in System
Settings. PLAN.md 5.1's acceptance, "no SmartScreen/Gatekeeper warning", needs these certificates
and a bit of reputation for the Windows one; I can't create them for you. The code-signing
certificates are a purchase (Windows) and an Apple Developer Program membership (macOS).

Linux has no equivalent; `.deb`, `.rpm` and `.AppImage` are attached unsigned, as is usual.
Only Apple silicon is built for macOS; an Intel build needs a runner I could not confirm exists.

## Self-update (PLAN.md 5.2): not the plan's version, and why

The plan replaces `updater.py` with Tauri's updater plugin (signed `latest.json`, in-app download
and restart). **That cannot be built today:** every release of `tauri-plugin-updater` 2.x depends on
the `zip` crate, and every `zip` release those versions accept (2.x to 8.x) has been yanked from
crates.io. Only `zip` 9.0.3 is live and the plugin does not allow it, so Cargo cannot resolve the
dependency at all. A first attempt at adding it failed exactly there.

Instead the app, at start-up and from the **Check for updates** button in the footer, asks
GitHub's API for the newest release, compares its tag with the running version, and offers to open
the download page. Nothing is downloaded or installed automatically, so there is no signature to
verify and no new trust to establish: the user installs from the release page, which is where the
installer's own signature (above) does its job.

To do the real thing later: when Tauri publishes an updater that builds, add the plugin, generate a
key with `npx tauri signer generate`, put the public key in `tauri.conf.json` (`plugins.updater`)
and the private key in the `TAURI_SIGNING_PRIVATE_KEY` secret, and set `bundle.createUpdaterArtifacts`.
The app stamps its version from the release tag at build time (`release-desktop.yml`), so the comparison
above already works for the first tagged release.

## Package managers (PLAN.md 5.5): manifests are generated, publishing is yours

`scripts/packaging.py` (tested in `tests/test_packaging.py`) writes manifests with the SHA-256 of the
exact installers and the workflow attaches them to each release:

- `kvgrainy.scoop.json`: `scoop install https://github.com/gerp93/KVGrainy/releases/latest/download/kvgrainy.scoop.json`
  works without a bucket. Not run against a real Scoop yet; the NSIS silent-install script is the part to check.
- `gerp93.KVGrainy*.yaml`: winget manifests. The first version must be submitted to
  `microsoft/winget-pkgs` by hand (`wingetcreate` or a PR); after that, with `WINGET_TOKEN` set, the
  workflow submits each new version. `winget install` works once Microsoft merges the first one.
- `kvgrainy.rb`: a Homebrew cask for the Apple-silicon disk image. It needs a tap repository
  (`gerp93/homebrew-tap`); copy it there on each release. Homebrew's own repository rejects casks
  for apps without notarization, so a tap is the path until you have an Apple developer account.

None of this was published or installed from here.

## Retiring the Python app (PLAN.md 5.6): packaging stopped, code not deleted

Releases no longer package the Python app (`gui.py`, `kvgrainy.py`, `theming.py`, `updater.py`), but
its source stays in the repo as the reference engine. Deleting it would regress video: PLAN.md 4.3
(native video) is not done, so the Tauri app runs clips through the webview's TypeScript search,
which covers the common cases but not `.mkv` and `.avi` (WebView2 cannot decode them) and is slower. When those are native, delete the Python files and
`requirements.txt`, and update the README and CLAUDE.md.

## Verifying a release

After a release finishes: download the installer for your OS, install it, and run
`kvgrainy-desktop --smoke-test report.txt` (the report should end in `PASSED`); open the app and
reduce an image; on Windows check that right-clicking an image shows "Reduce with KVGrainy".
`release-desktop.yml` has completed one real run (release v1.0.29): all three OS bundles built, passed their smoke
test and were uploaded, and the package manifests were generated and attached (`.msi`, NSIS `.exe`, `.dmg`, `.AppImage`,
`.deb`, `.rpm`, `kvgrainy.scoop.json`, `kvgrainy.rb`, three winget YAMLs). Its first attempt failed on one config value
(`bundle.category`), fixed in #39. **Not yet exercised:** the signing and notarization steps (no certificates), and
installing the Linux, macOS and MSI packages on a real machine; only the Windows NSIS installer was installed and run.
