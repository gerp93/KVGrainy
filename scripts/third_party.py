#!/usr/bin/env python3
"""Regenerate THIRD_PARTY.md from `cargo metadata`.

usage: python scripts/third_party.py > THIRD_PARTY.md

Lists the Rust crates in the runtime dependency closure of kvgrainy-core and kvgrainy-cli.
The hand-written header below holds the compatibility notes; edit them here, not in the output.
"""
import json
import os
import subprocess

ROOT_CRATES = {"kvgrainy-core", "kvgrainy-cli", "kvgrainy-wasm"}

HEADER = """# Third-party licences

KVGrainy is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).

This file lists the Rust crates compiled into `kvgrainy-core`, `kvgrainy-cli` and `kvgrainy-wasm` and the desktop shell (the
runtime dependency closure, all targets, with default features), then the web app's runtime npm
packages. It is generated from `cargo metadata`;
regenerate it with `python scripts/third_party.py > THIRD_PARTY.md` after changing dependencies.

## Compatibility notes

- Every licence below is compatible with distributing the combined work under AGPL-3.0.
- **MPL-2.0** (`avif-parse`, and `cssparser`, `dtoa-short` and friends through Tauri's HTML handling): file-level copyleft, used unmodified; MPL-2.0 permits combination with AGPL-3.0.
- **GPL-3.0-or-later** (`imagequant`, palette PNG): GPLv3 section 13 allows combining it with AGPL-3.0, which KVGrainy is. Anyone distributing KVGrainy as a whole must follow the AGPL-3.0, which this licence permits. It also means KVGrainy cannot be relicensed under a more permissive licence while it includes imagequant.
- **AGPL-3.0-or-later** (`gifski`, animated GIF output): the same licence family as KVGrainy's AGPL-3.0, so combining them is permitted and the combined work stays AGPL-3.0.
- **`r-efi`** is offered under `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; KVGrainy uses it under MIT.
- **mozjpeg** (`IJG AND Zlib AND BSD-3-Clause`) and **libwebp** (BSD-3-Clause) are C libraries built from source by their `-sys` crates on native targets only.
- **Tauri** (the desktop shell, `desktop/`) is MIT OR Apache-2.0; its Linux builds link WebKitGTK (LGPL) dynamically, as a system library, and Windows uses the system WebView2.
- Not yet included: any bundled ffmpeg. Add them here when they ship (ffmpeg builds must be LGPL-configured or the combination documented).

## Crates

| Crate | Version | Licence |
|---|---|---|"""


def crate_rows(manifest: list[str], roots: set[str]) -> set[tuple[str, str, str]]:
    """(name, version, licence) for the runtime dependency closure of `roots`."""
    meta = json.loads(subprocess.check_output(["cargo", "metadata", "--format-version", "1", "--locked", *manifest]))
    packages = {p["id"]: p for p in meta["packages"]}
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    stack = [p["id"] for p in meta["packages"] if p["name"] in roots]
    seen: set[str] = set()
    while stack:
        pkg = stack.pop()
        if pkg in seen:
            continue
        seen.add(pkg)
        for dep in nodes[pkg]["deps"]:
            if any(kind["kind"] in (None, "normal") for kind in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    return {
        (packages[i]["name"], packages[i]["version"], packages[i].get("license") or "UNSPECIFIED")
        for i in seen
        if not packages[i]["name"].startswith("kvgrainy")
    }


def main() -> None:
    rows = crate_rows([], ROOT_CRATES)
    # The desktop shell is its own Cargo workspace (see desktop/src-tauri/Cargo.toml).
    rows |= crate_rows(["--manifest-path", "desktop/src-tauri/Cargo.toml"], {"kvgrainy-desktop"})
    print(HEADER)
    for name, version, licence in sorted(rows):
        print(f"| {name} | {version} | {licence} |")
    print_npm()


def print_npm() -> None:
    """The web app's direct runtime dependencies (their transitive tree is in web/package-lock.json)."""
    web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
    with open(os.path.join(web, "package.json"), encoding="utf-8") as f:
        dependencies = sorted(json.load(f)["dependencies"])
    print()
    print("## Web app (npm, direct runtime dependencies)")
    print()
    print("Codecs are the jSquash WebAssembly builds of mozjpeg, libwebp, libavif, oxipng and libpng.")
    print()
    print("| Package | Version | Licence |")
    print("|---|---|---|")
    for name in dependencies:
        path = os.path.join(web, "node_modules", *name.split("/"), "package.json")
        if not os.path.exists(path):
            print(f"| {name} | (run npm ci) | |")
            continue
        with open(path, encoding="utf-8") as f:
            info = json.load(f)
        print(f"| {name} | {info['version']} | {info.get('license', 'UNSPECIFIED')} |")


if __name__ == "__main__":
    main()
