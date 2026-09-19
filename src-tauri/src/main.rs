#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connections;
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

fn download(webview: tauri::Webview<tauri::Wry>, event: DownloadEvent<'_>) -> bool {
    let notify = |url: &tauri::Url, status: &str| {
        let detail = serde_json::json!({"url": url.as_str(), "status": status});
        let _ = webview.eval(format!(
            "window.dispatchEvent(new CustomEvent('trestl:download', {{detail: {detail}}}))"
        ));
    };
    match event {
        DownloadEvent::Requested { destination, url } => {
            let name = destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if let Some(path) = rfd::FileDialog::new().set_file_name(name).save_file() {
                *destination = path;
            } else {
                notify(&url, "cancelled");
                return false;
            }
        }
        DownloadEvent::Finished { url, success, .. } => {
            notify(&url, if success { "saved" } else { "failed" })
        }
        _ => (),
    }
    true
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
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
        // Drain stdout without logging the launch credential.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let line = rx.recv_timeout(Duration::from_secs(90))??;
    let ready: serde_json::Value = serde_json::from_str(&line)?;
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
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("local-connections")
            .local(false)
            .window("main")
            .remote(format!("{}/*", origin.ascii_serialization()))
            .permission("allow-connection-open"),
    )?;
    app.add_capability(
        tauri::ipc::CapabilityBuilder::new("connection-manager")
            .window("connections")
            .permission("allow-connection-list")
            .permission("allow-connection-add")
            .permission("allow-connection-switch")
            .permission("allow-connection-close-session")
            .permission("allow-connection-browser")
            .permission("core:window:allow-start-dragging"),
    )?;
    app.manage(connections::Connections::load(data.clone()));
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
                "Connections",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "connections",
                        "Switch Connection…",
                        true,
                        Some("CmdOrCtrl+Shift+K"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "connection-local",
                        "Local",
                        true,
                        Some("CmdOrCtrl+1"),
                    )?,
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
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = updates::open(&handle, true);
                updates::check(handle, false).await;
            });
        }
        if event.id().as_ref() == "connections" {
            connections::open_async(app);
        }
        if event.id().as_ref() == "connection-local" {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = connections::activate(&handle, "local").await;
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
        .title("Trestl — Local")
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
        .on_download(download)
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
            updates::update_close, updates::update_releases,
            connections::connection_open, connections::connection_list, connections::connection_add,
            connections::connection_switch, connections::connection_metadata,
            connections::connection_close_session, connections::connection_browser])
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            connections::show_active(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default()
            // Connection switching owns visibility. Restoring it could expose a hidden session.
            .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
            .with_filter(|label| label == "main" || label.starts_with("remote-"))
            .build())
        .on_window_event(|window, event| {
            if window.label() == "main" || window.label().starts_with("remote-") {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    window.app_handle().exit(0);
                }
            }
        })
        .setup(|app| {
            app.manage(updates::Updates::new(app.package_info().version.to_string()));
            if let Err(error) = start(app) {
                rfd::MessageDialog::new().set_title("Trestl could not start")
                    .set_description(format!("{error}\n\nYour data has been kept. Check desktop.log in the Trestl data folder for details."))
                    .set_level(rfd::MessageLevel::Error).show();
                return Err(error);
            }
            tauri::async_runtime::spawn(connections::restore(app.handle().clone()));
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
        if let RunEvent::ExitRequested { api, .. } = &event {
            if connections::has_open_remote(app) && !updates::installing(app) {
                let result = rfd::MessageDialog::new().set_title("Quit Trestl?")
                    .set_description("Open remote sessions will close. Save changes in each connection before quitting.")
                    .set_buttons(rfd::MessageButtons::OkCancelCustom("Quit Trestl".into(), "Cancel".into())).show();
                if result != rfd::MessageDialogResult::Custom("Quit Trestl".into()) && result != rfd::MessageDialogResult::Ok {
                    api.prevent_exit(); return;
                }
            }
        }
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(service) = app.try_state::<Service>() {
                service.stop();
            }
        }
    });
}
