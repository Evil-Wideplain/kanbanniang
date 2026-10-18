//! JSON-RPC 协议层：方法路由与响应封套。
//!
//! 处理 `initialize` / `ping` / `tools/list` / `tools/call` 与通知；
//! `tools/call` 交 `tools` 模块路由，其余同步方法在此就地应答。
//! 协议版本与字段序在此收口（`response` / `error_resp` 成对）。

use serde_json::{json, Value};

use log::{info, warn};

use super::{tools, AppState};

/// 解析 JSON-RPC 请求，返回需要经 SSE 回传的响应字符串（通知类返回 None）。
pub(super) async fn handle_rpc(state: AppState, req: Value) -> Option<String> {
    let method = req.get("method").and_then(Value::as_str)?;
    let id = req.get("id").cloned();

    // tools/call 需异步转发前端并等待结果回传，单独处理后再统一包封套。
    if method == "tools/call" {
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        return Some(tools::call_tool(state, params, id).await);
    }
    respond_sync(method, &req, id)
}

/// 同步方法应答：通知（id 缺失或为 null）不回；未知方法回 -32601。
fn respond_sync(method: &str, req: &Value, id: Option<Value>) -> Option<String> {
    if id.as_ref().map_or(true, Value::is_null) {
        return None;
    }
    Some(match rpc_result(method, req) {
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
pub(crate) fn response(id: Option<Value>, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// JSON-RPC 错误响应封套（与 `response` 成对）。
pub(crate) fn error_resp(id: Option<Value>, code: i64, msg: &str) -> String {
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
}
