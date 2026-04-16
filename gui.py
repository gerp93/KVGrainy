import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from pathlib import Path
from threading import Thread
import sys
import io
import time
from kvgrainy import iter_images, parse_size_limit, optimize_image, SUPPORTED_EXTENSIONS


class KVGrainyGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("KVGrainy - Image Right Sizer")
        self.root.geometry("700x600")
        self.root.resizable(True, True)
        
        self.paths = []
        self.processing = False
        
        self.setup_ui()
    
    def setup_ui(self):
        # Title
        title = ttk.Label(self.root, text="KVGrainy Image Right Sizer", font=("Arial", 16, "bold"))
        title.pack(pady=10)
        
        # Subtitle
        subtitle = ttk.Label(self.root, text="Making Your Images More Grainy", font=("Arial", 10, "italic"))
        subtitle.pack(pady=(0, 15))
        
        # Input Paths Frame
        paths_frame = ttk.LabelFrame(self.root, text="Input Images", padding=10)
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
        limit_frame = ttk.LabelFrame(self.root, text="Settings", padding=10)
        limit_frame.pack(fill=tk.X, padx=10, pady=5)
        
        ttk.Label(limit_frame, text="Max Size per Image:").grid(row=0, column=0, sticky="w", pady=5)
        self.limit_entry = ttk.Entry(limit_frame, width=20)
        self.limit_entry.insert(0, "100kb")
        self.limit_entry.grid(row=0, column=1, sticky="w", padx=5)
        
        ttk.Label(limit_frame, text="Output Format:").grid(row=1, column=0, sticky="w", pady=5)
        self.format_var = tk.StringVar(value="auto")
        format_combo = ttk.Combobox(limit_frame, textvariable=self.format_var, 
                                    values=["auto", "jpeg", "png", "webp"], 
                                    state="readonly", width=17)
        format_combo.grid(row=1, column=1, sticky="w", padx=5)
        
        # Output Folder Frame
        output_frame = ttk.LabelFrame(self.root, text="Output Folder", padding=10)
        output_frame.pack(fill=tk.X, padx=10, pady=5)
        
        self.output_var = tk.StringVar(value="./reduced")
        output_entry = ttk.Entry(output_frame, textvariable=self.output_var, width=70)
        output_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 5))
        
        ttk.Button(output_frame, text="Browse", command=self.select_output).pack(side=tk.LEFT)
        
        # Progress Frame
        progress_frame = ttk.LabelFrame(self.root, text="Progress", padding=10)
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
        button_frame = ttk.Frame(self.root)
        button_frame.pack(fill=tk.X, padx=10, pady=10)
        
        self.process_btn = ttk.Button(button_frame, text="Process Images", command=self.start_processing)
        self.process_btn.pack(side=tk.LEFT, padx=5)
        
        ttk.Button(button_frame, text="Clear Log", command=self.clear_log).pack(side=tk.LEFT, padx=5)
        ttk.Button(button_frame, text="Exit", command=self.root.quit).pack(side=tk.RIGHT, padx=5)
    
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
