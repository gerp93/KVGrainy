import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "wait_for_ci.py"
sys.path.insert(0, str(SCRIPT.parent))
from wait_for_ci import evaluate  # noqa: E402


def run(status, conclusion=None, created="2026-01-01T00:00:00Z"):
    return {"status": status, "conclusion": conclusion, "createdAt": created}


class EvaluateTests(unittest.TestCase):
    def test_everything_green_passes(self):
        state, _ = evaluate({"web-ci.yml": [run("completed", "success")], "desktop-ci.yml": [run("completed", "success")]}, 5, 180)
        self.assertEqual(state, "pass")

    def test_a_failed_workflow_fails_even_while_another_is_still_running(self):
        state, why = evaluate({"web-ci.yml": [run("completed", "failure")], "desktop-ci.yml": [run("in_progress")]}, 5, 180)
        self.assertEqual(state, "fail")
        self.assertIn("web-ci.yml: failure", why)

    def test_cancelled_is_not_success(self):
        self.assertEqual(evaluate({"web-ci.yml": [run("completed", "cancelled")]}, 5, 180)[0], "fail")

    def test_a_running_workflow_waits(self):
        self.assertEqual(evaluate({"web-ci.yml": [run("in_progress")]}, 5, 180)[0], "wait")
        self.assertEqual(evaluate({"web-ci.yml": [run("queued")]}, 5, 180)[0], "wait")

    def test_a_workflow_that_has_not_started_waits_only_during_the_grace_period(self):
        self.assertEqual(evaluate({"web-ci.yml": []}, 30, 180)[0], "wait")
        state, why = evaluate({"web-ci.yml": []}, 200, 180)
        self.assertEqual(state, "pass")
        self.assertIn("nothing to wait for", why)

    def test_one_skipped_workflow_does_not_excuse_a_failing_one(self):
        state, _ = evaluate({"web-ci.yml": [], "desktop-ci.yml": [run("completed", "failure")]}, 400, 180)
        self.assertEqual(state, "fail")

    def test_the_newest_run_decides(self):
        # A re-run that passed replaces the failure before it (runs arrive newest first).
        runs = [run("completed", "success", "2026-01-02T00:00:00Z"), run("completed", "failure", "2026-01-01T00:00:00Z")]
        self.assertEqual(evaluate({"web-ci.yml": runs}, 5, 180)[0], "pass")


class EndToEndTests(unittest.TestCase):
    """The real script against a fake `gh` that answers from a script of responses."""

    def fake_gh(self, directory: Path, responses: list[list[dict]]) -> dict:
        (directory / "responses.json").write_text(json.dumps(responses))
        (directory / "count").write_text("0")
        gh = directory / "gh"
        gh.write_text(
            f"#!{sys.executable}\n"
            "import json, pathlib, sys\n"
            f"d = pathlib.Path({str(directory)!r})\n"
            "n = int((d / 'count').read_text())\n"
            "responses = json.loads((d / 'responses.json').read_text())\n"
            "(d / 'count').write_text(str(n + 1))\n"
            "print(json.dumps(responses[min(n, len(responses) - 1)]))\n"
        )
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        return {**os.environ, "PATH": f"{directory}{os.pathsep}{os.environ['PATH']}"}

    def call(self, responses, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.fake_gh(Path(tmp), responses)
            return subprocess.run(
                [sys.executable, str(SCRIPT), "web-ci.yml", "--repo", "o/r", "--sha", "abc", "--interval", "0", *extra],
                capture_output=True, text=True, env=env, timeout=60,
            )

    def test_waits_for_a_running_workflow_then_passes(self):
        done = self.call([[run("in_progress")], [run("in_progress")], [run("completed", "success")]])
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("pass", done.stdout)

    def test_a_failing_workflow_exits_nonzero_with_a_reason(self):
        done = self.call([[run("completed", "failure")]])
        self.assertEqual(done.returncode, 1)
        self.assertIn("not released or deployed", done.stderr)

    def test_a_workflow_that_never_runs_passes_after_the_grace_period(self):
        done = self.call([[]], "--grace", "0")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("nothing to wait for", done.stdout)

    def test_times_out_instead_of_waiting_forever(self):
        done = self.call([[run("in_progress")]], "--timeout", "0")
        self.assertEqual(done.returncode, 1)
        self.assertIn("Timed out", done.stderr)


if __name__ == "__main__":
    unittest.main()
