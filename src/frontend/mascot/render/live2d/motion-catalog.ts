/**
 * 动作目录（渲染层纯逻辑）：把调用名解析为模型里的真实组名、挑变体序号、
 * 把指令步骤计划成可执行步骤。不依赖 pixi / DOM，单测见 motion-catalog.test.ts。
 */
import type { MotionStep } from "@/shared/domain/types";
import { norm } from "@/shared/domain/normalize";

/** 从池中随机取一个元素；空池返回 undefined。 */
export function pickRandom<T>(items: T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

/** 动作名解析结果。 */
export interface ResolvedMotion {
  /** 解析出的真实动作组名。 */
  group: string;
  /** 是否走了回退策略（未命中任何组，随机挑了点触动作）。 */
  fallback: boolean;
}

/** 解析出的可下发目标：group 与 index 必须同时存在。 */
export interface PlannedMotionTarget {
  /** 真实动作组名（宿主模型里存在的组）。 */
  group: string;
  /** 实际使用的变体序号。 */
  index: number;
}

/** 计划后的一步（target 为 null 表示模型里没有可执行的动作）。 */
export interface PlannedMotionStep {
  /** 调用方请求的原始名字。 */
  requested: string;
  /** 是否走了回退策略。 */
  fallback: boolean;
  /** 可执行目标；null 表示模型里没有可用动作（队列会跳过本步）。 */
  target: PlannedMotionTarget | null;
  /** 本步动作播完后的额外停留时长（毫秒），缺省 0 表示播完立刻进下一步。 */
  holdMs?: number;
  /** 本步开始时同时切换的表情（不打断动作）。 */
  expression?: string;
  /** 本步开始时同时说出的台词（交给组合根注入的气泡回调显示）。 */
  text?: string;
}

/** 计划阶段的告警（显式序号越界已改随机变体），由宿主决定怎么打日志。 */
export interface MotionPlanWarning {
  /** 告警类别：显式序号越界（已改为随机变体）。 */
  kind: "index-out-of-range";
  /** 调用方请求的原始名字。 */
  requested: string;
  group: string;
  /** 越界的显式序号。 */
  index: number;
  /** 该组的实际变体数量。 */
  count: number;
}

/** 计划结果：可执行步骤 + 需要宿主告警的输入问题。 */
export interface MotionPlan {
  steps: PlannedMotionStep[];
  warnings: MotionPlanWarning[];
}

/** 动作目录：组名、语义别名与变体数量由宿主（Live2D 模型定义）提供。 */
export interface MotionCatalog {
  /** 当前模型可用的动作组名（与宿主共享同一个数组引用，模型加载后原地填充）。 */
  readonly groups: string[];
  /** 动作名解析：别名/归一化命中即返回，否则回退点触动作；模型没有可用组时返回 null。 */
  resolve(name: string): ResolvedMotion | null;
  /** 某组的变体数量（拿不到定义时按 1，保证至少有可下发序号）。 */
  count(group: string): number;
  /** 组内随机变体序号；avoid 用于避开相邻两步的「同组同序号」（库会把这种请求当正在播而拒绝）。 */
  randomIndex(group: string, avoid?: number | null): number;
}

/** 构造动作目录。 */
export function createMotionCatalog(opts: {
  groups: string[];
  /** 语义别名表（键须已归一化：norm）。 */
  aliases: Record<string, string>;
  /** 某个动作组的变体数量。 */
  countOf: (group: string) => number;
}): MotionCatalog {
  const { groups, aliases, countOf } = opts;

  /** 语义解析：档案别名 → 归一化匹配；未命中返回 undefined。 */
  const resolveReal = (name: string): string | undefined => {
    const target = norm(name);
    const alias = aliases[target];
    if (alias) return alias;
    return groups.find((g) => norm(g) === target);
  };

  /** 变体数量：模型未提供定义时按 1 处理。 */
  const count = (group: string): number => {
    const n = countOf(group);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
  };

  return {
    groups,
    resolve(name: string): ResolvedMotion | null {
      const exact = resolveReal(name);
      if (exact) return { group: exact, fallback: false };
      // 未命中：回退点触动作（Tap* 优先）；没有点触组时退回除待机外的任意组
      const taps = groups.filter((g) => /^tap/i.test(g));
      const idleGroup = norm(aliases["idle"] ?? "idle");
      const pool = taps.length ? taps : groups.filter((g) => norm(g) !== idleGroup);
      const pick = pickRandom(pool);
      return pick ? { group: pick, fallback: true } : null;
    },
    count,
    randomIndex(group: string, avoid: number | null = null): number {
      const n = count(group);
      if (n <= 1) return 0;
      const base = Math.floor(Math.random() * n);
      return avoid === null || base !== avoid ? base : (base + 1) % n;
    },
  };
}

/**
 * 计划步骤：解析目标、校验显式序号（越界按未给处理，改随机变体）、相邻同组避开同序号。
 * 纯函数：不做日志也不下发动作，告警以返回值交给宿主。
 */
export function planSteps(catalog: MotionCatalog, steps: MotionStep[]): MotionPlan {
  const planned: PlannedMotionStep[] = [];
  const warnings: MotionPlanWarning[] = [];
  let prevGroup: string | null = null;
  let prevIndex: number | null = null;

  for (const step of steps) {
    const resolved = catalog.resolve(step.motion);
    if (!resolved) {
      planned.push({
        requested: step.motion,
        fallback: false,
        target: null,
        holdMs: step.holdMs,
        expression: step.expression,
        text: step.text,
      });
      continue;
    }
    // 显式序号越界时库会「先占位后判空」直接返回 false（日志上看不出原因）：
    // 提前校验，越界按未给处理（改随机变体）并回传告警，避免静默无反应。
    const count = catalog.count(resolved.group);
    if (step.index !== undefined && step.index >= count) {
      warnings.push({
        kind: "index-out-of-range",
        requested: step.motion,
        group: resolved.group,
        index: step.index,
        count,
      });
    }
    const explicitIndex = step.index !== undefined && step.index < count ? step.index : undefined;
    const avoid: number | null = resolved.group === prevGroup ? prevIndex : null;
    const index: number = explicitIndex ?? catalog.randomIndex(resolved.group, avoid);
    planned.push({
      requested: step.motion,
      fallback: resolved.fallback,
      target: { group: resolved.group, index },
      holdMs: step.holdMs,
      expression: step.expression,
      text: step.text,
    });
    prevGroup = resolved.group;
    prevIndex = index;
  }

  return { steps: planned, warnings };
}
