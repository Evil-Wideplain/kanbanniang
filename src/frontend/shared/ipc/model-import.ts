/**
 * 导入模型传输（基础设施层）。
 *
 * 两条通道：
 * - Tauri 命令：`list_imported_models` / `import_models` / `remember_model`（Rust `commands.rs`）；
 * - Tauri 原生拖放事件：`getCurrentWebview().onDragDropEvent`（拿到的是本机绝对路径，
 *   文件夹也可用；`dragDropEnabled` 打开时 WebView 内 HTML5 DnD 被禁用，故必须用它）。
 *
 * 非 Tauri 环境（纯浏览器调试）一律降级：列表回空、命令抛错由调用方提示、拖放订阅返回空函数。
 */
import type { ImportOutcome, ImportedModel } from "@/shared/domain/imported";
import { IMPORTED_ASSET_SCHEME } from "@/shared/domain/imported";
import { registerImportedModels } from "@/shared/domain/profiles";

/**
 * 导入模型资产根地址（基础设施层负责平台差异，领域层只接收结果）。
 * Tauri 自定义协议在 Windows/Android 上是 `http://<scheme>.localhost`，
 * 在 macOS/iOS/Linux 上是 `<scheme>://localhost`。
 */
export function importedAssetOrigin(): string {
  return /Windows/i.test(navigator.userAgent)
    ? `http://${IMPORTED_ASSET_SCHEME}.localhost`
    : `${IMPORTED_ASSET_SCHEME}://localhost`;
}

/**
 * 读取已导入模型；**读取失败返回 `null`**（区别于「确实没有导入模型」的空数组）。
 * 调用方据此决定是否清空已注册档案：一次 IO 抖动不应让导入模型从 UI/MCP 里消失。
 */
export async function listImportedModels(): Promise<ImportedModel[] | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ImportedModel[]>("list_imported_models");
  } catch (e) {
    console.warn("[mascot] 读取导入模型失败（非 Tauri 环境？）：", e);
    return null;
  }
}

/**
 * 载入并注册运行时导入档案。
 * 主窗口启动时调用一次；设置窗口挂载与重新聚焦时各调用一次（窗口常驻）。
 * 返回是否刷新成功：读取失败时保留现有注册表，避免芯片与 MCP 列表被清空。
 */
export async function loadImportedProfiles(): Promise<boolean> {
  const models = await listImportedModels();
  if (!models) {
    console.warn("[mascot] 本次未能读取导入模型列表，保留已有档案");
    return false;
  }
  registerImportedModels(models, importedAssetOrigin());
  if (models.length > 0) {
    console.info("[mascot] 已注册导入模型", { count: models.length });
  }
  return true;
}

/** 导入拖入的路径（文件夹或 .zip）；失败向上抛（由调用方展示原因）。 */
export async function importModelPaths(paths: string[]): Promise<ImportOutcome> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<ImportOutcome>("import_models", { paths });
}

/**
 * 记住当前模型：只更新设置里的 `modelId`（不影响其它设置）；失败仅告警。
 * 这样重启应用后仍加载该模型，且不会覆盖设置窗口期间改过的其它字段。
 */
export async function rememberSelectedModel(modelId: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("remember_model", { modelId });
  } catch (e) {
    console.warn("[mascot] 记住当前模型失败：", e);
  }
}

/** 拖放事件回调（路径为本机绝对路径，可能是文件或文件夹）。 */
export interface ModelDropHandlers {
  /** 文件进入窗口：开始拖拽悬停。 */
  onEnter?(): void;
  /** 拖拽离开窗口或取消。 */
  onLeave?(): void;
  /** 松开：paths 为拖入的文件/文件夹绝对路径。 */
  onDrop(paths: string[]): void;
}

/**
 * 订阅拖放事件，返回取消订阅函数；环境不支持时返回 `null`（调用方据此决定是否宣告「就绪」）。
 * `enter` / `over` 都视为悬停中（over 只带位置，忽略）；`drop` 与 `leave` 结束悬停态。
 */
export async function listenModelDrop(
  handlers: ModelDropHandlers,
): Promise<(() => void) | null> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    return await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") {
        handlers.onEnter?.();
      } else if (payload.type === "leave") {
        handlers.onLeave?.();
      } else if (payload.type === "drop") {
        handlers.onLeave?.();
        handlers.onDrop(payload.paths);
      }
    });
  } catch (e) {
    console.warn("[mascot] 订阅拖放事件失败（非 Tauri 环境？）：", e);
    return null;
  }
}
