import json
import os
import platform
import stat
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

GITHUB_REPO = "gerp93/KVGrainy"
LATEST_RELEASE_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"

try:
    from _version import __version__ as CURRENT_VERSION
except ImportError:
    CURRENT_VERSION = "0.0.0-dev"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _parse_version(text: str) -> tuple[int, int, int]:
    core = text.strip().lstrip("v").split("-")[0]
    parts = []
    for piece in core.split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def _asset_name_for_platform() -> str:
    system = platform.system()
    if system == "Windows":
        return "KVGrainy-windows.exe"
    if system == "Darwin":
        return "KVGrainy-macos"
    return "KVGrainy-linux"


def check_for_update() -> dict | None:
    """Return {"version": str, "download_url": str} if a newer release is
    available, else None. Only ever returns non-None for a packaged build."""
    if not is_frozen() or CURRENT_VERSION == "0.0.0-dev":
        return None
    try:
        request = urllib.request.Request(
            LATEST_RELEASE_URL, headers={"Accept": "application/vnd.github+json"}
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.load(response)
    except Exception:
        return None

    latest_tag = data.get("tag_name", "")
    if _parse_version(latest_tag) <= _parse_version(CURRENT_VERSION):
        return None

    asset_name = _asset_name_for_platform()
    for asset in data.get("assets", []):
        if asset.get("name") == asset_name:
            return {"version": latest_tag.lstrip("v"), "download_url": asset["browser_download_url"]}
    return None


def download_update(download_url: str, progress_callback=None) -> Path:
    dest = Path(tempfile.mkdtemp(prefix="kvgrainy_update_")) / _asset_name_for_platform()
    request = urllib.request.Request(download_url, headers={"Accept": "application/octet-stream"})
    with urllib.request.urlopen(request, timeout=30) as response, open(dest, "wb") as out_file:
        total = int(response.headers.get("Content-Length", 0))
        read = 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            out_file.write(chunk)
            read += len(chunk)
            if progress_callback and total:
                progress_callback(read / total)

    if platform.system() != "Windows":
        current_mode = os.stat(dest).st_mode
        os.chmod(dest, current_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return dest


def apply_update_and_restart(new_binary_path: Path) -> None:
    """Replace the running executable with new_binary_path and relaunch.
    Never returns: exits (Windows) or execv's (macOS/Linux) the process."""
    current_exe = Path(sys.executable).resolve()

    if platform.system() == "Windows":
        script_path = new_binary_path.parent / "kvgrainy_update.bat"
        script_contents = (
            "@echo off\r\n"
            ":retry\r\n"
            f'del "{current_exe}" >nul 2>&1\r\n'
            f'if exist "{current_exe}" (\r\n'
            "  timeout /t 1 /nobreak >nul 2>&1\r\n"
            "  goto retry\r\n"
            ")\r\n"
            f'move /y "{new_binary_path}" "{current_exe}" >nul 2>&1\r\n'
            "timeout /t 2 /nobreak >nul 2>&1\r\n"
            f'explorer.exe "{current_exe}"\r\n'
            'del "%~f0"\r\n'
        )
        # write_bytes, not write_text: text mode would additionally
        # translate the \n in these \r\n literals into \r\n itself,
        # doubling every carriage return.
        script_path.write_bytes(script_contents.encode("ascii"))
        # Confirmed via a visible debug build: del/move/timeout all work
        # fine (move reports "1 file(s) moved." and the file is complete
        # and correctly placed on disk by the time we'd try to launch it),
        # but launching via `start` (CreateProcess, through cmd's builtin)
        # reliably failed to load python311.dll, while a manual
        # double-click of that exact file (ShellExecute, through Explorer)
        # always worked. explorer.exe here routes the relaunch through the
        # same shell code path the working manual case uses.
        subprocess.Popen(
            ["cmd", "/c", str(script_path)],
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        # sys.exit() raises SystemExit, which a Tkinter callback (this runs
        # from one, via root.after) silently swallows instead of letting it
        # terminate the process -- the batch script's wait-for-exit loop
        # would then spin forever. os._exit() kills the process outright.
        os._exit(0)
    else:
        import shutil

        shutil.move(str(new_binary_path), str(current_exe))
        os.execv(str(current_exe), [str(current_exe)] + sys.argv[1:])
