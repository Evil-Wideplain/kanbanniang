/**
 * 命中蒙版（渲染层纯逻辑）：把画布渲染结果的 alpha 通道降采样成行优先二值网格，
 * 用来判断画布坐标是否落在角色像素上（供「鼠标穿透」开关使用）。
 * 不依赖 pixi / DOM，单测见 hit-mask.test.ts。
 */

/**
 * 命中蒙版缺省参数（唯一来源）：纯逻辑侧与回读侧（`hit-mask-source.ts`）都从这里取，
 * 避免默认值被抄成第二份导致「改一处不生效」。
 */
export const DEFAULT_HIT_MASK_OPTIONS: Required<HitMaskOptions> = {
  /** 单格边长（CSS 像素）：越小越贴合轮廓，越大越省内存与回读成本。 */
  cellPx: 4,
  /** alpha 阈值：低于视为透明，8 能保留发丝与半透明边缘。 */
  alphaThreshold: 8,
  /** 膨胀格数：抵消降采样与动作滞后，避免光标在边缘抖动。 */
  expandCells: 1,
};

/** 命中网格默认单格边长（CSS 像素）：引用自缺省参数，供测试与调用方读同一数值。 */
export const HIT_MASK_DEFAULT_CELL_PX = DEFAULT_HIT_MASK_OPTIONS.cellPx;

/** 命中网格：行优先二值图，坐标原点与画布左上角一致。 */
export interface HitMask {
  cols: number;
  rows: number;
  /** 单格边长（CSS 像素），用于把画布坐标换算成格坐标。 */
  cellPx: number;
  /** 长度 cols*rows，1=可点（角色像素），0=穿透。 */
  cells: Uint8Array;
}

/** 生成命中网格的可选参数（缺省值见各字段说明）。 */
export interface HitMaskOptions {
  /** 单格边长（CSS 像素），缺省 HIT_MASK_DEFAULT_CELL_PX。 */
  cellPx?: number;
  /** alpha 阈值（0~255）：低于视为透明；缺省 8（保留发丝/半透明边缘）。 */
  alphaThreshold?: number;
  /** 膨胀格数（缺省 1）：抵消降采样与动作滞后，避免光标在边缘抖动。 */
  expandCells?: number;
}

/**
 * 由降采样后的 RGBA 像素（长度 cols*rows*4）生成命中网格。
 *
 * 只读每 4 字节中的第 4 个（alpha）与阈值比较；expandCells>0 时按切比雪夫距离
 * （半径 = expandCells，含对角）膨胀，膨胀以副本为源，结果不会二次扩散。
 * 入参非法（尺寸非非负整数、cellPx 非正、像素长度不足）一律抛错，
 * 避免静默产出「看起来正常但实际错误」的掩码。
 */
export function buildHitMask(
  rgba: Uint8Array | Uint8ClampedArray,
  cols: number,
  rows: number,
  options?: HitMaskOptions,
): HitMask {
  if (!Number.isInteger(cols) || cols < 0 || !Number.isInteger(rows) || rows < 0) {
    throw new Error(`[hit-mask] 网格尺寸必须是非负整数，收到 cols=${cols} rows=${rows}`);
  }

  const cellPx = options?.cellPx ?? DEFAULT_HIT_MASK_OPTIONS.cellPx;
  if (!Number.isFinite(cellPx) || cellPx <= 0) {
    throw new Error(`[hit-mask] cellPx 必须是大于 0 的有限数，收到 ${cellPx}`);
  }

  // 阈值与膨胀半径做一次规整：非有限值回落到缺省，其余夹到合法区间。
  const rawThreshold = options?.alphaThreshold ?? DEFAULT_HIT_MASK_OPTIONS.alphaThreshold;
  const alphaThreshold = Number.isFinite(rawThreshold)
    ? Math.min(255, Math.max(0, Math.floor(rawThreshold)))
    : DEFAULT_HIT_MASK_OPTIONS.alphaThreshold;
  const rawExpand = options?.expandCells ?? DEFAULT_HIT_MASK_OPTIONS.expandCells;
  const expandCells = Number.isFinite(rawExpand)
    ? Math.max(0, Math.floor(rawExpand))
    : DEFAULT_HIT_MASK_OPTIONS.expandCells;

  const expectedBytes = cols * rows * 4;
  if (rgba.length < expectedBytes) {
    throw new Error(
      `[hit-mask] RGBA 像素长度不足：期望至少 ${expectedBytes} 字节（${cols}×${rows}×4），实际 ${rgba.length}`,
    );
  }

  const cells = new Uint8Array(cols * rows);
  for (let i = 0; i < cells.length; i += 1) {
    cells[i] = rgba[i * 4 + 3] >= alphaThreshold ? 1 : 0;
  }
  if (expandCells <= 0 || cells.length === 0) {
    return { cols, rows, cellPx, cells };
  }

  // 膨胀：以膨胀前的副本为源逐格扩散，越界行列用夹取后的边界跳过。
  const source = cells.slice();
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (source[row * cols + col] !== 1) continue;
      const rowFrom = Math.max(0, row - expandCells);
      const rowTo = Math.min(rows - 1, row + expandCells);
      const colFrom = Math.max(0, col - expandCells);
      const colTo = Math.min(cols - 1, col + expandCells);
      for (let r = rowFrom; r <= rowTo; r += 1) {
        for (let c = colFrom; c <= colTo; c += 1) {
          cells[r * cols + c] = 1;
        }
      }
    }
  }

  return { cols, rows, cellPx, cells };
}

/**
 * 坐标对应的格索引（行优先）；越界返回 -1（便于测试与排查）。
 *
 * 换算：col = Math.floor(x / cellPx)，row = Math.floor(y / cellPx)；
 * NaN / Infinity / 负数 / 超出画布的坐标都返回 -1，空网格同样返回 -1。
 */
export function cellIndexAt(mask: HitMask, x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  if (mask.cols <= 0 || mask.rows <= 0) return -1;
  if (!Number.isFinite(mask.cellPx) || mask.cellPx <= 0) return -1;

  const col = Math.floor(x / mask.cellPx);
  const row = Math.floor(y / mask.cellPx);
  if (col < 0 || row < 0 || col >= mask.cols || row >= mask.rows) return -1;
  return row * mask.cols + col;
}

/** 画布逻辑坐标（CSS 像素）是否落在角色像素上；非法/越界坐标返回 false。 */
export function hitTestMask(mask: HitMask, x: number, y: number): boolean {
  const index = cellIndexAt(mask, x, y);
  return index >= 0 && mask.cells[index] === 1;
}

/** 命中蒙版摘要：可点格数与可点区域包围盒（CSS 像素，便于和渲染结果对比排查）。 */
export interface HitMaskSummary {
  /** 可点格数。 */
  opaque: number;
  /** 可点区域包围盒 `[left, top, right, bottom]`（CSS 像素）；全透明时为 null。 */
  bboxCss: [number, number, number, number] | null;
}

/** 统计命中蒙版：可点格数与包围盒（诊断日志与「穿透区域与角色错位」排查用，纯函数）。 */
export function summarizeHitMask(mask: HitMask): HitMaskSummary {
  let minCol = mask.cols;
  let maxCol = -1;
  let minRow = mask.rows;
  let maxRow = -1;
  let opaque = 0;
  for (let row = 0; row < mask.rows; row += 1) {
    for (let col = 0; col < mask.cols; col += 1) {
      if (mask.cells[row * mask.cols + col] !== 1) continue;
      opaque += 1;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
    }
  }
  return {
    opaque,
    bboxCss: opaque
      ? [
          minCol * mask.cellPx,
          minRow * mask.cellPx,
          (maxCol + 1) * mask.cellPx,
          (maxRow + 1) * mask.cellPx,
        ]
      : null,
  };
}
