---
name: logging
description: 日志规范——Rust `log::info!/log::warn!/log::error!` 门面经 tauri-plugin-log 双写落盘 / 前端 `console.*` 经官方插件 JS 桥自动转发、info/warn/error 级别语义、落盘位置与降级、必须覆盖的链路与禁止事项。添加或修改日志、排查日志缺失、审查日志质量时使用。触发词：日志、logging、log::info、log::warn、eprintln、console.log、模块前缀、打日志、trace、tauri-plugin-log。
---

# 日志规范（硬性要求）

> 日志统一走官方 **tauri-plugin-log**（Rust 侧 `log` 门面 + 前端 JS 桥），不自行实现落盘、禁止直接 `eprintln!` / `println!`。
> 保持「模块前缀」结构化格式，便于 grep 与 Agent 解析；运行期日志必须可查（含 release 无控制台场景）。

## 格式

| 端 | 格式 | 示例 |
|----|------|------|
| Rust | 按级别选用 `log::info!` / `log::warn!` / `log::error!`（用法同 `eprintln!`；经插件双写 stderr+文件，行尾由插件格式化追加 `level=xx`；禁止直接 `eprintln!`） | `log::info!("[mcp] SSE 会话建立 sessionId={session_id}")` |
| 前端 | `console.info/warn/error("[mascot] 中文消息", { 结构化数据 })`（`[mascot]` 前缀由 `shared/ipc/log-forward.ts` 经官方插件 JS 桥转发落盘） | `console.info("[mascot:core] 模型切换完成", { from, to })` |

模块前缀约定：Rust `[mcp]` / `[state]` / `[tauri]` / `[log]`；前端 `[mascot]`，细分子模块可用 `[mascot:core]`、`[mascot:live2d]` 等。

Rust 禁止 `println!`（由 `clippy::print_stdout` 强制）：GUI 应用 stdout 不可见，日志一律 stderr。

## 落盘与查看

- 注册入口：`src/tauri/src/log_setup.rs::plugin()`（`tauri_plugin_log::Builder` 配置，由 `lib.rs` 随 Tauri 启动注册）；targets = Stderr + 可执行文件目录（不可写时回退 LogDir）
- 日志文件：可执行文件同目录（dev 为 `target/debug/`，release 为安装目录）下的 `KanbanMascot.log`（文件名默认取 `productName`）；目录不可写时回退 `app_log_dir()`（Windows：`%LOCALAPPDATA%\<bundle id>\logs\`）；行格式 = UTC 时间戳 + 消息 + `level=xx`（如 `2026-10-17T09:02:42Z [mcp] SSE 会话建立 sessionId=xxx level=info`）
- 级别过滤 `LevelFilter::Info`（debug/trace 不落盘）；滚动策略：超过 5 MiB 归档为带日期文件、保留 1 份（`RotationStrategy::KeepSome(1)`）
- 前端：`[mascot]` 前缀的 `console.*` 由 `src/frontend/shared/ipc/log-forward.ts` 拦截，经官方插件 JS 桥（`@tauri-apps/plugin-log`，需 `log:default` 权限）转发后端落盘；附加参数序列化为 `data=`（Error 提级为 `{name,message}`，超 2000 字符截断）；非 Tauri 环境仅保留本地 console
- 日志是旁路：写失败/插件不可用不得阻断主流程，静默跳过或降级即可

## 级别语义

| 级别 | 语义 | 示例 |
|------|------|------|
| `info` | 生命周期事件 | 服务启动、SSE 会话建立/断开、事件通道连接、控制器创建、切换完成 |
| `warn` | 可恢复的降级 | 非 Tauri 环境、清单不一致、动作回退、切换失败回滚、别名未命中 |
| `error` | 失败 | 工具调用失败、查询超时、指令处理异常、Live2D 初始加载失败 |

Rust 侧三档级别直接用 `log` 门面宏（按语义选用 `info!` / `warn!` / `error!`，全路径 `log::info!` 亦可）；前端 `console.info/warn/error` 的级别经 JS 桥原样透传落盘。

## 必须覆盖的链路（新增/修改时保留或补齐）

- 服务启动（含监听地址、日志文件落盘路径）
- MCP 会话建立与断开（含 sessionId）
- 客户端 `initialize`（客户端名与版本）、`tools/list`（工具数量）
- 请求被拒（缺 sessionId / JSON 非法 / 会话不存在导致响应丢弃 / 未知方法）
- `tools/call` 工具名、成功/失败、耗时、超时（5s）
- 前端：指令进入（`mascot:action`，含动作与指令 id）与结果回传失败
- 前端：每个动作的执行结果（动作/表情生效或回退；查询型含数量/快照）
- 模型切换结果（切换前后档案 id、成功或回滚原因）

## 禁止事项

- 循环内高频打日志
- 输出大段二进制/模型文件内容
- 多行 dump 代替结构化字段
- 裸 `console.log` 调试残留
- 绕过统一入口写日志（Rust 直接 `eprintln!`、前端无 `[mascot]` 前缀的 `console.*`）：不会落盘，等价于日志缺失

## 相关 skill

- 注释怎么写 → `comments`；代码放哪层 → `architecture`；提交前质量门禁 → `crap-analysis`。
