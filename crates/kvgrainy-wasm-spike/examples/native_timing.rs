//! Native counterpart of `spike/wasm/run.mjs`: same steps, same codecs, same core.
use std::time::Instant;

use kvgrainy_wasm_spike::Spike;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: native_timing <image> [limit_bytes] [format]");
    let limit: u64 = args.next().map_or(100_000, |s| s.parse().unwrap());
    let format = args.next().unwrap_or_else(|| "jpeg".into());
    let bytes = std::fs::read(&path).unwrap();

    let t = Instant::now();
    let mut spike = Spike::new(&bytes).unwrap();
    println!("decode_ms={:.1} size={}x{}", ms(t), spike.width(), spike.height());
    let t = Instant::now();
    spike.prepare_reference();
    println!("prepare_reference_ms={:.1}", ms(t));
    let t = Instant::now();
    let len = spike.encode(&format, 80).unwrap();
    println!("encode_q80_ms={:.1} bytes={len}", ms(t));
    let t = Instant::now();
    let score = spike.score_last().unwrap();
    println!("score_ms={:.1} score={score:.4}", ms(t));
    let t = Instant::now();
    let best = spike.search(limit, &format);
    println!("search_ms={:.1} limit={limit} result={best:?}", ms(t));
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}
