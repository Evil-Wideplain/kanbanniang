---
name: architecture
description: 看板娘项目架构知识——DDD 分层（领域/应用/基础设施/表现）、依赖方向、设计模式（端口-适配器、组合根、先建后销回滚、事件桥）、MCP 事件链路与契约同步流程。在新增 MCP 动作或工具、跨层改动、判断代码该放哪一层、设计回滚/超时逻辑时务必先加载本 skill。触发词：分层、放哪层、DDD、依赖方向、新增动作、新增工具、契约、事件链路、设计模式、架构。
---

# 架构知识 — DDD 分层与设计模式

> 新增能力前必读。核心原则：**领域 → 应用 → 基础设施 → 表现** 单向落地，禁止反向依赖。

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

## 分层总览

| 层 | 前端位置（`src/frontend/`） | Rust 位置（`src/tauri/`） | 职责 | 禁止 |
|----|------|------|------|------|
| 领域层 Domain | `core/types.ts`（契约/值对象）、`core/profiles.ts`（模型档案）、`core/speech.ts`（领域规则） | —（渲染领域归前端所有） | 契约、类型、业务规则 | 依赖 DOM / Tauri / pixi / 渲染库 |
| 应用层 Application | `core/dispatcher.ts`（指令用例分发）、`core/model-switch.ts`（模型生命周期，含热切换与回滚） | — | 用例编排 | 直接操作 DOM 细节；绕过领域接口 |
| 基础设施层 Infrastructure | `core/live2d/`、`core/fallback.ts`、`ipc/events.ts` | `mcp/`、`state.rs` | 实现领域端口（`MascotController` 接口在领域层）；传输与状态 | 在适配器里写业务规则 |
| 表现层 Presentation | `ui/bubble.ts`（DOM 气泡）、`main.ts`（组合根） | `lib.rs`（组合根） | 渲染与装配 | 在组合根写业务逻辑（只做接线） |

依赖方向单向：表现 → 应用 → 领域；基础设施向领域契约收敛。避免循环依赖；跨层数据一律走类型化契约（`MascotCommand` / `MascotResult` / `ActionOutcome` 等），禁止裸 `any` / 无结构字符串传递。

Rust 后端对应「基础设施 + 接口层」：`lib.rs` 只做组装；`mcp/mod.rs` 只管传输与 JSON-RPC 协议；`mcp/tools.rs` 管工具路由；`state.rs` 管状态与事件回传端口。协议处理与业务语义不得混写。

## 设计模式

| 模式 | 落点 | 说明 |
|------|------|------|
| 端口-适配器（依赖倒置） | 接口 `MascotController`（领域层）← 实现 `core/live2d/`、`core/fallback.ts` | 业务用例只依赖接口，渲染实现可整体替换（Live2D ↔ 降级） |
| 组合根 | `main.ts`、`lib.rs` | 只做装配与接线，不写业务分支 |
| 用例编排 + 穷尽性检查 | `core/dispatcher.ts` | `switch` 穷尽 `MascotCommand`（`const _exhaustive: never`），漏写 case 编译失败；禁止 `default` 兜底 |
| 先建后销（失败天然回滚） | `core/model-switch.ts` | 模型热切换先在游离画布建好新控制器才提交销毁旧的；禁止先销毁再重建 |
| 事件桥（异步查询） | `state.rs` ↔ `ipc/events.ts` | 查询型工具经 `mascot:action` 下发、`mascot:result` 回传（oneshot，5s 超时；超时清理 `pending` 表防泄漏） |
| 锁中毒自愈 | `state.rs` | `PoisonError::into_inner` 恢复内部数据而非级联 panic；锁访问统一走访问器 |

## 契约同步（硬性）

1. 工具契约唯一来源 `src/mcp/tools.json`，新增工具的顺序：
   1. 清单中登记（name / description / inputSchema / action / query）
   2. `src/frontend/core/types.ts` 的 `MASCOT_ACTIONS` 补上动作名（运行时互校，不一致会告警）
   3. 前端 `dispatcher.ts` 补 case（穷尽性检查会强制编译失败，防止遗漏）
   4. 实现对应控制器能力（Live2D 与降级两个实现都要覆盖）
2. 事件契约成对维护：`types.ts` ↔ `state.rs`（`MascotCommand` / `MascotResult`），字段改动必须两侧同步；`#[serde(default)]` 等兼容标记不得随意移除。
3. 事件通道名固定：`mascot:action`（后端 → 前端）、`mascot:result`（前端 → 后端）；查询型工具由清单 `query:true` 驱动，超时 5s。

## 编码约定

- TS：`strict` 全开；禁止未使用变量/参数；优先 `unknown` + 收窄，禁止 `any`；异步统一 `Promise` 处理。
- Rust：edition 2021，MSRV 1.77；错误用 `anyhow::Result`；跨线程数据经访问器传递；放宽约定时用注释说明原因。
- 配置与常量集中定义（如 `MCP_PORT`、`DEFAULT_MODEL_ID`），禁止散落魔法值（必须使用时附中文注释）。
- 模型文件位于 `models/`（gitignore，不入库）；接入流程见 `models/README.md` 与 `profiles.ts` 头注释。

## 相关 skill

- 注释怎么写 → `comments`；日志怎么打 → `logging`；复杂度打分 → `crap-analysis`。
