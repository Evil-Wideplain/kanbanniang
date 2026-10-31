/**
 * 窗口平滑移动的几何（领域层，纯函数）。
 *
 * 把「工作区归一化坐标」换算成窗口外框的物理像素目标，并把滑行结束后的真实位置
 * 换算回归一化坐标与结果信封。窗口读写（读显示器/位置、写位置、显示窗口）属基础设施，
 * 在 `shared/ipc/window.ts`；本模块不碰 Tauri / DOM，便于用假几何覆盖 DPI 与退化范围。
 *
 * 坐标系：全程物理像素（虚拟屏绝对坐标），原点为当前显示器工作区左上角，
 * 可移动范围 = 工作区 − 窗口外框，保证窗口外框完整落在工作区内（不被任务栏遮挡）。
 */

import type { WindowMoveOutcome } from "./types";

/** 物理像素矩形（虚拟屏绝对坐标）。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 物理像素尺寸。 */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/** 物理像素坐标。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 一次滑行的几何快照（采集一次，供滑行与结果回读共用）。 */
export interface MoveFrame {
  /** 工作区左上角（归一化坐标原点）。 */
  readonly originX: number;
  readonly originY: number;
  /** 外框左上角的可移动范围（工作区 − 窗口外框，恒 ≥ 0）。 */
  readonly rangeX: number;
  readonly rangeY: number;
  /** 目标外框左上角。 */
  readonly targetX: number;
  readonly targetY: number;
  /** 移动前的外框左上角。 */
  readonly startX: number;
  readonly startY: number;
  /** 归一化输入超出 [0,1] 被截断。 */
  readonly clamped: boolean;
}

/** 目标位置输入（归一化坐标，0~1）。 */
export interface MoveInput {
  readonly x: number;
  readonly y: number;
}

/** 换算所需的窗口几何（读取顺序由调用方决定，这里只做计算）。 */
export interface MoveGeometry {
  /** 当前显示器工作区（物理像素，已扣除任务栏）。 */
  readonly workArea: Rect;
  /** 窗口外框尺寸（物理像素）。 */
  readonly outerSize: Size;
  /** 移动前窗口外框左上角（物理像素，虚拟屏绝对坐标）。 */
  readonly start: Point;
}

/**
 * 归一化坐标的轴值收敛：非有限值（NaN / ±Infinity）按中点 0.5 处理，再截断到 [0,1]。
 * `clamped` 只在「截断确实改变了输入」时为 true——非有限值已经按中点兜底，不算截断。
 */
export function sanitizeAxis(value: number): { value: number; clamped: boolean } {
  const finite = Number.isFinite(value) ? value : 0.5;
  const normalized = Math.min(1, Math.max(0, finite));
  return { value: normalized, clamped: normalized !== finite };
}

/**
 * 计算一次滑行的目标像素：把归一化坐标映射到「工作区 − 窗口外框」的可移动范围内。
 * 窗口比工作区还大时范围退化为 0（贴工作区左上角），不会产生负范围。
 */
export function planMove(input: MoveInput, geometry: MoveGeometry): MoveFrame {
  const { workArea, outerSize, start } = geometry;
  const x = sanitizeAxis(input.x);
  const y = sanitizeAxis(input.y);
  const rangeX = Math.max(0, workArea.width - outerSize.width);
  const rangeY = Math.max(0, workArea.height - outerSize.height);
  return {
    originX: workArea.x,
    originY: workArea.y,
    rangeX,
    rangeY,
    targetX: workArea.x + Math.round(rangeX * x.value),
    targetY: workArea.y + Math.round(rangeY * y.value),
    startX: start.x,
    startY: start.y,
    clamped: x.clamped || y.clamped,
  };
}

/** 缓动曲线：smoothstep 缓入缓出（t 截断到 [0,1]）。 */
export function easeAt(t: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * 读回真实最终位置并封装结果信封（不假定目标已达成：被抢占或窗口管理器吸附时以实际值为准）。
 * 可移动范围为 0 时归一化坐标没有意义，统一回 0（与「贴工作区左上角」一致）。
 */
export function readOutcome(
  frame: MoveFrame,
  end: Point,
  superseded: boolean,
): WindowMoveOutcome {
  const normalize = (pixel: number, origin: number, range: number): number => {
    if (range <= 0) return 0;
    return Math.min(1, Math.max(0, (pixel - origin) / range));
  };
  return {
    x: normalize(end.x, frame.originX, frame.rangeX),
    y: normalize(end.y, frame.originY, frame.rangeY),
    physicalX: end.x,
    physicalY: end.y,
    clamped: frame.clamped,
    superseded,
  };
}
