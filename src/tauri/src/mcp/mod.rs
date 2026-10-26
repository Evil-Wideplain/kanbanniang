//! 内置 MCP 服务（双传输：Streamable HTTP 为主，旧版 SSE 仅兼容）。
//!
//! 协议要点：
//! - **Streamable HTTP**（MCP `2025-03-26` 起，主路径）：客户端 POST /mcp 发送 JSON-RPC
//!   并同步收响应（initialize 下发 `Mcp-Session-Id`）；DSH 等新一代客户端走这条。
//! - 旧版 SSE（MCP `2024-11-05`，已废弃）：客户端 GET /mcp/sse 建立长连接，首条事件为
//!   `event: endpoint\ndata: /mcp/messages?sessionId=xxx`，告知后续 POST 地址；
//!   请求的响应经 SSE 通道以 `event: message\ndata: {...}` 回传。仅为兼容老客户端保留。
//! - 两种传输共用 initialize / ping / notifications/* / tools/list / tools/call，
//!   并由 `rpc` 按客户端请求回显协议版本（不硬编码单一版本）。
//!
//! 子模块（依赖单向：`server → {streamable, sse} → rpc → tools`）：
//! - `server`：服务生命周期（启动 / 停止 / 端口热重启）与路由装配；
//! - `streamable`：Streamable HTTP 传输（无状态，主路径）与 `/health` 探活；
//! - `sse`：旧版 SSE 传输、会话治理（兼容通道）；
//! - `rpc`：JSON-RPC 方法路由与响应封套；
//! - `tools`：工具清单与 `tools/call` 路由；
//! - `debug`：应用内调试面板入口（复用完整 `tools/call` 协议封套）。

mod debug;
mod rpc;
mod server;
mod sse;
mod streamable;
mod tools;

use std::sync::Arc;

pub use server::{start, ServiceManager};

pub(crate) use debug::debug_call;
pub(crate) use rpc::{error_resp, response};

use crate::state::AppStateInner;

pub type AppState = Arc<AppStateInner>;

/// 默认 MCP 监听端口（设置页可改；端口变更只在重启服务时生效）。
pub const DEFAULT_MCP_PORT: u16 = 7432;

/// 查询型工具的响应超时（秒）：前端须在此时间内经 `mascot:result` 回传结果。
pub const QUERY_TIMEOUT_SECS: u64 = 5;
