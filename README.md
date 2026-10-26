# 看板娘 KanbanNiang · Tauri + Live2D + 内置 MCP 服务

一个**桌面看板娘**：用 [Tauri](https://tauri.app/) 做窗口外壳，用 [Live2D Cubism](https://www.live2d.com/) 做角色渲染，并在应用内**直接提供一个 MCP（Model Context Protocol）服务**（同时支持旧版 SSE 与 Streamable HTTP）。任何兼容 MCP 的 Agent（**DSH**、Claude Desktop、自定义脚本等）都能连上来，调用工具让看板娘**做动作、换表情、说话、移动、查询状态**。

> 核心价值：**看板娘即工具（tool）**。Agent 不需要理解 Live2D，只要调用 `play_motion` / `speak` / `set_expression` 等 MCP 工具，桌面上的看板娘就会动起来。
>
> 本仓库同时是一个 **DSH 插件包**：安装后 DSH 启动时会自动拉起看板娘，并把 11 个工具注册给模型（`mcp__kanbanniang__*`）。

---

## 架构

```
┌──────────────────────────────┐   ┌────────────────────────────────┐
│  DSH（插件系统 + MCP 客户端） │   │  Claude Desktop / Inspector 等  │
│  mcp__kanbanniang__* 工具     │   │  任意 MCP 客户端                 │
└──────────────┬───────────────┘   └───────────────┬────────────────┘
               │ Streamable HTTP                    │ Streamable HTTP / 旧版 SSE
               ▼                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  看板娘 Tauri 进程（Rust，127.0.0.1:7432）                │
        │  axum：POST /mcp · GET /mcp/sse · /health                 │
        │  MCP 服务 → JSON-RPC 路由 → 工具清单（src/mcp/tools.json） │
        └───────────────────────────┬──────────────────────────────┘
                                    │ Tauri 事件 mascot:action
                                    ▼
        ┌──────────────────────────────────────────────────────────┐
        │  WebView 前端（TypeScript）                               │
        │  dispatcher → Live2D 控制器 → 动作 / 表情 / 气泡           │
        │  查询型动作经 mascot:result 回传（一次性通道，5s 超时）     │
        └──────────────────────────────────────────────────────────┘
```

- **双传输**：同一端口同时提供 MCP **Streamable HTTP**（`POST http://127.0.0.1:7432/mcp`，
  **主路径**，DSH 及所有现代客户端走这条）与旧版 **SSE**（`http://127.0.0.1:7432/mcp/sse`，
  MCP `2024-11-05` 的传输，自 `2025-03-26` 起已被 Streamable HTTP 取代并废弃，仅兼容老客户端）；
  `/health` 供插件探活。两条路径共用同一套 JSON-RPC 与工具实现。
- **动作链路**：Agent 调用工具 → axum 收到 `tools/call` → 通过 Tauri 事件 `mascot:action` 通知前端 → 前端驱动 Live2D 看板娘执行。
- **查询链路**：`list_motions` / `list_expressions` / `get_status` / `set_model` / `list_models` 这类查询型工具，前端执行后通过 `mascot:result` 事件把结果回传，Rust 端用 oneshot 通道等结果（超时 5s）。
- **DSH 插件链路**：DSH 启动 → 宿主插件探活/拉起看板娘 → 官方 MCP 客户端连接 `/mcp` → 工具注入当前会话。

---

## 特性

- ✅ 内置 MCP 服务：**Streamable HTTP + SSE 双传输**，Agent 即连即用
- ✅ **可作为 DSH 插件安装**：DSH 启动自动拉起看板娘，工具以 `mcp__kanbanniang__*` 注入会话
- ✅ 11 个工具：动作 / 表情 / 说话 / **窗口移动**（平滑滑行）/ 窗口内站位 / 待机 / 列动作 / 列表情 / 查状态 / **运行时换模型** / 列模型
- ✅ Live2D Cubism 3–5.3 模型即插即用：放入 `models/` 后自动发现并登记
- ✅ 透明无边框、置顶窗口，典型的桌面看板娘形态

---

## 前置依赖

1. **Node.js ≥ 18**（前端与 Tauri CLI）。
2. **Rust 工具链**（Tauri 必须）：<https://rustup.rs/>，安装 stable + `windows-msvc` 目标。
3. **Windows 系统依赖**（Tauri v2）：
   - WebView2 Runtime（Win10/11 一般已预装；没有则装 Evergreen 引导器）
   - Microsoft C++ Build Tools / Visual Studio（含「使用 C++ 的桌面开发」）
   - 详见官方指南：<https://v2.tauri.app/start/prerequisites/>
4. Live2D 模型文件需自备，官方示例模型在 Live2D Cubism SDK for Web 内 —— 见 `models/README.md`。

> 本仓库的 Rust 端需要你本地有 Rust 才能编译运行；前端 TypeScript 已尽量独立可测。

---

## 快速开始

```bash
# 1. 安装前端依赖
npm install

# 2. 接入 Live2D 模型（必需），见 models/README.md

# 3. 启动桌面应用（会自动拉起 Vite + 编译 Rust + 打开看板娘窗口）
npm run tauri:dev

# 4. 另开一个终端，验证 MCP 工具链路（需应用已启动）
node cmd/client/test.mjs            # 旧版 SSE 传输
node cmd/client/test-streamable.mjs # Streamable HTTP 传输（DSH 同款协议）
```

启动后可看到桌面角落出现一个透明置顶的看板娘；两个冒烟脚本会依次调用
`initialize → tools/list → speak → get_status → list_motions → play_motion → set_expression`，
你应该能看到看板娘做出对应反应，且脚本打印出返回结果。

---

## 作为 DSH 插件安装（推荐）

> 前置：DSH 桌面端 0.2.x 已启动过一次（完成 profile 初始化），且本仓库已构建出 exe。

```bash
npm install
make build              # Release 构建：生成 target/release/kanbanniang.exe
npm run plugin:install  # 安装到 DSH desktop profile（自动先编译插件宿主半侧）
```

安装脚本调用**桌面端自带的 dsh CLI**（`resources/runtime/cli/bin/dsh.cmd`）执行
`plugin --profile desktop add link:<本仓库绝对路径>`——PATH 上的 npm `dsh` 会拒绝操作 desktop profile。
插件管理器会完成：profile 依赖写为 `link:` 符号链接、`dsh.profile.bundles` 追加 `kanbanniang`、
用自带 pnpm 安装、以及版本闸门校验（本包声明 `engines.dsh: ^0.2.0-rc.1`）。

**它做了什么**

- 根目录 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后自动成为一层 bundle；
- `cordis.patch.yml` 按顺序插入两条插件：
  1. `kanbanniang` 宿主插件（`src/plugin/` → `lib/host.js`）：读取看板娘 `settings.json`
     的 `mcpPort` 解析 MCP 端点（默认 7432），发布 `mascotStartup` 服务；探测 `/health`，
     未运行则拉起 `target/release/kanbanniang.exe`（缺省回退 `target/debug/`）并等待就绪；
  2. `@deepseek-ai/dsh-mcp-client`：`inject: [mascotStartup]`，以 `streamable-http` 连接
     同一端点，把 11 个工具注册为 `mcp__kanbanniang__<tool>`。

> 端口只有一处来源：看板娘设置页（写入 `settings.json`）。插件每次启动都会重新读取，
> 因此改端口后只需重启 DSH，不必修改插件配置。

> **从旧名升级**：旧包名 `kanban-mascot` 已整体改为 `kanbanniang`——包名、插件 id、MCP 工具命名空间
> （`mcp__kanbanniang__*`）、可执行文件名、DSH 插件日志目录（`~/.dsh/kanbanniang/`）与环境变量前缀
> （`KANBANNIANG_*`）全部随之更新。Tauri application identifier 仍保留 `com.example.kanbanmascot`，
> 因此既有 `settings.json`（端口 / 模型 / 不透明度等）与 Rust 应用日志的回退目录继续复用，无需重新配置；
> 应用日志文件名随 productName 变为 `KanbanNiang.log`。
> 装过旧版的机器请先 `dsh plugin --profile desktop remove kanban-mascot` 再 `npm run plugin:install`，
> 否则 profile 里的旧 bundle 行会解析失败。

**重启 DSH 后验证**

- 新建会话，对模型说「让看板娘挥挥手，并说欢迎回来」；
- 可用工具里应出现 `mcp__kanbanniang__get_status`、`..._speak`、`..._play_motion` 等；
- 宿主插件日志：`~/.dsh/kanbanniang/plugin.log`（DSH 桌面端本身不落盘 host 插件日志，故双写一份）。

**图形界面安装（等价）**：DSH 侧栏「插件」→「安装第三方插件」→ 填本仓库绝对路径 `C:\Code\pet` → 安装并启用。

**配置**

| 位置 | 字段 | 说明 |
|------|------|------|
| 看板娘设置页 | MCP 开关 / 端口 | **端口的唯一来源**：写入 `settings.json` 的 `mcpEnabled` / `mcpPort`，插件自动读取 |
| `cordis.patch.yml`（宿主行） | `autoLaunch` | 是否由插件拉起应用；默认 `true` |
| `cordis.patch.yml`（宿主行） | `mcpUrl` | 可选：强制固定端点（覆盖设置文件），一般不需要 |
| `cordis.patch.yml`（宿主行） | `launchCommand` / `repoRoot` | 自定义启动命令或仓库位置（一般不需要） |
| `cordis.patch.yml`（MCP 行） | `reconnect.maxAttempts` | 连续重连上限；耗尽后工具注销，需重载配置 |

**卸载**

```bash
npm run plugin:uninstall   # dsh plugin --profile desktop remove kanbanniang
```

安装/卸载后需**完全退出并重启 DSH** 生效；看板娘应用与仓库文件不受影响，仍可单独运行。

---

## 让 Agent 接入（MCP 客户端配置）

> **端点：`http://127.0.0.1:7432/mcp`（Streamable HTTP，主路径）**。只有当客户端**只实现旧版
> SSE 传输、不会回退新版**时，才改用 `http://127.0.0.1:7432/mcp/sse`。端口可在设置页修改。

### DSH

见上文「作为 DSH 插件安装」，无需手工配置。

### Claude Desktop / 其他客户端

编辑客户端的 MCP 配置（Claude Desktop 为 `claude_desktop_config.json`，位置见其文档）：

```json
{
  "mcpServers": {
    "kanbanniang": {
      "url": "http://127.0.0.1:7432/mcp"
    }
  }
}
```

重启客户端，确认「kanbanniang」已连接。之后你可以直接说：
"让看板娘挥手并说『欢迎回来～』"，它就会调用 `play_motion` + `speak`。

若客户端版本较老、只认旧版 SSE（`2024-11-05`）传输，把 `url` 换成
`http://127.0.0.1:7432/mcp/sse` 即可——功能完全一致，只是换了条通道。

也可用官方 [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector) 可视化调试。

---

## 工具清单（MCP）

| 工具 | 参数 | 说明 |
|------|------|------|
| `play_motion` | `motion: string`, `index?: number` | 播动作（idle/tap_body/pinch_in/pinch_out/wave/shake…） |
| `set_expression` | `expression: string` | 换表情（neutral/happy/angry/surprised/sad…） |
| `speak` | `text: string` | 说话（显示气泡 + 反馈） |
| `move` | `x: number`, `y: number` | 平滑移动**整个窗口**到工作区坐标（归一化 0~1，约 0.6s；返回最终坐标） |
| `move_in_window` | `x: number`, `y: number` | 调整看板娘在窗口内的站位（归一化 0~1，不动窗口） |
| `set_idle` | — | 回到待机 |
| `list_motions` | — | 列出可用动作组 |
| `list_expressions` | — | 列出可用表情 |
| `get_status` | — | 当前状态快照 |
| `set_model` | `model: string` | 运行时切换模型档案（失败自动回滚，原模型不受影响） |
| `list_models` | — | 列出可用模型档案（id / 名称 / 当前使用中） |

> 工具定义的**单一来源**是 [`src/mcp/tools.json`](./src/mcp/tools.json)（Rust 与 TS 同源加载）；本表为文档镜像，以清单为准。
> 真实 Live2D 模型可用动作/表情名取决于模型自带的文件。
> `set_model` 成功返回 `{ok:true, model, mode, modelFile}`，失败返回 `{ok:false, error}`（同时 `isError:true`）。

---

## 接入真实 Live2D

见 [`models/README.md`](./models/README.md)：下载 Cubism SDK 或自备模型、放入 `models/`，构建前会自动扫描登记；如需展示名、缩放/锚点或语义别名，在 `src/frontend/shared/domain/profiles.ts` 的 `MODEL_OVERRIDES` 中补充。运行时用 MCP 工具 `set_model` 热切换模型。Cubism Core 运行时已内置于 `src/frontend/mascot/render/live2d/`，无需手动获取。

---

## 目录结构

```
pet/
├─ src/                    项目源码根
│  ├─ frontend/            前端（TS + Vite；三窗口入口见 app/）
│  │  ├─ app/              组合根：main.ts / settings.ts / debug.ts（只接线）
│  │  ├─ shared/
│  │  │  ├─ domain/        领域：types（契约+动作表）、profiles（模型档案）、speech/normalize/settings
│  │  │  ├─ ipc/           基础设施：events / settings-client / window / cursor / log-forward（Tauri 桥）
│  │  │  └─ ui/            表现工具：window-controls（自绘标题栏接线）
│  │  ├─ mascot/           看板娘功能域
│  │  │  ├─ application/   dispatcher（指令分发，含穷尽性检查）、model-switch（热切换/回滚）
│  │  │  ├─ render/        live2d/（控制器 + Cubism Core）
│  │  │  └─ ui/bubble.ts   说话气泡（DOM）
│  │  ├─ settings/ui/      设置页 settings-page.ts
│  │  ├─ debug/            MCP 调试面板：panel / args / ipc / log-view / types
│  │  └─ styles/           main.css / settings.css / debug.css
│  ├─ plugin/              DSH 宿主插件半侧（TS）：host 编排 / config / appSettings / runtime / logging
│  ├─ mcp/
│  │  └─ tools.json        MCP 工具清单（Rust/TS 单一来源）
│  └─ tauri/               Rust 后端（cargo 包根）
│     ├─ Cargo.toml
│     ├─ src/lib.rs        Tauri 入口 + 启动 MCP 服务
│     ├─ src/mcp/mod.rs    MCP 模块根（双传输常量与文档）
│     ├─ src/mcp/server.rs 服务生命周期 + 路由装配（/mcp · /mcp/sse · /health）
│     ├─ src/mcp/streamable.rs Streamable HTTP 传输（主路径，DSH 使用）
│     ├─ src/mcp/sse.rs    旧版 SSE 传输与会话（仅兼容老客户端）
│     ├─ src/mcp/rpc.rs    JSON-RPC 方法路由与封套
│     ├─ src/mcp/tools.rs  工具清单加载 + tools/call 分发（读 src/mcp/tools.json）
│     ├─ src/state.rs      共享状态 + 事件发射 + 结果回传（查询型 5s oneshot）
│     ├─ tauri.conf.json   窗口配置（透明/置顶/无边框）
│     └─ capabilities/     权限
├─ cordis.patch.yml        DSH bundle patch：插入宿主插件 + MCP 客户端两行
├─ assets/icon.png         插件管理页图标（≤256 KiB）
├─ scripts/
│  └─ install-dsh-plugin.mjs  安装/卸载到 DSH profile（调用桌面端自带 dsh CLI）
├─ models/                 静态资源根（Vite publicDir）：模型目录 + 接入文档
├─ cmd/
│  └─ client/
│     ├─ client.mjs        共享 SSE/RPC 客户端（pending + 消息队列）
│     ├─ test.mjs          SSE 冒烟测试：完整调用一遍工具
│     ├─ test-streamable.mjs Streamable HTTP 冒烟测试（零依赖）
│     └─ preview.mjs       动作/表情逐个预览并命名（生成语义别名用）
└─ README.md
```

---

## 已知限制 / 后续可扩展

- Live2D 的「真实口型同步」需接入 AudioEngine + Phoneme，当前 `speak` 仅做气泡与表情反馈。
- 查询型工具依赖前端在线（窗口开着）；若窗口关闭，查询会 5s 超时。
- MCP 目前仅本地 `127.0.0.1` 暴露，未做鉴权（桌面本地应用足够；若需远程接入请自行加 token/隧道）。
- DSH 宿主插件按仓库路径（`link:`）安装，**要求本机已 `make build`**；安装包分发（npm / 市场）尚未配置。
- 插件日志写到 `<DSH_HOME>/kanbanniang/plugin.log`：桌面端 DSH 不落盘宿主插件 stdout，排查请优先看该文件。
- Windows 为主要验证平台；macOS / Linux 的自动拉起路径（可执行文件名）未做适配。
- 可扩展方向：点击交互、动作队列、把「前端状态」做成可订阅的资源（MCP resources）。（拖拽窗口、多模型切换已完成）
