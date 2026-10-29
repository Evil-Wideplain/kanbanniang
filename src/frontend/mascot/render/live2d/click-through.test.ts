/**
 * 鼠标穿透判定单测（纯逻辑）：按下抑制、拖动续期、拖动结束恢复、普通点击恢复、
 * 首次采样必下发、结果未变不下发（避免每帧 IPC）。用假时间戳驱动，不依赖 Tauri/DOM。
 */
import { describe, expect, it } from "vitest";
import { resolveClickThrough, type ClickThroughInput } from "./click-through";

/** 构造判定输入：默认「无按下、刚采样过、光标不在角色上」。 */
function input(over: Partial<ClickThroughInput> = {}): ClickThroughInput {
  return {
    now: 1000,
    pointerDown: false,
    pointerDownAt: 0,
    windowMovedAt: 0,
    dragHoldMs: 350,
    lastOnMascot: true,
    onMascot: false,
    ...over,
  };
}

describe("穿透判定：翻转与去重", () => {
  it("首次采样（lastOnMascot=null）总是下发一次", () => {
    const off = resolveClickThrough(input({ lastOnMascot: null, onMascot: false }));
    expect(off).toEqual({ pointerDown: false, lastOnMascot: false, ignore: true });
    const on = resolveClickThrough(input({ lastOnMascot: null, onMascot: true }));
    expect(on).toEqual({ pointerDown: false, lastOnMascot: true, ignore: false });
  });

  it("命中结果未变时不下发（no ignore）", () => {
    expect(resolveClickThrough(input({ lastOnMascot: false, onMascot: false })).ignore).toBeNull();
    expect(resolveClickThrough(input({ lastOnMascot: true, onMascot: true })).ignore).toBeNull();
  });

  it("光标进入角色 → 关闭穿透；离开角色 → 开启穿透", () => {
    expect(resolveClickThrough(input({ lastOnMascot: false, onMascot: true })).ignore).toBe(false);
    expect(resolveClickThrough(input({ lastOnMascot: true, onMascot: false })).ignore).toBe(true);
  });
});

describe("穿透判定：按下抑制", () => {
  it("按下后未到阈值：即使命中翻转也保持原状态、不下发", () => {
    const decision = resolveClickThrough(
      input({ pointerDown: true, pointerDownAt: 900, now: 1000, dragHoldMs: 350 }),
    );
    expect(decision).toEqual({ pointerDown: true, lastOnMascot: true, ignore: null });
  });

  it("窗口持续移动会续期抑制（OS 模态拖动期间收不到 pointerup 也不切换）", () => {
    // 按下在 900ms，窗口刚在 1400ms 又移动过：距 1400 才过去 100ms，仍抑制
    const decision = resolveClickThrough(
      input({
        pointerDown: true,
        pointerDownAt: 900,
        windowMovedAt: 1400,
        now: 1500,
        dragHoldMs: 350,
      }),
    );
    expect(decision.pointerDown).toBe(true);
    expect(decision.ignore).toBeNull();
  });

  it("按下后超过阈值：自动解除抑制并跟随命中结果", () => {
    const decision = resolveClickThrough(
      input({
        pointerDown: true,
        pointerDownAt: 500,
        windowMovedAt: 0,
        now: 1000,
        dragHoldMs: 350,
        lastOnMascot: true,
        onMascot: false,
      }),
    );
    expect(decision).toEqual({ pointerDown: false, lastOnMascot: false, ignore: true });
  });

  it("普通点击（窗口没动）也在阈值后恢复：按住不放不会永久抑制", () => {
    const stillHeld = resolveClickThrough(
      input({ pointerDown: true, pointerDownAt: 100, now: 400, lastOnMascot: false }),
    );
    expect(stillHeld.pointerDown).toBe(true);
    expect(stillHeld.ignore).toBeNull();
    const recovered = resolveClickThrough(
      input({ pointerDown: true, pointerDownAt: 100, now: 460, lastOnMascot: false, onMascot: true }),
    );
    expect(recovered.pointerDown).toBe(false);
    expect(recovered.ignore).toBe(false);
  });
});
