//! 设置相关 Tauri 命令（接口层）。
//!
//! 读写持久化设置，并按需：
//! - 端口变更 → 重启内置 MCP 服务（`mcp::ServiceManager`）；
//! - 模型变更 → 经既有 `mascot:action` 契约下发 `set_model` 到主窗口热切换；
//! - 窗口置顶 / 开机自启 → 直接作用于运行态（窗口 API / autostart 插件）；
//! - 不透明度 / 视线跟随 → 随完整设置广播 `mascot:settings`，由主窗口前端应用。
//!
//! 装配（`lib.rs`）负责托管所需的共享状态；本模块只做用例编排。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;

use crate::config::{self, Settings, SettingsStore};
use crate::mcp::ServiceManager;
use crate::state::AppStateInner;
use crate::tray;

/// MCP 服务的运行时状态（供设置页显示真实地址与运行态）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    /// 服务当前是否在运行（启动时端口被占用则为 false）。
    pub mcp_running: bool,
    /// 实际监听端口；未运行时回退为配置端口（便于展示「期望端口」）。
    pub mcp_port: u16,
}

/// 读取 MCP 服务运行时状态（实际端口 / 是否运行）。
#[tauri::command]
pub async fn get_runtime_status(
    manager: State<'_, ServiceManager>,
    store: State<'_, SettingsStore>,
) -> Result<RuntimeStatus, String> {
    match manager.running_port().await {
        Some(port) => Ok(RuntimeStatus {
            mcp_running: true,
            mcp_port: port,
        }),
        None => Ok(RuntimeStatus {
            mcp_running: false,
            mcp_port: store.get().mcp_port,
        }),
    }
}

/// 读取当前设置（供前端启动时决定初始模型、设置页回显）。
#[tauri::command]
pub fn get_settings(store: State<'_, SettingsStore>) -> Settings {
    store.get()
}

/// 保存设置：按需启停 MCP 服务（开关/端口），模型变更时热切换看板娘，
/// 并应用窗口置顶 / 不透明度 / 视线跟随 / 开机自启。
///
/// MCP 服务：先落盘再启停；「开关变化」或「端口变化」失败（如端口被占用）时，
/// 回滚磁盘与内存副本为旧设置，保证「磁盘 / 内存 / 运行态」一致
/// （`ServiceManager` 的「先建后销」保证旧服务仍在跑）。
/// 模型：以结果信封回传失败不影响保存，下次启动会再尝试。
/// 窗口/自启偏好：幂等应用，失败仅告警（不影响关键路径）。
#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, Arc<AppStateInner>>,
    store: State<'_, SettingsStore>,
    manager: State<'_, ServiceManager>,
    settings: Settings,
) -> Result<Settings, String> {
    let current = store.get();
    config::validate_port(settings.mcp_port).map_err(|e| e.to_string())?;
    config::validate_opacity(settings.opacity).map_err(|e| e.to_string())?;

    let next = settings;
    config::save(&app, &next).map_err(|e| {
        log::error!("[settings] 设置落盘失败: {e}");
        format!("保存设置失败: {e}")
    })?;
    store.set(next.clone());

    // MCP 服务开关 / 端口：reconcile 运行态与配置（显式变更失败则回滚并中断保存）。
    reconcile_mcp(
        &app,
        &store,
        &manager,
        state.inner().clone(),
        &current,
        &next,
    )
    .await?;

    // 模型变更：走既有 mascot:action 契约下发（主窗口热切换，失败仅告警）。
    switch_model_if_changed(state.inner(), &current, &next).await;

    // 窗口置顶：直接作用于主窗口（幂等）。
    apply_always_on_top(&app, next.always_on_top);

    // 不透明度 / 视线跟随：广播给主窗口前端应用（启动时主窗口已自行读取，无需广播）。
    broadcast_settings(&app, &next);

    // 开机自启：仅在变化时改动系统登录项。
    if next.autostart != current.autostart {
        apply_autostart(&app, next.autostart);
    }

    Ok(next)
}

/// reconcile MCP 服务运行态与配置。
///
/// 仅当「开关变化」或「端口变化」（`mcp_relevant`）属用户显式意图，失败才回滚磁盘与内存
/// 副本并返回 `Err`（由调用方中断保存）；其余情况（如启动时端口被占）只告警，不阻断保存其他设置。
async fn reconcile_mcp(
    app: &AppHandle,
    store: &SettingsStore,
    manager: &ServiceManager,
    state: Arc<AppStateInner>,
    current: &Settings,
    next: &Settings,
) -> Result<(), String> {
    let mcp_relevant = next.mcp_enabled != current.mcp_enabled
        || (next.mcp_enabled && next.mcp_port != current.mcp_port);
    let result = if next.mcp_enabled {
        manager.ensure_started(state, next.mcp_port).await
    } else {
        manager.stop().await;
        Ok(())
    };
    let Err(e) = result else { return Ok(()) };
    if !mcp_relevant {
        log::warn!("[settings] MCP 服务未就绪（保存其他设置不受影响）: {e}");
        return Ok(());
    }
    log::error!("[settings] MCP 服务切换失败: {e}");
    if let Err(revert) = config::save(app, current) {
        log::error!("[settings] 切换失败后回滚配置失败: {revert}");
    }
    store.set(current.clone());
    Err(format!("MCP 服务切换失败: {e}"))
}

/// 模型 id 变化时经 `mascot:action` 契约下发 `set_model`（失败仅告警，不影响保存）。
async fn switch_model_if_changed(state: &AppStateInner, current: &Settings, next: &Settings) {
    if next.model_id == current.model_id {
        return;
    }
    match state
        .dispatch(
            "set_model",
            serde_json::json!({ "model": next.model_id }),
            true,
        )
        .await
    {
        Ok(_) => log::info!("[settings] 模型已切换为 {}", next.model_id),
        Err(e) => log::warn!("[settings] 模型热切换失败 {}: {e}", next.model_id),
    }
}

/// 把完整设置广播给主窗口前端（不透明度 / 视线跟随由此生效；失败仅告警）。
fn broadcast_settings(app: &AppHandle, next: &Settings) {
    if let Err(e) = app.emit_to(tray::MAIN_WINDOW, crate::state::channels::SETTINGS, next) {
        log::warn!("[settings] 广播设置变更失败: {e}");
    }
}

/// 启动时把设置应用到运行态（主窗口置顶 + 开机自启；不透明度由主窗口读取设置自行应用）。
pub fn apply_startup(app: &AppHandle, settings: &Settings) {
    apply_always_on_top(app, settings.always_on_top);
    apply_autostart(app, settings.autostart);
}

/// 设置主窗口置顶（失败仅告警，不阻断启动/保存）。
fn apply_always_on_top(app: &AppHandle, always_on_top: bool) {
    let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) else {
        log::warn!("[settings] 未找到主窗口，跳过窗口置顶设置");
        return;
    };
    if let Err(e) = window.set_always_on_top(always_on_top) {
        log::warn!("[settings] 应用窗口置顶失败: {e}");
    }
}

/// 应用开机自启设置（注册/移除系统登录项；失败仅告警）。
fn apply_autostart(app: &AppHandle, enabled: bool) {
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    let state_text = if enabled { "开启" } else { "关闭" };
    match result {
        Ok(()) => log::info!("[settings] 开机自启已{state_text}"),
        Err(e) => log::warn!("[settings] 应用开机自启失败（{state_text}）: {e}"),
    }
}
