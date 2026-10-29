/**
 * 模型自省（渲染层）：从 pixi-live2d-display 的模型句柄里按需读取内部字段。
 *
 * 库 0.4.0 不带类型声明，Cubism 4 与 Cubism 2 的内部结构又不一致，
 * 因此把「读哪些字段、各自怎么兜底」集中到本模块：动作下发、表情通道与列表查询
 * 都只经由这里取用模型内部数据，避免 `as any` 散落到各处。
 * 本文件不依赖 pixi / DOM，纯取值逻辑，可独立单测。
 */

/** pixi-live2d-display 的模型句柄（库 0.4.0 无类型声明）：统一在这一层按需取用内部字段。 */
export type Live2DModelLike = any;

/** 库内 MotionManager 的最小可用形态：只声明本仓库实际读取的字段。 */
export interface MotionManagerLike {
  /** 是否有动作正在播放（库的 playing 标志）。 */
  playing?: boolean;
  /** 当前动作状态（组名 + 变体序号），用于判断「同组是否已在播」。 */
  state?: { currentGroup?: string; currentIndex?: number };
  /** Cubism 4 的动作定义映射：{ 组名: [动作...] }。 */
  definitions?: Record<string, unknown[]>;
  /** 清掉所有正在播放的动作。 */
  stopAllMotions?: () => void;
  /** 订阅库的动作事件（如 motionFinish）。 */
  on?: (evt: string, cb: () => void) => void;
  /** 退订库的动作事件。 */
  off?: (evt: string, cb: () => void) => void;
}

/** 定义数组元素的最小形态：Cubism 2 / 4 用 `Name`，部分模型配置用 `name`。 */
interface NamedDefinition {
  Name?: unknown;
  name?: unknown;
}

/** 定义数组为空时的兜底变体数量：保证至少有可下发的序号 0。 */
const FALLBACK_MOTION_COUNT = 1;

/**
 * 从定义数组里取名字（保持 Name 优先、name 兜底的原有顺序）；缺名或空名的元素丢弃。
 * 数组元素若为 null 时访问属性仍会抛错——与搬迁前行为一致，不做静默吞错。
 */
function namesOf(defs: unknown[]): string[] {
  return defs
    .map((def: unknown): unknown => {
      const entry = def as NamedDefinition;
      return entry.Name ?? entry.name;
    })
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** MotionManager 访问器：动作下发、结束事件、播放状态都从这里取；模型未就绪时返回 undefined。 */
export function motionManagerOf(model: Live2DModelLike): MotionManagerLike | undefined {
  return model?.internalModel?.motionManager as MotionManagerLike | undefined;
}

/** 某动作组变体数量；模型未提供定义时按 1（保证至少有可下发序号）。 */
export function motionCountOf(model: Live2DModelLike, group: string): number {
  const definitions = motionManagerOf(model)?.definitions;
  const variants = definitions?.[group];
  // Cubism 2 的 definitions 是数组，按组名取不到元素，这里统一退回 1
  return Array.isArray(variants) ? variants.length : FALLBACK_MOTION_COUNT;
}

/** 解析可用动作组名（Cubism4 definitions / Cubism2 数组 / settings.motions / m.motions 兜底）。 */
export function resolveMotionGroups(model: Live2DModelLike): string[] {
  const m = model;
  const definitions: unknown = m?.internalModel?.motionManager?.definitions;
  // Cubism 4：definitions 是 { 组名: [动作...] } 映射
  if (definitions && typeof definitions === "object" && !Array.isArray(definitions)) {
    return Object.keys(definitions);
  }
  // Cubism 2 风格：数组，元素带 Name
  if (Array.isArray(definitions)) return namesOf(definitions);
  // 兜底：模型配置里的 motions 分组（旧路径与库自身字段）
  const settingsMotions: unknown = m?.internalModel?.settings?.motions;
  if (settingsMotions && typeof settingsMotions === "object") {
    return Object.keys(settingsMotions);
  }
  const modelMotions: unknown = m?.motions;
  if (modelMotions && typeof modelMotions === "object") return Object.keys(modelMotions);
  return [];
}

/** 解析可用表情名（m.expressions 优先，回退 expressionManager.definitions，异常返回空数组）。 */
export function resolveExpressionNames(model: Live2DModelLike): string[] {
  const m = model;
  // 库在模型实例上直接挂的 expressions 映射优先（键即表情名）
  if (m?.expressions && typeof m.expressions === "object") {
    return Object.keys(m.expressions as Record<string, unknown>);
  }
  try {
    const definitions: unknown = m.internalModel?.motionManager?.expressionManager?.definitions;
    // 非数组定义（含缺失）时保持原实现的空结果，不抛错
    return Array.isArray(definitions) ? namesOf(definitions) : [];
  } catch {
    // 模型内部结构异常（如未加载时字段链断开）：按无可用表情处理
    return [];
  }
}
