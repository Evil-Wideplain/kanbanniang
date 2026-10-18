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

/// 校验端口合法性：仅拒绝 0（操作系统会分配随机端口，与「固定端口」语义冲突）。
pub fn validate_port(port: u16) -> anyhow::Result<()> {
    if port == 0 {
        anyhow::bail!("端口不能为 0");
    }
    Ok(())
}

/// 校验不透明度合法性：1~100 的百分数（0 会让看板娘完全不可见，故下限为 1）。
pub fn validate_opacity(opacity: u8) -> anyhow::Result<()> {
    if opacity == 0 || opacity > 100 {
        anyhow::bail!("不透明度需为 1~100");
    }
    Ok(())
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

/// 读取磁盘设置：文件不存在属首次运行的正常路径；内容损坏或端口非法则告警并回退。
fn read_settings(app: &AppHandle) -> Settings {
    let Some(path) = settings_path(app) else {
        return Settings::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&text) {
        Ok(mut settings) => {
            if validate_port(settings.mcp_port).is_err() {
                log::warn!(
                    "[settings] 配置端口非法（{}），回退默认端口",
                    settings.mcp_port
                );
                settings.mcp_port = DEFAULT_MCP_PORT;
            }
            if validate_opacity(settings.opacity).is_err() {
                log::warn!(
                    "[settings] 配置不透明度非法（{}），回退默认值",
                    settings.opacity
                );
                settings.opacity = 100;
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
    fn validate_port_rejects_zero_only() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(1).is_ok());
        assert!(validate_port(DEFAULT_MCP_PORT).is_ok());
        assert!(validate_port(u16::MAX).is_ok());
    }

    #[test]
    fn validate_opacity_bounds_are_1_to_100() {
        assert!(validate_opacity(0).is_err());
        assert!(validate_opacity(1).is_ok());
        assert!(validate_opacity(100).is_ok());
        assert!(validate_opacity(101).is_err());
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
