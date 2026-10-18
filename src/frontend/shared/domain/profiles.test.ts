/**
 * 领域纯函数单测：模型档案注册表（对扫描结果稳健，不假设具体模型数量）。
 */
import { describe, expect, it } from "vitest";
import { getProfile, MODEL_IDS, MODEL_PROFILES, profileMode } from "./profiles";

describe("MODEL_PROFILES", () => {
  it("始终包含降级 Canvas 档案", () => {
    const fallback = getProfile("fallback");
    expect(fallback).toBeDefined();
    expect(profileMode(fallback as NonNullable<typeof fallback>)).toBe("fallback");
  });

  it("id 唯一，且 MODEL_IDS 与档案一致", () => {
    expect(new Set(MODEL_IDS).size).toBe(MODEL_IDS.length);
    expect(MODEL_IDS).toEqual(MODEL_PROFILES.map((p) => p.id));
  });

  it("Live2D 档案的渲染模式为 live2d", () => {
    for (const p of MODEL_PROFILES) {
      expect(profileMode(p)).toBe(p.config ? "live2d" : "fallback");
    }
  });

  it("未知 id 返回 undefined", () => {
    expect(getProfile("__no_such_model__")).toBeUndefined();
  });
});
