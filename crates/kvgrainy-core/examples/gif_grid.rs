//! Print size and similarity for a grid of scales and gifski qualities: usage gif_grid <animation>
use kvgrainy_core::animated::{encode_gif, gif_similarity, load_animation, GifSettings};

fn main() {
    let animation = load_animation(&std::fs::read(std::env::args().nth(1).expect("animation")).expect("read")).expect("animation");
    println!("scale quality bytes similarity");
    for scale in [1.0f32, 0.8, 0.6, 0.45, 0.3] {
        for quality in [1u8, 10, 25, 50, 75, 100] {
            let bytes = encode_gif(&animation, GifSettings { scale, quality, frame_step: 1 }).unwrap();
            println!("{scale:.2} {quality:3} {:7} {:5.1}", bytes.len(), gif_similarity(&animation, &bytes) * 100.0);
        }
    }
}
