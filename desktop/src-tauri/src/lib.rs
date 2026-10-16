//! KVGrainy desktop: a Tauri shell around the shared web UI that runs `kvgrainy-core` natively.
//!
//! The UI is the same code as the web tool. Only the engine differs: the web build runs the core
//! as WebAssembly in workers, this build calls the core's native codecs (mozjpeg, libwebp, rav1e,
//! imagequant, oxipng) through the commands below, on all CPU cores. All logic stays in the core
//! crate; this file only moves bytes, progress and cancellation across the IPC boundary.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use kvgrainy_core::animated::{best_effort_gif, load_animation, optimize_gif, AnimationError, GifOptions};
use kvgrainy_core::load::decode;
use kvgrainy_core::raster::Raster;
use kvgrainy_core::{best_effort, optimize, Effort, Encoder, Error, Format, NativeEncoder, Options, Progress};
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// Extensions the app opens from the command line (Explorer's "Reduce with KVGrainy", "Open with").
const OPENABLE: [&str; 14] =
    ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "mp4", "m4v", "mov", "webm", "mkv", "avi"];

/// Running searches, so the UI can cancel one by id.
#[derive(Default)]
struct Jobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Files handed to the app on launch, read once by the UI at start-up.
#[derive(Default)]
struct Pending(Mutex<Vec<String>>);

/// Paths the UI may read back with `read_file`: only files the user opened the app with. The UI
/// is bundled and its CSP forbids remote content, but a command that reads any path on request
/// is not one to leave open.
#[derive(Default)]
struct Allowed(Mutex<HashSet<String>>);

#[derive(Clone, Serialize)]
struct ProgressEvent {
    id: String,
    fraction: f64,
}

/// Everything about a finished search except the file bytes, which follow it in the reply.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    /// "ok", "nothing-fits" (bytes are the smallest output possible, over the limit), "cancelled", or
    /// (animation command only) "not-animated": the file is a still and the caller should use `optimize_image`.
    outcome: &'static str,
    format: Option<&'static str>,
    quality: Option<u8>,
    scale: f32,
    score: f64,
    limit: u64,
    smallest: u64,
    width: u32,
    height: u32,
    warnings: Vec<String>,
}

fn format_name(format: Format) -> &'static str {
    match format {
        Format::Jpeg => "jpeg",
        Format::Webp => "webp",
        Format::Avif => "avif",
        Format::Png | Format::PngPalette => "png",
    }
}

/// The reply layout: `u32` little-endian length of the JSON, the JSON, then the file bytes.
fn reply(meta: &Meta, bytes: &[u8]) -> Result<Response, String> {
    let json = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + json.len() + bytes.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(bytes);
    Ok(Response::new(out))
}

fn header(request: &Request<'_>, name: &str) -> String {
    request.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err("expected the file as raw bytes".into()),
    }
}

struct Search {
    app: AppHandle,
    id: String,
    limit: u64,
    format: Option<Format>,
    effort: Effort,
    cancel: Arc<AtomicBool>,
}

fn run_search(search: Search, bytes: &[u8]) -> Result<Response, String> {
    let loaded = decode(bytes).map_err(|e| e.to_string())?;
    let raster = loaded.raster;
    let (width, height) = (raster.width, raster.height);
    let options = Options { format: search.format, effort: search.effort, cancel: Some(search.cancel), ..Options::new(search.limit) };
    let progress = |p: Progress| {
        let event = ProgressEvent { id: search.id.clone(), fraction: p.completed as f64 / p.total.max(1) as f64 };
        let _ = search.app.emit("optimize-progress", event);
    };
    let base = |outcome| Meta {
        outcome,
        format: None,
        quality: None,
        scale: 0.0,
        score: 0.0,
        limit: search.limit,
        smallest: 0,
        width,
        height,
        warnings: loaded.warnings.clone(),
    };
    match optimize(&raster, &options, &progress) {
        Ok(best) => {
            let meta = Meta {
                format: Some(format_name(best.format)),
                quality: best.quality,
                scale: best.scale,
                score: best.score,
                smallest: best.bytes.len() as u64,
                ..base("ok")
            };
            reply(&meta, &best.bytes)
        }
        Err(Error::Cancelled) => reply(&base("cancelled"), &[]),
        Err(Error::NothingFits { smallest, .. }) => {
            // Never leave the user with nothing: the smallest output possible, clearly over the limit.
            match best_effort(&raster, &options) {
                Some(fallback) => {
                    let meta = Meta { format: Some(format_name(fallback.format)), smallest, ..base("nothing-fits") };
                    reply(&meta, &fallback.bytes)
                }
                None => reply(&Meta { smallest, ..base("nothing-fits") }, &[]),
            }
        }
    }
}

/// Fit an animated GIF, WebP or PNG under a size limit as a GIF, with gifski. Same parameters and
/// reply as `optimize_image`; a file that turns out to be a still comes back as outcome "not-animated"
/// (after at most a header read) so the caller can send it to `optimize_image` instead.
#[tauri::command]
async fn optimize_animation(app: AppHandle, jobs: State<'_, Jobs>, request: Request<'_>) -> Result<Response, String> {
    let bytes = raw_body(&request)?.to_vec();
    let id = header(&request, "x-job-id");
    let limit: u64 = header(&request, "x-limit").parse().map_err(|_| "x-limit must be a number of bytes".to_string())?;
    let cancel = Arc::new(AtomicBool::new(false));
    jobs.0.lock().map_err(|_| "job list poisoned")?.insert(id.clone(), cancel.clone());
    let search = Search { app, id: id.clone(), limit, format: None, effort: Effort::Quick, cancel };
    let result = tauri::async_runtime::spawn_blocking(move || run_animation(search, &bytes)).await;
    jobs.0.lock().map_err(|_| "job list poisoned")?.remove(&id);
    result.map_err(|e| e.to_string())?
}

fn run_animation(search: Search, bytes: &[u8]) -> Result<Response, String> {
    let blank = |outcome| Meta {
        outcome,
        format: None,
        quality: None,
        scale: 0.0,
        score: 0.0,
        limit: search.limit,
        smallest: 0,
        width: 0,
        height: 0,
        warnings: Vec::new(),
    };
    let animation = match load_animation(bytes) {
        Ok(animation) => animation,
        Err(AnimationError::NotAnimated) => return reply(&blank("not-animated"), &[]),
        Err(why) => return Err(why.to_string()),
    };
    let (width, height) = (animation.width, animation.height);
    let options = GifOptions { limit_bytes: search.limit, cancel: Some(search.cancel.clone()) };
    let progress = |fraction: f64| {
        let _ = search.app.emit("optimize-progress", ProgressEvent { id: search.id.clone(), fraction });
    };
    match optimize_gif(&animation, &options, &progress) {
        Ok(best) => {
            let meta = Meta {
                format: Some("gif"),
                quality: Some(best.settings.quality),
                scale: best.settings.scale,
                score: best.score,
                smallest: best.bytes.len() as u64,
                width,
                height,
                ..blank("ok")
            };
            reply(&meta, &best.bytes)
        }
        Err(AnimationError::Cancelled) => reply(&blank("cancelled"), &[]),
        Err(AnimationError::NothingFits { smallest, .. }) => match best_effort_gif(&animation) {
            Ok(fallback) => {
                let meta = Meta { format: Some("gif"), smallest, width, height, ..blank("nothing-fits") };
                reply(&meta, &fallback.bytes)
            }
            Err(_) => reply(&Meta { smallest, ..blank("nothing-fits") }, &[]),
        },
        Err(why) => Err(why.to_string()),
    }
}

/// Fit the image file (sent as raw bytes) under a size limit. Parameters travel as headers:
/// `x-job-id`, `x-limit` (bytes), `x-format` (empty for automatic) and `x-effort` ("quick" or "best").
/// Progress arrives as `optimize-progress` events carrying the job id.
#[tauri::command]
async fn optimize_image(app: AppHandle, jobs: State<'_, Jobs>, request: Request<'_>) -> Result<Response, String> {
    let bytes = raw_body(&request)?.to_vec();
    let id = header(&request, "x-job-id");
    let limit: u64 = header(&request, "x-limit").parse().map_err(|_| "x-limit must be a number of bytes".to_string())?;
    let format = match header(&request, "x-format").as_str() {
        "" => None,
        name => Some(Format::parse(name).ok_or_else(|| format!("unknown format {name:?}"))?),
    };
    let effort = if header(&request, "x-effort") == "best" { Effort::Best } else { Effort::Quick };

    let cancel = Arc::new(AtomicBool::new(false));
    jobs.0.lock().map_err(|_| "job list poisoned")?.insert(id.clone(), cancel.clone());
    let search = Search { app, id: id.clone(), limit, format, effort, cancel };
    let result = tauri::async_runtime::spawn_blocking(move || run_search(search, &bytes)).await;
    jobs.0.lock().map_err(|_| "job list poisoned")?.remove(&id);
    result.map_err(|e| e.to_string())?
}

/// Stop a running search. Unknown or finished ids are ignored.
#[tauri::command]
fn cancel_optimize(jobs: State<'_, Jobs>, id: String) {
    if let Ok(jobs) = jobs.0.lock() {
        if let Some(flag) = jobs.get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Ask where to save, then write the file (sent as raw bytes; `x-name` is the percent-encoded
/// suggested file name). Returns the chosen path, or nothing if the user cancelled.
#[tauri::command]
async fn save_file(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let bytes = raw_body(&request)?.to_vec();
    let name = percent_decode(&header(&request, "x-name"));
    let chosen = tauri::async_runtime::spawn_blocking(move || app.dialog().file().set_file_name(name).blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(chosen) = chosen else { return Ok(None) };
    let path: PathBuf = chosen.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not save {}: {e}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Show a saved file in the system file manager, selected.
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
}

/// The files the app was launched with, once. Later launches reach the running app as `open-files` events.
#[tauri::command]
fn take_pending_files(pending: State<'_, Pending>) -> Vec<String> {
    pending.0.lock().map(|mut files| std::mem::take(&mut *files)).unwrap_or_default()
}

/// Read a file the app was opened with (see [`Allowed`]).
#[tauri::command]
fn read_file(allowed: State<'_, Allowed>, path: String) -> Result<Response, String> {
    let permitted = allowed.0.lock().map_err(|_| "allow list poisoned")?.contains(&path);
    if !permitted {
        return Err("that file was not opened with the app".into());
    }
    std::fs::read(&path).map(Response::new).map_err(|e| format!("could not read {path}: {e}"))
}

/// Where releases are published. The check reads the newest one and compares its tag with this build.
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/gerp93/KVGrainy/releases/latest";

/// `major.minor.patch` from a tag such as `v1.2.3` (anything after a `-` or `+` is ignored).
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>());
    Some((parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?))
}

fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// The newest release's tag and page, from GitHub.
fn latest_release() -> Result<(String, String), String> {
    let mut response = ureq::get(LATEST_RELEASE_API)
        .header("User-Agent", concat!("kvgrainy-desktop/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?;
    let release: serde_json::Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    let tag = release["tag_name"].as_str().ok_or("the release has no tag")?.to_string();
    let url = release["html_url"].as_str().ok_or("the release has no page")?.to_string();
    Ok((tag, url))
}

/// Look for a newer release and offer to open its download page. `silent` is the start-up check:
/// it says nothing unless there is a newer release.
///
/// This does not download or install anything. Tauri's own updater plugin would, but every
/// version of it depends on a `zip` crate release that has been yanked, so it cannot be built
/// right now (docs/release.md); installing from the release page keeps a human in the loop until then.
async fn check_for_updates_inner(app: AppHandle, silent: bool) -> Result<(), String> {
    let checked = tauri::async_runtime::spawn_blocking(latest_release).await.map_err(|e| e.to_string())?;
    let (tag, url) = match checked {
        Ok(found) => found,
        Err(_) if silent => return Ok(()),
        Err(error) => return Err(format!("could not check for updates: {error}")),
    };
    let current = app.package_info().version.to_string();
    let dialog = app.clone();
    if !is_newer(&tag, &current) {
        if !silent {
            let message = format!("You're running the latest version ({current}).");
            let _ = tauri::async_runtime::spawn_blocking(move || dialog.dialog().message(message).title("Up to date").blocking_show()).await;
        }
        return Ok(());
    }
    let message = format!("KVGrainy {tag} is available (you have {current}).\n\nOpen the download page?");
    let open = tauri::async_runtime::spawn_blocking(move || {
        dialog
            .dialog()
            .message(message)
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom("Open download page".into(), "Later".into()))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if open {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// "Check for updates" from the UI.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    check_for_updates_inner(app, false).await
}

/// `--smoke-test <report file>`: encode and decode a small image with every native codec and run a
/// whole search, write what happened to the report, and return the process exit code (0 = all
/// worked). Release builds run this on the packaged binary in CI, so a missing codec or a broken
/// build fails the release instead of reaching users. No window is opened.
fn smoke_test(report: &str) -> i32 {
    let (width, height) = (96u32, 64u32);
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            rgb.extend([(x * 255 / width) as u8, (y * 255 / height) as u8, ((x + y) * 255 / (width + height)) as u8]);
        }
    }
    let raster = Raster { width, height, rgb, alpha: None };
    let mut lines = vec![format!("kvgrainy-desktop {}", env!("CARGO_PKG_VERSION"))];
    let mut failed = false;
    for format in [Format::Jpeg, Format::Webp, Format::Avif, Format::Png, Format::PngPalette] {
        let outcome = NativeEncoder.encode(format, &raster, 70).and_then(|bytes| {
            let decoded = NativeEncoder.decode(format, &bytes).ok_or("could not decode its own output")?;
            if (decoded.width, decoded.height) == (width, height) && !bytes.is_empty() {
                Ok(bytes.len())
            } else {
                Err("decoded to the wrong size".to_string())
            }
        });
        match outcome {
            Ok(size) => lines.push(format!("ok   {format:?}: {size} bytes")),
            Err(why) => {
                failed = true;
                lines.push(format!("FAIL {format:?}: {why}"));
            }
        }
    }
    let options = Options { effort: Effort::Quick, ..Options::new(4096) };
    match optimize(&raster, &options, &|_| {}) {
        Ok(best) if best.bytes.len() <= 4096 => lines.push(format!("ok   search: {:?}, {} bytes", best.format, best.bytes.len())),
        Ok(best) => {
            failed = true;
            lines.push(format!("FAIL search: {} bytes is over the 4096 limit", best.bytes.len()));
        }
        Err(why) => {
            failed = true;
            lines.push(format!("FAIL search: {why}"));
        }
    }
    lines.push(if failed { "FAILED".into() } else { "PASSED".into() });
    let _ = std::fs::write(report, lines.join("\n") + "\n");
    i32::from(failed)
}

/// Command-line arguments that are existing image or video files.
fn openable(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|arg| {
            let path = std::path::Path::new(arg);
            path.is_file()
                && path.extension().and_then(|e| e.to_str()).is_some_and(|e| OPENABLE.contains(&e.to_ascii_lowercase().as_str()))
        })
        .cloned()
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() && hex(bytes[i + 1]).is_some() && hex(bytes[i + 2]).is_some() {
            out.push((hex(bytes[i + 1]).unwrap() * 16 + hex(bytes[i + 2]).unwrap()) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hand_over(app: &AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    if let Ok(mut allowed) = app.state::<Allowed>().0.lock() {
        allowed.extend(files.iter().cloned());
    }
    let _ = app.emit("open-files", files);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|a| a == "--smoke-test") {
        std::process::exit(smoke_test(args.get(at + 1).map_or("smoke-test.txt", String::as_str)));
    }
    tauri::Builder::default()
        // A second launch (a right-click on another file) goes to the window that is already open.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            hand_over(app, openable(&args));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Jobs::default())
        .manage(Pending::default())
        .manage(Allowed::default())
        .setup(|app| {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let files = openable(&args);
            app.state::<Allowed>().0.lock().expect("allow list").extend(files.iter().cloned());
            *app.state::<Pending>().0.lock().expect("pending list") = files;
            // A quiet check at start-up; development builds have no release to compare with.
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = check_for_updates_inner(handle, true).await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            optimize_image,
            optimize_animation,
            cancel_optimize,
            save_file,
            reveal_in_folder,
            take_pending_files,
            read_file,
            check_for_updates
        ])
        .run(tauri::generate_context!())
        .expect("error while running KVGrainy");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding_handles_unicode_and_stray_percent() {
        assert_eq!(percent_decode("photo%20one.png"), "photo one.png");
        assert_eq!(percent_decode("%E2%9C%93.jpg"), "\u{2713}.jpg");
        assert_eq!(percent_decode("100%.png"), "100%.png");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn version_comparison_follows_semver_order() {
        assert!(is_newer("v0.2.0", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(is_newer("v0.1.10", "0.1.9"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("v0.1.0", "0.2.0"));
        assert!(!is_newer("nightly", "0.1.0"));
        assert_eq!(parse_version("v1.2.3-rc.1"), Some((1, 2, 3)));
    }

    #[test]
    fn the_smoke_test_passes_with_the_native_codecs() {
        let report = std::env::temp_dir().join(format!("kvgrainy-smoke-{}.txt", std::process::id()));
        assert_eq!(smoke_test(report.to_str().unwrap()), 0, "{}", std::fs::read_to_string(&report).unwrap_or_default());
        let text = std::fs::read_to_string(&report).unwrap();
        assert!(text.contains("PASSED") && text.contains("PngPalette") && text.contains("Avif"), "{text}");
        std::fs::remove_file(report).unwrap();
    }

    #[test]
    fn only_existing_media_files_are_openable() {
        let dir = std::env::temp_dir().join(format!("kvgrainy-open-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = dir.join("a.PNG");
        let text = dir.join("b.txt");
        std::fs::write(&image, b"x").unwrap();
        std::fs::write(&text, b"x").unwrap();
        let args = vec![image.to_string_lossy().into_owned(), text.to_string_lossy().into_owned(), "--flag".into(), "missing.png".into()];
        assert_eq!(openable(&args), vec![image.to_string_lossy().into_owned()]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
