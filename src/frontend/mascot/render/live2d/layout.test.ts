/**
 * 画布布局单测：验证「缩放按设计基准 360x480、摆放按实际视口」的拆分。
 * 重点回归：窗口放大到 640x800 后模型缩放必须与 360x480 视口完全相同（角色像素尺寸不变）。
 * 纯计算（不依赖 pixi / DOM）。
 */
import { describe, expect, it } from "vitest";
import {
  applyModelFit,
  BUBBLE_GAP_PX,
  bubbleBottomPx,
  computeModelFit,
  MODEL_DESIGN_HEIGHT,
  MODEL_DESIGN_WIDTH,
  type LayoutTarget,
  type ModelFitInput,
} from "./layout";

/** 构造布局输入：默认按设计基准 360x480 视口、锚点 0.5/0.98、模型 300x1000。 */
function input(over: Partial<ModelFitInput> = {}): ModelFitInput {
  return {
    designWidth: MODEL_DESIGN_WIDTH,
    designHeight: MODEL_DESIGN_HEIGHT,
    anchorX: 0.5,
    anchorY: 0.98,
    modelWidth: 300,
    modelHeight: 1000,
    viewWidth: MODEL_DESIGN_WIDTH,
    viewHeight: MODEL_DESIGN_HEIGHT,
    ...over,
  };
}

describe("布局：设计基准适配", () => {
  // 设计边距 margin = max(4, round(480*0.01)) = 5，基线以上可用高度 480*0.98-5 = 465.4
  it("设计基准 360x480 视口下模型高度贴合基线以上区域", () => {
    const fit = computeModelFit(input());
    expect(fit.scale).toBeCloseTo(465.4 / 1000, 10);
    // 头脚完整：模型顶端距窗口顶 = margin（5px），脚底落在基线
    expect(fit.y - fit.scale * 1000).toBeCloseTo(5, 10);
    expect(fit.y).toBeCloseTo(480 * 0.98, 10);
  });

  it("视口放大到 640x800 时 scale 不变，只移动摆放位置（x=320、y=784）", () => {
    const base = computeModelFit(input());
    const big = computeModelFit(input({ viewWidth: 640, viewHeight: 800 }));
    // 缩放只依赖设计基准与模型尺寸，与视口无关：这是「窗口放大、角色尺寸不变」的核心保证
    expect(big.scale).toBe(base.scale);
    expect(big.x).toBe(320);
    expect(big.y).toBeCloseTo(784, 10);
  });

  it("cfg.scale 作为整体微调系数线性生效", () => {
    const base = computeModelFit(input());
    const half = computeModelFit(input({ scale: 0.5 }));
    const double = computeModelFit(input({ scale: 2 }));
    expect(half.scale).toBeCloseTo(base.scale * 0.5, 10);
    expect(double.scale).toBeCloseTo(base.scale * 2, 10);
    // 微调只影响缩放，不影响摆放坐标
    expect(half.x).toBe(base.x);
    expect(half.y).toBe(base.y);
  });

  it("宽模型在窄视口下按设计宽度适配（缩放仍与视口尺寸无关）", () => {
    // 宽 2000 的模型：宽度上限 360-10=350 → 350/2000 小于高度上限 465.4/100
    const narrow = computeModelFit(
      input({ modelWidth: 2000, modelHeight: 100, viewWidth: 320, viewHeight: 480 }),
    );
    const wide = computeModelFit(
      input({ modelWidth: 2000, modelHeight: 100, viewWidth: 640, viewHeight: 800 }),
    );
    expect(narrow.scale).toBeCloseTo(350 / 2000, 10);
    expect(wide.scale).toBe(narrow.scale);
  });

  it("模型尺寸缺失时按 1 处理，不产生 Infinity 缩放", () => {
    const fit = computeModelFit(input({ modelWidth: 0, modelHeight: 0 }));
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(fit.scale).toBeGreaterThan(0);
  });
});

describe("布局：气泡底边贴角色头顶", () => {
  /** 640x800 视口、锚点 0.98 时的实际模型高度（设计基准限制下的 465.4px）。 */
  const FITTED = computeModelFit(input({ viewWidth: 640, viewHeight: 800 })).fittedHeight;

  it("气泡底边在头顶上方 gap 处（640x800 下约 493px，而非旧常量的 482）", () => {
    const bottom = bubbleBottomPx(800, 0.98, FITTED);
    // 气泡底边（距窗口顶部）= 800 − bottom，应比头顶线（318.6）再高出一个间隙
    const bubbleBottomFromTop = 800 - bottom;
    const headTop = 800 * 0.98 - FITTED;
    expect(bubbleBottomFromTop).toBeCloseTo(headTop - BUBBLE_GAP_PX, 10);
    expect(bottom).toBeCloseTo(493.4, 6);
  });

  it("窗口变矮（低分屏收缩）时气泡跟着头顶下移，间隙保持不变", () => {
    const tall = bubbleBottomPx(800, 0.98, FITTED);
    const short = bubbleBottomPx(728, 0.98, FITTED);
    expect(short).toBeLessThan(tall);
    // 两种视口下气泡底边到头顶的距离都恰好是 gap
    for (const [viewHeight, bottom] of [
      [800, tall],
      [728, short],
    ] as const) {
      const headTop = viewHeight * 0.98 - FITTED;
      expect(viewHeight - bottom).toBeCloseTo(headTop - BUBBLE_GAP_PX, 10);
    }
  });

  it("模型更矮时气泡跟着头顶下移；角色整体上移（锚点变小）时气泡跟着上移", () => {
    // 宽模型按宽度适配、实际更矮 → 头顶更低 → 气泡更靠下（底边距更小）
    expect(bubbleBottomPx(800, 0.98, 200)).toBeLessThan(bubbleBottomPx(800, 0.98, FITTED));
    // 锚点变小 = 脚底基线上移 → 头顶更高 → 气泡更靠上（底边距变大），越界时夹到视口高度
    const raised = bubbleBottomPx(800, 0.6, FITTED);
    expect(raised).toBeGreaterThan(bubbleBottomPx(800, 0.98, FITTED));
    expect(raised).toBeLessThanOrEqual(800);
  });

  it("非法输入不产生 NaN / 负值 / 超出窗口的值", () => {
    for (const bottom of [
      bubbleBottomPx(Number.NaN, 0.98, FITTED),
      bubbleBottomPx(800, Number.NaN, FITTED),
      bubbleBottomPx(800, 0.98, Number.NaN),
      bubbleBottomPx(-10, 2, -5),
    ]) {
      expect(Number.isFinite(bottom)).toBe(true);
      expect(bottom).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(800);
    }
  });
});

describe("布局：应用到模型", () => {
  /** 假模型：只记录 scale/anchor/x/y，够验证施加顺序与基线对齐。 */
  function target(width = 300, height = 1000): LayoutTarget & { applied: number[] } {
    const applied: number[] = [];
    return {
      applied,
      scale: { set: (v: number) => applied.push(v) },
      anchor: { set: () => undefined },
      x: 0,
      y: 0,
      width,
      height,
    };
  }

  it("先按 scale=1 取原始尺寸再施加缩放，x/y 用实际视口", () => {
    const model = target();
    const fit = applyModelFit(model, {
      designWidth: MODEL_DESIGN_WIDTH,
      designHeight: MODEL_DESIGN_HEIGHT,
      anchorX: 0.5,
      anchorY: 0.98,
      viewWidth: 640,
      viewHeight: 800,
    });
    // 第一次 set(1) 取原始尺寸，第二次才是真实缩放
    expect(model.applied[0]).toBe(1);
    expect(model.applied[1]).toBeCloseTo(computeModelFit(input({ viewWidth: 640, viewHeight: 800 })).scale, 10);
    expect(model.x).toBe(320);
    expect(model.y).toBeCloseTo(784, 10);
    // 返回的布局结果带上实际模型高度，气泡底边直接复用它（不再自己乘一遍）
    expect(fit.fittedHeight).toBeCloseTo(1000 * fit.scale, 10);
  });

  it("窗口放大不改变施加的缩放值（角色像素尺寸不变）", () => {
    const small = target();
    const big = target();
    applyModelFit(small, {
      designWidth: MODEL_DESIGN_WIDTH,
      designHeight: MODEL_DESIGN_HEIGHT,
      anchorX: 0.5,
      anchorY: 0.98,
      viewWidth: MODEL_DESIGN_WIDTH,
      viewHeight: MODEL_DESIGN_HEIGHT,
    });
    applyModelFit(big, {
      designWidth: MODEL_DESIGN_WIDTH,
      designHeight: MODEL_DESIGN_HEIGHT,
      anchorX: 0.5,
      anchorY: 0.98,
      viewWidth: 640,
      viewHeight: 800,
    });
    expect(big.applied[1]).toBe(small.applied[1]);
  });
});
