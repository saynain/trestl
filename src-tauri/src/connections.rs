use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use uuid::Uuid;

const MAX_CONNECTIONS: usize = 20;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    id: Uuid,
    name: String,
    url: String,
    #[serde(default)]
    server_version: Option<String>,
    #[serde(default)]
    bridge_version: Option<u64>,
}
impl Connection {
    fn label(&self) -> String {
        format!("remote-{}", self.id)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    version: u8,
    active: String,
    connections: Vec<Connection>,
}
impl Default for Saved {
    fn default() -> Self {
        Self {
            version: 1,
            active: "local".into(),
            connections: vec![],
        }
    }
}
pub struct Connections {
    file: PathBuf,
    saved: Mutex<Saved>,
    pub operation: tokio::sync::Mutex<()>,
    error: Mutex<Option<String>>,
    read_only: bool,
    pub persistent_sessions: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    active: String,
    connections: Vec<Connection>,
    open: Vec<String>,
    desktop_version: String,
    persistent_sessions: bool,
    error: Option<String>,
}
impl Connections {
    pub fn load(data: PathBuf) -> Self {
        let file = data.join("connections.json");
        let loaded = match std::fs::read(&file) {
            Ok(bytes) => decode_saved(&bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Saved::default()),
            Err(e) => Err(e.to_string()),
        };
        let (saved, error) = match loaded {
            Ok(saved) => (saved, None),
            Err(_) => (Saved::default(), Some("Could not read connections.json. Local is still available. Restore this file from a backup before changing connections.".into())),
        };
        Self {
            file,
            saved: Mutex::new(saved),
            operation: tokio::sync::Mutex::new(()),
            read_only: error.is_some(),
            error: Mutex::new(error),
            persistent_sessions: supports_persistent_sessions(),
        }
    }
    fn edit(&self, f: impl FnOnce(&mut Saved)) -> Result<(), String> {
        if self.read_only {
            return Err("Restore connections.json before changing connections.".into());
        }
        let mut saved = self.saved.lock().unwrap();
        let mut next = saved.clone();
        f(&mut next);
        let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(self.file.parent().unwrap())
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.file).map_err(|e| e.to_string())?;
        *saved = next;
        drop(saved);
        *self.error.lock().unwrap() = None;
        Ok(())
    }
    pub fn active(&self) -> String {
        self.saved.lock().unwrap().active.clone()
    }
    fn find(&self, id: &str) -> Result<Connection, String> {
        self.saved
            .lock()
            .unwrap()
            .connections
            .iter()
            .find(|c| c.id.to_string() == id)
            .cloned()
            .ok_or("Connection not found".into())
    }
}
fn decode_saved(bytes: &[u8]) -> Result<Saved, String> {
    let saved: Saved = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if saved.version != 1 || saved.connections.len() > MAX_CONNECTIONS {
        return Err("Unsupported connections file".into());
    }
    let mut origins = std::collections::HashSet::new();
    let mut ids = std::collections::HashSet::new();
    for c in &saved.connections {
        if normalize_url(&c.url)? != c.url
            || !origins.insert(&c.url)
            || !ids.insert(c.id)
            || c.name.is_empty()
            || c.name.chars().count() > 80
        {
            return Err("Invalid connection".into());
        }
    }
    if saved.active != "local"
        && !saved
            .connections
            .iter()
            .any(|c| c.id.to_string() == saved.active)
    {
        return Err("Invalid active connection".into());
    }
    Ok(saved)
}
fn supports_persistent_sessions() -> bool {
    #[cfg(target_os = "macos")]
    {
        // WKWebView only supports named persistent data stores on macOS 14+.
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|version| version.split('.').next()?.trim().parse::<u32>().ok())
            .is_some_and(|major| major >= 14)
    }
    #[cfg(not(target_os = "macos"))]
    true
}
pub fn normalize_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    let url = tauri::Url::parse(value)
        .map_err(|_| "Enter the full installation address, such as https://trestl.example.com")?;
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(
            "Use HTTPS for remote connections. HTTP is only supported on localhost.".into(),
        );
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use the installation's base address without a page path, credentials, query, or fragment.".into());
    }
    Ok(url.to_string())
}
fn clean_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect::<String>()
        .trim()
        .to_owned()
}
#[derive(Default)]
struct Metadata {
    name: Option<String>,
    version: Option<String>,
    bridge: Option<u64>,
}
fn metadata(value: &serde_json::Value) -> Result<Metadata, String> {
    if !value.get("needsSetup").is_some_and(|v| v.is_boolean())
        || !value.get("authenticated").is_some_and(|v| v.is_boolean())
    {
        return Err(
            "This address did not return a Trestl installation. Check the server address.".into(),
        );
    }
    Ok(Metadata {
        name: value["installationName"]
            .as_str()
            .map(clean_name)
            .filter(|s| !s.is_empty()),
        version: value["desktop"]["serverVersion"]
            .as_str()
            .map(|s| s.chars().take(40).collect()),
        bridge: value["desktop"]["bridgeVersion"].as_u64(),
    })
}
async fn probe(url: &str) -> Result<Metadata, String> {
    // No cookies, tokens, or credentials are copied from Local or another connection.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client.get(format!("{url}api/v1/auth/status")).send().await.map_err(|_| "Could not reach this installation. Check its address, network connection, and certificate.")?;
    if response.status().is_redirection() || matches!(response.status().as_u16(), 401 | 403) {
        return Ok(Metadata::default());
    } // Reverse-proxy sign-in; discover the name after login.
    if !response.status().is_success() {
        return Err(format!(
            "The installation returned HTTP {}. Try again when it is available.",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the installation information")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("The installation information is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    metadata(
        &serde_json::from_slice(&bytes)
            .map_err(|_| "This address did not return Trestl installation information")?,
    )
}
fn manager(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "connections" {
        Ok(())
    } else {
        Err("Use the Connections window for this action".into())
    }
}
fn available(app: &tauri::AppHandle) -> Result<(), String> {
    if crate::updates::installing(app) {
        Err("An update is being installed. Wait for Trestl to restart.".into())
    } else {
        Ok(())
    }
}
pub fn has_open_remote(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| label.starts_with("remote-"))
}
pub fn show_active(app: &tauri::AppHandle) {
    let state = app.state::<Connections>();
    let active = state.active();
    let label = if active == "local" {
        "main".into()
    } else {
        format!("remote-{active}")
    };
    if let Some(window) = app
        .get_webview_window(&label)
        .or_else(|| app.get_webview_window("main"))
    {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
pub fn open(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("connections") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(
        app,
        "connections",
        WebviewUrl::App("connections.html".into()),
    )
    .title("Connections — Trestl")
    .inner_size(520.0, 620.0)
    .min_inner_size(440.0, 500.0)
    .center();
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn open_async(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = open(&handle);
    });
}
#[tauri::command]
pub async fn connection_open(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    if window.label() != "main" && !window.label().starts_with("remote-") {
        return Err("Use a workspace to open Connections".into());
    }
    open(&app)
}
#[tauri::command]
pub fn connection_list(window: WebviewWindow, app: tauri::AppHandle) -> Result<Snapshot, String> {
    manager(&window)?;
    let state = app.state::<Connections>();
    let saved = state.saved.lock().unwrap().clone();
    let error = state.error.lock().unwrap().clone();
    Ok(Snapshot {
        active: saved.active,
        connections: saved.connections,
        open: app
            .webview_windows()
            .keys()
            .filter_map(|s| s.strip_prefix("remote-").map(str::to_owned))
            .collect(),
        desktop_version: app.package_info().version.to_string(),
        persistent_sessions: state.persistent_sessions,
        error,
    })
}
#[tauri::command]
pub async fn connection_add(
    window: WebviewWindow,
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    manager(&window)?;
    let state = app.state::<Connections>();
    let _operation = state.operation.lock().await;
    available(&app)?;
    let url = normalize_url(&url)?;
    {
        let saved = state.saved.lock().unwrap();
        if saved.connections.iter().any(|c| c.url == url) {
            return Err("This installation is already in your connections.".into());
        }
        if saved.connections.len() >= MAX_CONNECTIONS {
            return Err("You can save up to 20 remote connections.".into());
        }
    }
    let info = probe(&url).await?;
    let name = info
        .name
        .unwrap_or_else(|| tauri::Url::parse(&url).unwrap().host_str().unwrap().into());
    let entry = Connection {
        id: Uuid::new_v4(),
        name,
        url,
        server_version: info.version,
        bridge_version: info.bridge,
    };
    state.edit(|saved| saved.connections.push(entry))
}
fn bridge_script(connection: &Connection) -> String {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    let config = serde_json::json!({"bridgeVersion":1,"remote":true,"platform":platform,"name":connection.name,"origin":tauri::Url::parse(&connection.url).unwrap().origin().ascii_serialization(),"nativeChrome":connection.bridge_version==Some(1)});
    format!("if(location.origin === {origin}) {{ Object.defineProperty(window, '__TRESTL_DESKTOP__', {{value:Object.freeze({config}),writable:false}}); }}", origin=config["origin"], config=config)
}
const DISCOVER: &str = r#"if (window.__TRESTL_DESKTOP__ && location.origin === window.__TRESTL_DESKTOP__.origin) {
fetch('/api/v1/auth/status', {credentials:'same-origin'}).then(r => r.ok ? r.json() : null).then(info => {
 if (info && typeof info.installationName === 'string') window.__TAURI__.core.invoke('connection_metadata', {name:info.installationName, serverVersion:info.desktop?.serverVersion ?? null, bridgeVersion:info.desktop?.bridgeVersion ?? null}).catch(() => {});
}).catch(() => {});
}"#;
async fn activate_inner(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    available(app)?;
    let state = app.state::<Connections>();
    let label = if id == "local" {
        "main".into()
    } else {
        state.find(id)?.label()
    };
    let previous = state.active();
    if app.get_webview_window(&label).is_none() {
        let mut entry = state.find(id)?;
        let info = probe(&entry.url).await?;
        if let Some(name) = info.name {
            entry.name = name;
        }
        entry.server_version = info.version;
        entry.bridge_version = info.bridge;
        state.edit(|saved| {
            if let Some(c) = saved.connections.iter_mut().find(|c| c.id == entry.id) {
                *c = entry.clone();
            }
        })?;
        let origin = tauri::Url::parse(&entry.url).unwrap().origin();
        let auth_origin = origin.clone();
        let capability = tauri::ipc::CapabilityBuilder::new(format!("connection-{}", entry.id))
            .local(false)
            .window(&label)
            .remote(format!("{}/*", origin.ascii_serialization()))
            .permission("allow-connection-open")
            .permission("allow-connection-metadata");
        #[cfg(target_os = "macos")]
        let capability = capability
            .permission("core:window:allow-start-dragging")
            .permission("core:window:allow-internal-toggle-maximize");
        app.add_capability(capability).map_err(|e| e.to_string())?;
        let builder = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::External(tauri::Url::parse(&entry.url).unwrap()),
        )
        .title(format!(
            "{} — {}",
            entry.name,
            tauri::Url::parse(&entry.url).unwrap().host_str().unwrap()
        ))
        .inner_size(1320.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .visible(false)
        .initialization_script(bridge_script(&entry));
        #[cfg(target_os = "macos")]
        let builder = if state.persistent_sessions {
            builder.data_store_identifier(*entry.id.as_bytes())
        } else {
            builder.incognito(true)
        };
        #[cfg(not(target_os = "macos"))]
        let builder = builder.data_directory(
            state
                .file
                .parent()
                .unwrap()
                .join("connections")
                .join(entry.id.to_string()),
        );
        #[cfg(target_os = "macos")]
        let builder = if entry.bridge_version == Some(1) {
            builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(18.0, 20.0))
        } else {
            builder
        };
        let nav_app = app.clone();
        let nav_label = label.clone();
        let title_name = entry.name.clone();
        builder
            .on_navigation(move |url| {
                // HTTPS identity-provider redirects remain in this isolated session. Never grant
                // those origins IPC permissions, and never allow a redirect into Local's origin.
                if url.origin() == origin || url.scheme() == "https" {
                    if let Some(window) = nav_app.get_webview_window(&nav_label) {
                        let _ = window.set_title(&format!(
                            "{} — {}",
                            title_name,
                            url.host_str().unwrap_or_default()
                        ));
                    }
                    true
                } else {
                    crate::external(url);
                    false
                }
            })
            .on_new_window(move |url, _| {
                // Ordinary external links and unsupported popup sign-in open in the browser.
                crate::external(&url);
                tauri::webview::NewWindowResponse::Deny
            })
            .on_page_load(move |window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished
                    && payload.url().origin() == auth_origin
                {
                    let _ = window.eval(DISCOVER);
                }
            })
            .on_download(crate::download)
            .build()
            .map_err(|e| e.to_string())?;
    }
    let next = app
        .get_webview_window(&label)
        .ok_or("The connection window is unavailable")?;
    let previous_label = if previous == "local" {
        "main".into()
    } else {
        format!("remote-{previous}")
    };
    if let Some(old) = app
        .get_webview_window(&previous_label)
        .filter(|old| old.label() != label)
    {
        if let Ok(position) = old.outer_position() {
            let _ = next.set_position(position);
        }
        if let Ok(size) = old.inner_size() {
            let _ = next.set_size(size);
        }
    }
    if !state.read_only {
        state.edit(|saved| saved.active = id.into())?;
    }
    next.unminimize().map_err(|e| e.to_string())?;
    next.show().map_err(|e| e.to_string())?;
    next.set_focus().map_err(|e| e.to_string())?;
    // Hiding preserves DOM, drafts, cookies, and in-flight writes. No remote API contract required.
    for (other_label, window) in app.webview_windows() {
        if (other_label == "main" || other_label.starts_with("remote-")) && other_label != label {
            let _ = window.hide();
        }
    }
    Ok(())
}
pub async fn activate(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<Connections>();
    let _operation = state.operation.lock().await;
    activate_inner(app, id).await
}
#[tauri::command]
pub async fn connection_switch(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    manager(&window)?;
    activate(&app, &id).await?;
    window.close().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn connection_metadata(
    window: WebviewWindow,
    app: tauri::AppHandle,
    name: String,
    server_version: Option<String>,
    bridge_version: Option<u64>,
) -> Result<(), String> {
    let id = window
        .label()
        .strip_prefix("remote-")
        .ok_or("Only remote connections can report their name")?;
    let state = app.state::<Connections>();
    let entry = state.find(id)?;
    if window.url().map_err(|e| e.to_string())?.origin()
        != tauri::Url::parse(&entry.url).unwrap().origin()
    {
        return Err("Installation origin does not match".into());
    }
    let name = clean_name(&name);
    if name.is_empty() {
        return Err("Installation name is empty".into());
    }
    state.edit(|saved| {
        if let Some(c) = saved.connections.iter_mut().find(|c| c.id == entry.id) {
            c.name = name;
            c.server_version = server_version.map(|s| s.chars().take(40).collect());
            c.bridge_version = bridge_version;
        }
    })
}
#[tauri::command]
pub async fn connection_close_session(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    remove: bool,
) -> Result<bool, String> {
    manager(&window)?;
    let state = app.state::<Connections>();
    let _operation = state.operation.lock().await;
    available(&app)?;
    let entry = state.find(&id)?;
    let handle = app.get_webview_window(&entry.label());
    if handle.is_some() || remove {
        let confirmed = rfd::AsyncMessageDialog::new().set_title(if remove { "Remove connection?" } else { "Close remote session?" })
            .set_description(format!("{}\n\nSave any changes before continuing. Unsaved edits in this connection will be lost. {}", entry.name, if remove { "Its saved login will be cleared. Data on the server will not be deleted." } else { "Your saved login and connection will remain available." }))
            .set_buttons(rfd::MessageButtons::OkCancelCustom(if remove { "Remove connection".into() } else { "Close session".into() }, "Cancel".into())).show().await;
        if !matches!(
            confirmed,
            rfd::MessageDialogResult::Custom(_) | rfd::MessageDialogResult::Ok
        ) {
            return Ok(false);
        }
        // Custom button results contain the label, including Cancel; check it explicitly.
        if confirmed == rfd::MessageDialogResult::Custom("Cancel".into()) {
            return Ok(false);
        }
    }
    if remove && handle.is_none() {
        // Open the existing cookie store without loading any remote page so it can be cleared.
        let builder = WebviewWindowBuilder::new(
            &app,
            entry.label(),
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .visible(false);
        #[cfg(target_os = "macos")]
        let builder = if state.persistent_sessions {
            builder.data_store_identifier(*entry.id.as_bytes())
        } else {
            builder.incognito(true)
        };
        #[cfg(not(target_os = "macos"))]
        let builder = builder.data_directory(
            state
                .file
                .parent()
                .unwrap()
                .join("connections")
                .join(entry.id.to_string()),
        );
        builder.build().map_err(|e| e.to_string())?;
    }
    if remove {
        if let Some(window) = app.get_webview_window(&entry.label()) {
            window
                .clear_all_browsing_data()
                .map_err(|e| e.to_string())?;
        }
    }
    if state.active() == id {
        activate_inner(&app, "local").await?;
    }
    // destroy bypasses the user close-button handler; this explicit operation was confirmed.
    if let Some(window) = app.get_webview_window(&entry.label()) {
        window.destroy().map_err(|e| e.to_string())?;
    }
    if remove {
        state.edit(|saved| saved.connections.retain(|c| c.id != entry.id))?;
    }
    Ok(true)
}
#[tauri::command]
pub fn connection_browser(
    window: WebviewWindow,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    manager(&window)?;
    let entry = app.state::<Connections>().find(&id)?;
    open::that_detached(entry.url).map_err(|e| e.to_string())
}
pub async fn restore(app: tauri::AppHandle) {
    let active = app.state::<Connections>().active();
    if active != "local" {
        if let Err(error) = activate(&app, &active).await {
            let _ = activate(&app, "local").await;
            *app.state::<Connections>().error.lock().unwrap() = Some(format!(
                "Could not reopen your remote connection: {error} Local is available."
            ));
            let _ = open(&app);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_are_secure_canonical_installation_origins() {
        assert_eq!(
            normalize_url(" https://EXAMPLE.com:443 ").unwrap(),
            "https://example.com/"
        );
        assert!(normalize_url("http://127.0.0.1:4567").is_ok());
        assert!(normalize_url("http://[::1]:4567").is_ok());
        for url in [
            "http://example.com",
            "file:///tmp/app",
            "javascript:alert(1)",
            "https://u:p@example.com",
            "https://example.com/app",
            "https://example.com/?token=x",
            "https://example.com/#/home",
        ] {
            assert!(normalize_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn corrupted_future_duplicate_and_path_traversal_profiles_are_rejected() {
        assert!(decode_saved(br#"{"version":2,"active":"local","connections":[]}"#).is_err());
        let entry = Connection {
            id: Uuid::new_v4(),
            name: "Work".into(),
            url: "https://example.com/".into(),
            server_version: None,
            bridge_version: None,
        };
        let saved = Saved {
            version: 1,
            active: "local".into(),
            connections: vec![entry.clone(), entry],
        };
        assert!(decode_saved(&serde_json::to_vec(&saved).unwrap()).is_err());
        assert!(decode_saved(br#"{"version":1,"active":"local","connections":[{"id":"../../other","name":"X","url":"https://example.com/"}]}"#).is_err());
    }
    #[test]
    fn older_and_newer_servers_do_not_require_matching_desktop_versions() {
        let old = metadata(&serde_json::json!({"needsSetup":false,"authenticated":false,"installationName":"Remote team"})).unwrap();
        assert_eq!(old.name.as_deref(), Some("Remote team"));
        assert_eq!(old.bridge, None);
        let new = metadata(&serde_json::json!({"needsSetup":false,"authenticated":false,"installationName":"Other","desktop":{"serverVersion":"9.0.0","bridgeVersion":9}})).unwrap();
        assert_eq!(new.version.as_deref(), Some("9.0.0"));
        assert_eq!(new.bridge, Some(9));
        assert!(metadata(&serde_json::json!({"message":"Not Trestl"})).is_err());
    }
    #[test]
    fn connection_preferences_round_trip_without_changing_identity() {
        let temp = tempfile::tempdir().unwrap();
        let state = Connections::load(temp.path().into());
        let entry = Connection {
            id: Uuid::new_v4(),
            name: "Remote".into(),
            url: "https://example.com/".into(),
            server_version: None,
            bridge_version: None,
        };
        state
            .edit(|saved| {
                saved.active = entry.id.to_string();
                saved.connections.push(entry.clone());
            })
            .unwrap();
        let loaded = Connections::load(temp.path().into());
        assert_eq!(loaded.active(), entry.id.to_string());
        assert_eq!(loaded.find(&entry.id.to_string()).unwrap().url, entry.url);
    }
}
