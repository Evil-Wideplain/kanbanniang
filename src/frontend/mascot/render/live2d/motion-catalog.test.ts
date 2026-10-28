/**
 * 渲染层动作目录单测：名称解析、变体序号选择、步骤计划（目标形状、越界告警、相邻避让、透传）。
 * 纯逻辑（不依赖 pixi / DOM），随机性用 vi.spyOn(Math, "random") 固定。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMotionCatalog, planSteps } from "./motion-catalog";

/** 构造测试用目录：默认 3 个组、idle/speak 语义别名、每组 1 个变体。 */
function catalog(
  over: { groups?: string[]; aliases?: Record<string, string>; counts?: Record<string, number> } = {},
) {
  return createMotionCatalog({
    groups: over.groups ?? ["Idle", "TapBody", "m01"],
    aliases: over.aliases ?? { idle: "Idle", speak: "TapBody" },
    countOf: (group) => over.counts?.[group] ?? 1,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("动作目录：名称解析", () => {
  it("命中语义别名与归一化名字时不回退", () => {
    const c = catalog();
    expect(c.resolve("idle")).toEqual({ group: "Idle", fallback: false });
    expect(c.resolve("TAP_BODY")).toEqual({ group: "TapBody", fallback: false });
  });

  it("未命中时回退点触组并标记 fallback", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(catalog().resolve("wave")).toEqual({ group: "TapBody", fallback: true });
  });

  it("没有可用组时返回 null", () => {
    expect(catalog({ groups: [] }).resolve("wave")).toBeNull();
  });

  it("没有点触组时回退到除待机外的任意组", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(catalog({ groups: ["Idle", "m01"] }).resolve("wave")).toEqual({ group: "m01", fallback: true });
  });
});

describe("动作目录：变体序号", () => {
  it("单变体组固定 0；多变体组避开相邻序号", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const c = catalog({ counts: { TapBody: 3 } });
    expect(c.count("Idle")).toBe(1);
    expect(c.count("TapBody")).toBe(3);
    expect(c.randomIndex("TapBody")).toBe(0);
    expect(c.randomIndex("TapBody", 0)).toBe(1);
  });

  it("count 拿不到定义时按 1 处理（至少有可下发序号）", () => {
    expect(catalog().count("不存在的组")).toBe(1);
  });
});

describe("步骤计划", () => {
  it("显式序号合法时原样使用，越界改随机并回传结构化告警", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const plan = planSteps(catalog({ counts: { TapBody: 2 } }), [
      { motion: "TapBody", index: 1 },
      { motion: "TapBody", index: 9 },
    ]);
    expect(plan.steps[0].target).toEqual({ group: "TapBody", index: 1 });
    expect(plan.steps[1].target).toEqual({ group: "TapBody", index: 0 });
    expect(plan.warnings).toEqual([
      { kind: "index-out-of-range", requested: "TapBody", group: "TapBody", index: 9, count: 2 },
    ]);
  });

  it("模型没有可用动作时该步 target 为 null（交给队列跳过并告警）", () => {
    const plan = planSteps(catalog({ groups: [] }), [{ motion: "wave", holdMs: 120 }]);
    expect(plan.steps[0]).toEqual({
      requested: "wave",
      fallback: false,
      target: null,
      holdMs: 120,
      expression: undefined,
      text: undefined,
    });
  });

  it("别名解析后 target 带真实组名与序号，未命中则标记 fallback", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const plan = planSteps(catalog(), [{ motion: "idle" }, { motion: "wave" }]);
    expect(plan.steps[0]).toMatchObject({
      requested: "idle",
      fallback: false,
      target: { group: "Idle", index: 0 },
    });
    expect(plan.steps[1]).toMatchObject({
      requested: "wave",
      fallback: true,
      target: { group: "TapBody", index: 0 },
    });
    expect(plan.warnings).toEqual([]);
  });

  it("相邻同组自动避开同序号（库会把同组同序号当成正在播而拒绝）", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const plan = planSteps(catalog({ counts: { TapBody: 2 } }), [
      { motion: "TapBody" },
      { motion: "TapBody" },
    ]);
    expect(plan.steps[0].target).toEqual({ group: "TapBody", index: 0 });
    expect(plan.steps[1].target).toEqual({ group: "TapBody", index: 1 });
  });

  it("透传 expression / text / holdMs", () => {
    const plan = planSteps(catalog(), [
      { motion: "idle", holdMs: 200, expression: "F01", text: "你好" },
    ]);
    expect(plan.steps[0]).toMatchObject({
      requested: "idle",
      fallback: false,
      target: { group: "Idle", index: 0 },
      holdMs: 200,
      expression: "F01",
      text: "你好",
    });
  });
});
