---
title: 看板娘 — Agent Guide
created: 2026-10-17
updated: 2026-10-18
type: concept
tags: [project, tauri, live2d, mcp, rust, typescript, ai]
description: Tauri + Live2D 桌面看板娘的 Agent 开发入口：常用命令、项目结构、核心链路、硬性规则与提交前验证；规范细则见内置 skill。
sources: [.]
---

# 看板娘 — Agent Guide

> Tauri + Live2D 桌面看板娘（KanbanMascot），内置 MCP（SSE）服务：兼容 MCP 的 Agent 可通过工具调用让看板娘做动作、换表情、说话、移动、切换模型。
> 本文件只保留开发必需信息；细则通过内置 skill 按需加载（`.agents/skills/`）。子模块细则就近生效：[[src/tauri/AGENTS.md]]、[[src/frontend/AGENTS.md]]。

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm install` | 安装前端依赖 |
| `npm run tauri:dev` | 开发运行（Vite 热更新 + Tauri 窗口） |
| `make check` | 前端门禁：`tsc --noEmit` + Vite 构建（= `npm run build`）；前端改动必过 |
| `make unit` | 前端单元测试（= `npm run test`，vitest）；改领域层/纯函数必过 |
| `make lint` | Rust 门禁：clippy `--all-targets -- -D warnings` + fmt；Rust 改动必过 |
| `make verify` | 提交前全量门禁（= `make check` + `make unit` + `make lint`） |
| `make score` | Rust CRAP 复杂度打分（cargo-crap，无覆盖率数据按 0% 保守计） |
| `node cmd/client/test.mjs` | MCP 冒烟测试（需应用已启动）；协议/工具改动必跑 |
| `cargo check --all-targets` | Rust 编译快速检查（workdir: `src/tauri`） |
| `make help / dev / build / test` | Makefile 快捷入口（`check` / `lint` / `verify` 见上） |

平台为 Windows（pwsh）；msys 环境下 npm 用 `npm.cmd`。除注明外命令均在仓库根执行。

## 项目结构

| 目录 | 职责 |
|------|------|
| `src/frontend/` | 前端（feature+shared 分包：`app/` 入口、`shared/` 契约与 IPC、`mascot/`+`settings/`+`debug/` 功能域、`styles/`）：Live2D/降级渲染、MCP 指令分发、模型热切换、DOM 气泡、设置页 + 调试面板（调试面板仅开发构建）（细则 [[src/frontend/AGENTS.md]]） |
| `src/tauri/` | Rust 后端：Tauri 应用装配 + axum MCP SSE 服务 + 设置持久化与端口热重启 / 窗口置顶 / 开机自启 / 窗口平滑移动 `move_window` / 调试命令 `mcp_debug_call`（细则 [[src/tauri/AGENTS.md]]） |
| `.agents/skills/` | 内置 Skill：`architecture`（分层/契约/模式）、`comments`、`logging`、`crap-analysis`、`commit`、`agents-md`（按需加载） |
| `src/mcp/tools.json` | MCP 工具契约单一来源（Rust 与 TS 同源加载） |
| `cmd/` | MCP 冒烟测试脚本（`client/test.mjs`） |
| `models/` | Live2D 模型资源（gitignore，不入库；见 `models/README.md`） |

技术栈：Tauri 2（Windows WebView2）；Rust edition 2021 / MSRV 1.77 + axum；TypeScript（strict）+ Vite，无框架；pixi.js v6 + pixi-live2d-display（Live2D），Canvas 2D 降级。协议：MCP over SSE（JSON-RPC 2.0），默认 `127.0.0.1:7432/mcp/sse`（端口与启用状态可在设置页配置；关闭 MCP 后看板娘仍独立运行）。

## 核心链路

```
Agent（Claude Desktop 等） ──SSE / JSON-RPC──▶ Rust: axum MCP 服务（src/tauri）
                                                  │  Tauri 事件 mascot:action
                                                  ▼
                                        WebView 前端（src/frontend）
                                                  │  查询型：mascot:result 回传（oneshot，5s 超时）
                                                  ▼
                                     Live2D / 降级 控制器 → 看板娘响应
```

## 编码硬性规则（速记）

- 依赖单向：表现 → 应用 → 领域；基础设施向领域契约收敛；跨层走类型化契约，禁止裸 `any` / 无结构字符串。
- 契约先行：工具唯一来源 `src/mcp/tools.json`；事件契约 `types.ts` ↔ `state.rs` 成对维护；设置契约 `MascotSettings` ↔ `config.rs` 成对维护（启用 MCP / 端口 / 模型 / 置顶 / 视线跟随 / 不透明度 / 开机自启）；通道 `mascot:action` / `mascot:result` / `mascot:settings`。
- 注释与日志一律中文、带模块前缀；运行日志必须可查（Rust 经 `log::info!`/`log::warn!`/`log::error!` 门面、由 tauri-plugin-log 双写 stderr+文件，前端 `[mascot]` 日志经官方插件 JS 桥自动转发落盘）；Rust 错误用 `Result` 传播，禁裸 `unwrap` / `expect` / `panic`（lint 强制，受控例外仅 `tools.rs::manifest`）。
- 提交信息：每次生成 commit msg **必须**加载并遵循 skill `commit`（Conventional Commits，`type(scope): 中文 subject`，正文解释「为什么」）；未获明确要求不提交。
- 完整规则按需加载：skill `architecture` / `comments` / `logging` / `crap-analysis` / `commit`。

## 提交前验证清单

1. 前端改动：`make check` 必过（= `npm run build`，含 tsc 类型检查）；改领域层/纯函数另跑 `make unit`
2. Rust 改动：`make lint` 必过；复杂度显著上升时 `make score` 复核
3. 提交前可用 `make verify` 一次跑齐前端 + Rust 门禁
4. 协议/工具/动作改动：启动 `npm run tauri:dev` 后用 `node cmd/client/test.mjs` 冒烟测试，并人工确认看板娘有响应
5. 不提交 `dist/`、`target/`、`node_modules/`、`models/*/`；不提交密钥/凭据
6. 生成 commit msg：加载并遵循 skill `commit`（Conventional Commits，中文正文）
7. 未经用户明确要求，不要执行 git commit / push

## AGENTS.md / Skill 维护

- 模块页 7 段式：职责 / 关键文件 / 核心模式（按需）/ 开发注意事项 / 依赖关系 / References（按需）/ See Also（首行「← 上级」）；完整写作指南（内容归属 / 反模式 / 自检）→ skill `agents-md`。
- 同步时机：关键文件、工具、事件契约、公开接口、依赖关系、目录结构变更 → 更新对应 AGENTS.md；规范（架构/注释/日志）变更 → 先改 `.agents/skills/` 对应 SKILL.md，再同步 AGENTS.md 引用与摘要。
