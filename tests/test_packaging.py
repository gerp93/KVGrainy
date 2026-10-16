import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "packaging.py"


def render(files: dict[str, bytes], version: str = "v1.2.3") -> tuple[Path, subprocess.CompletedProcess]:
    assets = Path(tempfile.mkdtemp())
    out = Path(tempfile.mkdtemp())
    for name, data in files.items():
        (assets / name).write_bytes(data)
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "--version", version, "--assets-dir", str(assets), "--out", str(out)],
        capture_output=True,
        text=True,
    )
    return out, done


class PackagingTests(unittest.TestCase):
    def test_manifests_carry_the_real_hash_of_the_installer(self):
        exe = b"pretend installer"
        dmg = b"pretend disk image"
        out, done = render({"KVGrainy_1.2.3_x64-setup.exe": exe, "KVGrainy_1.2.3_aarch64.dmg": dmg})
        self.assertEqual(done.returncode, 0, done.stderr)

        scoop = json.loads((out / "kvgrainy.scoop.json").read_text(encoding="utf-8"))
        self.assertEqual(scoop["version"], "1.2.3")
        self.assertEqual(scoop["architecture"]["64bit"]["hash"], hashlib.sha256(exe).hexdigest().upper())
        self.assertTrue(scoop["architecture"]["64bit"]["url"].endswith("/releases/download/v1.2.3/KVGrainy_1.2.3_x64-setup.exe"))
        self.assertEqual(scoop["license"], "AGPL-3.0-only")

        installer = (out / "gerp93.KVGrainy.installer.yaml").read_text(encoding="utf-8")
        self.assertIn(f"InstallerSha256: {hashlib.sha256(exe).hexdigest().upper()}", installer)
        self.assertIn("PackageVersion: 1.2.3", installer)
        self.assertIn("InstallerType: nullsoft", installer)
        for name in ("gerp93.KVGrainy.yaml", "gerp93.KVGrainy.locale.en-US.yaml"):
            self.assertIn("PackageIdentifier: gerp93.KVGrainy", (out / name).read_text(encoding="utf-8"))

        cask = (out / "kvgrainy.rb").read_text(encoding="utf-8")
        self.assertIn(f'sha256 "{hashlib.sha256(dmg).hexdigest()}"', cask)
        self.assertIn('version "1.2.3"', cask)

    def test_a_tag_without_the_v_gives_the_same_result(self):
        out, done = render({"KVGrainy_2.0.0_x64-setup.exe": b"x"}, version="2.0.0")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads((out / "kvgrainy.scoop.json").read_text(encoding="utf-8"))["version"], "2.0.0")

    def test_no_installers_is_an_error_not_an_empty_success(self):
        _, done = render({"README.txt": b"nothing to package"})
        self.assertNotEqual(done.returncode, 0)


if __name__ == "__main__":
    unittest.main()
