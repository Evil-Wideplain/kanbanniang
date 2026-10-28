/**
 * 真实 Live2D 看板娘（基于 pixi.js v6 + pixi-live2d-display）：MascotController 的实现与组合。
 * 本文件只负责控制器生命周期、画布布局、视线跟随、表情通道与队列端口接线；
 * 动作名称解析在 motion-catalog.ts，串行播放队列在 motion-queue.ts，
 * Cubism Core 装载与兼容层在 core-loader.ts。
 *
 * 注意：pixi 与 pixi-live2d-display 在模块顶层导入会依赖 Cubism Core，
 * 因此这里用动态 import，并且 Cubism Core 脚本在 loadCubismCore() 中按需注入。
 */
import type {
  ActionOutcome,
  MascotController,
  MascotStatus,
  MotionPlayOptions,
  MotionStep,
  MotionStepOutcome,
} from "@/shared/domain/types";
import type { ModelConfig, ModelProfile } from "@/shared/domain/profiles";
import { norm } from "@/shared/domain/normalize";
import { startCursorTracking } from "@/shared/ipc/cursor";
import { loadCubismCore } from "./core-loader";
import { createMotionCatalog, pickRandom, planSteps, type MotionCatalog } from "./motion-catalog";
import { MotionQueue, type MotionQueuePort, type StartMotionResult } from "./motion-queue";

/**
 * 动作播放优先级兜底值：对应 pixi-live2d-display 的 MotionPriority.FORCE（3）。
 * 正常在 create() 里从库中取真实枚举；取不到时才用这个数值。
 * 默认 NORMAL(2) 时库会静默拒绝「另一动作在播 / 优先级不足」的请求，连续动作里表现为某几步完全不播。
 */
const MOTION_PRIORITY_FORCE_FALLBACK = 3;

export class Live2DMascot implements MascotController, MotionQueuePort {
  private app: any; // PIXI.Application
  private model: any; // Live2DModel
  private profile: ModelProfile;
  private cfg: ModelConfig;
  private expressionName = "neutral";
  private anchor: { x: number; y: number };

  // 档案语义别名（键已归一化），构造时预计算
  private motionAliasMap: Record<string, string>;
  private expressionAliasMap: Record<string, string>;

  /** 动作目录：groups 与 this.motions 共享同一个数组引用（模型加载后原地填充）。 */
  private catalog: MotionCatalog;
  /** 串行动作队列（点击反应 / 说话手势 / 待机 / MCP play_motion 共用）。 */
  private queue: MotionQueue;

  /** 动作下发优先级（create() 里按库枚举覆盖）。 */
  private motionPriority = MOTION_PRIORITY_FORCE_FALLBACK;

  /** 动作下发序号（越大越新）：过期请求不下发，避免旧动作在新动作之后落地。 */
  private startSeq = 0;
  /** 动作下发串行链：保证同一时刻只有一个 motion 请求在等模型文件加载。 */
  private startChain: Promise<void> = Promise.resolve();

  private onResize = () => this.layout();
  private destroyed = false;

  // 全屏视线跟随：全局光标轮询句柄（null 表示未跟踪）；
  // 窗口内跟随由库的 autoInteract 常驻生效，与此开关无关。
  private gazeStop: (() => void) | null = null;

  // 台词出口：气泡属表现层，由组合根注入回调，渲染层不直接碰 DOM
  private speechSink: ((text: string) => void) | null = null;

  // 懒加载后保存的引用
  private Live2DModel: any;

  // 模型加载后一次性解析的动作组名 / 表情名（供 list_* 与名称解析复用）
  private motions: string[] = [];
  private expressions: string[] = [];

  private constructor(canvas: HTMLCanvasElement, profile: ModelProfile, PIXI: any) {
    this.profile = profile;
    this.cfg = profile.config;
    this.anchor = { x: this.cfg.anchorX ?? 0.5, y: this.cfg.anchorY ?? 0.98 };
    this.motionAliasMap = Object.fromEntries(
      Object.entries(profile.motionAliases ?? {}).map(([k, v]) => [norm(k), v]),
    );
    this.expressionAliasMap = Object.fromEntries(
      Object.entries(profile.expressionAliases ?? {}).map(([k, v]) => [norm(k), v]),
    );
    // 目录须在模型加载前建好（模型未就绪时 count 按 1），groups 与 this.motions 共享引用
    this.catalog = createMotionCatalog({
      groups: this.motions,
      aliases: this.motionAliasMap,
      countOf: (group) => this.motionCount(group),
    });
    this.queue = new MotionQueue(this, window);
    this.app = new PIXI.Application({
      view: canvas,
      transparent: true,
      autoStart: true,
      // 画布铺满主窗口（看板娘窗口固定尺寸，无内嵌分栏）。
      resizeTo: window,
      antialias: true,
      backgroundAlpha: 0,
    });
  }

  /** 创建控制器：注入 Cubism Core 运行时，按需加载 pixi 与模型；
   *  任一步失败先回收已建资源再抛出，由调用方决定回退策略。 */
  static async create(canvas: HTMLCanvasElement, profile: ModelProfile): Promise<Live2DMascot> {
    // Cubism Core 与 pixi 相互独立，并行加载；只有 pixi-live2d-display 依赖 Core，须在其后。
    const [pixi] = await Promise.all([import("pixi.js"), loadCubismCore()]);
    // 必须用 cubism4 子路径入口：主入口 pixi-live2d-display 内置的是 Cubism 2
    // 运行时（要求 live2d.min.js），加载 Cubism 4 模型会直接抛错回退。
    const pixiLive2d = await import("pixi-live2d-display/cubism4");
    const instance = new Live2DMascot(canvas, profile, pixi);
    // 库模块无类型声明（旧版 0.4.0），统一在此收口一次
    const lib = pixiLive2d as any;
    instance.Live2DModel = lib.Live2DModel;
    instance.motionPriority = lib.MotionPriority?.FORCE ?? MOTION_PRIORITY_FORCE_FALLBACK;
    // 库默认 preserveExpressionOnMotion=true：动作播放不重置表情，步骤表情才能保留。
    // 显式对齐一次，避免升级后默认值变化导致「刚换的表情立刻被动作抹掉」。
    if (lib.config) lib.config.preserveExpressionOnMotion = true;
    // 注册 Ticker：驱动动作/呼吸/物理的逐帧更新，缺失时模型只会静止
    instance.Live2DModel.registerTicker((pixi as any).Ticker);

    try {
      const modelPath = `${instance.cfg.modelDir}/${instance.cfg.modelFile}`;
      // autoInteract：pointer tap 命中 HitAreas（Head/Body）时派发 "hit" 事件
      const model = await instance.Live2DModel.from(modelPath, { autoInteract: true });
      instance.model = model;
      model.on?.("hit", (areas: string[]) => instance.onHit(areas));
      instance.app.stage.addChild(model);
      // 名称清单只随模型加载变化：原地填充，catalog 共享同一数组引用，无需重建
      instance.motions.splice(0, instance.motions.length, ...instance.resolveMotions());
      instance.expressions = instance.resolveExpressions();
      instance.layout();
      window.addEventListener("resize", instance.onResize);
      return instance;
    } catch (e) {
      // 构造函数已创建 PIXI.Application（autoStart + resizeTo: window），
      // 加载失败必须回收，否则会留下一个空转的渲染循环。
      instance.destroy();
      throw e;
    }
  }

  /** 释放资源：队列、监听、模型与渲染器。幂等，可多次调用。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // 先放行队列里所有挂起等待，await 链才会退出（不再依赖队列「是否在播」判断）
    this.queue.dispose();
    this.stopGaze();
    window.removeEventListener("resize", this.onResize);
    try {
      this.model?.destroy?.({ children: true, texture: true, baseTexture: true });
    } catch (e) {
      console.warn("[mascot] model.destroy 失败:", e);
    }
    try {
      // removeView 必须为 false：canvas 节点由切换逻辑整块替换，
      // 这里摘掉节点会让后续 replaceWith 静默失效。
      this.app?.destroy?.(false);
    } catch (e) {
      console.warn("[mascot] app.destroy 失败:", e);
    }
  }

  private layout() {
    if (!this.model) return;
    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    const margin = Math.max(4, Math.round(h * 0.01));

    // 先取模型原始尺寸（scale=1），按“基线以上的可用区域”自动适配，
    // 保证头和脚都完整落在窗口内；cfg.scale 作为整体微调系数（1=恰好贴合）。
    this.model.scale.set(1);
    const bh = this.model.height || 1;
    const bw = this.model.width || 1;
    const footY = h * this.anchor.y; // 脚底基线（窗口高度比例）
    const maxH = Math.max(1, footY - margin); // 基线以上的可用高度
    const maxW = Math.max(1, w - margin * 2);
    const fit = Math.min(maxH / bh, maxW / bw);
    this.model.scale.set(fit * (this.cfg.scale ?? 1));
    this.model.anchor.set(this.anchor.x, 1); // 底部对齐到基线
    this.model.x = w * this.anchor.x;
    this.model.y = footY;
  }

  /**
   * 开始全屏视线跟随（幂等）：光标位置换算为画布坐标后聚焦。
   * 窗口内跟随由库的 autoInteract 常驻生效；本方法只额外扩展「屏幕任意位置」的跟随。
   */
  private startGaze(): void {
    if (this.gazeStop) return;
    this.gazeStop = startCursorTracking((p) => this.model?.focus?.(p.x, p.y));
    console.info("[mascot] 全屏视线跟随已开启");
  }

  /** 停止全屏视线跟随（幂等）并把视线复位到正前方；窗口内跟随不受影响。 */
  private stopGaze(): void {
    if (this.gazeStop) {
      this.gazeStop();
      this.gazeStop = null;
      console.info("[mascot] 全屏视线跟随已关闭");
    }
    this.model?.internalModel?.focusController?.focus(0, 0, true);
  }

  // ---- MotionQueuePort：串行队列 ↔ 具体 Live2D 的接线 ----

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
    if (this.destroyed) return "rejected";
    if (seq !== this.startSeq) return "superseded";
    const manager = this.motionManager();
    if (manager?.playing) this.stopAllMotionsQuietly();
    try {
      const accepted = Boolean(await Promise.resolve(this.model.motion(group, index, this.motionPriority)));
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

  /** 应用表情（队列端口）：与 set_expression 共用同一条表情通道，不打断动作。 */
  applyExpression(name: string): ActionOutcome {
    return this.expression(name);
  }

  /** 显示台词气泡（队列端口）。 */
  showSpeech(text: string): void {
    this.speechSink?.(text);
  }

  /** 队列正常完成且 idle=true 时回待机（队列端口）。 */
  finishToIdle(): void {
    this.idle();
  }

  /** 控制器是否已销毁（队列端口）。 */
  isDisposed(): boolean {
    return this.destroyed;
  }

  // ---- 动作播放入口 ----

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
  private onHit(areas: string[]): void {
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

  // ---- 表情通道 ----

  private applyExpressionReal(real: string, fallback: boolean): ActionOutcome {
    try {
      this.model.expression(real);
      this.expressionName = real;
      return { applied: real, fallback };
    } catch (e) {
      // 模型缺少该表情时抛错：记录真实原因，否则只表现为 applied=null
      console.warn("[mascot] 表情应用失败:", real, e);
      return { applied: null, fallback: false };
    }
  }

  private resetExpressionDefault(): ActionOutcome {
    try {
      this.model.expression();
      this.expressionName = "neutral";
      return { applied: "neutral", fallback: false };
    } catch (e) {
      // 重置默认表情失败（模型不支持无参重置）：记录真实原因
      console.warn("[mascot] 表情重置失败:", e);
      return { applied: null, fallback: false };
    }
  }

  /**
   * 设置表情。不打断正在播放的动作序列——表情与动作在 Live2D 里是两条独立通道，
   * 这样可以「一边做动作一边换表情」。
   */
  expression(name: string): ActionOutcome {
    const target = norm(name);
    // 1) 档案语义别名（可显式接管 neutral）
    const alias = this.expressionAliasMap[target];
    if (alias) return this.applyExpressionReal(alias, false);
    // 2) neutral/default：无参重置为模型默认表情
    if (target === "neutral" || target === "default") return this.resetExpressionDefault();
    // 3) 归一化匹配
    const real = this.expressions.find((e) => norm(e) === target);
    if (real) return this.applyExpressionReal(real, false);
    // 4) 未命中：回退为默认表情，保证状态可控（而非静默保持原样）
    return { ...this.resetExpressionDefault(), fallback: true };
  }

  // ---- 其它控制器能力 ----

  /** 说话：先显示气泡（气泡唯一出口就是 speechSink），再决定是否播放手势。
   *  Live2D 没有内建"说话"，这里额外播放档案指定的口语动作（默认 tap 类组）；
   *  真实口型需用 AudioEngine + Phoneme，超出当前范围。
   *  外部队列（MCP play_motion）期间只显示气泡，不打断正在播的动作序列。 */
  speak(text: string): void {
    // 气泡必须无条件先落地：dispatcher 已不再提供 showBubble，漏掉这里等于说话无声。
    if (text) this.speechSink?.(text);
    if (this.queue.isExternal()) {
      console.info("[mascot] play_motion 播放中，说话只更新气泡，不打断动作");
      return;
    }
    this.playOne(this.motionAliasMap["speak"] ?? "tap_body", 0);
  }

  /** 注入台词出口（气泡显示由组合根决定，渲染层不直接操作 DOM）。 */
  setSpeechSink(sink: (text: string) => void): void {
    this.speechSink = sink;
  }

  moveTo(x: number, y: number): void {
    this.anchor.x = Math.max(0, Math.min(1, x));
    this.anchor.y = Math.max(0, Math.min(1, y));
    this.layout();
  }

  idle(): void {
    this.queue.interrupt("改为回到待机");
    this.expression("neutral");
    this.playOne("idle", 0);
  }

  setGaze(enabled: boolean): void {
    if (enabled) {
      this.startGaze();
    } else {
      this.stopGaze();
    }
  }

  listMotions(): string[] {
    return this.motions;
  }

  listExpressions(): string[] {
    return this.expressions;
  }

  status(): MascotStatus {
    return {
      mode: "live2d",
      model: this.cfg.modelFile,
      modelId: this.profile.id,
      expression: this.expressionName,
      position: { x: this.anchor.x, y: this.anchor.y },
      speaking: false,
    };
  }

  // ---- 模型内部访问（第三方库无类型声明，统一在此收口） ----

  /** MotionManager 访问器：动作下发、结束事件、播放状态都从这里取。 */
  private motionManager(): any {
    return (this.model as any)?.internalModel?.motionManager;
  }

  /** 某个动作组的变体数量（模型未提供定义时按 1 处理，保证至少有可下发序号）。 */
  private motionCount(group: string): number {
    const defs = this.motionManager()?.definitions;
    return Array.isArray(defs?.[group]) ? defs[group].length : 1;
  }

  /** 从模型定义解析可用动作组名（建控制器时调用一次，结果缓存）。 */
  private resolveMotions(): string[] {
    const m = this.model as any;
    const defs = m?.internalModel?.motionManager?.definitions;
    // Cubism 4：definitions 是 { 组名: [动作...] } 映射
    if (defs && typeof defs === "object" && !Array.isArray(defs)) return Object.keys(defs);
    // Cubism 2 风格：数组，元素带 Name
    if (Array.isArray(defs)) return defs.map((d: any) => d.Name ?? d.name).filter(Boolean);
    // 兜底：模型配置里的 motions 分组
    const settingsMotions = m?.internalModel?.settings?.motions;
    if (settingsMotions && typeof settingsMotions === "object") return Object.keys(settingsMotions);
    if (m?.motions && typeof m.motions === "object") return Object.keys(m.motions);
    return [];
  }

  /** 从模型定义解析可用表情名（建控制器时调用一次，结果缓存）。 */
  private resolveExpressions(): string[] {
    const m = this.model as any;
    if (m?.expressions && typeof m.expressions === "object") return Object.keys(m.expressions);
    try {
      const defs = m.internalModel?.motionManager?.expressionManager?.definitions ?? [];
      return defs.map((d: any) => d.Name ?? d.name).filter(Boolean);
    } catch {
      return [];
    }
  }
}
