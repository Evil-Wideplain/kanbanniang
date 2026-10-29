/**
 * 命中蒙版来源（渲染层）：从 WebGL 画布回读当前帧的 alpha 并生成命中蒙版。
 *
 * 依赖创建应用时的 `preserveDrawingBuffer: true`——否则 drawImage 读到的是被清空的缓冲。
 * 回读按 `HIT_MASK_REFRESH_MS` 节流（轮廓随动作/呼吸变化，10Hz 近似足够，也避免频繁读 GPU）。
 * 失败处理分两档：前几次失败按较长间隔重试（GPU 上下文瞬时丢失可能自行恢复），
 * 连续失败到上限才永久退化为 null，让上层改用模型包围盒判定——宁可多可点也不让窗口整体失联。
 */
import {
  buildHitMask,
  DEFAULT_HIT_MASK_OPTIONS,
  type HitMask,
  type HitMaskOptions,
} from "./hit-mask";

/** 尺寸提供者：画布 CSS 尺寸（渲染器 screen），未就绪返回 null。 */
export type ViewSizeSource = () => { width: number; height: number } | null;
/** 画布提供者：WebGL 画布元素，未就绪返回 null。 */
export type CanvasSource = () => HTMLCanvasElement | null;

/** 连续失败多少次后永久降级（约为 2s × 3，覆盖上下文瞬时丢失的恢复窗口）。 */
const MAX_CAPTURE_FAILURES = 3;
/** 失败后的重试间隔（毫秒）：比正常刷新慢得多，避免每帧刷屏。 */
const FAILURE_RETRY_MS = 2000;

/** 命中蒙版来源：节流回读 + 失败重试 + 到位后永久降级。 */
export class HitMaskSource {
  private maskCanvas: HTMLCanvasElement | null = null;
  private mask: HitMask | null = null;
  /** 最近一次回读尝试的时间：成功失败都算，保证失败路径也受节流。 */
  private attemptedAt = 0;
  private failures = 0;
  private failed = false;

  constructor(
    private readonly size: ViewSizeSource,
    private readonly canvas: CanvasSource,
    private readonly refreshMs: number,
    private readonly options: Required<HitMaskOptions> = DEFAULT_HIT_MASK_OPTIONS,
  ) {}

  /** 取当前命中蒙版（按间隔节流回读）；尚未就绪或已永久降级时返回 null。 */
  get(): HitMask | null {
    if (this.failed) return null;
    const now = performance.now();
    const interval = this.failures > 0 ? Math.max(this.refreshMs, FAILURE_RETRY_MS) : this.refreshMs;
    if (now - this.attemptedAt < interval) return this.mask;
    const size = this.size();
    const view = this.canvas();
    if (!size || !view || size.width < 1 || size.height < 1) return this.mask;
    this.attemptedAt = now;
    try {
      this.mask = this.capture(view, size);
      this.failures = 0;
    } catch (e) {
      this.failures += 1;
      this.failed = this.failures >= MAX_CAPTURE_FAILURES;
      if (this.failed) {
        console.warn("[mascot] 命中蒙版连续生成失败，永久退化为按模型包围盒判定鼠标穿透:", e);
      } else {
        console.warn("[mascot] 命中蒙版生成失败，稍后重试:", e);
      }
    }
    return this.mask;
  }

  /** 降采样整块画布并生成蒙版（cellPx 网格，alpha 阈值与膨胀由 options 决定）。 */
  private capture(view: HTMLCanvasElement, size: { width: number; height: number }): HitMask {
    const { cellPx, alphaThreshold, expandCells } = this.options;
    const cols = Math.max(1, Math.ceil(size.width / cellPx));
    const rows = Math.max(1, Math.ceil(size.height / cellPx));
    if (!this.maskCanvas) this.maskCanvas = document.createElement("canvas");
    const canvas = this.maskCanvas;
    if (canvas.width !== cols || canvas.height !== rows) {
      canvas.width = cols;
      canvas.height = rows;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d 上下文不可用");
    ctx.clearRect(0, 0, cols, rows);
    // 从 WebGL 画布取当前帧，alpha 原样保留（依赖 preserveDrawingBuffer）
    ctx.drawImage(view, 0, 0, cols, rows);
    const pixels = ctx.getImageData(0, 0, cols, rows).data;
    return buildHitMask(pixels, cols, rows, { cellPx, alphaThreshold, expandCells });
  }
}
