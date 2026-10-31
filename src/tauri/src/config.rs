//! 应用设置持久化（基础设施层）。
//!
//! 设置以 JSON 存于应用配置目录（`settings.json`）：文件缺失或损坏一律回退默认值，
//! 保证应用总能启动。字段采用 camelCase 序列化，与前端 `shared/domain/types.ts` 的
//! `MascotSettings` 成对镜像，改动必须两侧同步。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::mcp::DEFAULT_MCP_PORT;

/// 持久化设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// 是否启用内置 MCP 服务（关闭后不监听端口，看板娘仍可独立运行）。
    #[serde(default = "default_true")]
    pub mcp_enabled: bool,
    /// 内置 MCP 服务监听端口。
    pub mcp_port: u16,
    /// 启动时加载的模型档案 id；空串表示「未指定」，由前端回退到默认档案。
    pub model_id: String,
    /// 看板娘窗口是否置顶（应用主窗口的 always-on-top）。
    pub always_on_top: bool,
    /// 是否让看板娘视线跟随鼠标（前端读取全局光标实现；仅 Live2D 模式生效）。
    #[serde(default = "default_true")]
    pub gaze_follow: bool,
    /// 看板娘不透明度（1~100 的百分数，作用于前端画布）。
    pub opacity: u8,
    /// 是否开机自启（注册到系统登录项）。
    pub autostart: bool,
}

/// 旧配置文件缺字段时的默认值（保持「默认启用 MCP」的后向兼容）。
fn default_true() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mcp_enabled: true,
            mcp_port: DEFAULT_MCP_PORT,
            model_id: String::new(),
            always_on_top: true,
            gaze_follow: true,
            opacity: 100,
            autostart: false,
        }
    }
}

/// 内存中的设置副本：避免每次命令调用都读盘，并作为当前有效设置的唯一来源。
pub struct SettingsStore {
    settings: Mutex<Settings>,
}

impl SettingsStore {
    /// 从磁盘加载设置并构造（缺失/损坏回退默认值，仅告警不阻断启动）。
    pub fn load(app: &AppHandle) -> Self {
        Self {
            settings: Mutex::new(read_settings(app)),
        }
    }

    /// 取当前设置快照。锁中毒自愈（同 `AppStateInner` 的访问器策略）。
    pub fn get(&self) -> Settings {
        lock(&self.settings).clone()
    }

    /// 更新内存副本（落盘由 `save()` 单独负责）。
    pub fn set(&self, next: Settings) {
        *lock(&self.settings) = next;
    }
}

/// 收敛越界设置值：端口 0 回退默认端口，不透明度不在 1~100 回退 100。
/// 返回是否发生了修正（供调用方决定是否落告警日志）。
///
/// 为什么只收敛、不做校验报错：取值规则的用户可见报错归前端
/// （`shared/domain/settings.ts` 的 `validatePort` / `validateOpacity`，设置页据此就地提示），
/// 后端再存一份同样的规则与中文错误码就是双份真相。但「读盘」与「IPC 入参」两条入口
/// 都必须收敛——否则非法值会原样落盘（端口 0 会让操作系统每次分配随机端口，
/// 与「固定端口」语义冲突；不透明度 0 会让看板娘完全不可见）。
pub fn normalize(settings: &mut Settings) -> bool {
    let mut changed = false;
    if settings.mcp_port == 0 {
        settings.mcp_port = DEFAULT_MCP_PORT;
        changed = true;
    }
    if settings.opacity == 0 || settings.opacity > 100 {
        settings.opacity = 100;
        changed = true;
    }
    changed
}

/// 把设置写入磁盘（自动创建配置目录）。
pub fn save(app: &AppHandle, settings: &Settings) -> anyhow::Result<()> {
    let path = settings_path(app).ok_or_else(|| anyhow::anyhow!("无法解析应用配置目录"))?;
    ensure_parent_dir(&path)?;
    std::fs::write(&path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

/// 确保设置文件的父目录存在（首次运行时自动创建）。
fn ensure_parent_dir(path: &std::path::Path) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

/// 读取磁盘设置：文件不存在属首次运行的正常路径；内容损坏或字段越界则告警并回退。
fn read_settings(app: &AppHandle) -> Settings {
    let Some(path) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut settings) => {
            if normalize(&mut settings) {
                log::warn!(
                    "[settings] 配置含越界值，已收敛（端口 {}，不透明度 {}）",
                    settings.mcp_port,
                    settings.opacity
                );
            }
            settings
        }
        Err(e) => {
            log::warn!("[settings] 设置文件解析失败，回退默认值: {e}");
            Settings::default()
        }
    }
}

/// 设置文件路径：`<app_config_dir>/settings.json`。
fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

/// 取锁：中毒（持锁线程曾 panic）时取回内部数据继续服务，避免级联 panic。
fn lock(mutex: &Mutex<Settings>) -> MutexGuard<'_, Settings> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // 测试代码：断言失败即用例失败，属受控例外
mod tests {
    use super::*;

    #[test]
    fn normalize_converges_invalid_port() {
        let mut settings = Settings {
            mcp_port: 0,
            ..Settings::default()
        };
        assert!(normalize(&mut settings));
        assert_eq!(settings.mcp_port, DEFAULT_MCP_PORT);
        for port in [1, DEFAULT_MCP_PORT, u16::MAX] {
            settings.mcp_port = port;
            assert!(!normalize(&mut settings), "合法端口不应被修正: {port}");
            assert_eq!(settings.mcp_port, port);
        }
    }

    #[test]
    fn normalize_opacity_bounds_are_1_to_100() {
        let mut settings = Settings::default();
        for (input, expected) in [(0u8, 100u8), (1, 1), (100, 100), (101, 100), (u8::MAX, 100)] {
            settings.opacity = input;
            let changed = normalize(&mut settings);
            assert_eq!(settings.opacity, expected, "不透明度 {input}");
            assert_eq!(
                changed,
                input != expected,
                "修正标记与是否越界不一致: {input}"
            );
        }
    }

    #[test]
    fn default_settings_match_contract() {
        let s = Settings::default();
        assert_eq!(s.mcp_port, DEFAULT_MCP_PORT);
        assert!(s.mcp_enabled);
        assert!(s.always_on_top);
        assert!(s.gaze_follow);
        assert_eq!(s.opacity, 100);
        assert!(!s.autostart);
        assert!(s.model_id.is_empty());
    }

    #[test]
    fn settings_serialize_as_camel_case() {
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("\"mcpPort\""));
        assert!(json.contains("\"mcpEnabled\""));
    }
}
