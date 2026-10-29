/**
 * 队列等待原语（渲染层）：可被打断的固定等待与「等一步动作真正播完」。
 *
 * 单独成模块的原因：两者都要登记计时器与挂起回调，打断时必须一次性清理并放行，
 * 这套簿记与队列的播放顺序无关，抽出来既避免队列文件过长，也让等待语义只有一处实现。
 * token 有效性由队列以 `isAlive` 回调注入，因此本模块不持有队列状态。
 */
import { PLAY_MOTION_STEP_WAIT_MS } from "@/shared/domain/motion-limits";
import type { MotionQueuePort, QueueScheduler } from "./motion-queue";

/** 可打断等待的簿记：计时器与挂起回调统一登记，清理时一并放行。 */
export class MotionWaits {
  private readonly timers = new Set<number>();
  private readonly waits = new Set<(ok: boolean) => void>();

  constructor(
    private readonly scheduler: QueueScheduler,
    /** 续体是否仍有效（token 未作废且控制器未销毁）。 */
    private readonly isAlive: (token: number) => boolean,
    /** 动作结束事件源（库的 motionFinish）。 */
    private readonly motion: Pick<MotionQueuePort, "onMotionFinish" | "isMotionPlaying">,
  ) {}

  /** 清理计时器与挂起等待；notify 为 true 时把挂起等待以 false 放行（打断/销毁）。 */
  cleanup(notify: boolean): void {
    for (const id of this.timers) this.scheduler.clearTimeout(id);
    this.timers.clear();
    const pending = [...this.waits];
    this.waits.clear();
    if (notify) for (const done of pending) done(false);
  }

  /** 可被打断的固定等待：false 表示等待期间队列被打断或控制器已销毁。 */
  wait(token: number, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let id = 0;
      const done = (ok: boolean): void => {
        this.scheduler.clearTimeout(id);
        this.timers.delete(id);
        this.waits.delete(done);
        resolve(ok && this.isAlive(token));
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
  waitMotionEnd(token: number, group: string, index: number): Promise<boolean> {
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
        resolve(ok && this.isAlive(token));
      };
      this.waits.add(done);
      off = this.motion.onMotionFinish(() => done(true));
      // 监听挂上时动作可能已经结束（极短动作）：补一次状态检查
      if (!this.motion.isMotionPlaying()) {
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
