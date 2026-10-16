use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use kvgrainy_core::encode::{encode, Format};
use kvgrainy_core::load::decode;
use kvgrainy_core::raster::Raster;
use kvgrainy_core::{optimize, Encoder, Error, Options};

fn noise(width: u32, height: u32) -> Raster {
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            rgb.extend([((x * y) % 255) as u8, ((x + y) % 255) as u8, ((x * 2 + y * 3) % 255) as u8]);
        }
    }
    Raster { width, height, rgb, alpha: None }
}

/// Insert an EXIF APP1 segment carrying only an Orientation tag after the JPEG SOI marker.
fn with_exif_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
    let mut tiff = b"MM\x00\x2a\x00\x00\x00\x08".to_vec();
    tiff.extend([0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]);
    tiff.extend(orientation.to_be_bytes());
    tiff.extend([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend(tiff);
    let mut out = jpeg[..2].to_vec();
    out.extend([0xFF, 0xE1]);
    out.extend(((payload.len() + 2) as u16).to_be_bytes());
    out.extend(payload);
    out.extend(&jpeg[2..]);
    out
}

fn no_progress(_: kvgrainy_core::Progress) {}

#[test]
fn exif_orientation_is_applied() {
    // Stored 60x40 landscape with orientation 6 (rotate 90 CW) must load as 40x60.
    let jpeg = encode(Format::Jpeg, &noise(60, 40), 90).unwrap();
    assert_eq!(decode(&jpeg).unwrap().raster.width, 60);
    let rotated = decode(&with_exif_orientation(&jpeg, 6)).unwrap().raster;
    assert_eq!((rotated.width, rotated.height), (40, 60));
}

#[test]
fn output_carries_no_metadata() {
    let jpeg = with_exif_orientation(&encode(Format::Jpeg, &noise(80, 80), 90).unwrap(), 6);
    let loaded = decode(&jpeg).unwrap();
    let best = optimize(&loaded.raster, &Options { format: Some(Format::Jpeg), ..Options::new(40 * 1024) }, &no_progress).unwrap();
    assert!(!best.bytes.windows(4).any(|w| w == b"Exif"), "EXIF leaked into output");
}

#[test]
fn unusable_icc_profile_warns_and_falls_back() {
    // PNG with a garbage iCCP chunk is awkward to build; use a JPEG APP2 ICC_PROFILE segment.
    let jpeg = encode(Format::Jpeg, &noise(32, 32), 90).unwrap();
    let junk = b"not a profile";
    let mut payload = b"ICC_PROFILE\0\x01\x01".to_vec();
    payload.extend(junk);
    let mut bad = jpeg[..2].to_vec();
    bad.extend([0xFF, 0xE2]);
    bad.extend(((payload.len() + 2) as u16).to_be_bytes());
    bad.extend(payload);
    bad.extend(&jpeg[2..]);
    let loaded = decode(&bad).unwrap();
    assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
}

#[test]
fn transparent_image_keeps_alpha_and_uses_alpha_formats() {
    let mut image = noise(80, 80);
    image.alpha = Some((0..80 * 80).map(|i| (i % 256) as u8).collect());
    let best = optimize(&image, &Options::new(60 * 1024), &no_progress).unwrap();
    assert_ne!(best.format, Format::Jpeg);
    let decoded = image::load_from_memory(&best.bytes).unwrap();
    assert!(decoded.color().has_alpha());
}

#[test]
fn stays_under_limit_and_progress_reaches_total() {
    let limit = 20 * 1024;
    let furthest = std::sync::atomic::AtomicUsize::new(0);
    let expected_total = std::sync::atomic::AtomicUsize::new(0);
    let best = optimize(&noise(300, 200), &Options::new(limit), &|p| {
        assert!(p.completed <= p.total, "{p:?}");
        furthest.fetch_max(p.completed, std::sync::atomic::Ordering::Relaxed);
        expected_total.store(p.total, std::sync::atomic::Ordering::Relaxed);
    })
    .unwrap();
    assert!(best.bytes.len() as u64 <= limit);
    assert_eq!(furthest.into_inner(), expected_total.into_inner());
}

#[test]
fn generous_limit_stops_at_full_scale() {
    let best = optimize(&noise(200, 200), &Options::new(10 * 1024 * 1024), &no_progress).unwrap();
    assert_eq!(best.scale, 1.0);
}

#[test]
fn already_small_image_keeps_full_scale() {
    let tiny = Raster { width: 16, height: 16, rgb: vec![0, 128, 0].repeat(256), alpha: None };
    let best = optimize(&tiny, &Options::new(500 * 1024), &no_progress).unwrap();
    assert_eq!(best.scale, 1.0);
}

#[test]
fn impossible_limit_reports_smallest_output() {
    match optimize(&noise(200, 200), &Options::new(10), &no_progress) {
        Err(Error::NothingFits { limit: 10, smallest }) => assert!(smallest > 10),
        other => panic!("expected NothingFits, got {other:?}"),
    }
}

#[test]
fn cancel_aborts_the_search() {
    let cancel = Arc::new(AtomicBool::new(true));
    let options = Options { cancel: Some(cancel), ..Options::new(50 * 1024) };
    assert!(matches!(optimize(&noise(100, 100), &options, &no_progress), Err(Error::Cancelled)));
}

#[test]
fn avif_round_trips_through_encoder_and_decoder() {
    let image = noise(64, 48);
    let bytes = encode(Format::Avif, &image, 80).unwrap();
    let reference = kvgrainy_core::score::Reference::new(&image);
    let score = reference.score(&bytes, Format::Avif);
    assert!(score > 0.3, "decoded AVIF should resemble the original, got {score}");
}

#[test]
fn scorer_ranks_higher_quality_above_lower() {
    let image = noise(128, 128);
    let reference = kvgrainy_core::score::Reference::new(&image);
    let high = reference.score(&encode(Format::Jpeg, &image, 95).unwrap(), Format::Jpeg);
    let low = reference.score(&encode(Format::Jpeg, &image, 20).unwrap(), Format::Jpeg);
    assert!(high > low, "q95 ({high}) should beat q20 ({low})");
    let lossless = reference.score(&encode(Format::Png, &image, 100).unwrap(), Format::Png);
    assert!(lossless > 0.99, "lossless PNG should score ~1.0, got {lossless}");
}

#[test]
fn tiny_image_falls_back_to_pixel_score() {
    // SSIMULACRA2 rejects images under 8x8; scoring must still work.
    let tiny = Raster { width: 4, height: 4, rgb: vec![10, 200, 30].repeat(16), alpha: None };
    let reference = kvgrainy_core::score::Reference::new(&tiny);
    let score = reference.score(&encode(Format::Png, &tiny, 100).unwrap(), Format::Png);
    assert!(score > 0.99, "{score}");
}

/// An encoder that delegates to the native one but counts calls, standing in for
/// a codec set supplied by another target.
struct CountingEncoder {
    encodes: std::sync::atomic::AtomicUsize,
    decodes: std::sync::atomic::AtomicUsize,
}

impl Encoder for CountingEncoder {
    fn encode(&self, format: Format, raster: &Raster, quality: u8) -> Result<Vec<u8>, String> {
        self.encodes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        kvgrainy_core::NativeEncoder.encode(format, raster, quality)
    }

    fn decode(&self, format: Format, payload: &[u8]) -> Option<Raster> {
        self.decodes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        kvgrainy_core::NativeEncoder.decode(format, payload)
    }
}

#[test]
fn search_runs_on_a_custom_encoder() {
    use kvgrainy_core::optimize_with;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let image = noise(96, 96);
    let options = Options { format: Some(Format::Jpeg), ..Options::new(8 * 1024) };
    let counting = CountingEncoder { encodes: AtomicUsize::new(0), decodes: AtomicUsize::new(0) };

    let custom = optimize_with(&counting, &image, &options, &no_progress).unwrap();
    let native = optimize(&image, &options, &no_progress).unwrap();

    assert!(counting.encodes.load(Ordering::Relaxed) > 0, "search never called the custom encoder");
    assert!(counting.decodes.load(Ordering::Relaxed) > 0, "scoring never decoded through the custom encoder");
    assert_eq!(custom.bytes, native.bytes, "a delegating encoder must not change the result");
}

#[test]
fn impossible_limit_still_yields_a_best_effort_file() {
    let image = noise(200, 200);
    let options = Options::new(10);
    assert!(matches!(optimize(&image, &options, &no_progress), Err(Error::NothingFits { .. })));
    let best = kvgrainy_core::best_effort(&image, &options).expect("a best-effort output");
    assert!(best.bytes.len() as u64 > 10, "over the limit by definition");
    let decoded = kvgrainy_core::NativeEncoder.decode(best.format, &best.bytes).expect("decodable");
    assert!(decoded.width > 0 && decoded.height > 0);
    // It is the smallest on offer: no candidate format at that scale and quality is smaller.
    for format in [Format::Jpeg, Format::Webp, Format::Avif, Format::Png] {
        let q = if format.has_quality() { 20 } else { 100 };
        let other = encode(format, &image.scaled(0.3), q).unwrap();
        assert!(best.bytes.len() <= other.len(), "{format:?} was smaller ({} < {})", other.len(), best.bytes.len());
    }
}

#[test]
fn same_input_and_settings_give_byte_identical_output() {
    let image = noise(120, 90);
    for effort in [kvgrainy_core::Effort::Best, kvgrainy_core::Effort::Quick] {
        let options = || Options { effort, ..Options::new(6 * 1024) };
        let first = optimize(&image, &options(), &no_progress).unwrap();
        let second = optimize(&image, &options(), &no_progress).unwrap();
        assert_eq!(first.bytes, second.bytes, "{effort:?} output differs between runs");
        assert_eq!((first.format, first.scale, first.quality), (second.format, second.scale, second.quality));
    }
}

#[test]
fn quick_effort_never_picks_avif() {
    let options = Options { effort: kvgrainy_core::Effort::Quick, ..Options::new(8 * 1024) };
    let best = optimize(&noise(120, 90), &options, &no_progress).unwrap();
    assert_ne!(best.format, Format::Avif);
}
