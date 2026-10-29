/**
 * pixi 运行时装载（渲染层基础设施）。
 *
 * pixi 与 pixi-live2d-display 不能在模块顶层静态 import：二者都依赖 Cubism Core，
 * 而 Core 是运行期注入的脚本（`core-loader.ts`），静态 import 会在 Core 就绪前求值并失败。
 * 因此统一在这里按需动态 import，并把「必须用 cubism4 子路径入口」等坑位收口一处。
 */
import { loadCubismCore } from "./core-loader";

/** 动作优先级兜底值：对应库的 MotionPriority.FORCE（3），取不到真实枚举时使用。 */
const MOTION_PRIORITY_FORCE_FALLBACK = 3;

/** pixi 运行时句柄：库无类型声明，这里统一用宽松句柄收口，业务侧不再直接摸类型。 */
export interface PixiRuntime {
  /** PIXI 命名空间（Application / Ticker）。 */
  PIXI: any;
  /** pixi-live2d-display 的 Live2DModel 构造器。 */
  Live2DModel: any;
  /** 动作下发优先级（库枚举 FORCE，缺失时回退 3）。 */
  motionPriority: number;
}

/**
 * PIXI.Application 的最小句柄（只声明本仓库实际读到的字段）。
 * 用它替代 `any` 传递应用实例：命中判定要用 `renderer.screen`（CSS 逻辑像素，
 * 与光标坐标同量纲；`width/height` 是设备像素，高分屏下会错位）。
 */
export interface PixiApplicationLike {
  /** 渲染器：`screen` 为 CSS 逻辑像素，`view` 为 WebGL 画布。 */
  renderer: {
    screen: { width: number; height: number };
    view: HTMLCanvasElement;
  };
  /** 舞台：模型挂载点。 */
  stage: { addChild(child: unknown): void };
  /** 释放渲染器（removeView 约定由 `destroyPixiApplication` 统一传 false）。 */
  destroy?: (removeView?: boolean) => void;
}

/**
 * 动态装载 pixi 与 cubism4 运行时：并行加载 pixi / Cubism Core，再加载依赖 Core 的库；
 * 顺手对齐库的两处关键配置（Ticker 注册、表情保持），返回后续建控制器所需的句柄。
 */
export async function loadPixiRuntime(): Promise<PixiRuntime> {
  // Cubism Core 与 pixi 相互独立，并行加载；只有 pixi-live2d-display 依赖 Core，须在其后。
  const [PIXI] = await Promise.all([import("pixi.js"), loadCubismCore()]);
  // 必须用 cubism4 子路径入口：主入口内置的是 Cubism 2 运行时（要求 live2d.min.js），
  // 加载 Cubism 4 模型会直接抛错回退。
  const pixiLive2d = await import("pixi-live2d-display/cubism4");
  const lib = pixiLive2d as any;
  const Live2DModel = lib.Live2DModel;
  // 库默认 preserveExpressionOnMotion=true：动作播放不重置表情，步骤表情才能保留。
  // 显式对齐一次，避免升级后默认值变化导致「刚换的表情立刻被动作抹掉」。
  if (lib.config) lib.config.preserveExpressionOnMotion = true;
  // 注册 Ticker：驱动动作/呼吸/物理的逐帧更新，缺失时模型只会静止
  Live2DModel.registerTicker((PIXI as any).Ticker);
  return {
    PIXI,
    Live2DModel,
    motionPriority: lib.MotionPriority?.FORCE ?? MOTION_PRIORITY_FORCE_FALLBACK,
  };
}

/** 按模型路径加载模型（autoInteract：指针点中 HitAreas 时派发 "hit" 事件）。 */
export async function loadLive2DModel(
  runtime: PixiRuntime,
  modelPath: string,
): Promise<any> {
  return await runtime.Live2DModel.from(modelPath, { autoInteract: true });
}

/** 建 PIXI 应用：画布铺满主窗口（看板娘窗口固定尺寸，无内嵌分栏）。 */
export function createPixiApplication(
  runtime: PixiRuntime,
  canvas: HTMLCanvasElement,
): PixiApplicationLike {
  return new runtime.PIXI.Application({
    view: canvas,
    transparent: true,
    autoStart: true,
    resizeTo: window,
    antialias: true,
    backgroundAlpha: 0,
    // 命中蒙版要回读当前帧的 alpha（drawImage 取样），不清空后台缓冲才能读到内容
    preserveDrawingBuffer: true,
  });
}

/**
 * 释放渲染器：removeView 必须为 false——canvas 节点由切换逻辑整块替换，
 * 这里摘掉节点会让后续 replaceWith 静默失效；失败只记一次告警，不影响后续清理。
 */
export function destroyPixiApplication(app: PixiApplicationLike | null | undefined): void {
  try {
    app?.destroy?.(false);
  } catch (e) {
    console.warn("[mascot] app.destroy 失败:", e);
  }
}

