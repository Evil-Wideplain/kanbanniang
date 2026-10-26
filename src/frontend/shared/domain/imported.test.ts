/**
 * 领域纯函数单测：导入模型元数据 → 模型档案换算。
 * 资产地址由基础设施层传入，这里只验证换算结果与语义别名派生。
 */
import { describe, expect, it } from "vitest";
import { importedModelDir, profileFromImported, type ImportedModel } from "./imported";

const ORIGIN = "http://mascot-model.localhost";

/** 构造一个最小导入模型元数据（按需覆盖字段）。 */
function makeModel(overrides: Partial<ImportedModel> = {}): ImportedModel {
  return {
    id: "imported-haru",
    name: "Haru",
    modelFile: "Haru.model3.json",
    motions: [],
    expressions: [],
    textures: 1,
    source: "folder",
    ...overrides,
  };
}

describe("importedModelDir", () => {
  it("模型目录 = 资产根 + 模型 id", () => {
    expect(importedModelDir(ORIGIN, "imported-haru")).toBe(
      "http://mascot-model.localhost/imported-haru",
    );
    expect(importedModelDir("mascot-model://localhost", "imported-haru")).toBe(
      "mascot-model://localhost/imported-haru",
    );
  });
});

describe("profileFromImported", () => {
  it("档案指向自定义协议地址并保留配置文件名", () => {
    const profile = profileFromImported(makeModel(), ORIGIN);
    expect(profile.id).toBe("imported-haru");
    expect(profile.name).toBe("Haru");
    expect(profile.config.modelFile).toBe("Haru.model3.json");
    expect(profile.config.modelDir).toBe(`${ORIGIN}/imported-haru`);
    expect(profile.config.anchorX).toBe(0.5);
  });

  it("按归一化派生 idle / speak / tap_body 动作别名", () => {
    const profile = profileFromImported(
      makeModel({ motions: ["Idle", "TapBody", "Extra"] }),
      ORIGIN,
    );
    expect(profile.motionAliases).toEqual({
      idle: "Idle",
      speak: "TapBody",
      tap_body: "TapBody",
    });
  });

  it("社区命名（standby / flick_head）也能命中语义别名", () => {
    const profile = profileFromImported(makeModel({ motions: ["standby", "flick_head"] }), ORIGIN);
    expect(profile.motionAliases?.idle).toBe("standby");
    expect(profile.motionAliases?.speak).toBe("flick_head");
  });

  it("没有可派生的动作/表情时不配置别名（交给控制器内建回退）", () => {
    const profile = profileFromImported(makeModel({ motions: ["wave"], expressions: ["Q1"] }), ORIGIN);
    expect(profile.motionAliases).toBeUndefined();
    expect(profile.expressionAliases).toBeUndefined();
  });

  it("表情语义别名按候选名归一化匹配", () => {
    const profile = profileFromImported(
      makeModel({ expressions: ["Normal", "Smile", "Angry", "Sad"] }),
      ORIGIN,
    );
    expect(profile.expressionAliases).toEqual({
      neutral: "Normal",
      happy: "Smile",
      angry: "Angry",
      sad: "Sad",
    });
  });
});
