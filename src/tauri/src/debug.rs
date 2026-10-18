//! 应用内 MCP 调试面板（仅开发构建创建窗口）：无需外部 MCP 客户端即可点击调用各工具。
//!
//! 调用复用 `mcp::debug_call`（自造 JSON-RPC id 走完整 `tools/call`，含协议封套），
//! 面板原样展示响应帧；SSE / 传输帧由 `cmd/client/test.mjs` 冒烟测试覆盖。
//! 复用真链路的理由：WebView origin 为 `tauri://localhost`，与 `http://127.0.0.1:<port>` 跨源，
//! 且 MCP 服务未开 CORS，页面内直连 SSE 会被浏览器拦截。

use std::sync::Arc;

use serde_json::Value;

use crate::mcp;
use crate::state::AppStateInner;

#[cfg(debug_assertions)]
use tauri::{App, WebviewUrl, WebviewWindowBuilder};

#[cfg(debug_assertions)]
use crate::tray::DEBUG_WINDOW;

/// 创建调试面板窗口（仅开发构建；默认隐藏，由托盘「MCP 调试…」唤出，可复用同一实例）。
/// release 构建不创建该窗口，故调试命令虽始终注册，却无窗口可触达。
#[cfg(debug_assertions)]
pub(crate) fn create_window(app: &App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, DEBUG_WINDOW, WebviewUrl::App("debug.html".into()))
        .title("看板娘 · MCP 调试")
        .inner_size(860.0, 620.0)
        .min_inner_size(720.0, 560.0)
        .visible(false)
        .resizable(true)
        .always_on_top(true)
        .center()
        // 与设置窗口一致：无系统边框 + 透明（圆角手账纸透出桌面），拖动/关闭由前端自绘标题栏负责。
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .build()?;
    Ok(())
}

/// 供调试面板调用：执行工具并返回完整 JSON-RPC 响应帧（`{id, jsonrpc, result|error}`）。
/// 不上抛错误：失败已表达为协议 error 帧（如未知工具 -32602），面板原样展示即可。
#[tauri::command]
pub async fn mcp_debug_call(
    state: tauri::State<'_, Arc<AppStateInner>>,
    name: String,
    args: Value,
) -> Result<Value, String> {
    Ok(mcp::debug_call(state.inner().clone(), name, args).await)
}
