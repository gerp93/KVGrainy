# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup
python -m venv .venv
.venv\Scripts\activate        # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt

# Run the CLI
python kvgrainy.py [paths ...] --limit 750kb --output ./reduced [--format jpeg|png|webp|gif]
python kvgrainy.py                     # no args -> interactive prompt mode

# Run the desktop GUI
python gui.py

# Tests (stdlib unittest, no pytest dependency)
python -m unittest discover -s tests -v
python -m unittest tests.test_kvgrainy.KVGrainyTests.test_parse_size_limit   # single test

# Compile-check after edits (fast syntax/import sanity check, no test runner needed)
python -m py_compile gui.py kvgrainy.py updater.py theming.py
```

There is no linter or formatter configured in this repo.

`requirements.txt` installs `visual-assault-tkinter` directly from a GitHub
subdirectory (`git+https://github.com/gerp93/VisualAssault.git@main#subdirectory=packages/tkinter`) —
there is no PyPI package for it.

## Architecture

KVGrainy has two independent entry points sharing one optimization engine:

- **`kvgrainy.py`** — the optimization engine and CLI. No dependency on Tkinter.
- **`gui.py`** — a Tkinter desktop app (`KVGrainyGUI`) that imports and reuses
  `kvgrainy.py`'s functions directly; it does not shell out to the CLI.
- **`theming.py`** and **`updater.py`** — GUI-only concerns, imported by `gui.py`.

### Optimization engine (`kvgrainy.py`)

The core idea used throughout: for a target size limit, search a space of
`(format, scale, quality/colors)` combinations and keep the best-scoring
candidate that still fits under the limit. A `Candidate` bundles the encoded
bytes with a `total_score` (weighted blend of `VISUAL_WEIGHT` similarity vs.
`SIZE_UTILIZATION_WEIGHT` — how much of the size budget got used), and
`is_better()` picks the winner by `(total_score, size_bytes)`.

Two parallel search paths exist because static and animated images need
different knobs:

- **Static images** (`optimize_image` → `find_best_for_format` →
  `evaluate_candidate`): tries JPEG/WEBP/PNG (or a single forced format via
  `--format`) across `SCALE_FACTORS`, binary-searching JPEG/WEBP quality
  (20–100) at each scale; PNG/GIF have no quality knob so every scale is
  just evaluated once. `rms_score()` measures visual similarity by
  re-decoding the candidate and diffing pixels against the original.
- **Animated GIFs** (`optimize_animated_gif` → `find_best_gif`): detected via
  `original.is_animated`, so a `.gif` upload isn't required — any animated
  input hits this path, any static input hits the format search above. Same
  scale loop, but binary-searches per-frame palette size (2–256 colors) at
  each scale instead of quality, sampling up to 5 frames for the visual score
  since scoring every frame would be too slow. This path always outputs
  `.gif`; it never falls back to another format.

A third, separate mechanism — `build_gif_ladder()` / `GifTuner` — powers the
GUI's manual "Fine-Tune GIF" tab and is not used by the automatic bulk-mode
paths above. Instead of searching for one optimum, it builds a fixed,
ordered list of configs (best → worst) across three independent axes —
scale, color count, and frame-drop step (`apply_frame_step`, which keeps
every Nth frame and sums the dropped frames' durations into the kept
frame's, so playback speed doesn't change) — degrading whichever axis the
user picked as `priority` first, before touching the other two. `GifTuner`
caches encodes by `(priority, ladder index)` so scrubbing a slider in the
GUI doesn't re-encode configs it's already computed. `max_feasible_index()`
finds the best (lowest-index) config that still fits a size limit; the GUI
maps its quality slider's 100% end to that index rather than to ladder
index 0, so the slider always spans a fully-usable range regardless of how
strict the limit is.

### GUI (`gui.py`)

`KVGrainyGUI` builds a `ttk.Notebook` with two tabs, `setup_bulk_tab` (drives
`kvgrainy.optimize_image` directly, one call per file) and
`setup_finetune_tab` (drives `GifTuner` for one GIF at a time, live-previewing
the animated result as the user adjusts limit/priority/quality). Every
encode — bulk or fine-tune — runs on a background `Thread` and posts results
back via `self.root.after(0, ...)`, since Tk is not thread-safe and must only
be touched from the main thread.

**`theming.py`** applies color themes from the separate
[VisualAssault](https://github.com/gerp93/VisualAssault) project. It forces
`ttk.Style` to the `clam` base theme (the only one that reliably honors
custom background/foreground overrides cross-platform) and manually restyles
raw `tk.Text`/`tk.Menu` widgets, since ttk styling doesn't reach them.
`capture_defaults()` must be called once, after the full UI (including all
menus) is built, so picking "System Default" can restore the exact native
look rather than guessing at it.

**`updater.py`** implements in-app self-update: it compares a build-time
`_version.py` (generated by CI, gitignored, absent when running from source —
`CURRENT_VERSION` falls back to `"0.0.0-dev"` and every update check no-ops
in that case) against the latest GitHub release, then downloads and
self-replaces. The replace step is platform-specific and easy to get wrong:
on Windows the running `.exe` can't overwrite itself, so it writes a
self-deleting batch script that polls `tasklist` for the current PID to
disappear before copying the new exe over and relaunching; on macOS/Linux it
replaces the running binary directly and `os.execv`s into it, since POSIX
allows replacing a file that's currently executing. On the Windows path,
terminating with `sys.exit()` does **not** work if called from a Tkinter
callback (`root.after`) — Tkinter's callback exception handler silently
swallows the resulting `SystemExit`, so the process never actually dies and
the batch script's wait loop spins forever. Use `os._exit()` there instead.

### Release pipeline (`.github/workflows/release.yml`)

Every push to `main` runs three jobs in sequence: `version` bumps semver
using `mathieudutour/github-tag-action`, which follows the Conventional
Commits / Angular convention across **every commit in the push, not just
one**, taking the highest-severity prefix found (`BREAKING CHANGE` footer >
`feat:` > `fix:`; anything else falls back to `default_bump: patch`). Then
`build` runs a PyInstaller `--onefile --windowed` matrix across Linux,
Windows, and macOS, writing `_version.py` (consumed by `updater.py`) and
bundling `LICENSE` via `--add-data` before each build. Then `release`
collects all three artifacts and cuts a GitHub Release tagged with the
version job's output.

Because the version bump scans every commit in a push, a merge that bundles
an unrelated `feat:` commit alongside a `chore:`/`fix:` one will bump minor
even if the PR's main intent was patch-level — keep PRs to one conventional
commit type where the version bump matters, or squash-merge.






