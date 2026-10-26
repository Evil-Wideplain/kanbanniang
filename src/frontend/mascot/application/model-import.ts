/**
 * 拖拽导入模型（应用层用例）。
 *
 * 链路：监听窗口拖放 → 把绝对路径交给后端解析/落盘 → 重新注册导入档案 →
 * 热切换到新模型并记住选择。文件解析、校验与落盘全部在 Rust 侧（`model_store.rs`），
 * 本层只做编排；浮层与气泡由组合根注入，保持与 DOM 解耦。
 */
import type { SetModelOutcome } from "@/shared/domain/types";
import { registerImportedModels } from "@/shared/domain/profiles";
import {
  importedAssetOrigin,
  importModelPaths,
  listenModelDrop,
  loadImportedProfiles,
  rememberSelectedModel,
} from "@/shared/ipc/model-import";

/** 导入用例依赖（组合根注入模型管理器与表现层）。 */
export interface ModelImportDeps {
  /** 请求切换到指定档案（含先建后销的回滚语义）。 */
  setModel(id: string): Promise<SetModelOutcome>;
  /** 展示提示气泡。 */
  showBubble(text: string): void;
  /** 拖拽悬停态（用于显示/隐藏拖放浮层）。 */
  setDropActive(active: boolean): void;
}

/** 安装拖拽导入：订阅原生拖放事件；订阅失败仅告警，不影响应用启动。 */
export async function installModelImport(deps: ModelImportDeps): Promise<void> {
  const unlisten = await listenModelDrop({
    onEnter: () => deps.setDropActive(true),
    onLeave: () => deps.setDropActive(false),
    onDrop: (paths) => {
      deps.setDropActive(false);
      void handleDrop(paths, deps);
    },
  });
  if (!unlisten) {
    // 非 Tauri 环境（或事件权限缺失）：拖放通道不可用，不能谎报「已就绪」
    console.warn("[mascot] 拖拽导入不可用：拖放事件订阅失败");
    return;
  }
  console.info("[mascot] 拖拽导入模型已就绪（.zip 压缩包 / 模型文件夹）");
}

/** 处理一次拖放：导入 → 注册档案 → 切换首个新模型并记住选择。 */
async function handleDrop(paths: string[], deps: ModelImportDeps): Promise<void> {
  if (paths.length === 0) {
    return;
  }
  console.info("[mascot] 收到拖入路径", { count: paths.length });

  const outcome = await importModelPaths(paths).catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[mascot] 模型导入失败", message);
    deps.showBubble(`导入失败：${message}`);
    return null;
  });
  if (!outcome) {
    return;
  }

  if (outcome.models.length === 0) {
    const reason = outcome.errors[0] ?? "未识别到可用的 Live2D 模型";
    console.warn("[mascot] 模型导入未产生可用模型", outcome.errors);
    deps.showBubble(`导入失败：${reason}`);
    return;
  }

  // 先用本次导入结果注册档案：随后 list 刷新失败也不会让新模型变成「未知模型」。
  // 之后再从仓库回读一次，补上「同名覆盖后其它模型是否仍在」等信息。
  registerImportedModels(outcome.models, importedAssetOrigin());
  const refreshed = await loadImportedProfiles();
  if (!refreshed) {
    console.warn("[mascot] 导入后回读模型列表失败，沿用本次导入结果");
  }

  const target = outcome.models[0];
  const failedSuffix =
    outcome.errors.length > 0 ? `；另有 ${outcome.errors.length} 项失败` : "";
  const switched = await deps.setModel(target.id);
  if (!switched.ok) {
    // 文件已落盘，只是本次渲染失败：保留提示，用户可再次切换重试
    console.warn("[mascot] 导入成功但模型加载失败", { id: target.id, error: switched.error });
    if (switched.error.includes("切换进行中")) {
      deps.showBubble(`已导入「${target.name}」，正在切换模型，请稍后再拖一次`);
      return;
    }
    deps.showBubble(`已导入「${target.name}」，但加载失败：${switched.error}${failedSuffix}`);
    return;
  }

  await rememberSelectedModel(target.id);
  const countSuffix = outcome.models.length > 1 ? `（共 ${outcome.models.length} 个）` : "";
  deps.showBubble(`已载入模型「${target.name}」${countSuffix}${failedSuffix}`);
  if (outcome.errors.length > 0) {
    console.warn("[mascot] 部分拖入路径导入失败", outcome.errors);
  }
}
