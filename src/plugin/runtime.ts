/**
 * 运行时编排：定位仓库、探测 MCP 服务、拉起看板娘进程。
 *
 * 纯副作用集中在本模块，便于宿主插件入口只做「读配置 → 调本模块 → 记日志」。
 * 所有函数都不抛异常（除仓库探测这类纯查询）：失败以返回值表达，由调用方决定日志级别。
 *
 * @module plugin/runtime
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginConfig } from './config.js';

/** 启动命令描述（可执行文件 + 参数 + 工作目录）。 */
export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** 启动结果：成功给出进程号，失败给出可读原因。 */
export type LaunchResult =
  | { readonly ok: true; readonly pid: number }
  | { readonly ok: false; readonly reason: string };

/** 内置产物相对仓库根的位置（release 优先，debug 兜底）。 */
const EXE_CANDIDATES: readonly string[] =
  process.platform === 'win32'
    ? ['target/release/kanbanniang.exe', 'target/debug/kanbanniang.exe']
    : ['target/release/kanbanniang', 'target/debug/kanbanniang'];

/** 向上探测仓库根的最大层数（node_modules 软链接层级留够余量）。 */
const MAX_ROOT_WALK = 8;

/** 本模块所在目录（编译后为 `<repo>/lib`）。 */
export function moduleRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * 从起始目录向上寻找仓库根：同时存在 `package.json` 与 `src/tauri/Cargo.toml`。
 *
 * 不用「找到 package.json 就停」的简化判定：通过 `file:` 安装时插件目录本身
 * 也有 package.json（位于 node_modules 内），必须继续上溯到真正的仓库根。
 *
 * @param start - 起始目录（通常是插件模块目录）。
 * @returns 仓库根绝对路径；未找到返回 undefined。
 */
export function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (let depth = 0; depth < MAX_ROOT_WALK; depth += 1) {
    if (
      existsSync(join(dir, 'package.json')) &&
      existsSync(join(dir, 'src', 'tauri', 'Cargo.toml'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 推导启动命令：显式配置优先，否则探测内置构建产物。
 *
 * @param repoRoot - 仓库根；未定位到时为 undefined。
 * @param config - 已解析插件配置。
 * @returns 启动命令；没有可用可执行文件时返回 undefined。
 */
export function detectLaunch(repoRoot: string | undefined, config: PluginConfig): LaunchSpec | undefined {
  const cwd = config.launchCwd ?? repoRoot;
  if (config.launchCommand !== undefined && config.launchCommand.length > 0) {
    if (cwd === undefined) return undefined;
    const command = config.launchCommand[0];
    if (command === undefined) return undefined;
    return { command, args: config.launchCommand.slice(1), cwd };
  }
  if (repoRoot === undefined) return undefined;
  for (const relative of EXE_CANDIDATES) {
    const candidate = join(repoRoot, relative);
    if (existsSync(candidate)) {
      return { command: candidate, args: [], cwd: repoRoot };
    }
  }
  return undefined;
}

/**
 * 单次健康检查：HTTP 200 且响应体 `ok:true` 视为就绪。
 *
 * @param healthUrl - `/health` 地址。
 * @param timeoutMs - 单次请求超时。
 * @returns 是否就绪（网络错误 / 超时 / 非 200 均视为未就绪）。
 */
export async function probeHealth(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 轮询等待服务就绪（应用冷启动需要一点时间）。
 *
 * @param healthUrl - `/health` 地址。
 * @param config - 已解析插件配置（提供超时与轮询间隔）。
 * @returns 是否在超时前就绪。
 */
export async function waitForHealth(healthUrl: string, config: PluginConfig): Promise<boolean> {
  const deadline = Date.now() + config.startTimeoutMs;
  for (;;) {
    if (await probeHealth(healthUrl, config.probeTimeoutMs)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(config.probeIntervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * 以分离进程方式启动看板娘，不阻塞 DSH 退出。
 *
 * @param spec - 启动命令。
 * @returns 启动结果（spawn 失败或可执行文件不存在时给出原因）。
 */
export async function launchDetached(spec: LaunchSpec): Promise<LaunchResult> {
  return new Promise<LaunchResult>((resolve) => {
    try {
      const child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: error.message });
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true, pid: child.pid ?? -1 });
      });
    } catch (error) {
      resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * 尽力终止由本插件拉起的进程（仅在 `stopOnDispose` 开启时使用）。
 *
 * @param pid - 进程号；非正数视为无效，直接忽略。
 */
export function terminate(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid);
  } catch {
    // 进程可能已自行退出：清理失败无需升级为错误。
  }
}

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
