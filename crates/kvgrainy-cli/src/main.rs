use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;
use kvgrainy_core::{load::load_image, optimize, parse_size_limit, Format, Options};

const IMAGE_EXTENSIONS: [&str; 7] = ["jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif"];

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
    /// Force an output format (jpeg, png, webp); default picks the best
    #[arg(long)]
    format: Option<String>,
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
            eprintln!("error: unsupported format (use jpeg, png or webp)");
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
        let options = Options { format, ..Options::new(limit) };
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
                    "[done] {name} -> {} | {:.1}KB | fmt={:?} quality={:?} scale={:.2}",
                    out.file_name().unwrap_or_default().to_string_lossy(),
                    best.bytes.len() as f64 / 1024.0,
                    best.format,
                    best.quality,
                    best.scale
                );
            }
            Err(why) => {
                eprintln!("[fail] {name}: {why}");
                failures += 1;
            }
        }
    }
    if failures == 0 { ExitCode::SUCCESS } else { ExitCode::from(1) }
}
