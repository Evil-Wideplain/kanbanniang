//! 内置 MCP 服务（SSE 传输）。
//!
//! 协议要点（遵循 MCP 2024-11-05）：
//! - 客户端 GET /mcp/sse 建立 SSE 长连接，服务端首条事件为
//!   `event: endpoint\ndata: /mcp/messages?sessionId=xxx`，告知后续 POST 地址。
//! - 客户端向该地址 POST JSON-RPC 请求；响应通过 SSE 通道以
//!   `event: message\ndata: {...}` 回传。
//! - 支持 initialize / ping / notifications/* / tools/list / tools/call。
//!
//! 子模块（依赖单向：`server → sse → rpc → tools`）：
//! - `server`：服务生命周期（启动 / 停止 / 端口热重启）；
//! - `sse`：SSE 与 POST 传输、会话治理；
//! - `rpc`：JSON-RPC 方法路由与响应封套；
//! - `tools`：工具清单与 `tools/call` 路由；
//! - `debug`：应用内调试面板入口（复用完整 `tools/call` 协议封套）。

mod debug;
mod rpc;
mod server;
mod sse;
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
