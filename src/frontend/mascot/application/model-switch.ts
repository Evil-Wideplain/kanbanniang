/**
 * 模型管理器（应用层）：默认档案初始化、运行时热切换与回滚。
 * 切换遵循「先建后销、失败天然回滚」：新控制器建好才提交销毁旧的。
 * 只管理 Live2D 模型；初始加载失败时保持「未加载」状态，可由 set_model 重试。
 */
import type { MascotController, SetModelOutcome } from "@/shared/domain/types";
import type { ModelProfile } from "@/shared/domain/profiles";
import { allModelIds, DEFAULT_MODEL_ID, getProfile } from "@/shared/domain/profiles";

/** 模型生命周期：初始化、运行时热切换、当前控制器访问。 */
export interface ModelManager {
  /** 运行时切换模型：游离画布上先建好新控制器，失败保留旧状态（天然回滚）。 */
  setModel(id: string): Promise<SetModelOutcome>;
  /** 当前档案 id；未加载时为空串。 */
  currentModelId(): string;
  /** 当前控制器（未加载时为 null）。 */
  controller(): MascotController | null;
  /** 开关视线跟随：作用于当前控制器并记住，供后续热切换沿用。 */
  setGaze(enabled: boolean): void;
  /** 注入台词出口：作用于当前控制器并记住，热切换后自动挂到新控制器上。 */
  setSpeechSink(sink: (text: string) => void): void;
  /** 注入鼠标穿透出口：作用于当前控制器并记住，热切换后自动挂到新控制器上。 */
  setClickThroughSink(sink: (ignore: boolean) => void): void;
  /** 注入气泡底边出口：作用于当前控制器并记住，热切换后自动挂到新控制器上。 */
  setBubbleBottomSink(sink: (bottomPx: number) => void): void;
}

/** 按档案创建 Live2D 控制器。失败向上抛。 */
async function createController(
  canvas: HTMLCanvasElement,
  profile: ModelProfile,
): Promise<MascotController> {
  const { Live2DMascot } = await import("@/mascot/render/live2d");
  return Live2DMascot.create(canvas, profile);
}

/** 创建模型管理器：按指定档案（默认 `DEFAULT_MODEL_ID`）初始化控制器。 */
export async function createModelManager(
  initialCanvas: HTMLCanvasElement,
  initialModelId: string = DEFAULT_MODEL_ID,
  initialGaze: boolean = true,
): Promise<ModelManager> {
  let controller: MascotController | null = null;
  let currentModelId = "";
  let swapping = false;
  let gazeEnabled = initialGaze;
  /** 台词出口（气泡回调）：记住并在每次热切换后重新挂到新控制器。 */
  let speechSink: ((text: string) => void) | null = null;
  /** 鼠标穿透出口：同样随热切换重新挂到新控制器。 */
  let clickThroughSink: ((ignore: boolean) => void) | null = null;
  /** 气泡底边出口：同样随热切换重新挂到新控制器。 */
  let bubbleBottomSink: ((bottomPx: number) => void) | null = null;

  // 1) 按初始档案初始化控制器（未知/空 id 回退默认档案）
  const profile = getProfile(initialModelId) ?? getProfile(DEFAULT_MODEL_ID);
  if (profile) {
    try {
      controller = await createController(initialCanvas, profile);
      currentModelId = profile.id;
      console.info("[mascot] Live2D 模式已启用:", profile.name);
    } catch (err) {
      // 启动阶段失败不阻断应用：保持未加载状态，之后可用 set_model 重试。
      console.error("[mascot] Live2D 加载失败，看板娘未加载：", err);
    }
  } else {
    console.error("[mascot] 没有可用模型档案（models/ 为空？），看板娘未加载");
  }

  // 暴露到全局，方便手动调试（每次切换后刷新）
  (window as any).__mascot = controller;

  // 应用视线跟随设置到初始控制器
  controller?.setGaze(gazeEnabled);

  // 2) 运行时切换模型：先在游离画布上建好新控制器，
  //    成功才提交；任何一步失败都保留旧状态（天然回滚）。
  async function setModel(id: string): Promise<SetModelOutcome> {
    const from = currentModelId; // 记录切换前档案 id，日志需标识切换前后状态
    const target = getProfile(id);
    /** 失败信封：统一带上当前档案与可用列表。 */
    const fail = (error: string): SetModelOutcome => ({
      ok: false,
      error,
      current: currentModelId,
      available: allModelIds(),
    });
    if (!target) {
      console.warn("[mascot] 模型切换失败（未知模型）", { from, to: id });
      return fail(`未知模型: ${id}（可用: ${allModelIds().join(", ")}）`);
    }
    if (swapping) {
      console.warn("[mascot] 模型切换失败（已有切换进行中）", { from, to: id });
      return fail("已有切换在进行中，请稍后重试");
    }
    if (id === currentModelId) {
      return {
        ok: true,
        model: id,
        mode: "live2d",
        modelFile: target.config.modelFile,
        unchanged: true,
      };
    }

    swapping = true;
    try {
      const oldCanvas = document.getElementById("stage") as HTMLCanvasElement;
      const newCanvas = document.createElement("canvas");
      newCanvas.id = "stage"; // 复用 #stage 的 CSS，保证任何时刻 DOM 里只有一个
      newCanvas.setAttribute("data-tauri-drag-region", ""); // 保住窗口拖拽

      // ① 在游离（未插入 DOM）的新画布上创建新控制器
      let next: MascotController;
      try {
        next = await createController(newCanvas, target);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // 新控制器未建成，旧控制器保持不动：天然回滚，仅记录失败原因
        console.warn("[mascot] 模型切换失败，保留原模型", { from, to: id, error });
        return fail(`加载模型失败: ${error}`);
      }

      // ② 提交：销毁旧控制器 → 原子替换画布 → 切换引用
      try {
        controller?.destroy();
      } catch (e) {
        console.warn("[mascot] 旧控制器销毁失败:", e);
      }
      oldCanvas.replaceWith(newCanvas);
      controller = next;
      currentModelId = target.id;
      // 新控制器沿用当前视线跟随设置、台词出口、鼠标穿透出口与气泡底边出口
      next.setGaze(gazeEnabled);
      if (speechSink) next.setSpeechSink(speechSink);
      if (clickThroughSink) next.setClickThroughSink(clickThroughSink);
      if (bubbleBottomSink) next.setBubbleBottomSink(bubbleBottomSink);
      (window as any).__mascot = controller;
      console.info("[mascot] 模型切换完成", {
        from,
        to: target.id,
      });

      return {
        ok: true,
        model: target.id,
        mode: "live2d",
        modelFile: target.config.modelFile,
      };
    } finally {
      swapping = false;
    }
  }

  return {
    setModel,
    currentModelId: () => currentModelId,
    controller: () => controller,
    setGaze: (enabled: boolean) => {
      gazeEnabled = enabled;
      controller?.setGaze(enabled);
    },
    setSpeechSink: (sink: (text: string) => void) => {
      speechSink = sink;
      controller?.setSpeechSink(sink);
    },
    setClickThroughSink: (sink: (ignore: boolean) => void) => {
      clickThroughSink = sink;
      controller?.setClickThroughSink(sink);
    },
    setBubbleBottomSink: (sink: (bottomPx: number) => void) => {
      bubbleBottomSink = sink;
      controller?.setBubbleBottomSink(sink);
    },
  };
}
