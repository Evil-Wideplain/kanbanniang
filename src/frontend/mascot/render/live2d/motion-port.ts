/**
 * 动作端口（渲染层）：`MotionQueuePort` 的 Live2D 实现——队列只认这个窄接口。
 *
 * 队列负责「按序等播完 / 打断 / 超时」，本类负责「怎么把一步真正交给库」：
 * 清理残留动作、序号串行化、把库的接受结果翻译成 started / already-playing / superseded / rejected。
 */
import type { ActionOutcome } from "@/shared/domain/types";
import { motionManagerOf, type MotionManagerLike, type Live2DModelLike } from "./model-introspection";
import type { MotionQueuePort, StartMotionResult } from "./motion-queue";

/** 动作端口依赖：模型句柄 + 状态查询 + 三个出站回调。 */
export interface MotionPortDeps {
  /** 当前模型句柄；未加载返回 null。 */
  model: () => Live2DModelLike | null;
  /** 控制器是否已销毁。 */
  isDisposed: () => boolean;
  /** 设置表情（队列步骤里的 expression）。 */
  applyExpression: (name: string) => ActionOutcome;
  /** 显示台词气泡（队列步骤里的 text）。 */
  showSpeech: (text: string) => void;
  /** 队列正常完成且 idle=true 时回待机。 */
  finishToIdle: () => void;
}

/** 动作端口：把队列的一步转成一次库调用，并回传库的真实接受情况。 */
export class MotionPort implements MotionQueuePort {
  /** 动作下发优先级（控制器装载库后覆盖为 MotionPriority.FORCE）。 */
  private priority = 3;
  /** 动作下发序号（越大越新）：过期请求不下发，避免旧动作在新动作之后落地。 */
  private startSeq = 0;
  /** 动作下发串行链：保证同一时刻只有一个 motion 请求在等模型文件加载。 */
  private startChain: Promise<void> = Promise.resolve();

  constructor(private deps: MotionPortDeps) {}

  /** 覆盖动作下发优先级（create() 里从库枚举取值后调用一次）。 */
  setPriority(priority: number): void {
    this.priority = priority;
  }

  /**
   * 下发一步动作并回传库的接受情况。
   * 先清掉库里自己的自动待机/残留动作：MotionState.reserve 对「同组同序号」的拒绝与优先级无关，
   * 而 MotionManager 在动作结束的同一 tick 就会自动接一段 Idle——不清掉的话，
   * Idle 组步骤会被当成「正在播」直接拒绝：既不播也不等，整段节奏被压缩。
   *
   * 下发串行化：队列每步都已 await，但「打断瞬间仍在等模型文件加载」的旧请求会晚于新请求落地，
   * 结果要么库报「同组同序号已预留」，要么旧动作最后覆盖新动作。这里用序号 + 串行链保证
   * 「最新的请求一定最后下发、过期请求不再下发」。
   * 该串行化只有并发实测覆盖（需真实 pixi 模型），日志查 `旧动作下发已被新指令取代`。
   */
  async startMotion(group: string, index: number): Promise<StartMotionResult> {
    const seq = ++this.startSeq;
    const task = this.startChain.then(
      async (): Promise<StartMotionResult> => await this.startMotionLatest(seq, group, index),
      async (): Promise<StartMotionResult> => await this.startMotionLatest(seq, group, index),
    );
    // 串行链只关心「上一个请求落地」，异常由 startMotionLatest 内部吃掉
    this.startChain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 真正下发一步动作：seq 已被更新请求超越时不下发（返回 superseded）。 */
  private async startMotionLatest(
    seq: number,
    group: string,
    index: number,
  ): Promise<StartMotionResult> {
    if (this.deps.isDisposed()) return "rejected";
    if (seq !== this.startSeq) return "superseded";
    const manager = this.motionManager();
    if (manager?.playing) this.stopAllMotionsQuietly();
    try {
      const model = this.deps.model();
      const accepted = Boolean(await Promise.resolve(model?.motion(group, index, this.priority)));
      // 加载期间来了更新的请求：把刚落地的旧动作停掉；本方法只清理并返回 superseded，
      // 真正的下发由新请求自己完成（避免同一次调用既清理又重下发造成双份动作）
      if (seq !== this.startSeq) {
        console.info("[mascot] 旧动作下发已被新指令取代，已清理，交由新请求下发", { group, index });
        this.stopAllMotionsQuietly();
        return "superseded";
      }
      if (accepted) return "started";
      const state = manager?.state;
      // 同组仍在播（清理与下发之间的竞态）：等它播完，不误报成失败
      if (state?.currentGroup === group) {
        console.info("[mascot] 该动作组已在播放，等待其结束", {
          group,
          index,
          currentIndex: state.currentIndex ?? null,
        });
        return "already-playing";
      }
      console.warn("[mascot] 动作未被接受（目标不存在或状态不允许）", { group, index });
      return "rejected";
    } catch (e) {
      // model.motion 抛错（模型未就绪等）：记录后按失败处理，队列跳过等待继续下一步
      console.warn("[mascot] 动作播放失败:", group, e);
      return "rejected";
    }
  }

  /** 静默清掉库里正在播的动作：库缺失或清理抛错都不影响后续下发，异常只记一次告警。 */
  private stopAllMotionsQuietly(): void {
    try {
      this.motionManager()?.stopAllMotions?.();
    } catch (e) {
      console.warn("[mascot] 清理残留动作失败:", e);
    }
  }

  /** 订阅库的动作结束事件（motionFinish），返回退订函数。 */
  onMotionFinish(cb: () => void): () => void {
    const manager = this.motionManager();
    if (!manager?.on) return () => {};
    manager.on("motionFinish", cb);
    return () => manager.off?.("motionFinish", cb);
  }

  /** 库里当前是否有动作在播。 */
  isMotionPlaying(): boolean {
    return this.motionManager()?.playing === true;
  }

  /** 应用表情（端口）：与 set_expression 共用同一条表情通道，不打断动作。 */
  applyExpression(name: string): ActionOutcome {
    return this.deps.applyExpression(name);
  }

  /** 显示台词气泡（端口）。 */
  showSpeech(text: string): void {
    this.deps.showSpeech(text);
  }

  /** 队列正常完成且 idle=true 时回待机（端口）。 */
  finishToIdle(): void {
    this.deps.finishToIdle();
  }

  /** 控制器是否已销毁（端口）。 */
  isDisposed(): boolean {
    return this.deps.isDisposed();
  }

  /** MotionManager 访问器：动作下发、结束事件、播放状态都从这里取。 */
  private motionManager(): MotionManagerLike | undefined {
    return motionManagerOf(this.deps.model());
  }
}
