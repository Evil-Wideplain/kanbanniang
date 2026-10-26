/**
 * 看板娘应用设置（`settings.json`）的只读访问。
 *
 * 为什么插件要读它：MCP 端口可在看板娘设置页修改（Rust `config.rs` 持久化，
 * 默认 7432）。插件若把端口写死在 `cordis.patch.yml`，用户改端口后工具会静默消失。
 * 这里读取应用配置目录里的设置文件，作为**MCP 端点的单一来源**：
 * 宿主插件据此探活/拉起，并通过 `mascotStartup` 服务把 URL 交给 MCP 客户端。
 *
 * 文件路径与 Rust 侧一致：`<app_config_dir>/settings.json`，
 * Windows 上是 `%APPDATA%/com.example.kanbanmascot/settings.json`
 * （identifier 见 `src/tauri/tauri.conf.json`，改动必须两侧同步）。
 *
 * 读取失败一律回退默认值：设置文件缺失/损坏不能让插件崩溃。
 *
 * @module plugin/appSettings
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_MCP_URL } from './config.js';

/** Tauri 应用标识（与 `src/tauri/tauri.conf.json` 的 `identifier` 成对维护）。 */
export const APP_IDENTIFIER = 'com.example.kanbanmascot';

/** 覆盖设置文件路径的环境变量（测试或自定义安装位置时使用）。 */
export const SETTINGS_PATH_ENV = 'KANBAN_MASCOT_SETTINGS';

/** 应用设置中与 MCP 相关的字段（camelCase，与 Rust `Settings` 序列化一致）。 */
export interface AppMcpSettings {
  /** MCP 服务开关；关闭时应用不监听端口，工具不可用。 */
  readonly mcpEnabled: boolean;
  /** MCP 监听端口。 */
  readonly mcpPort: number;
}

/** MCP 端点解析结果（含来源，便于日志排障）。 */
export interface McpEndpoint {
  /** 最终使用的 Streamable HTTP 端点。 */
  readonly mcpUrl: string;
  /** 端点来源：显式配置 / 应用设置 / 内置默认。 */
  readonly source: 'config' | 'settings' | 'default';
  /** 应用设置是否明确关闭了 MCP（未读到设置时为 undefined）。 */
  readonly mcpEnabled?: boolean;
}

/** 设置文件绝对路径；无 `APPDATA` 等环境时返回 undefined。 */
export function appSettingsPath(): string | undefined {
  const override = process.env[SETTINGS_PATH_ENV];
  if (override !== undefined && override.trim() !== '') return override;
  const appData = process.env.APPDATA;
  if (appData === undefined || appData.trim() === '') return undefined;
  return join(appData, APP_IDENTIFIER, 'settings.json');
}

/**
 * 读取应用设置中的 MCP 字段。
 *
 * @returns 合法配置；文件缺失、JSON 损坏或字段非法时返回 undefined。
 */
export function readAppMcpSettings(): AppMcpSettings | undefined {
  const path = appSettingsPath();
  if (path === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as { mcpEnabled?: unknown; mcpPort?: unknown };
    if (typeof record.mcpEnabled !== 'boolean') return undefined;
    const port = record.mcpPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return undefined;
    }
    return { mcpEnabled: record.mcpEnabled, mcpPort: port };
  } catch {
    return undefined;
  }
}

/**
 * 解析 MCP 端点：显式配置 > 应用设置端口 > 内置默认端口。
 *
 * @param configuredUrl - `cordis.patch.yml` 里显式配置的 `mcpUrl`（可空）。
 * @returns 端点与来源；`mcpEnabled` 透传应用设置，未读到则为 undefined。
 */
export function resolveMcpEndpoint(configuredUrl?: string): McpEndpoint {
  if (configuredUrl !== undefined) {
    return { mcpUrl: configuredUrl, source: 'config' };
  }
  const settings = readAppMcpSettings();
  if (settings === undefined) {
    return { mcpUrl: DEFAULT_MCP_URL, source: 'default' };
  }
  return {
    mcpUrl: `http://127.0.0.1:${settings.mcpPort}/mcp`,
    source: 'settings',
    mcpEnabled: settings.mcpEnabled,
  };
}
