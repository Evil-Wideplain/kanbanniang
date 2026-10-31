//! 看板娘桌面应用后端（组合根）。
//! 本文件只做装配：注册日志插件、读取设置、创建共享状态、注册结果监听器与设置命令、
//! 拉起 MCP 服务；不承载传输/工具/状态/设置等业务逻辑（分别见 `mcp/`、`state.rs`、
//! `config.rs` 与 `commands.rs`）。

mod commands;
mod config;
mod debug;
mod log_setup;
mod mcp;
mod model_store;
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
        // 导入模型的自定义只读协议：`mascot-model://<id>/<相对路径>`
        // （Windows/Android 上由 Tauri 映射为 `http://mascot-model.localhost/<id>/...`）。
        // 运行时导入的模型不在安装包内，无法走 Vite 静态资源，故单独开一条只读通道。
        .register_uri_scheme_protocol(model_store::ASSET_SCHEME, |ctx, request| {
            model_store::respond(ctx.app_handle(), &request)
        })
        // 设置相关命令：读写持久化设置、按需重启 MCP 服务与热切换模型；
        // 另含导入模型、鼠标穿透与调试调用入口。
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::get_runtime_status,
            commands::save_settings,
            commands::list_imported_models,
            commands::import_models,
            commands::remember_model,
            commands::set_click_through,
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

            // 开发构建（`tauri dev`，或用 `cargo build` 直接编）会把前端指向 devUrl：
            // 此时没有 Vite dev server 就是空白窗口，且前端不回 MCP（查询型工具 5s 超时），
            // 表现为「插件拉起了看板娘但看不到角色」。发布与 DSH 插件拉起的二进制必须由
            // `npm run tauri:build`（make build）产出，故显式告警，避免再次静默白屏。
            if cfg!(dev) {
                log::warn!(
                    "[boot] 当前为开发构建：前端加载 devUrl，需 Vite dev server 同时运行；发布请用 npm run tauri:build"
                );
            }

            // 读取持久化设置（文件缺失/损坏回退默认值），随后托管给设置命令。
            let settings = config::SettingsStore::load(&handle);

            // 把窗口置顶 / 开机自启等运行态偏好应用到当前进程（不透明度由主窗口前端应用）。
            commands::apply_startup(&handle, &settings.get());

            // 低分屏适配：工作区放不下设计尺寸时收缩窗口（前端布局按视口摆放，只减留白）。
            commands::fit_windows_to_work_area(&handle);

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
