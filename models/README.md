# 接入真实 Live2D 模型

降级看板娘（纯 Canvas）无需任何额外文件即可运行。要换成**真实 Live2D 角色**，按下面两步操作。

> Cubism Core 运行时 `live2dcubismcore.min.js` 已内置于 `src/frontend/mascot/render/live2d/` 并随仓库提交，
> 由 Vite 打包进构建产物，无需手动获取。

## 1. 放入模型文件

1. 用官方 SDK 的示例模型，或自己导出的模型（需 Cubism 3/4 的 `*.model3.json` 及其配套 `motions/`、`expressions/` 目录）。
   - 官方示例模型在 **Cubism SDK for Web**（<https://www.live2d.com/sdk/download/>，需同意许可协议）解压后的 `Samples/Resources/` 下（如 `Hiyori`、`Haru`、`Shizuku`）。
2. 把整个模型目录放到本仓库的 `models/<模型名>/`，例如：
   ```
   models/Hiyori/
     ├─ Hiyori.model3.json
     ├─ Hiyori.physics3.json
     ├─ motions/
     └─ expressions/
   ```
   - `models/` 整体经 Vite `publicDir` 作为静态资源根：`models/Haru/…` 会以 `/Haru/…` 提供。
   - 注意：示例模型与 SDK 同属 Live2D 开放许可，可用于学习；商用请遵循 Live2D 许可。

## 2. 登记模型档案

编辑 `src/frontend/shared/domain/profiles.ts`，在 `MODEL_PROFILES` 中登记一条档案：

```ts
export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: "haru",                       // MCP set_model 使用的 id
    name: "Haru",
    config: {
      modelDir: "Haru",            // models/ 下的子目录（映射为根路径 /Haru）
      modelFile: "Haru.model3.json",
      scale: 1,                       // 相对自动适配的微调（1=恰好贴合）
      anchorX: 0.5,
      anchorY: 0.98,                  // 脚底基线（0~1）
    },
    // 语义别名（可选，见下节）
    motionAliases: { idle: "Idle", speak: "TapBody" },
  },
  // …更多档案…
];

export const DEFAULT_MODEL_ID = "haru"; // 启动时加载
```

窗口尺寸变化、模型高矮胖瘦都由 `layout()` 按模型包围盒**自动适配**（保证头脚不出界），
`scale` 只是最后的整体微调系数。

## 3. 语义别名（不同模型动作/表情名不同）

模型的动作组名和表情名由作者随意命名：官方系多为 `Idle`/`TapBody`，表情可能是
`F01..F08`；另一些模型可能叫 `standby`/`flick_head`/`Smile`。为了让 Agent 用
**同一套调用名**操作任意模型，档案支持两类别名（键会归一化，忽略大小写与下划线）：

| 语义调用名 | 说明 | 例：Haru | 例：Natori |
|---|---|---|---|
| `idle` | 待机 | `Idle` | `Idle` |
| `speak` | 说话/点触类动作 | `TapBody` | `TapBody` |
| `neutral` | 默认表情（Live2D 下不配则用无参重置） | 不配 → 自动重置 | `Normal` |
| `happy` / `angry` … | 语义表情 | 可手工映射到 `F0x` | `Smile` / `Angry` |

**发现真实名字**：MCP 调用 `list_motions` / `list_expressions`，
或直接读 `models/<名>/*.model3.json` 的 `FileReferences.Motions`（组名）
与 `FileReferences.Expressions`（`Name` 字段）。

**批量命名**：应用运行时在仓库根跑 `node cmd/client/preview.mjs`（参数：间隔秒数、`motions|expressions|all`），
逐个播放动作/表情并让你在终端输入语义名（回车跳过、`r` 重播、`q` 结束），
结果存 `cmd/client/preview-result.json`，按上表转写成档案别名即可。

## 4. 运行时切换模型（MCP）

无需重启应用，Agent 直接调用：

```
list_models              → 可用档案：id / 模式 / 当前使用中
set_model {"model":"natori"}  → {ok:true, model, mode, modelFile}
set_model {"model":"fallback"} → 切到降级 Canvas 模式
```

- **失败自动回滚**：新模型加载失败时原模型原封不动，返回 `{ok:false, error}`；
- 切换会重置表情与位置（跨模型名字不同，正是别名存在的意义）；
- 同 id 重复切换返回 `{ok:true, unchanged:true}`，不会重复加载。

## 5. 排查

- 控制台报「无法加载 Cubism Core」→ 检查 `src/frontend/mascot/render/live2d/live2dcubismcore.min.js` 是否存在（该文件应随仓库提交）。
- 报 404 找不到模型 → 检查 `modelDir`/`modelFile` 是否匹配 `models/...` 实际路径。
- 模型加载失败会自动回退到降级看板娘，并在控制台给出警告，不会 crash。
- `set_model` 切换失败会**保留原模型**（回滚），失败原因在 MCP 返回的 `{ok:false,error}` 中。

> 小贴士：`npm run dev`（纯浏览器）也能预览前端，但 MCP 事件通道只有在 Tauri 运行时才生效；调试模型渲染可用 `npm run dev`，调试 Agent 调用请用 `npm run tauri:dev`。
