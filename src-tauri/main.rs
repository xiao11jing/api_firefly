//! 桌面壳入口（Tauri 2 / Ubuntu ARM64 .deb）
//!
//! 前端就是仓库根目录的 index.html + js/（由 scripts/build-frontend.mjs 组装到 dist/），
//! 本文件只负责窗口生命周期与运行环境准备。

// Windows 发布构建不弹控制台窗口（Linux 目标下无效果）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 把用户授权的学习工作区目录动态加入 fs scope（对话框选中的目录在 $APPDATA 之外）。
/// 应用自定义 command 不需要 capability 权限；路径校验在前端 vault.js 与弹窗确认之外，
/// 这里再要求绝对路径，避免相对路径逃逸。
#[tauri::command]
fn allow_vault_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("工作区路径必须是绝对路径".into());
    }
    app.fs_scope()
        .allow_directory(&p, true)
        .map_err(|e| e.to_string())
}

fn main() {
    // PRoot / 容器环境里 bubblewrap 沙箱起不来，未显式配置时默认关闭 WebKit 沙箱，
    // 需要沙箱的环境可自行设置 WEBKIT_FORCE_SANDBOX=1 覆盖。
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_FORCE_SANDBOX").is_none() {
        std::env::set_var("WEBKIT_FORCE_SANDBOX", "0");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init()) // FileStore 落盘（仅应用数据目录，见 capabilities）
        .plugin(tauri_plugin_http::init()) // 本地请求通道：AI 请求由 Rust 侧发出，绕过 CORS
        .plugin(tauri_plugin_dialog::init()) // 学习工作区目录选择对话框
        .invoke_handler(tauri::generate_handler![allow_vault_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
