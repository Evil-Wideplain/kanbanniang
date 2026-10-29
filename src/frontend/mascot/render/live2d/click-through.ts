/**
 * 鼠标穿透判定（渲染层纯逻辑）：把「按下抑制 / 拖动计时 / 命中结果 / 上次已下发值」
 * 合成一次决策，渲染层只负责提供时间与命中结果、执行下发。
 *
 * 单独成纯函数的原因：这是穿透链路上唯一有状态的交互逻辑，抽出来才能用假时钟覆盖
 * 「拖动中 / 拖动结束 / 普通点击 / 首次采样」四种时序（见 click-through.test.ts），
 * 而不必依赖真实 Tauri 窗口与光标源。
 */

/** 判定输入：时间戳须与渲染层使用同一时钟（`performance.now()`）。 */
export interface ClickThroughInput {
  /** 当前时间（毫秒）。 */
  now: number;
  /** 是否处于按下状态（按下期间暂停切换，否则拖动窗口时光标滑出轮廓会中断拖拽）。 */
  pointerDown: boolean;
  /** 按下时刻（毫秒）。 */
  pointerDownAt: number;
  /** 窗口最后一次移动的时刻（毫秒）。 */
  windowMovedAt: number;
  /** 拖动结束后继续暂停切换的时长（毫秒）。 */
  dragHoldMs: number;
  /** 最近一次已下发的命中结果；null 表示尚未采样过。 */
  lastOnMascot: boolean | null;
  /** 本次采样是否落在角色像素上。 */
  onMascot: boolean;
}

/** 判定结果：调用方按 `ignore` 决定是否下发，并回写两个状态字段。 */
export interface ClickThroughDecision {
  /** 更新后的按下标志（抑制到期会自动清除）。 */
  pointerDown: boolean;
  /** 更新后的最近命中结果（未变化时原样返回）。 */
  lastOnMascot: boolean | null;
  /** 需要下发的整窗穿透值；null 表示状态未变、无需调用后端。 */
  ignore: boolean | null;
}

/**
 * 计算本次采样的穿透决策。
 *
 * 抑制规则：按下期间不切换，直到「按下」与「最后一次窗口移动」中较晚者已过去
 * `dragHoldMs`——拖动窗口时窗口持续移动会一直续期，所以 OS 模态拖动循环里
 * 收不到 pointerup 也能在松手后自动恢复；普通点击（窗口不动）同样在阈值后恢复。
 */
export function resolveClickThrough(input: ClickThroughInput): ClickThroughDecision {
  const { now, pointerDownAt, windowMovedAt, dragHoldMs, lastOnMascot, onMascot } = input;
  let pointerDown = input.pointerDown;
  if (pointerDown) {
    const since = Math.max(pointerDownAt, windowMovedAt);
    if (now - since < dragHoldMs) return { pointerDown, lastOnMascot, ignore: null };
    pointerDown = false; // 抑制到期：视为拖动/点击已结束
  }
  if (onMascot === lastOnMascot) return { pointerDown, lastOnMascot, ignore: null };
  // 命中结果翻转才下发：落在角色上 → 关闭穿透（ignore=false），落在空白 → 开启穿透
  return { pointerDown, lastOnMascot: onMascot, ignore: !onMascot };
}
