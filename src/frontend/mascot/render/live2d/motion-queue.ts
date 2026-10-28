/**
 * 动作队列（渲染层串行播放状态机）：逐步下发、等每步真正播完、可被新指令打断。
 * 通过 `MotionQueuePort` 与具体 Live2D 实现解耦；计时器经 `QueueScheduler` 注入，
 * 因此 token 作废、打断清理、兜底放行等行为可在 node 环境用假端口 + 假计时器单测
 * （见 motion-queue.test.ts），不需要 pixi / DOM。
 */
import type { ActionOutcome } from "@/shared/domain/types";
import { PLAY_MOTION_STEP_WAIT_MS } from "@/shared/domain/motion-limits";
import type { PlannedMotionStep } from "./motion-catalog";

/** 计时器抽象：生产环境传 window，单测注入假实现。 */
export interface QueueScheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

/**
 * 单步下发结果：
 * - `started`：库已接受，开始播；
 * - `already-playing`：目标组正由库自己播（典型是自动待机），此时同样要等它播完；
 * - `rejected`：库明确拒绝（目标不存在 / 状态不允许），跳过本步等待，避免空等吃掉节奏；
 * - `superseded`：下发期间已被更新的指令取代（端口不再下发旧动作），本步直接丢弃。
 */
export type StartMotionResult = "started" | "already-playing" | "rejected" | "superseded";

/** 队列宿主端口：具体渲染实现提供（生产环境为 Live2DMascot）。 */
export interface MotionQueuePort {
  /** 下发一步动作（内部处理优先级与「清掉自动待机」）。 */
  startMotion(group: string, index: number): Promise<StartMotionResult>;
  /** 订阅动作结束事件，返回退订函数；无可监听的 MotionManager 时返回空函数。 */
  onMotionFinish(cb: () => void): () => void;
  /** 库当前是否有动作在播（用于补「监听挂上时动作已结束」的检查）。 */
  isMotionPlaying(): boolean;
  /** 应用表情（不打断动作），返回生效/回退结果供日志判定。 */
  applyExpression(name: string): ActionOutcome;
  /** 显示台词气泡。 */
  showSpeech(text: string): void;
  /** 队列正常完成、且 resetToIdle 为 true 时调用（复用 set_idle 语义）。 */
  finishToIdle(): void;
  /** 控制器是否已销毁：销毁后不再推进队列。 */
  isDisposed(): boolean;
}

/** 队列启动选项。 */
export interface QueueStartOptions {
  /** 整段播完后回到待机（对应 play_motion 的 idle 参数）。 */
  resetToIdle?: boolean;
  /**
   * 是否外部（MCP play_motion）队列。
   * `speak` 只在外部队列期间抑制肢体动作：点击反应 / 待机 / 说话手势不算外部。
   */
  external?: boolean;
}

/**
 * 串行动作队列：token 自增即作废旧序列；计时器与挂起等待统一登记，打断时一次性清理。
 * 生命周期：`start` → 每步 `startMotion` / 等播完 / `holdMs` → 完成（可选 `finishToIdle`）；
 * `interrupt` / `dispose` 可在任意时刻作废当前序列。
 */
export class MotionQueue {
  private token = 0;
  /** 队列状态：idle 无队列；internal 内部单步（点击/说话/待机）；external MCP play_motion。 */
  private state: "idle" | "internal" | "external" = "idle";
  private readonly timers = new Set<number>();
  private readonly waits = new Set<(ok: boolean) => void>();

  /** 构造队列：port 提供播放能力，scheduler 提供可清理的计时器。 */
  constructor(
    private readonly port: MotionQueuePort,
    private readonly scheduler: QueueScheduler,
  ) {}

  /** 队列是否在播（含内部单步：点击反应 / 说话手势 / 待机）。 */
  isActive(): boolean {
    return this.state !== "idle";
  }

  /** 是否是外部队列在播：只有此时才抑制 speak 的肢体动作。 */
  isExternal(): boolean {
    return this.state === "external";
  }

  /** 开始新队列（打断旧的）：steps 须先经 planSteps 解析，token 保证旧续体全部退出。 */
  start(steps: PlannedMotionStep[], options: QueueStartOptions = {}): void {
    this.interrupt("改为播放新的动作");
    const token = ++this.token;
    this.state = options.external === true ? "external" : "internal";
    // 队列内任何意外异常（如气泡回调抛错）都不能外泄成未处理的 Promise 拒绝，
    // 也不能让状态卡在非 idle 导致后续指令被当成「播放中」。
    void this.run(token, steps, options.resetToIdle === true).catch((e: unknown) => {
      console.error("[mascot] 连续动作执行异常", e);
      if (token === this.token) this.cleanup(true);
    });
  }

  /** 打断并清理：没有队列在播时也清理残留计时器/等待（只在该情况下不打日志）。 */
  interrupt(reason: string): void {
    const wasActive = this.isActive();
    this.cleanup(true);
    if (wasActive) console.info("[mascot] 连续动作被打断", { reason });
  }

  /** 控制器销毁：无条件清理，并放行所有挂起等待让 await 链退出。 */
  dispose(): void {
    this.cleanup(true);
  }

  /** 串行播放：每步等它真的播完，再按 holdMs 额外停留，然后进下一步。 */
  private async run(token: number, steps: PlannedMotionStep[], resetToIdle: boolean): Promise<void> {
    if (steps.length > 1) console.info("[mascot] 连续动作开始", { steps: steps.length });
    for (let i = 0; i < steps.length; i += 1) {
      if (!this.alive(token)) return;
      const step = steps[i];
      // 本步的氛围反馈先落地：换表情、显示台词（都不打断动作）
      if (step.expression) {
        const outcome = this.port.applyExpression(step.expression);
        const detail = { step: i + 1, requested: step.expression, applied: outcome.applied };
        if (outcome.applied === null || outcome.fallback) {
          console.warn("[mascot] 连续动作换表情回退", detail);
        } else {
          console.info("[mascot] 连续动作同步换表情", detail);
        }
      }
      if (step.text) this.port.showSpeech(step.text);
      if (!step.target) {
        console.warn("[mascot] 连续动作跳过（无可用目标）", { step: i + 1, requested: step.requested });
        continue;
      }
      const { group, index } = step.target;
      const result = await this.port.startMotion(group, index);
      if (!this.alive(token)) return;
      if (result === "superseded") {
        // 当前所有 startMotion 调用都来自队列，更新请求必然先作废旧 token，因此本分支实际不可达；
        // 保留以防御端口未来被非队列调用方使用。
        console.info("[mascot] 连续动作跳过（该步已被更新指令取代）", { step: i + 1, group, index });
        continue;
      }
      if (result === "rejected") {
        console.warn("[mascot] 连续动作跳过（动作未被接受）", {
          step: i + 1,
          requested: step.requested,
          group,
          index,
        });
        continue;
      }
      // started / already-playing 都要等这一步真正播完（后者正是库里正在播的目标动画）
      if (!(await this.waitMotionEnd(token, group, index))) return;
      if (!this.alive(token)) return;
      if (step.holdMs !== undefined && step.holdMs > 0) {
        if (!(await this.waitMs(token, step.holdMs))) return;
      }
    }
    if (!this.alive(token)) return;
    this.state = "idle";
    if (steps.length > 1) console.info("[mascot] 连续动作播放完成", { steps: steps.length });
    if (resetToIdle) {
      // 复用 set_idle 的语义（中性表情 + 待机动作），不另写一套复位逻辑
      console.info("[mascot] 连续动作播完，按 idle 参数调用 set_idle");
      this.port.finishToIdle();
    }
  }

  /** 当前续体是否仍有效：token 未被作废且控制器未销毁。 */
  private alive(token: number): boolean {
    return token === this.token && !this.port.isDisposed();
  }

  /** 清理计时器与挂起等待；notify 为 true 时把挂起等待以 false 放行。 */
  private cleanup(notify: boolean): void {
    this.token += 1;
    this.state = "idle";
    for (const id of this.timers) this.scheduler.clearTimeout(id);
    this.timers.clear();
    const waits = [...this.waits];
    this.waits.clear();
    if (notify) for (const done of waits) done(false);
  }

  /** 可被打断的固定等待：false 表示等待期间队列被打断或控制器已销毁。 */
  private waitMs(token: number, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let id = 0;
      const done = (ok: boolean): void => {
        this.scheduler.clearTimeout(id);
        this.timers.delete(id);
        this.waits.delete(done);
        resolve(ok && this.alive(token));
      };
      this.waits.add(done);
      id = this.scheduler.setTimeout(() => {
        this.timers.delete(id);
        done(true);
      }, ms);
      this.timers.add(id);
    });
  }

  /**
   * 等一步动作真正播完。
   * 用库的 `motionFinish` 事件（MotionManager 在动作结束时发出）而不是轮询状态：
   * `model.motion()` 是异步的，调用后立刻读状态会读不到本步，误判成「已播完」。
   * 上限只作兜底：个别模型/异常路径不触发该事件时按上限放行，避免队列永久卡住。
   */
  private waitMotionEnd(token: number, group: string, index: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let capId = 0;
      let off = (): void => {};
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        off();
        this.scheduler.clearTimeout(capId);
        this.timers.delete(capId);
        this.waits.delete(done);
        resolve(ok && this.alive(token));
      };
      this.waits.add(done);
      off = this.port.onMotionFinish(() => done(true));
      // 监听挂上时动作可能已经结束（极短动作）：补一次状态检查
      if (!this.port.isMotionPlaying()) {
        done(true);
        return;
      }
      capId = this.scheduler.setTimeout(() => {
        if (settled) return;
        console.warn("[mascot] 连续动作等待动作结束超时，按兜底放行", {
          group,
          index,
          capMs: PLAY_MOTION_STEP_WAIT_MS,
        });
        done(true);
      }, PLAY_MOTION_STEP_WAIT_MS);
      this.timers.add(capId);
    });
  }
}
