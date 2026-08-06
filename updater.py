"""Thin app-specific wrapper around kvg_updater (see KVG_Standards).

KVGrainy's own update-check/self-replace logic was extracted into
kvg_updater verbatim to become the shared standard; this wrapper just
supplies KVGrainy's repo/app name/version and keeps gui.py's existing
zero-arg call sites (check_for_update(), download_update(url),
apply_update_and_restart(path)) working unchanged.
"""
from pathlib import Path
from typing import Callable, Optional

from kvg_updater import (
    apply_update_and_restart as _apply_update_and_restart,
    check_for_update as _check_for_update,
    download_update as _download_update,
)

GITHUB_REPO = "gerp93/KVGrainy"
APP_NAME = "KVGrainy"

try:
    from _version import __version__ as CURRENT_VERSION
except ImportError:
    CURRENT_VERSION = "0.0.0-dev"


def check_for_update() -> Optional[dict]:
    return _check_for_update(GITHUB_REPO, APP_NAME, CURRENT_VERSION)


def download_update(download_url: str, progress_callback: Optional[Callable[[float], None]] = None) -> Path:
    return _download_update(download_url, APP_NAME, progress_callback)


def apply_update_and_restart(new_binary_path: Path) -> None:
    _apply_update_and_restart(new_binary_path, APP_NAME)
