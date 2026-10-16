# Security policy

## Reporting a vulnerability

Please report it **privately**, not in a public issue:
[open a security advisory](https://github.com/gerp93/KVGrainy/security/advisories/new).

Include what you found, how to reproduce it, and which part is affected (the website, the desktop app, or the
command line). KVGrainy is maintained by one person, so replies are best-effort; expect an acknowledgement within a
few days rather than a guaranteed turnaround.

## What is in scope

- The web tool (the static site) and the desktop app, including its self-update check.
- Anything that would make an image leave the user's device. The privacy claim, "nothing is uploaded", is enforced by
  an automated test (`web/e2e/privacy.spec.ts`); a way around it is a security bug.
- The release pipeline and the installers it publishes.

## Supported versions

Only the latest release and `main` receive fixes.

## Known limits

Desktop installers are currently unsigned, so Windows SmartScreen and macOS Gatekeeper warn on install, and the in-app
updater verifies a SHA-256 from the same GitHub release as the file it downloads (it detects a damaged download, not a
compromised release). See `docs/release.md`.
