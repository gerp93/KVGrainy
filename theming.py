"""Applies VisualAssault (https://github.com/gerp93/VisualAssault) color
themes to the KVGrainy Tkinter/ttk UI."""
import tkinter as tk
from tkinter import ttk

from visual_assault_tkinter import THEMES

THEME_NAMES = {theme_id: data["name"] for theme_id, data in THEMES.items()}
DEFAULT_LABEL = "System Default"

_defaults = {"ttk_theme": None, "root_background": None, "widgets": []}


def _walk(widget):
    yield widget
    for child in widget.winfo_children():
        yield from _walk(child)


def capture_defaults(root: tk.Misc) -> None:
    """Snapshot the native look before any theme is applied, so 'System
    Default' can restore it exactly. Call once, after the full UI (including
    all menus) has been built."""
    style = ttk.Style(root)
    _defaults["ttk_theme"] = style.theme_use()
    _defaults["root_background"] = root.cget("background")

    widgets = []
    for widget in _walk(root):
        if isinstance(widget, tk.Text):
            widgets.append((widget, {
                "background": widget.cget("background"),
                "foreground": widget.cget("foreground"),
                "insertbackground": widget.cget("insertbackground"),
            }))
        elif isinstance(widget, tk.Menu):
            widgets.append((widget, {
                "background": widget.cget("background"),
                "foreground": widget.cget("foreground"),
                "activebackground": widget.cget("activebackground"),
                "activeforeground": widget.cget("activeforeground"),
            }))
    _defaults["widgets"] = widgets


def apply_theme(root: tk.Misc, theme_id: str | None) -> None:
    """Apply a VisualAssault theme by id, or pass None to restore the
    defaults captured by capture_defaults()."""
    style = ttk.Style(root)

    if theme_id is None:
        style.theme_use(_defaults["ttk_theme"])
        root.configure(background=_defaults["root_background"])
        for widget, values in _defaults["widgets"]:
            widget.configure(**values)
        return

    theme = THEMES[theme_id]
    style.theme_use("clam")

    style.configure("TFrame", background=theme["background"])
    style.configure("TLabelframe", background=theme["background"], bordercolor=theme["border"])
    style.configure("TLabelframe.Label", background=theme["background"], foreground=theme["foreground"])
    style.configure("TLabel", background=theme["background"], foreground=theme["foreground"])
    style.configure(
        "TButton",
        background=theme["buttonBackground"],
        foreground=theme["foreground"],
        bordercolor=theme["border"],
        focuscolor=theme["accentBlue"],
    )
    style.map(
        "TButton",
        background=[("disabled", theme["surface"]), ("active", theme["buttonHover"])],
        foreground=[("disabled", theme["textMuted"])],
    )
    style.configure(
        "TEntry",
        fieldbackground=theme["surface"],
        foreground=theme["foreground"],
        bordercolor=theme["border"],
        insertcolor=theme["foreground"],
    )
    style.configure(
        "TCombobox",
        fieldbackground=theme["surface"],
        background=theme["buttonBackground"],
        foreground=theme["foreground"],
        arrowcolor=theme["foreground"],
    )
    style.map(
        "TCombobox",
        fieldbackground=[("readonly", theme["surface"])],
        foreground=[("readonly", theme["foreground"])],
    )
    style.configure("TRadiobutton", background=theme["background"], foreground=theme["foreground"])
    style.map("TRadiobutton", background=[("active", theme["backgroundHover"])])
    style.configure("TNotebook", background=theme["background"], bordercolor=theme["border"])
    style.configure(
        "TNotebook.Tab",
        background=theme["buttonBackground"],
        foreground=theme["foreground"],
        padding=(10, 4),
    )
    style.map(
        "TNotebook.Tab",
        background=[("selected", theme["topBarBackground"])],
        foreground=[("selected", theme["foreground"])],
    )
    style.configure("TProgressbar", background=theme["accentBlue"], troughcolor=theme["surface"], bordercolor=theme["border"])
    style.configure("TScale", background=theme["background"], troughcolor=theme["surface"])
    style.configure(
        "TScrollbar",
        background=theme["buttonBackground"],
        troughcolor=theme["surface"],
        arrowcolor=theme["foreground"],
        bordercolor=theme["border"],
    )

    root.configure(background=theme["background"])

    for widget, _ in _defaults["widgets"]:
        if isinstance(widget, tk.Text):
            widget.configure(background=theme["surface"], foreground=theme["foreground"], insertbackground=theme["foreground"])
        elif isinstance(widget, tk.Menu):
            widget.configure(
                background=theme["surface"],
                foreground=theme["foreground"],
                activebackground=theme["buttonHover"],
                activeforeground=theme["foreground"],
            )
