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

/** 前端探活使用的 MCP 工具：查询型，必须经「事件 → 前端 → 结果回传」才有应答。 */
export const FRONTEND_PROBE_TOOL = 'get_status';

/**
 * 前端探活默认超时。
 *
 * 服务端查询型工具自身有 5s 超时，这里留出网络与排队余量，避免把「服务端超时」
 * 误报成「插件探活超时」。
 */
const FRONTEND_PROBE_TIMEOUT_MS = 8000;

/** 前端链路探活结果：失败时给出可直接写进日志的原因。 */
export type FrontendProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** JSON-RPC 响应帧中本模块关心的字段（只取需要的，不镜像完整协议）。 */
interface RpcEnvelope {
  readonly error?: { readonly message?: unknown };
  readonly result?: {
    readonly isError?: unknown;
    readonly content?: readonly { readonly text?: unknown }[];
  };
}

/**
 * 探活「后端 → 前端」整链路：调用一次查询型 MCP 工具。
 *
 * `/health` 只能证明 axum 在监听。应用若以 dev 构建方式运行（前端加载 `devUrl`，
 * 没有 Vite dev server 就是白屏）或 WebView 渲染失败，后端照样健康、探活照样通过，
 * 但前端不会响应 `mascot:action`，查询型工具必然超时——这正是「插件说就绪、
 * 用户却看不到角色」的成因。补一次真实工具调用即可把这种形态区分出来。
 *
 * @param mcpUrl - Streamable HTTP 端点（`http://host:port/mcp`）。
 * @param timeoutMs - 整体超时，必须大于服务端 5s 查询超时。
 * @returns 探活结果；失败给出原因（超时 / 非 200 / 帧不可解析 / 工具报错）。
 */
export async function probeFrontend(
  mcpUrl: string,
  timeoutMs: number = FRONTEND_PROBE_TIMEOUT_MS,
): Promise<FrontendProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'kanbanniang-frontend-probe',
        method: 'tools/call',
        params: { name: FRONTEND_PROBE_TOOL, arguments: {} },
      }),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${String(response.status)}` };

    const envelope = parseJsonRpc(await response.text(), response.headers.get('content-type'));
    if (envelope === undefined) return { ok: false, reason: '响应不是可解析的 JSON-RPC 帧' };

    if (envelope.error !== undefined) {
      const message =
        typeof envelope.error.message === 'string' ? envelope.error.message : '未知错误';
      return { ok: false, reason: `工具调用失败: ${message}` };
    }
    const result = envelope.result;
    if (result === undefined) return { ok: false, reason: '响应缺少 result 字段' };
    if (result.isError === true) {
      return { ok: false, reason: `前端未响应: ${firstContentText(result.content) ?? '未知原因'}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describeProbeError(error, timeoutMs) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把探活异常转成一句可读原因（undici 会把真实网络错误藏在 `cause` 里）。 */
function describeProbeError(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'AbortError') return `前端响应超时（${String(timeoutMs)}ms）`;
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message.length > 0) return `${error.message}: ${cause.message}`;
  return error.message;
}

/** 解析 JSON-RPC 响应帧；Streamable HTTP 允许以事件流返回单帧响应。 */
function parseJsonRpc(text: string, contentType: string | null): RpcEnvelope | undefined {
  const raw = contentType !== null && contentType.includes('text/event-stream')
    ? lastSseData(text)
    : text;
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as RpcEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

/** 取 SSE 响应里最后一个 `data:` 载荷。 */
function lastSseData(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) last = line.slice('data:'.length).trim();
  }
  return last;
}

/** 取工具结果里的第一段文本（错误说明通常放在这里）。 */
function firstContentText(content: readonly { readonly text?: unknown }[] | undefined): string | undefined {
  for (const item of content ?? []) {
    if (typeof item.text === 'string' && item.text.length > 0) return item.text;
  }
  return undefined;
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
