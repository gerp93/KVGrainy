import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from pathlib import Path
from threading import Thread
import os
import subprocess
import sys
import io
import time
from PIL import Image, ImageTk
from kvgrainy import (
    iter_images,
    parse_size_limit,
    optimize_image,
    SUPPORTED_EXTENSIONS,
    GifTuner,
)
from updater import CURRENT_VERSION, check_for_update, download_update, apply_update_and_restart
import theming

PRIORITY_LABELS = {
    "Prioritize dropping frames (keep colors & detail)": "frames",
    "Prioritize dropping colors (keep motion & detail)": "colors",
    "Prioritize shrinking resolution (keep colors & motion)": "resolution",
}


class KVGrainyGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("KVGrainy - Image Right Sizer")
        self.root.geometry("760x820")
        self.root.resizable(True, True)

        self.paths = []
        self.processing = False

        self.setup_ui()
        self.setup_menu()
        self.root.after(1500, lambda: self.check_for_updates(manual=False))

    def setup_menu(self):
        menubar = tk.Menu(self.root)

        self.theme_var = tk.StringVar(value="__default__")
        theme_menu = tk.Menu(menubar, tearoff=0)
        theme_menu.add_radiobutton(
            label=theming.DEFAULT_LABEL, variable=self.theme_var,
            value="__default__", command=lambda: self.on_theme_selected(None),
        )
        theme_menu.add_separator()
        for theme_id, name in theming.THEME_NAMES.items():
            theme_menu.add_radiobutton(
                label=name, variable=self.theme_var,
                value=theme_id, command=lambda tid=theme_id: self.on_theme_selected(tid),
            )
        menubar.add_cascade(label="Theme", menu=theme_menu)

        help_menu = tk.Menu(menubar, tearoff=0)
        help_menu.add_command(label="Check for Updates...", command=lambda: self.check_for_updates(manual=True))
        help_menu.add_separator()
        help_menu.add_command(label=f"Version {CURRENT_VERSION}", state=tk.DISABLED)
        menubar.add_cascade(label="Help", menu=help_menu)

        self.root.config(menu=menubar)
        theming.capture_defaults(self.root)

    def on_theme_selected(self, theme_id):
        theming.apply_theme(self.root, theme_id)

    def check_for_updates(self, manual: bool):
        Thread(target=self._check_for_updates_worker, args=(manual,), daemon=True).start()

    def _check_for_updates_worker(self, manual: bool):
        update = check_for_update()

        def show():
            if update:
                self.prompt_update(update)
            elif manual:
                messagebox.showinfo("Up to Date", f"You're running the latest version ({CURRENT_VERSION}).")

        self.root.after(0, show)

    def prompt_update(self, update):
        if not messagebox.askyesno(
            "Update Available",
            f"Version {update['version']} is available (you have {CURRENT_VERSION}).\n\n"
            "Download and install it now? KVGrainy will restart automatically.",
        ):
            return
        Thread(target=self._download_and_apply_update, args=(update,), daemon=True).start()

    def _download_and_apply_update(self, update):
        try:
            new_binary = download_update(update["download_url"])
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Update Failed", f"Could not download update: {e}"))
            return
        self.root.after(0, lambda: self._finish_update(new_binary))

    def _finish_update(self, new_binary):
        messagebox.showinfo("Restarting", "KVGrainy will now restart to complete the update.")
        apply_update_and_restart(new_binary)

    def setup_ui(self):
        notebook = ttk.Notebook(self.root)
        notebook.pack(fill=tk.BOTH, expand=True)

        bulk_tab = ttk.Frame(notebook)
        finetune_tab = ttk.Frame(notebook)
        notebook.add(bulk_tab, text="Bulk Optimize")
        notebook.add(finetune_tab, text="Fine-Tune GIF")

        self.setup_bulk_tab(bulk_tab)
        self.setup_finetune_tab(finetune_tab)

    def setup_bulk_tab(self, root):
        # Title
        title = ttk.Label(root, text="KVGrainy Image Right Sizer", font=("Arial", 16, "bold"))
        title.pack(pady=10)

        # Subtitle
        subtitle = ttk.Label(root, text="Making Your Images More Grainy", font=("Arial", 10, "italic"))
        subtitle.pack(pady=(0, 15))

        # Input Paths Frame
        paths_frame = ttk.LabelFrame(root, text="Input Images", padding=10)
        paths_frame.pack(fill=tk.X, padx=10, pady=5)
        
        self.paths_display = tk.Text(paths_frame, height=3, width=60, wrap=tk.WORD)
        self.paths_display.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 5))
        
        paths_scrollbar = ttk.Scrollbar(paths_frame, orient=tk.VERTICAL, command=self.paths_display.yview)
        paths_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.paths_display.config(yscrollcommand=paths_scrollbar.set)
        
        button_frame = ttk.Frame(paths_frame)
        button_frame.pack(fill=tk.X, pady=5)
        
        ttk.Button(button_frame, text="Add File", command=self.add_file).pack(side=tk.LEFT, padx=2)
        ttk.Button(button_frame, text="Add Folder", command=self.add_folder).pack(side=tk.LEFT, padx=2)
        ttk.Button(button_frame, text="Clear", command=self.clear_paths).pack(side=tk.LEFT, padx=2)
        
        # Size Limit Frame
        limit_frame = ttk.LabelFrame(root, text="Settings", padding=10)
        limit_frame.pack(fill=tk.X, padx=10, pady=5)
        
        ttk.Label(limit_frame, text="Max Size per Image:").grid(row=0, column=0, sticky="w", pady=5)
        self.limit_entry = ttk.Entry(limit_frame, width=20)
        self.limit_entry.insert(0, "100kb")
        self.limit_entry.grid(row=0, column=1, sticky="w", padx=5)
        
        ttk.Label(limit_frame, text="Output Format:").grid(row=1, column=0, sticky="w", pady=5)
        self.format_var = tk.StringVar(value="auto")
        format_combo = ttk.Combobox(limit_frame, textvariable=self.format_var, 
                                    values=["auto", "jpeg", "png", "webp", "gif"],
                                    state="readonly", width=17)
        format_combo.grid(row=1, column=1, sticky="w", padx=5)
        
        # Output Folder Frame
        output_frame = ttk.LabelFrame(root, text="Output Folder", padding=10)
        output_frame.pack(fill=tk.X, padx=10, pady=5)
        
        self.output_var = tk.StringVar(value="./reduced")
        output_entry = ttk.Entry(output_frame, textvariable=self.output_var, width=70)
        output_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        
        ttk.Button(output_frame, text="Browse", command=self.select_output).pack(side=tk.LEFT)
        ttk.Button(output_frame, text="Open Folder", command=self.open_output_folder).pack(side=tk.LEFT, padx=(5, 0))
        
        # Progress Frame
        progress_frame = ttk.LabelFrame(root, text="Progress", padding=10)
        progress_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        
        # Progress bar
        self.progress_var = tk.DoubleVar()
        self.progress_bar = ttk.Progressbar(progress_frame, orient=tk.HORIZONTAL, 
                                           variable=self.progress_var, maximum=100)
        self.progress_bar.pack(fill=tk.X, pady=(0, 5))
        
        # Progress label
        self.progress_label = ttk.Label(progress_frame, text="Ready", font=("Arial", 9))
        self.progress_label.pack(fill=tk.X, pady=(0, 5))
        
        # Log text
        text_frame = ttk.Frame(progress_frame)
        text_frame.pack(fill=tk.BOTH, expand=True)
        
        self.progress_text = tk.Text(text_frame, height=10, width=80, wrap=tk.WORD, state=tk.DISABLED)
        self.progress_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 5))
        
        progress_scrollbar = ttk.Scrollbar(text_frame, orient=tk.VERTICAL, command=self.progress_text.yview)
        progress_scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.progress_text.config(yscrollcommand=progress_scrollbar.set)
        
        # Button Frame
        button_frame = ttk.Frame(root)
        button_frame.pack(fill=tk.X, padx=10, pady=10)

        self.process_btn = ttk.Button(button_frame, text="Process Images", command=self.start_processing)
        self.process_btn.pack(side=tk.LEFT, padx=5)

        ttk.Button(button_frame, text="Clear Log", command=self.clear_log).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Exit", command=self.root.quit).pack(side=tk.RIGHT, padx=5)

    def setup_finetune_tab(self, root):
        self.tuner = None
        self.tuner_path = None
        self.tuner_payload = None
        self.tuner_priority = "frames"
        self.tuner_debounce_job = None
        self.tuner_anim_job = None
        self.tuner_anim_frames = []
        self.tuner_max_feasible = 0
        self.tuner_ladder_len = 1
        self.tuner_limit_bytes = 0

        # File selection
        file_frame = ttk.LabelFrame(root, text="GIF File", padding=10)
        file_frame.pack(fill=tk.X, padx=10, pady=5)

        self.tuner_file_var = tk.StringVar(value="No file selected")
        ttk.Label(file_frame, textvariable=self.tuner_file_var).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(file_frame, text="Open GIF", command=self.tuner_open_file).pack(side=tk.RIGHT)

        # Controls
        controls_frame = ttk.LabelFrame(root, text="Controls", padding=10)
        controls_frame.pack(fill=tk.X, padx=10, pady=5)

        ttk.Label(controls_frame, text="Max Size:").grid(row=0, column=0, sticky="w", pady=5)
        limit_row = ttk.Frame(controls_frame)
        limit_row.grid(row=0, column=1, sticky="w", padx=5)

        self.tuner_limit_value_var = tk.StringVar(value="300")
        self.tuner_limit_unit_var = tk.StringVar(value="kb")
        self.tuner_last_applied_limit = (self.tuner_limit_value_var.get(), self.tuner_limit_unit_var.get())
        self.tuner_limit_value_var.trace_add("write", lambda *a: self.tuner_update_set_button_state())
        self.tuner_limit_unit_var.trace_add("write", lambda *a: self.tuner_update_set_button_state())

        limit_entry = ttk.Entry(limit_row, textvariable=self.tuner_limit_value_var, width=10)
        limit_entry.pack(side=tk.LEFT)
        limit_entry.bind("<Return>", lambda e: self.tuner_on_limit_change())

        ttk.Radiobutton(limit_row, text="KB", variable=self.tuner_limit_unit_var, value="kb").pack(side=tk.LEFT, padx=(8, 0))
        ttk.Radiobutton(limit_row, text="MB", variable=self.tuner_limit_unit_var, value="mb").pack(side=tk.LEFT, padx=(4, 0))

        self.tuner_set_btn = ttk.Button(limit_row, text="Set", command=self.tuner_on_limit_change, state=tk.DISABLED)
        self.tuner_set_btn.pack(side=tk.LEFT, padx=(8, 0))

        ttk.Label(controls_frame, text="Priority:").grid(row=1, column=0, sticky="w", pady=5)
        self.tuner_priority_var = tk.StringVar(value=next(iter(PRIORITY_LABELS)))
        priority_combo = ttk.Combobox(
            controls_frame, textvariable=self.tuner_priority_var,
            values=list(PRIORITY_LABELS.keys()), state="readonly", width=45,
        )
        priority_combo.grid(row=1, column=1, sticky="w", padx=5)
        priority_combo.bind("<<ComboboxSelected>>", lambda e: self.tuner_on_priority_change())

        ttk.Label(controls_frame, text="Quality:").grid(row=2, column=0, sticky="w", pady=5)
        self.tuner_quality_var = tk.DoubleVar(value=100)
        quality_slider = ttk.Scale(
            controls_frame, from_=0, to=100, variable=self.tuner_quality_var,
            orient=tk.HORIZONTAL, length=300, command=self.tuner_on_slider_move,
        )
        quality_slider.grid(row=2, column=1, sticky="ew", padx=5)

        slider_labels_frame = ttk.Frame(controls_frame)
        slider_labels_frame.grid(row=3, column=1, sticky="ew", padx=5)
        ttk.Label(slider_labels_frame, text="More compressed", font=("Arial", 8)).pack(side=tk.LEFT)
        self.tuner_max_label_var = tk.StringVar(value="Max (best that fits limit)")
        ttk.Label(slider_labels_frame, textvariable=self.tuner_max_label_var, font=("Arial", 8)).pack(side=tk.RIGHT)

        controls_frame.columnconfigure(1, weight=1)

        # Preview + info
        preview_frame = ttk.LabelFrame(root, text="Preview", padding=10)
        preview_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.tuner_preview_label = ttk.Label(preview_frame, text="Open a GIF to preview it here")
        self.tuner_preview_label.pack(pady=10)

        self.tuner_info_var = tk.StringVar(value="")
        ttk.Label(preview_frame, textvariable=self.tuner_info_var, font=("Arial", 9)).pack(pady=5)

        # Save
        save_frame = ttk.Frame(root)
        save_frame.pack(fill=tk.X, padx=10, pady=10)
        self.tuner_save_btn = ttk.Button(save_frame, text="Save As...", command=self.tuner_save, state=tk.DISABLED)
        self.tuner_save_btn.pack(side=tk.LEFT, padx=5)

        # Busy overlay (hidden until tuner_show_busy is called)
        self.tuner_busy_count = 0
        self.tuner_busy_overlay = ttk.Frame(root, relief=tk.RIDGE, borderwidth=1)
        busy_inner = ttk.Frame(self.tuner_busy_overlay, padding=20)
        busy_inner.pack(expand=True)
        self.tuner_busy_bar = ttk.Progressbar(busy_inner, mode="indeterminate", length=200)
        self.tuner_busy_bar.pack(pady=(0, 8))
        ttk.Label(busy_inner, text="Recalculating...").pack()

    def tuner_show_busy(self):
        self.tuner_busy_count += 1
        if self.tuner_busy_count == 1:
            self.tuner_busy_overlay.place(relx=0.5, rely=0.5, anchor="center")
            self.tuner_busy_overlay.lift()
            self.tuner_busy_bar.start(10)

    def tuner_hide_busy(self):
        self.tuner_busy_count = max(0, self.tuner_busy_count - 1)
        if self.tuner_busy_count == 0:
            self.tuner_busy_bar.stop()
            self.tuner_busy_overlay.place_forget()

    def tuner_open_file(self):
        file = filedialog.askopenfilename(title="Select GIF File", filetypes=[("GIF Files", "*.gif")])
        if not file:
            return
        try:
            self.tuner = GifTuner(Path(file))
        except Exception as e:
            messagebox.showerror("Error", f"Could not open GIF: {e}")
            return
        self.tuner_path = Path(file)
        self.tuner_file_var.set(f"{self.tuner_path.name}  ({self.tuner.frame_count} frames, {self.tuner.original_size[0]}x{self.tuner.original_size[1]})")
        self.tuner_quality_var.set(100)
        self.tuner_save_btn.config(state=tk.NORMAL)
        self.tuner_recompute_bounds()

    def tuner_on_priority_change(self):
        self.tuner_priority = PRIORITY_LABELS[self.tuner_priority_var.get()]
        self.tuner_recompute_bounds()

    def tuner_on_limit_change(self):
        self.tuner_last_applied_limit = (self.tuner_limit_value_var.get(), self.tuner_limit_unit_var.get())
        self.tuner_update_set_button_state()
        self.tuner_recompute_bounds()

    def tuner_update_set_button_state(self):
        current = (self.tuner_limit_value_var.get(), self.tuner_limit_unit_var.get())
        changed = current != self.tuner_last_applied_limit
        self.tuner_set_btn.config(state=tk.NORMAL if changed else tk.DISABLED)

    def tuner_on_slider_move(self, _value):
        if self.tuner_debounce_job is not None:
            self.root.after_cancel(self.tuner_debounce_job)
        self.tuner_debounce_job = self.root.after(200, self.tuner_refresh_preview)

    def tuner_recompute_bounds(self):
        """Find the best (index 0) config that still fits the size limit; the
        slider's far-right position always maps to this, whatever it is."""
        if not self.tuner:
            return
        try:
            limit_bytes = parse_size_limit(f"{self.tuner_limit_value_var.get()}{self.tuner_limit_unit_var.get()}")
        except ValueError as e:
            self.tuner_info_var.set(f"Invalid size limit: {e}")
            return

        priority = self.tuner_priority
        ladder = self.tuner.ladder(priority)

        self.tuner_show_busy()

        def work():
            max_feasible = self.tuner.max_feasible_index(priority, limit_bytes)

            def apply():
                self.tuner_max_feasible = max_feasible
                self.tuner_ladder_len = len(ladder)
                self.tuner_limit_bytes = limit_bytes
                self.tuner_max_label_var.set(
                    "Max = original quality" if max_feasible == 0 else "Max (best that fits limit)"
                )
                self.tuner_hide_busy()
                self.tuner_refresh_preview()

            self.root.after(0, apply)

        Thread(target=work, daemon=True).start()

    def tuner_refresh_preview(self):
        self.tuner_debounce_job = None
        if not self.tuner:
            return

        priority = self.tuner_priority
        ladder = self.tuner.ladder(priority)
        max_feasible = self.tuner_max_feasible
        span = max(1, self.tuner_ladder_len - 1 - max_feasible)
        desired_percent = self.tuner_quality_var.get()
        effective_index = max_feasible + round((100 - desired_percent) / 100 * span)
        limit_bytes = self.tuner_limit_bytes

        self.tuner_show_busy()

        def work():
            payload = self.tuner.encode(priority, effective_index)
            self.root.after(0, lambda: self.tuner_apply_result(payload, ladder[effective_index], limit_bytes))

        Thread(target=work, daemon=True).start()

    def tuner_apply_result(self, payload, config, limit_bytes):
        self.tuner_hide_busy()
        self.tuner_payload = payload

        fps = 1000 / (self.tuner.durations[0] * config.frame_step) if self.tuner.durations[0] else 0
        self.tuner_info_var.set(
            f"{len(payload) / 1024:.1f}KB / {limit_bytes / 1024:.1f}KB limit  |  "
            f"scale={config.scale:.2f}  colors={config.colors}  "
            f"frame step={config.frame_step} (~{fps:.1f}fps)"
        )
        self.tuner_start_preview(payload)

    def tuner_start_preview(self, payload):
        if self.tuner_anim_job is not None:
            self.root.after_cancel(self.tuner_anim_job)
            self.tuner_anim_job = None

        gif = Image.open(io.BytesIO(payload))
        frames = []
        try:
            for idx in range(gif.n_frames):
                gif.seek(idx)
                duration = gif.info.get("duration", 100)
                frame = ImageTk.PhotoImage(gif.convert("RGBA"))
                frames.append((frame, duration))
        except EOFError:
            pass
        self.tuner_anim_frames = frames
        self._tuner_animate(0)

    def _tuner_animate(self, index):
        if not self.tuner_anim_frames:
            return
        index %= len(self.tuner_anim_frames)
        frame, duration = self.tuner_anim_frames[index]
        self.tuner_preview_label.config(image=frame, text="")
        self.tuner_preview_label.image = frame
        self.tuner_anim_job = self.root.after(max(20, duration), lambda: self._tuner_animate(index + 1))

    def tuner_save(self):
        if not self.tuner_payload or not self.tuner_path:
            return
        file = filedialog.asksaveasfilename(
            title="Save Optimized GIF", defaultextension=".gif",
            initialfile=f"{self.tuner_path.stem}_finetuned.gif",
            filetypes=[("GIF Files", "*.gif")],
        )
        if not file:
            return
        Path(file).write_bytes(self.tuner_payload)
        messagebox.showinfo("Saved", f"Saved to {file}")

    def add_file(self):
        file = filedialog.askopenfilename(
            title="Select Image File",
            filetypes=[("Image Files", " ".join(f"*{ext}" for ext in SUPPORTED_EXTENSIONS)), ("All Files", "*.*")]
        )
        if file:
            self.paths.append(file)
            self.update_paths_display()
    
    def add_folder(self):
        folder = filedialog.askdirectory(title="Select Folder")
        if folder:
            self.paths.append(folder)
            self.update_paths_display()
    
    def clear_paths(self):
        self.paths.clear()
        self.update_paths_display()
    
    def update_paths_display(self):
        self.paths_display.config(state=tk.NORMAL)
        self.paths_display.delete(1.0, tk.END)
        self.paths_display.insert(tk.END, "\n".join(self.paths))
        self.paths_display.config(state=tk.DISABLED)
    
    def select_output(self):
        folder = filedialog.askdirectory(title="Select Output Folder")
        if folder:
            self.output_var.set(folder)

    def open_output_folder(self):
        folder = Path(self.output_var.get()).expanduser().resolve()
        folder.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            os.startfile(folder)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])


    def log(self, message):
        self.progress_text.config(state=tk.NORMAL)
        self.progress_text.insert(tk.END, message + "\n")
        self.progress_text.see(tk.END)
        self.progress_text.config(state=tk.DISABLED)
        self.root.update()
    
    def clear_log(self):
        self.progress_text.config(state=tk.NORMAL)
        self.progress_text.delete(1.0, tk.END)
        self.progress_text.config(state=tk.DISABLED)
    
    def start_processing(self):
        if not self.paths:
            messagebox.showerror("Error", "Please select at least one image file or folder")
            return
        
        try:
            parse_size_limit(self.limit_entry.get())
        except ValueError as e:
            messagebox.showerror("Error", f"Invalid size limit: {e}")
            return
        
        self.process_btn.config(state=tk.DISABLED)
        thread = Thread(target=self.process_images)
        thread.daemon = True
        thread.start()
    
    def process_images(self):
        try:
            self.clear_log()
            start_time = time.time()
            
            self.log("=" * 70)
            self.log("🚀 Starting image processing...")
            self.log("=" * 70)
            
            limit_bytes = parse_size_limit(self.limit_entry.get())
            fmt = self.format_var.get()
            fmt = fmt if fmt != "auto" else None
            output_dir = Path(self.output_var.get()).expanduser().resolve()
            output_dir.mkdir(parents=True, exist_ok=True)
            
            image_files = iter_images(self.paths)
            if not image_files:
                self.log("❌ ERROR: No supported images found in provided paths")
                messagebox.showerror("Error", "No supported images found")
                self.process_btn.config(state=tk.NORMAL)
                return
            
            total = len(image_files)
            if fmt:
                self.log(f"📊 Processing {total} image(s) with limit {limit_bytes / 1024:.1f}KB (format: {fmt.upper()})")
            else:
                self.log(f"📊 Processing {total} image(s) with limit {limit_bytes / 1024:.1f}KB")
            self.log("")
            
            for i, image in enumerate(image_files, 1):
                try:
                    # Update progress bar
                    progress = (i - 1) / total * 100
                    self.progress_var.set(progress)
                    self.progress_label.config(text=f"Processing {i}/{total}: {image.name}")
                    self.root.update()
                    
                    optimize_image(image, limit_bytes, output_dir, fmt)
                    
                except Exception as e:
                    self.log(f"   ⚠️  {image.name}: ERROR - {e}")
            
            # Final progress update
            self.progress_var.set(100)
            elapsed = time.time() - start_time
            
            self.log("")
            self.log("=" * 70)
            self.log(f"✅ All {total} image(s) processed successfully!")
            self.log(f"⏱️  Time elapsed: {elapsed:.1f}s")
            self.log(f"📁 Output folder: {output_dir}")
            self.log("=" * 70)
            
            self.progress_label.config(text=f"✓ Complete! Processed {total} image(s) in {elapsed:.1f}s")
            messagebox.showinfo("Success", f"✓ Processed {total} image(s)\n⏱️ Time: {elapsed:.1f}s\n\nOutput: {output_dir}")
            
        except Exception as e:
            self.log(f"❌ FATAL ERROR: {e}")
            messagebox.showerror("Error", f"Processing failed: {e}")
        finally:
            self.process_btn.config(state=tk.NORMAL)


if __name__ == "__main__":
    root = tk.Tk()
    app = KVGrainyGUI(root)
    root.mainloop()
