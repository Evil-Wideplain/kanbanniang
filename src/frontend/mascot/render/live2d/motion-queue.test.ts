/**
 * 串行动作队列单测（假端口 + 假计时器，无 pixi / DOM）：
 * 覆盖「等每步真正播完」、已在播的目标动画、拒绝跳过、holdMs、打断（token 作废）、
 * 销毁清理、异常兜底与计时器不残留。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PLAY_MOTION_STEP_WAIT_MS } from "@/shared/domain/motion-limits";
import type { PlannedMotionStep } from "./motion-catalog";
import { MotionQueue, type MotionQueuePort, type QueueScheduler } from "./motion-queue";

/** 假计时器：手动推进时间，用于验证 holdMs 与兜底上限，并检查是否有计时器残留。 */
class FakeScheduler implements QueueScheduler {
  private nextId = 1;
  private readonly tasks = new Map<number, { fn: () => void; at: number }>();
  private now = 0;

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + ms });
    return id;
  }

  clearTimeout(id: number): void {
    this.tasks.delete(id);
  }

  /** 当前登记的计时器数量（用于断言清理是否彻底）。 */
  get size(): number {
    return this.tasks.size;
  }

  /** 把所有到期任务执行一次（内部按登记顺序）。 */
  advance(ms: number): void {
    this.now += ms;
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.now) {
        this.tasks.delete(id);
        task.fn();
      }
    }
  }
}

/** 假端口：记录下发/表情/台词，`finish()` 模拟库的 motionFinish 事件。 */
function createPort() {
  const record = {
    started: [] as string[],
    expressions: [] as string[],
    speeches: [] as string[],
    finishToIdle: 0,
    disposed: false,
  };
  let playing = false;
  let finishCb: (() => void) | null = null;
  const port: MotionQueuePort = {
    startMotion: async (group, index) => {
      record.started.push(`${group}#${index}`);
      playing = true;
      return "started";
    },
    onMotionFinish: (cb) => {
      finishCb = cb;
      return () => {
        if (finishCb === cb) finishCb = null;
      };
    },
    isMotionPlaying: () => playing,
    applyExpression: (name) => {
      record.expressions.push(name);
      return { applied: name, fallback: false };
    },
    showSpeech: (text) => record.speeches.push(text),
    finishToIdle: () => {
      record.finishToIdle += 1;
    },
    isDisposed: () => record.disposed,
  };
  return {
    port,
    record,
    /** 模拟一步动作播完（MotionManager 的 motionFinish）。 */
    finish(): void {
      playing = false;
      finishCb?.();
    },
    setPlaying(value: boolean): void {
      playing = value;
    },
  };
}

/** 构造计划步骤（默认单步、无 holdMs）。 */
function step(group: string, index = 0, holdMs?: number): PlannedMotionStep {
  return { requested: group, fallback: false, target: { group, index }, holdMs };
}

/** 让微任务与宏任务跑完（队列的 await 链推进）。 */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  // 队列按设计会打日志；静音以免噪声淹没测试结果
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.clearAllMocks());

describe("MotionQueue：串行等待", () => {
  it("单步：下发后等 motionFinish，播完才结束且不残留兜底计时器", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle")], { external: true });
    await tick();
    expect(h.record.started).toEqual(["Idle#0"]);
    expect(queue.isActive()).toBe(true);
    expect(queue.isExternal()).toBe(true);
    // 正在等动作结束：兜底计时器已登记
    expect(sched.size).toBe(1);

    h.finish();
    await tick();
    expect(queue.isActive()).toBe(false);
    expect(queue.isExternal()).toBe(false);
    // 兜底计时器必须随动作结束一起清掉（否则序列结束后会残留到销毁后）
    expect(sched.size).toBe(0);
  });

  it("库里已在播的目标动画（自动待机）同样等它播完", async () => {
    const h = createPort();
    h.port.startMotion = async (group, index) => {
      h.record.started.push(`${group}#${index}`);
      h.setPlaying(true);
      return "already-playing";
    };
    const queue = new MotionQueue(h.port, new FakeScheduler());

    queue.start([step("Idle")]);
    await tick();
    expect(queue.isActive()).toBe(true); // 没有立刻跳过
    // 未显式声明 external（点击/说话等内部单步）：既在播也不是外部队列
    expect(queue.isExternal()).toBe(false);

    h.finish();
    await tick();
    expect(queue.isActive()).toBe(false);
  });

  it("库拒绝的下发跳过等待，直接进下一步", async () => {
    const h = createPort();
    h.port.startMotion = async (group, index) => {
      h.record.started.push(`${group}#${index}`);
      if (group === "Missing") return "rejected";
      h.setPlaying(true);
      return "started";
    };
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Missing"), step("Idle")]);
    await tick();
    await tick();
    expect(h.record.started).toEqual(["Missing#0", "Idle#0"]);
    expect(queue.isActive()).toBe(true);
  });

  it("holdMs 是播完后的额外停留，到时才进下一步", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle", 0, 500), step("TapBody")]);
    await tick();
    h.finish();
    await tick();
    // 动作已播完，现在停在 holdMs 计时上
    expect(h.record.started).toEqual(["Idle#0"]);
    expect(sched.size).toBe(1);

    sched.advance(500);
    await tick();
    expect(h.record.started).toEqual(["Idle#0", "TapBody#0"]);
  });

  it("动作迟迟不结束：到兜底上限放行，不会永久卡住队列", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle")]);
    await tick();
    sched.advance(PLAY_MOTION_STEP_WAIT_MS);
    await tick();
    expect(queue.isActive()).toBe(false);
    expect(sched.size).toBe(0);
  });
});

describe("MotionQueue：打断与清理", () => {
  it("打断后旧续体不再下发后续步骤，计时器全部清空", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle"), step("TapBody")]);
    await tick();
    expect(h.record.started).toEqual(["Idle#0"]);

    queue.interrupt("测试打断");
    expect(queue.isActive()).toBe(false);
    expect(sched.size).toBe(0);

    // 旧动作的 finish 事件对已作废的序列无效
    h.finish();
    await tick();
    expect(h.record.started).toEqual(["Idle#0"]);
  });

  it("打断在 holdMs 停留期间也能清掉计时器", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle", 0, 500), step("TapBody")]);
    await tick();
    h.finish();
    await tick();
    expect(sched.size).toBe(1);

    queue.interrupt("改为播放新的动作");
    expect(sched.size).toBe(0);
    expect(queue.isActive()).toBe(false);
  });

  it("dispose 后挂起等待被放行，队列不再推进", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle"), step("TapBody")]);
    await tick();
    queue.dispose();
    h.finish();
    await tick();
    expect(h.record.started).toEqual(["Idle#0"]);
    expect(queue.isActive()).toBe(false);
    expect(sched.size).toBe(0);
  });

  it("新队列打断旧队列（token 作废旧续体）", async () => {
    const h = createPort();
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle"), step("TapBody")]);
    await tick();
    queue.start([step("m01")]);
    await tick();
    expect(h.record.started).toEqual(["Idle#0", "m01#0"]);

    h.finish(); // 旧序列的 finish 已无效
    await tick();
    expect(queue.isActive()).toBe(false);
  });

  it("被更新指令取代的步骤（superseded）直接丢弃，不空等", async () => {
    const h = createPort();
    h.port.startMotion = async (group, index) => {
      h.record.started.push(`${group}#${index}`);
      return "superseded";
    };
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle"), step("TapBody")]);
    await tick();
    await tick();
    expect(h.record.started).toEqual(["Idle#0", "TapBody#0"]);
    expect(queue.isActive()).toBe(false);
    expect(sched.size).toBe(0);
  });

  it("队列内异常不外泄：active 复位、计时器清空，并记录 error", async () => {
    const h = createPort();
    h.port.startMotion = async () => {
      throw new Error("端口异常");
    };
    const sched = new FakeScheduler();
    const queue = new MotionQueue(h.port, sched);

    queue.start([step("Idle")]);
    await tick();
    expect(console.error).toHaveBeenCalled();
    expect(queue.isActive()).toBe(false);
    expect(sched.size).toBe(0);
  });
});

describe("MotionQueue：氛围反馈", () => {
  it("每步先换表情、再说台词，表情回退走 warn", async () => {
    const h = createPort();
    h.port.applyExpression = (name) => {
      h.record.expressions.push(name);
      return { applied: null, fallback: true };
    };
    const queue = new MotionQueue(h.port, new FakeScheduler());

    queue.start([{ ...step("Idle"), expression: "F01", text: "你好" }]);
    await tick();
    expect(h.record.expressions).toEqual(["F01"]);
    expect(h.record.speeches).toEqual(["你好"]);
    expect(console.warn).toHaveBeenCalled();
  });

  it("resetToIdle 在序列播完后回待机一次", async () => {
    const h = createPort();
    const queue = new MotionQueue(h.port, new FakeScheduler());

    queue.start([step("Idle")], { resetToIdle: true, external: true });
    await tick();
    h.finish();
    await tick();
    expect(h.record.finishToIdle).toBe(1);
  });

  it("无可用目标（target=null）的步骤跳过并告警", async () => {
    const h = createPort();
    const queue = new MotionQueue(h.port, new FakeScheduler());

    queue.start([{ requested: "wave", fallback: false, target: null }]);
    await tick();
    expect(h.record.started).toEqual([]);
    expect(queue.isActive()).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });
});
