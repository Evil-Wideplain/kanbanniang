/**
 * 应用设置的领域规则：默认值与校验（字段契约与 Rust 侧 config.rs 成对镜像）。
 * 校验规则（含中文报错文案）只在本模块实现一份：Rust 侧 `config::normalize` 仅对
 * 越界值做收敛兜底，不再重复一套校验与错误文案。
 * 设置的传输由 shared/ipc/settings-client.ts 负责，本模块不触碰 DOM / Tauri。
 */
import { DEFAULT_MODEL_ID } from "./profiles";
import type { MascotSettings } from "./types";

/** 默认 MCP 端口（与 Rust `mcp::DEFAULT_MCP_PORT` 一致）。 */
export const DEFAULT_MCP_PORT = 7432;

/** 默认设置：后端设置缺失或非 Tauri 环境时的回退值。 */
export const DEFAULT_SETTINGS: MascotSettings = {
  mcpEnabled: true,
  mcpPort: DEFAULT_MCP_PORT,
  modelId: DEFAULT_MODEL_ID,
  alwaysOnTop: true,
  gazeFollow: true,
  opacity: 100,
  autostart: false,
};

/** 校验端口：须为 1~65535 的整数。合法返回 null，否则返回中文原因。 */
export function validatePort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return "端口需为 1~65535 的整数";
  }
  return null;
}

/** 校验不透明度：须为 1~100 的整数（规则的唯一实现；Rust `config::normalize` 只做越界兜底收敛，不重复报错文案）。 */
export function validateOpacity(opacity: number): string | null {
  if (!Number.isInteger(opacity) || opacity < 1 || opacity > 100) {
    return "不透明度需为 1~100";
  }
  return null;
}
