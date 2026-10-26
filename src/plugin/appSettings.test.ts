import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_IDENTIFIER,
  appSettingsPath,
  readAppMcpSettings,
  resolveMcpEndpoint,
  SETTINGS_PATH_ENV,
} from './appSettings.js';
import { DEFAULT_MCP_URL } from './config.js';

/**
 * 应用设置读取的单元测试。
 *
 * 这些用例覆盖「设置页改端口 → 插件自动跟随」的核心契约：
 * 端口来源单一、坏文件回退默认值、显式配置优先。
 */
describe('appSettings', () => {
  let dir: string;
  let settingsPath: string;
  const previousOverride = process.env[SETTINGS_PATH_ENV];
  const previousAppData = process.env.APPDATA;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-mascot-settings-'));
    settingsPath = join(dir, 'settings.json');
    process.env[SETTINGS_PATH_ENV] = settingsPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    restoreEnv(SETTINGS_PATH_ENV, previousOverride);
    restoreEnv('APPDATA', previousAppData);
  });

  it('读取合法设置文件', () => {
    writeSettings({ mcpEnabled: true, mcpPort: 7433 });
    expect(readAppMcpSettings()).toEqual({ mcpEnabled: true, mcpPort: 7433 });
  });

  it('文件缺失或 JSON 损坏时返回 undefined', () => {
    expect(readAppMcpSettings()).toBeUndefined();
    writeFileSync(settingsPath, '{not json', 'utf8');
    expect(readAppMcpSettings()).toBeUndefined();
  });

  it('端口非法时返回 undefined', () => {
    for (const port of [0, 65_536, 7432.5, '7432', null]) {
      writeSettings({ mcpEnabled: true, mcpPort: port });
      expect(readAppMcpSettings()).toBeUndefined();
    }
  });

  it('从应用设置推导端点并透传 mcpEnabled', () => {
    writeSettings({ mcpEnabled: false, mcpPort: 7500 });
    const endpoint = resolveMcpEndpoint();
    expect(endpoint.mcpUrl).toBe('http://127.0.0.1:7500/mcp');
    expect(endpoint.source).toBe('settings');
    expect(endpoint.mcpEnabled).toBe(false);
  });

  it('显式配置优先于应用设置', () => {
    writeSettings({ mcpEnabled: true, mcpPort: 7500 });
    const endpoint = resolveMcpEndpoint('http://127.0.0.1:9000/mcp');
    expect(endpoint).toEqual({ mcpUrl: 'http://127.0.0.1:9000/mcp', source: 'config' });
  });

  it('读不到设置时回退内置默认端点', () => {
    process.env[SETTINGS_PATH_ENV] = join(dir, 'missing.json');
    expect(resolveMcpEndpoint()).toEqual({ mcpUrl: DEFAULT_MCP_URL, source: 'default' });
  });

  it('设置路径缺少 APPDATA 且无覆盖时不猜测', () => {
    delete process.env[SETTINGS_PATH_ENV];
    delete process.env.APPDATA;
    expect(appSettingsPath()).toBeUndefined();
    expect(readAppMcpSettings()).toBeUndefined();
  });

  it('默认设置目录包含应用 identifier', () => {
    delete process.env[SETTINGS_PATH_ENV];
    process.env.APPDATA = dir;
    expect(appSettingsPath()).toBe(join(dir, APP_IDENTIFIER, 'settings.json'));
  });

  /** 写入设置文件（字段值可故意非法，用于负向用例）。 */
  function writeSettings(value: unknown): void {
    writeFileSync(settingsPath, JSON.stringify(value), 'utf8');
  }
});

/** 恢复被用例修改的环境变量。 */
function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}
