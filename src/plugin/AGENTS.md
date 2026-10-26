---
title: src/plugin/ — DSH 宿主插件半侧
created: 2026-10-26
updated: 2026-10-26
type: concept
tags: [typescript, dsh, cordis, plugin, mcp]
description: DSH（DeepSeek Harness）宿主插件的职责、文件边界、装配与失败语义；包含端口单一来源与 provider 永不缺席的约束。
sources: [.]
---

# src/plugin/ — DSH 宿主插件半侧

## 职责

把看板娘接入 DSH 的**宿主半侧**（Node 侧）：解析 MCP 端点 → 发布 `mascotStartup` 服务 → 探活 `/health` 并做一次**前端链路探活**（MCP `get_status`，用来区分「后端在监听」与「角色真的画出来了」），必要时以分离进程拉起看板娘 → 记录可落盘的插件日志。浏览器半侧不做（看板娘是独立桌面窗口，不嵌入 DSH 页面），MCP 客户端的装配由仓库根 `cordis.patch.yml` 声明。

插件**不打包、不复制 exe**：以 `link:` 安装后直接拉起仓库里的 `target/release` 产物，因此 `npm run plugin:install` 会先执行 `tauri build --no-bundle` 把应用构建出来（`--no-build` 可跳过）。

编译产物输出到仓库根 `lib/`（gitignore），入口 `lib/host.js`（package.json `main` / `exports["."]`）。

## 关键文件

| 文件 | 作用 | 边界 |
|------|------|------|
| `host.ts` | Cordis 插件入口：`name` / `inject` / `apply`；编排端点解析、`ctx.provide('mascotStartup')`、探活/拉起、生命周期清理 | 只做编排；不写协议、不定义工具、不直接读设置文件 |
| `config.ts` | 插件配置解析与校验（`mcpUrl` 可选覆盖、`autoLaunch`、超时、`launchCommand` 等）；未知字段报错 | 纯函数，无 IO，可单测 |
| `appSettings.ts` | 读取看板娘应用设置 `settings.json`（`mcpEnabled` / `mcpPort`），解析端点（显式配置 > 应用设置 > 默认 7432） | 只读；文件缺失/损坏一律回退默认，绝不抛 |
| `runtime.ts` | 仓库根探测、可执行文件探测、`fetch /health` 探活与轮询、**前端链路探活**（`probeFrontend`：MCP `get_status`）、分离进程启动/终止 | 副作用集中处；失败用返回值表达 |
| `logging.ts` | 双写 logger：`ctx.logger` + `<DSH_HOME>/kanbanniang/plugin.log` | 文件写失败静默降级，不影响插件 |
| `dsh.ts` | DSH Cordis 上下文的最小结构镜像（`logger` / `provide` / `effect`） | 不 import DSH 内部包；升级 DSH 时复核 |
| `config.test.ts` / `appSettings.test.ts` / `runtime.test.ts` | 配置解析、设置读取、前端探活应答形态的单测（`npm run test:plugin`） | 只测纯逻辑、只读解析与 HTTP 帧解析 |

## 核心模式

### 端点单一来源

```
看板娘设置页 → <app_config_dir>/settings.json { mcpEnabled, mcpPort }
        │
        ├─ src/plugin/appSettings.ts 读取 → resolveMcpEndpoint() → mcpUrl
        │        └─ ctx.provide('mascotStartup', { mcpUrl })
        │                 └─ cordis.patch.yml 的 MCP 客户端行：inject + !!js ctx.mascotStartup.mcpUrl
        └─ Rust config.rs 用同一端口启动 axum（/mcp）
```

改端口只需重启 DSH；`cordis.patch.yml` 不再维护第二份端口。

### 失败语义

- 配置非法：记录 error，**仍然 `provide` 默认端点**，跳过自动启动；DSH 正常启动，工具缺席。
- 应用未运行且 `autoLaunch=false`：warn 后返回。
- 找不到 exe：error 并提示 `make build` / `launchCommand`。
- 启动失败或等待 `/health` 超时：error；MCP 客户端行自带重连预算兜底。
- **`/health` 通过但前端无响应**：error 并给出排查方向。`/health` 只证明 axum 在监听——exe 若是 `cargo build` 直接编出来的（前端加载 `devUrl`）或 WebView 白屏，后端照样健康、探活照样过，用户看到的就是「拉起了却没有角色」。因此两条就绪路径（复用现有实例 / 冷启动成功后）都会再跑一次 `probeFrontend`（MCP `tools/call get_status`），把结论写进 `plugin.log`。
- 卸载（含 HMR）：默认保留看板娘进程，仅 `stopOnDispose=true` 时终止。

> 红线：MCP 客户端行 `inject: [mascotStartup]`。若宿主插件在**任何路径**漏掉 `provide`，该行会停在 PENDING，DSH 启动直接失败。`host.ts` 的 `resolveStartup` 因此先兜底再做事。

## 开发注意事项

- 不 import `@deepseek-ai/*`：插件通过 `file:` / `link:` 安装，无法保证解析到 DSH 私有模块；只用 Node 内置模块。
- `ctx.logger` 在桌面端不落盘，因此必须同时写 `plugin.log`；日志中文、前缀 `[kanbanniang]`。
- 插件的 `apply` 可能因 HMR 重跑：探活成功即复用现有实例，禁止重复拉起。
- 启动子进程必须 `detached + stdio:'ignore' + unref()`，避免 DSH 退出被拖住；`cwd` 用仓库根。
- `resolveStartup` 兜底默认配置里的超时字段无实际用途（`ok=false` 时直接返回），保持字段完整即可。
- 新增配置字段：`config.ts` 加校验 + `KNOWN_KEYS` + 单测；README 配置表同步。
- `settings.json` 路径依赖 Tauri identifier `com.example.kanbanmascot`（`src/tauri/tauri.conf.json`）；改 identifier 必须同步 `appSettings.ts`。
- 修改后跑：`npm run plugin:build`、`npm run test:plugin`；涉及装配再跑 `dsh --profile <test> --dump-config` 与无头端到端。
- `npm run plugin:install` 会连应用一起构建（约数十秒到两分钟），只改插件半侧时用 `--no-build`；当前应用正在运行时构建会因 exe 被占用而失败，先退出看板娘再装。

## 依赖关系

- 构建：`tsc -p tsconfig.plugin.json`（`src/plugin/**` → `lib/`；测试文件排除）。
- 测试：`vitest.plugin.config.ts`（独立 root，node 环境）。
- 运行时依赖 DSH 注入的 Cordis 上下文（`logger` / `provide` / `effect`）与 Node ≥ 20（`fetch`、`AbortSignal.timeout`）。
- 与 Rust 侧的契约：`settings.json` 字段（`mcpEnabled` / `mcpPort`）与 `/health` 响应 `{ok:true,...}`；MCP 协议由 `src/mcp/tools.json` 决定。

## See Also

- ← 上级：[[AGENTS.md]]
- [[src/tauri/AGENTS.md]]（`/health`、MCP 端点实现）
- 仓库根 `cordis.patch.yml`（两行装配）
