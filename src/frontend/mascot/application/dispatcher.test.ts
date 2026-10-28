/**
 * 应用层分发单测：`handleCommand` 的动作 → 控制器调用 → MascotResult 成型。
 * 分发逻辑不触碰 DOM / Tauri，控制器与上下文均以替身注入，故在 node 环境可测。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MascotAction, MascotCommand, MascotController, MascotStatus } from "@/shared/domain/types";
import { handleCommand, type CommandCtx } from "./dispatcher";

// 分发会输出预期的 info/warn/error 日志；静音以免噪声淹没测试结果（不影响断言的返回值）。
beforeAll(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

/** 构造指令（id 固定，便于断言回传 id 原样带回）。 */
function cmd(action: MascotAction, params: Record<string, unknown> = {}): MascotCommand {
  return { id: "req-1", action, params };
}

/** 构造控制器替身，可覆盖单个方法（默认行为足够跑通用例）。 */
function fakeController(over: Partial<MascotController> = {}): MascotController {
  const status: MascotStatus = {
    mode: "live2d",
    model: null,
    expression: "neutral",
    position: { x: 0.5, y: 0.9 },
    speaking: false,
  };
  return {
    playMotions: () => [],
    expression: () => ({ applied: "neutral", fallback: false }),
    speak: () => {},
    setSpeechSink: () => {},
    moveTo: () => {},
    idle: () => {},
    setGaze: () => {},
    listMotions: () => ["idle"],
    listExpressions: () => ["neutral"],
    status: () => status,
    destroy: () => {},
    ...over,
  };
}

/** 同步动作直接返回结果；异步动作（move / set_model）返回 Promise，统一 await。 */
function run(action: MascotAction, params: Record<string, unknown>, c: MascotController | null, ctx?: CommandCtx) {
  return Promise.resolve(handleCommand(cmd(action, params), c, ctx));
}

describe("handleCommand 动作型", () => {
  it("play_motion 缺少 steps 时回 fail（不再接受扁平 motion 参数）", async () => {
    const res = await run("play_motion", { motion: "wave" }, fakeController());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("steps 必须是非空数组");
  });

  it("speak 只走控制器（气泡唯一出口在控制器的 speechSink）", async () => {
    const said: string[] = [];
    const c = fakeController({ speak: (text) => void said.push(text) });
    const res = await run("speak", { text: "你好" }, c);
    expect(said).toEqual(["你好"]);
    expect(res.ok).toBe(true);
    expect(res.result).toBe("ok");
  });

  it("move_in_window 移动控制器锚点并回 ok", async () => {
    let seen: [number, number] | undefined;
    const c = fakeController({ moveTo: (x, y) => (seen = [x, y]) });
    const res = await run("move_in_window", { x: 0.2, y: 0.8 }, c);
    expect(seen).toEqual([0.2, 0.8]);
    expect(res.result).toBe("ok");
  });

  it("set_idle 回到待机并回 ok", async () => {
    let called = false;
    const c = fakeController({ idle: () => (called = true) });
    const res = await run("set_idle", {}, c);
    expect(called).toBe(true);
    expect(res.result).toBe("ok");
  });
});

describe("handleCommand 查询型", () => {
  it("list_motions / list_expressions 回传数组", async () => {
    const c = fakeController({ listMotions: () => ["a", "b"], listExpressions: () => ["x"] });
    expect((await run("list_motions", {}, c)).result).toEqual(["a", "b"]);
    expect((await run("list_expressions", {}, c)).result).toEqual(["x"]);
  });

  it("get_status 原样回传状态快照", async () => {
    const st = fakeController().status();
    const res = await run("get_status", {}, fakeController());
    expect(res.result).toEqual(st);
  });

  it("list_models 只含 Live2D 档案，current 来自控制器状态", async () => {
    const c = fakeController({ status: () => ({ ...fakeController().status(), modelId: "haru" }) });
    const res = (await run("list_models", {}, c)).result as {
      current: string;
      default: string;
      models: { id: string; mode: string }[];
    };
    expect(res.current).toBe("haru");
    expect(res.models.every((m) => m.mode === "live2d")).toBe(true);
    expect(res.models.some((m) => m.id === "fallback")).toBe(false);
  });
});

describe("handleCommand 动作序列", () => {
  it("play_motion 把规整后的步骤交给控制器，并回传每步结果", async () => {
    let seen: { motion: string; index?: number; holdMs?: number }[] | undefined;
    const c = fakeController({
      playMotions: (steps) => {
        seen = steps;
        return steps.map((s) => ({
          requested: s.motion,
          applied: "TapBody",
          fallback: true,
          index: s.index,
          holdMs: s.holdMs,
        }));
      },
    });
    const res = await run(
      "play_motion",
      { steps: [{ motion: "wave" }, { motion: "Idle", index: 1.7, holdMs: 99999 }] },
      c,
    );
    expect(seen).toEqual([{ motion: "wave" }, { motion: "Idle", index: 1, holdMs: 5000 }]);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual([
      { requested: "wave", applied: "TapBody", fallback: true, index: undefined, holdMs: undefined },
      { requested: "Idle", applied: "TapBody", fallback: true, index: 1, holdMs: 5000 },
    ]);
  });

  it("play_motion 规整 holdMs：负数截断到 0 并告警", async () => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    let seen: { motion: string; holdMs?: number }[] | undefined;
    const c = fakeController({
      playMotions: (steps) => {
        seen = steps;
        return [];
      },
    });
    await run("play_motion", { steps: [{ motion: "Idle", holdMs: -20 }] }, c);
    expect(seen).toEqual([{ motion: "Idle", holdMs: 0 }]);
    // 静默容错必须留痕：规整动作要能查
    expect(warn.mock.calls.some((call) => String(call[0]).includes("参数已规整"))).toBe(true);
  });

  it("play_motion 拒绝 name 别名与非法的 index（负面 index 按随机并告警）", async () => {
    const c = fakeController({ playMotions: () => [] });
    const named = await run("play_motion", { steps: [{ name: "Idle" }] }, c);
    expect(named.ok).toBe(false);
    expect(named.error).toContain("第 1 步缺少 motion");

    let seen: { motion: string; index?: number }[] | undefined;
    const c2 = fakeController({
      playMotions: (steps) => {
        seen = steps;
        return [];
      },
    });
    await run("play_motion", { steps: [{ motion: "Idle", index: -3 }] }, c2);
    expect(seen).toEqual([{ motion: "Idle" }]);
  });

  it("play_motion 透传每步的 expression / text（空串按未给处理）", async () => {
    let seen: { motion: string; expression?: string; text?: string }[] | undefined;
    const c = fakeController({
      playMotions: (steps) => {
        seen = steps;
        return [];
      },
    });
    await run(
      "play_motion",
      {
        steps: [
          { motion: "TapBody", expression: "F01", text: "你好" },
          { motion: "Idle", expression: "  ", text: "" },
        ],
      },
      c,
    );
    expect(seen).toEqual([{ motion: "TapBody", expression: "F01", text: "你好" }, { motion: "Idle" }]);
  });

  it("play_motion 不接受字符串形式的 steps（JSON 解析留在调试面板层）", async () => {
    const c = fakeController({ playMotions: () => [] });
    const res = await run("play_motion", { steps: '[{"motion":"Idle"}]' }, c);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("steps 必须是非空数组");
  });

  it("play_motion 规整告警按「步号 + 问题」结构化落日志", async () => {
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const c = fakeController({ playMotions: () => [] });
    await run("play_motion", { steps: [{ motion: "Idle" }, { motion: "Idle", holdMs: 99999 }] }, c);
    const payloads = warn.mock.calls
      .filter((call) => String(call[0]).includes("参数已规整"))
      .map((call) => call[1] as { step: number; problem: string });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.step).toBe(2);
    expect(payloads[0]?.problem).toContain("holdMs");
  });

  it("play_motion 逐条记录每步结果日志（便于排查未生效/回退）", async () => {
    const info = vi.mocked(console.info);
    info.mockClear();
    const c = fakeController({
      playMotions: (steps) =>
        steps.map((s) => ({ requested: s.motion, applied: "TapBody", fallback: false })),
    });
    await run("play_motion", { steps: [{ motion: "idle" }, { motion: "wave" }] }, c);
    const messages = info.mock.calls.map((call) => String(call[0]));
    // 只约束「每步都留痕」，不锁死具体文案（文案属实现细节，调整不应弄红测试）
    const stepLogs = messages.filter((m) => m.includes("play_motion 第"));
    expect(stepLogs.length).toBeGreaterThanOrEqual(2);
    expect(stepLogs.every((m) => m.includes("play_motion 第"))).toBe(true);
  });

  it("play_motion 透传 idle 开关（播完后调用 set_idle，兼容字符串 true）", async () => {
    let seenIdle: boolean | undefined;
    const c = fakeController({
      playMotions: (_steps, options) => {
        seenIdle = options?.idle;
        return [];
      },
    });
    await run("play_motion", { steps: [{ motion: "Idle" }], idle: true }, c);
    expect(seenIdle).toBe(true);

    await run("play_motion", { steps: [{ motion: "Idle" }], idle: "true" }, c);
    expect(seenIdle).toBe(true);

    await run("play_motion", { steps: [{ motion: "Idle" }] }, c);
    expect(seenIdle).toBe(false);
  });

  it("play_motion 非法 steps 回 fail 且不触碰控制器", async () => {
    let called = false;
    const c = fakeController({
      playMotions: () => {
        called = true;
        return [];
      },
    });
    const empty = await run("play_motion", { steps: [] }, c);
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("非空数组");

    const notArray = await run("play_motion", { steps: "Idle" }, c);
    expect(notArray.ok).toBe(false);

    const missing = await run("play_motion", { steps: [{ index: 1 }] }, c);
    expect(missing.error).toContain("第 1 步缺少 motion");

    expect(called).toBe(false);
  });

  it("play_motion 不设步数上限（长队列整段交给控制器）", async () => {
    let seen: { motion: string }[] | undefined;
    const c = fakeController({
      playMotions: (steps) => {
        seen = steps;
        return steps.map((s) => ({ requested: s.motion, applied: "Idle", fallback: false }));
      },
    });
    const res = await run(
      "play_motion",
      { steps: Array.from({ length: 30 }, () => ({ motion: "Idle" })) },
      c,
    );
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(30);
    expect((res.result as unknown[]).length).toBe(30);
  });

  it("play_motion 在未加载看板娘时回失败", async () => {
    const res = await run("play_motion", { steps: [{ motion: "Idle" }] }, null);
    expect(res).toEqual({ id: "req-1", ok: false, result: null, error: "看板娘未加载（没有可用 Live2D 模型）" });
  });
});

describe("handleCommand 异步 / 失败路径", () => {
  it("move 缺上下文时回 ok=false 信封", async () => {
    const res = await run("move", { x: 0.1, y: 0.2 }, fakeController());
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ ok: false });
  });

  it("move 透传窗口移动结果，异常转 ok=false 信封", async () => {
    const okCtx = { setModel: async () => ({ ok: true, model: "", mode: "live2d", modelFile: null }), currentModelId: () => "", moveWindow: async () => ({ x: 0.1, y: 0.2, physicalX: 0, physicalY: 0, clamped: false, superseded: false }) } as CommandCtx;
    const okRes = await run("move", { x: 0.1, y: 0.2 }, fakeController(), okCtx);
    expect(okRes.result).toMatchObject({ x: 0.1, superseded: false });

    const badCtx = { ...okCtx, moveWindow: async () => { throw new Error("失败原因"); } } as CommandCtx;
    const badRes = await run("move", { x: 0.1, y: 0.2 }, fakeController(), badCtx);
    expect(badRes.result).toMatchObject({ ok: false, error: "失败原因" });
  });

  it("set_model 缺上下文回 ok=false；异常转 ok=false 信封", async () => {
    const missing = await run("set_model", { model: "haru" }, fakeController());
    expect(missing.result).toMatchObject({ ok: false });

    const okCtx = { setModel: async () => ({ ok: true, model: "haru", mode: "live2d", modelFile: "Haru.moc3" }), currentModelId: () => "haru" } as CommandCtx;
    expect((await run("set_model", { model: "haru" }, fakeController(), okCtx)).result).toMatchObject({ ok: true, model: "haru" });

    const badCtx = { ...okCtx, setModel: async () => { throw new Error("切换失败"); } } as CommandCtx;
    expect((await run("set_model", { model: "haru" }, fakeController(), badCtx)).result).toMatchObject({
      ok: false,
      error: "切换失败",
    });
  });

  it("未知动作走穷尽性兜底并回 fail（运行时防越界）", async () => {
    const res = await run("bogus" as unknown as MascotAction, {}, fakeController());
    expect(res.ok).toBe(false);
    expect(res.error).toContain("未知动作");
  });

  it("控制器抛异常时转 fail 并不外溢", async () => {
    const c = fakeController({
      playMotions: () => {
        throw new Error("控制器异常");
      },
    });
    const res = await run("play_motion", { steps: [{ motion: "wave" }] }, c);
    expect(res).toEqual({ id: "req-1", ok: false, result: null, error: "控制器异常" });
  });

  it("未加载看板娘时动作回失败，但 set_model 仍可恢复", async () => {
    const res = await run("play_motion", { steps: [{ motion: "wave" }] }, null);
    expect(res).toEqual({ id: "req-1", ok: false, result: null, error: "看板娘未加载（没有可用 Live2D 模型）" });

    const ctx = { setModel: async () => ({ ok: true, model: "haru", mode: "live2d", modelFile: "Haru.moc3" }), currentModelId: () => "" } as CommandCtx;
    expect((await run("set_model", { model: "haru" }, null, ctx)).result).toMatchObject({ ok: true, model: "haru" });
  });
});
