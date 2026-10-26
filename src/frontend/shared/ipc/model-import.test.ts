/**
 * 基础设施单测：导入模型资产地址的平台差异 + 列表读取失败时的降级语义。
 * 只验证纯函数与「失败不清空注册表」这一层，不依赖真实 Tauri 运行时。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { importedModelProfiles, registerImportedModels } from "@/shared/domain/profiles";
import { importedAssetOrigin, loadImportedProfiles } from "./model-import";

/** 用指定 UA 替换全局 navigator（Node 环境默认 navigator 不可写）。 */
function stubUserAgent(userAgent: string): void {
  vi.stubGlobal("navigator", { userAgent });
}

describe("importedAssetOrigin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Windows 走 http://<scheme>.localhost（Tauri 在 Windows 上的映射形式）", () => {
    stubUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    expect(importedAssetOrigin()).toBe("http://mascot-model.localhost");
  });

  it("其它平台走 <scheme>://localhost", () => {
    stubUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15");
    expect(importedAssetOrigin()).toBe("mascot-model://localhost");
    stubUserAgent("");
    expect(importedAssetOrigin()).toBe("mascot-model://localhost");
  });
});

describe("loadImportedProfiles", () => {
  afterEach(() => {
    registerImportedModels([], "http://mascot-model.localhost");
    vi.unstubAllGlobals();
  });

  it("IPC 不可用时返回 false，且保留已注册档案（不清空芯片/MCP 列表）", async () => {
    stubUserAgent("Windows NT 10.0");
    registerImportedModels(
      [
        {
          id: "imported-x",
          name: "X",
          modelFile: "X.model3.json",
          motions: [],
          expressions: [],
          textures: 1,
          source: "folder",
        },
      ],
      "http://mascot-model.localhost",
    );

    const ok = await loadImportedProfiles();

    expect(ok).toBe(false);
    expect(importedModelProfiles().map((profile) => profile.id)).toContain("imported-x");
  });
});
