/**
 * DSH（DeepSeek Harness）宿主插件契约的最小结构镜像。
 *
 * 本仓库只在运行期依赖 DSH 注入的 Cordis 上下文，不直接 import DSH 内部包
 * （插件安装目录无法保证解析到 harness 的私有模块）。这里以「按用到的能力收窄接口」
 * 的方式镜像契约：字段语义与 DSH 0.2.x 的 Cordis `Context` 一致，升级 DSH 时
 * 只需复核本文件。注释中的 `ctx` 均指宿主注入的上下文实例。
 *
 * @module plugin/dsh
 */

/** 宿主日志门面：DSH 会把日志写入自身日志管线（桌面端落盘）。 */
export interface DshLogger {
  /** 运行期正常信息（启动、就绪、生命周期变化）。 */
  info(message: string): void;
  /** 可恢复的异常或降级（连接失败、自动启动被禁用）。 */
  warn(message: string): void;
  /** 需要用户介入的失败（启动命令找不到、等待超时）。 */
  error(message: string): void;
}

/** 释放函数：Cordis 在插件卸载 / 热重载（HMR）时调用。 */
export type DshDisposer = () => void;

/**
 * 宿主插件上下文：只声明本插件用到的两项能力。
 *
 * `effect` 负责把资源清理绑定到插件生命周期；`logger` 是统一日志出口。
 */
export interface DshPluginContext {
  /** 插件生命周期内的日志门面。 */
  readonly logger: DshLogger;
  /**
   * 注册一个 Cordis 服务，供后续插件行 `inject` 使用。
   *
   * 本插件用它发布 `mascotStartup`（解析后的 MCP 端点），使 MCP 客户端行
   * 能读到同一份 URL，无需在 YAML 里再写一遍端口。
   *
   * @param name - 服务名（Cordis 服务键）。
   * @param value - 服务值；同名服务重复注册会由宿主报错。
   */
  provide(name: string, value: unknown): void;
  /**
   * 注册随插件卸载执行的清理逻辑。
   *
   * @param execute - 返回释放函数的初始化函数；插件卸载时调用该释放函数。
   * @param label - 诊断标签，用于宿主定位未清理的资源。
   */
  effect(execute: () => DshDisposer | void, label?: string): void;
}

/** DSH 插件模块导出形状（宿主按 `name` / `inject` / `apply` 加载）。 */
export interface DshPluginModule {
  /** 插件名，出现在宿主日志与配置树中。 */
  readonly name: string;
  /** 声明依赖的宿主机服务；本插件只做进程编排，无需注入服务。 */
  readonly inject: readonly string[];
  /** 插件激活入口：宿主传入上下文与配置项。 */
  apply(ctx: DshPluginContext, config: unknown): void | Promise<void>;
}
