//! 内置 MCP 服务（双传输：SSE + Streamable HTTP）。
//!
//! 协议要点（遵循 MCP 2024-11-05）：
//! - 旧版 SSE 传输：客户端 GET /mcp/sse 建立长连接，首条事件为
//!   `event: endpoint\ndata: /mcp/messages?sessionId=xxx`，告知后续 POST 地址；
//!   请求的响应经 SSE 通道以 `event: message\ndata: {...}` 回传。
//! - Streamable HTTP 传输：客户端 POST /mcp 发送 JSON-RPC 并同步收响应
//!   （initialize 下发 `Mcp-Session-Id`），供 DSH 等新一代 MCP 客户端接入。
//! - 两种传输共用 initialize / ping / notifications/* / tools/list / tools/call。
//!
//! 子模块（依赖单向：`server → {sse, streamable} → rpc → tools`）：
//! - `server`：服务生命周期（启动 / 停止 / 端口热重启）与路由装配；
//! - `sse`：旧版 SSE 传输、会话治理；
//! - `streamable`：Streamable HTTP 传输（无状态）与 `/health` 探活；
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
