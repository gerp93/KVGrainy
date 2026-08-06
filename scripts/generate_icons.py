"""One-off icon generation from assets/logo.png. Run with:
    python scripts/generate_icons.py
after replacing assets/logo.png with a new source mark.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "logo.png"


def main():
    src = Image.open(SRC).convert("RGBA")

    # Pad to a square canvas using a transparent background so a non-square
    # source doesn't get cropped or distorted.
    side = max(src.size)
    squared = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    squared.paste(src, ((side - src.width) // 2, (side - src.height) // 2), src)

    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)

    # Tkinter window/taskbar icon (root.iconphoto) and in-app usage.
    squared.resize((256, 256), Image.LANCZOS).save(assets / "icon.png")

    # PyInstaller --icon on Windows: embeds into the .exe shown in Explorer/taskbar.
    squared.resize((256, 256), Image.LANCZOS).save(
        assets / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)]
    )

    # PyInstaller --icon on macOS.
    squared.resize((1024, 1024), Image.LANCZOS).save(assets / "icon.icns")

    print("Icons generated.")


if __name__ == "__main__":
    main()
