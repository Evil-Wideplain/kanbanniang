# 看板娘 KanbanNiang

**Tauri 2 + Live2D 桌面看板娘，内置 MCP 服务（Streamable HTTP）。** Agent 通过 11 个 MCP 工具操作她的动作、表情、台词、窗口位置与模型；本仓库同时是一个 **DSH 插件包**，安装后 DSH 启动时自动拉起看板娘，并把工具注入为 `mcp__kanbanniang__*`。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Tauri 2](https://img.shields.io/badge/Tauri-2-lightgrey.svg)
![Node >=18](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg)
![MCP Streamable HTTP](https://img.shields.io/badge/MCP-Streamable%20HTTP-purple.svg)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-blueviolet.svg)

## 特性

| 能力 | 说明 |
|------|------|
| MCP 单端点 | `POST http://127.0.0.1:7432/mcp`，Streamable HTTP 单传输；`GET /health` 供插件探活 |
| Agent 即插即用 | DSH、Claude Desktop、MCP Inspector 等任意支持 Streamable HTTP 的客户端 |
| DSH 插件 | `cordis.patch.yml` 插入宿主插件与官方 MCP 客户端两行，工具注册为 `mcp__kanbanniang__<tool>` |
| 11 个工具 | 动作序列 / 表情 / 说话 / 窗口移动 / 窗口内站位 / 待机 / 列举动作 / 列举表情 / 状态 / 换模型 / 列举模型 |
| 拖拽导入模型 | 把 `.zip` 或解压后的模型文件夹拖到角色身上，解析配置、落盘、热切换 |
| 鼠标穿透 | 只有角色像素接收鼠标事件，空白区域事件落到下层窗口 |
| 模型热切换 | 运行时 `set_model` 切换，失败回滚原模型；语义别名屏蔽不同模型的命名差异 |
| 窗口形态 | 透明、无边框、置顶、不占任务栏；主窗口 640×800，角色固定按 360×480 渲染 |

## 架构

```
DSH（插件系统 + MCP 客户端）          Claude Desktop / Inspector / 自研脚本
      │ Streamable HTTP                       │ Streamable HTTP
      ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 看板娘进程（Tauri 2 / Rust，127.0.0.1:7432）                          │
│ axum：POST /mcp · GET /health（Streamable HTTP 唯一传输）              │
│ JSON-RPC 2.0 路由 → 工具清单 src/mcp/tools.json → tools/call           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ Tauri 事件 mascot:action
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ WebView 前端（TypeScript + pixi.js + pixi-live2d-display）            │
│ dispatcher → Live2D 控制器 → 动作 / 表情 / 气泡                        │
│ 需回传结果的工具经 mascot:result 事件返回（oneshot，5s 超时）          │
└─────────────────────────────────────────────────────────────────────┘
```

- **传输**：单端点 `POST /mcp`。`initialize` 的 `protocolVersion` 按客户端请求回显，受支持版本为 `2025-06-18` / `2025-03-26` / `2024-11-05`；未声明或未知版本回退 `2025-06-18`。旧版 HTTP+SSE 的 `/mcp/sse` 已下线。
- **动作链路**：`tools/call` → Rust 发射 Tauri 事件 `mascot:action` → 前端 dispatcher 驱动 Live2D 控制器执行。
- **查询链路**：`src/mcp/tools.json` 中 `query: true` 的工具（`play_motion`、`set_expression`、`move`、`list_motions`、`list_expressions`、`get_status`、`set_model`、`list_models`）由前端经 `mascot:result` 回传，Rust 侧 oneshot 等待 5s；`speak`、`move_in_window`、`set_idle` 发射后直接返回。
- **导入链路**：拖放到角色 → Tauri 原生拖放事件 → Rust 解析 `*.model3.json` 并落盘到应用数据目录 → 前端注册运行时档案并热切换；模型资源经只读协议 `mascot-model://` 提供给 WebView（Windows 上为 `http://mascot-model.localhost/...`）。
- **DSH 链路**：DSH 启动 → 宿主插件读设置解析端点、探活 `/health`、未运行则拉起 exe → 官方 MCP 客户端连同一端点 → 工具注入会话。

## 前置依赖

| 依赖 | 说明 |
|------|------|
| Node.js ≥ 18 | 前端构建与 Tauri CLI |
| Rust stable（推荐 `windows-msvc` 目标；`windows-gnu` 亦可） | <https://rustup.rs/> |
| WebView2 Runtime | Windows 10/11 一般已预装 |
| VS Build Tools | 勾选「使用 C++ 的桌面开发」；详见 <https://v2.tauri.app/start/prerequisites/> |
| Live2D 模型 | 需自备 Cubism 3–5.3 的模型（`.model3.json`），见 [`models/README.md`](./models/README.md) |

Cubism Core 运行时 `live2dcubismcore.min.js`（6.0.1，支持 Cubism 3–5.3 / moc3 v1–v6）已内置于 `src/frontend/mascot/render/live2d/` 并随仓库提交，无需手动获取。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 准备模型（任选其一，详见 models/README.md）
#    a) 构建期静态资源：把模型目录放进 models/<模型名>/
#    b) 运行时导入：先跳过本步，启动应用后把 .zip 或模型文件夹拖到角色身上

# 3. 启动桌面应用（Vite + 编译 Rust + 打开看板娘窗口）
npm run tauri:dev

# 4. 另开终端验证 MCP 链路（需应用已启动）
node cmd/client/test-streamable.mjs
```

冒烟脚本按顺序覆盖：`/health` → `initialize`（校验协议与 `Mcp-Session-Id`）→ `notifications/initialized` → `tools/list`（≥ 11 个工具）→ `get_status` → `speak` → `play_motion`。执行时应看到看板娘显示气泡并播放两个动作，终端逐项打印 `✅`。

## 作为 DSH 插件安装

前置：DSH 桌面端 0.2.x 已启动过一次（完成 profile 初始化），本机已具备 Rust 工具链。

```bash
npm install
npm run plugin:install               # 构建应用本体 + 编译插件宿主半侧 + 注册到 desktop profile
npm run plugin:install -- --no-build # 跳过构建，沿用 target/release 现有产物
```

脚本调用桌面端自带的 `dsh.cmd`（`resources/runtime/cli/bin/dsh.cmd`）执行 `plugin --profile desktop add link:<仓库绝对路径>`；PATH 上的 npm `dsh` 会拒绝操作 desktop profile。找不到桌面端 CLI 时退化为直接修改 profile 清单，并打印需要手工执行的 pnpm 安装命令。

**它做了什么**

1. `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后自动成为一层 bundle；
2. `cordis.patch.yml` 按顺序插入两行插件：
   - `kanbanniang` 宿主插件（`src/plugin/` → `lib/host.js`）：从看板娘 `settings.json` 的 `mcpEnabled` / `mcpPort` 推导 MCP 端点（默认 7432），发布 `mascotStartup` 服务；探测 `/health`，未运行则拉起 `target/release/kanbanniang.exe`（缺省回退 `target/debug/`），就绪后再用 MCP `get_status` 做一次前端链路探活；
   - `@deepseek-ai/dsh-mcp-client`：`inject: [mascotStartup]`，以 `streamable-http` 连接同一端点，把工具注册为 `mcp__kanbanniang__<tool>`。

> 插件以 `link:` 方式安装，运行时直接拉起仓库里的 `target/release` 产物，不打包、不复制 exe，因此安装脚本会先执行 `tauri build --no-bundle`。不要用 `cargo build --release` 代替：那样编出的二进制带 `cfg(dev)`，前端走 `devUrl`，DSH 拉起后是白屏且查询超时。

**安装后验证**

- 完全退出并重启 DSH，新建会话，工具列表应出现 `mcp__kanbanniang__get_status` / `speak` / `play_motion` 等；
- 对模型说「让看板娘挥挥手，并说欢迎回来」，应看到动作与气泡；
- 宿主插件日志：`<DSH_HOME>/kanbanniang/plugin.log`（Windows 默认 `%USERPROFILE%\.dsh`）。

**配置**

| 位置 | 字段 | 说明 |
|------|------|------|
| 看板娘设置页 | MCP 开关 / 端口 | **端口唯一来源**，写入 `settings.json` 的 `mcpEnabled` / `mcpPort`，插件自动读取 |
| `cordis.patch.yml`（宿主行） | `autoLaunch` | 是否由插件拉起应用，默认 `true` |
| `cordis.patch.yml`（宿主行） | `mcpUrl` | 强制固定端点（覆盖设置文件），一般不需要 |
| `cordis.patch.yml`（宿主行） | `repoRoot` / `launchCommand` | 仓库位置 / 自定义启动命令，一般不需要 |
| `cordis.patch.yml`（MCP 行） | `toolCallTimeoutMs` | 单次工具调用超时，默认 15000ms |
| `cordis.patch.yml`（MCP 行） | `reconnect.maxAttempts` | 连续重连上限，耗尽后工具注销，需重载配置 |

**图形界面安装（等价）**：DSH 侧栏「插件」→「安装第三方插件」→ 填本仓库绝对路径 → 安装并启用。

**卸载**

```bash
npm run plugin:uninstall   # dsh plugin --profile desktop remove kanbanniang
```

安装/卸载后需完全退出并重启 DSH 生效；看板娘应用与仓库文件不受影响，仍可直接运行 `target/release/kanbanniang.exe`。

## DSH 插件市场

**现状：不能直接从 DSH 插件市场安装，请使用上一节的本地 `link:` 安装。** 结论是「协议与工具链层面支持，本仓库打包形态尚不支持」：

- **机制本身可用**（DSH 0.2.1-rc.3 实测）：可选组合包 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供「发现」页；索引格式 1 有随装校验器；安装 spec 由 `marketInstallTarget` 生成（npm 为 `name@version`，git 为 `git+<url>#<commit>`），交给 `pluginManager.installBundle`。
- **入口缺失**：`lib/`（宿主插件编译产物）在 `.gitignore` 中，git 形态的包没有 `main` 入口；改用安装期 `prepare` 构建也走不通——pnpm 会拦截 git 依赖的构建脚本，要求精确到 `包名@git+url#commit` 的 `allowBuilds` key，而市场安装的授权只记录包名。
- **应用 exe 缺失**：安装目录里没有 `target/release/kanbanniang.exe`；宿主插件的 `findRepoRoot()` 要求包内同时存在 `package.json` 与 `src/tauri/Cargo.toml`，但 pnpm 按 `files` 打包，`src/` 与 `target/` 都不会进包，实测 `plugin.log` 报「未找到看板娘可执行文件」。
- **没有 npm 版本**：`package.json` 为 `private: true`，且这是含 Rust 源码的应用仓库，市场只能走 git source；DSH 目前也没有官方市场，索引源需自建自托管、由用户手动添加。
- **模型不入库**：市场安装无法附带 Live2D 模型，用户仍需自备并拖拽导入。

完整的验证过程（索引校验、隔离 profile 实测、`plugin.log` 证据）、阻塞项清单与上架前启用清单见 [`docs/market-distribution.md`](./docs/market-distribution.md)。在补齐这些之前，请使用本地安装方式。

## 让 Agent 接入（MCP 客户端）

**端点：`http://127.0.0.1:7432/mcp`（Streamable HTTP，唯一传输）。** 端口可在看板娘设置页修改；旧版 HTTP+SSE（`2024-11-05`）的 `/mcp/sse` 已下线。

- **DSH**：按上一节安装插件，无需手工配置。
- **Claude Desktop / 其他客户端**：编辑客户端的 MCP 配置（Claude Desktop 为 `claude_desktop_config.json`，位置见其文档），重启客户端后确认 `kanbanniang` 已连接：

```json
{
  "mcpServers": {
    "kanbanniang": {
      "url": "http://127.0.0.1:7432/mcp"
    }
  }
}
```

- **可视化调试**：官方 [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector)，填入上述 URL 即可。
- 仅支持旧版 HTTP+SSE 的客户端需先升级（Claude Desktop、DSH 及现代客户端均已支持 Streamable HTTP）。

## 工具清单（MCP）

| 工具 | 参数 | 说明 | 返回 |
|------|------|------|------|
| `play_motion` | `steps: {motion, index?, holdMs?, expression?, text?}[]`、`idle?: boolean` | 串行连播动作，每步等播完再进下一步；`holdMs` 为播完后的额外停留（0–5000ms）；`expression` / `text` 在本步开始时同步生效且不打断动作；`idle=true` 整段播完回待机；新调用打断旧队列 | 每步解析结果数组 |
| `set_expression` | `expression: string` | 换表情，接受真实名或语义名（忽略大小写与下划线），未命中回退默认表情；播放中可用且不打断动作 | `{applied, fallback}` |
| `speak` | `text: string` | 显示气泡并做表情反馈（当前无真实口型同步） | — |
| `move` | `x: number`、`y: number`（0–1） | 平滑移动整个窗口到工作区归一化坐标，约 0.6s 到位，窗口保证完整可见 | `{x, y, physicalX, physicalY, clamped, superseded}` |
| `move_in_window` | `x: number`、`y: number`（0–1） | 调整角色在窗口内的站位，不移动窗口本身 | — |
| `set_idle` | — | 清除表情与动作，回到待机 | — |
| `list_motions` | — | 列出当前模型可用的动作组名 | 组名列表 |
| `list_expressions` | — | 列出当前模型可用的表情名 | 表情名列表 |
| `get_status` | — | 当前状态快照（模式 / 模型 / 表情 / 位置 / 是否在说话） | 状态对象 |
| `set_model` | `model: string` | 运行时热切换模型档案，加载失败时原模型保持不变 | `{ok:true, model, mode, modelFile}` / `{ok:false, error}` |
| `list_models` | — | 列出模型档案：id / 名称 / 渲染模式 / 主文件 / 是否默认 / 当前使用中 | 档案列表 |

> 工具定义的单一来源是 [`src/mcp/tools.json`](./src/mcp/tools.json)（Rust 与 TS 同源加载），本表为文档镜像，冲突以清单为准。可用动作名与表情名取决于模型自带文件，先调 `list_motions` / `list_expressions` 查询。

## 接入真实 Live2D

**方式 A：拖拽导入（不写入仓库）**

把 `.zip` 压缩包或解压后的模型文件夹拖到**角色身上**，松开即导入：解析 moc / 贴图 / 动作组 / 表情，校验必需文件存在后复制到 `<app_data_dir>/models/imported-<名字>/`（Windows 一般在 `%APPDATA%` 下）。同名模型重复导入整体覆盖；不同名模型 id 撞车时分配 `-2` 保留，不会互相删除。导入成功后立即热切换，并出现在设置页芯片与 `list_models` 中（id 形如 `imported-haru`）。移除：退出应用后删除对应目录。

**方式 B：构建期静态资源（可随仓库分发，但模型目录不入库）**

1. 把模型目录放到 `models/<模型名>/`（含 `*.model3.json` 及 `motions/`、`expressions/` 等）；
2. `models/` 经 Vite `publicDir` 作为静态资源根，`models/Haru/…` 会以 `/Haru/…` 提供；
3. `npm run dev` / `npm run build` 前由 `scripts/gen-models.mjs` 自动扫描并生成模型清单，无需手工登记；
4. 需要展示名、缩放 / 锚点或语义别名时，编辑 `src/frontend/shared/domain/profiles.ts` 的 `MODEL_OVERRIDES`（键为 `models/` 下的目录名）。

**语义别名**：不同模型的动作 / 表情命名不一致（官方系多为 `Idle` / `TapBody`，表情可能是 `F01` 起）。档案可为 `idle`、`speak`、`neutral`、`happy` 等语义名配置映射，Agent 即可用同一套调用名操作任意模型。批量发现与命名可运行 `node cmd/client/preview.mjs`（需应用已启动），逐个播放并让你在终端标注。

**运行时切换**：`list_models` 查档案 → `set_model` 热切换；切换会重置表情与位置（跨模型名称不同），同 id 重复切换返回 `{ok:true, unchanged:true}`。完整说明（含排查）见 [`models/README.md`](./models/README.md)。

## 目录结构

```
pet/
├─ src/
│  ├─ frontend/           前端（TS + Vite）
│  │  ├─ app/             三个窗口入口与组合根
│  │  ├─ shared/          领域契约 / IPC / 表现工具
│  │  ├─ mascot/          看板娘域：dispatcher、模型热切换、Live2D 渲染、气泡、拖放浮层
│  │  ├─ settings/        设置页
│  │  ├─ debug/           MCP 调试面板（仅开发构建）
│  │  └─ styles/
│  ├─ plugin/             DSH 宿主插件半侧（TS → lib/）
│  ├─ mcp/tools.json      MCP 工具清单（单一来源）
│  └─ tauri/              Rust 后端：Tauri 装配、axum MCP 服务、模型导入
├─ cmd/client/            MCP 客户端与脚本：client.mjs / test-streamable.mjs / preview.mjs
├─ scripts/               gen-models.mjs（构建前扫描模型）、install-dsh-plugin.mjs（安装到 DSH）
├─ models/                静态资源根；模型目录不入库，接入文档见 models/README.md
├─ assets/icon.png        插件管理页图标
├─ docs/                  补充文档（如 market-distribution.md）
├─ .github/workflows/     CI
├─ .agents/skills/        内置开发规约（按需加载）
├─ cordis.patch.yml       DSH bundle patch：宿主插件 + MCP 客户端两行
├─ Makefile               常用命令入口
├─ package.json           前端依赖、脚本与 DSH 插件元数据
├─ AGENTS.md              Agent 开发入口与硬性规则
├─ LICENSE                MIT
├─ .gitattributes / .gitignore
└─ README.md
```

## 开发与验证

| 命令 | 作用 |
|------|------|
| `make check` | 前端门禁：`tsc --noEmit` + Vite 构建（前端改动必过） |
| `make unit` | 单元测试：`npm run test` + `npm run test:plugin`（改领域层 / 纯函数 / 插件逻辑必过） |
| `make lint` | Rust 门禁：`clippy --all-targets -- -D warnings` + `fmt --check`（Rust 改动必过） |
| `make verify` | 提交前全量门禁（= `check` + `unit` + `lint`） |
| `make score` | Rust CRAP 复杂度打分（cargo-crap） |
| `make dev` / `make build` | `npm run tauri:dev` / `npm run tauri:build` |
| `npm run plugin:build` | 编译插件宿主半侧到 `lib/` |
| `node cmd/client/test-streamable.mjs` | MCP 冒烟测试（需应用已启动；协议 / 工具改动必跑） |

提交前至少执行 `make verify`；改动协议、工具清单或动作后补跑冒烟测试；改动 DSH 装配后用非 desktop profile（如复制 `web` 模板）验证层叠与端到端工具调用。

CI（GitHub Actions，[`.github/workflows/ci.yml`](./.github/workflows/ci.yml)）在 `windows-latest` 上跑同一组门禁：前端 `npm ci` → `npm run build` → `npm run test` → `npm run test:plugin`，Rust 侧 `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings`（先构建 `dist/`，不跑 `tauri build`）。

> GNU 工具链 + MSYS / Git Bash 下若 `make lint` 报 windres `Unable to create temp file`，是该 shell 把 `TEMP` 置为 `/tmp` 导致资源编译找不到合法临时目录：改用 PowerShell / cmd 运行，或先把 `TEMP`、`TMP` 设为 Windows 路径（如 `C:\...\Temp`）；`make check` / `make unit` 不受影响。

编码规约、分层约束与完整检查清单见 [`AGENTS.md`](./AGENTS.md) 与 `.agents/skills/`，本 README 不重复搬运。

## 常见问题

| 现象 | 排查方向 |
|------|----------|
| DSH 拉起后白屏、工具不可用 | 构建方式错（用了 `cargo build --release`）：产物带 `cfg(dev)`，前端加载 `devUrl`。看日志里的 `[boot] 当前为开发构建…`，用 `npm run plugin:install` 重新做 release 构建；`plugin.log` 里 `get_status` 探活失败也指向这里 |
| 改了端口，插件仍连旧端口 | 端口唯一来源是看板娘设置页写入的 `settings.json`；插件每次启动重读，改完重启 DSH 即可。不要在 `cordis.patch.yml` 里另写一份端口 |
| 插件没激活 / 工具没出现 | 查 `<DSH_HOME>/kanbanniang/plugin.log`；确认 profile 依赖里有 `kanbanniang`、`cordis.patch.yml` 未被覆盖，然后完全重启 DSH |
| 查询型工具 5s 超时 | 前端不在线（窗口关闭或白屏）。`/health` 健康只证明 Rust 在监听，不代表前端活着；用 `get_status` 判断 |
| 拖模型没反应 | 拖到了空白区域：鼠标穿透已把事件交给下层窗口，需把文件放到角色身上；仅支持 `.model3.json`（Cubism 3+） |
| 模型加载失败 | 读 `set_model` 返回的 `{ok:false, error}`。常见原因是 moc3 版本高于内置 Core 上限（6.0.1 最高支持 Cubism 5.3），需替换 `live2dcubismcore.min.js` |
| 导入后设置页没有新模型 | 设置窗口重新聚焦时刷新；列表来自后端仓库，仍不出现请重启应用 |

## 已知限制

- **无鉴权**：MCP 服务仅监听 `127.0.0.1`，未做 token / 证书，请勿直接暴露到公网。
- **平台**：Windows 为主要验证平台；macOS / Linux 的自动拉起路径（可执行文件名）未适配。
- **口型**：`speak` 仅显示气泡并做表情反馈，真实口型同步需接入 AudioEngine + Phoneme。
- **前端依赖**：查询型工具要求前端在线，窗口关闭即 5s 超时。
- **模型**：`models/*/` 不入库，需自备模型并遵守各自许可；Cubism 2 的 `.model.json` 会被拒绝。
- **市场分发**：DSH 市场机制本身可用，但当前打包形态（`lib/` 不入库、包内无 exe）装完起不来，只能本地安装；详见「DSH 插件市场」与 [`docs/market-distribution.md`](./docs/market-distribution.md)。
- **鼠标穿透**：按角色像素命中动态开关，空白区域收不到任何鼠标消息；前端有 fail-safe（交互层停止、光标源失效、穿透态 1s 无采样主动恢复可交互），不会卡死。
- **窗口适配**：启动时按当前显示器工作区收缩窗口（只收缩不放大）；角色缩放以 360×480 设计基准计算，窗口变小只是减少四周留白，不改变角色像素尺寸。

## 贡献与致谢

- 提交前跑 `make verify`；commit message 遵循 Conventional Commits（`type(scope): 中文 subject`），细则见 `.agents/skills/commit`。
- 文档分工：README 面向使用者，[`AGENTS.md`](./AGENTS.md) 与 `.agents/skills/` 面向开发规约；补充文档放 `docs/`。
- 致谢：[Tauri](https://tauri.app/)、axum、[Live2D Cubism SDK](https://www.live2d.com/sdk/)、pixi-live2d-display、[pixi.js](https://pixijs.com/)、[Model Context Protocol](https://modelcontextprotocol.io/)、DeepSeek Harness。
- 仓库不附带模型；演示用的示例模型来自 Live2D Cubism SDK（遵循 Live2D 开放许可），商用请自行确认授权。

## License

[MIT](./LICENSE)
