/**
 * 领域纯函数单测：模型档案注册表（对扫描结果稳健，不假设具体模型数量）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID, getProfile, MODEL_IDS, MODEL_PROFILES } from "./profiles";

describe("MODEL_PROFILES", () => {
  it("不再包含降级 Canvas 档案", () => {
    expect(getProfile("fallback")).toBeUndefined();
    expect(MODEL_IDS).not.toContain("fallback");
  });

  it("id 唯一，且 MODEL_IDS 与档案一致", () => {
    expect(new Set(MODEL_IDS).size).toBe(MODEL_IDS.length);
    expect(MODEL_IDS).toEqual(MODEL_PROFILES.map((p) => p.id));
  });

  it("每个档案都配置了真实 Live2D 模型", () => {
    for (const p of MODEL_PROFILES) {
      expect(p.config.modelDir).not.toBe("");
      expect(p.config.modelFile.endsWith(".model3.json")).toBe(true);
    }
  });

  it("默认档案是首个模型；没有模型时为空串", () => {
    expect(DEFAULT_MODEL_ID).toBe(MODEL_PROFILES[0]?.id ?? "");
  });

  it("未知 id 返回 undefined", () => {
    expect(getProfile("__no_such_model__")).toBeUndefined();
  });
});
