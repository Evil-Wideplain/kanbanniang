---
title: src/frontend/ — 前端（TypeScript + Vite + Live2D）
created: 2026-10-17
updated: 2026-10-17
type: concept
tags: [typescript, vite, live2d, canvas, frontend]
description: 前端执行细则：DDD 分层文件映射、MCP 动作落地顺序、模型热切换、常见坑。
sources: [.]
---

# src/frontend/ — 前端（TypeScript + Vite + Live2D）

## 职责

看板娘的渲染与交互前端：Live2D（pixi）与纯 Canvas 降级两条控制器实现、MCP 指令分发、模型热切换与 DOM 气泡。运行在 Tauri WebView 中，代码须容忍非 Tauri 环境。

## 关键文件

| 层 | 文件 | 职责 |
|----|------|------|
| 领域 Domain | `core/types.ts`、`core/profiles.ts`、`core/speech.ts`、`core/settings.ts` | 契约、模型档案、领域规则、设置默认值与校验（端口/不透明度） |
| 应用 Application | `core/dispatcher.ts`、`core/model-switch.ts` | 指令用例分发、模型生命周期（热切换 + 回滚） |
| 基础设施 Infrastructure | `core/live2d/`、`core/fallback.ts`、`ipc/events.ts`、`ipc/log-forward.ts`、`ipc/settings.ts`、`ipc/cursor.ts` | 实现领域接口 `MascotController`、Tauri 事件传输、日志转发（官方插件 JS 桥）落盘、设置命令 invoke 与 `mascot:settings` 订阅、全局光标源（视线跟随） |
| 表现 Presentation | `ui/bubble.ts`、`ui/settings-page.ts`、`main.ts`、`settings.ts` | DOM 气泡、设置页、两个窗口的组合根（只接线，不写业务分支）；`main.ts` 应用不透明度到画布 |

> 两个 WebView 入口：主窗口 `index.html`（`main.ts`）与设置窗口 `settings.html`（`settings.ts`，由 Tauri 托盘右键「设置…」唤出）。Vite 多入口见 `vite.config.ts`。

## 核心模式

- 依赖方向单向：表现 → 应用 → 领域；基础设施向领域接口 `MascotController` 收敛，禁止反向 import。
- DOM 访问白名单：`ui/`、根入口 `main.ts` / `settings.ts`、`core/fallback.ts`、`core/live2d/`，以及 `core/model-switch.ts` 的画布切换逻辑；`core/` 其余模块（`types.ts`、`profiles.ts`、`speech.ts`、`settings.ts`、`dispatcher.ts`）与 `ipc/` 内禁止直接操作 `document.*` / `window.*`。
- 新增 MCP 动作的固定顺序：`src/mcp/tools.json` → `types.ts` 的 `MASCOT_ACTIONS` → `dispatcher.ts` case → 两个控制器实现（`live2d/` 与 `fallback.ts` 都要覆盖）→ 冒烟验证。
- `dispatcher.ts` 的 `switch` 有穷尽性检查（`const _exhaustive: never`）：新增动作漏写 case 会编译失败；禁止用 `default` 兜底绕过。
- 模型切换遵循「先建后销、失败天然回滚」（先在游离画布建好新控制器才提交，见 `model-switch.ts`），禁止改成先销毁旧实例。
- 设置契约 `MascotSettings`（`types.ts`）与 Rust `config.rs::Settings` 成对镜像（camelCase）：启用 MCP / 端口 / 模型 / 置顶 / 视线跟随 / 不透明度 / 开机自启。MCP 启停与端口、窗口置顶、开机自启由后端作用于运行态（`get_runtime_status` 回读真实端口/运行态）；不透明度经事件 `mascot:settings` 由 `main.ts` 写到 CSS 变量 `--mascot-opacity`（`#stage` 引用），模型热切换重建画布后仍沿用；视线跟随同经 `mascot:settings` 由 `model-switch.ts` 应用到控制器（仅 Live2D 生效：`ipc/cursor.ts` 读全局光标，`live2d/` 调 `focus` 扩展为**全屏**跟随；窗口内跟随由库 `autoInteract` 常驻、不受开关影响；降级为空实现）。

## 开发注意事项

- 技术栈：TypeScript（`strict` 全开）+ Vite，无 UI 框架；不引入新框架/状态库（除非用户明确要求）。渲染：pixi.js v6 + pixi-live2d-display（仅 Live2D 档案时动态 import）；降级模式为纯 Canvas 2D，零第三方依赖。
- 运行环境是 Tauri WebView；浏览器直开 `npm run dev` 仅用于界面调试（MCP 不可用），代码必须容忍非 Tauri 环境（见 `ipc/events.ts` 的降级分支）。
- 类型门禁：`make check`（= `npm run build`，`tsc --noEmit` + vite build）。tsconfig 已开 `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch`。
- `set_model` 的结果（含失败）必须包成 `SetModelOutcome` 信封塞进 `result` 字段用 `okValue` 返回：Rust 侧只转发 `result`，走 `fail()` 会丢失结构化错误。
- Vite 的 `root` 是 `src/frontend/`，静态资源根是 `models/`（`/Haru/...` 即 `models/Haru/...`，见 `vite.config.ts`）；模型路径只能来自档案配置，禁止写死。开发端口 5173 与 `tauri.conf.json` 的 `devUrl` 绑定（`strictPort`），不要改动。
- 查询型动作必须在 5s 内回传结果；任何抛错都要转成 `MascotResult{ok:false}`（`ipc/events.ts` 已兜底，不要绕过该路径）。
- 禁止 `any`（`as any` 零容忍）；现存 `live2d/` 与 `model-switch.ts` 的 `window as any` 属第三方运行时/调试钩子例外，新增代码不得扩散该写法。
- 资源生命周期：创建者负责 `destroy()`（幂等）；动画帧、事件监听、PIXI 实例必须在控制器 `destroy()` 中清理。
- 日志统一 `console.info/warn/error` 且消息以 `[mascot]` 开头（经 `ipc/log-forward.ts` 走官方插件 JS 桥 `@tauri-apps/plugin-log` 转发后端落盘）；无前缀的 `console.*` 不会落盘。注意 `installLogForwarding()` 之前的模块级日志（如 `types.ts` 的一致性警告）不在拦截范围。
- 注释与日志其余要求遵全局规范（见 References）。

## 依赖关系

- 领域层仅依赖 TS 标准库与 `src/mcp/tools.json`；禁止 DOM / Tauri / pixi。
- 与 Rust 后端仅通过 Tauri 事件契约耦合（`types.ts` ↔ `state.rs`）。
- 外部依赖：pixi.js v6 + pixi-live2d-display（仅 Live2D 路径加载）；降级模式零第三方依赖。

## References

| 文档 | 主题 |
|------|------|
| [.agents/skills/architecture/SKILL.md](../../.agents/skills/architecture/SKILL.md) | DDD 分层、端口-适配器、穷尽性检查、回滚策略 |
| [.agents/skills/comments/SKILL.md](../../.agents/skills/comments/SKILL.md) | 注释规范：中文注释、JSDoc、必须注释的位置 |
| [.agents/skills/logging/SKILL.md](../../.agents/skills/logging/SKILL.md) | 日志规范：`[mascot]` 前缀、级别语义 |

## See Also

- ← 上级：[[AGENTS.md]]
- [[src/tauri/AGENTS.md]]（事件契约成对维护）
