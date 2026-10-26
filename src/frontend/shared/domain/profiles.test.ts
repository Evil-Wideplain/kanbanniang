/**
 * 领域纯函数单测：模型档案注册表（对扫描结果稳健，不假设具体模型数量）。
 * 含运行时导入档案的注册/替换/清空语义。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ImportedModel } from "./imported";
import {
  allModelIds,
  allProfiles,
  DEFAULT_MODEL_ID,
  getProfile,
  importedModelProfiles,
  MODEL_IDS,
  MODEL_PROFILES,
  registerImportedModels,
} from "./profiles";

/** 测试用资产根（实际由 `shared/ipc/model-import.ts` 按平台解析后传入）。 */
const IMPORTED_ORIGIN = "http://mascot-model.localhost";

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

/** 构造导入模型元数据。 */
function importedModel(id: string, name: string): ImportedModel {
  return {
    id,
    name,
    modelFile: `${name}.model3.json`,
    motions: ["Idle"],
    expressions: [],
    textures: 1,
    source: "zip",
  };
}

describe("运行时导入档案", () => {
  afterEach(() => {
    // 注册表是模块级单例：每个用例后清空，避免相互污染
    registerImportedModels([], IMPORTED_ORIGIN);
  });

  it("注册后进入 allProfiles / allModelIds，可按 id 查回", () => {
    registerImportedModels([importedModel("imported-haru", "Haru")], IMPORTED_ORIGIN);
    expect(allProfiles().map((p) => p.id)).toContain("imported-haru");
    expect(allModelIds()).toContain("imported-haru");
    expect(getProfile("imported-haru")?.name).toBe("Haru");
    expect(importedModelProfiles()).toHaveLength(1);
    // 内置档案不受影响
    expect(allModelIds().slice(0, MODEL_IDS.length)).toEqual(MODEL_IDS);
  });

  it("重新注册是整体替换（同名模型覆盖后不重复）", () => {
    registerImportedModels([importedModel("imported-haru", "Haru")], IMPORTED_ORIGIN);
    registerImportedModels([importedModel("imported-haru", "Haru 新版")], IMPORTED_ORIGIN);
    expect(importedModelProfiles()).toHaveLength(1);
    expect(getProfile("imported-haru")?.name).toBe("Haru 新版");
  });

  it("清空注册表后回到内置档案", () => {
    registerImportedModels([importedModel("imported-x", "X")], IMPORTED_ORIGIN);
    registerImportedModels([], IMPORTED_ORIGIN);
    expect(allProfiles()).toHaveLength(MODEL_PROFILES.length);
    expect(allModelIds()).toEqual(MODEL_IDS);
  });

  it("导入档案不影响默认档案（默认仍是首个内置模型）", () => {
    registerImportedModels([importedModel("imported-a", "A")], IMPORTED_ORIGIN);
    expect(DEFAULT_MODEL_ID).toBe(MODEL_PROFILES[0]?.id ?? "");
  });
});

