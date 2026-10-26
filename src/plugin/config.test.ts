import { describe, expect, it } from 'vitest';

import { defaultConfig, healthUrlOf, resolveConfig } from './config.js';

/**
 * 插件配置解析的单元测试。
 *
 * 配置来自用户手写的 `cordis.patch.yml`，拼写错误与类型错误必须在加载期就失败，
 * 否则插件会带着空配置静默启动，表现为「DSH 起来了但看板娘没反应」。
 */
describe('resolveConfig', () => {
  it('缺省时返回默认配置', () => {
    const config = resolveConfig(undefined);
    // mcpUrl 缺省表示由应用设置推导，不在这里写死默认值。
    expect(config.mcpUrl).toBeUndefined();
    expect(config.autoLaunch).toBe(true);
    expect(config.stopOnDispose).toBe(false);
    expect(config.startTimeoutMs).toBeGreaterThan(0);
  });

  it('接受合法覆盖值并补齐默认值', () => {
    const config = resolveConfig({
      mcpUrl: 'http://127.0.0.1:8000/mcp',
      autoLaunch: false,
      startTimeoutMs: 5000,
      launchCommand: ['node', 'server.mjs'],
    });
    expect(config.mcpUrl).toBe('http://127.0.0.1:8000/mcp');
    expect(config.autoLaunch).toBe(false);
    expect(config.startTimeoutMs).toBe(5000);
    expect(config.launchCommand).toEqual(['node', 'server.mjs']);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('拒绝未知字段（拼写错误不应静默生效）', () => {
    expect(() => resolveConfig({ mcpURL: 'http://127.0.0.1:7432/mcp' })).toThrow(/未知字段/);
  });

  it('拒绝非对象配置', () => {
    expect(() => resolveConfig([])).toThrow(/必须是对象/);
    expect(() => resolveConfig('x')).toThrow(/必须是对象/);
  });

  it('拒绝非 http(s) 端点与非法端口写法', () => {
    expect(() => resolveConfig({ mcpUrl: 'ws://127.0.0.1:7432/mcp' })).toThrow(/http/);
    expect(() => resolveConfig({ mcpUrl: 'not-a-url' })).toThrow(/合法 URL/);
  });

  it('拒绝越界超时与空启动命令', () => {
    expect(() => resolveConfig({ startTimeoutMs: 10 })).toThrow(/毫秒之间/);
    expect(() => resolveConfig({ startTimeoutMs: Number.NaN })).toThrow(/毫秒数/);
    expect(() => resolveConfig({ launchCommand: [] })).toThrow(/非空字符串数组/);
    expect(() => resolveConfig({ launchCommand: [''] })).toThrow(/非空字符串/);
  });

  it('拒绝错误类型的布尔值', () => {
    expect(() => resolveConfig({ autoLaunch: 'true' })).toThrow(/布尔值/);
  });
});

describe('healthUrlOf', () => {
  it('保留主机与端口，替换为 /health', () => {
    expect(healthUrlOf('http://127.0.0.1:7432/mcp')).toBe('http://127.0.0.1:7432/health');
    expect(healthUrlOf('https://example.com:9443/custom/mcp?x=1')).toBe(
      'https://example.com:9443/health',
    );
  });
});

describe('defaultConfig', () => {
  it('每次返回独立对象', () => {
    expect(defaultConfig()).not.toBe(defaultConfig());
  });
});
