#![cfg(feature = "animation")]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use kvgrainy_core::animated::{
    encode_gif, load_animation, optimize_gif, Animation, AnimationError, GifOptions, GifSettings,
};
use kvgrainy_core::encode::{encode, Format};
use kvgrainy_core::raster::Raster;

/// A small animation with real motion and colour: a gradient with a bar sweeping across it.
fn animation(frames: usize) -> Animation {
    let (width, height) = (96u32, 64u32);
    let frames_out = (0..frames)
        .map(|f| {
            let mut rgb = Vec::with_capacity((width * height * 3) as usize);
            for y in 0..height {
                for x in 0..width {
                    let bar = (x as usize + f * 8) % (width as usize) < 12;
                    let base = [(x * 255 / width) as u8, (y * 255 / height) as u8, 90 + (f as u8 * 7)];
                    rgb.extend(if bar { [250, 240, 60] } else { base });
                }
            }
            Raster { width, height, rgb, alpha: None }
        })
        .collect();
    Animation { width, height, frames: frames_out, delays_ms: vec![80; frames], loops: 0 }
}

fn settings(scale: f32, quality: u8, frame_step: usize) -> GifSettings {
    GifSettings { scale, quality, frame_step }
}

#[test]
fn a_gif_written_by_encode_reads_back_with_its_frames_and_timing() {
    let gif = encode_gif(&animation(8), settings(1.0, 90, 1)).unwrap();
    assert!(gif.starts_with(b"GIF8"), "not a GIF");
    let back = load_animation(&gif).unwrap();
    assert_eq!((back.width, back.height), (96, 64));
    assert_eq!(back.frames.len(), 8);
    assert!(back.delays_ms.iter().all(|&d| (70..=90).contains(&d)), "delays {:?}", back.delays_ms);
}

#[test]
fn dropping_frames_keeps_the_playing_time() {
    let gif = encode_gif(&animation(8), settings(1.0, 90, 2)).unwrap();
    let back = load_animation(&gif).unwrap();
    assert_eq!(back.frames.len(), 4);
    let total: u32 = back.delays_ms.iter().sum();
    assert!((600..=680).contains(&total), "8 frames of 80 ms should still take about 640 ms, took {total}");
}

#[test]
fn scale_shrinks_the_picture() {
    let gif = encode_gif(&animation(6), settings(0.5, 90, 1)).unwrap();
    let back = load_animation(&gif).unwrap();
    assert_eq!((back.width, back.height), (48, 32));
}

#[test]
fn a_single_image_is_not_an_animation() {
    let still = Raster { width: 32, height: 32, rgb: vec![10, 120, 30].repeat(32 * 32), alpha: None };
    let png = encode(Format::Png, &still, 100).unwrap();
    assert!(matches!(load_animation(&png), Err(AnimationError::NotAnimated)));
    let jpeg = encode(Format::Jpeg, &still, 90).unwrap();
    assert!(matches!(load_animation(&jpeg), Err(AnimationError::NotAnimated)));
}

#[test]
fn the_search_fits_under_the_limit_and_keeps_the_picture_when_it_can() {
    let source = animation(10);
    let full = encode_gif(&source, settings(1.0, 100, 1)).unwrap().len() as u64;
    // Easy: the limit is above the full-quality size, so the search should keep full size.
    let easy = optimize_gif(&source, &GifOptions { limit_bytes: full * 2, cancel: None }, &|_| {}).unwrap();
    assert!(easy.bytes.len() as u64 <= full * 2);
    assert_eq!(easy.settings.scale, 1.0);
    assert!(easy.score > 0.5, "score {}", easy.score);

    // Tight: 40% of the full size forces a lower quality or a smaller picture, and must still fit.
    let limit = full * 4 / 10;
    let hard = optimize_gif(&source, &GifOptions { limit_bytes: limit, cancel: None }, &|_| {}).unwrap();
    assert!(hard.bytes.len() as u64 <= limit, "{} over {limit}", hard.bytes.len());
    assert!(load_animation(&hard.bytes).is_ok(), "the result must be a playable animation");
}

#[test]
fn an_impossible_limit_reports_the_smallest_output_tried() {
    match optimize_gif(&animation(6), &GifOptions { limit_bytes: 50, cancel: None }, &|_| {}) {
        Err(AnimationError::NothingFits { limit: 50, smallest }) => assert!(smallest > 50),
        other => panic!("expected NothingFits, got {:?}", other.map(|c| c.bytes.len())),
    }
}

#[test]
fn cancel_stops_the_search() {
    let cancel = Arc::new(AtomicBool::new(true));
    let options = GifOptions { limit_bytes: 4000, cancel: Some(cancel) };
    assert!(matches!(optimize_gif(&animation(6), &options, &|_| {}), Err(AnimationError::Cancelled)));
}

#[test]
fn progress_never_goes_backwards_and_ends_at_one() {
    let last = std::sync::Mutex::new(0.0f64);
    let source = animation(6);
    let full = encode_gif(&source, settings(1.0, 100, 1)).unwrap().len() as u64;
    optimize_gif(&source, &GifOptions { limit_bytes: full / 2, cancel: None }, &|p| {
        let mut last = last.lock().unwrap();
        assert!(p >= *last - 1e-9 && p <= 1.0, "progress went from {last} to {p}");
        *last = p;
    })
    .unwrap();
    assert!((*last.lock().unwrap() - 1.0).abs() < 1e-9);
}
