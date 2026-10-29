/**
 * 角色像素命中判定（渲染层）：命中蒙版优先，蒙版不可用时回退模型包围盒。
 *
 * 单独成模块的原因：蒙版回读的节流/失败降级/一次性诊断日志，与「光标 → 穿透」
 * 的时序状态机（`interaction.ts`）是两件独立的事——拆开后各自都能单独推理，
 * `interaction.ts` 只负责喂坐标、下发后端。
 */
import { hitTestMask, summarizeHitMask, type HitMask } from "./hit-mask";
import { HitMaskSource } from "./hit-mask-source";

/** 命中蒙版刷新间隔（毫秒）：轮廓随动作/呼吸变化，10Hz 近似足够，且避免频繁回读 GPU。 */
const HIT_MASK_REFRESH_MS = 100;

/** 画布内的矩形（模型包围盒）。 */
export interface InteractionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 命中判定依赖：画布、渲染器尺寸（CSS 像素）与模型包围盒。 */
export interface HitTesterDeps {
  /** 当前 WebGL 画布；未就绪返回 null。 */
  canvas: () => HTMLCanvasElement | null;
  /** 渲染器尺寸（CSS 像素）；未就绪返回 null。 */
  viewSize: () => { width: number; height: number } | null;
  /** 模型包围盒：命中蒙版不可用时的兜底；未就绪返回 null。 */
  bounds: () => InteractionBounds | null;
}

/** 命中判定器：懒生成命中蒙版并做一次性诊断，蒙版永久失败后退化为包围盒。 */
export class MascotHitTester {
  private masks: HitMaskSource;
  /** 首次生成蒙版时记一次诊断日志（网格规模 + 可点包围盒），之后不再刷屏。 */
  private logged = false;

  constructor(private deps: HitTesterDeps) {
    this.masks = new HitMaskSource(deps.viewSize, deps.canvas, HIT_MASK_REFRESH_MS);
  }

  /** 画布逻辑坐标是否落在角色像素上（空白处为 false → 开启鼠标穿透）。 */
  test(x: number, y: number): boolean {
    const mask = this.masks.get();
    if (mask) {
      this.logOnce(mask);
      return hitTestMask(mask, x, y);
    }
    // 掩码不可用时的兜底：模型包围盒内视为角色（少穿透一点，别让窗口整体点不到）
    const bounds = this.deps.bounds();
    return bounds
      ? x >= bounds.x &&
          x <= bounds.x + bounds.width &&
          y >= bounds.y &&
          y <= bounds.y + bounds.height
      : false;
  }

  /** 首次生成蒙版时记一次诊断信息，用于排查「穿透区域与角色对不上」。 */
  private logOnce(mask: HitMask): void {
    if (this.logged) return;
    this.logged = true;
    const { width, height } = this.deps.viewSize() ?? { width: 0, height: 0 };
    const { opaque, bboxCss } = summarizeHitMask(mask);
    console.info("[mascot] 命中蒙版已生成", {
      grid: [mask.cols, mask.rows],
      cellPx: mask.cellPx,
      opaque,
      bboxCss,
      view: [width, height],
      canvas: [this.deps.canvas()?.width ?? 0, this.deps.canvas()?.height ?? 0],
    });
  }
}
