/**
 * 领域纯函数单测：窗口平滑移动的几何换算（原 Rust `commands.rs::move_window`）。
 * 覆盖归一化截断、非有限值兜底、退化范围（窗口比工作区大）与结果回读。
 */
import { describe, expect, it } from "vitest";
import { easeAt, planMove, readOutcome, sanitizeAxis, type MoveFrame } from "./window-move";

/** 常见工作区：1920x1040（1080p 扣掉任务栏），窗口 640x800。 */
const GEOMETRY = {
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  outerSize: { width: 640, height: 800 },
  start: { x: 640, y: 120 },
};

describe("sanitizeAxis", () => {
  it("[0,1] 内原样返回且不标记截断", () => {
    expect(sanitizeAxis(0)).toEqual({ value: 0, clamped: false });
    expect(sanitizeAxis(0.5)).toEqual({ value: 0.5, clamped: false });
    expect(sanitizeAxis(1)).toEqual({ value: 1, clamped: false });
  });

  it("越界截断并标记 clamped", () => {
    expect(sanitizeAxis(-0.5)).toEqual({ value: 0, clamped: true });
    expect(sanitizeAxis(2)).toEqual({ value: 1, clamped: true });
  });

  it("非有限值按中点兜底，不算截断", () => {
    expect(sanitizeAxis(Number.NaN)).toEqual({ value: 0.5, clamped: false });
    expect(sanitizeAxis(Number.POSITIVE_INFINITY)).toEqual({ value: 0.5, clamped: false });
  });
});

describe("planMove", () => {
  it("把归一化坐标映射到「工作区 − 外框」范围", () => {
    const frame = planMove({ x: 0, y: 0 }, GEOMETRY);
    expect(frame).toMatchObject({
      originX: 0,
      originY: 0,
      rangeX: 1280, // 1920 - 640
      rangeY: 240, // 1040 - 800
      targetX: 0,
      targetY: 0,
      startX: 640,
      startY: 120,
      clamped: false,
    });
    expect(planMove({ x: 1, y: 1 }, GEOMETRY)).toMatchObject({ targetX: 1280, targetY: 240 });
    expect(planMove({ x: 0.5, y: 0.5 }, GEOMETRY)).toMatchObject({ targetX: 640, targetY: 120 });
  });

  it("工作区原点非 0 时目标坐标加原点偏移", () => {
    const frame = planMove(
      { x: 1, y: 1 },
      { ...GEOMETRY, workArea: { x: -1920, y: 200, width: 1920, height: 1040 } },
    );
    expect(frame.targetX).toBe(-1920 + 1280);
    expect(frame.targetY).toBe(200 + 240);
    expect(frame.originX).toBe(-1920);
  });

  it("窗口比工作区大时范围退化 0（贴工作区左上角）", () => {
    const frame = planMove(
      { x: 1, y: 1 },
      { workArea: { x: 100, y: 50, width: 400, height: 300 }, outerSize: { width: 640, height: 800 }, start: { x: 0, y: 0 } },
    );
    expect(frame.rangeX).toBe(0);
    expect(frame.rangeY).toBe(0);
    expect(frame.targetX).toBe(100);
    expect(frame.targetY).toBe(50);
  });

  it("任一轴越界即标记 clamped", () => {
    expect(planMove({ x: 1.5, y: 0.5 }, GEOMETRY).clamped).toBe(true);
    expect(planMove({ x: 0.5, y: -1 }, GEOMETRY).clamped).toBe(true);
    expect(planMove({ x: 0.5, y: 0.5 }, GEOMETRY).clamped).toBe(false);
  });
});

describe("easeAt", () => {
  it("端点固定为 0 / 1，中点 0.5", () => {
    expect(easeAt(0)).toBe(0);
    expect(easeAt(0.5)).toBe(0.5);
    expect(easeAt(1)).toBe(1);
  });

  it("越界与非有限值被截断", () => {
    expect(easeAt(-1)).toBe(0);
    expect(easeAt(2)).toBe(1);
    expect(easeAt(Number.NaN)).toBe(0);
  });
});

describe("readOutcome", () => {
  const frame: MoveFrame = {
    originX: 0,
    originY: 0,
    rangeX: 1280,
    rangeY: 240,
    targetX: 1280,
    targetY: 240,
    startX: 640,
    startY: 120,
    clamped: false,
  };

  it("按真实终点换算归一化坐标（用于被抢占 / 被窗口管理器吸附）", () => {
    expect(readOutcome(frame, { x: 640, y: 120 }, true)).toMatchObject({
      x: 0.5,
      y: 0.5,
      physicalX: 640,
      physicalY: 120,
      superseded: true,
    });
  });

  it("终点越界时归一化坐标截断到 [0,1]", () => {
    expect(readOutcome(frame, { x: 9999, y: -50 }, false)).toMatchObject({ x: 1, y: 0 });
  });

  it("范围为 0 时归一化坐标回 0", () => {
    const degenerate: MoveFrame = { ...frame, rangeX: 0, rangeY: 0, originX: 100, originY: 50 };
    expect(readOutcome(degenerate, { x: 100, y: 50 }, false)).toMatchObject({ x: 0, y: 0 });
  });
});
