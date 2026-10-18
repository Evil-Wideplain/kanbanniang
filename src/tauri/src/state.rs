//! 共享状态与事件回传端口。
//!
//! 跨端链路都在这里收口：
//! - 后端 → 前端：`dispatch()` 经 Tauri 事件 `mascot:action` 下发指令；
//! - 前端 → 后端：`spawn_result_listener()` 监听 `mascot:result`，
//!   用 oneshot 通道唤醒等待中的查询（5s 超时）。
//!
//! 类型定义与前端 `src/frontend/shared/domain/types.ts` 成对镜像，改动必须两侧同步。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use log::warn;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener};
use tokio::sync::{broadcast, oneshot};

/// Tauri 事件通道名契约（与前端 `shared/domain/types.ts` 的 `CHANNELS` 成对维护）。
pub mod channels {
    /// 后端 → 前端：下发 MCP 动作指令。
    pub const ACTION: &str = "mascot:action";
    /// 前端 → 后端：回传查询型动作结果。
    pub const RESULT: &str = "mascot:result";
    /// 后端 → 前端：广播设置变更。
    pub const SETTINGS: &str = "mascot:settings";
}

/// 后端转发给前端的指令（与 src/frontend/shared/domain/types.ts 的 MascotCommand 对应）。
#[derive(Serialize, Clone)]
pub struct MascotCommand {
    /// 本次指令唯一 id；查询型指令回传结果时必须原样带回。
    pub id: String,
    /// 动作名（MascotAction）。
    pub action: String,
    /// 动作参数（不同动作结构不同，schema 见 src/mcp/tools.json）。
    pub params: Value,
}

/// 前端回传的查询结果（与 src/frontend/shared/domain/types.ts 的 MascotResult 对应）。
#[derive(serde::Deserialize)]
pub struct FrontendResult {
    /// 对应下发指令的 id。
    pub id: String,
    /// 前端处理是否成功。
    pub ok: bool,
    /// 成功时的结果载荷（任意 JSON）。
    pub result: Value,
    /// 失败原因（ok=false 时使用）；缺失视为 None，兼容旧版前端。
    #[serde(default)]
    pub error: Option<String>,
}

/// 跨线程共享的应用状态：持有 AppHandle（用于发射事件）、SSE 会话表、
/// 以及查询型工具等待前端回传结果的 oneshot 通道。
/// 线程安全由内部 Mutex 保证；表结构一律经访问器方法读写。
pub struct AppStateInner {
    /// Tauri 应用句柄：向 WebView 发射 `mascot:action` 事件。
    app: AppHandle,
    /// SSE 会话表：会话 id → 广播发送端（消息经 SSE 流回传）。
    sessions: Mutex<HashMap<String, broadcast::Sender<String>>>,
    /// 待回传结果表：指令 id → oneshot 发送端（查询型工具用）。
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl AppStateInner {
    /// 构造共享状态（app 句柄用于后续事件发射）。
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// 取会话表（SSE 会话 id → 广播发送端）。
    /// 锁中毒（持锁线程曾 panic）时取回内部数据继续服务：该表只是会话索引，
    /// 不存在会被中断破坏的结构性不变量，自愈优于让后续请求级联 panic。
    pub fn sessions(&self) -> MutexGuard<'_, HashMap<String, broadcast::Sender<String>>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 取待回传结果表（指令 id → oneshot 发送端）。中毒自愈策略同 `sessions()`。
    fn pending(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<Value>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 把一次 MCP 指令发给前端看板娘。
    /// - query=false：发射即返回 "ok"。
    /// - query=true：注册 oneshot，等待前端通过 mascot:result 事件回传，
    ///   最多等待 5 秒（查询型，或需回报执行结果的动作型）。
    pub async fn dispatch(
        &self,
        action: &str,
        params: Value,
        query: bool,
    ) -> anyhow::Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let cmd = MascotCommand {
            id: id.clone(),
            action: action.to_string(),
            params,
        };
        self.app.emit(channels::ACTION, &cmd)?;

        if !query {
            return Ok(Value::String("ok".into()));
        }

        let (tx, rx) = oneshot::channel::<Value>();
        self.pending().insert(id.clone(), tx);
        self.await_result(id, rx).await
    }

    /// 等待前端回传查询结果（最多 5 秒）。
    /// 超时后必须从 pending 表移除，防止前端迟到回传匹配到已放弃的通道（表泄漏）。
    async fn await_result(
        &self,
        id: String,
        rx: oneshot::Receiver<Value>,
    ) -> anyhow::Result<Value> {
        let timeout = std::time::Duration::from_secs(crate::mcp::QUERY_TIMEOUT_SECS);
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(val)) => Ok(val),
            Ok(Err(_)) => Err(anyhow::anyhow!("前端连接已断开，无法获取结果")),
            Err(_) => {
                self.pending().remove(&id);
                Err(anyhow::anyhow!(
                    "前端响应超时（{}s）",
                    crate::mcp::QUERY_TIMEOUT_SECS
                ))
            }
        }
    }
}

/// 在 Tauri 中注册监听器：接收前端回传的查询结果，唤醒对应的 oneshot。
/// 必须在 Tauri 运行时内调用（setup 阶段）。
pub fn spawn_result_listener(app: &AppHandle, state: std::sync::Arc<AppStateInner>) {
    let _ = app.listen(channels::RESULT, move |event| {
        let res = match serde_json::from_str::<FrontendResult>(event.payload()) {
            Ok(res) => res,
            // 载荷不合法说明前端契约不一致：必须记录，否则查询只会表现为 5s 超时
            Err(e) => {
                warn!("[state] mascot:result 载荷解析失败: {e}");
                return;
            }
        };
        if let Some(tx) = state.pending().remove(&res.id) {
            // 失败时转发结构化信封，否则调用方只能收到裸 null
            let v = if res.ok {
                res.result
            } else {
                serde_json::json!({
                    "ok": false,
                    "error": res.error.unwrap_or_else(|| "前端返回失败".into())
                })
            };
            let _ = tx.send(v);
        }
    });
}
