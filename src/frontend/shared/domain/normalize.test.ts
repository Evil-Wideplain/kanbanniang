/**
 * 领域纯函数单测：动作 / 表情名归一化（两个控制器实现与档案别名映射共用）。
 */
import { describe, expect, it } from "vitest";
import { norm } from "./normalize";

describe("norm", () => {
  it("小写并去掉下划线", () => {
    expect(norm("TapBody")).toBe("tapbody");
    expect(norm("tap_body")).toBe("tapbody");
    expect(norm("Flick_Head")).toBe("flickhead");
  });

  it("空串原样返回", () => {
    expect(norm("")).toBe("");
  });
});
