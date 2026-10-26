//! MCP 传输层（**旧版 HTTP+SSE，仅为兼容保留**）：SSE 长连接与消息入口。
//!
//! 该传输属 MCP `2024-11-05` 规范；自 `2025-03-26` 起被 Streamable HTTP 取代并标记废弃，
//! 本服务保留它只为兼容「只实现旧传输、不会回退新版」的老客户端。
//! **新接入一律用 `/mcp`**（见 `streamable` 模块），两条传输共用 `rpc` 的协议实现。
//!
//! - `sse_handler` 建立 SSE 会话，下发 endpoint 事件并转发服务端消息；
//! - `post_handler` 接收 JSON-RPC POST，处理后将响应推回对应 SSE 会话。
//!
//! 会话表随流存活（`SessionGuard`），断开即清理，防止重连导致表泄漏。

use std::collections::HashMap;
use std::convert::Infallible;

use axum::extract::{Query, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::{self, Stream, StreamExt};
use log::{info, warn};

use super::{rpc, AppState};

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
pub(super) async fn sse_handler(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let id = uuid::Uuid::new_v4().to_string();
    // 64：单会话消息缓冲上限；前端消费慢时丢弃最旧消息（下方 Lagged 分支），保证不断流
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
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
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                // 会话关闭（发送端已全部释放，防御分支），结束流
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    Sse::new(endpoint_event.chain(msg_stream)).keep_alive(KeepAlive::default())
}

/// 接收客户端 JSON-RPC POST，处理后将响应推回对应 SSE 会话。
pub(super) async fn post_handler(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    body: String,
) -> axum::http::StatusCode {
    // 解析请求（sessionId + JSON-RPC 体）：任一不合法即拒绝。
    let Some((session_id, value)) = parse_request(&params, &body) else {
        return axum::http::StatusCode::BAD_REQUEST;
    };

    if let Some(response_str) = rpc::handle_rpc(state.clone(), value).await {
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
fn parse_request(
    params: &HashMap<String, String>,
    body: &str,
) -> Option<(String, serde_json::Value)> {
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)] // 测试代码：断言失败即用例失败，JSON 索引为惯用写法
mod tests {
    use std::collections::HashMap;

    use super::*;

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
