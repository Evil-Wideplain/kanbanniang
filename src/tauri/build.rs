//! 构建脚本：生成 Tauri 上下文 + 补齐测试目标缺失的 Windows 资源。
//!
//! `tauri_build::build()` 会产出 Windows 资源（图标 / 版本信息 / **应用清单**），但只通过
//! `cargo:rustc-link-arg-bins` 发给可执行文件；测试目标拿不到清单时，进程加载阶段会去
//! System32 的 comctl32（v5.82）解析 `TaskDialogIndirect`，而该符号只有 v6 导出，
//! 于是 `cargo test` 的测试进程还没跑到第一个用例就已 `0xC0000139`（入口点未找到）。
//! 因此把同一份资源也挂给测试目标，见 `link_windows_resource_to_tests`。

use std::env;
use std::path::Path;

fn main() {
    tauri_build::build();
    link_windows_resource_to_tests();
}

/// 把 build 脚本目录下由 Tauri 生成的 `libresource.a` 同时链接给测试目标。
///
/// 非 Windows 无此问题；资源缺失（如尚未生成）时静默跳过，不打断正常构建。
fn link_windows_resource_to_tests() {
    if !cfg!(target_os = "windows") {
        return;
    }
    let Ok(out_dir) = env::var("OUT_DIR") else {
        return;
    };
    let resource = Path::new(&out_dir).join("libresource.a");
    if !resource.exists() {
        return;
    }
    println!("cargo:rustc-link-arg={}", resource.display());
}
