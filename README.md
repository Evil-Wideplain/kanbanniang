# 看板娘 KanbanMascot · Tauri + Live2D + 内置 MCP 服务

一个**桌面看板娘**：用 [Tauri](https://tauri.app/) 做窗口外壳，用 [Live2D Cubism](https://www.live2d.com/)（或降级动画）做角色渲染，并在应用内**直接提供一个 MCP（Model Context Protocol）服务**。任何兼容 MCP 的 Agent（Claude Desktop、CodeBuddy、自定义脚本等）都能连上来，调用工具让看板娘**做动作、换表情、说话、移动、查询状态**。

> 核心价值：**看板娘即工具（tool）**。Agent 不需要理解 Live2D，只要调用 `play_motion` / `speak` / `set_expression` 等 MCP 工具，桌面上的看板娘就会动起来。

---

## 架构

```
┌──────────────────────────────┐         SSE / JSON-RPC
│  Agent (Claude Desktop 等)   │ ───────────────────────────┐
└──────────────────────────────┘                            │
                                                             ▼
                          ┌────────────────────────────────────────────┐
                          │  Tauri 进程 (Rust)                          │
                          │  ┌──────────────────────────────────────┐  │
                          │  │  axum MCP SSE 服务  :7432/mcp/sse     │  │
                          │  │   tools/list · tools/call · initialize│  │
                          │  └───────────────┬──────────────────────┘  │
                          │        emit "mascot:action" (Tauri 事件)   │
                          └───────────────────┬────────────────────────┘
                                              │  Tauri 事件
                                              ▼
                          ┌────────────────────────────────────────────┐
                          │  WebView 前端 (TypeScript)                  │
                          │  Live2D 控制器 ── 或 ── 降级 Canvas 看板娘    │
                          │  dispatcher.ts: 事件 → 控制器方法          │
                          │  emit "mascot:result" (查询型动作回传)        │
                          └────────────────────────────────────────────┘
```

- **传输方式**：MCP 走 **本地 SSE**（`http://127.0.0.1:7432/mcp/sse`），桌面 GUI 程序无法用 stdio 暴露 MCP，SSE 是最自然的本地接入方式。
- **动作链路**：Agent 调用工具 → Rust 端 axum 收到 `tools/call` → 通过 Tauri 事件 `mascot:action` 通知前端 → 前端驱动 Live2D/降级看板娘执行。
- **查询链路**：`list_motions` / `list_expressions` / `get_status` / `set_model` / `list_models` 这类查询型工具，前端执行后通过 `mascot:result` 事件把结果回传，Rust 端用 oneshot 通道等结果（超时 5s）。

---

## 特性

- ✅ 内置 MCP 服务（SSE），Agent 可即连即用
- ✅ 10 个工具：动作 / 表情 / 说话 / 移动 / 待机 / 列动作 / 列表情 / 查状态 / **运行时换模型** / 列模型
- ✅ **无需 Live2D SDK 也能跑**：未配置模型时自动用 Canvas 降级看板娘，MCP 工具链路立刻可验证
- ✅ 真实 Live2D 是"即插即用"升级：放入模型 + 改一行配置即可
- ✅ 透明无边框、置顶窗口，典型的桌面看板娘形态

---

## 前置依赖

1. **Node.js ≥ 18**（前端与 Tauri CLI）。
2. **Rust 工具链**（Tauri 必须）：<https://rustup.rs/>，安装 stable + `windows-msvc` 目标。
3. **Windows 系统依赖**（Tauri v2）：
   - WebView2 Runtime（Win10/11 一般已预装；没有则装 Evergreen 引导器）
   - Microsoft C++ Build Tools / Visual Studio（含「使用 C++ 的桌面开发」）
   - 详见官方指南：<https://v2.tauri.app/start/prerequisites/>
4. （可选，接真实 Live2D 模型）模型文件需自备，官方示例模型在 Live2D Cubism SDK for Web 内 —— 见 `models/README.md`。

> 本仓库的 Rust 端需要你本地有 Rust 才能编译运行；前端 TypeScript 已尽量独立可测。

---

## 快速开始

```bash
# 1. 安装前端依赖
npm install

# 2.（可选）接入真实 Live2D 模型，见 models/README.md
#    不配置也能直接跑「降级看板娘」

# 3. 启动桌面应用（会自动拉起 Vite + 编译 Rust + 打开看板娘窗口）
npm run tauri:dev

# 4. 另开一个终端，验证 MCP 工具链路（需应用已启动）
node cmd/client/test.mjs
```

启动后可看到桌面角落出现一个透明置顶的看板娘；`test.mjs` 会依次调用
`initialize → tools/list → speak → get_status → list_motions → play_motion → set_expression`，
你应该能看到看板娘做出对应反应，且脚本打印出返回结果。

---

## 让 Agent 接入（MCP 客户端配置）

### Claude Desktop（SSE 服务器）

编辑 `claude_desktop_config.json`（位置见 Claude 文档），加入：

```json
{
  "mcpServers": {
    "kanban-mascot": {
      "url": "http://127.0.0.1:7432/mcp/sse"
    }
  }
}
```

重启 Claude Desktop，确认「kanban-mascot」已连接。之后你可以直接对它说：
"让看板娘挥手并说『欢迎回来～』"，它就会调用 `play_motion` + `speak`。

### 任意支持 SSE 的客户端 / 自定义 Agent

只要客户端支持 MCP SSE 传输，指向 `http://127.0.0.1:7432/mcp/sse` 即可。
也可用官方 [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector) 可视化调试。

---

## 工具清单（MCP）

| 工具 | 参数 | 说明 |
|------|------|------|
| `play_motion` | `motion: string`, `index?: number` | 播动作（idle/tap_body/pinch_in/pinch_out/wave/shake…） |
| `set_expression` | `expression: string` | 换表情（neutral/happy/angry/surprised/sad…） |
| `speak` | `text: string` | 说话（显示气泡 + 反馈） |
| `move` | `x: number`, `y: number` | 移动（归一化坐标 0~1） |
| `set_idle` | — | 回到待机 |
| `list_motions` | — | 列出可用动作组 |
| `list_expressions` | — | 列出可用表情 |
| `get_status` | — | 当前状态快照 |
| `set_model` | `model: string` | 运行时切换模型档案（失败自动回滚，原模型不受影响） |
| `list_models` | — | 列出可用模型档案（id / 模式 / 当前使用中） |

> 工具定义的**单一来源**是 [`shared/mcp-tools.json`](./shared/mcp-tools.json)（Rust 与 TS 同源加载）；本表为文档镜像，以清单为准。
> 真实 Live2D 模型可用动作/表情名取决于模型自带的文件；降级模式下是内置的一组示例名。
> `set_model` 成功返回 `{ok:true, model, mode, modelFile}`，失败返回 `{ok:false, error}`（同时 `isError:true`）。

---

## 接入真实 Live2D

见 [`models/README.md`](./models/README.md)：下载 Cubism SDK 或自备模型、放入 `models/`，并在 `src/frontend/core/profiles.ts` 的 `MODEL_PROFILES` 中登记模型档案（含缩放/锚点与语义别名），即可从降级模式切换到真实 Live2D；运行时用 MCP 工具 `set_model` 热切换模型。Cubism Core 运行时已内置于 `src/frontend/core/live2d/`，无需手动获取。

---

## 目录结构

```
pet/
├─ src/                    项目源码根
│  ├─ frontend/            前端（TS，Vite 入口 src/frontend/main.ts）
│  │  ├─ main.ts           入口：装配气泡/模型管理器/事件接线（薄层）
│  │  ├─ ui/bubble.ts      说话气泡（DOM）
│  │  ├─ core/
│  │  │  ├─ dispatcher.ts  MCP 指令 → 控制器方法 分发（含穷尽性检查）
│  │  │  ├─ model-switch.ts 模型生命周期：初始化降级 + 运行时热切换（游离画布/回滚）
│  │  │  ├─ live2d/         Live2D 控制器（index.ts）+ Cubism Core 运行时，pixi 动态加载
│  │  │  ├─ fallback.ts    降级 Canvas 看板娘（无需 SDK）
│  │  │  ├─ profiles.ts    模型档案（MODEL_PROFILES：配置+语义别名，默认 DEFAULT_MODEL_ID）
│  │  │  ├─ speech.ts      说话时长（气泡与口型共用）
│  │  │  └─ types.ts       前后端共用类型 + 动作表（与共享清单运行时互校）
│  │  └─ ipc/events.ts     Tauri 事件通道（mascot:action 进 / mascot:result 出）
│  └─ tauri/               Rust 后端（原 src-tauri，cargo 包根）
│     ├─ Cargo.toml
│     ├─ src/lib.rs        Tauri 入口 + 启动 MCP 服务
│     ├─ src/mcp/mod.rs    axum SSE MCP 服务（传输 + JSON-RPC 协议）
│     ├─ src/mcp/tools.rs  工具清单加载 + tools/call 分发（读 shared/mcp-tools.json）
│     ├─ src/state.rs      共享状态 + 事件发射 + 结果回传（查询型 5s oneshot）
│     ├─ tauri.conf.json   窗口配置（透明/置顶/无边框）
│     └─ capabilities/     权限
├─ shared/mcp-tools.json   MCP 工具清单（Rust/TS 单一来源）
├─ models/                 静态资源根（Vite publicDir）：模型目录 + 接入文档
├─ cmd/
│  └─ client/
│     ├─ client.mjs        共享 SSE/RPC 客户端（pending + 消息队列）
│     ├─ test.mjs          冒烟测试：完整调用一遍工具
│     └─ preview.mjs       动作/表情逐个预览并命名（生成语义别名用）
└─ README.md
```

---

## 已知限制 / 后续可扩展

- Live2D 的「真实口型同步」需接入 AudioEngine + Phoneme，当前 `speak` 仅做气泡与表情反馈。
- 查询型工具依赖前端在线（窗口开着）；若窗口关闭，查询会 5s 超时。
- MCP 目前仅本地 `127.0.0.1` 暴露，未做鉴权（桌面本地应用足够；若需远程接入请自行加 token/隧道）。
- 可扩展方向：点击交互、动作队列、把「前端状态」做成可订阅的资源（MCP resources）。（拖拽窗口、多模型切换已完成）
