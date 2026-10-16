//! Score an output against its source with SSIMULACRA2 at a 4 MP cap (the study's
//! near-truth reference). usage: score_file <source> <output>...
//! Prints one line per output: `<bytes> <score x100>`.
use std::path::Path;

use kvgrainy_core::load::load_image;
use kvgrainy_core::score::Reference;
use kvgrainy_core::{Encoder, Format, NativeEncoder};

fn main() {
    let mut args = std::env::args().skip(1);
    let source = load_image(Path::new(&args.next().expect("source"))).expect("load source").raster;
    let reference = Reference::with_cap(&source, 4_000_000.0);
    for path in args {
        let bytes = std::fs::read(&path).expect("read output");
        let format = match Path::new(&path).extension().and_then(|e| e.to_str()) {
            Some("jpg" | "jpeg") => Format::Jpeg,
            Some("webp") => Format::Webp,
            Some("avif") => Format::Avif,
            _ => Format::Png,
        };
        let decoded = NativeEncoder.decode(format, &bytes).expect("decode output");
        println!("{} {:.2}", bytes.len(), reference.score_raster(&decoded) * 100.0);
    }
}
