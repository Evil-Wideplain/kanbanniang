//! 应用内调试面板的 MCP 入口。
//!
//! 自造 JSON-RPC id 复用完整 `tools/call`（含协议封套），返回整帧响应供面板原样展示，
//! 使调试面板覆盖「工具路由 → `state.dispatch` → 前端分发 → 结果回传」链路。

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use super::{tools, AppState};

/// 调试面板专用 JSON-RPC id 序号（仅用于面板页展示请求/响应的 id 配对，不与 SSE 会话共享）。
static DEBUG_SEQ: AtomicU64 = AtomicU64::new(1);

/// 应用内调试面板入口：自造 JSON-RPC id 复用完整 `tools/call`（含协议封套），
/// 返回整帧响应（`{id, jsonrpc, result|error}`）供面板原样展示。
/// 日志含义也与真实链路一致（未知工具走 error 帧 -32602，而非结果信封）。
pub(crate) async fn debug_call(state: AppState, name: String, args: Value) -> Value {
    let id = json!(DEBUG_SEQ.fetch_add(1, Ordering::Relaxed));
    let params = json!({ "name": name, "arguments": args });
    let frame = tools::call_tool(state, params, Some(id)).await;
    serde_json::from_str(&frame).unwrap_or(Value::String(frame))
}
