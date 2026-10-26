/**
 * 看板娘 × DSH 宿主插件（Cordis 半侧）。
 *
 * 职责：在 DSH 启动时解析 MCP 端点、确保看板娘应用可用，并把端点发布成
 * `mascotStartup` 服务，供同层插入的 `@deepseek-ai/dsh-mcp-client` 读取。
 * 进程与探活语义在 `runtime`，配置校验在 `config`，应用设置读取在 `appSettings`；
 * 本文件只做编排。
 *
 * 装配关系（见仓库根 `cordis.patch.yml`）：
 * 1. 本插件（先加载）→ `ctx.provide('mascotStartup', { mcpUrl })`，
 *    等待 `/health` 就绪，必要时拉起看板娘；
 * 2. `@deepseek-ai/dsh-mcp-client`（后加载，`inject: [mascotStartup]`）→
 *    `url: !!js ctx.mascotStartup.mcpUrl`，把工具以 `mcp__kanbanniang__<tool>`
 *    注册进 DSH。
 *
 * 注意：`mascotStartup` 必须在**所有失败路径**下都被提供——如果 MCP 客户端行
 * inject 的服务永远不出现，该行会停在 PENDING，DSH 启动会直接失败。
 *
 * @module plugin/host
 */

import { resolveMcpEndpoint, type McpEndpoint } from './appSettings.js';
import {
  DEFAULT_MCP_URL,
  defaultConfig,
  healthUrlOf,
  resolveConfig,
  type PluginConfig,
} from './config.js';
import type { DshLogger, DshPluginContext } from './dsh.js';
import { createDualLogger, defaultLogPath } from './logging.js';
import {
  detectLaunch,
  findRepoRoot,
  FRONTEND_PROBE_TOOL,
  launchDetached,
  moduleRoot,
  probeFrontend,
  probeHealth,
  terminate,
  waitForHealth,
} from './runtime.js';

/** 日志前缀：与仓库其他模块的 `[mascot]` / `[mcp]` 风格保持一致，便于检索。 */
const LOG_PREFIX = '[kanbanniang]';

/** 对外发布的 Cordis 服务名（MCP 客户端行按它 inject）。 */
const STARTUP_SERVICE = 'mascotStartup';

/** 插件名（宿主日志与配置树中可见）。 */
export const name = 'kanbanniang';

/** 本插件不依赖宿主服务：只做端点解析、进程编排与日志。 */
export const inject: readonly string[] = [];

/** 配置解析结果：即使配置非法也要给出可发布的端点（保证 provider 永不缺席）。 */
interface StartupResolution {
  /** 解析后的配置；配置非法时为默认配置。 */
  readonly config: PluginConfig;
  /** 解析后的 MCP 端点。 */
  readonly endpoint: McpEndpoint;
  /** 配置是否有效；false 时跳过自动启动。 */
  readonly ok: boolean;
}

/**
 * 插件激活：解析端点 → 发布 `mascotStartup` → 确保应用就绪。
 *
 * 激活期间会阻塞至服务就绪或 `startTimeoutMs` 超时，以保证 MCP 客户端
 * 首次连接即可发现工具；失败只记日志，不阻止 DSH 启动
 * （mcp-client 自己也有重连预算）。
 *
 * @param ctx - DSH 注入的 Cordis 上下文。
 * @param rawConfig - `cordis.patch.yml` 中的 `config` 字段（可为空）。
 */
export async function apply(ctx: DshPluginContext, rawConfig?: unknown): Promise<void> {
  // 桌面端 DSH 不落盘 host 日志：这里同时写一份到 `<DSH_HOME>/kanbanniang/plugin.log`。
  const logger = createDualLogger(ctx.logger, defaultLogPath());
  const startup = resolveStartup(rawConfig, logger);

  // 先提供服务再做事：MCP 客户端行的 config 依赖它，且该行不会容忍 provider 缺失。
  ctx.provide(STARTUP_SERVICE, Object.freeze({ mcpUrl: startup.endpoint.mcpUrl }));
  logger.info(
    `${LOG_PREFIX} 激活: mcpUrl=${startup.endpoint.mcpUrl} 来源=${startup.endpoint.source} ` +
      `autoLaunch=${String(startup.config.autoLaunch)}`,
  );

  if (!startup.ok) return;
  if (startup.endpoint.mcpEnabled === false) {
    logger.warn(
      `${LOG_PREFIX} 看板娘设置中已关闭 MCP 服务，工具不可用；` +
        '请在设置页开启 MCP（修改端口后无需改插件配置）。',
    );
    return;
  }

  const { config } = startup;
  const healthUrl = healthUrlOf(startup.endpoint.mcpUrl);
  if (healthUrl === undefined) {
    logger.error(`${LOG_PREFIX} MCP 端点无法推导健康检查地址: ${startup.endpoint.mcpUrl}`);
    return;
  }

  if (await probeHealth(healthUrl, config.probeTimeoutMs)) {
    logger.info(`${LOG_PREFIX} 看板娘已在运行，复用现有实例: ${startup.endpoint.mcpUrl}`);
    // 复用实例也要验证前端：进程在跑不等于画得出角色（dev 构建 / WebView 白屏都会命中这里）。
    await reportFrontendProbe(startup.endpoint.mcpUrl, logger);
    return;
  }

  if (!config.autoLaunch) {
    logger.warn(
      `${LOG_PREFIX} 看板娘未运行且已配置 autoLaunch=false；` +
        `请手动启动应用（MCP 端点 ${startup.endpoint.mcpUrl}）`,
    );
    return;
  }

  const repoRoot = config.repoRoot ?? findRepoRoot(moduleRoot());
  const launch = detectLaunch(repoRoot, config);
  if (launch === undefined) {
    logger.error(
      `${LOG_PREFIX} 未找到看板娘可执行文件。请先在仓库根执行 "make build" 生成 ` +
        'target/release/kanbanniang.exe，或在 cordis.patch.yml 中配置 launchCommand。',
    );
    return;
  }

  logger.info(
    `${LOG_PREFIX} 启动看板娘: ${launch.command} ${launch.args.join(' ')} (cwd=${launch.cwd})`,
  );
  const started = await launchDetached(launch);
  if (!started.ok) {
    logger.error(`${LOG_PREFIX} 启动失败: ${started.reason}`);
    return;
  }
  logger.info(`${LOG_PREFIX} 看板娘已启动 pid=${started.pid}`);

  // 卸载（含 HMR）时的清理：Cordis 的 effect 会立即执行回调并要求返回释放函数，
  // 因此日志与进程处理都放在返回的 disposer 里（默认保留桌面宠物）。
  ctx.effect(
    () => () => {
      if (!config.stopOnDispose) {
        logger.info(`${LOG_PREFIX} 插件卸载：保留看板娘进程 pid=${started.pid}`);
        return;
      }
      logger.info(`${LOG_PREFIX} 插件卸载：终止看板娘进程 pid=${started.pid}`);
      terminate(started.pid);
    },
    'kanbanniang.lifecycle',
  );

  if (await waitForHealth(healthUrl, config)) {
    logger.info(`${LOG_PREFIX} MCP 服务就绪: ${startup.endpoint.mcpUrl}`);
    await reportFrontendProbe(startup.endpoint.mcpUrl, logger);
    return;
  }
  // 首次冷启动可能仍在编译：不升级为异常，交给 mcp-client 的重连预算兜底。
  logger.error(
    `${LOG_PREFIX} 等待 MCP 服务就绪超时（${config.startTimeoutMs}ms）。` +
      '若这是首次运行，构建可能尚未完成；完成后 DSH 会自动重连。',
  );
}

/**
 * 解析配置与端点；配置非法时回退默认值并记录错误。
 *
 * @param rawConfig - 宿主传入的原始配置。
 * @param logger - 已就绪的日志门面。
 * @returns 解析结果（`ok=false` 表示配置非法，调用方应跳过后续启动逻辑）。
 */
function resolveStartup(rawConfig: unknown, logger: DshLogger): StartupResolution {
  try {
    const config = resolveConfig(rawConfig);
    return { config, endpoint: resolveMcpEndpoint(config.mcpUrl), ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error(`${LOG_PREFIX} 配置无效，已回退默认端点并跳过自动启动: ${reason}`);
    return {
      config: defaultConfig(),
      endpoint: safeDefaultEndpoint(),
      ok: false,
    };
  }
}

/** 配置非法时的兜底端点：读取应用设置失败也不能让 provider 缺席。 */
function safeDefaultEndpoint(): McpEndpoint {
  try {
    return resolveMcpEndpoint();
  } catch {
    return { mcpUrl: DEFAULT_MCP_URL, source: 'default' };
  }
}

/**
 * 前端链路探活并记录结论。
 *
 * 后端健康 + 前端白屏是最容易误判的失败形态：`/health` 返回 ok，插件日志照写「就绪」，
 * 但从用户视角看就是「拉起了却没有角色」。这里用一次查询型工具把真实结论落到日志里，
 * 避免再出现「日志全绿、屏幕空白」这种排查成本极高的组合。
 *
 * @param mcpUrl - Streamable HTTP 端点。
 * @param logger - 已就绪的日志门面。
 */
async function reportFrontendProbe(mcpUrl: string, logger: DshLogger): Promise<void> {
  const probe = await probeFrontend(mcpUrl);
  if (probe.ok) {
    logger.info(`${LOG_PREFIX} 前端链路就绪: ${FRONTEND_PROBE_TOOL} 已响应`);
    return;
  }
  logger.error(
    `${LOG_PREFIX} 后端已就绪但前端无响应（${probe.reason}）：看板娘窗口可能是空白。` +
      '最常见原因是 exe 由 cargo build 直接编译（dev 构建加载 devUrl，需要 Vite dev server），' +
      '请用 "npm run tauri:build" 重新构建后重启看板娘。',
  );
}
