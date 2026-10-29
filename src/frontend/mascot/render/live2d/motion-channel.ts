/**
 * 动作通道（渲染层）：动作播放入口 + 串行队列的持有者。
 *
 * 分工：`motion-port.ts` 负责「一步动作怎么交给库」，`motion-queue.ts` 负责「按序等播完 / 打断」，
 * 本类把它们接在一起，并对外提供控制器需要的播放入口：
 * MCP `play_motion`（`playMotions`）、点击反应（`onHit`）、说话手势（`speak`）、回到待机（`idle`）。
 */
import type {
  ActionOutcome,
  MotionPlayOptions,
  MotionStep,
  MotionStepOutcome,
} from "@/shared/domain/types";
import { norm } from "@/shared/domain/normalize";
import type { Live2DModelLike } from "./model-introspection";
import { pickRandom, planSteps, type MotionCatalog } from "./motion-catalog";
import { MotionPort } from "./motion-port";
import { MotionQueue } from "./motion-queue";

/** 动作通道依赖：控制器只提供「模型、销毁状态与三个出站回调」。 */
export interface MotionChannelDeps {
  /** 当前模型句柄；未加载返回 null。 */
  model: () => Live2DModelLike | null;
  /** 控制器是否已销毁。 */
  isDisposed: () => boolean;
  /** 设置表情（待机时复位为中性、队列步骤里的 expression）。 */
  applyExpression: (name: string) => ActionOutcome;
  /** 显示台词气泡。 */
  showSpeech: (text: string) => void;
}

/** 动作通道：持有队列与端口，对外只暴露「播放」语义的入口。 */
export class MotionChannel {
  /** 串行队列（点击反应 / 说话手势 / 待机 / MCP play_motion 共用）。 */
  readonly queue: MotionQueue;
  private port: MotionPort;

  constructor(
    private catalog: MotionCatalog,
    /** 模型动作组名；与 catalog.groups 共享同一数组引用（模型加载后原地填充）。 */
    private motions: string[],
    /** 归一化的语义别名 → 模型真实动作组名。 */
    private aliases: Record<string, string>,
    private deps: MotionChannelDeps,
  ) {
    this.port = new MotionPort({
      model: deps.model,
      isDisposed: deps.isDisposed,
      applyExpression: deps.applyExpression,
      showSpeech: deps.showSpeech,
      // 队列正常播完且调用方要求空闲时回待机（由本类统一处理表情复位）
      finishToIdle: () => this.idle(),
    });
    this.queue = new MotionQueue(this.port, window);
  }

  /** 覆盖动作下发优先级（控制器装载库后按库枚举取值调用一次）。 */
  setPriority(priority: number): void {
    this.port.setPriority(priority);
  }

  /**
   * 播放一串动作（MCP play_motion）：按顺序下发、每步等它真正播完，可被新指令打断。
   * 返回的是「已解析的计划值」——查询型工具必须 5s 内回传，真实播放结果（生效/回退）见日志。
   */
  playMotions(steps: MotionStep[], options: MotionPlayOptions = {}): MotionStepOutcome[] {
    const { steps: planned, warnings } = planSteps(this.catalog, steps);
    for (const w of warnings) console.warn("[mascot] 动作序号越界，改为随机变体", w);
    this.queue.start(planned, { resetToIdle: options.idle === true, external: true });
    return planned.map((step) => ({
      requested: step.requested,
      applied: step.target?.group ?? null,
      fallback: step.fallback,
      index: step.target?.index,
      holdMs: step.holdMs,
      expression: step.expression,
      text: step.text,
    }));
  }

  /**
   * 内部单步播放（点击反应 / 说话手势 / 待机）：与 MCP 队列共用同一条链路，
   * 但不算「外部队列」——这些动作期间 speak 不必抑制自己的肢体反馈。
   */
  private playOne(name: string, index?: number): void {
    const { steps } = planSteps(this.catalog, [{ motion: name, index }]);
    this.queue.start(steps, { external: false });
  }

  /** 点击反应：身体 → 点触动作；头部/其它 → 随机手势动作（m01… 优先）。 */
  onHit(areas: string[]): void {
    const names = (areas ?? []).map((a) => norm(a));
    if (names.some((a) => a.includes("body"))) {
      this.playOne("tap_body");
      return;
    }
    const gestures = this.motions.filter((g) => /^m\d+$/i.test(g));
    const pool = gestures.length ? gestures : this.motions;
    const pick = pickRandom(pool);
    if (!pick) return;
    this.playOne(pick, this.catalog.randomIndex(pick));
  }

  /**
   * 说话：先显示气泡（气泡唯一出口就是 speechSink），再决定是否播放手势。
   * Live2D 没有内建「说话」，这里额外播放档案指定的口语动作（默认 tap 类组）；
   * 真实口型需用 AudioEngine + Phoneme，超出当前范围。
   * 外部队列（MCP play_motion）期间只显示气泡，不打断正在播的动作序列。
   */
  speak(text: string): void {
    // 气泡必须无条件先落地：dispatcher 已不再提供 showBubble，漏掉这里等于说话无声。
    if (text) this.deps.showSpeech(text);
    if (this.queue.isExternal()) {
      console.info("[mascot] play_motion 播放中，说话只更新气泡，不打断动作");
      return;
    }
    this.playOne(this.aliases["speak"] ?? "tap_body", 0);
  }

  /** 回到待机：打断队列 → 复位中性表情 → 播待机动作。 */
  idle(): void {
    this.queue.interrupt("改为回到待机");
    this.deps.applyExpression("neutral");
    this.playOne("idle", 0);
  }
}
