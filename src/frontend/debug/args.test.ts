/**
 * 调试面板参数纯函数单测：schema → 控件取值 / 默认值、候选值筛选。
 */
import { describe, expect, it } from "vitest";
import { asModelIds, asStringArray, collect, defaultArgs, isNumeric, prefillFor } from "./args";
import type { Field, ToolDef } from "./types";

/** 构造一个假的参数控件（仅需 value 供 collect 读取）。 */
function fakeField(key: string, value: string, numeric: boolean, json = false): Field {
  return { key, el: { value } as HTMLInputElement, numeric, json };
}

/** 构造一个最小工具定义。 */
function tool(props: ToolDef["inputSchema"]["properties"]): ToolDef {
  return { name: "t", description: "", query: false, inputSchema: { properties: props } };
}

describe("isNumeric", () => {
  it("number / integer 为数字型", () => {
    expect(isNumeric({ type: "number" })).toBe(true);
    expect(isNumeric({ type: "integer" })).toBe(true);
    expect(isNumeric({ type: "string" })).toBe(false);
    expect(isNumeric({})).toBe(false);
  });
});

describe("prefillFor", () => {
  it("惯用键给固定值", () => {
    expect(prefillFor({}, "x")).toBe("0.5");
    expect(prefillFor({}, "y")).toBe("0.9");
    expect(prefillFor({}, "text")).toContain("调试面板");
  });

  it("其余取候选首项，无候选为空", () => {
    expect(prefillFor({ motion: ["Wave", "Idle"] }, "motion")).toBe("Wave");
    expect(prefillFor({}, "motion")).toBe("");
  });

  it("steps 预填为合法 JSON 数组（语义名 idle，交给动作目录解析）", () => {
    expect(JSON.parse(prefillFor({}, "steps"))).toEqual([{ motion: "idle" }]);
  });
});

describe("collect", () => {
  it("空值跳过；数值型转 number，其余转 string", () => {
    expect(
      collect([fakeField("x", "0.5", true), fakeField("motion", "", false), fakeField("text", "hi", false)]),
    ).toEqual({ x: 0.5, text: "hi" });
  });

  it("数组型参数按 JSON 解析，非法 JSON 抛错（容错留在调试层）", () => {
    expect(collect([fakeField("steps", '[{"motion":"idle"}]', false, true)])).toEqual({
      steps: [{ motion: "idle" }],
    });
    expect(() => collect([fakeField("steps", "[{motion:", false, true)])).toThrow("不是合法 JSON");
  });
});

describe("defaultArgs", () => {
  it("按预填组装且跳过空值", () => {
    const args = defaultArgs(
      { motion: ["Wave"] },
      tool({ x: { type: "number" }, motion: { type: "string" }, expression: { type: "string" } }),
    );
    expect(args).toEqual({ x: 0.5, motion: "Wave" });
  });

  it("数组型参数解析成数组（不是 JSON 字符串）", () => {
    const args = defaultArgs({}, tool({ steps: { type: "array" } }));
    expect(Array.isArray(args.steps)).toBe(true);
    expect(args.steps).toEqual([{ motion: "idle" }]);
  });
});

describe("asStringArray", () => {
  it("仅保留字符串项", () => {
    expect(asStringArray([1, "a", true, "b"])).toEqual(["a", "b"]);
    expect(asStringArray("nope")).toEqual([]);
  });
});

describe("asModelIds", () => {
  it("从 { models: [{id}] } 中筛出字符串 id", () => {
    expect(asModelIds({ models: [{ id: "haru" }, { id: 2 }, { noid: true }] })).toEqual(["haru"]);
  });

  it("结构不符返回空数组", () => {
    expect(asModelIds(null)).toEqual([]);
    expect(asModelIds({})).toEqual([]);
    expect(asModelIds({ models: "x" })).toEqual([]);
  });
});
