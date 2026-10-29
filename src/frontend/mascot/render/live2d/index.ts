/**
 * 真实 Live2D 看板娘（pixi.js v6 + pixi-live2d-display）：MascotController 的装配与生命周期。
 * 本文件只做「装配 + 生命周期 + 布局 + 对外委托」，能力各归其位（子模块清单见
 * `src/frontend/AGENTS.md` 的 `render/` 行）。
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
import { wireChannels, type MascotChannels } from "./channels";
import type { ExpressionChannel } from "./expression-channel";
import type { MascotInteraction } from "./interaction";
import {
  applyModelFit,
  bubbleBottomPx,
  MODEL_DESIGN_HEIGHT,
  MODEL_DESIGN_WIDTH,
} from "./layout";
import { resolveMotionGroups, type Live2DModelLike } from "./model-introspection";
import type { MotionChannel } from "./motion-channel";
import {
  createPixiApplication,
  destroyPixiApplication,
  loadLive2DModel,
  loadPixiRuntime,
  type PixiApplicationLike,
  type PixiRuntime,
} from "./pixi-runtime";

/** Live2D 控制器：把各渲染子模块装配成 MascotController。 */
export class Live2DMascot implements MascotController {
  private app: PixiApplicationLike;
  /** 当前模型句柄；加载完成前为 null。 */
  private model: Live2DModelLike = null;
  private profile: ModelProfile;
  private cfg: ModelConfig;
  private anchor: { x: number; y: number };

  /** 模型动作组名；与 catalog.groups 共享同一数组引用（模型加载后原地填充）。 */
  private motionGroups: string[] = [];

  /** 动作通道（队列 + 端口 + 手势入口）。 */
  private motion: MotionChannel;
  /** 表情通道（语义名 → 模型真实表情）。 */
  private expressions: ExpressionChannel;
  /** 光标与鼠标穿透交互。 */
  private interaction: MascotInteraction;

  // 台词出口：气泡属表现层，由组合根注入回调，渲染层不直接碰 DOM
  private speechSink: ((text: string) => void) | null = null;
  // 气泡底边出口：布局算出的「距窗口底部距离」，由组合根写进 CSS 变量
  private bubbleSink: ((bottomPx: number) => void) | null = null;

  private onResize = () => this.layout();
  private destroyed = false;

  private constructor(canvas: HTMLCanvasElement, profile: ModelProfile, runtime: PixiRuntime) {
    this.profile = profile;
    this.cfg = profile.config;
    this.anchor = { x: this.cfg.anchorX ?? 0.5, y: this.cfg.anchorY ?? 0.98 };
    const channels: MascotChannels = wireChannels({
      profile,
      groups: this.motionGroups,
      model: () => this.model,
      app: () => this.app,
      isDisposed: () => this.destroyed,
      showSpeech: (text) => this.speechSink?.(text),
    });
    this.motion = channels.motion;
    this.expressions = channels.expressions;
    this.interaction = channels.interaction;
    this.app = createPixiApplication(runtime, canvas);
  }

  /** 创建控制器：装载运行时与模型；任一步失败先回收已建资源再抛出（调用方决定回退）。 */
  static async create(canvas: HTMLCanvasElement, profile: ModelProfile): Promise<Live2DMascot> {
    const runtime = await loadPixiRuntime();
    const instance = new Live2DMascot(canvas, profile, runtime);
    instance.motion.setPriority(runtime.motionPriority);
    try {
      const modelPath = `${instance.cfg.modelDir}/${instance.cfg.modelFile}`;
      const model = await loadLive2DModel(runtime, modelPath);
      instance.model = model;
      // autoInteract（pixi-runtime 里开启）：指针点中 HitAreas 时派发 "hit" 事件
      model.on?.("hit", (areas: string[]) => instance.motion.onHit(areas));
      instance.app.stage.addChild(model);
      // 名称清单只随模型加载变化：原地填充，catalog 共享同一数组引用，无需重建
      instance.motionGroups.splice(0, instance.motionGroups.length, ...resolveMotionGroups(instance.model));
      instance.expressions.attach(instance.model);
      instance.layout();
      window.addEventListener("resize", instance.onResize);
      // 光标轮询常开：视线跟随（按开关生效）与鼠标穿透判定都依赖它
      instance.interaction.start();
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
    this.motion.queue.dispose();
    this.interaction.stop();
    window.removeEventListener("resize", this.onResize);
    try {
      this.model?.destroy?.({ children: true, texture: true, baseTexture: true });
    } catch (e) {
      console.warn("[mascot] model.destroy 失败:", e);
    }
    destroyPixiApplication(this.app);
  }

  /** 按设计基准缩放、按实际视口摆放；顺带把气泡底边（距窗口底部）交给组合根。 */
  private layout(): void {
    if (!this.model) return;
    const { width, height } = this.app.renderer.screen;
    const fit = applyModelFit(this.model, {
      designWidth: MODEL_DESIGN_WIDTH,
      designHeight: MODEL_DESIGN_HEIGHT,
      anchorX: this.anchor.x,
      anchorY: this.anchor.y,
      scale: this.cfg.scale,
      viewWidth: width,
      viewHeight: height,
    });
    this.bubbleSink?.(bubbleBottomPx(height, this.anchor.y, fit.fittedHeight));
  }

  // ---- MascotController：对外能力（大多委托给子模块） ----

  playMotions(steps: MotionStep[], options: MotionPlayOptions = {}): MotionStepOutcome[] {
    return this.motion.playMotions(steps, options);
  }

  expression(name: string): ActionOutcome {
    return this.expressions.apply(name);
  }

  speak(text: string): void {
    this.motion.speak(text);
  }

  setSpeechSink(sink: (text: string) => void): void {
    this.speechSink = sink;
  }

  setClickThroughSink(sink: (ignore: boolean) => void): void {
    this.interaction.setClickThroughSink(sink);
  }

  setBubbleBottomSink(sink: (bottomPx: number) => void): void {
    this.bubbleSink = sink;
    // 注入晚于首次布局时补发一次当前值，避免气泡停在默认位置
    if (this.model) this.layout();
  }

  moveTo(x: number, y: number): void {
    this.anchor.x = Math.max(0, Math.min(1, x));
    this.anchor.y = Math.max(0, Math.min(1, y));
    this.layout();
  }

  idle(): void {
    this.motion.idle();
  }

  setGaze(enabled: boolean): void {
    this.interaction.setGaze(enabled);
  }

  listMotions(): string[] {
    return this.motionGroups;
  }

  listExpressions(): string[] {
    return this.expressions.list();
  }

  status(): MascotStatus {
    return {
      mode: "live2d",
      model: this.cfg.modelFile,
      modelId: this.profile.id,
      expression: this.expressions.current(),
      position: { x: this.anchor.x, y: this.anchor.y },
      speaking: false,
    };
  }
}
