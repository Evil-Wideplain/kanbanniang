---
title: src/tauri/ — Rust 后端（Tauri 2 + axum MCP 双传输服务）
created: 2026-10-17
updated: 2026-10-29
type: concept
tags: [rust, tauri, axum, mcp, sse, streamable-http]
description: Rust 后端执行细则：模块职责与边界、MCP 传输（Streamable HTTP 主路径 + 旧版 SSE 兼容）与 /health、协议版本协商、错误处理、质量门禁（clippy/fmt/cargo-crap）。
sources: [.]
---

# src/tauri/ — Rust 后端（Tauri 2 + axum MCP 双传输服务）

## 职责

桌面应用后端与 MCP 服务（**Streamable HTTP 主路径 + 旧版 SSE 兼容通道**）：接收 Agent 的 JSON-RPC 工具调用，经 Tauri 事件转发给前端看板娘，并等待查询型工具的结果回传（5s 超时）。额外提供 `/health` 供 DSH 插件探活；另把用户拖入的模型包解析、落盘并经只读协议提供资源。包根即本目录，所有 cargo 命令在此执行（workdir: `src/tauri`）。

## 关键文件

| 路径 | 作用 | 边界 |
|------|------|------|
| `src/lib.rs` | 组合根：装配共享状态、注册结果监听器、读取设置、拉起 MCP 服务、注册设置命令、注册 autostart 插件、应用运行态偏好（`commands::apply_startup`） | 只做接线；启动失败记录日志并以非零码退出 |
| `src/mcp/mod.rs` | 模块根：子模块声明与 re-export、共享常量（`DEFAULT_MCP_PORT` / `QUERY_TIMEOUT_SECS`）、`AppState` 别名 | 只做收口；协议文档头在此 |
| `src/mcp/server.rs` | 服务生命周期：启动 / 停止 / 按端口热重启（`ServerHandle` / `ServiceManager`，先建后销）+ 路由装配（`/mcp` · `/mcp/sse` · `/mcp/messages` · `/health`） | 只做启停编排与路由装配；不写工具语义 |
| `src/mcp/streamable.rs` | Streamable HTTP 传输（**主路径**，无状态）：`POST /mcp` 同步回 JSON/202、initialize 下发 `Mcp-Session-Id`、`GET /mcp` → 405、`DELETE` 幂等、`OPTIONS` CORS；`/health` 探活 | 只做传输适配；协议分发交 `rpc` |
| `src/mcp/sse.rs` | **旧版 SSE 传输（已废弃，仅兼容老客户端）**：握手 / 会话治理（`sse_handler`）+ POST 入口（`post_handler` / `parse_request` / `SessionGuard`）；新接入一律用 `/mcp` | 只做传输与会话清理；协议分发交 `rpc` |
| `src/mcp/rpc.rs` | JSON-RPC 协议：方法路由（initialize / ping / tools/list / tools/call）与响应封套成型（错误码/字段） | 不写工具语义与传输细节 |
| `src/mcp/tools.rs` | 工具清单加载（`src/mcp/tools.json` 编译期嵌入）与 `tools/call` 路由（核心 `route`；调试面板复用 `call_tool` 完整协议封套） | 只投影协议字段；`action`/`query` 内部字段不得混入 `tools/list` 响应 |
| `src/mcp/debug.rs` | 应用内调试面板的 MCP 入口：`debug_call` 自造 JSON-RPC id 复用 `tools::call_tool` 完整协议封套，返回整帧响应 | 只做调试接线；复用真链路但绕过传输层 |
| `src/state.rs` | 共享状态与事件端口：`mascot:action` 发射、`mascot:result` 等待（5s oneshot） | 跨线程表结构一律经访问器读写；类型与前端 `types.ts` 成对镜像 |
| `src/config.rs` | 设置持久化：`settings.json` 读写（缺失/损坏回退默认值）+ 端口/不透明度校验 + 内存副本 `SettingsStore` | 只做持久化；字段与前端 `shared/domain/types.ts` 的 `MascotSettings` 成对镜像；DSH 插件从该文件读取 `mcpPort` |
| `src/commands.rs` | 设置命令（接口层）：`get_settings` / `get_runtime_status`（MCP 实际端口/运行态）/ `save_settings`（MCP 开关与端口变更启停服务、模型变更热切换、窗口置顶/开机自启作用于运行态、不透明度与视线跟随广播 `mascot:settings`）；`apply_startup` 启动时应用运行态偏好；`move_window` 主窗口平滑滑到工作区归一化坐标（600ms smoothstep，`WindowGlideGuard` 代次守卫防并发抢占，供 MCP `move` 工具经前端分发调入）；导入模型命令 `list_imported_models` / `import_models`（阻塞 IO 走 `spawn_blocking`）/ `remember_model`（只改 `modelId` 落盘，避免整份设置并发覆盖）;`set_click_through` 整窗鼠标穿透开关（前端只在命中结果翻转时调用，`set_ignore_cursor_events` 的薄封装，不影响视觉透明度）；`fit_windows_to_work_area` 启动期低分屏适配（按当前显示器 `work_area()` 只收缩不放大，主窗口 640×800 / 设置窗口 440×760 在 1366×768 上放不下，不收缩会裁掉角色脚部与设置页按钮、并让 `move_window` 纵向范围退化为 0） | 只做用例编排；持久化交 `config.rs`、启停交 `mcp::ServiceManager`、窗口交 Tauri 窗口 API、自启交 autostart 插件、模型解析/落盘交 `model_store.rs` |
| `src/model_store.rs` | 导入模型仓库（基础设施层）：扫描/解析 `*.model3.json`（`FileReferences` 的 moc/贴图/动作组/表情）、校验引用路径合法与必需文件存在、zip 解压（防解压炸弹与路径穿越，按实际字节计数）、临时目录暂存 → 旧目录挪 `.trash` → 新目录上位（失败回滚）落盘到 `<app_data_dir>/models/imported-*/`、仅同名模型覆盖（撞 slug 的不同名让位 `-2`）、进程级串行导入 + 残留临时目录清理、`list()` 回读（容错单条目，meta 记录主配置文件名）、只读协议 `mascot-model://<id>/<相对路径>` 的请求处理（含 CORS 头与目录越界二次校验） | 只做解析/落盘/只读服务；不碰设置与窗口，命令编排在 `commands.rs` |
| `src/debug.rs` | 应用内 MCP 调试面板：命令 `mcp_debug_call`（始终注册）复用 `mcp::debug_call` 工具路由；`create_window` 仅在 `debug_assertions` 下创建 `debug.html` 窗口 | 只做调试接线；窗口创建仅开发构建，release 无该窗口故命令不可触达 |
| `src/log_setup.rs` | 日志装配：`tauri-plugin-log` 配置（级别/滚动/targets/落盘位置/行格式）与注册入口 `plugin()`；`file_dir()` 暴露实际落盘目录给启动日志 | 只做装配；落盘位置优先 exe 同目录、不可写回退 LogDir；禁止绕过 `log` 门面写日志 |
| `src/tray.rs` | 系统托盘装配：托盘图标（按平台选素材）+ 右键菜单（显隐、设置、[开发构建] MCP 调试、退出）+ 左键切换显隐；`init()` 供组合根调用 | 只做托盘与窗口显隐接线；常驻语义（关窗转隐藏、macOS Dock 隐藏）在 `lib.rs` |
| `Cargo.toml` | 依赖 + `[lints]` 质量门禁（唯一来源） | 调整 lint 前先跑门禁确认零告警 |
| `rustfmt.toml` | 格式化配置 | 仅使用稳定选项 |

依赖方向：`tools → mcp → state`，禁止反向；跨模块只用契约类型（`MascotCommand` / `FrontendResult`）。

## 核心流程

### MCP 请求链路（双传输共用同一套协议与工具）

```
POST /mcp（Streamable HTTP，主路径，DSH 等新客户端）──┐
GET /mcp/sse + POST /mcp/messages（旧版 SSE，兼容）───┴─▶ rpc.rs（JSON-RPC 分发）
                                                            ├─ initialize / ping / tools/list 就地应答
                                                            └─ tools/call → tools.rs 路由 → state.rs::dispatch
GET /health ──▶ {"ok":true,"service":"kanbanniang","transport":[...],...}（插件探活）
```

`initialize` 的 `protocolVersion` **按客户端请求回显**：取 `params.protocolVersion`，命中 `SUPPORTED_PROTOCOL_VERSIONS`（`2024-11-05` / `2025-03-26` / `2025-06-18`）则原样返回，否则回退 `FALLBACK_PROTOCOL_VERSION`（当前 `2025-06-18`）。不要改回硬编码——两条传输分属不同规范版本，写死任一版本都会对另一条自相矛盾。其余：`capabilities.tools.listChanged: true`、`serverInfo`（name + `env!("CARGO_PKG_VERSION")`）。Streamable HTTP 为无状态实现：会话头只在 initialize 下发、不校验归属；`GET /mcp` 按协议回 405（客户端视为不支持服务端推送）。

### 常驻托盘与窗口行为

窗口尺寸：`tauri.conf.json` 按设计尺寸创建（主窗口 640×800、设置窗口 440×760，`resizable: false` 且不再设 `minWidth/minHeight`——设了会挡住程序化收缩），`lib.rs` 的 setup 在 `apply_startup` 之后调用 `commands::fit_windows_to_work_area` 按工作区收缩并重新居中；前端布局按视口摆放，收缩只减少留白，角色像素尺寸与气泡位置自动跟随。

应用常驻系统托盘：`tray.rs::init()` 装配托盘图标与右键菜单（显示/隐藏、退出），左键切换显隐；`lib.rs` 拦截 `CloseRequested` 转为隐藏，故关窗不结束进程，唯一退出入口是托盘菜单。托盘依赖 `tauri` 的 `tray-icon` feature。

平台差异（代码已按 `#[cfg(target_os)]` 分支，Windows 为主要验证目标）：

| 平台 | 托盘位置 | 图标来源 | 不占任务栏/程序坞 |
|------|----------|----------|-------------------|
| Windows | 通知区域（右下） | `default_window_icon()`（`bundle.icon`，彩色） | `skipTaskbar: true` |
| macOS | 顶部菜单栏 | `icons/tray.png` 单色模板图（`image-png` 解码，该 feature 按目标平台收窄到 macOS + `icon_as_template`，随深浅色反色） | `skipTaskbar` 无效；`lib.rs` 用 `ActivationPolicy::Accessory` 隐藏 Dock 图标 |
| Linux | AppIndicator 托盘 | `default_window_icon()`（`bundle.icon`，彩色） | `skipTaskbar: true`（WM 提示）；需系统 `libayatana-appindicator`，GNOME 需 AppIndicator 扩展 |

设置窗口 `settings`（`settings.html`）随应用启动创建但初始隐藏，托盘右键「设置…」显示并聚焦；全局 `CloseRequested` 拦截对所有窗口生效，故关设置窗口也只是隐藏、可复用。设置窗口**无系统标题栏**（`decorations:false` + `transparent:true`，圆角透出桌面），标题栏由前端自绘（`data-tauri-drag-region` 拖动 + 自绘最小化/关闭按钮，关闭即 `hide()`）；对应窗口权限在 `capabilities/default.json`（`allow-start-dragging` / `allow-hide` / `allow-minimize`）。

调试面板 `debug`（`debug.html`）**仅开发构建**：窗口在 `#[cfg(debug_assertions)]` 下由 `debug.rs::create_window` 创建（初始隐藏，托盘「MCP 调试…」唤出，与设置窗口同为常驻复用；release 不创建该窗口，托盘菜单项亦不出现）。命令 `mcp_debug_call` 始终注册，调试页面点击经它调用 `mcp::debug_call`（自造 JSON-RPC id 复用 `tools::call_tool`，返回整帧响应、面板原样展示），因此覆盖「工具路由 → `state.dispatch` → 前端分发 → 结果回传」链路，但**不经 SSE / JSON-RPC 帧**（传输层由 `cmd/client/test.mjs` 冒烟测试覆盖）。不在 WebView 内直连 SSE 的原因：页面 origin 为 `tauri://localhost`，与 `http://127.0.0.1:<port>` 跨源且 MCP 服务未开 CORS，会被拦截。`debug` 标签已列入 `capabilities/default.json`（调试页亦使用 `log:default` 转发日志）。

### 设置链路（启用 MCP / 端口 / 模型 / 窗口置顶 / 视线跟随 / 不透明度 / 开机自启）

设置存于 `<app_config_dir>/settings.json`（`config.rs`，缺失/损坏回退默认值）。前端经命令读写：

- `get_settings`：主窗口启动时读取以决定初始模型、回显窗口/偏好设置。
- `get_runtime_status`：读取 MCP 服务运行时状态（实际端口 / 是否运行），供设置页显示真实地址与状态。
- `save_settings`：接收完整 `Settings` 载荷（单参数，避免参数过多）。
  - MCP 开关 / 端口 → 先落盘，再 reconcile 运行态：启用走 `ServiceManager::ensure_started`（已在该端口则空操作，否则「先建后销」重启），关闭走 `ServiceManager::stop`；仅有「开关变化 / 端口变化」失败时回滚配置（保持磁盘/内存/运行态一致）；
  - 模型变更 → 经既有 `mascot:action` 契约下发 `set_model` 到主窗口热切换；
  - 窗口置顶 → 主窗口 `set_always_on_top`（幂等，失败仅告警）；
  - 不透明度 → 广播事件 `mascot:settings`，由主窗口前端写到画布（`--mascot-opacity`，不弹窗级 API）；
  - 视线跟随 → 随完整 `Settings` 载荷广播 `mascot:settings`，由主窗口前端开关**全屏**光标跟随（窗口内跟随始终生效；仅 Live2D 模式；后端不参与）；
  - 开机自启 → autostart 插件注册/移除系统登录项（仅变化时改动）。

关键约束：MCP 可独立开关（`mcp_enabled` 缺省 true，后向兼容旧配置）；关闭时不监听端口，看板娘仍独立运行。监听端口不再是编译期常量（`mcp::DEFAULT_MCP_PORT` 仅作默认值），改用配置端口启动；端口切换必须先建后销，避免旧服务释放端口前的占用窗口。启动时 `commands::apply_startup` 用设置对齐「主窗口置顶 + 开机自启」，不透明度与视线跟随由主窗口前端自行读取应用。Tauri v2 / WebView2 无窗口级不透明度 API，故不透明度落在前端画布上（透明窗口里等价于看板娘半透明）。

### 导入模型链路（拖入 .zip / 模型文件夹）

```
前端拖放（Tauri 原生 drag-drop，拿到本机绝对路径）
  → invoke import_models{paths} → model_store::import
      ├─ 文件夹：递归找全部 *.model3.json（深度上限 6，跳过 . 开头/__MACOSX）
      ├─ .zip：解压到 <app_data>/models/.tmp-<uuid>（拒绝越界路径，限制条目数/解压总量；按实际写出字节计数防「声明大小撒谎」）
      ├─ 解析 FileReferences（Moc / Textures / Motions / Expressions），moc 与贴图必须存在，其余引用路径必须合法（缺失仅告警）
      └─ 逐模型：复制到 .tmp-<uuid> → 写 mascot-import.json（含主配置文件名）→ 旧目录挪成 .trash-<uuid> → 新目录改名上位 → 删 .trash
  → 返回 {models, errors}（单路径失败不影响其它路径）
  → 前端 registerImportedModels 注册运行时档案 → set_model 热切换 → remember_model 落盘选择
```

- id 规则：`imported-<slug>`（slug 只保留 ASCII 字母数字与 `-_.`）。**只有同名模型**重复导入才整体覆盖；slug 撞车的不同名模型（如两个中文名都折成 `model`）会分配 `-2` 让位，绝不互相删除。导入在进程内用 `IMPORT_LOCK` 串行，并在拿锁后清理残留 `.tmp-*` / `.trash-*`。
- 资源访问：主窗口用 `http://mascot-model.localhost/<id>/<相对路径>`（macOS/Linux 为 `mascot-model://localhost/...`）由 `register_uri_scheme_protocol` 提供；响应必须带 `Access-Control-Allow-Origin: *`（页面与协议源不同源，Live2D 的 XHR/贴图都走 CORS），JSON 配置必须回 `application/json`（模型加载器按内容解析）。
- 文件名安全：协议侧按 `id` 白名单 + 相对路径分段校验 + `canonicalize` 前缀二次校验，任何一步不通过都回 404，不泄露路径。

### 质量门禁与工具链（AI 代码必跑）

门禁（已配置，提交前必过；快捷入口：仓库根 `make lint`）：

| 命令 | 作用 |
|------|------|
| `cargo clippy --all-targets -- -D warnings` | 静态检查门禁：全部警告升级为错误（含下方 lint 清单） |
| `cargo fmt --check` | 格式校验（`cargo fmt` 自动修复） |
| `cargo check --all-targets` | 编译/类型快速检查 |

lint 配置唯一来源：`Cargo.toml` 的 `[lints]` 表与 `rustfmt.toml`。启用项与针对的 AI 高频问题：

| lint | 级别（门禁下均为错误） | 防什么 |
|------|------------------------|--------|
| `unsafe_code`（rust） | forbid | 无审查的 unsafe |
| `unused_must_use`（rust） | deny | 静默丢弃 Result 等必须处理的返回值 |
| `clippy::all` | warn（基线组） | 正确性 / 可疑代码 / 性能 |
| `clippy::dbg_macro` | deny | `dbg!` 调试残留 |
| `clippy::todo` / `clippy::unimplemented` | warn | 占位实现残留 |
| `clippy::unwrap_used` / `clippy::expect_used` / `clippy::panic` | warn | 运行期 panic 风险 |
| `clippy::indexing_slicing` / `clippy::string_slice` | warn | 切片越界 / UTF-8 边界 panic |
| `clippy::print_stdout` | warn | 不可见的 stdout 日志 |

复杂度打分（快捷入口：`make score`，基于 cargo-crap）：

- 指标：`CRAP = CC² × (1 - cov)³ + CC`（CC 为圈复杂度，cov 为覆盖率），挑出「复杂且缺测试」的函数；本项目 Rust 测试（`config` / `mcp` 单测，见 `cargo test --lib`）尚未接入覆盖率工具，无覆盖率数据按 0% 保守计（结果偏严）。
- 基线（2026-10-18，加入应用内调试面板后）：80 个函数，0 个超阈值 30；最高档 CRAP 30（CC 5）：`save_settings`、`reconcile_mcp`、`apply_autostart`、`config::save`、`read_settings`、`rpc_result`；第二档 CRAP 20（CC 4）：`switch_model_if_changed`、`respond_sync`、`post_handler`、`AppStateInner::await_result`、`on_menu_event`、`aux_window`、`toggle_window`；重构热点时以分数不继续上升为约束。
- 说明：此前几轮已把 `tray::init`（72→12）、`save_settings`（240→30）、`handle_rpc`（110→12）、`call_tool`（42→≤6）、`AppStateInner::dispatch`（42→12）、`toggle_window`（42→20）、`level_name`（42→<6）等拆到阈值以下（手法：抽出 `build_menu`/`apply_icon`/`respond_sync`/`run_query`/`await_result`/`route`/`aux_window` 等单一职责函数；`on_menu_event` 因调试菜单并入而改走 `menu_specs` 清单 + `aux_window` 解析，从 30 降回 20）。剩余 CRAP 30 一档的分支多为其语义本身（协议分发 / 校验 / 平台 API 读写），继续拆收益递减。真正的降分杠杆是补测试（cov 上升）；此前记的「测试 exe 链接失败」已查明并修复——不是链接器故障，而是测试目标缺少 `tauri-build` 生成的 Windows 资源（应用清单），运行期解析 `comctl32!TaskDialogIndirect`（仅 v6 导出）失败，进程加载阶段即 `0xC0000139`；现由 `build.rs::link_windows_resource_to_tests` 补齐，`cargo test --lib` 可正常执行（覆盖率工具 llvm-cov 尚未接入）。
- 提示：新增托盘菜单项时走 `menu_specs()` 清单 + `aux_window()` 映射，不要向 `build_menu` / `on_menu_event` 累加 `?` 与 match 臂（会导致 CRAP 越过 30）。
- 完整用法（Windows 安装、覆盖率接入、CLI 选项与退出码、修复指引）见 [.agents/skills/crap-analysis/SKILL.md](../../.agents/skills/crap-analysis/SKILL.md)。

按需扩展检查（未安装不影响开发；依赖/供应链变更时建议执行）：

| 工具 | 安装 | 用途 |
|------|------|------|
| `cargo-audit` | `cargo install cargo-audit` | RustSec 漏洞公告扫描（零配置） |
| `cargo-deny` | `cargo install cargo-deny` | 漏洞 + 许可证 + 重复依赖检查（首次 `cargo deny init` 生成配置） |
| `cargo-machete` | `cargo install cargo-machete` | 检出未使用依赖 |

调整 lint 清单时：先在本目录跑门禁命令确认零告警，再同步更新本节两张表。

## 开发注意事项

- 统一 `anyhow::Result` + `?` 传播；错误信息中文、可定位（例：「前端响应超时（5s）」）。
- 运行期路径禁止 `unwrap` / `expect` / `panic!`（由 lint 门禁强制）；仅启动期 fail-fast 可受控例外，且必须 `#[allow]` + 中文注释说明理由（现有唯一例外：`tools.rs::manifest`）。
- 互斥锁一律走 `AppStateInner` 访问器（`sessions()` / `pending()`）：锁中毒自愈（`PoisonError::into_inner`）而非级联 panic；禁止 `lock().unwrap()`。
- 超时/并发/回滚路径必须有防护且写清原因：查询型 5s 超时后必须清理 `pending` 表（防泄漏）；SSE 会话断开由 `SessionGuard::drop` 清理 `sessions` 表（防重连累积泄漏）；SSE `broadcast` 落后丢弃策略（Lagged）不得改为阻塞等待。注意 `sessions` / `SessionGuard` / `Lagged` 这组状态**只为 SSE 兼容通道存在**，Streamable HTTP 是无状态的；若要下线 SSE，这条链可整段删除（`rpc` / `tools` / `state.pending` 均不受影响）。
- 事件契约字段改动必须与 `src/frontend/shared/domain/types.ts` 同步；`#[serde(default)]` 等兼容标记不得随意移除。设置契约同理由 `config.rs::Settings` ↔ `types.ts::MascotSettings` 成对维护（camelCase）。导入模型契约 `ImportedModel` / `ImportOutcome` ↔ `shared/domain/imported.ts` 成对维护（命令名与协议 scheme 也在两侧成对）。
- 用户数据目录不可假设可写：落盘失败必须回滚临时目录并给中文错误（`model_store.rs` 已按此实现）；任何新增用户文件都放 `<app_data_dir>/` 下并走 `?` 传播，不要 `unwrap`。
- zip 解压是攻击面：新增解压路径必须经过 `enclosed_name` 校验、限制条目数/总字节数，并拒绝绝对路径与 `..`（参见 `extract_zip` 与单测）。
- edition 2021、MSRV 1.77（`Cargo.toml`）；使用更高版本要求的语法/API 时必须同步更新 `rust-version`。
- 常量集中定义（如 `mcp::DEFAULT_MCP_PORT`、查询超时 5s）；端口以设置为准，魔法值必须附中文注释（如 SSE 缓冲 64）。
- 依赖变更必须同步 `Cargo.lock`，并跑一次门禁命令。
- 日志按级别走 `log` 门面（`log::info!` / `log::warn!` / `log::error!`），由 `log_setup.rs::plugin()` 注册的 tauri-plugin-log 双写 stderr + 文件（落盘位置与行格式见 References），禁止直接 `eprintln!` / `println!`；注释与日志其余要求遵全局规范（见 References）。
- 构建口径：`target/release/kanbanniang.exe` 只能由 `npm run tauri:build`（= `make build`）产出。用 `cargo build` / `cargo build --release` 直接编得到的二进制带 `cfg(dev)`，前端走 `devUrl`（Vite dev server），被 DSH 插件拉起后是空白窗口、前端不回 MCP（查询型工具 5s 超时），且 exe 只有 ~4MB（内嵌资源约 23MB）。`lib.rs` 启动时会打 `[boot] 当前为开发构建…` 告警兜底——日志里出现它即说明构建方式错了。
- 测试目标也要链接 Windows 资源：`tauri-build` 只经 `cargo:rustc-link-arg-bins` 把 `libresource.a`（含 Common-Controls v6 应用清单）发给 bin，测试目标没清单时 `comctl32!TaskDialogIndirect`（仅 v6 导出）解析失败，进程加载期即 `0xC0000139`（表现为 `cargo test --lib` 退出码 `-1073741511`、无任何用例输出）。`build.rs::link_windows_resource_to_tests` 用 `cargo:rustc-link-arg` 补齐；注意 `cargo:rustc-link-arg-tests` 对 lib 单测 harness 无效（cargo 会报「没有 test target」）。

## 依赖关系

- 依赖 `src/mcp/tools.json`（`include_str!` 编译期嵌入）。
- 依赖 `tauri-plugin-autostart`（开机自启：Windows 写 `HKCU\...\Run`，macOS 走 LaunchAgent）；插件 `setup` 阶段托管 `AutoLaunchManager`，经 `ManagerExt::autolaunch()` 调用，故 `apply_startup`/`save_settings` 必须在插件注册之后执行。
- 与前端仅通过「Tauri 事件契约 + JSON 字段」耦合（`state.rs` ↔ `types.ts`），不依赖前端代码。
- 依赖 `zip`（只开 `deflate-flate2` 后端，复用已有 flate2 纯 Rust 实现，不引入 C 依赖；版本按 MSRV 1.77 固定为 `=4.2.0`，升级前先确认 `rust-version`）与 `percent-encoding`（协议请求路径解码）。
- 导入模型只依赖文件系统与 `app_data_dir()`：协议 scheme 常量 `model_store::ASSET_SCHEME` 由 `lib.rs` 注册，前端同名常量在 `shared/domain/imported.ts` 成对维护。
- 本仓库设置了 rustup 目录 override：工具链为 `stable-x86_64-pc-windows-gnu`（`rustup override list` 可查）；工具安装/构建行为以该工具链为准。

## References

| 文档 | 主题 |
|------|------|
| [.agents/skills/architecture/SKILL.md](../../.agents/skills/architecture/SKILL.md) | DDD 分层、事件桥、契约同步、锁中毒自愈 |
| [.agents/skills/comments/SKILL.md](../../.agents/skills/comments/SKILL.md) | 注释规范：中文注释、受控 `#[allow]` 例外 |
| [.agents/skills/logging/SKILL.md](../../.agents/skills/logging/SKILL.md) | 日志规范：模块前缀、必录链路、级别语义 |
| [.agents/skills/crap-analysis/SKILL.md](../../.agents/skills/crap-analysis/SKILL.md) | CRAP 复杂度打分：安装、覆盖率接入、修复指引 |

## See Also

- ← 上级：[[AGENTS.md]]
- [[src/frontend/AGENTS.md]]（事件契约成对维护）
