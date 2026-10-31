---
name: commit
description: 提交信息（commit message）规范——基于 Conventional Commits，`<type>(<scope>): <subject>` 格式、type/scope 取值、中文正文写法、body/footer 与破坏性变更标注、生成 commit msg 的勘察流程与正反例。凡是生成 commit msg、拟写提交信息、提交代码前制定提交内容时务必加载本 skill。触发词：commit msg、commit message、提交信息、提交规范、conventional commit、写提交、提交格式、type/scope、BREAKING CHANGE。
---

# 提交信息规范（硬性要求）

> 采用 **Conventional Commits**：首行 `type(scope): subject` 机器可读，正文（body）用**中文**解释「为什么」。
> 每次生成 commit msg **必须**按本规范执行，不得自由发挥格式；未获用户明确指令不得 `git add` / `git commit` / `git push`。

## 格式

```
<type>(<scope>): <subject>   ← 首行；subject 中文祈使句，≤ 50 字符，结尾不加句号
<空行>
<body>                       ← 可选；为什么这么改 + 要点（bullet）
<空行>
<footer>                     ← 可选；BREAKING CHANGE: 说明 / Refs #issue
```

- `scope` 可省略（省略时写作 `<type>: <subject>`）。
- 首行与 body 之间必须空一行；body 每行建议 ≤ 72 字符。

## type 取值

| type | 含义 | 示例 |
|------|------|------|
| `feat` | 新增功能 | `feat(frontend): 支持模型热切换失败自动回滚` |
| `fix` | 修复缺陷 | `fix(mcp): 修正查询超时后 oneshot 未释放` |
| `docs` | 仅文档 | `docs: 补充模型接入说明` |
| `style` | 格式（不影响逻辑） | `style(tauri): 统一 rustfmt 缩进` |
| `refactor` | 重构（不改行为） | `refactor(mcp): 拆分 handle_rpc 各 method 分支` |
| `perf` | 性能优化 | `perf(frontend): 减少 Live2D 每帧重复取样` |
| `test` | 测试 | `test(tauri): 补充 config 校验用例` |
| `build` | 构建/依赖 | `build: 升级 pixi.js 至 v6.5.10` |
| `ci` | CI 配置 | `ci: 增加 make lint 门禁` |
| `chore` | 杂项（配置/脚手架/工具链） | `chore: 初始化看板娘项目` |
| `revert` | 回滚提交 | `revert: 回滚模型热切换改动` |

## scope 取值

按仓库结构取，可省略。常用：`frontend` / `tauri` / `mcp` / `settings` / `shared` / `cmd` / `models` / `docs` / `deps` / `skills`。
跨多模块可用主要受影响者，或在 body 中说明，禁止臆造无关 scope。

## subject / body / footer 规则

- **subject**：中文祈使句，描述「做什么」；≤ 50 字符；结尾不加句号；专有名词（MCP / Live2D / JSON-RPC 等）保留英文。
- **body**：解释**为什么**（动机、取舍、影响），而非复述 diff；多个要点用 `- ` 列表；与首行空一行。
- **footer**：破坏性变更有两种写法——`type(scope)!:` 加 `!`，并在 footer 写 `BREAKING CHANGE: <影响与迁移说明>`；关联 issue 写 `Refs #12` / `Closes #12`。

## 生成流程（硬性）

1. 先勘察，再拟稿：`git status` + `git diff --cached`（已暂存）+ `git diff`（未暂存），必要时 `git log --oneline -10` 对齐仓库既有风格。
2. 只描述本次实际改动，不臆造未发生的变更；type/scope 必须与 diff 对应。
3. 若一次改动含多个不相干逻辑，提示用户是否拆分为多次提交，而非塞进一条含糊信息。
4. 未经用户明确要求，不执行 `git add` / `git commit` / `git push`；只产出信息文本或用 `git commit -m` 在用户确认后提交。
5. 提交前确认已过 `AGENTS.md` 的「提交前验证清单」（前端 `make check`、Rust `make lint`，或一次跑齐 `make verify`）。

## 正反例

```
# 反例：无 type、含糊、只复述改动
更新了代码

# 反例：首行过长、正文复述 diff
fix: 修改了 dispatcher.ts 里的 switch 分支并加了日志和注释还调整了类型定义

# 正例：类型明确、正文解释动机
fix(frontend): 查询型指令超时后清理 pending 状态

- 原先超时仅回传错误却残留 pending 映射，下一次同 id 指令会被误判为重复
- 统一在超时分支移除 pending 并按协议回传错误码
```

## 相关 skill

- 文档怎么写 → `agents-md`；代码放哪层 → `architecture`；提交前质量门禁 → `crap-analysis`。
