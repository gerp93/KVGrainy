#!/usr/bin/env python3
"""Wait for the CI workflows that guard a release or a deploy to finish for one commit.

    python scripts/wait_for_ci.py --repo owner/name --sha <commit> web-ci.yml desktop-ci.yml

Exits 0 when every named workflow that ran for the commit finished with `success`, and 1 when one failed
or the wait timed out. A workflow that never starts for the commit is not an error: CI workflows only run
for the paths they list, so a change that touches none of them has no run to wait for. A workflow is
treated as "did not run" only after a grace period, so a slow start is not mistaken for a skipped one.

Needs the GitHub CLI (`gh`) and a token that can read Actions runs (`GH_TOKEN`, `actions: read`).
"""
import argparse
import json
import subprocess
import sys
import time


def evaluate(runs_by_workflow: dict[str, list[dict]], waited: float, grace: float) -> tuple[str, str]:
    """Decide from the runs seen so far: ("pass" | "fail" | "wait", why). Runs are newest first."""
    failed, waiting, notes = [], [], []
    for workflow, runs in runs_by_workflow.items():
        if not runs:
            if waited < grace:
                waiting.append(f"{workflow}: not started yet")
            else:
                notes.append(f"{workflow}: no run for this commit (its paths did not match), so nothing to wait for")
            continue
        run = runs[0]
        if run.get("status") != "completed":
            waiting.append(f"{workflow}: {run.get('status')}")
        elif run.get("conclusion") != "success":
            failed.append(f"{workflow}: {run.get('conclusion')}")
        else:
            notes.append(f"{workflow}: success")
    if failed:
        return "fail", "; ".join(failed)
    if waiting:
        return "wait", "; ".join(waiting)
    return "pass", "; ".join(notes)


def fetch_runs(repo: str, sha: str, workflow: str) -> list[dict]:
    done = subprocess.run(
        ["gh", "run", "list", "--repo", repo, "--workflow", workflow, "--commit", sha,
         "--json", "status,conclusion,createdAt", "--limit", "10"],
        capture_output=True, text=True,
    )
    if done.returncode != 0:
        raise RuntimeError(f"gh run list failed for {workflow}: {done.stderr.strip() or done.stdout.strip()}")
    return sorted(json.loads(done.stdout or "[]"), key=lambda r: r.get("createdAt", ""), reverse=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workflows", nargs="+", help="workflow file names, e.g. web-ci.yml")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--timeout", type=float, default=2700, help="give up after this many seconds")
    parser.add_argument("--grace", type=float, default=180, help="treat a workflow that has not started by now as not triggered")
    parser.add_argument("--interval", type=float, default=20)
    args = parser.parse_args(argv)

    started = time.monotonic()
    last = ""
    while True:
        waited = time.monotonic() - started
        runs = {w: fetch_runs(args.repo, args.sha, w) for w in args.workflows}
        state, why = evaluate(runs, waited, args.grace)
        line = f"[{int(waited)}s] {state}: {why}"
        if line != last:
            print(line, flush=True)
            last = line
        if state == "pass":
            return 0
        if state == "fail":
            print("A required CI workflow failed for this commit, so it is not released or deployed.", file=sys.stderr)
            return 1
        if waited >= args.timeout:
            print(f"Timed out after {int(args.timeout)}s waiting for: {why}", file=sys.stderr)
            return 1
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
