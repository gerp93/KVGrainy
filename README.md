# KVGrainy

KVGrainy is a local-first image optimizer that automatically reduces images to the
largest possible file size under a limit while keeping them visually strong.

## Features

- Process one or many image files at once
- Accept size limits like `500kb`, `1.5mb`, or raw bytes
- Automatically choose format, scale, and quality per image
- Prioritize visual quality and size utilization under your limit
- Run fully on your PC (no cloud required)

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python kvgrainy.py --limit 400kb --output ./reduced ./images
```

If you omit arguments, KVGrainy starts an interactive prompt ("chat-like" flow)
to ask for paths and limits.

## CLI

```bash
python kvgrainy.py [paths ...] --limit 750kb --output ./reduced
```

- `paths`: files and/or folders (folders are scanned recursively)
- `--limit`: max output size for each image
- `--output`: destination directory for optimized images
