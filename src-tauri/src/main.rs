#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::{DownloadEvent, NewWindowResponse},
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};

struct Service(Mutex<Option<Child>>);
impl Service {
    fn stop_for_update(&self) -> Result<(), String> {
        let mut guard = self.0.lock().unwrap();
        let child = guard
            .as_mut()
            .ok_or("The database process is unavailable")?;
        writeln!(
            child
                .stdin
                .as_mut()
                .ok_or("The database control pipe is closed")?,
            "shutdown"
        )
        .map_err(|error| error.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
                guard.take();
                return if status.success() {
                    Ok(())
                } else {
                    Err("The database did not exit cleanly".into())
                };
            }
            if Instant::now() >= deadline {
                return Err("Database shutdown timed out".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn stop(&self) {
        let mut guard = self.0.lock().unwrap();
        if let Some(mut child) = guard.take() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = writeln!(stdin, "shutdown");
            }
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.stop();
    }
}

fn external(url: &tauri::Url) {
    if matches!(url.scheme(), "https" | "http" | "mailto") {
        let _ = open::that_detached(url.as_str());
    }
}

/// Reads the service's launch message. Progress lines keep the wait open during one-time
/// work such as a pre-upgrade backup; a silent service still times out after `quiet`.
fn launch_message(
    stdout: impl std::io::Read + Send + 'static,
    quiet: Duration,
    limit: Duration,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let result = reader.read_line(&mut line).map(|_| line);
            let progress = matches!(&result, Ok(line) if line.starts_with("{\"status\""));
            let _ = tx.send(result);
            if !progress {
                break;
            }
        }
        // Drain stdout without logging the launch credential.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let deadline = Instant::now() + limit;
    loop {
        let line = rx.recv_timeout(quiet)??;
        let value: serde_json::Value = serde_json::from_str(&line)?;
        if value.get("status").is_none() || Instant::now() > deadline {
            return Ok(value);
        }
    }
}

fn start(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let resources = app.path().resource_dir()?.join("resources");
    // Tauri places externalBin beside the application executable on all desktop targets.
    let executable = std::env::current_exe()?
        .parent()
        .unwrap()
        .join(if cfg!(windows) {
            "trestl-node.exe"
        } else {
            "trestl-node"
        });
    let log = std::fs::File::create(data.join("desktop.log"))?;
    let mut command = Command::new(executable);
    command
        .arg(resources.join("server.cjs"))
        .current_dir(&data)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(log);
    // Retain only OS runtime paths. No NODE_OPTIONS, hosted DB, or proxy-auth inheritance.
    for name in [
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LOCALAPPDATA",
        "APPDATA",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let service = Service(Mutex::new(Some(child)));
    writeln!(
        service
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .stdin
            .as_mut()
            .unwrap(),
        "{}",
        serde_json::json!({"dataDir": data, "resources": resources})
    )?;
    let ready = launch_message(
        stdout,
        Duration::from_secs(90),
        Duration::from_secs(60 * 60),
    )?;
    let url: tauri::Url = ready["url"]
        .as_str()
        .ok_or("Missing desktop launch URL")?
        .parse()?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("Invalid desktop launch URL".into());
    }
    let origin = url.origin();
    let popup_origin = origin.clone();
    // Only this app's exact loopback origin may drag/zoom its own native window.
    // No filesystem, process, network, or shell commands are exposed to web content.
    #[cfg(target_os = "macos")]
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("native-titlebar")
            .local(false)
            .window("main")
            .remote(format!("{}/*", origin.ascii_serialization()))
            .permission("core:window:allow-start-dragging")
            .permission("core:window:allow-internal-toggle-maximize"),
    )?;
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("workspace-update-preparation")
            .local(false)
            .window("main")
            .remote(format!("{}/*", origin.ascii_serialization()))
            .permission("allow-update-prepared"),
    )?;
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("update-controls")
            .window("updates")
            .permission("allow-update-status")
            .permission("allow-update-check")
            .permission("allow-update-download")
            .permission("allow-update-install")
            .permission("allow-update-close")
            .permission("allow-update-releases")
            .permission("core:window:allow-start-dragging"),
    )?;
    app.manage(service);
    let menu = Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                "Trestl",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About Trestl"), None)?,
                    &MenuItem::with_id(app, "updates", "Check for Updates…", true, None::<&str>)?,
                    &MenuItem::with_id(app, "data", "Open Data Folder", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some("Quit Trestl"))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::fullscreen(app, None)?,
                ],
            )?,
        ],
    )?;
    app.set_menu(menu)?;
    app.on_menu_event(move |app, event| {
        if event.id().as_ref() == "updates" {
            let _ = updates::open(app, true);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                updates::check(handle, false).await;
            });
        }
        if event.id().as_ref() == "data" {
            let _ = open::that_detached(&data);
        }
    });
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url));
    #[cfg(target_os = "macos")]
    let window = window
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0));
    window
        .title("Trestl")
        .inner_size(1320.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |url| {
            if url.origin() == origin {
                return true;
            }
            external(url);
            false
        })
        .on_new_window(move |url, _| {
            if url.origin() != popup_origin {
                external(&url);
            }
            NewWindowResponse::Deny
        })
        .on_download(|webview, event| {
            let notify = |url: &tauri::Url, status: &str| {
                let detail = serde_json::json!({"url": url.as_str(), "status": status});
                let _ = webview.eval(format!("window.dispatchEvent(new CustomEvent('trestl:download', {{detail: {detail}}}))"));
            };
            match event {
                DownloadEvent::Requested { destination, url } => {
                    let name = destination.file_name().unwrap_or_default().to_string_lossy().into_owned();
                    if let Some(path) = rfd::FileDialog::new().set_file_name(name).save_file() {
                        *destination = path;
                    } else {
                        notify(&url, "cancelled");
                        return false;
                    }
                }
                DownloadEvent::Finished { url, success, .. } => notify(&url, if success { "saved" } else { "failed" }),
                _ => (),
            }
            true
        })
        .build()?;
    let handle = app.handle().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = handle.state::<Service>();
        let mut guard = state.0.lock().unwrap();
        let Some(child) = guard.as_mut() else {
            break;
        };
        if let Ok(Some(_)) = child.try_wait() {
            guard.take();
            drop(guard);
            let dialog_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                rfd::MessageDialog::new().set_title("Trestl stopped unexpectedly")
                    .set_description("The local database process stopped. Restart Trestl to continue. Check desktop.log in the data folder if this happens again.")
                    .set_level(rfd::MessageLevel::Error).show();
                dialog_handle.exit(1);
            });
            break;
        }
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![updates::update_status, updates::update_check,
            updates::update_download, updates::update_install, updates::update_prepared,
            updates::update_close, updates::update_releases])
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(updates::Updates::new(app.package_info().version.to_string()));
            if let Err(error) = start(app) {
                rfd::MessageDialog::new().set_title("Trestl could not start")
                    .set_description(format!("{error}\n\nYour data has been kept. Check desktop.log in the Trestl data folder for details."))
                    .set_level(rfd::MessageLevel::Error).show();
                return Err(error);
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                loop {
                    updates::check(handle.clone(), true).await;
                    tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Trestl desktop");
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(service) = app.try_state::<Service>() {
                service.stop();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_message_waits_through_progress_lines() {
        let output = "{\"status\":\"starting\"}\n{\"status\":\"starting\"}\n{\"url\":\"http://127.0.0.1:9/x\"}\nlater\n";
        let message = launch_message(
            std::io::Cursor::new(output),
            Duration::from_secs(5),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(message["url"], "http://127.0.0.1:9/x");
        assert!(launch_message(
            std::io::Cursor::new(""),
            Duration::from_secs(5),
            Duration::from_secs(60)
        )
        .is_err());
    }
}
