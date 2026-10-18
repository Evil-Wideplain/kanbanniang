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
    mode: "fallback",
    model: null,
    expression: "neutral",
    position: { x: 0.5, y: 0.9 },
    speaking: false,
  };
  return {
    motion: () => ({ applied: "idle", fallback: false }),
    expression: () => ({ applied: "neutral", fallback: false }),
    speak: () => {},
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
function run(action: MascotAction, params: Record<string, unknown>, c: MascotController, ctx?: CommandCtx) {
  return Promise.resolve(handleCommand(cmd(action, params), c, ctx));
}

describe("handleCommand 动作型", () => {
  it("play_motion 传递请求名与 index，回传真实生效结果", async () => {
    let seen: { name: string; index?: number } | undefined;
    const c = fakeController({
      motion: (name, index) => {
        seen = { name, index };
        return { applied: "TapBody", fallback: true, index: 2 };
      },
    });
    const res = await run("play_motion", { motion: "wave", index: 2 }, c);
    expect(seen).toEqual({ name: "wave", index: 2 });
    expect(res).toEqual({ id: "req-1", ok: true, result: { applied: "TapBody", fallback: true, index: 2 } });
  });

  it("play_motion 缺省名为 idle", async () => {
    let seen = "";
    const c = fakeController({ motion: (name) => ((seen = name), { applied: "idle", fallback: false }) });
    await run("play_motion", {}, c);
    expect(seen).toBe("idle");
  });

  it("speak 先走气泡回调，再驱动控制器", async () => {
    const order: string[] = [];
    const c = fakeController({ speak: () => order.push("controller") });
    await run("speak", { text: "你好" }, c, { showBubble: () => order.push("bubble"), setModel: async () => ({ ok: true, model: "", mode: "fallback", modelFile: null }), currentModelId: () => "fallback" });
    expect(order).toEqual(["bubble", "controller"]);
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

  it("list_models 含降级档案，current 来自控制器状态", async () => {
    const c = fakeController({ status: () => ({ ...fakeController().status(), modelId: "haru" }) });
    const res = (await run("list_models", {}, c)).result as {
      current: string;
      default: string;
      models: { id: string; mode: string }[];
    };
    expect(res.current).toBe("haru");
    expect(res.models.some((m) => m.id === "fallback" && m.mode === "fallback")).toBe(true);
  });
});

describe("handleCommand 异步 / 失败路径", () => {
  it("move 缺上下文时回 ok=false 信封", async () => {
    const res = await run("move", { x: 0.1, y: 0.2 }, fakeController());
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ ok: false });
  });

  it("move 透传窗口移动结果，异常转 ok=false 信封", async () => {
    const okCtx = { setModel: async () => ({ ok: true, model: "", mode: "fallback", modelFile: null }), currentModelId: () => "fallback", moveWindow: async () => ({ x: 0.1, y: 0.2, physicalX: 0, physicalY: 0, clamped: false, superseded: false }) } as CommandCtx;
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
      motion: () => {
        throw new Error("控制器异常");
      },
    });
    const res = await run("play_motion", { motion: "wave" }, c);
    expect(res).toEqual({ id: "req-1", ok: false, result: null, error: "控制器异常" });
  });
});
