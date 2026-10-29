/**
 * 命中蒙版单测：alpha 阈值降采样、膨胀（含对角、不越界）、坐标换算、非法/越界坐标与防御性抛错。
 * 纯逻辑（不依赖 pixi / DOM），RGBA 缓冲由本地辅助函数构造。
 */
import { describe, expect, it } from "vitest";
import {
  HIT_MASK_DEFAULT_CELL_PX,
  buildHitMask,
  cellIndexAt,
  hitTestMask,
  type HitMask,
} from "./hit-mask";

/** 造一块 cols×rows 的 RGBA 缓冲：按给定 alpha 列表逐格写入，RGB 恒为 0。 */
function rgbaGrid(cols: number, rows: number, alphas: number[] = []): Uint8Array {
  const buffer = new Uint8Array(cols * rows * 4);
  alphas.forEach((alpha, index) => {
    buffer[index * 4 + 3] = alpha;
  });
  return buffer;
}

/** 只让行优先第 index 格不透明的 RGBA 缓冲。 */
function rgbaSingle(cols: number, rows: number, index: number, alpha = 255): Uint8Array {
  const alphas = new Array<number>(cols * rows).fill(0);
  alphas[index] = alpha;
  return rgbaGrid(cols, rows, alphas);
}

describe("命中蒙版：alpha 阈值降采样", () => {
  it("全透明网格任意点都不可点", () => {
    const mask = buildHitMask(rgbaGrid(4, 4), 4, 4);
    expect(hitTestMask(mask, 0, 0)).toBe(false);
    expect(hitTestMask(mask, 8, 8)).toBe(false);
    expect(hitTestMask(mask, 15.9, 15.9)).toBe(false);
  });

  it("单格不透明时格内可点（含右/下边界内侧），相邻格穿透", () => {
    // 3×3 网格、格 (1,1) 不透明；expandCells=0 才能验证「相邻格不可点」。
    const mask = buildHitMask(rgbaSingle(3, 3, 4), 3, 3, { cellPx: 4, expandCells: 0 });
    expect(mask.cellPx).toBe(4);
    expect(hitTestMask(mask, 4, 4)).toBe(true);
    expect(hitTestMask(mask, 7.99, 7.99)).toBe(true);
    expect(hitTestMask(mask, 4, 7.99)).toBe(true);
    expect(hitTestMask(mask, 3.99, 4)).toBe(false);
    expect(hitTestMask(mask, 4, 3.99)).toBe(false);
    expect(hitTestMask(mask, 8, 8)).toBe(false);
  });

  it("阈值边界：alpha=7 视为透明、alpha=8 可点（缺省阈值 8）", () => {
    const make = (alpha: number): HitMask => buildHitMask(rgbaSingle(3, 3, 4, alpha), 3, 3, { cellPx: 4 });
    expect(hitTestMask(make(7), 6, 6)).toBe(false);
    expect(hitTestMask(make(8), 6, 6)).toBe(true);
    expect(hitTestMask(make(255), 6, 6)).toBe(true);
  });

  it("只读 alpha 通道：RGB 有值但 alpha 为 0 时仍算透明", () => {
    const buffer = new Uint8Array(3 * 3 * 4).fill(255);
    for (let i = 0; i < 9; i += 1) buffer[i * 4 + 3] = 0;
    const mask = buildHitMask(buffer, 3, 3, { cellPx: 4 });
    expect(hitTestMask(mask, 6, 6)).toBe(false);
  });

  it("自定义阈值与缺省常量生效", () => {
    expect(HIT_MASK_DEFAULT_CELL_PX).toBe(4);
    const buffer = rgbaSingle(2, 2, 0, 100);
    const low = buildHitMask(buffer, 2, 2, { alphaThreshold: 200 });
    const high = buildHitMask(buffer, 2, 2, { alphaThreshold: 50 });
    expect(hitTestMask(low, 0, 0)).toBe(false);
    expect(hitTestMask(high, 0, 0)).toBe(true);
    expect(buildHitMask(buffer, 2, 2).cellPx).toBe(HIT_MASK_DEFAULT_CELL_PX);
    expect(buildHitMask(buffer, 2, 2).cells).toBeInstanceOf(Uint8Array);
  });
});

describe("命中蒙版：膨胀", () => {
  it("expandCells=1 时四周与对角邻格都可点", () => {
    // 5×5 网格、格 (2,2) 不透明：膨胀后 (1..3, 1..3) 九格全可点。
    const mask = buildHitMask(rgbaSingle(5, 5, 12), 5, 5, { cellPx: 4, expandCells: 1 });
    for (let row = 1; row <= 3; row += 1) {
      for (let col = 1; col <= 3; col += 1) {
        expect(hitTestMask(mask, col * 4 + 0.5, row * 4 + 0.5)).toBe(true);
      }
    }
    expect(hitTestMask(mask, 0.5, 0.5)).toBe(false);
    expect(hitTestMask(mask, 4 * 4 + 0.5, 2 * 4 + 0.5)).toBe(false);
    expect(hitTestMask(mask, 2 * 4 + 0.5, 0.5)).toBe(false);
  });

  it("expandCells=0 时邻格不可点，只有原格可点", () => {
    const mask = buildHitMask(rgbaSingle(5, 5, 12), 5, 5, { cellPx: 4, expandCells: 0 });
    expect(hitTestMask(mask, 2 * 4 + 0.5, 2 * 4 + 0.5)).toBe(true);
    expect(hitTestMask(mask, 1 * 4 + 0.5, 1 * 4 + 0.5)).toBe(false);
    expect(hitTestMask(mask, 3 * 4 + 0.5, 2 * 4 + 0.5)).toBe(false);
  });

  it("膨胀不越界：四个角与超大半径都不报错且不改变网格大小", () => {
    const corners = [
      { cols: 3, rows: 3, index: 0 },
      { cols: 3, rows: 3, index: 2 },
      { cols: 3, rows: 3, index: 6 },
      { cols: 3, rows: 3, index: 8 },
    ];
    for (const corner of corners) {
      const mask = buildHitMask(rgbaSingle(corner.cols, corner.rows, corner.index), corner.cols, corner.rows, {
        cellPx: 4,
        expandCells: 2,
      });
      expect(mask.cells).toHaveLength(corner.cols * corner.rows);
      expect(hitTestMask(mask, 0.5, 0.5)).toBe(true);
      expect(hitTestMask(mask, 2 * 4 + 0.5, 2 * 4 + 0.5)).toBe(true);
    }
    // 半径远大于网格时只填满网格，不产生越界写入或长度变化。
    const tiny = buildHitMask(rgbaSingle(1, 1, 0), 1, 1, { cellPx: 4, expandCells: 99 });
    expect(tiny.cells).toHaveLength(1);
    expect(hitTestMask(tiny, 0.5, 0.5)).toBe(true);
  });

  it("膨胀结果不参与二次膨胀（只按原始可点格扩散）", () => {
    // 两格间距 3 的单像素：expandCells=1 时中间格不应被连锁填满。
    const cols = 5;
    const rows = 1;
    const buffer = rgbaGrid(cols, rows, [255, 0, 0, 0, 255]);
    const mask = buildHitMask(buffer, cols, rows, { cellPx: 4, expandCells: 1 });
    expect(hitTestMask(mask, 0.5, 0.5)).toBe(true);
    expect(hitTestMask(mask, 4 * 1 + 0.5, 0.5)).toBe(true);
    expect(hitTestMask(mask, 4 * 2 + 0.5, 0.5)).toBe(false);
    expect(hitTestMask(mask, 4 * 3 + 0.5, 0.5)).toBe(true);
    expect(hitTestMask(mask, 4 * 4 + 0.5, 0.5)).toBe(true);
  });
});

describe("命中蒙版：坐标换算", () => {
  it("cellPx=4 时按 floor(x/cellPx) 换格（x=0 / 3.99 → 格 0，x=4 → 格 1）", () => {
    const mask = buildHitMask(rgbaGrid(3, 2), 3, 2, { cellPx: 4 });
    expect(cellIndexAt(mask, 0, 0)).toBe(0);
    expect(cellIndexAt(mask, 3.99, 0)).toBe(0);
    expect(cellIndexAt(mask, 4, 0)).toBe(1);
    expect(cellIndexAt(mask, 7.99, 3.99)).toBe(1);
    expect(cellIndexAt(mask, 0, 4)).toBe(3);
    expect(cellIndexAt(mask, 8, 4)).toBe(5);
  });

  it("越界坐标返回 -1（右/下边界外与负坐标）", () => {
    const mask = buildHitMask(rgbaGrid(3, 2), 3, 2, { cellPx: 4 });
    expect(cellIndexAt(mask, 12, 0)).toBe(-1);
    expect(cellIndexAt(mask, 0, 8)).toBe(-1);
    expect(cellIndexAt(mask, -0.01, 0)).toBe(-1);
    expect(cellIndexAt(mask, 0, -4)).toBe(-1);
  });
});

describe("命中蒙版：非法输入", () => {
  it("NaN / Infinity / 负数 / 超出画布 → false", () => {
    const mask = buildHitMask(rgbaSingle(2, 2, 0), 2, 2, { cellPx: 4 });
    expect(hitTestMask(mask, Number.NaN, 0)).toBe(false);
    expect(hitTestMask(mask, 0, Number.NaN)).toBe(false);
    expect(hitTestMask(mask, Number.POSITIVE_INFINITY, 0)).toBe(false);
    expect(hitTestMask(mask, Number.NEGATIVE_INFINITY, 0)).toBe(false);
    expect(hitTestMask(mask, -1, 0)).toBe(false);
    expect(hitTestMask(mask, 0, -1)).toBe(false);
    expect(hitTestMask(mask, 8, 0)).toBe(false);
    expect(hitTestMask(mask, 0, 8)).toBe(false);
  });

  it("空网格（cols 或 rows 为 0）不崩，任何坐标都不可点", () => {
    const zeroCols = buildHitMask(new Uint8Array(0), 0, 3);
    const zeroRows = buildHitMask(new Uint8Array(0), 3, 0);
    for (const mask of [zeroCols, zeroRows]) {
      expect(mask.cells).toHaveLength(0);
      expect(hitTestMask(mask, 0, 0)).toBe(false);
      expect(cellIndexAt(mask, 0, 0)).toBe(-1);
    }
  });

  it("rgba 长度不足时抛中文 Error，不静默产出错误掩码", () => {
    expect(() => buildHitMask(new Uint8Array(3), 2, 2)).toThrow(/\[hit-mask\] RGBA 像素长度不足/);
    expect(() => buildHitMask(new Uint8Array(15), 2, 2)).toThrow(Error);
  });

  it("尺寸或 cellPx 非法时抛中文 Error", () => {
    expect(() => buildHitMask(new Uint8Array(0), -1, 2)).toThrow(/网格尺寸/);
    expect(() => buildHitMask(new Uint8Array(0), 1.5, 2)).toThrow(/网格尺寸/);
    expect(() => buildHitMask(new Uint8Array(16), 2, 2, { cellPx: 0 })).toThrow(/cellPx/);
    expect(() => buildHitMask(new Uint8Array(16), 2, 2, { cellPx: Number.NaN })).toThrow(/cellPx/);
  });
});
