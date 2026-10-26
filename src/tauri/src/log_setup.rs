//! 日志装配（基础设施层）：官方 `tauri-plugin-log` 的配置与注册入口。
//! 落盘/格式化/滚动由插件负责，本模块只声明「写到哪、怎么写、留几份」。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// 落盘行时间戳格式：UTC、秒级精度（如 `2026-10-17T08:36:51Z`）。
const LOG_TS_FORMAT: &[time::format_description::FormatItem<'static>] =
    time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second]Z");

/// `plugin()` 选定的日志文件目录（无值 = 回退系统日志目录，由插件解析）。
static FILE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 组装官方日志插件：stderr + 日志文件双写（GUI 应用 stdout 不可见），
/// 行格式与历史规范一致（UTC 时间戳 + 消息 + `level=xx`），5 MiB 滚动、归档保留 1 份。
pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(1))
        .targets([Target::new(TargetKind::Stderr), Target::new(file_target())])
        .format(|out, message, record| {
            out.finish(format_args!(
                "{} {message} level={}",
                time::OffsetDateTime::now_utc()
                    .format(LOG_TS_FORMAT)
                    .unwrap_or_default(),
                level_name(record.level())
            ))
        })
        .build()
}

/// 本进程日志文件目录：仅当选用「可执行文件同目录」时有值（供启动日志输出定位信息）。
pub(crate) fn file_dir() -> Option<&'static Path> {
    FILE_DIR.get().map(PathBuf::as_path)
}

/// `log::Level` → 小写级别名（对齐落盘行 `level=xx` 与前端 console 方法名）。
/// `Level::as_str()` 返回大写，统一转小写。
fn level_name(level: log::Level) -> String {
    level.as_str().to_ascii_lowercase()
}

/// 日志文件目标：优先可执行文件同目录（便于就近查看、随包分发）；
/// 目录不可写时回退 `app_log_dir()`（AppData），避免日志初始化失败拖垮启动。
fn file_target() -> TargetKind {
    match exe_dir() {
        Some(dir) if is_writable(&dir) => {
            // 记录实际目录供启动日志展示；本函数只会被调用一次，重复设置不会发生
            let _ = FILE_DIR.set(dir.clone());
            TargetKind::Folder {
                path: dir,
                file_name: None,
            }
        }
        _ => TargetKind::LogDir { file_name: None },
    }
}

/// 当前可执行文件所在目录（无法解析时为 None）。
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .parent()
        .map(Path::to_path_buf)
}

/// 试写探针文件判断目录可写：插件初始化失败会导致整个应用启动失败，因此先探测再决定目标。
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".kanbanniang-log-probe");
    let writable = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    writable
}
