---
title: 看板娘 — Agent Guide
created: 2026-10-17
updated: 2026-10-26
type: concept
tags: [project, tauri, live2d, mcp, rust, typescript, ai, dsh-plugin]
description: Tauri + Live2D 桌面看板娘的 Agent 开发入口：常用命令、项目结构、核心链路、硬性规则与提交前验证；含 DSH 插件装配（Streamable HTTP + 宿主插件）；规范细则见内置 skill。
sources: [.]
---

# 看板娘 — Agent Guide

> Tauri + Live2D 桌面看板娘（KanbanMascot），内置 MCP 服务（**Streamable HTTP + SSE 双传输**）：兼容 MCP 的 Agent 可通过工具调用让看板娘做动作、换表情、说话、移动、切换模型。
> 本仓库同时是 **DSH 插件包**：安装到 DSH 后，DSH 启动时自动拉起看板娘，并把工具注册为 `mcp__kanban_mascot__*`。
> 本文件只保留开发必需信息；细则通过内置 skill 按需加载（`.agents/skills/`）。子模块细则就近生效：[[src/tauri/AGENTS.md]]、[[src/frontend/AGENTS.md]]、[[src/plugin/AGENTS.md]]。

## 常用命令

| 命令 | 作用 |
|------|------|
| `npm install` | 安装前端依赖 |
| `npm run tauri:dev` | 开发运行（Vite 热更新 + Tauri 窗口） |
| `make check` | 前端门禁：`tsc --noEmit` + Vite 构建（= `npm run build`）；前端改动必过 |
| `make unit` | 单元测试（= `npm run test` + `npm run test:plugin`，vitest）；改领域层/纯函数/插件逻辑必过 |
| `make lint` | Rust 门禁：clippy `--all-targets -- -D warnings` + fmt；Rust 改动必过 |
| `make verify` | 提交前全量门禁（= `make check` + `make unit` + `make lint`） |
| `make score` | Rust CRAP 复杂度打分（cargo-crap，无覆盖率数据按 0% 保守计） |
| `node cmd/client/test.mjs` | MCP 冒烟测试（SSE，需应用已启动）；协议/工具改动必跑 |
| `node cmd/client/test-streamable.mjs` | MCP 冒烟测试（Streamable HTTP，零依赖，需应用已启动） |
| `npm run plugin:build` | 编译 DSH 宿主插件（`src/plugin` → `lib/`） |
| `npm run plugin:install` | 安装到 DSH desktop profile（自动 build；需已 `make build`） |
| `npm run plugin:uninstall` | 从 DSH desktop profile 卸载 |
| `cargo check --all-targets` | Rust 编译快速检查（workdir: `src/tauri`） |
| `make help / dev / build / test` | Makefile 快捷入口（`check` / `lint` / `verify` 见上） |

平台为 Windows（pwsh）；msys 环境下 npm 用 `npm.cmd`。除注明外命令均在仓库根执行。
安装/卸载 DSH 插件需用桌面端自带的 `dsh.cmd`（PATH 上的 npm `dsh` 会拒绝 desktop profile），脚本已自动处理。

## 项目结构

| 目录 | 职责 |
|------|------|
| `src/frontend/` | 前端（feature+shared 分包：`app/` 入口、`shared/` 契约与 IPC、`mascot/`+`settings/`+`debug/` 功能域、`styles/`）：Live2D 渲染、MCP 指令分发、模型热切换、DOM 气泡、设置页 + 调试面板（调试面板仅开发构建）（细则 [[src/frontend/AGENTS.md]]） |
| `src/tauri/` | Rust 后端：Tauri 应用装配 + axum MCP 双传输服务（Streamable HTTP + SSE）+ `/health` + 设置持久化与端口热重启 / 窗口置顶 / 开机自启 / 窗口平滑移动 `move_window` / 调试命令 `mcp_debug_call`（细则 [[src/tauri/AGENTS.md]]） |
| `src/plugin/` | DSH 宿主插件半侧（TS → `lib/`）：读取应用设置解析 MCP 端点、发布 `mascotStartup` 服务、探活/拉起看板娘、双写插件日志（细则 [[src/plugin/AGENTS.md]]） |
| `cordis.patch.yml` | DSH bundle patch：插入宿主插件 + `@deepseek-ai/dsh-mcp-client` 两行（工具命名空间 `mcp__kanban_mascot__*`） |
| `scripts/install-dsh-plugin.mjs` | 安装/卸载到 DSH profile（调用桌面端自带 `dsh.cmd`，含 build 与校验） |
| `.agents/skills/` | 内置 Skill：`architecture`（分层/契约/模式）、`comments`、`logging`、`crap-analysis`、`commit`、`agents-md`（按需加载） |
| `src/mcp/tools.json` | MCP 工具契约单一来源（Rust 与 TS 同源加载） |
| `cmd/` | MCP 冒烟测试脚本（`client/test.mjs`、`client/test-streamable.mjs`） |
| `models/` | Live2D 模型资源（gitignore，不入库；见 `models/README.md`） |

技术栈：Tauri 2（Windows WebView2）；Rust edition 2021 / MSRV 1.77 + axum；TypeScript（strict）+ Vite，无框架；pixi.js v6 + pixi-live2d-display（Live2D）。协议：MCP over Streamable HTTP（`POST 127.0.0.1:7432/mcp`）与旧版 SSE（`/mcp/sse`），JSON-RPC 2.0；端口与启用状态可在设置页配置（关闭 MCP 后看板娘仍独立运行）。DSH 插件半侧复用同一端点，DSH 侧工具名 `mcp__kanban_mascot__<tool>`。

## 核心链路

```
DSH（插件系统 + MCP 客户端）        Claude Desktop 等
   │ Streamable HTTP                    │ SSE / Streamable HTTP
   ▼                                    ▼
Rust: axum MCP 服务（src/tauri，/mcp · /mcp/sse · /health）
   │  Tauri 事件 mascot:action
   ▼
WebView 前端（src/frontend）── 查询型：mascot:result 回传（oneshot，5s 超时）
   ▼
Live2D 控制器 → 看板娘响应

DSH 启动 → src/plugin 宿主插件（读 settings.json 端口 → provide mascotStartup）
        → 探活 /health → 未运行则拉起 target/release exe → dsh-mcp-client 连同一 URL
```

## 编码硬性规则（速记）

- 依赖单向：表现 → 应用 → 领域；基础设施向领域契约收敛；跨层走类型化契约，禁止裸 `any` / 无结构字符串。
- 契约先行：工具唯一来源 `src/mcp/tools.json`；事件契约 `types.ts` ↔ `state.rs` 成对维护；设置契约 `MascotSettings` ↔ `config.rs` 成对维护（启用 MCP / 端口 / 模型 / 置顶 / 视线跟随 / 不透明度 / 开机自启）；通道 `mascot:action` / `mascot:result` / `mascot:settings`。
- MCP 端点单一来源：看板娘 `settings.json` 的 `mcpEnabled` / `mcpPort`（插件读取）；`cordis.patch.yml` 只声明依赖与兜底，不得再写一份端口；插件通过 `mascotStartup` 服务把 URL 交给 MCP 客户端行。宿主插件**任何失败路径都必须 `ctx.provide`**，否则 inject 该服务的行会 PENDING 并导致 DSH 启动失败。
- 注释与日志一律中文、带模块前缀；运行日志必须可查（Rust 经 `log::info!`/`log::warn!`/`log::error!` 门面、由 tauri-plugin-log 双写 stderr+文件，前端 `[mascot]` 日志经官方插件 JS 桥自动转发落盘，DSH 宿主插件日志双写 `<DSH_HOME>/kanban-mascot/plugin.log`）；Rust 错误用 `Result` 传播，禁裸 `unwrap` / `expect` / `panic`（lint 强制，受控例外仅 `tools.rs::manifest`）。
- DSH 宿主插件（`src/plugin/`）不 import DSH 内部包（安装目录无法保证解析）；只按用到的能力镜像 Cordis 契约（`dsh.ts`）。协议字段（tools.json）仍是唯一工具来源，插件不重复定义工具。
- 提交信息：每次生成 commit msg **必须**加载并遵循 skill `commit`（Conventional Commits，`type(scope): 中文 subject`，正文解释「为什么」）；未获明确要求不提交。
- 完整规则按需加载：skill `architecture` / `comments` / `logging` / `crap-analysis` / `commit`。

## 提交前验证清单

1. 前端改动：`make check` 必过（= `npm run build`，含 tsc 类型检查）；改领域层/纯函数另跑 `make unit`
2. Rust 改动：`make lint` 必过；复杂度显著上升时 `make score` 复核
3. 插件（`src/plugin/`）改动：`npm run plugin:build` + `npm run test:plugin` 必过
4. 提交前可用 `make verify` 一次跑齐前端 + 插件 + Rust 门禁
5. 协议/工具/动作改动：启动应用后用 `node cmd/client/test.mjs` 与 `node cmd/client/test-streamable.mjs` 冒烟测试，并人工确认看板娘有响应
6. DSH 装配改动：用非 desktop profile（如复制 `web` 模板）跑 `dsh --profile <test> --dump-config` 验证层叠，再用 `dsh --profile <test> --json "<提示词>"` 做端到端工具调用
7. 不提交 `dist/`、`lib/`、`target/`、`node_modules/`、`models/*/`；不提交密钥/凭据
8. 生成 commit msg：加载并遵循 skill `commit`（Conventional Commits，中文正文）
9. 未经用户明确要求，不要执行 git commit / push

## AGENTS.md / Skill 维护

- 模块页 7 段式：职责 / 关键文件 / 核心模式（按需）/ 开发注意事项 / 依赖关系 / References（按需）/ See Also（首行「← 上级」）；完整写作指南（内容归属 / 反模式 / 自检）→ skill `agents-md`。
- 同步时机：关键文件、工具、事件契约、公开接口、依赖关系、目录结构变更 → 更新对应 AGENTS.md；规范（架构/注释/日志）变更 → 先改 `.agents/skills/` 对应 SKILL.md，再同步 AGENTS.md 引用与摘要。
