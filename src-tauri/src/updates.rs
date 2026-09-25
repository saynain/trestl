use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

const ENDPOINT: &str = "https://github.com/saynain/trestl/releases/latest/download/latest.json";
const RELEASES: &str = "https://github.com/saynain/trestl/releases/latest";
const PUBLIC_KEY: &str = include_str!("../updater.pub");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    phase: String,
    current_version: String,
    version: Option<String>,
    notes: String,
    downloaded: u64,
    total: Option<u64>,
    message: String,
    installable: bool,
}
struct Inner {
    status: Status,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    preparation: Option<(u64, oneshot::Sender<Result<(), String>>)>,
    next_request: u64,
}
pub struct Updates(Mutex<Inner>);
impl Updates {
    pub fn new(version: String) -> Self {
        let installable = !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some();
        Self(Mutex::new(Inner {
            status: Status {
                phase: "idle".into(),
                current_version: version,
                version: None,
                notes: String::new(),
                downloaded: 0,
                total: None,
                message: String::new(),
                installable,
            },
            update: None,
            bytes: None,
            preparation: None,
            next_request: 0,
        }))
    }
}
fn trusted(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "updates" {
        Ok(())
    } else {
        Err("Update controls are only available in the Updates window".into())
    }
}
fn change(app: &tauri::AppHandle, f: impl FnOnce(&mut Inner)) {
    f(&mut app.state::<Updates>().0.lock().unwrap());
}
fn fail(app: &tauri::AppHandle, message: &str) {
    change(app, |inner| {
        inner.status.phase = "error".into();
        inner.status.message = message.into();
    });
}
pub fn open(app: &tauri::AppHandle, focus: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("updates") {
        window.show()?;
        if focus {
            window.set_focus()?;
        }
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(app, "updates", WebviewUrl::App("updates.html".into()))
        .title("Trestl Updates")
        .inner_size(480.0, 510.0)
        .resizable(false)
        .maximizable(false)
        .focused(focus)
        .center();
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder
        .on_navigation(|url| {
            // The update window may never navigate to release notes or a remote page.
            url.scheme() == "tauri" || matches!(url.host_str(), Some("tauri.localhost"))
        })
        .build()?;
    Ok(())
}
#[tauri::command]
pub fn update_status(window: WebviewWindow, app: tauri::AppHandle) -> Result<Status, String> {
    trusted(&window)?;
    Ok(app.state::<Updates>().0.lock().unwrap().status.clone())
}
#[tauri::command]
pub async fn update_check(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    trusted(&window)?;
    check(app, false).await;
    Ok(())
}
pub async fn check(app: tauri::AppHandle, background: bool) {
    {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap();
        if matches!(
            inner.status.phase.as_str(),
            "checking" | "downloading" | "ready" | "preparing" | "installing"
        ) {
            return;
        }
        inner.status.phase = "checking".into();
        inner.status.message.clear();
    }
    let result = async {
        app.updater_builder()
            .pubkey(PUBLIC_KEY.trim())
            .endpoints(vec![ENDPOINT.parse().unwrap()])?
            .timeout(Duration::from_secs(20))
            .build()?
            .check()
            .await
    }
    .await;
    match result {
        Ok(Some(mut update)) => {
            // The feed can only point to our immutable GitHub release assets.
            if !allowed_download(update.download_url.as_str()) {
                fail(&app, "The update contains an unexpected download address. Please try again later.");
                return;
            }
            update.timeout = Some(Duration::from_secs(15 * 60));
            let newly_available = {
                let state = app.state::<Updates>();
                let mut inner = state.0.lock().unwrap();
                let fresh = inner.status.version.as_deref() != Some(&update.version);
                inner.status.phase = "available".into();
                inner.status.version = Some(update.version.clone());
                inner.status.notes = update.body.clone().unwrap_or_default();
                inner.update = Some(update);
                fresh
            };
            if background && newly_available { let _ = open(&app, false); }
        }
        Ok(None) => change(&app, |inner| {
            inner.status.phase = "current".into(); inner.status.version = None;
            inner.status.notes.clear(); inner.update = None;
        }),
        Err(_) => fail(&app, "Could not check for updates. Check your connection and try again. Downloads become available when the GitHub release is public."),
    }
}
fn allowed_download(value: &str) -> bool {
    let Ok(url) = tauri::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .path()
            .starts_with("/saynain/trestl/releases/download/v")
}
#[tauri::command]
pub async fn update_download(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    trusted(&window)?;
    let update = {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap();
        if !inner.status.installable
            || !matches!(inner.status.phase.as_str(), "available" | "error")
        {
            return Err("No downloadable update is available".into());
        }
        let update = inner.update.clone().ok_or("Check for updates first")?;
        inner.status.phase = "downloading".into();
        inner.status.message.clear();
        inner.status.downloaded = 0;
        inner.status.total = None;
        update
    };
    let result = update
        .download(
            |chunk, total| {
                change(&app, |inner| {
                    inner.status.downloaded += chunk as u64;
                    inner.status.total = total;
                })
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => change(&app, |inner| { inner.bytes = Some(bytes); inner.status.phase = "ready".into(); }),
        Err(_) => fail(&app, "The update could not be downloaded or its signature could not be verified. Your installed app has not changed. Try again."),
    }
    Ok(())
}
#[tauri::command]
pub fn update_prepared(
    window: WebviewWindow,
    app: tauri::AppHandle,
    request: u64,
    error: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the workspace may confirm it is saved".into());
    }
    let state = app.state::<Updates>();
    let mut inner = state.0.lock().unwrap();
    if inner
        .preparation
        .as_ref()
        .is_some_and(|(id, _)| *id == request)
    {
        let (_, sender) = inner.preparation.take().unwrap();
        let _ = sender.send(error.map_or(Ok(()), Err));
    }
    Ok(())
}
fn thaw(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval("window.dispatchEvent(new Event('trestl:update-cancelled'))");
    }
}
#[tauri::command]
pub async fn update_install(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    trusted(&window)?;
    let (receiver, request) = {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap();
        if inner.status.phase != "ready" || inner.bytes.is_none() {
            return Err("Download and verify the update first".into());
        }
        inner.status.phase = "preparing".into();
        inner.status.message.clear();
        inner.next_request += 1;
        let request = inner.next_request;
        let (sender, receiver) = oneshot::channel();
        inner.preparation = Some((request, sender));
        (receiver, request)
    };
    let Some(main) = app.get_webview_window("main") else {
        change(&app, |inner| {
            inner.preparation = None;
            inner.status.phase = "ready".into();
            inner.status.message = "Reopen the workspace before installing the update.".into();
        });
        return Ok(());
    };
    let _ = main.eval(format!(
        "window.dispatchEvent(new CustomEvent('trestl:prepare-update', {{detail: {request}}}))"
    ));
    let result = tokio::time::timeout(Duration::from_secs(30), receiver).await;
    let error = match result {
        Ok(Ok(Ok(()))) => None,
        Ok(Ok(Err(message))) => Some(message),
        _ => {
            Some("The workspace did not confirm it is ready. Save your work and try again.".into())
        }
    };
    if let Some(error) = error {
        change(&app, |inner| {
            inner.preparation = None;
            inner.status.phase = "ready".into();
            inner.status.message = error;
        });
        thaw(&app);
        return Ok(());
    }
    change(&app, |inner| inner.status.phase = "installing".into());
    // Never run an installer while PGlite/Node still owns the database or app files.
    let handle = app.clone();
    let stopped = tauri::async_runtime::spawn_blocking(move || {
        handle.state::<crate::Service>().stop_for_update()
    })
    .await;
    if !matches!(stopped, Ok(Ok(()))) {
        fail(&app, "The database could not shut down cleanly. The update was not installed. Quit and reopen Trestl before trying again.");
        return Ok(());
    }
    let (update, bytes) = {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap();
        (inner.update.clone().unwrap(), inner.bytes.take().unwrap())
    };
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = update.install(bytes) {
            // The verified download is safe but installation can fail (for example permissions).
            // Reopen the current application to reconnect its already-flushed database.
            rfd::MessageDialog::new()
                .set_title("Update could not be installed")
                .set_description(format!(
                    "{error}\n\nTrestl will reopen. Your local data has been kept."
                ))
                .set_level(rfd::MessageLevel::Error)
                .show();
        }
        handle.restart();
    });
    Ok(())
}
#[tauri::command]
pub fn update_close(window: WebviewWindow) -> Result<(), String> {
    trusted(&window)?;
    window.close().map_err(|error| error.to_string())
}
#[tauri::command]
pub fn update_releases(window: WebviewWindow) -> Result<(), String> {
    trusted(&window)?;
    open::that_detached(RELEASES).map_err(|error| error.to_string())
}
#[cfg(test)]
mod tests {
    use super::allowed_download;
    #[test]
    fn only_our_https_release_downloads_are_accepted() {
        assert!(allowed_download(
            "https://github.com/saynain/trestl/releases/download/v0.5.0/Trestl.app.tar.gz"
        ));
        for url in [
            "http://github.com/saynain/trestl/releases/download/v1/app",
            "https://github.com/other/repo/releases/download/v1/app",
            "https://github.com.evil.test/saynain/trestl/releases/download/v1/app",
            "https://user@github.com/saynain/trestl/releases/download/v1/app",
            "file:///tmp/update",
        ] {
            assert!(!allowed_download(url));
        }
    }
}
