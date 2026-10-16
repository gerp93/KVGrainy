//! Score GIFs against an original animation: prints `bytes similarity(0-100)` for each output.
//! usage: gif_compare <original animation> <output.gif>...
use kvgrainy_core::animated::{gif_similarity, load_animation};

fn main() {
    let mut args = std::env::args().skip(1);
    let original = load_animation(&std::fs::read(args.next().expect("original")).expect("read")).expect("an animation");
    for path in args {
        let bytes = std::fs::read(&path).expect("read output");
        println!("{} {:.1}", bytes.len(), gif_similarity(&original, &bytes) * 100.0);
    }
}
