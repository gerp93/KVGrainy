#!/usr/bin/env python3
"""Render package-manager manifests (Scoop, winget, Homebrew) for a KVGrainy desktop release.

usage: python scripts/packaging.py --version v1.2.3 --assets-dir dir-with-release-files --out manifests/

The release workflow runs this after the bundles are built, with the real files, so every manifest
carries the SHA-256 of the exact installer users will download, and attaches the output to the
release. Publishing to the registries themselves needs the owner's accounts; see docs/release.md.

Asset names are what Tauri's bundler writes for productName "KVGrainy":
  Windows  KVGrainy_<v>_x64-setup.exe          (NSIS, per-user install)
  macOS    KVGrainy_<v>_aarch64.dmg
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = "gerp93/KVGrainy"
HOMEPAGE = f"https://github.com/{REPO}"
DESCRIPTION = "Fit an image, GIF or clip under a size limit with the best quality possible. Local-first: nothing is uploaded."
LICENCE = "AGPL-3.0-only"
PACKAGE_ID = "gerp93.KVGrainy"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest().upper()


def download_url(tag: str, name: str) -> str:
    return f"{HOMEPAGE}/releases/download/{tag}/{name}"


def scoop(version: str, tag: str, windows: Path) -> str:
    """A Scoop manifest. Install with: scoop install <url to this file>."""
    name = windows.name
    manifest = {
        "version": version,
        "description": DESCRIPTION,
        "homepage": HOMEPAGE,
        "license": LICENCE,
        "architecture": {"64bit": {"url": download_url(tag, name), "hash": sha256(windows)}},
        "installer": {"script": [f'Start-Process -FilePath "$dir\\{name}" -ArgumentList "/S" -Wait', f'Remove-Item "$dir\\{name}"']},
        "uninstaller": {"script": ['$u = "$env:LOCALAPPDATA\\KVGrainy\\uninstall.exe"', 'if (Test-Path $u) { Start-Process -FilePath $u -ArgumentList "/S" -Wait }']},
        "checkver": {"github": HOMEPAGE},
        "autoupdate": {"architecture": {"64bit": {"url": f"{HOMEPAGE}/releases/download/v$version/KVGrainy_$version_x64-setup.exe"}}},
    }
    return json.dumps(manifest, indent=2) + "\n"


def winget(version: str, tag: str, windows: Path) -> dict[str, str]:
    """The three winget manifest files (schema 1.6) for the NSIS installer."""
    header = "# yaml-language-server: $schema=https://aka.ms/winget-manifest.{kind}.1.6.0.schema.json\n"
    common = f"PackageIdentifier: {PACKAGE_ID}\nPackageVersion: {version}\n"
    version_file = header.format(kind="version") + common + "DefaultLocale: en-US\nManifestType: version\nManifestVersion: 1.6.0\n"
    installer_file = (
        header.format(kind="installer")
        + common
        + "InstallerType: nullsoft\nScope: user\nInstallModes:\n- silent\n- silentWithProgress\n"
        + "InstallerSwitches:\n  Silent: /S\n  SilentWithProgress: /S\n"
        + "Installers:\n"
        + f"- Architecture: x64\n  InstallerUrl: {download_url(tag, windows.name)}\n  InstallerSha256: {sha256(windows)}\n"
        + "ManifestType: installer\nManifestVersion: 1.6.0\n"
    )
    locale_file = (
        header.format(kind="defaultLocale")
        + common
        + "PackageLocale: en-US\nPublisher: gerp93\nPackageName: KVGrainy\n"
        + f"PackageUrl: {HOMEPAGE}\nLicense: {LICENCE}\nLicenseUrl: {HOMEPAGE}/blob/main/LICENSE\n"
        + f"ShortDescription: {DESCRIPTION}\nManifestType: defaultLocale\nManifestVersion: 1.6.0\n"
    )
    return {
        f"{PACKAGE_ID}.yaml": version_file,
        f"{PACKAGE_ID}.installer.yaml": installer_file,
        f"{PACKAGE_ID}.locale.en-US.yaml": locale_file,
    }


def homebrew(version: str, tag: str, mac: Path) -> str:
    """A Homebrew cask for the Apple-silicon disk image. Put it in a tap: brew install --cask <tap>/kvgrainy."""
    return (
        'cask "kvgrainy" do\n'
        f'  version "{version}"\n'
        f'  sha256 "{sha256(mac).lower()}"\n\n'
        f'  url "{HOMEPAGE}/releases/download/v#{{version}}/KVGrainy_#{{version}}_aarch64.dmg"\n'
        '  name "KVGrainy"\n'
        f'  desc "{DESCRIPTION}"\n'
        f'  homepage "{HOMEPAGE}"\n\n'
        "  depends_on arch: :arm64\n\n"
        '  app "KVGrainy.app"\n'
        "end\n"
    )


def find(assets: Path, pattern: str) -> Path | None:
    matches = sorted(assets.glob(pattern))
    return matches[0] if matches else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True, help="release tag, e.g. v1.2.3")
    parser.add_argument("--assets-dir", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    tag = "v" + args.version.lstrip("v")
    version = tag[1:]
    args.out.mkdir(parents=True, exist_ok=True)
    written = []

    windows = find(args.assets_dir, "*_x64-setup.exe")
    if windows:
        (args.out / "kvgrainy.scoop.json").write_text(scoop(version, tag, windows), encoding="utf-8")
        written.append("kvgrainy.scoop.json")
        for name, text in winget(version, tag, windows).items():
            (args.out / name).write_text(text, encoding="utf-8")
            written.append(name)
    mac = find(args.assets_dir, "*_aarch64.dmg")
    if mac:
        (args.out / "kvgrainy.rb").write_text(homebrew(version, tag, mac), encoding="utf-8")
        written.append("kvgrainy.rb")

    if not written:
        print("no installers found in", args.assets_dir, file=sys.stderr)
        return 1
    print("wrote:", ", ".join(written))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
