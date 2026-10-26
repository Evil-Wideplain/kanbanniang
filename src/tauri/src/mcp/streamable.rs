//! MCP Streamable HTTP 传输（旧版协议 2024-11-05 的无状态实现）。
//!
//! 与 `sse` 模块并列：同一个监听端口同时提供两种传输，供不同 MCP 客户端选择。
//! - `POST /mcp`：承载 JSON-RPC 消息。请求同步返回 `application/json` 响应；
//!   通知（无 id）返回 202；`initialize` 响应携带 `Mcp-Session-Id`。
//! - `GET /mcp`：协议中的服务端主动消息通道；本应用不需要服务端推送，
//!   按规范返回 405（官方 SDK 将其视为「不支持 SSE 流」而不是错误）。
//! - `DELETE /mcp`：会话终止（幂等；无状态服务不保存会话，直接 200）。
//! - `GET /health`：供 DSH 插件等外部集成方探测服务是否就绪。
//!
//! 协议版本、响应封套与工具路由全部复用 `rpc` / `tools`，本模块只做传输适配，
//! 避免同一套 JSON-RPC 语义出现两份实现。

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use log::info;
use serde_json::Value;

use super::{rpc, AppState};

/// 协议要求的会话标识头（HTTP 头名大小写不敏感）。
const SESSION_HEADER: &str = "mcp-session-id";

/// 健康检查响应：插件 / 运维脚本据此判断「应用已启动且 MCP 已监听」。
pub(super) async fn health_handler() -> Response {
    let body = serde_json::json!({
        "ok": true,
        "service": "kanban-mascot",
        "version": env!("CARGO_PKG_VERSION"),
        "transport": ["sse", "streamable-http"],
    });
    json_response(StatusCode::OK, body.to_string(), None)
}

/// Streamable HTTP 的 JSON-RPC 入口。
///
/// 单条消息与批量消息都接受：批量为空（全是通知）时回 202，否则回 JSON 数组。
/// 会话标识优先沿用客户端头部，缺失时按规范新发一个——服务本身无状态，
/// 因此不校验会话归属（本地单用户场景，校验只增加故障面）。
pub(super) async fn post_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    let Ok(value) = serde_json::from_str::<Value>(&body) else {
        log::warn!("[mcp] streamable 请求体不是合法 JSON，已拒绝");
        return json_response(
            StatusCode::BAD_REQUEST,
            rpc::error_resp(None, -32700, "Parse error"),
            None,
        );
    };

    let session = headers
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let is_initialize = value
        .get("method")
        .and_then(Value::as_str)
        .is_some_and(|method| method == "initialize");

    let response = match value {
        // 批量消息：逐条处理，通知不产生响应项。
        Value::Array(items) => {
            let mut responses = Vec::with_capacity(items.len());
            for item in items {
                if let Some(response) = rpc::handle_rpc(state.clone(), item).await {
                    responses.push(response);
                }
            }
            if responses.is_empty() {
                None
            } else {
                Some(format!("[{}]", responses.join(",")))
            }
        }
        single => rpc::handle_rpc(state, single).await,
    };

    let Some(payload) = response else {
        // 只有通知：按协议回 202 Accepted，无响应体。
        return status_response(StatusCode::ACCEPTED, Some(&session));
    };

    if is_initialize {
        info!("[mcp] streamable 会话建立 sessionId={session}");
    }
    // 只在 initialize 响应上附加会话头：后续请求由客户端回传，服务端无需重复下发。
    json_response(
        StatusCode::OK,
        payload,
        is_initialize.then_some(session.as_str()),
    )
}

/// 服务端主动消息通道：本应用没有服务端推送需求，按协议允许的方式回 405。
pub(super) async fn get_handler() -> Response {
    Response::builder()
        .status(StatusCode::METHOD_NOT_ALLOWED)
        .header(header::ALLOW, "POST, DELETE, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::empty())
        .unwrap_or_else(|_| status_response(StatusCode::METHOD_NOT_ALLOWED, None))
}

/// 会话终止：无状态实现下等价于幂等空操作。
pub(super) async fn delete_handler() -> Response {
    status_response(StatusCode::OK, None)
}

/// 浏览器预检：允许 MCP 客户端从任意本机页面发起请求（仅本机监听，风险可控）。
pub(super) async fn options_handler() -> Response {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, POST, DELETE, OPTIONS",
        )
        .header(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "content-type, mcp-session-id, mcp-protocol-version",
        )
        .body(Body::empty())
        .unwrap_or_else(|_| status_response(StatusCode::NO_CONTENT, None))
}

/// 构造 JSON 响应：统一附带 CORS 头，按需附带会话头。
fn json_response(status: StatusCode, body: String, session: Option<&str>) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if let Some(session) = session {
        if let Ok(value) = HeaderValue::from_str(session) {
            builder = builder.header(SESSION_HEADER, value);
        }
    }
    builder.body(Body::from(body)).unwrap_or_else(|_| {
        // 头值理论上始终合法：若构造失败，返回空响应的等价状态码，避免 panic。
        let mut fallback = Response::new(Body::empty());
        *fallback.status_mut() = status;
        fallback
    })
}

/// 无响应体的状态码响应（202 / 200 / 204 等）。
fn status_response(status: StatusCode, session: Option<&str>) -> Response {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    if let Some(session) = session {
        if let Ok(value) = HeaderValue::from_str(session) {
            builder = builder.header(SESSION_HEADER, value);
        }
    }
    builder.body(Body::empty()).unwrap_or_else(|_| {
        let mut fallback = Response::new(Body::empty());
        *fallback.status_mut() = status;
        fallback
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_response_sets_content_type_and_session() {
        // 直接调用私有构造器：验证协议头收口，不启动 HTTP 服务。
        let response = json_response(StatusCode::OK, "{}".to_string(), Some("abc"));
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/json")
        );
        assert_eq!(
            response
                .headers()
                .get(SESSION_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("abc")
        );
    }

    #[test]
    fn status_response_omits_session_when_absent() {
        let response = status_response(StatusCode::ACCEPTED, None);
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(response.headers().get(SESSION_HEADER).is_none());
    }
}
