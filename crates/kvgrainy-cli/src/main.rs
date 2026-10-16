use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use kvgrainy_core::animated::{best_effort_gif, load_animation, optimize_gif, AnimationError, GifOptions};
use kvgrainy_core::{best_effort, load::load_image, optimize, parse_size_limit, Effort, Error, Format, Options};

const IMAGE_EXTENSIONS: [&str; 8] = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"];

/// Reduce images to fit under a size limit with the best quality possible.
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Image files and/or folders
    paths: Vec<PathBuf>,
    /// Max output size per image (e.g. 500kb, 1.5mb)
    #[arg(long)]
    limit: String,
    /// Output directory
    #[arg(long, default_value = "./reduced")]
    output: PathBuf,
    /// Force an output format (jpeg, png, webp, avif); default picks the best
    #[arg(long)]
    format: Option<String>,
    /// Skip AVIF, the slowest codec: several times faster, usually slightly larger output
    #[arg(long)]
    quick: bool,
}

fn collect(paths: &[PathBuf]) -> Vec<PathBuf> {
    fn is_image(p: &Path) -> bool {
        p.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.to_lowercase().as_str()))
    }
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else if is_image(&path) {
                    out.push(path);
                }
            }
        }
    }
    let mut files = Vec::new();
    for path in paths {
        if path.is_dir() {
            walk(path, &mut files);
        } else if path.is_file() && is_image(path) {
            files.push(path.clone());
        }
    }
    files.sort();
    files.dedup();
    files
}

/// Animated GIF, WebP and PNG files are fitted as GIFs. `None` means the file is a still, for the normal path.
fn try_animation(file: &Path, limit: u64, output: &Path) -> Option<bool> {
    let name = file.file_name().unwrap_or_default().to_string_lossy().to_string();
    let bytes = std::fs::read(file).ok()?;
    let animation = match load_animation(&bytes) {
        Err(AnimationError::NotAnimated) => return None,
        Err(why) => {
            eprintln!("[fail] {name}: {why}");
            return Some(false);
        }
        Ok(animation) => animation,
    };
    let stem = file.file_stem().unwrap_or_default().to_string_lossy();
    let out = output.join(format!("{stem}_optimized.gif"));
    let write = |bytes: &[u8]| std::fs::write(&out, bytes);
    match optimize_gif(&animation, &GifOptions { limit_bytes: limit, cancel: None }, &|_| {}) {
        Ok(best) => {
            if let Err(why) = write(&best.bytes) {
                eprintln!("[fail] {name}: cannot write {}: {why}", out.display());
                return Some(false);
            }
            println!(
                "[done] {name} -> {} | {:.1}KB | fmt=Gif quality={} scale={:.2} frame-step={} score={:.3}",
                out.file_name().unwrap_or_default().to_string_lossy(),
                best.bytes.len() as f64 / 1024.0,
                best.settings.quality,
                best.settings.scale,
                best.settings.frame_step,
                best.score
            );
            Some(true)
        }
        Err(why @ AnimationError::NothingFits { .. }) => {
            match best_effort_gif(&animation).and_then(|fallback| write(&fallback.bytes).map(|()| fallback.bytes.len()).map_err(|e| AnimationError::Encode(e.to_string()))) {
                Ok(size) => eprintln!("[over limit] {name}: {why}. Wrote the smallest possible instead: {} ({:.1}KB)", out.file_name().unwrap_or_default().to_string_lossy(), size as f64 / 1024.0),
                Err(_) => eprintln!("[fail] {name}: {why}"),
            }
            Some(false)
        }
        Err(why) => {
            eprintln!("[fail] {name}: {why}");
            Some(false)
        }
    }
}

fn main() -> ExitCode {
    let args = Args::parse();
    let limit = match parse_size_limit(&args.limit) {
        Ok(limit) => limit,
        Err(why) => {
            eprintln!("error: {why}");
            return ExitCode::from(2);
        }
    };
    let format = match args.format.as_deref().map(Format::parse) {
        Some(None) => {
            eprintln!("error: unsupported format (use jpeg, png, webp or avif)");
            return ExitCode::from(2);
        }
        Some(parsed) => parsed,
        None => None,
    };
    let files = collect(&args.paths);
    if files.is_empty() {
        eprintln!("error: no supported images found");
        return ExitCode::from(2);
    }
    if let Err(why) = std::fs::create_dir_all(&args.output) {
        eprintln!("error: cannot create {}: {why}", args.output.display());
        return ExitCode::from(1);
    }

    let mut failures = 0;
    for file in &files {
        let name = file.file_name().unwrap_or_default().to_string_lossy();
        if matches!(file.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(), Some("gif" | "webp" | "png")) {
            if let Some(succeeded) = try_animation(file, limit, &args.output) {
                if !succeeded {
                    failures += 1;
                }
                continue;
            }
        }
        let loaded = match load_image(file) {
            Ok(loaded) => loaded,
            Err(why) => {
                eprintln!("[fail] {name}: {why}");
                failures += 1;
                continue;
            }
        };
        for warning in &loaded.warnings {
            eprintln!("[warn] {name}: {warning}");
        }
        let effort = if args.quick { Effort::Quick } else { Effort::Best };
        let options = Options { format, effort, ..Options::new(limit) };
        match optimize(&loaded.raster, &options, &|_| {}) {
            Ok(best) => {
                let stem = file.file_stem().unwrap_or_default().to_string_lossy();
                let out = args.output.join(format!("{stem}_optimized.{}", best.format.extension()));
                if let Err(why) = std::fs::write(&out, &best.bytes) {
                    eprintln!("[fail] {name}: cannot write {}: {why}", out.display());
                    failures += 1;
                    continue;
                }
                println!(
                    "[done] {name} -> {} | {:.1}KB | fmt={:?} quality={:?} scale={:.2} score={:.3}",
                    out.file_name().unwrap_or_default().to_string_lossy(),
                    best.bytes.len() as f64 / 1024.0,
                    best.format,
                    best.quality,
                    best.scale,
                    best.score
                );
            }
            Err(why @ Error::NothingFits { .. }) => {
                // Never leave the user with nothing: write the smallest output we can make, clearly marked over the limit.
                match best_effort(&loaded.raster, &options) {
                    Some(best) => {
                        let stem = file.file_stem().unwrap_or_default().to_string_lossy();
                        let out = args.output.join(format!("{stem}_optimized.{}", best.format.extension()));
                        match std::fs::write(&out, &best.bytes) {
                            Ok(()) => eprintln!(
                                "[over limit] {name}: {why}. Wrote the smallest possible instead: {} ({:.1}KB)",
                                out.file_name().unwrap_or_default().to_string_lossy(),
                                best.bytes.len() as f64 / 1024.0
                            ),
                            Err(e) => eprintln!("[fail] {name}: {why}; cannot write {}: {e}", out.display()),
                        }
                    }
                    None => eprintln!("[fail] {name}: {why}"),
                }
                failures += 1;
            }
            Err(why) => {
                eprintln!("[fail] {name}: {why}");
                failures += 1;
            }
        }
    }
    if failures == 0 { ExitCode::SUCCESS } else { ExitCode::from(1) }
}
