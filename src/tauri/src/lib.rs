//! 看板娘桌面应用后端（组合根）。
//! 本文件只做装配：注册日志插件、读取设置、创建共享状态、注册结果监听器与设置命令、
//! 拉起 MCP 服务；不承载传输/工具/状态/设置等业务逻辑（分别见 `mcp/`、`state.rs`、
//! `config.rs` 与 `commands.rs`）。

mod commands;
mod config;
mod debug;
mod log_setup;
mod mcp;
mod state;
mod tray;

use std::path::Path;
use std::sync::Arc;

use tauri::Manager;

/// 启动 Tauri 应用与内置 MCP 服务（由桌面端入口 `main.rs` 调用）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(log_setup::plugin())
        // 开机自启：注册/移除系统登录项（Windows 走 HKCU\...\Run，macOS 走 LaunchAgent）。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // 设置相关命令：读写持久化设置、按需重启 MCP 服务与热切换模型；另含窗口平滑移动。
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_runtime_status,
            commands::save_settings,
            commands::move_window,
            debug::mcp_debug_call
        ])
        // 常驻托盘：关窗只隐藏不退出，真正结束进程走托盘菜单「退出」。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(e) = window.hide() {
                    log::warn!("[tray] 关窗请求转为隐藏失败: {e}");
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // macOS：隐藏 Dock 图标，以「菜单栏应用」形态常驻（macOS 无任务栏，等价于 skipTaskbar）。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // 装配系统托盘（图标 + 右键菜单 + 显隐/设置/[调试]/退出）；失败即启动失败，避免隐藏后无法唤回。
            tray::init(app)?;

            // 调试面板窗口：仅开发构建创建（默认隐藏，托盘「MCP 调试…」唤出）；release 不创建。
            #[cfg(debug_assertions)]
            debug::create_window(app)?;

            // 记录日志落盘位置（exe 同目录；回退时经 app_log_dir 解析），便于直接定位日志文件
            let log_dir = log_setup::file_dir()
                .map(Path::to_path_buf)
                .or_else(|| handle.path().app_log_dir().ok());
            if let Some(dir) = log_dir {
                log::info!(
                    "[log] 日志文件: {}",
                    dir.join(format!("{}.log", handle.package_info().name))
                        .display()
                );
            }

            // 读取持久化设置（文件缺失/损坏回退默认值），随后托管给设置命令。
            let settings = config::SettingsStore::load(&handle);

            // 把窗口置顶 / 开机自启等运行态偏好应用到当前进程（不透明度由主窗口前端应用）。
            commands::apply_startup(&handle, &settings.get());

            // 创建共享状态并托管给 Tauri，同时交给 MCP 服务与结果监听器使用。
            let state = Arc::new(state::AppStateInner::new(handle.clone()));
            app.manage(state.clone());

            // 监听前端回传的查询结果（查询型工具用）。
            state::spawn_result_listener(&handle, state.clone());

            // 启动 MCP 服务：仅在启用时监听端口；端口被占用不阻断启动（应用与设置页仍可用，
            // 用户可在设置页换端口后由 ServiceManager 重启）。
            let port = settings.get().mcp_port;
            let server = if settings.get().mcp_enabled {
                match tauri::async_runtime::block_on(mcp::start(state.clone(), port)) {
                    Ok(server) => Some((server, port)),
                    Err(e) => {
                        log::error!("[mcp] 服务启动失败（端口 {port}）: {e}");
                        None
                    }
                }
            } else {
                log::info!("[mcp] 设置已关闭 MCP 服务，跳过启动");
                None
            };
            app.manage(mcp::ServiceManager::new(server));
            app.manage(settings);
            // 窗口滑动代次守卫：并发移动请求的抢占防护（move_window 命令注入使用）。
            app.manage(commands::WindowGlideGuard::default());

            Ok(())
        })
        .run(tauri::generate_context!());

    // GUI 应用无可见控制台：启动失败输出结构化日志并以非零码退出，
    // 不走 panic（release 配置为 panic=abort，崩溃现场对用户不可读且丢失错误文本）。
    if let Err(e) = result {
        log::error!("[tauri] 应用启动失败: {e}");
        std::process::exit(1);
    }
}
