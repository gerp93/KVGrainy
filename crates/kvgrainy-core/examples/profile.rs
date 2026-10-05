use std::time::Instant;
use kvgrainy_core::encode::{encode, Format};
use kvgrainy_core::load::load_image;
use kvgrainy_core::score::Reference;
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let src = load_image(std::path::Path::new(&path)).unwrap().raster;
    let t = Instant::now();
    let reference = Reference::new(&src);
    println!("reference prep {:?} ({}x{})", t.elapsed(), src.width, src.height);
    for (name, fmt) in [("jpeg", Format::Jpeg), ("webp", Format::Webp), ("avif", Format::Avif), ("png", Format::Png)] {
        for q in [30u8, 70, 95] {
            let t = Instant::now();
            let b = encode(fmt, &src, q).unwrap();
            let enc = t.elapsed();
            let t = Instant::now();
            let s = reference.score(&b, fmt);
            println!("{name} q{q}: {} B, encode {:?}, score {:?} ({s:.2})", b.len(), enc, t.elapsed());
            if fmt == Format::Png { break; }
        }
    }
}
