/**
 * 交互（渲染层）：一条全局光标流同时驱动「全屏视线跟随」与「鼠标穿透判定」。
 *
 * 穿透原理：把渲染帧的 alpha 降采样成命中蒙版（`hit-mask.ts`），光标落在角色像素上时
 * 窗口保持可交互，落在空白处则通知组合根把整窗切为鼠标穿透（Tauri `set_click_through`）。
 *
 * 为什么必须常驻轮询：窗口一旦被设为穿透就不再收到任何鼠标消息，只能靠全局光标判定恢复。
 * 因此本层带 fail-safe：光标源不可用/停止、或超过心跳阈值没有采样时，主动把窗口恢复为
 * 可交互——穿透只是体验优化，绝不能让窗口整体失联。
 *
 * 判定本身是纯函数（`click-through.ts::resolveClickThrough`），本类只负责喂时间戳、
 * 执行下发与日志。
 */
import { startCursorTracking } from "@/shared/ipc/cursor";
import { resolveClickThrough } from "./click-through";
import { MascotHitTester, type InteractionBounds } from "./hit-testing";

/**
 * 拖动结束后继续暂停穿透判定的时长（毫秒）：以「窗口最后一次移动」为起点计算。
 * 不能用 pointerup 判断拖动结束——Tauri 的 startDragging 会进入 OS 模态拖动循环，
 * WebView 收不到 pointerup，按下标志只能靠这个「窗口停止移动」信号自动解除。
 */
const DRAG_HOLD_MS = 350;
/**
 * 光标心跳阈值（毫秒）：穿透开启期间超过该时长没有任何采样，就认为光标源已失效
 * （读取失败 / WebView 被节流），立即把窗口恢复为可交互，避免用户失去窗口操作能力。
 */
const CURSOR_WATCHDOG_MS = 1000;

/** 交互层依赖：由控制器提供画布、渲染器尺寸、命中判定输入与视线回调。 */
export interface InteractionDeps {
  /** 当前 WebGL 画布；未就绪返回 null。 */
  canvas: () => HTMLCanvasElement | null;
  /** 渲染器尺寸（CSS 像素）；未就绪返回 null。 */
  viewSize: () => { width: number; height: number } | null;
  /** 模型包围盒：命中蒙版不可用时的兜底；未就绪返回 null。 */
  bounds: () => InteractionBounds | null;
  /** 视线聚焦到画布坐标（全屏跟随）。 */
  focus: (x: number, y: number) => void;
  /** 视线复位到正前方。 */
  resetFocus: () => void;
}

/** 光标与穿透交互：常驻光标轮询、命中蒙版、穿透翻转、按下期抑制与失败兜底。 */
export class MascotInteraction {
  private cursorStop: (() => void) | null = null;
  /** 交互依赖（画布/尺寸/包围盒/视线回调）。 */
  private deps: InteractionDeps;
  /** 光标心跳定时器：检测「穿透开启但采样断流」并兜底复位。 */
  private watchdog: ReturnType<typeof setInterval> | undefined;
  /** 全屏视线跟随开关；轮询与穿透判定不依赖它。 */
  private gazeEnabled = false;

  // 鼠标穿透：渲染层只算「光标是否在角色像素上」，整窗开关由组合根注入执行
  private clickThroughSink: ((ignore: boolean) => void) | null = null;
  /** 最近一次命中结果；null 表示还没采样过（首次采样必下发一次）。 */
  private lastOnMascot: boolean | null = null;
  /** 按下期间不切换穿透，否则拖动窗口时光标滑出轮廓会把自己变成穿透状态、中断拖拽。 */
  private pointerDown = false;
  private pointerDownAt = 0;
  /** 窗口最后一次移动的时间戳：拖动窗口时持续刷新，用于判断拖动是否仍在进行。 */
  private windowMovedAt = 0;
  /** 最近一次光标采样的时间戳：穿透开启后若长期无采样，说明光标源已失效。 */
  private lastSampleAt = 0;
  private onWindowMoved = () => {
    this.windowMovedAt = performance.now();
  };
  private onPointerDown = () => {
    this.pointerDown = true;
    this.pointerDownAt = performance.now();
  };
  private onPointerUp = () => {
    this.pointerDown = false;
  };

  /** 命中判定（蒙版回读 + 包围盒兜底）；穿透判定的「是否落在角色像素上」全交给它。 */
  private hits: MascotHitTester;

  constructor(deps: InteractionDeps) {
    this.deps = deps;
    this.hits = new MascotHitTester(deps);
  }

  /**
   * 注入整窗穿透出口（组合根接到 Tauri `set_click_through`）。
   * 注入晚于首次采样时补发一次已有结果，避免窗口停在「全窗口可交互」状态。
   */
  setClickThroughSink(sink: (ignore: boolean) => void): void {
    this.clickThroughSink = sink;
    if (this.lastOnMascot !== null) sink(!this.lastOnMascot);
  }

  /** 开关全屏视线跟随（幂等）：只影响视线，不停止光标轮询（穿透判定仍需要它）。 */
  setGaze(enabled: boolean): void {
    if (this.gazeEnabled === enabled) return;
    this.gazeEnabled = enabled;
    if (enabled) {
      this.start();
      console.info("[mascot] 全屏视线跟随已开启");
      return;
    }
    this.deps.resetFocus();
    console.info("[mascot] 全屏视线跟随已关闭");
  }

  /** 启动光标轮询、按下监听与心跳兜底（幂等）。 */
  start(): void {
    if (this.cursorStop) return;
    // 第二参数是窗口移动回调：拖动期间靠它（而不是收不到的 pointerup）维持按下抑制；
    // 第三参数是光标源失败回调：立刻把窗口恢复为可交互（fail-safe）
    this.cursorStop = startCursorTracking(
      (p) => this.onCursor(p),
      () => this.onWindowMoved(),
      () => this.forceInteractive("全局光标源不可用"),
    );
    // 按下状态监听：只用于「按下期间不切穿透」，与拖拽/点击行为本身无关
    this.deps.canvas()?.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.watchdog = setInterval(() => this.checkCursorHeartbeat(), CURSOR_WATCHDOG_MS);
  }

  /** 停止轮询与监听，并把窗口恢复为可交互（幂等）。 */
  stop(): void {
    if (this.cursorStop) {
      this.cursorStop();
      this.cursorStop = null;
    }
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    this.deps.canvas()?.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    // 停止后没有任何 actor 还能判定光标：必须回到可交互，否则窗口会永久失联
    this.forceInteractive("交互层停止");
    this.deps.resetFocus();
  }

  /**
   * 强制窗口回到可交互（穿透关闭）并记一次告警。
   * 只在当前确实处于穿透态时下发；重复调用不会产生额外 IPC。
   */
  private forceInteractive(reason: string): void {
    if (this.lastOnMascot === true) return;
    this.lastOnMascot = true;
    if (!this.clickThroughSink) return;
    this.clickThroughSink(false);
    console.warn("[mascot] 鼠标穿透已复位为可交互:", reason);
  }

  /**
   * 光标回调（约 30Hz）：视线跟随按开关生效；穿透判定始终按角色像素命中执行。
   * 光标移出窗口时坐标会越界，此时命中判定为 false（窗口变穿透），正是期望行为。
   */
  private onCursor(p: { x: number; y: number }): void {
    this.lastSampleAt = performance.now();
    if (this.gazeEnabled) this.deps.focus(p.x, p.y);
    this.updateClickThrough(p.x, p.y);
  }

  /** 心跳兜底：穿透开启但长时间没有采样（光标源失效/被节流）时恢复可交互。 */
  private checkCursorHeartbeat(): void {
    if (this.lastOnMascot !== false) return; // 已可交互，无需兜底
    if (performance.now() - this.lastSampleAt <= CURSOR_WATCHDOG_MS) return;
    this.forceInteractive("光标采样中断（穿透态无法自行恢复）");
  }

  /** 按命中结果翻转穿透状态：只在翻转时通知组合根，避免每帧 invoke 后端。 */
  private updateClickThrough(x: number, y: number): void {
    const decision = resolveClickThrough({
      now: performance.now(),
      pointerDown: this.pointerDown,
      pointerDownAt: this.pointerDownAt,
      windowMovedAt: this.windowMovedAt,
      dragHoldMs: DRAG_HOLD_MS,
      lastOnMascot: this.lastOnMascot,
      onMascot: this.hits.test(x, y),
    });
    this.pointerDown = decision.pointerDown;
    this.lastOnMascot = decision.lastOnMascot;
    if (decision.ignore === null) return;
    this.clickThroughSink?.(decision.ignore);
    console.info(
      decision.ignore
        ? "[mascot] 光标离开角色，鼠标穿透已开启"
        : "[mascot] 光标进入角色，鼠标穿透已关闭",
      { x: Math.round(x), y: Math.round(y) },
    );
  }
}
