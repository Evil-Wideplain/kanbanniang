//! MCP 服务生命周期：启动 / 停止 / 按端口热重启。
//!
//! 只负责装配 axum 路由（入口处理见 `sse` 模块）与服务的启停编排；
//! 端口切换遵循「先建后销」，避免旧服务释放端口前的占用窗口。

use std::future::Future;
use std::net::SocketAddr;

use anyhow::Context;
use axum::routing::get;
use axum::Router;
use log::{error, info};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use super::streamable;
use super::AppState;

/// 运行中的 MCP 服务句柄：持有优雅关闭信号与后台任务，供重启时收旧服务。
pub struct ServerHandle {
    shutdown: oneshot::Sender<()>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl ServerHandle {
    /// 停止服务：发关闭信号并立即终结任务，释放监听端口。
    ///
    /// 不等待连接排空：客户端可能挂着未结束的请求，阻塞等待会卡住端口切换；
    /// 且新端口已先行绑定（先建后销），旧服务是否排空不影响功能。
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
            error!("[mcp] 服务异常: {e}");
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
        // Streamable HTTP 传输（唯一传输）：单端点承载 JSON-RPC（DSH 的官方 MCP 客户端使用）。
        .route(
            "/mcp",
            get(streamable::get_handler)
                .post(streamable::post_handler)
                .delete(streamable::delete_handler)
                .options(streamable::options_handler),
        )
        // 探活：DSH 插件启动前据此确认应用与 MCP 已就绪。
        .route("/health", get(streamable::health_handler))
        .with_state(state);

    info!(
        "[mcp] MCP 服务已启动: Streamable HTTP http://{}/mcp",
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
