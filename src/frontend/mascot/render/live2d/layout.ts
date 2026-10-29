/**
 * Live2D 画布布局纯函数：把「模型该多大」与「模型摆在哪」拆成两套基准。
 *
 * 设计动机：主窗口已从 360x480 放大到 640x800，但角色像素尺寸必须保持不变
 * （多出来的空间留给动作特效）。因此缩放基准固定为设计基准（原窗口 360x480），
 * 而摆放位置仍按实际视口（渲染器）尺寸计算——窗口再大也只增加四周留白。
 *
 * 本文件只做纯计算，不依赖 pixi / DOM，便于单测。
 */

/** 看板娘的设计基准尺寸（原窗口 360x480）：模型始终按该尺寸渲染，窗口变大只增加四周留白。 */
export const MODEL_DESIGN_WIDTH = 360;
export const MODEL_DESIGN_HEIGHT = 480;

/** 气泡底边与角色头顶之间的间隙（CSS 像素）：气泡在小尾巴之外再留一点空。 */
export const BUBBLE_GAP_PX = 12;

/** 布局输入：设计基准（决定缩放）、锚点与实际视口（决定摆放）。 */
export interface ModelFitInput {
  /** 设计基准宽高（模型缩放按它们算，与窗口实际尺寸无关）。 */
  designWidth: number;
  designHeight: number;
  /** 基线锚点（0~1）：脚底落在视口高度 anchorY 处，水平中心在视口宽度 anchorX 处。 */
  anchorX: number;
  anchorY: number;
  /** 整体缩放微调系数（档案 cfg.scale，1 = 恰好贴合设计基准）。 */
  scale?: number;
  /** 模型原始宽度（scale=1 时的像素宽）。 */
  modelWidth: number;
  /** 模型原始高度（scale=1 时的像素高）。 */
  modelHeight: number;
  /** 实际视口（渲染器）宽高：决定摆放位置。 */
  viewWidth: number;
  viewHeight: number;
}

/** 布局结果：模型缩放与画布坐标。 */
export interface ModelFit {
  /** 应用到模型上的缩放值（已含设计基准适配与 cfg.scale 微调）。 */
  scale: number;
  /** 模型 x 坐标（视口宽度 * anchorX）。 */
  x: number;
  /** 模型 y 坐标（脚底基线，视口高度 * anchorY）。 */
  y: number;
  /** 缩放后的模型高度（CSS 像素）：气泡贴头顶、包围盒兜底都用它，避免各处再乘一遍。 */
  fittedHeight: number;
}

/**
 * 计算模型缩放与摆放位置（与原 `layout()` 等价，只把适配基准从窗口改成设计基准）。
 *
 * 适配规则：先按「基线以上的设计可用区域」求缩放，保证头和脚都完整落在设计基准内；
 * cfg.scale 作为整体微调系数（1 = 恰好贴合）。摆放仍用实际视口尺寸，
 * 故视口从 360x480 放大到 640x800 时 scale 不变、只有 x/y 变化。
 */
export function computeModelFit(input: ModelFitInput): ModelFit {
  const { designWidth, designHeight, anchorX, anchorY, scale, viewWidth, viewHeight } = input;
  // 模型尺寸缺省（加载中/空模型）时按 1 处理，避免除零得到 Infinity 缩放把模型缩没
  const modelWidth = input.modelWidth > 0 ? input.modelWidth : 1;
  const modelHeight = input.modelHeight > 0 ? input.modelHeight : 1;

  // 边距按设计基准取 1%（至少 4px），与窗口实际尺寸无关，保证放大窗口后留白不跟着变
  const margin = Math.max(4, Math.round(designHeight * 0.01));
  const footY = viewHeight * anchorY; // 脚底基线（实际视口高度比例）
  const maxH = Math.max(1, designHeight * anchorY - margin); // 基线以上的设计可用高度
  const maxW = Math.max(1, designWidth - margin * 2);
  const fit = Math.min(maxH / modelHeight, maxW / modelWidth) * (scale ?? 1);

  return { scale: fit, x: viewWidth * anchorX, y: footY, fittedHeight: modelHeight * fit };
}

/**
 * 气泡底边距窗口底部的距离（CSS 像素）：气泡贴角色头顶而不是窗口顶部/底部。
 *
 * 由布局结果推导而不是写常量：头顶线 = 脚底基线 − 实际模型高度，
 * 再换算成「距窗口底部」的距离并减去气泡自身高度之外的间隙。
 * 这样窗口高度变化（低分屏收缩）、`move_in_window` 改锚点、换模型都会自动跟随。
 */
export function bubbleBottomPx(
  viewHeight: number,
  anchorY: number,
  fittedHeight: number,
  gapPx: number = BUBBLE_GAP_PX,
): number {
  const safeHeight = Math.max(0, Number.isFinite(viewHeight) ? viewHeight : 0);
  const safeAnchor = Math.min(1, Math.max(0, Number.isFinite(anchorY) ? anchorY : 1));
  const safeModel = Math.max(0, Number.isFinite(fittedHeight) ? fittedHeight : 0);
  const safeGap = Math.max(0, Number.isFinite(gapPx) ? gapPx : BUBBLE_GAP_PX);
  // 头顶线（距窗口顶部）→ 气泡底边（距窗口底部）= 视口高 − 头顶线 + 间隙
  const headTop = safeHeight * safeAnchor - safeModel;
  return Math.min(safeHeight, Math.max(0, safeHeight - headTop + safeGap));
}

/** 可摆放的模型句柄（pixi DisplayObject 的子集，只取布局需要的字段）。 */
export interface LayoutTarget {
  scale: { set(value: number): void };
  anchor: { set(x: number, y: number): void };
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把 `computeModelFit` 的结果应用到模型上：缩放、底部对齐到基线、按视口摆放。
 * 调用方只需提供档案锚点、微调系数与当前渲染器尺寸；返回布局结果（含 `fittedHeight`），
 * 供气泡贴头顶等「需要知道模型实际占多高」的调用方复用。
 */
export function applyModelFit(
  target: LayoutTarget,
  input: Omit<ModelFitInput, "modelWidth" | "modelHeight">,
): ModelFit {
  target.scale.set(1); // 先取模型原始尺寸（scale=1）再算适配
  const fit = computeModelFit({
    ...input,
    modelWidth: target.width,
    modelHeight: target.height,
  });
  target.scale.set(fit.scale);
  target.anchor.set(input.anchorX, 1); // 底部对齐到基线
  target.x = fit.x;
  target.y = fit.y;
  return fit;
}

