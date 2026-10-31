//! 设置相关 Tauri 命令（接口层）。
//!
//! 读写持久化设置，并按需：
//! - 端口变更 → 重启内置 MCP 服务（`mcp::ServiceManager`）；
//! - 模型变更 → 经既有 `mascot:action` 契约下发 `set_model` 到主窗口热切换；
//! - 窗口置顶 / 开机自启 → 直接作用于运行态（窗口 API / autostart 插件）；
//! - 不透明度 / 视线跟随 → 随完整设置广播 `mascot:settings`，由主窗口前端应用。
//!
//! 以及导入模型命令：`list_imported_models` / `import_models`（拖入文件夹或 zip 后
//! 解析并落盘）与 `remember_model`（记住当前模型，避免把整份设置再从主窗口写一遍）。
//!
//! 另有窗口鼠标穿透开关 `set_click_through`（前端按角色像素命中结果动态调用），
//! 以及启动期窗口工作区适配 `fit_windows_to_work_area`（低分屏不裁掉角色脚部/设置页按钮）。
//!
//! 装配（`lib.rs`）负责托管所需的共享状态；本模块只做用例编排。

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;

use crate::config::{self, Settings, SettingsStore};
use crate::mcp::ServiceManager;
use crate::model_store::{self, ImportOutcome, ImportedModel};
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
    // 越界值收敛到默认（取值规则的用户可见报错归前端设置页），避免非法端口/不透明度落盘。
    let mut next = settings;
    if config::normalize(&mut next) {
        log::warn!(
            "[settings] 保存入参越界，已收敛（端口 {}，不透明度 {}）",
            next.mcp_port,
            next.opacity
        );
    }

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

    // 其余设置：模型热切换 / 窗口置顶 / 设置广播 / 开机自启（幂等，失败仅告警）。
    apply_runtime_prefs(&app, state.inner(), &current, &next).await;

    Ok(next)
}

/// 保存成功后的运行态应用：模型热切换、窗口置顶、设置广播、开机自启
/// （均幂等，失败仅告警，不影响已保存的设置）。
async fn apply_runtime_prefs(
    app: &AppHandle,
    state: &AppStateInner,
    current: &Settings,
    next: &Settings,
) {
    switch_model_if_changed(state, current, next).await;
    apply_always_on_top(app, next.always_on_top);
    broadcast_settings(app, next);
    if next.autostart != current.autostart {
        apply_autostart(app, next.autostart);
    }
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
    rollback_mcp(app, store, current, &e);
    Err(format!("MCP 服务切换失败: {e}"))
}

/// 显式变更失败时回滚配置到 `current`（磁盘 + 内存副本），保证「磁盘 / 内存 / 运行态」一致。
fn rollback_mcp(app: &AppHandle, store: &SettingsStore, current: &Settings, e: &anyhow::Error) {
    log::error!("[settings] MCP 服务切换失败: {e}");
    if let Err(revert) = config::save(app, current) {
        log::error!("[settings] 切换失败后回滚配置失败: {revert}");
    }
    store.set(current.clone());
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

/// 启动时把设置应用到运行态（主窗口置顶 + 开机自启；
/// 不透明度由主窗口读取设置自行应用）。
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

/// 启动时按工作区收缩主窗口与设置窗口：设计尺寸（主 640x800 / 设置 440x760）在
/// 1366x768 这类小屏上放不下，超出部分（角色脚部、设置页底部按钮）会被裁掉，
/// 且前端 `move` 的可移动范围会被 `saturating_sub` 挤成 0，纵向归一化参数静默失效。
///
/// 为什么放在后端：窗口尺寸是窗口系统属性，前端只能读视口；前端布局按视口摆放
/// （`layout.ts::computeModelFit` + `bubbleBottomPx`），窗口变小只减少四周留白，
/// 角色像素尺寸与气泡位置都会自动跟随。只收缩不放大——工作区足够时保留设计尺寸。
/// 失败仅告警，保留配置尺寸、不阻断启动。
pub fn fit_windows_to_work_area(app: &AppHandle) {
    for label in [tray::MAIN_WINDOW, tray::SETTINGS_WINDOW] {
        let Some(window) = app.get_webview_window(label) else {
            log::warn!("[window] 未找到窗口 {label}，跳过工作区适配");
            continue;
        };
        if let Err(e) = shrink_to_work_area(&window) {
            log::warn!("[window] 窗口 {label} 工作区适配失败（保留配置尺寸）: {e}");
        }
    }
}

/// 按工作区收缩单个窗口：物理像素读取、逻辑尺寸写回；外框已完整落在工作区内则不动。
fn shrink_to_work_area(window: &WebviewWindow) -> anyhow::Result<()> {
    let monitor = window
        .current_monitor()?
        .ok_or_else(|| anyhow::anyhow!("窗口不在任何显示器上"))?;
    let work = *monitor.work_area();
    let outer = window.outer_size()?;
    // 快路径：外框已完整落在工作区内（设置窗口通常走这里），不做任何窗口操作
    if outer.width <= work.size.width && outer.height <= work.size.height {
        return Ok(());
    }
    let scale = window.scale_factor()?;
    let inner = window.inner_size()?;
    let width = (f64::from(inner.width) / scale).min(f64::from(work.size.width) / scale);
    let height = (f64::from(inner.height) / scale).min(f64::from(work.size.height) / scale);
    window.set_size(tauri::LogicalSize::new(width, height))?;
    window.center()?; // 收缩后重新居中，避免贴边或跨越到另一块屏幕
    log::info!(
        "[window] {} 工作区 {}x{}（物理像素）放不下窗口，收缩为 {width:.0}x{height:.0}（逻辑像素）",
        window.label(),
        work.size.width,
        work.size.height
    );
    Ok(())
}

/// 列出已导入模型（主窗口启动时注册档案、设置页展示用）。
#[tauri::command]
pub fn list_imported_models(app: AppHandle) -> Result<Vec<ImportedModel>, String> {
    model_store::list(&app).map_err(|e| {
        log::error!("[model_store] 读取导入模型列表失败: {e}");
        format!("读取导入模型列表失败: {e}")
    })
}

/// 导入拖入的模型路径（文件夹或 .zip）：解析配置并落盘，返回成功项与逐路径失败原因。
///
/// 解压 / 复制属阻塞 IO，放到阻塞线程池执行，避免占用异步运行时工作线程。
#[tauri::command]
pub async fn import_models(app: AppHandle, paths: Vec<String>) -> Result<ImportOutcome, String> {
    if paths.is_empty() {
        return Ok(ImportOutcome::default());
    }
    tauri::async_runtime::spawn_blocking(move || model_store::import(&app, &paths))
        .await
        .map_err(|e| format!("模型导入任务失败: {e}"))
}

/// 记住当前模型：只更新设置里的 `model_id` 并落盘。
///
/// 不复用 `save_settings` 是为了避免主窗口拿启动时的整份设置回写、
/// 覆盖掉设置窗口在此期间改过的端口 / 不透明度等字段。
#[tauri::command]
pub fn remember_model(
    app: AppHandle,
    store: State<'_, SettingsStore>,
    model_id: String,
) -> Result<(), String> {
    let current = store.get();
    if current.model_id == model_id {
        return Ok(());
    }
    let mut next = current;
    next.model_id = model_id.clone();
    config::save(&app, &next).map_err(|e| {
        log::warn!("[model_store] 记住当前模型失败: {e}");
        format!("保存当前模型失败: {e}")
    })?;
    store.set(next);
    log::info!("[model_store] 已记住当前模型 {model_id}");
    Ok(())
}

/// 切换主窗口的鼠标穿透：`ignore=true` 时窗口不接收鼠标消息（事件落到下层窗口）。
///
/// 为什么由前端驱动：可交互区域是「角色像素」而非整个窗口，只有前端能按 Live2D 的
/// 像素命中结果判断光标是否落在角色上，故由前端在命中结果变化时调用本命令。
/// 只改输入命中行为，不影响视觉透明度（不透明度仍由 `mascot:settings` 落到画布）。
/// 重复设置同一状态是幂等的，因此前端无需先读旧状态、也不必做去重。
/// 失败原因以中文 `Err` 回传前端（是否落日志由前端决定）；后端刻意不打日志，
/// 因为本命令只在「光标进出角色」的状态翻转时调用，日志噪声交给前端统一控制。
#[tauri::command]
pub fn set_click_through(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| format!("设置鼠标穿透失败(ignore={ignore}): {e}"))
}
