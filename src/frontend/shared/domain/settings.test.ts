/**
 * 领域纯函数单测：设置默认值与校验（须与 Rust `config.rs` 对齐）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MCP_PORT, DEFAULT_SETTINGS, validateOpacity, validatePort } from "./settings";

describe("validatePort", () => {
  it("1~65535 的整数合法", () => {
    expect(validatePort(1)).toBeNull();
    expect(validatePort(DEFAULT_MCP_PORT)).toBeNull();
    expect(validatePort(65535)).toBeNull();
  });

  it("越界或非整数返回原因", () => {
    expect(validatePort(0)).not.toBeNull();
    expect(validatePort(65536)).not.toBeNull();
    expect(validatePort(80.5)).not.toBeNull();
  });
});

describe("validateOpacity", () => {
  it("1~100 的整数合法", () => {
    expect(validateOpacity(1)).toBeNull();
    expect(validateOpacity(100)).toBeNull();
  });

  it("越界或非整数返回原因", () => {
    expect(validateOpacity(0)).not.toBeNull();
    expect(validateOpacity(101)).not.toBeNull();
    expect(validateOpacity(50.5)).not.toBeNull();
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("默认端口与 Rust 常量一致，且默认值自身合法", () => {
    expect(DEFAULT_SETTINGS.mcpPort).toBe(DEFAULT_MCP_PORT);
    expect(validatePort(DEFAULT_SETTINGS.mcpPort)).toBeNull();
    expect(validateOpacity(DEFAULT_SETTINGS.opacity)).toBeNull();
  });
});
