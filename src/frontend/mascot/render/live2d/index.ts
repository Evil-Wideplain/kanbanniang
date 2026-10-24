import type { ActionOutcome, MascotController, MascotStatus } from "@/shared/domain/types";
import type { ModelConfig, ModelProfile } from "@/shared/domain/profiles";
import { norm } from "@/shared/domain/normalize";
import { startCursorTracking } from "@/shared/ipc/cursor";
import cubismCoreUrl from "./live2dcubismcore.min.js?url";

/**
 * 真实 Live2D 看板娘（基于 pixi.js v6 + @guansss/pixi-live2d-display）。
 * 该实现是"即插即用"的：放入 Cubism 模型并填写 profiles.ts 后自动启用。
 * 详见 README 与 models/README.md。
 *
 * 注意：pixi 与 pixi-live2d-display 在模块顶层导入会依赖 Cubism Core，
 * 因此这里用动态 import，并且 Cubism Core 脚本在 loadCubismCore() 中按需注入，
 * 这样"降级模式"完全不加载这些依赖。
 */

async function loadCubismCore(): Promise<void> {
  if ((window as any).Live2DCubismCore) return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = cubismCoreUrl;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("无法加载 Cubism Core 运行时资源（src/frontend/mascot/render/live2d/live2dcubismcore.min.js）"));
    document.head.appendChild(s);
  });
}

/** 从池中随机取一个元素；空池返回 undefined。 */
function pickRandom<T>(items: T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

export class Live2DMascot implements MascotController {
  private app: any; // PIXI.Application
  private model: any; // Live2DModel
  private profile: ModelProfile;
  private cfg: ModelConfig;
  private expressionName = "neutral";
  private anchor: { x: number; y: number };

  // 档案语义别名（键已归一化），构造时预计算
  private motionAliasMap: Record<string, string>;
  private expressionAliasMap: Record<string, string>;

  private onResize = () => this.layout();
  private destroyed = false;

  // 全屏视线跟随：全局光标轮询句柄（null 表示未跟踪）；
  // 窗口内跟随由库的 autoInteract 常驻生效，与此开关无关。
  private gazeStop: (() => void) | null = null;

  // 懒加载后保存的引用
  private Live2DModel: any;

  // 模型加载后一次性解析的动作组名 / 表情名（供 list_* 与名称解析复用）
  private motions: string[] = [];
  private expressions: string[] = [];

  private constructor(canvas: HTMLCanvasElement, profile: ModelProfile, PIXI: any) {
    this.profile = profile;
    this.cfg = profile.config!; // 调用方保证 Live2D 档案 config 非 null
    this.anchor = { x: this.cfg.anchorX ?? 0.5, y: this.cfg.anchorY ?? 0.98 };
    this.motionAliasMap = Object.fromEntries(
      Object.entries(profile.motionAliases ?? {}).map(([k, v]) => [norm(k), v]),
    );
    this.expressionAliasMap = Object.fromEntries(
      Object.entries(profile.expressionAliases ?? {}).map(([k, v]) => [norm(k), v]),
    );
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
    instance.Live2DModel = (pixiLive2d as any).Live2DModel;
    // 注册 Ticker：驱动动作/呼吸/物理的逐帧更新，缺失时模型只会静止
    instance.Live2DModel.registerTicker((pixi as any).Ticker);

    try {
      const modelPath = `${instance.cfg.modelDir}/${instance.cfg.modelFile}`;
      // autoInteract：pointer tap 命中 HitAreas（Head/Body）时派发 "hit" 事件
      const model = await instance.Live2DModel.from(modelPath, { autoInteract: true });
      instance.model = model;
      model.on?.("hit", (areas: string[]) => instance.onHit(areas));
      instance.app.stage.addChild(model);
      // 名称清单只随模型加载变化，此处解析一次缓存，避免每次指令/点击重算
      instance.motions = instance.resolveMotions();
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

  /** 释放资源：移除监听、销毁模型与渲染器。幂等，可多次调用。 */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
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

  // ---- MascotController 实现 ----

  /**
   * 语义解析：把调用名解析为模型里真实的名字。
   * 1) 档案语义别名（profile.motionAliases / expressionAliases）
   * 2) 归一化匹配（忽略大小写与下划线，如 tap_body → TapBody）
   * 未命中返回 undefined，由调用方决定回退策略。
   */
  private resolveReal(
    name: string,
    aliases: Record<string, string>,
    pool: string[],
  ): string | undefined {
    const target = norm(name);
    const alias = aliases[target];
    if (alias) return alias;
    return pool.find((x) => norm(x) === target);
  }

  /** 动作组内随机变体序号（拿不到定义时按 0）。 */
  private randomIndex(group: string): number {
    const defs = (this.model as any)?.internalModel?.motionManager?.definitions;
    const n = Array.isArray(defs?.[group]) ? defs[group].length : 1;
    return n > 1 ? Math.floor(Math.random() * n) : 0;
  }

  private play(group: string, index: number, fallback: boolean): ActionOutcome {
    try {
      this.model.motion(group, index);
      return { applied: group, fallback, index };
    } catch (e) {
      // 模型缺少该动作组时 pixi-live2d 会抛错：记录真实原因，否则只表现为 applied=null
      console.warn("[mascot] 动作播放失败:", group, e);
      return { applied: null, fallback: false };
    }
  }

  motion(name: string, index?: number): ActionOutcome {
    const exact = this.resolveReal(name, this.motionAliasMap, this.motions);
    if (exact) return this.play(exact, index ?? this.randomIndex(exact), false);

    // 未命中：回退随机点触动作（优先 Tap* 组），保证调用始终"有反应"
    const groups = this.motions;
    const taps = groups.filter((g) => /^tap/i.test(g));
    const pool = taps.length ? taps : groups.filter((g) => norm(g) !== norm(this.motionAliasMap["idle"] ?? "idle"));
    const pick = pickRandom(pool);
    if (!pick) return { applied: null, fallback: false };
    return this.play(pick, index ?? this.randomIndex(pick), true);
  }

  /** 点击反应：身体 → 点触动作；头部/其它 → 随机手势动作（m01… 优先）。 */
  private onHit(areas: string[]): void {
    const names = (areas ?? []).map((a) => norm(a));
    if (names.some((a) => a.includes("body"))) {
      this.motion("tap_body");
      return;
    }
    const groups = this.motions;
    const gestures = groups.filter((g) => /^m\d+$/i.test(g));
    const pool = gestures.length ? gestures : groups;
    const pick = pickRandom(pool);
    if (!pick) return;
    this.play(pick, this.randomIndex(pick), gestures.length === 0);
  }

  private applyExpression(real: string, fallback: boolean): ActionOutcome {
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

  private resetExpression(): ActionOutcome {
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

  expression(name: string): ActionOutcome {
    const target = norm(name);
    // 1) 档案语义别名（可显式接管 neutral）
    const alias = this.expressionAliasMap[target];
    if (alias) return this.applyExpression(alias, false);
    // 2) neutral/default：无参重置为模型默认表情
    if (target === "neutral" || target === "default") return this.resetExpression();
    // 3) 归一化匹配
    const real = this.expressions.find((e) => norm(e) === target);
    if (real) return this.applyExpression(real, false);
    // 4) 未命中：回退为默认表情，保证状态可控（而非静默保持原样）
    return { ...this.resetExpression(), fallback: true };
  }

  speak(_text: string): void {
    // Live2D 没有内建"说话"，这里尝试播放档案指定的口语动作
    // （默认 tap 类组），真实口型需用 AudioEngine + Phoneme，
    // 超出脚手架范围；气泡由上层 DOM 处理。
    this.motion(this.motionAliasMap["speak"] ?? "tap_body", 0);
  }

  moveTo(x: number, y: number): void {
    this.anchor.x = Math.max(0, Math.min(1, x));
    this.anchor.y = Math.max(0, Math.min(1, y));
    this.layout();
  }

  idle(): void {
    this.expression("neutral");
    this.motion("idle", 0);
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
}
