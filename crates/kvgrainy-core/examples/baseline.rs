//! Compare the search against the strongest "manual" baseline: for each format, slide the quality
//! until the file just fits under the limit, at the image's own size, and keep the best-looking of
//! the formats. That is what a person gets from a quality slider (Squoosh and similar) with perfect
//! patience; it never resizes, so it can fail where the search succeeds by shrinking.
//!
//! usage: baseline <limit, e.g. 100kb> [--quick] <image>...
//! Prints one CSV line per image: name,limit,baseline_bytes,baseline_format,baseline_score,search_bytes,search_format,search_scale,search_score
//! Scores are SSIMULACRA2 x100 at a 4 MP cap (docs/metric-study.md: matches full resolution 99% of the time).
//! File names are replaced by their position (img01, img02...) so results can be shared without them.
use std::path::Path;

use kvgrainy_core::encode::{encode, Format};
use kvgrainy_core::load::load_image;
use kvgrainy_core::score::Reference;
use kvgrainy_core::{optimize, parse_size_limit, Effort, Encoder, NativeEncoder, Options};

/// Highest quality in 1..=100 whose output fits, by bisection; `None` if even quality 1 does not fit.
fn fit(format: Format, raster: &kvgrainy_core::raster::Raster, limit: u64) -> Option<(Vec<u8>, u8)> {
    let (mut lo, mut hi) = (1u8, 100u8);
    let mut best = None;
    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        match encode(format, raster, mid) {
            Ok(bytes) if bytes.len() as u64 <= limit => {
                best = Some((bytes, mid));
                lo = mid + 1;
            }
            _ => hi = mid.saturating_sub(1),
        }
        if mid == 0 {
            break;
        }
    }
    best
}

fn main() {
    let mut args = std::env::args().skip(1);
    let limit = parse_size_limit(&args.next().expect("limit")).expect("a size like 100kb");
    let mut effort = Effort::Best;
    let mut images = Vec::new();
    for arg in args {
        if arg == "--quick" {
            effort = Effort::Quick;
        } else {
            images.push(arg);
        }
    }
    println!("name,limit,baseline_bytes,baseline_format,baseline_score,search_bytes,search_format,search_scale,search_score");
    for (index, path) in images.iter().enumerate() {
        let raster = load_image(Path::new(path)).expect("load").raster;
        let reference = Reference::with_cap(&raster, 4_000_000.0);
        let score = |format: Format, bytes: &[u8]| -> f64 {
            NativeEncoder.decode(format, bytes).map_or(0.0, |d| reference.score_raster(&d) * 100.0)
        };

        let formats: &[Format] = if raster.alpha.is_some() {
            &[Format::Webp, Format::Avif, Format::Png]
        } else {
            &[Format::Jpeg, Format::Webp, Format::Avif, Format::Png]
        };
        let formats: Vec<Format> = formats.iter().copied().filter(|f| effort == Effort::Best || *f != Format::Avif).collect();
        let baseline = formats
            .iter()
            .filter_map(|&f| fit(f, &raster, limit).map(|(bytes, _)| (f, score(f, &bytes), bytes.len())))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap());

        let options = Options { effort, ..Options::new(limit) };
        let search = optimize(&raster, &options, &|_| {}).ok().map(|c| (c.format, score(c.format, &c.bytes), c.bytes.len(), c.scale));

        let b = baseline.map_or(",,".to_string(), |(f, s, n)| format!("{n},{f:?},{s:.2}"));
        let s = search.map_or(",,,".to_string(), |(f, sc, n, scale)| format!("{n},{f:?},{scale:.2},{sc:.2}"));
        println!("img{:02},{limit},{b},{s}", index + 1);
    }
}
