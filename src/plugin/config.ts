/**
 * DSH 插件配置：解析、校验与默认值。
 *
 * 配置由插件 `cordis.patch.yml` 的 `config` 字段传入（见仓库根同名文件）。
 * 这里不依赖 DSH 的 schemastery：配置面很小，手写校验能给出更准确的中文错误，
 * 同时让纯函数可被单元测试覆盖。未知字段一律报错（拼写错误不应静默忽略）。
 *
 * @module plugin/config
 */

/** 默认 MCP 端点：与 Rust 侧 `mcp::DEFAULT_MCP_PORT` 保持一致。 */
export const DEFAULT_MCP_URL = 'http://127.0.0.1:7432/mcp';

/** 等待看板娘应用就绪的默认上限（首次冷启动含窗口初始化，留足余量）。 */
export const DEFAULT_START_TIMEOUT_MS = 20_000;

/** 单次健康检查的默认超时。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 800;

/** 健康检查轮询间隔。 */
export const DEFAULT_PROBE_INTERVAL_MS = 300;

/** 允许配置的超时上下限（毫秒）：过小会误判，过大会拖住 DSH 启动。 */
const TIMEOUT_RANGE = { min: 200, max: 120_000 } as const;

/** 插件配置（全部字段在解析后必有值；mcpUrl 缺省表示从应用设置推导）。 */
export interface PluginConfig {
  /**
   * MCP Streamable HTTP 端点覆盖值；缺省时由 `appSettings` 从看板娘
   * `settings.json` 的 `mcpPort` 推导，实现「设置页改端口，插件自动跟随」。
   */
  readonly mcpUrl?: string;
  /** 看板娘未运行且检测到可执行文件时，是否由插件自动拉起。 */
  readonly autoLaunch: boolean;
  /** 仓库根目录覆盖；缺省时从插件文件位置向上探测。 */
  readonly repoRoot?: string;
  /** 自定义启动命令（含参数），覆盖内置的 exe 探测结果。 */
  readonly launchCommand?: readonly string[];
  /** 自定义启动命令的工作目录；缺省为仓库根。 */
  readonly launchCwd?: string;
  /** 等待应用就绪的上限（毫秒）。 */
  readonly startTimeoutMs: number;
  /** 单次探活超时（毫秒）。 */
  readonly probeTimeoutMs: number;
  /** 探活轮询间隔（毫秒）。 */
  readonly probeIntervalMs: number;
  /** 插件卸载时是否终止由本插件拉起的应用进程（默认保留，桌面宠物常驻）。 */
  readonly stopOnDispose: boolean;
}

/** 已知配置键：用于拒绝未知字段，避免 `mcpURL` 之类的拼写错误静默生效。 */
const KNOWN_KEYS = new Set([
  'mcpUrl',
  'autoLaunch',
  'repoRoot',
  'launchCommand',
  'launchCwd',
  'startTimeoutMs',
  'probeTimeoutMs',
  'probeIntervalMs',
  'stopOnDispose',
]);

/** 解析后的默认配置（mcpUrl 缺省：由应用设置推导）。 */
export function defaultConfig(): PluginConfig {
  return {
    autoLaunch: true,
    startTimeoutMs: DEFAULT_START_TIMEOUT_MS,
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    probeIntervalMs: DEFAULT_PROBE_INTERVAL_MS,
    stopOnDispose: false,
  };
}

/**
 * 把关卡配置解析成 `PluginConfig`。
 *
 * @param raw - 宿主传入的原始 config（可能为 undefined）。
 * @returns 补齐默认值并冻结的配置对象。
 * @throws 配置不是对象、含未知字段或字段类型/取值非法时抛出带字段名的中文错误。
 */
export function resolveConfig(raw: unknown): PluginConfig {
  if (raw === undefined || raw === null) return defaultConfig();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('[kanban-mascot] config 必须是对象');
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`[kanban-mascot] config 含未知字段: ${key}`);
    }
  }

  // 可选覆盖：缺省时由 appSettings 从看板娘设置推导，不能在这里补默认值，
  // 否则宿主插件永远走不到「读设置」分支（设置页改端口将静默失效）。
  const mcpUrl = optionalString(record.mcpUrl, 'mcpUrl');
  if (mcpUrl !== undefined) assertHttpUrl(mcpUrl, 'mcpUrl');

  const repoRoot = optionalString(record.repoRoot, 'repoRoot');
  const launchCwd = optionalString(record.launchCwd, 'launchCwd');
  const launchCommand = optionalStringArray(record.launchCommand, 'launchCommand');

  const startTimeoutMs = optionalTimeout(
    record.startTimeoutMs,
    'startTimeoutMs',
    DEFAULT_START_TIMEOUT_MS,
  );
  const probeTimeoutMs = optionalTimeout(
    record.probeTimeoutMs,
    'probeTimeoutMs',
    DEFAULT_PROBE_TIMEOUT_MS,
  );
  const probeIntervalMs = optionalTimeout(
    record.probeIntervalMs,
    'probeIntervalMs',
    DEFAULT_PROBE_INTERVAL_MS,
  );

  return Object.freeze({
    ...(mcpUrl === undefined ? {} : { mcpUrl }),
    autoLaunch: optionalBoolean(record.autoLaunch, 'autoLaunch') ?? true,
    stopOnDispose: optionalBoolean(record.stopOnDispose, 'stopOnDispose') ?? false,
    startTimeoutMs,
    probeTimeoutMs,
    probeIntervalMs,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(launchCwd === undefined ? {} : { launchCwd }),
    ...(launchCommand === undefined ? {} : { launchCommand }),
  });
}

/**
 * 从 MCP 端点推导健康检查地址（同源、固定 `/health` 路径）。
 *
 * @param mcpUrl - 已通过校验的 MCP 端点。
 * @returns 健康检查 URL；解析失败时返回 undefined（由调用方按未就绪处理）。
 */
export function healthUrlOf(mcpUrl: string): string | undefined {
  try {
    const url = new URL(mcpUrl);
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/** 读取可选字符串（空串视为未配置）。 */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[kanban-mascot] config.${field} 必须是非空字符串`);
  }
  return value.trim();
}

/** 读取可选布尔值。 */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`[kanban-mascot] config.${field} 必须是布尔值`);
  }
  return value;
}

/** 读取非空字符串数组（启动命令）。 */
function optionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[kanban-mascot] config.${field} 必须是非空字符串数组`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item === '') {
      throw new Error(`[kanban-mascot] config.${field}[${index}] 必须是非空字符串`);
    }
    return item;
  });
}

/** 读取带上下限的毫秒超时。 */
function optionalTimeout(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[kanban-mascot] config.${field} 必须是毫秒数`);
  }
  if (value < TIMEOUT_RANGE.min || value > TIMEOUT_RANGE.max) {
    throw new Error(
      `[kanban-mascot] config.${field} 需在 ${TIMEOUT_RANGE.min}~${TIMEOUT_RANGE.max} 毫秒之间`,
    );
  }
  return Math.round(value);
}

/** 校验 HTTP(S) 端点。 */
function assertHttpUrl(value: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[kanban-mascot] config.${field} 不是合法 URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`[kanban-mascot] config.${field} 必须是 http(s) URL: ${value}`);
  }
}
