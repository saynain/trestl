fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connection_open",
            "connection_list",
            "connection_add",
            "connection_switch",
            "connection_metadata",
            "connection_close_session",
            "connection_browser",
            "update_status",
            "update_check",
            "update_download",
            "update_install",
            "update_prepared",
            "update_close",
            "update_releases",
        ]),
    ))
    .expect("Failed to build Trestl desktop permissions");
}
