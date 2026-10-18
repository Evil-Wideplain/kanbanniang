//! MCP 工具清单与分发。
//!
//! 单一来源是仓库的 src/mcp/tools.json：
//! 工具名/描述/参数 schema/动作路由（action、query）都从这里读取，
//! TS 侧（src/frontend/shared/domain/types.ts）同源导入。新增工具只需改清单 + 补 dispatcher case。

use std::sync::OnceLock;
use std::time::Instant;

use serde_json::{json, Value};

use log::{error, info};

use super::AppState;

#[derive(serde::Deserialize)]
struct ToolDef {
    name: String,
    description: String,
    /// JSON 键为 inputSchema（JSON Schema 惯例），这里仅以 serde rename 对齐。
    #[serde(rename = "inputSchema")]
    input_schema: Value,
    /// 前端动作名（MascotAction），目前与 name 相同，独立字段以便将来演化。
    action: String,
    /// true = 需要前端在 5s 内回传结果（查询型，或需回报执行结果的动作型）；false = 发射即返回。
    query: bool,
}

static MANIFEST: OnceLock<Vec<ToolDef>> = OnceLock::new();

/// 加载并缓存工具清单。
/// 清单经 `include_str!` 编译期嵌入：解析失败属于构建缺陷，
/// 启动期 fail-fast 优于静默返回空清单（否则所有工具调用都会报「未知工具」）。
#[allow(clippy::expect_used)] // 启动期 fail-fast 的受控例外，理由见上方文档注释
fn manifest() -> &'static [ToolDef] {
    MANIFEST.get_or_init(|| {
        serde_json::from_str(include_str!("../../../mcp/tools.json"))
            .expect("src/mcp/tools.json 不是合法工具清单")
    })
}

/// tools/list 响应中的工具数组。
/// 只投影协议允许的三个字段——action/query 是内部路由信息，绝不能泄漏进协议响应。
pub(super) fn list() -> Value {
    json!(manifest()
        .iter()
        .map(|t| json!({
            "name": t.name,
            "description": t.description,
            "inputSchema": t.input_schema,
        }))
        .collect::<Vec<_>>())
}

/// 处理 tools/call：解析参数 → 路由执行 → 封装 JSON-RPC 响应。
/// 应用内调试面板（Tauri 命令）也共用本函数——自造 JSON-RPC id 调用并原样展示完整响应帧。
pub(super) async fn call_tool(state: AppState, params: Value, id: Option<Value>) -> String {
    let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    match route(&state, name, args).await {
        Ok(result) => super::response(id, result),
        Err(e) => {
            error!("[mcp] tools/call 失败 tool={} error={}", name, e);
            super::error_resp(id, -32602, &e)
        }
    }
}

/// 工具路由核心：查清单 → 分发（查询型等待前端回传 / 动作型发射即返回）→ 记录耗时。
/// 未知工具返回 Err，由调用方组装 JSON-RPC 错误码（-32602）。
async fn route(state: &AppState, name: &str, args: Value) -> Result<Value, String> {
    let Some(tool) = manifest().iter().find(|t| t.name == name) else {
        return Err(format!("未知工具: {}", name));
    };

    let started = Instant::now();
    let (text, failure) = if tool.query {
        run_query(state, &tool.action, args).await
    } else {
        run_action(state, &tool.action, args, name).await
    };
    log_call(name, started.elapsed(), failure.as_deref());
    Ok(tool_result(text, failure.is_some()))
}

/// 查询型工具：转发前端并等待结果回传（5s），返回（展示文本, 失败原因）。
/// 前端失败信封 `{ok:false,...}` 视为工具错误；成功载荷无 ok 字段不受影响。
async fn run_query(state: &AppState, action: &str, args: Value) -> (String, Option<String>) {
    match state.dispatch(action, args, true).await {
        Ok(val) => {
            let is_error = val.get("ok").and_then(|v| v.as_bool()) == Some(false);
            (
                serde_json::to_string_pretty(&val).unwrap_or_default(),
                is_error.then(|| "前端返回失败信封".to_string()),
            )
        }
        Err(e) => (format!("查询失败: {}", e), Some(e.to_string())),
    }
}

/// 发射型工具：下发动作即返回（不等待结果），返回（展示文本, 失败原因）。
async fn run_action(
    state: &AppState,
    action: &str,
    args: Value,
    name: &str,
) -> (String, Option<String>) {
    match state.dispatch(action, args, false).await {
        Ok(_) => (format!("已触发动作: {}", name), None),
        Err(e) => (format!("执行失败: {}", e), Some(e.to_string())),
    }
}

/// 组装 tools/call 结果信封（content[0].text + isError；协议形状在此收口）。
fn tool_result(text: String, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}

/// 记录 tools/call 结果：工具名、成功/失败、耗时（毫秒）与失败原因。
/// 查询超时也走失败分支（错误文本含「前端响应超时（5s）」）。
fn log_call(name: &str, elapsed: std::time::Duration, error: Option<&str>) {
    match error {
        Some(e) => error!(
            "[mcp] tools/call 失败 tool={} 耗时={}ms error={}",
            name,
            elapsed.as_millis(),
            e
        ),
        None => info!(
            "[mcp] tools/call 完成 tool={} 耗时={}ms",
            name,
            elapsed.as_millis()
        ),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)] // 测试代码：断言失败即用例失败，JSON 索引为惯用写法
mod tests {
    use super::*;

    #[test]
    fn manifest_loads_all_tools() {
        assert!(!manifest().is_empty());
    }

    #[test]
    fn list_projects_only_protocol_fields() {
        let tools = list();
        let arr = tools.as_array().unwrap();
        assert_eq!(arr.len(), manifest().len());
        for t in arr {
            // 只暴露协议三个字段：action / query 是内部路由信息，不得泄漏。
            assert!(t.get("name").is_some());
            assert!(t.get("description").is_some());
            assert!(t.get("inputSchema").is_some());
            assert!(t.get("action").is_none());
            assert!(t.get("query").is_none());
        }
    }

    #[test]
    fn manifest_tool_names_unique() {
        let names: Vec<&str> = manifest().iter().map(|t| t.name.as_str()).collect();
        for (i, name) in names.iter().enumerate() {
            assert!(
                !names.iter().skip(i + 1).any(|n| n == name),
                "工具名重复: {name}"
            );
        }
    }
}
