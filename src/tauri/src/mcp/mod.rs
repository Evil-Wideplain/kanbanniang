//! 内置 MCP 服务（单传输：Streamable HTTP）。
//!
//! 协议要点：
//! - **Streamable HTTP**（MCP `2025-03-26` 起，唯一传输）：客户端 POST /mcp 发送 JSON-RPC
//!   并同步收响应（initialize 下发 `Mcp-Session-Id`）；DSH 等现代客户端走这条。
//!   旧版 HTTP+SSE 传输（`2024-11-05`）已下线，不再提供 `/mcp/sse` 端点。
//! - 支持 initialize / ping / notifications/* / tools/list / tools/call，
//!   并由 `rpc` 按客户端请求回显协议版本（不硬编码单一版本）。
//!
//! 子模块（依赖单向：`server → streamable → rpc → tools`）：
//! - `server`：服务生命周期（启动 / 停止 / 端口热重启）与路由装配；
//! - `streamable`：Streamable HTTP 传输（无状态）与 `/health` 探活；
//! - `rpc`：JSON-RPC 方法路由与响应封套；
//! - `tools`：工具清单与 `tools/call` 路由；
//! - `debug`：应用内调试面板入口（复用完整 `tools/call` 协议封套）。

mod debug;
mod rpc;
mod server;
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
