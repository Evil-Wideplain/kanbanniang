//! 内置 MCP 服务（SSE 传输）。
//!
//! 协议要点（遵循 MCP 2024-11-05）：
//! - 客户端 GET /mcp/sse 建立 SSE 长连接，服务端首条事件为
//!   `event: endpoint\ndata: /mcp/messages?sessionId=xxx`，告知后续 POST 地址。
//! - 客户端向该地址 POST JSON-RPC 请求；响应通过 SSE 通道以
//!   `event: message\ndata: {...}` 回传。
//! - 支持 initialize / ping / notifications/* / tools/list / tools/call。

mod tools;

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{get, post};
use axum::Router;
use futures::stream::{self, Stream, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, oneshot};

use log::{info, warn};

use crate::state::AppStateInner;

pub type AppState = Arc<AppStateInner>;

/// 默认 MCP 监听端口（设置页可改；端口变更只在重启服务时生效）。
pub const DEFAULT_MCP_PORT: u16 = 7432;

/// 查询型工具的响应超时（秒）：前端须在此时间内经 `mascot:result` 回传结果。
pub const QUERY_TIMEOUT_SECS: u64 = 5;

/// 运行中的 MCP 服务句柄：持有优雅关闭信号与后台任务，供重启时收旧服务。
pub struct ServerHandle {
    shutdown: oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl ServerHandle {
    /// 停止服务：发关闭信号并立即终结任务，释放监听端口。
    ///
    /// 不等待连接排空：SSE 是长连接，可能永不自然结束，阻塞等待会卡住端口切换；
    /// 且新端口已先行绑定，旧服务是否排空不影响功能。
    fn stop(self) {
        let _ = self.shutdown.send(());
        self.task.abort();
    }
}

/// 在指定端口启动 MCP 服务。
///
/// 先绑定监听（端口被占用等错误立即上抛，调用方得以保留旧服务），
/// 再以分离任务提供服务；`ServerHandle::stop` 触发后停止。
pub async fn start(state: AppState, port: u16) -> anyhow::Result<ServerHandle> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("MCP 端口 {port} 监听失败"))?;

    let (shutdown, rx) = oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(listener, state, async move {
            // 忽略接收端已释放：调用方只关心是否收到关闭信号
            let _ = rx.await;
        })
        .await
        {
            log::error!("[mcp] 服务异常: {e}");
        }
    });

    Ok(ServerHandle { shutdown, task })
}

/// MCP 服务运行器：装配路由并服务直到 `shutdown` 完成。
async fn serve<F>(listener: TcpListener, state: AppState, shutdown: F) -> anyhow::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    let app = Router::new()
        .route("/mcp/sse", get(sse_handler))
        .route("/mcp/messages", post(post_handler))
        .with_state(state);

    info!(
        "[mcp] MCP SSE 服务已启动: http://{}/mcp/sse",
        listener.local_addr()?
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

/// MCP 服务生命周期管理：保存运行中的服务句柄与端口，支持按新端口重启。
/// 重启遵循「先建后销」：新端口建好服务才关闭旧的，失败则保留原服务与原端口。
pub struct ServiceManager {
    running: tokio::sync::Mutex<Option<RunningServer>>,
}

/// 运行中的服务：句柄 + 实际监听端口（供运行时状态查询）。
struct RunningServer {
    handle: ServerHandle,
    port: u16,
}

impl ServiceManager {
    /// 以初始服务句柄构造（`None` = 启动时端口被占用，MCP 未运行）。
    pub fn new(running: Option<(ServerHandle, u16)>) -> Self {
        Self {
            running: tokio::sync::Mutex::new(
                running.map(|(handle, port)| RunningServer { handle, port }),
            ),
        }
    }

    /// 当前实际监听端口；`None` 表示服务未运行（如启动时端口被占用）。
    pub async fn running_port(&self) -> Option<u16> {
        self.running.lock().await.as_ref().map(|s| s.port)
    }

    /// 关闭服务（若在运行）；幂等，未运行时为空操作。
    pub async fn stop(&self) {
        if let Some(server) = self.running.lock().await.take() {
            server.handle.stop();
            info!("[mcp] 服务已关闭");
        }
    }

    /// 确保服务运行在指定端口：已在该端口则空操作，否则重启（先建后销）。
    pub async fn ensure_started(&self, state: AppState, port: u16) -> anyhow::Result<()> {
        if self.running.lock().await.as_ref().map(|s| s.port) == Some(port) {
            return Ok(());
        }
        self.restart(state, port).await
    }

    /// 以新端口重启服务：新服务绑定成功后才替换并关闭旧服务。
    pub async fn restart(&self, state: AppState, port: u16) -> anyhow::Result<()> {
        let mut guard = self.running.lock().await;
        let handle = start(state, port).await?;
        if let Some(old) = guard.replace(RunningServer { handle, port }) {
            old.handle.stop();
        }
        info!("[mcp] 服务已切换到端口 {port}");
        Ok(())
    }
}

/// SSE 会话守卫：流被丢弃（客户端断开/服务停止）时移除会话表项并记录日志，
/// 防止客户端重连导致死会话在表中累积（表泄漏）。
struct SessionGuard {
    state: AppState,
    id: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.state.sessions().remove(&self.id);
        info!("[mcp] SSE 会话断开 sessionId={}", self.id);
    }
}

/// SSE 入口：为每个连接创建会话，下发 endpoint 事件，随后转发服务端消息。
async fn sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let id = uuid::Uuid::new_v4().to_string();
    // 64：单会话消息缓冲上限；前端消费慢时丢弃最旧消息（下方 Lagged 分支），保证不断流
    let (tx, rx) = broadcast::channel::<String>(64);
    state.sessions().insert(id.clone(), tx);
    info!("[mcp] SSE 会话建立 sessionId={}", id);

    let endpoint = format!("/mcp/messages?sessionId={}", id);
    let endpoint_event = stream::once(async move {
        Ok::<_, Infallible>(Event::default().event("endpoint").data(endpoint))
    });

    // 守卫随流（unfold 状态）存活：连接断开导致流被丢弃时自动清理会话表并记日志。
    let guard = SessionGuard { state, id };
    let msg_stream = stream::unfold((rx, guard), |(mut rx, guard)| async move {
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    return Some((
                        Ok::<_, Infallible>(Event::default().event("message").data(msg)),
                        (rx, guard),
                    ))
                }
                // 客户端落后时跳过，继续监听
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // 会话关闭（发送端已全部释放，防御分支），结束流
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    Sse::new(endpoint_event.chain(msg_stream)).keep_alive(KeepAlive::default())
}

/// 接收客户端 JSON-RPC POST，处理后将响应推回对应 SSE 会话。
async fn post_handler(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    body: String,
) -> axum::http::StatusCode {
    // 解析请求（sessionId + JSON-RPC 体）：任一不合法即拒绝。
    let Some((session_id, value)) = parse_request(&params, &body) else {
        return axum::http::StatusCode::BAD_REQUEST;
    };

    if let Some(response_str) = handle_rpc(state.clone(), value).await {
        match state.sessions().get(&session_id) {
            Some(tx) => {
                let _ = tx.send(response_str);
            }
            // 会话已断开（或 id 伪造）：响应无处可回，记录以便排查客户端重连问题
            None => warn!("[mcp] 会话不存在，响应已丢弃 sessionId={session_id}"),
        }
    }
    axum::http::StatusCode::ACCEPTED
}

/// 解析查询参数与请求体：缺 sessionId 或 JSON 非法时告警并返回 None（调用方回 400）。
fn parse_request(params: &HashMap<String, String>, body: &str) -> Option<(String, Value)> {
    let Some(session_id) = params.get("sessionId").cloned() else {
        warn!("[mcp] 拒绝请求：缺少 sessionId 查询参数");
        return None;
    };
    match serde_json::from_str(body) {
        Ok(value) => Some((session_id, value)),
        Err(e) => {
            warn!("[mcp] 拒绝请求：JSON-RPC 解析失败 sessionId={session_id} error={e}");
            None
        }
    }
}

/// 解析 JSON-RPC 请求，返回需要经 SSE 回传的响应字符串（通知类返回 None）。
async fn handle_rpc(state: AppState, req: Value) -> Option<String> {
    let method = req.get("method").and_then(Value::as_str)?;
    let id = req.get("id").cloned();

    // tools/call 需异步转发前端并等待结果回传，单独处理后再统一包封套。
    if method == "tools/call" {
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        return Some(tools::call_tool(state, params, id).await);
    }

    // 通知（id 缺失或为 null）不产生响应。
    if id.as_ref().map_or(true, Value::is_null) {
        return None;
    }
    Some(match rpc_result(method, &req) {
        Some(result) => response(id, result),
        None => {
            warn!("[mcp] 收到未知方法: {method}");
            error_resp(id, -32601, "Method not found")
        }
    })
}

/// 同步方法路由：initialize / ping / tools/list 各返回结果；未知方法返回 None（由调用方回 -32601）。
fn rpc_result(method: &str, req: &Value) -> Option<Value> {
    match method {
        "initialize" => Some(rpc_initialize(req)),
        "ping" => Some(json!({})),
        "tools/list" => Some(rpc_tools_list()),
        _ => None,
    }
}

/// initialize 响应：记录客户端名/版本（便于排查不同 Agent 接入问题），返回协议版本与服务能力。
fn rpc_initialize(req: &Value) -> Value {
    let client = req.get("params").and_then(|p| p.get("clientInfo"));
    info!(
        "[mcp] initialize 客户端={} 版本={}",
        client
            .and_then(|c| c.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知"),
        client
            .and_then(|c| c.get("version"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知")
    );
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "kanban-mascot", "version": "0.1.0" }
    })
}

/// tools/list 响应：投影工具清单并记录数量。
fn rpc_tools_list() -> Value {
    let tools = tools::list();
    info!(
        "[mcp] tools/list 返回 {} 个工具",
        tools.as_array().map_or(0, Vec::len)
    );
    json!({ "tools": tools })
}

/// JSON-RPC 成功响应封套（协议版本/字段序在此收口，与 `error_resp` 成对）。
pub(super) fn response(id: Option<Value>, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_resp(id: Option<Value>, code: i64, msg: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": msg } }).to_string()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)] // 测试代码：断言失败即用例失败，JSON 索引为惯用写法
mod tests {
    use super::*;

    #[test]
    fn rpc_result_routes_known_methods() {
        // ping → {}
        assert_eq!(rpc_result("ping", &json!({})), Some(json!({})));
        // initialize → 协议版本与服务信息
        let init = rpc_result("initialize", &json!({})).unwrap();
        assert_eq!(init["protocolVersion"], "2024-11-05");
        assert_eq!(init["serverInfo"]["name"], "kanban-mascot");
        // tools/list → { tools: [...] }
        let list = rpc_result("tools/list", &json!({})).unwrap();
        assert!(list["tools"].is_array());
        // 未知方法 → None（调用方回 -32601）
        assert!(rpc_result("no/such/method", &json!({})).is_none());
    }

    #[test]
    fn rpc_initialize_reads_client_info() {
        let req = json!({ "params": { "clientInfo": { "name": "claude", "version": "1.2" } } });
        let v = rpc_initialize(&req);
        assert_eq!(v["capabilities"]["tools"], json!({}));
    }

    #[test]
    fn response_carries_jsonrpc_envelope() {
        let s = response(Some(json!(7)), json!({ "ok": true }));
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 7);
        assert_eq!(v["result"]["ok"], true);
        assert!(v.get("error").is_none());
    }

    #[test]
    fn error_resp_carries_code_and_message() {
        let s = error_resp(None, -32601, "Method not found");
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["id"], Value::Null);
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(v["error"]["message"], "Method not found");
    }

    #[test]
    fn parse_request_requires_session_and_valid_json() {
        let mut params = HashMap::new();
        assert!(parse_request(&params, "{}").is_none()); // 缺 sessionId
        params.insert("sessionId".to_string(), "abc".to_string());
        assert!(parse_request(&params, "not json").is_none()); // JSON 非法
        let (id, value) = parse_request(&params, r#"{"jsonrpc":"2.0"}"#).unwrap();
        assert_eq!(id, "abc");
        assert_eq!(value["jsonrpc"], "2.0");
    }
}
