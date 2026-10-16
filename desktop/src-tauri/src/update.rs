//! In-app updates. At start-up, and from the footer button, the app reads the newest GitHub release,
//! and if it is newer than this build it offers to install it: download the installer for this
//! system, check its SHA-256 against the digest GitHub recorded for the asset, run it silently, and
//! start the new version.
//!
//! Tauri's own updater plugin would do this with signed manifests, but every version of it depends on
//! a `zip` crate release that has been yanked, so it cannot be built (docs/release.md). The checksum
//! here proves the download is intact and is the file attached to that release; it does not prove who
//! published the release, which the installers' code signature will once there are certificates.
//!
//! Automatic install is implemented for Windows (the NSIS installer) and for a Linux AppImage. On
//! macOS, and for a Linux install from a package, the update dialog opens the release page instead.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// Where releases are published. The check reads the newest one and compares its tag with this build.
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/gerp93/KVGrainy/releases/latest";

/// `major.minor.patch` from a tag such as `v1.2.3` (anything after a `-` or `+` is ignored).
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>());
    Some((parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    matches!((parse_version(latest), parse_version(current)), (Some(l), Some(c)) if l > c)
}

/// A downloadable file attached to a release.
#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    pub name: String,
    pub url: String,
    /// Lower-case hex SHA-256, from the `digest` field GitHub records for each asset.
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct Release {
    pub tag: String,
    pub page: String,
    pub assets: Vec<Asset>,
}

fn release_from_json(json: &serde_json::Value) -> Result<Release, String> {
    let tag = json["tag_name"].as_str().ok_or("the release has no tag")?.to_string();
    let page = json["html_url"].as_str().ok_or("the release has no page")?.to_string();
    let assets = json["assets"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let digest = a["digest"].as_str()?.strip_prefix("sha256:")?.to_ascii_lowercase();
                    Some(Asset { name: a["name"].as_str()?.to_string(), url: a["browser_download_url"].as_str()?.to_string(), sha256: digest })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Release { tag, page, assets })
}

fn latest_release() -> Result<Release, String> {
    let mut response = ureq::get(LATEST_RELEASE_API)
        .header("User-Agent", concat!("kvgrainy-desktop/", env!("CARGO_PKG_VERSION")))
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = response.body_mut().read_json().map_err(|e| e.to_string())?;
    release_from_json(&json)
}

/// What kind of install this process is, which decides which release file replaces it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Platform {
    Windows,
    AppImage,
    /// macOS, or a Linux install from a package: update by hand from the release page.
    Manual,
}

pub fn platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some() {
        Platform::AppImage
    } else {
        Platform::Manual
    }
}

/// The release file that replaces this install, or `None` when there is none (or it has no digest).
pub fn pick_asset(assets: &[Asset], platform: Platform) -> Option<&Asset> {
    let suffix = match platform {
        Platform::Windows => "_x64-setup.exe",
        Platform::AppImage => "_amd64.AppImage",
        Platform::Manual => return None,
    };
    assets.iter().find(|a| a.name.ends_with(suffix))
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    /// 0 to 1 while downloading.
    fraction: f64,
}

/// Download `asset` to `dest`, emitting progress, and fail unless its SHA-256 matches. On failure
/// nothing is left at `dest`.
fn download_verified(app: &AppHandle, asset: &Asset, dest: &Path) -> Result<(), String> {
    let mut response = ureq::get(&asset.url)
        .header("User-Agent", concat!("kvgrainy-desktop/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| format!("could not download {}: {e}", asset.name))?;
    let total: Option<u64> = response.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok());
    let mut reader = response.body_mut().with_config().limit(1 << 30).reader();
    let mut file = std::fs::File::create(dest).map_err(|e| format!("could not write {}: {e}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    let (mut done, mut last_reported) = (0u64, 0.0f64);
    let result = (|| -> Result<(), String> {
        loop {
            let n = reader.read(&mut buffer).map_err(|e| format!("download interrupted: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            file.write_all(&buffer[..n]).map_err(|e| format!("could not write {}: {e}", dest.display()))?;
            done += n as u64;
            if let Some(total) = total.filter(|t| *t > 0) {
                let fraction = (done as f64 / total as f64).min(1.0);
                if fraction - last_reported >= 0.01 {
                    last_reported = fraction;
                    let _ = app.emit("update-progress", UpdateProgress { fraction });
                }
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        let actual = to_hex(&hasher.finalize());
        if actual != asset.sha256 {
            return Err(format!("the downloaded {} does not match its published checksum, so it was not installed", asset.name));
        }
        Ok(())
    })();
    if result.is_err() {
        drop(file);
        let _ = std::fs::remove_file(dest);
    }
    result
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Run the downloaded installer once this process has exited, then start the app again. The short
/// wait lets this process release the install folder; the installer runs silently and, being
/// per-user, needs no elevation.
#[cfg(windows)]
fn install_and_restart(app: &AppHandle, installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let script = format!(
        r#"/C ping -n 4 127.0.0.1 >nul & "{}" /S & start "" "{}""#,
        installer.display(),
        exe.display()
    );
    std::process::Command::new("cmd")
        .raw_arg(script)
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| format!("could not start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Replace the AppImage file with the downloaded one, then start it.
#[cfg(target_os = "linux")]
fn install_and_restart_appimage(app: &AppHandle, downloaded: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let target = PathBuf::from(std::env::var_os("APPIMAGE").ok_or("not running from an AppImage")?);
    std::fs::set_permissions(downloaded, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    // Same folder, so the rename is atomic and replaces the running file.
    std::fs::rename(downloaded, &target).map_err(|e| format!("could not replace {}: {e}", target.display()))?;
    std::process::Command::new(&target).spawn().map_err(|e| format!("could not start the new version: {e}"))?;
    app.exit(0);
    Ok(())
}

fn update_dir() -> PathBuf {
    std::env::temp_dir().join("kvgrainy-update")
}

/// Download, check and install `asset`; on success this process exits and the new version starts.
fn install(app: &AppHandle, asset: &Asset, platform: Platform) -> Result<(), String> {
    match platform {
        Platform::Windows => {
            #[cfg(windows)]
            {
                let dir = update_dir();
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let installer = dir.join(&asset.name);
                download_verified(app, asset, &installer)?;
                return install_and_restart(app, &installer);
            }
            #[cfg(not(windows))]
            Err("a Windows installer cannot run here".into())
        }
        Platform::AppImage => {
            #[cfg(target_os = "linux")]
            {
                let target = PathBuf::from(std::env::var_os("APPIMAGE").ok_or("not running from an AppImage")?);
                let staged = target.with_extension("AppImage.new");
                download_verified(app, asset, &staged)?;
                return install_and_restart_appimage(app, &staged).inspect_err(|_| {
                    let _ = std::fs::remove_file(&staged);
                });
            }
            #[cfg(not(target_os = "linux"))]
            Err("an AppImage cannot be replaced here".into())
        }
        Platform::Manual => Err("this install is updated from the release page".into()),
    }
}

/// Look for a newer release and offer to install it. `silent` is the start-up check: it says nothing
/// unless there is a newer release.
pub async fn check(app: AppHandle, silent: bool) -> Result<(), String> {
    let checked = tauri::async_runtime::spawn_blocking(latest_release).await.map_err(|e| e.to_string())?;
    let release = match checked {
        Ok(found) => found,
        Err(_) if silent => return Ok(()),
        Err(error) => return Err(format!("could not check for updates: {error}")),
    };
    let current = app.package_info().version.to_string();
    let dialog = app.clone();
    if !is_newer(&release.tag, &current) {
        if !silent {
            let message = format!("You're running the latest version ({current}).");
            let _ = tauri::async_runtime::spawn_blocking(move || dialog.dialog().message(message).title("Up to date").blocking_show()).await;
        }
        return Ok(());
    }
    let platform = platform();
    let asset = pick_asset(&release.assets, platform).cloned();
    let (message, accept) = match &asset {
        Some(_) => (
            format!("KVGrainy {} is available (you have {current}).\n\nDownload and install it now? The app restarts.", release.tag),
            "Install and restart",
        ),
        None => (format!("KVGrainy {} is available (you have {current}).\n\nOpen the download page?", release.tag), "Open download page"),
    };
    let ask = dialog.clone();
    let accepted = tauri::async_runtime::spawn_blocking(move || {
        ask.dialog()
            .message(message)
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(accept.into(), "Later".into()))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())?;
    if !accepted {
        return Ok(());
    }
    match asset {
        Some(asset) => {
            let handle = app.clone();
            let installed = tauri::async_runtime::spawn_blocking(move || install(&handle, &asset, platform)).await.map_err(|e| e.to_string())?;
            installed
        }
        None => tauri_plugin_opener::open_url(release.page, None::<&str>).map_err(|e| e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn sample() -> Release {
        let json = serde_json::json!({
            "tag_name": "v1.2.3",
            "html_url": "https://example.test/release",
            "assets": [
                {"name": "KVGrainy_1.2.3_x64-setup.exe", "browser_download_url": "https://example.test/a.exe", "digest": "sha256:ABCDEF"},
                {"name": "KVGrainy_1.2.3_amd64.AppImage", "browser_download_url": "https://example.test/a.AppImage", "digest": "sha256:0123"},
                {"name": "KVGrainy_1.2.3_aarch64.dmg", "browser_download_url": "https://example.test/a.dmg", "digest": "sha256:00"},
                {"name": "no-digest.exe", "browser_download_url": "https://example.test/b.exe", "digest": null}
            ]
        });
        release_from_json(&json).unwrap()
    }

    #[test]
    fn release_json_keeps_only_assets_with_a_sha256_digest() {
        let release = sample();
        assert_eq!(release.tag, "v1.2.3");
        assert_eq!(release.assets.len(), 3);
        assert_eq!(release.assets[0].sha256, "abcdef");
    }

    #[test]
    fn the_right_file_is_chosen_for_each_install_kind() {
        let release = sample();
        assert_eq!(pick_asset(&release.assets, Platform::Windows).unwrap().name, "KVGrainy_1.2.3_x64-setup.exe");
        assert_eq!(pick_asset(&release.assets, Platform::AppImage).unwrap().name, "KVGrainy_1.2.3_amd64.AppImage");
        assert!(pick_asset(&release.assets, Platform::Manual).is_none());
    }

    #[test]
    fn hex_is_lower_case_and_zero_padded() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xa0, 0xff]), "000fa0ff");
    }
}
