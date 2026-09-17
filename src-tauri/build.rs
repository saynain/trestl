fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
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
