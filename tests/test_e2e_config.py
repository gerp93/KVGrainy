import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "desktop" / "src-tauri"
DEBUG_FLAGS = ("remote-debugging", "remote-allow-origins")


def load(name: str) -> dict:
    return json.loads((TAURI / name).read_text())


class E2eConfigTests(unittest.TestCase):
    """The desktop end-to-end tests need a window that opens a DevTools port. That must exist only in the test build."""

    def test_the_shipped_config_never_opens_a_debugging_port(self):
        text = (TAURI / "tauri.conf.json").read_text()
        for flag in DEBUG_FLAGS:
            self.assertNotIn(flag, text)
        self.assertNotIn("additionalBrowserArgs", text)

    def test_the_test_config_differs_from_the_shipped_one_only_by_the_browser_arguments(self):
        shipped = load("tauri.conf.json")["app"]["windows"]
        test = load("tauri.e2e.conf.json")["app"]["windows"]
        self.assertEqual(len(shipped), len(test))
        for before, after in zip(shipped, test):
            after = dict(after)
            args = after.pop("additionalBrowserArgs")
            self.assertEqual(before, after, "the test window must otherwise match the shipped one")
            # What wry would have passed anyway (so the app behaves the same), plus the debugging port.
            self.assertIn("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection", args)
            self.assertIn("--remote-debugging-port=0", args)

    def test_only_the_desktop_ci_build_uses_the_test_config(self):
        users = [p.name for p in (ROOT / ".github" / "workflows").glob("*.yml") if "tauri.e2e.conf.json" in p.read_text()]
        self.assertEqual(users, ["desktop-ci.yml"])


if __name__ == "__main__":
    unittest.main()
