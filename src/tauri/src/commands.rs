//! 设置相关 Tauri 命令（接口层）。
//!
//! 读写持久化设置，并按需：
//! - 端口变更 → 重启内置 MCP 服务（`mcp::ServiceManager`）；
//! - 模型变更 → 经既有 `mascot:action` 契约下发 `set_model` 到主窗口热切换；
//! - 窗口置顶 / 开机自启 → 直接作用于运行态（窗口 API / autostart 插件）；
//! - 不透明度 / 视线跟随 → 随完整设置广播 `mascot:settings`，由主窗口前端应用。
//!
//! 另提供窗口平滑移动命令 `move_window`（MCP `move` 工具经前端分发调入），
//! 把主窗口滑到当前显示器工作区的归一化坐标。
//!
//! 装配（`lib.rs`）负责托管所需的共享状态；本模块只做用例编排。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, State, WebviewWindow};
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

/// 窗口滑动代次守卫：新请求递增代次，旧滑动循环检测到代次变化即让位返回。
/// 由 `lib.rs` 经 `app.manage()` 托管，命令以 `State<'_, WindowGlideGuard>` 注入。
#[derive(Default)]
pub struct WindowGlideGuard(AtomicU64);

/// 窗口移动结果（与前端 `shared/domain/types.ts` 的 `WindowMoveOutcome` 成对镜像，camelCase）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMoveOutcome {
    /// 最终生效的归一化坐标（工作区内，已截断到 [0,1]）。
    pub x: f64,
    pub y: f64,
    /// 最终窗口外框左上角（物理像素，虚拟屏绝对坐标）。
    pub physical_x: i32,
    pub physical_y: i32,
    /// 归一化输入超出 [0,1] 被截断。
    pub clamped: bool,
    /// 被更新的移动请求打断（本请求未滑到终点）。
    pub superseded: bool,
}

/// `move_window` 的几何快照（物理像素，虚拟屏绝对坐标；采集一次供滑行与回读共用）。
struct MoveFrame {
    /// 工作区左上角（归一化坐标原点）。
    origin_x: i32,
    origin_y: i32,
    /// 外框左上角可移动范围（工作区 − 窗口外框，≥ 0）。
    range_x: f64,
    range_y: f64,
    /// 目标外框左上角。
    target_x: i32,
    target_y: i32,
    /// 移动前的外框左上角。
    start_x: i32,
    start_y: i32,
    /// 归一化输入超出 [0,1] 被截断。
    clamped: bool,
}

/// 非有限值（NaN/Inf）按中点处理并截断到 [0,1]；返回（截断值，是否发生截断）。
fn sanitize_axis(v: f64) -> (f64, bool) {
    let finite = if v.is_finite() { v } else { 0.5 };
    let cx = finite.clamp(0.0, 1.0);
    (cx, cx != finite)
}

/// 解析窗口当前所在显示器（`None` 表示窗口不在任何显示器上，按失败处理）。
fn resolve_monitor(window: &WebviewWindow) -> Result<Monitor, String> {
    window
        .current_monitor()
        .map_err(|e| format!("获取当前显示器失败: {e}"))?
        .ok_or_else(|| "当前窗口不在任何显示器上".to_string())
}

/// 托盘隐藏的窗口先显示（仅 show 不聚焦，避免抢用户焦点）；失败仅告警。
fn show_if_hidden(window: &WebviewWindow) {
    if matches!(window.is_visible(), Ok(false)) {
        if let Err(e) = window.show() {
            log::warn!("[move_window] 移动前显示窗口失败: {e}");
        }
    }
}

/// 采集窗口几何并算出归一化目标对应的外框左上角像素。
///
/// 坐标系：`Monitor::work_area` 工作区（已扣除任务栏），按「工作区 − 窗口外框」
/// 的可移动范围换算，保证窗口外框完整落在工作区内；全程物理像素，避免 DPI 混算。
fn plan_move(window: &WebviewWindow, x: f64, y: f64) -> Result<MoveFrame, String> {
    let monitor = resolve_monitor(window)?;
    let work = *monitor.work_area(); // 工作区矩形（物理像素，已扣除任务栏）
    let win_size = window
        .outer_size()
        .map_err(|e| format!("读取窗口尺寸失败: {e}"))?;
    let (cx, mut clamped) = sanitize_axis(x);
    let (cy, clamped_y) = sanitize_axis(y);
    clamped |= clamped_y;
    // 外框左上角的可移动范围 = 工作区 − 窗口外框（小于 0 时贴工作区左上角）
    let range_x = f64::from(work.size.width.saturating_sub(win_size.width));
    let range_y = f64::from(work.size.height.saturating_sub(win_size.height));
    let start = window
        .outer_position()
        .map_err(|e| format!("读取窗口位置失败: {e}"))?;
    Ok(MoveFrame {
        origin_x: work.position.x,
        origin_y: work.position.y,
        range_x,
        range_y,
        target_x: work.position.x + (range_x * cx).round() as i32,
        target_y: work.position.y + (range_y * cy).round() as i32,
        start_x: start.x,
        start_y: start.y,
        clamped,
    })
}

/// 平滑滑到目标点；返回是否被更新的移动请求打断（superseded）。
/// 已在目标点时直接返回（幂等快路径，不空转 600ms）。
async fn glide(
    window: &WebviewWindow,
    frame: &MoveFrame,
    guard: &WindowGlideGuard,
    gen: u64,
) -> Result<bool, String> {
    if frame.start_x == frame.target_x && frame.start_y == frame.target_y {
        return Ok(false);
    }
    glide_loop(window, frame, guard, gen).await
}

/// 滑行步进循环：600ms smoothstep 缓入缓出、~60fps 写位置。
/// 循环内不打日志（logging 规范禁高频日志），汇总由调用方统一输出。
async fn glide_loop(
    window: &WebviewWindow,
    frame: &MoveFrame,
    guard: &WindowGlideGuard,
    gen: u64,
) -> Result<bool, String> {
    let duration = Duration::from_millis(600); // 滑行时长（0.5~1s 取中；须远小于查询型 5s 超时）
    let began = Instant::now();
    loop {
        if guard.0.load(Ordering::SeqCst) != gen {
            return Ok(true); // 已有更新请求：让位，不再写位置
        }
        let t = (began.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0);
        let ease = t * t * (3.0 - 2.0 * t); // smoothstep 缓入缓出
        let px = frame.start_x + ((frame.target_x - frame.start_x) as f64 * ease).round() as i32;
        let py = frame.start_y + ((frame.target_y - frame.start_y) as f64 * ease).round() as i32;
        if let Err(e) = window.set_position(tauri::PhysicalPosition::new(px, py)) {
            log::error!("[move_window] 窗口移动失败: {e}");
            return Err(format!("窗口移动失败: {e}"));
        }
        if t >= 1.0 {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(16)).await; // ~60fps 步进
    }
}

/// 读回真实最终位置（而非假定目标达成），换算归一化坐标并封装结果信封。
fn read_outcome(
    window: &WebviewWindow,
    frame: &MoveFrame,
    superseded: bool,
) -> Result<WindowMoveOutcome, String> {
    let end = window
        .outer_position()
        .map_err(|e| format!("读取窗口位置失败: {e}"))?;
    let norm = |px: i32, origin: i32, range: f64| -> f64 {
        if range <= 0.0 {
            0.0
        } else {
            ((px - origin) as f64 / range).clamp(0.0, 1.0)
        }
    };
    Ok(WindowMoveOutcome {
        x: norm(end.x, frame.origin_x, frame.range_x),
        y: norm(end.y, frame.origin_y, frame.range_y),
        physical_x: end.x,
        physical_y: end.y,
        clamped: frame.clamped,
        superseded,
    })
}

/// 平滑滑动主窗口到当前显示器工作区的归一化坐标
/// （约 600ms、smoothstep 缓入缓出、~60fps 步进；MCP `move` 工具经前端分发调入）。
/// 几何换算 / 滑行 / 回读拆在 `plan_move` / `glide` / `read_outcome`，
/// 本函数只做编排（保持 CRAP 低于门禁阈值）。
#[tauri::command]
pub async fn move_window(
    app: AppHandle,
    guard: State<'_, WindowGlideGuard>,
    x: f64,
    y: f64,
) -> Result<WindowMoveOutcome, String> {
    let gen = guard.0.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) else {
        return Err("未找到主窗口".to_string());
    };
    show_if_hidden(&window);
    let frame = plan_move(&window, x, y)?;
    let superseded = glide(&window, &frame, &guard, gen).await?;
    let out = read_outcome(&window, &frame, superseded)?;
    log::info!(
        "[move_window] 平滑移动 ({x}, {y}) → ({}, {}) px=({}, {}) clamped={} superseded={}",
        out.x,
        out.y,
        out.physical_x,
        out.physical_y,
        out.clamped,
        out.superseded
    );
    Ok(out)
}
