---
name: comments
description: 中文注释规范——文件头模块注释、导出成员文档注释、复杂逻辑行内注释的硬性要求、必须注释的位置清单与正反例。编写或修改任何 TS/Rust 代码、评审注释质量时使用。触发词：注释、comment、JSDoc、文件头、doc comment、注释太少、#[allow] 理由。
---

# 注释规范（硬性要求）

> 本仓库注释密度较高：中文、简短、直述结论。可参考 `src/tauri/src/state.rs`、`src/frontend/shared/domain/types.ts`、`src/frontend/shared/domain/profiles.ts`。

## 硬性要求

1. 所有新增/修改的代码逻辑必须配**中文注释**；术语（MCP / Live2D / JSON-RPC 等）可保留英文。
2. 每个文件头部必须有模块注释，说明职责与关键设计动机（TS 用 `/** */`，Rust 用 `//!`）。
3. 所有导出成员（函数、类型、接口字段、常量）必须有文档注释（TS 用 JSDoc，Rust 用 `///`）。
4. 复杂逻辑必须行内注释：状态机、回滚/降级路径、超时与并发、协议字段映射、魔法值。注释解释「为什么」而非复述代码，禁止无信息量的复述注释。
5. 修改代码时同步更新受影响的注释，禁止留下过期注释。
6. 保持与现有风格一致，不引入新的注释风格（如分割线、装饰性注释）。

## 必须行内注释的位置

| 位置 | 说明 |
|------|------|
| 协议字段映射 | JSON 键 ↔ TS/Rust 字段（如 `params` 取值默认值） |
| 魔法值 | 如前端滑行步进 16ms、查询超时 5s |
| 状态机 / 回滚 / 降级路径 | 「先建后销」提交点、降级分支触发条件 |
| 超时与并发 | oneshot 5s 超时清理、`swapping` 锁、滑行代次抢占（`superseded`） |
| 受控 `#[allow]` | 说明原因与范围（现有唯一例外：`src/tauri/src/mcp/tools.rs::manifest` 的 `clippy::expect_used`） |

## 正反例

```rust
// 复述代码、无信息量
// 拿锁
let sessions = self.sessions.lock();

// 解释「为什么」：锁中毒说明持锁线程已放弃写入，取回内部数据自愈，避免级联 panic
let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
```

```ts
// 复述代码
// 设置模型的参数
controller.setParam(key, value);

// 解释「为什么」：params 缺省时走档案默认值，避免后端未传参导致动作静默失效
controller.setParam(key, value ?? profile.defaults[key]);
```

## 相关 skill

- 代码放哪层 → `architecture`；日志怎么打 → `logging`；提交前质量门禁 → `crap-analysis`。
