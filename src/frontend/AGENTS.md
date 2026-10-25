---
title: src/frontend/ — 前端（TypeScript + Vite + Live2D）
created: 2026-10-17
updated: 2026-10-18
type: concept
tags: [typescript, vite, live2d, canvas, frontend]
description: 前端执行细则：功能分片目录结构、DDD 分层、MCP 动作落地顺序、模型热切换、常见坑。
sources: [.]
---

# src/frontend/ — 前端（TypeScript + Vite + Live2D）

## 职责

看板娘的渲染与交互前端：Live2D（pixi）控制器实现、MCP 指令分发、模型热切换与 DOM 气泡。运行在 Tauri WebView 中，代码须容忍非 Tauri 环境。

## 关键文件

按「功能分片（feature slice）+ 共享内核」组织：每个功能域自带分层子目录，跨功能的契约与桥归入 `shared/`。

| 功能域 / 层 | 路径 | 职责 |
|----|------|------|
| 组合根 | `app/` | `main.ts`（主窗口）、`settings.ts`（设置窗口）、`debug.ts`（调试面板）三个 WebView 入口，只接线不写业务分支；`main.ts` 应用不透明度到画布 |
| 共享·领域 Domain | `shared/domain/` | `types.ts` 契约、`profiles.ts` 模型档案、`settings.ts` 设置默认值与校验、`speech.ts` 说话时长、`normalize.ts` 名称归一化、`models.generated.json` 生成物 |
| 共享·基础设施 Infra | `shared/ipc/` | `events.ts` Tauri 事件传输、`log-forward.ts` 日志转发（官方插件 JS 桥）、`settings-client.ts` 设置命令 invoke 与 `mascot:settings` 订阅、`cursor.ts` 全局光标源（视线跟随）、`window.ts` 窗口平滑移动 `move_window` 封装 |
| 共享·表现 UI | `shared/ui/` | `window-controls.ts` 无边框窗口自绘标题栏（关闭=隐藏 / 最小化）接线，设置窗口与调试面板共用 |
| ① 看板娘 `mascot/` | `application/` | `dispatcher.ts` 指令用例分发、`model-switch.ts` 模型生命周期（热切换 + 回滚） |
| | `render/` | `MascotController` 的 Live2D 实现 `live2d/`（pixi） |
| | `ui/` | `bubble.ts` DOM 气泡 |
| ② 设置 `settings/` | `ui/` | `settings-page.ts` 设置页（纯 DOM） |
| ③ 调试 `debug/` | `panel.ts` `args.ts` `ipc.ts` `log-view.ts` `types.ts` | MCP 调试面板：`panel.ts` 状态与渲染（由 `app/debug.ts` 调 `mountDebugPanel()` 挂载）、`args.ts` 参数纯函数、`ipc.ts` `mcp_debug_call` 传输、`log-view.ts` 调用日志视图、`types.ts` 面板类型 |
| 样式 | `styles/` | `main.css` / `settings.css` / `debug.css`，各窗口入口 import |

> 三个 WebView 入口：主窗口 `index.html`（`app/main.ts`）、设置窗口 `settings.html`（`app/settings.ts`，托盘「设置…」唤出）与调试面板 `debug.html`（`app/debug.ts`，托盘「MCP 调试…」唤出，窗口仅开发构建由 Rust `debug.rs` 创建）。Vite 多入口见 `vite.config.ts`。

## 核心模式

- 分层与依赖方向：`shared/domain` 不依赖任何本地模块（仅 TS 标准库 + `mcp/tools.json`），被所有层依赖；`shared/ipc` 可依赖 `shared/domain`；`shared/ui` 为纯表现工具（可触碰 DOM），不依赖本地模块；功能域 `mascot` / `settings` / `debug` **之间禁止互相 import**；`mascot/` 内保持 `ui → application → render → shared/domain`；`app/*` 组合根可依赖全部。
- 路径别名：跨模块 import 一律用 `@/*`（→ `src/frontend/*`），与同目录 `./x` 相对引用并用；别名在 `tsconfig.json`（`paths`）与 `vite.config.ts`（`resolve.alias`）成对维护，`vitest.config.ts` 复用后者。禁止跨模块 `../../` 深相路径。例外：`shared/domain/types.ts` 引仓库外 `../../../mcp/tools.json`（见下「接受的边界决策」）。
- DOM 访问白名单：`mascot/ui/`、`settings/ui/`、`shared/ui/`、`debug/`、`app/*`、`mascot/render/`（`live2d/`），以及 `mascot/application/model-switch.ts` 的画布切换逻辑；`shared/domain/`、`shared/ipc/` 与 `mascot/application/dispatcher.ts` 内禁止直接操作 `document.*` / `window.*`。
- 新增 MCP 动作的固定顺序：`src/mcp/tools.json` → `shared/domain/types.ts` 的 `MASCOT_ACTIONS` → `mascot/application/dispatcher.ts` case → 控制器实现 `mascot/render/live2d/` → 冒烟验证。
- `dispatcher.ts` 的 `switch` 有穷尽性检查（`const _exhaustive: never`）：新增动作漏写 case 会编译失败；禁止用 `default` 兜底绕过。
- 模型切换遵循「先建后销、失败天然回滚」（先在游离画布建好新控制器才提交，见 `mascot/application/model-switch.ts`），禁止改成先销毁旧实例。
- 设置契约 `MascotSettings`（`shared/domain/types.ts`）与 Rust `config.rs::Settings` 成对镜像（camelCase）：启用 MCP / 端口 / 模型 / 置顶 / 视线跟随 / 不透明度 / 开机自启。MCP 启停与端口、窗口置顶、开机自启由后端作用于运行态（`get_runtime_status` 回读真实端口/运行态）；不透明度经事件 `mascot:settings` 由 `app/main.ts` 写到 CSS 变量 `--mascot-opacity`（`#stage` 引用），模型热切换重建画布后仍沿用；视线跟随同经 `mascot:settings` 由 `mascot/application/model-switch.ts` 应用到控制器（仅 Live2D 生效：`shared/ipc/cursor.ts` 读全局光标，`mascot/render/live2d/` 调 `focus` 扩展为**全屏**跟随；窗口内跟随由库 `autoInteract` 常驻、不受开关影响）。

## 开发注意事项

- 技术栈：TypeScript（`strict` 全开）+ Vite，无 UI 框架；不引入新框架/状态库（除非用户明确要求）。渲染：pixi.js v6 + pixi-live2d-display（动态 import）。
- Cubism Core 6 移除了 `drawables.renderOrders`（改为 `model.getRenderOrders()`），而 `pixi-live2d-display@0.4.0` 仍读旧字段：`mascot/render/live2d/index.ts::patchCubismCoreCompat` 在 Core 加载后补只读兼容 getter；升级/替换渲染库时需一并复核，否则模型会“加载成功但不显示”。
- 运行环境是 Tauri WebView；浏览器直开 `npm run dev` 仅用于界面调试（MCP 不可用），代码必须容忍非 Tauri 环境（见 `shared/ipc/events.ts` 的降级分支）。
- 调试面板（`debug/panel.ts`，入口 `app/debug.ts`）不直接连 MCP SSE（WebView origin `tauri://localhost` 与 `http://127.0.0.1:<port>` 跨源、axum 无 CORS）：经 Tauri 命令 `mcp_debug_call`（Rust `debug.rs` → `mcp::debug_call`）复用工具真链路；候选值在页面加载时经 `list_motions` / `list_expressions` / `list_models` 一次拉回并填充 datalist。
- 类型门禁：`make check`（= `npm run build`，`tsc --noEmit` + vite build）。tsconfig 已开 `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`。
- 单元测试：`make unit`（= `npm run test`，vitest）覆盖领域层与纯函数（`shared/domain/*.test.ts`、`debug/args.test.ts`）以及应用层分发（`mascot/application/dispatcher.test.ts`，以替身注入 `MascotController` / `CommandCtx`）；DOM / Tauri / pixi 依赖的部分不在此测（以 `make test` 冒烟 + 人工确认为准）。`vitest.config.ts` 复用 `vite.config.ts` 的 root 与 `@` 别名（单一来源）。
- `set_model` 的结果（含失败）必须包成 `SetModelOutcome` 信封塞进 `result` 字段用 `okValue` 返回：Rust 侧只转发 `result`，走 `fail()` 会丢失结构化错误。
- Vite 的 `root` 是 `src/frontend/`，静态资源根是 `models/`（`/Haru/...` 即 `models/Haru/...`，见 `vite.config.ts`）；模型路径只能来自档案配置，禁止写死。开发端口 5173 与 `tauri.conf.json` 的 `devUrl` 绑定（`strictPort`），不要改动。
- 查询型动作必须在 5s 内回传结果；任何抛错都要转成 `MascotResult{ok:false}`（`shared/ipc/events.ts` 已兜底，不要绕过该路径）。
- 禁止 `any`（`as any` 零容忍）；现存 `mascot/render/live2d/` 与 `mascot/application/model-switch.ts` 的 `window as any` 属第三方运行时/调试钩子例外，新增代码不得扩散该写法。
- 资源生命周期：创建者负责 `destroy()`（幂等）；动画帧、事件监听、PIXI 实例必须在控制器 `destroy()` 中清理。
- 日志统一 `console.info/warn/error` 且消息以 `[mascot]` 开头（经 `shared/ipc/log-forward.ts` 走官方插件 JS 桥 `@tauri-apps/plugin-log` 转发后端落盘）；无前缀的 `console.*` 不会落盘。注意 `installLogForwarding()` 之前的模块级日志（如 `shared/domain/types.ts` 的一致性警告）不在拦截范围。
- 注释与日志其余要求遵全局规范（见 References）。

## 接受的边界决策

架构审查后确认保留、不再改动的取舍（避免「看似规整却无收益」的重构）：

- `shared/ipc/{events,window,cursor}.ts` 当前各仅一个消费者，仍保留为基础设施原语：它们是「前端 ↔ Tauri」的传输边界，按通道而非按调用方组织，未来复用点自然存在（如 `cursor.ts` 供 Live2D 视线跟随、`window.ts` 供窗口移动），下沉进单一功能域反而破坏 shared 语义。
- `mascot/application/model-switch.ts` 动态 import 具体实现 `@/mascot/render/live2d`：模型工厂的职责就是「选具体控制器并构造」，端口抽象（`MascotController`）已在分发侧遵守；为单一工厂再加一层实现注册表属无收益抽象。
- `shared/domain/types.ts` import 仓库外 `../../../mcp/tools.json`：`tools.json` 是工具契约的**跨语言单一来源**（Rust 同源加载），领域层依赖它是刻意设计，故为该文件豁免「禁止跨模块深相路径」的规则。

## 依赖关系

- 领域层（`shared/domain/`）仅依赖 TS 标准库与 `src/mcp/tools.json`；禁止 DOM / Tauri / pixi。
- 与 Rust 后端仅通过 Tauri 事件契约耦合（`shared/domain/types.ts` ↔ `state.rs`）。
- 外部依赖：pixi.js v6 + pixi-live2d-display（动态加载）。

## References

| 文档 | 主题 |
|------|------|
| [.agents/skills/architecture/SKILL.md](../../.agents/skills/architecture/SKILL.md) | DDD 分层、端口-适配器、穷尽性检查、回滚策略 |
| [.agents/skills/comments/SKILL.md](../../.agents/skills/comments/SKILL.md) | 注释规范：中文注释、JSDoc、必须注释的位置 |
| [.agents/skills/logging/SKILL.md](../../.agents/skills/logging/SKILL.md) | 日志规范：`[mascot]` 前缀、级别语义 |

## See Also

- ← 上级：[[AGENTS.md]]
- [[src/tauri/AGENTS.md]]（事件契约成对维护）
