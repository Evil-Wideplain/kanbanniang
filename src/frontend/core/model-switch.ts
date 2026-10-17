/**
 * 模型管理器（应用层）：默认档案初始化（含静默降级）、运行时热切换与回滚。
 * 切换遵循「先建后销、失败天然回滚」：新控制器建好才提交销毁旧的。
 */
import type { MascotController, SetModelOutcome } from "./types";
import type { ModelProfile } from "./profiles";
import { DEFAULT_MODEL_ID, getProfile, MODEL_IDS, MODEL_PROFILES, profileMode } from "./profiles";
import { FallbackMascot } from "./fallback";

/** 模型生命周期：初始化（含静默降级）、运行时热切换、当前控制器访问。 */
export interface ModelManager {
  /** 运行时切换模型：游离画布上先建好新控制器，失败保留旧状态（天然回滚）。 */
  setModel(id: string): Promise<SetModelOutcome>;
  /** 当前档案 id。 */
  currentModelId(): string;
  /** 当前控制器（分发指令时读取，切换后为新实例）。 */
  controller(): MascotController;
  /** 开关视线跟随：作用于当前控制器并记住，供后续热切换沿用。 */
  setGaze(enabled: boolean): void;
}

/** 按档案创建控制器：Live2D 档案动态加载实现，降级档案直接用 Canvas。失败向上抛。 */
async function createController(
  canvas: HTMLCanvasElement,
  profile: ModelProfile,
): Promise<MascotController> {
  if (!profile.config) return new FallbackMascot(canvas);
  const { Live2DMascot } = await import("./live2d");
  return Live2DMascot.create(canvas, profile);
}

/** 创建模型管理器：按指定档案（默认 `DEFAULT_MODEL_ID`）初始化控制器（失败静默降级到 Canvas）。 */
export async function createModelManager(
  initialCanvas: HTMLCanvasElement,
  initialModelId: string = DEFAULT_MODEL_ID,
  initialGaze: boolean = true,
): Promise<ModelManager> {
  let controller: MascotController;
  let currentModelId = "fallback";
  let swapping = false;
  let gazeEnabled = initialGaze;

  // 1) 按初始档案初始化控制器（未知/空 id 回退默认档案）
  const profile = getProfile(initialModelId) ?? getProfile(DEFAULT_MODEL_ID)!;
  if (profile.config) {
    try {
      controller = await createController(initialCanvas, profile);
      currentModelId = profile.id;
      console.info("[mascot] Live2D 模式已启用:", profile.name);
    } catch (err) {
      // 启动阶段保持"静默降级"（应用总能跑起来）；
      // 显式 set_model 切换则严格回滚，见 setModel。
      console.warn("[mascot] Live2D 加载失败，回退到降级模式：", err);
      controller = new FallbackMascot(initialCanvas);
    }
  } else {
    controller = new FallbackMascot(initialCanvas);
    console.info("[mascot] 降级模式（未配置模型）");
  }

  // 暴露到全局，方便手动调试（每次切换后刷新）
  (window as any).__mascot = controller;

  // 应用视线跟随设置到初始控制器（Live2D 生效；降级为空实现）
  controller.setGaze(gazeEnabled);

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
      available: MODEL_PROFILES.map((p) => p.id),
    });
    if (!target) {
      console.warn("[mascot] 模型切换失败（未知模型）", { from, to: id });
      return fail(`未知模型: ${id}（可用: ${MODEL_IDS.join(", ")}）`);
    }
    if (swapping) {
      console.warn("[mascot] 模型切换失败（已有切换进行中）", { from, to: id });
      return fail("已有切换在进行中，请稍后重试");
    }
    if (id === currentModelId) {
      return {
        ok: true,
        model: id,
        mode: profileMode(target),
        modelFile: target.config?.modelFile ?? null,
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
        controller.destroy();
      } catch (e) {
        console.warn("[mascot] 旧控制器销毁失败:", e);
      }
      oldCanvas.replaceWith(newCanvas);
      controller = next;
      currentModelId = target.id;
      // 新控制器沿用当前视线跟随设置
      next.setGaze(gazeEnabled);
      (window as any).__mascot = controller;
      console.info("[mascot] 模型切换完成", {
        from,
        to: target.id,
        mode: profileMode(target),
      });

      return {
        ok: true,
        model: target.id,
        mode: profileMode(target),
        modelFile: target.config?.modelFile ?? null,
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
      controller.setGaze(enabled);
    },
  };
}
