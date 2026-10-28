/**
 * 看板娘与 MCP 服务之间共用的类型定义（领域层契约）。
 * 工具清单单一来源是 src/mcp/tools.json（Rust 侧同源加载）；
 * 事件契约与 src/tauri/src/state.rs 成对镜像，字段改动必须两侧同步。
 */

import mcpTools from "../../../mcp/tools.json";

/** 运行时工具清单（name/description/inputSchema/action/query，与 Rust 侧同源）。 */
export const MCP_TOOLS = mcpTools;

/**
 * 动作表：本文件内唯一的手写点（值与类型同源）。
 * JSON 导入的字符串字面量会被 widen 成 string，无法直接派生字面量联合类型，
 * 因此联合类型由本常量派生，并在下方与 src/mcp/tools.json 运行时互校。
 */
export const MASCOT_ACTIONS = [
  "play_motion",
  "set_expression",
  "speak",
  "move_in_window",
  "set_idle",
  // 下面是"查询型"动作：前端需要把结果回传给后端
  "move",
  "list_motions",
  "list_expressions",
  "get_status",
  "set_model",
  "list_models",
] as const;

/** MCP 服务向后端发起、由后端转发给前端的"动作"指令。 */
export type MascotAction = (typeof MASCOT_ACTIONS)[number];

// 加载时一致性校验：清单与本地动作表不一致仅告警（不阻断启动，符合 fallback-first）。
const manifestActions = MCP_TOOLS.map((t) => t.action).slice().sort().join(",");
const localActions = [...MASCOT_ACTIONS].slice().sort().join(",");
if (manifestActions !== localActions) {
  console.warn("[mascot] src/mcp/tools.json 与 types.ts 动作表不一致", {
    manifest: manifestActions,
    local: localActions,
  });
}

/**
 * Tauri 事件通道名契约（与 Rust 侧 `state.rs` / `commands.rs` 用的字面量成对维护）。
 * 集中定义避免跨文件/跨语言各自硬编码，重命名时只改这里。
 */
export const CHANNELS = {
  /** 后端 → 前端：下发 MCP 动作指令。 */
  action: "mascot:action",
  /** 前端 → 后端：回传查询型动作结果。 */
  result: "mascot:result",
  /** 后端 → 前端：广播设置变更。 */
  settings: "mascot:settings",
} as const;

/** 后端通过 Tauri 事件发给前端的指令载荷。 */
export interface MascotCommand {
  /** 本次指令唯一 id；查询型指令回传结果时必须带上同一个 id。 */
  id: string;
  /** 动作类型。 */
  action: MascotAction;
  /** 动作参数（不同动作结构不同，见各方法）。 */
  params: Record<string, unknown>;
}

/** 前端把查询型动作的结果回传给后端的载荷（经 Tauri 事件 mascot:result）。 */
export interface MascotResult {
  /** 对应下发指令的 id。 */
  id: string;
  /** 前端处理是否成功。 */
  ok: boolean;
  /** 任意可序列化结果（动作列表、状态对象等）。 */
  result: unknown;
  /** 失败原因（ok=false 时使用）。 */
  error?: string;
}

/**
 * 持久化应用设置（与 src/tauri/src/config.rs 的 Settings 成对镜像，camelCase）。
 * 经 Tauri 命令 get_settings / save_settings 读写。
 */
export interface MascotSettings {
  /** 是否启用内置 MCP 服务（关闭后不监听端口，看板娘仍可独立运行）。 */
  mcpEnabled: boolean;
  /** 内置 MCP 服务监听端口。 */
  mcpPort: number;
  /** 启动时加载的模型档案 id；空串表示未指定，回退默认档案。 */
  modelId: string;
  /** 看板娘窗口是否置顶（主窗口 always-on-top）。 */
  alwaysOnTop: boolean;
  /** 是否让看板娘全屏跟随鼠标（扩展到屏幕任意位置；关闭时仍保留窗口内跟随。仅 Live2D 模式）。 */
  gazeFollow: boolean;
  /** 看板娘不透明度（1~100 的百分数，作用于画布）。 */
  opacity: number;
  /** 是否开机自启（注册到系统登录项）。 */
  autostart: boolean;
}

/** MCP 服务运行时状态（get_runtime_status 返回，与 config.rs 无关、纯运行态）。 */
export interface RuntimeStatus {
  /** 服务当前是否在运行（启动时端口被占用则为 false）。 */
  mcpRunning: boolean;
  /** 实际监听端口；未运行时回退为配置端口。 */
  mcpPort: number;
}

/** 看板娘当前状态（get_status 返回）。 */
export interface MascotStatus {
  mode: "live2d";
  model: string | null;
  /** 模型档案 id（如 "haru"），供 list_models 展示当前使用项。 */
  modelId?: string;
  expression: string;
  position: { x: number; y: number };
  speaking: boolean;
}

/** set_model 的结果信封（内嵌在 MascotResult.result 中回传）。 */
export type SetModelOutcome =
  | { ok: true; model: string; mode: "live2d"; modelFile: string | null; unchanged?: boolean }
  | { ok: false; error: string; current?: string; available?: string[] };

/**
 * 窗口平滑移动结果（Tauri 命令 move_window 返回，
 * 与 src/tauri/src/commands.rs 的 WindowMoveOutcome 成对镜像，camelCase）。
 */
export interface WindowMoveOutcome {
  /** 最终生效的归一化坐标（工作区内，已截断到 [0,1]）。 */
  x: number;
  y: number;
  /** 最终窗口外框左上角（物理像素）。 */
  physicalX: number;
  physicalY: number;
  /** 归一化输入超出 [0,1] 被截断。 */
  clamped: boolean;
  /** 被更新的移动请求打断（本请求未滑到终点）。 */
  superseded: boolean;
}

/** 动作/表情执行结果：回报真实生效的名字与是否走了回退。 */
export interface ActionOutcome {
  /** 实际生效的真实名字（动作组名/表情名）；null 表示没有可执行目标。 */
  applied: string | null;
  /** 请求名未直接命中、走了回退策略时为 true。 */
  fallback: boolean;
  /** 实际使用的动作变体序号（仅动作有）。 */
  index?: number;
}

/**
 * 动作序列中的一步（play_motion 的输入单元）。
 * 控制器总是等该步动作真正播完再进下一步；`holdMs` 只是播完后的额外停留时长。
 */
export interface MotionStep {
  /** 动作组名或语义名（同 list_motions 的返回）。 */
  motion: string;
  /** 动作变体序号；省略表示随机变体。 */
  index?: number;
  /** 本步动作播完后的额外停留毫秒数（默认 0：播完立刻进下一步）。 */
  holdMs?: number;
  /** 本步开始时同时切换的表情（可选，不打断动作）。 */
  expression?: string;
  /** 本步开始时同时说出的台词（可选，显示气泡；不打断动作）。 */
  text?: string;
}

/** 动作序列中一步的执行结果（多一个 requested 便于对照请求名与回退）。 */
export interface MotionStepOutcome extends ActionOutcome {
  /** 调用方请求的原始名字。 */
  requested: string;
  /** 本步采用的动作播完后额外停留毫秒数（未给即 0）。 */
  holdMs?: number;
  /** 本步同时切换的表情（原样回显，便于核对）。 */
  expression?: string;
  /** 本步同时说出的台词（原样回显）。 */
  text?: string;
}

/** play_motion 的整体播放选项。 */
export interface MotionPlayOptions {
  /** 整个序列播放完成后调用 set_idle（中性表情 + 待机动作）。缺省 false。 */
  idle?: boolean;
}

/**
 * 看板娘控制器接口：MCP 事件分发逻辑只依赖它，
 * 因此与具体 Live2D 渲染实现解耦。
 */
export interface MascotController {
  /**
   * 按序串行播放动作序列（单步即「播一个动作」）。
   * 名字先按档案别名/归一化匹配，未命中回退点触动作；每步等播完再进下一步。
   * `options.idle` 为真时，整段播完后调用 set_idle（中性表情 + 待机动作）。
   * 返回每一步的解析结果（同步）；实际播放异步进行，完成/被打断只体现在日志与渲染上。
   */
  playMotions(steps: MotionStep[], options?: MotionPlayOptions): MotionStepOutcome[];
  /** 设置表情（如 "happy" / "angry" / "neutral"）。未命中时回退为默认表情；不打断动作播放。 */
  expression(name: string): ActionOutcome;
  /** 说话：展示气泡并做口型/表情反馈；动作播放中只更新气泡，不打断动作。 */
  speak(text: string): void;
  /** 注入台词出口（气泡显示），由组合根接线，渲染层不直接操作 DOM。 */
  setSpeechSink(sink: (text: string) => void): void;
  /** 移动到归一化坐标（x,y ∈ [0,1]，相对窗口）。 */
  moveTo(x: number, y: number): void;
  /** 回到待机。 */
  idle(): void;
  /** 开关全屏视线跟随（窗口内跟随始终生效）。 */
  setGaze(enabled: boolean): void;
  /** 当前模型可用的动作组名。 */
  listMotions(): string[];
  /** 当前模型可用的表情名。 */
  listExpressions(): string[];
  /** 当前状态快照。 */
  status(): MascotStatus;
  /** 释放资源：移除监听、取消动画、销毁渲染实例。幂等，可多次调用。 */
  destroy(): void;
}
