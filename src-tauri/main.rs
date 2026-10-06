//! 桌面壳入口（Tauri 2 / Ubuntu ARM64 .deb）
//!
//! 前端就是仓库根目录的 index.html + js/（由 scripts/build-frontend.mjs 组装到 dist/），
//! 本文件只负责窗口生命周期与运行环境准备。

// Windows 发布构建不弹控制台窗口（Linux 目标下无效果）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
