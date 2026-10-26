---
name: crap-analysis
description: 用 cargo-crap 计算 Rust 函数级 CRAP 风险分（圈复杂度 × 覆盖率组合），找出「高复杂度 + 低测试」的函数并给出修复方向。用于重构决策、提交前风险检查、代码质量审计。触发词：CRAP、复杂度、圈复杂度、代码风险、cargo-crap、make score、该拆哪个函数、代码质量门禁、重构。
---

# CRAP 代码风险分析（Rust / cargo-crap）

> CRAP = Change Risk Anti-Patterns（变更风险反模式）
> 公式：`CRAP(m) = CC(m)² × (1 - cov(m))³ + CC(m)`

## 快速使用

```bash
make score                        # 仓库根快捷入口（= cd src/tauri && cargo crap）
cd src/tauri && cargo crap        # 直接运行；默认阈值 30，输出人类可读表格
```

判读输出：

- `✗`：CRAP 超阈值（默认 30），必须处理；`▲`：超阈值 1/3，计划内处理；`✓`：安全。
- 已补 Rust 单测（`cargo test --lib`：`config.rs` / `mcp/`），但尚未接入覆盖率：不提供 `--lcov` 时覆盖率列显示 `—`，按 `--missing pessimistic` 视为 0% 覆盖（分数 = CC² + CC，结果偏严）。补测试并接入 `--lcov` 后分数会显著下降。
- 降分只有两条正路：**拆函数**（降 CC）或**补测试**（升 cov）。不要靠删测试、加屏蔽降分——根因永远在代码本身。

## Windows 安装（重要）

- 推荐：从 GitHub Releases 下载 `cargo-crap-x86_64-pc-windows-msvc.zip`，解压 `cargo-crap.exe` 到 PATH；或 `cargo binstall cargo-crap`。
- **不要用 `cargo install` 源码安装**：本仓库有 rustup 目录 override（`stable-x86_64-pc-windows-gnu`），GNU 工具链构建的产物启动即崩溃（0xC0000005，连 `--help` 都崩）。

## 接入覆盖率（可选）

```bash
cargo install cargo-llvm-cov
cd src/tauri && cargo llvm-cov --lcov --output-path lcov.info
cd src/tauri && cargo crap --lcov lcov.info
```

当前无测试时 llvm-cov 也是全 0%，接入意义不大；补上测试后再启用。

## 常用 CLI 选项

| 选项 | 用途 |
|------|------|
| `--lcov <FILE>` | 使用 LCOV 覆盖率文件（缺省时按 `--missing` 策略处理） |
| `--threshold <N>` | 风险阈值，默认 30 |
| `--top <N>` / `--min <SCORE>` | 只看最差的 N 个 / 只显示 ≥ 分数的函数 |
| `--summary` | 聚合统计（总数、超标数、最差函数） |
| `--duplicates` | 附带重复函数检测（`--dup-threshold` 默认 0.82） |
| `--format {human,json,markdown,sarif,...}` | 输出格式；`json` 可配合 `--baseline` 做回归对比 |
| `--fail-above` | 有函数超阈值时退出码 1（CI 门禁用） |
| `--fail-regression --baseline <FILE>` | 分数相对基线上升时退出码 1 |
| `--exclude <GLOB>` / `--allow <GLOB>` | 排除文件 / 隐藏函数（慎用，勿用来掩盖问题） |
| `--no-cache` | 跳过分析缓存，强制重新解析 |

退出码：`0` 正常；`1` 触发了 `--fail-above` / `--fail-regression`；`2` 运行失败（用法/输入/分析错误）。

## 当前基线（2026-10-17，第二轮热点拆分后）

74 个函数，0 个超阈值 30（实测 `cargo crap --summary`）。最高档为 CRAP 30（CC 5）：

| 函数 | CRAP | CC | 位置 |
|------|------|-----|------|
| `save_settings` | 30 | 5 | `src/tauri/src/commands.rs` |
| `reconcile_mcp` | 30 | 5 | `src/tauri/src/commands.rs` |
| `apply_autostart` | 30 | 5 | `src/tauri/src/commands.rs` |
| `config::save` | 30 | 5 | `src/tauri/src/config.rs` |
| `read_settings` | 30 | 5 | `src/tauri/src/config.rs` |
| `rpc_result` | 30 | 5 | `src/tauri/src/mcp/rpc.rs` |
| `on_menu_event` | 30 | 5 | `src/tauri/src/tray.rs` |

第二档 CRAP 20（CC 4）：`switch_model_if_changed`、`respond_sync`、`post_handler`、`AppStateInner::await_result`、`build_menu`、`toggle_window`。

两轮改进（同一批热点，第一轮 → 第二轮）：

| 函数 | CRAP | CC | 拆分手法 |
|------|------|-----|----------|
| `tray::init` | 72 → 12 | 8 → 3 | 抽出 `build_menu` / `apply_icon` / `on_menu_event` / `on_tray_icon_event` |
| `save_settings` | 240 → 42 → 30 | → 5 | 抽出 `reconcile_mcp` / `apply_runtime_prefs` |
| `reconcile_mcp` | 42 → 30 | 6 → 5 | 抽出失败回滚 `rollback_mcp` |
| `handle_rpc` | 110 → 42 → 12 | → 3 | 抽出 `respond_sync`（通知/未知方法分支） |
| `call_tool` | 42 → ≤6 | 6 → ≤2 | 抽出 `run_query` / `run_action` |
| `AppStateInner::dispatch` | 42 → 12 | 6 → 3 | 抽出 `await_result`（超时等待） |
| `toggle_window` | 42 → 20 | 6 → 4 | 抽出 `hide_window` / `show_window` |
| `level_name` | 42 → <6 | 6 → 1 | 改 `Level::as_str().to_ascii_lowercase()` 取代 5 臂 match |
| `config::save` | 42 → 30 | 6 → 5 | 抽出 `ensure_parent_dir` |

剩余 CRAP 30 一档的分支多为其语义本身（协议分发 / 校验 / 平台 API 读写），继续拆收益递减；真正的降分杠杆是补测试（cov 上升）。

已补 Rust 单测（`config.rs` 校验/默认值、`mcp/rpc.rs` 路由/封套、`mcp/sse.rs` 请求解析、`mcp/tools.rs` 清单投影，`cargo test --lib`），但尚未接入覆盖率：本机仍缺 `cargo llvm-cov` 所需的插桩测试链路，`--lcov` 暂无法本地产出。注意此前「测试 exe 链接失败」的说法已不成立——那是**运行时缺应用清单**（`comctl32!TaskDialogIndirect` 属 v6 导出，测试目标未链接 `tauri-build` 生成的 Windows 资源，加载期即 `0xC0000139`），已由 `src/tauri/build.rs::link_windows_resource_to_tests` 修复，`cargo test --lib` 现在可直接跑。接入覆盖率后 `cargo llvm-cov --lcov --output-path lcov.info` + `cargo crap --lcov lcov.info` 可让分数显著下降。

重构这些热点时以「分数不继续上升」为约束；重构后重跑 `make score`，把新基线同步到本文件与 `src/tauri/AGENTS.md`。

## 修复指引

1. 优先拆函数：识别可独立的分支块（如 `handle_rpc` 的各 method 分支），提取为独立函数并各自可测。
2. 拆完后跑 `make lint` 确认零告警，再跑 `make score` 确认分数下降。
3. 触达协议/工具行为时，按 [src/tauri/AGENTS.md](../../../src/tauri/AGENTS.md) 的门禁与冒烟测试流程验证（`node cmd/client/test.mjs`）。

## 参考

- 工具：[cargo-crap](https://github.com/minikin/cargo-crap)
- 原始概念：[Crap4J](http://www.crap4j.org/)（Uncle Bob 团队提出）
- 仓库内规范：[src/tauri/AGENTS.md](../../../src/tauri/AGENTS.md)

## 相关 skill

- 代码放哪层 → `architecture`；注释怎么写 → `comments`；日志怎么打 → `logging`。
