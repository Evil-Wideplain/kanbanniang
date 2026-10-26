/**
 * 插件日志落盘：DSH 桌面端不把 host 插件日志写入文件（子进程 stdout 由 Electron 接管），
 * 排障时只靠 GUI 插件页与崩溃日志不够用。这里在 `ctx.logger` 之外补一份独立文件日志，
 * 位置固定为 `<DSH_HOME>/kanbanniang/plugin.log`（可用环境变量覆盖）。
 *
 * 约束：日志写入失败绝不能影响插件功能，所有文件操作均静默降级。
 *
 * @module plugin/logging
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { DshLogger } from './dsh.js';

/** 覆盖插件日志路径的环境变量（测试或自定义部署时使用）。 */
export const LOG_PATH_ENV = 'KANBANNIANG_PLUGIN_LOG';

/** 解析 DSH 主目录：优先 `DSH_HOME`，否则 `~/.dsh`。 */
export function resolveDshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/** 插件日志默认路径。 */
export function defaultLogPath(): string {
  const override = process.env[LOG_PATH_ENV];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(resolveDshHome(), 'kanbanniang', 'plugin.log');
}

/**
 * 包装宿主 logger：同一份日志同时交给 DSH 与本地文件。
 *
 * @param base - 宿主注入的 logger。
 * @param logPath - 本地日志文件路径。
 * @returns 双写 logger（文件侧失败时只保留宿主日志）。
 */
export function createDualLogger(base: DshLogger, logPath: string): DshLogger {
  let prepared = false;

  const append = (level: string, message: string): void => {
    try {
      if (!prepared) {
        mkdirSync(dirname(logPath), { recursive: true });
        prepared = true;
      }
      appendFileSync(logPath, `${new Date().toISOString()} ${level} ${message}\n`, 'utf8');
    } catch {
      // 只读文件系统 / 权限不足：放弃文件日志，不影响插件。
    }
  };

  return {
    info: (message) => {
      base.info(message);
      append('INFO', message);
    },
    warn: (message) => {
      base.warn(message);
      append('WARN', message);
    },
    error: (message) => {
      base.error(message);
      append('ERROR', message);
    },
  };
}
