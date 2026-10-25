/**
 * 领域纯函数单测：说话时长公式（气泡展示用）。
 */
import { describe, expect, it } from "vitest";
import { speakDurationMs } from "./speech";

describe("speakDurationMs", () => {
  it("基础时长 1500ms + 每字 90ms", () => {
    expect(speakDurationMs("")).toBe(1500);
    expect(speakDurationMs("abcd")).toBe(1860);
  });

  it("封顶 8000ms", () => {
    expect(speakDurationMs("x".repeat(1000))).toBe(8000);
  });
});
