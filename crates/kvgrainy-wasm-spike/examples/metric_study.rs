//! Phase 1.4 study: how well do cheaper metrics pick the candidate that full-resolution
//! SSIMULACRA2 would pick?
//!
//! For each image: build a grid of JPEG candidates (scales x qualities), score every
//! candidate with every metric, then for several size limits pick the best candidate that
//! fits according to each metric. Regret = true best score minus the true score of the
//! pick, in SSIMULACRA2 points (score x 100). "True" is `s2_full`.
//!
//! usage: metric_study <dir-or-image>... [--csv-prefix target/metric-study]
use std::borrow::Cow;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::time::Instant;

use kvgrainy_core::load::decode;
use kvgrainy_core::raster::Raster;
use kvgrainy_core::score::Reference;
use kvgrainy_core::{Encoder, Format};
use kvgrainy_wasm_spike::proxy::{ProxyKind, ProxyRef};
use kvgrainy_wasm_spike::PureEncoder;
use rayon::prelude::*;

const MAX_SOURCE_MP: f64 = 10.0;
const SCALES: [f32; 12] = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.3, 0.25, 0.2, 0.15];
const QUALITIES: [u8; 9] = [15, 25, 35, 45, 55, 65, 75, 85, 92];
const LIMIT_FRACTIONS: [f64; 6] = [0.5, 0.3, 0.18, 0.1, 0.05, 0.025];

#[derive(Clone, Copy)]
enum Kind {
    S2,
    Proxy(ProxyKind),
    Rmse,
}

struct Spec {
    name: &'static str,
    kind: Kind,
    cap_mp: Option<f64>,
}

const fn spec(name: &'static str, kind: Kind, cap_mp: Option<f64>) -> Spec {
    Spec { name, kind, cap_mp }
}

/// Index 0 is the truth.
const SPECS: [Spec; 12] = [
    spec("s2_full", Kind::S2, None),
    spec("s2_4mp", Kind::S2, Some(4.0)),
    spec("s2_1mp", Kind::S2, Some(1.0)),
    spec("s2_0.25mp", Kind::S2, Some(0.25)),
    spec("blend_4mp", Kind::Proxy(ProxyKind::Blended), Some(4.0)),
    spec("blend_1mp", Kind::Proxy(ProxyKind::Blended), Some(1.0)),
    spec("blend_0.25mp", Kind::Proxy(ProxyKind::Blended), Some(0.25)),
    spec("ssim_4mp", Kind::Proxy(ProxyKind::LumaSsim), Some(4.0)),
    spec("ssim_1mp", Kind::Proxy(ProxyKind::LumaSsim), Some(1.0)),
    spec("ssim_0.25mp", Kind::Proxy(ProxyKind::LumaSsim), Some(0.25)),
    spec("rmse_full", Kind::Rmse, None),
    spec("rmse_1mp", Kind::Rmse, Some(1.0)),
];

enum Prepared {
    S2(Reference),
    Proxy(ProxyRef),
    Rmse(Vec<u8>),
}

struct Metric {
    width: u32,
    height: u32,
    prepared: Prepared,
}

fn cap_dims(w: u32, h: u32, cap_mp: Option<f64>) -> (u32, u32) {
    match cap_mp {
        Some(cap) if (w as f64) * (h as f64) > cap * 1e6 => {
            let f = (cap * 1e6 / (w as f64 * h as f64)).sqrt();
            (((w as f64 * f) as u32).max(1), ((h as f64 * f) as u32).max(1))
        }
        _ => (w, h),
    }
}

fn prepare(spec: &Spec, source: &Raster) -> Metric {
    let (width, height) = cap_dims(source.width, source.height, spec.cap_mp);
    let base: Cow<Raster> =
        if (width, height) == (source.width, source.height) { Cow::Borrowed(source) } else { Cow::Owned(source.resized(width, height)) };
    let prepared = match spec.kind {
        Kind::S2 => Prepared::S2(Reference::new(&base)),
        Kind::Proxy(kind) => Prepared::Proxy(ProxyRef::new(&base, kind)),
        Kind::Rmse => Prepared::Rmse(base.flattened_rgb()),
    };
    Metric { width, height, prepared }
}

impl Metric {
    fn score(&self, decoded: &Raster) -> f64 {
        match &self.prepared {
            Prepared::S2(reference) => reference.score_raster(decoded),
            Prepared::Proxy(proxy) => proxy.score(&decoded.resized(self.width, self.height)),
            Prepared::Rmse(reference) => {
                let candidate = decoded.resized(self.width, self.height).flattened_rgb();
                let squares: u64 = reference
                    .iter()
                    .zip(&candidate)
                    .map(|(&a, &b)| {
                        let d = a as i32 - b as i32;
                        (d * d) as u64
                    })
                    .sum();
                (1.0 - (squares as f64 / reference.len() as f64).sqrt() / 255.0).max(0.0)
            }
        }
    }
}

struct Cand {
    bytes: usize,
    scale: f32,
    quality: u8,
    scores: Vec<f64>,
    ms: Vec<f64>,
}

fn load_capped(path: &Path) -> Raster {
    let loaded = decode(&std::fs::read(path).expect("read image")).expect("decode image");
    let r = loaded.raster;
    let (w, h) = cap_dims(r.width, r.height, Some(MAX_SOURCE_MP));
    if (w, h) == (r.width, r.height) {
        r
    } else {
        r.resized(w, h)
    }
}

fn study_image(source: &Raster) -> Vec<Cand> {
    let metrics: Vec<Metric> = SPECS.iter().map(|s| prepare(s, source)).collect();
    let grid: Vec<(f32, u8)> = SCALES.iter().flat_map(|&s| QUALITIES.iter().map(move |&q| (s, q))).collect();
    grid.par_iter()
        .map(|&(scale, quality)| {
            let scaled = source.scaled(scale);
            let bytes = PureEncoder.encode(Format::Jpeg, &scaled, quality).expect("encode");
            let decoded = PureEncoder.decode(Format::Jpeg, &bytes).expect("decode");
            let (mut scores, mut ms) = (Vec::new(), Vec::new());
            for m in &metrics {
                let t = Instant::now();
                scores.push(m.score(&decoded));
                ms.push(t.elapsed().as_secs_f64() * 1000.0);
            }
            Cand { bytes: bytes.len(), scale, quality, scores, ms }
        })
        .collect()
}

struct Record {
    image: String,
    fraction: f64,
    metric: usize,
    truth_best: f64,
    regret: f64,
    exact: bool,
    scale: f32,
    quality: u8,
    feasible: usize,
}

fn evaluate(image: &str, cands: &[Cand]) -> Vec<Record> {
    let base = cands.iter().filter(|c| c.scale == 1.0).map(|c| c.bytes).max().unwrap_or(0) as f64;
    let mut out = Vec::new();
    for &fraction in &LIMIT_FRACTIONS {
        let limit = base * fraction;
        let feasible: Vec<&Cand> = cands.iter().filter(|c| c.bytes as f64 <= limit).collect();
        if feasible.len() < 3 {
            continue;
        }
        let truth_best = feasible.iter().map(|c| c.scores[0]).fold(f64::MIN, f64::max);
        for metric in 0..SPECS.len() {
            let pick = feasible.iter().copied().fold(None::<&Cand>, |best, c| match best {
                Some(b) if b.scores[metric] >= c.scores[metric] => Some(b),
                _ => Some(c),
            });
            let pick = pick.expect("non-empty");
            let regret = (truth_best - pick.scores[0]) * 100.0;
            out.push(Record {
                image: image.to_string(),
                fraction,
                metric,
                truth_best,
                regret,
                exact: regret < 1e-9,
                scale: pick.scale,
                quality: pick.quality,
                feasible: feasible.len(),
            });
        }
    }
    out
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn collect_images(inputs: &[String]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for input in inputs {
        let p = PathBuf::from(input);
        if p.is_dir() {
            let mut stack = vec![p];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).unwrap().flatten() {
                    let path = e.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if matches!(path.extension().and_then(|x| x.to_str()).map(str::to_lowercase).as_deref(), Some("jpg" | "jpeg" | "png")) {
                        files.push(path);
                    }
                }
            }
        } else {
            files.push(p);
        }
    }
    files.sort();
    files
}

fn main() {
    let mut inputs = Vec::new();
    let mut csv_prefix = String::from("target/metric-study");
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "--csv-prefix" {
            csv_prefix = args.next().expect("--csv-prefix needs a value");
        } else {
            inputs.push(a);
        }
    }
    assert!(!inputs.is_empty(), "usage: metric_study <dir-or-image>... [--csv-prefix PATH]");
    rayon::ThreadPoolBuilder::new().num_threads(8).build_global().unwrap();

    let files = collect_images(&inputs);
    let mut records = Vec::new();
    let mut cand_csv = String::from("image,scale,quality,bytes");
    for s in &SPECS {
        write!(cand_csv, ",{}", s.name).unwrap();
    }
    cand_csv.push('\n');
    let mut ms_sum = vec![0f64; SPECS.len()];
    let mut ms_count = 0u64;
    let mut cap_px = vec![0f64; SPECS.len()];

    for (i, path) in files.iter().enumerate() {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let t = Instant::now();
        let source = load_capped(path);
        let cands = study_image(&source);
        for (k, s) in SPECS.iter().enumerate() {
            let (w, h) = cap_dims(source.width, source.height, s.cap_mp);
            cap_px[k] += w as f64 * h as f64;
        }
        for c in &cands {
            write!(cand_csv, "{name},{},{},{}", c.scale, c.quality, c.bytes).unwrap();
            for v in &c.scores {
                write!(cand_csv, ",{v:.5}").unwrap();
            }
            cand_csv.push('\n');
            for (k, v) in c.ms.iter().enumerate() {
                ms_sum[k] += v;
            }
            ms_count += 1;
        }
        let recs = evaluate(&name, &cands);
        eprintln!("[{}/{}] {name} {}x{} -> {} records in {:.0}s", i + 1, files.len(), source.width, source.height, recs.len(), t.elapsed().as_secs_f64());
        records.extend(recs);
    }

    let mut rec_csv = String::from("image,limit_fraction,metric,truth_best,regret_points,exact,picked_scale,picked_quality,feasible\n");
    for r in &records {
        writeln!(rec_csv, "{},{},{},{:.4},{:.3},{},{},{},{}", r.image, r.fraction, SPECS[r.metric].name, r.truth_best, r.regret, r.exact, r.scale, r.quality, r.feasible).unwrap();
    }
    std::fs::write(format!("{csv_prefix}-records.csv"), rec_csv).unwrap();
    std::fs::write(format!("{csv_prefix}-candidates.csv"), cand_csv).unwrap();

    let cases = records.iter().filter(|r| r.metric == 1).count();
    let informative = records.iter().filter(|r| r.metric == 1 && r.truth_best > 0.2).count();
    println!("\n{} images, {} (image, limit) cases ({} with true best > 20 points)\n", files.len(), cases, informative);
    println!("| metric | mean regret | median | p90 | max | within 2 pts | within 1 pt | exact | ms/score | pixels scored |");
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for metric in 1..SPECS.len() {
        let mut regrets: Vec<f64> = records.iter().filter(|r| r.metric == metric).map(|r| r.regret).collect();
        regrets.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = regrets.len() as f64;
        let mean = regrets.iter().sum::<f64>() / n;
        let within = |t: f64| regrets.iter().filter(|&&r| r <= t).count() as f64 / n * 100.0;
        let exact = records.iter().filter(|r| r.metric == metric && r.exact).count() as f64 / n * 100.0;
        println!(
            "| {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.0}% | {:.0}% | {:.0}% | {:.0} | {:.2} MP |",
            SPECS[metric].name,
            mean,
            percentile(&regrets, 0.5),
            percentile(&regrets, 0.9),
            regrets.last().copied().unwrap_or(f64::NAN),
            within(2.0),
            within(1.0),
            exact,
            ms_sum[metric] / ms_count as f64,
            cap_px[metric] / files.len() as f64 / 1e6
        );
    }
    println!("\nMean regret (points) by limit, as a fraction of the largest candidate:\n");
    print!("| metric |");
    for f in &LIMIT_FRACTIONS {
        print!(" {f} |");
    }
    println!("\n|---|---|---|---|---|");
    for metric in 1..SPECS.len() {
        print!("| {} |", SPECS[metric].name);
        for &f in &LIMIT_FRACTIONS {
            let v: Vec<f64> = records.iter().filter(|r| r.metric == metric && r.fraction == f).map(|r| r.regret).collect();
            print!(" {:.2} (n={}) |", v.iter().sum::<f64>() / v.len().max(1) as f64, v.len());
        }
        println!();
    }
    println!("\nMean scale picked (1.0 = full size) vs the truth's pick:\n");
    let mean_scale = |metric: usize| {
        let v: Vec<f64> = records.iter().filter(|r| r.metric == metric).map(|r| r.scale as f64).collect();
        v.iter().sum::<f64>() / v.len().max(1) as f64
    };
    for metric in 0..SPECS.len() {
        println!("- {}: {:.2}", SPECS[metric].name, mean_scale(metric));
    }
}
