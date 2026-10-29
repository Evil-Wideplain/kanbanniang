/**
 * 控制器子模块装配（渲染层）：把动作通道、表情通道与交互实例按依赖关系接好。
 *
 * 拆出来只为让 `index.ts` 保持「生命周期 + 布局 + 委托」的薄壳（约定 ≤200 行）；
 * 这里只做接线，不含任何播放/命中逻辑——那些各在 `motion-channel.ts` / `expression-channel.ts`
 * / `interaction.ts` 里。
 */
import type { ModelProfile } from "@/shared/domain/profiles";
import { norm } from "@/shared/domain/normalize";
import { ExpressionChannel } from "./expression-channel";
import { MascotInteraction } from "./interaction";
import { motionCountOf, type Live2DModelLike } from "./model-introspection";
import { MotionChannel } from "./motion-channel";
import { createMotionCatalog } from "./motion-catalog";
import type { PixiApplicationLike } from "./pixi-runtime";

/** 装配结果：控制器持有这些实例并对它们做委托。 */
export interface MascotChannels {
  /** 动作通道（队列 + 端口 + 手势入口）。 */
  motion: MotionChannel;
  /** 表情通道（语义名 → 模型真实表情）。 */
  expressions: ExpressionChannel;
  /** 光标与鼠标穿透交互。 */
  interaction: MascotInteraction;
}

/** 装配依赖：控制器把「模型/渲染器/状态/出口」以回调形式借给子模块。 */
export interface ChannelWiringDeps {
  /** 模型档案：提供动作/表情语义别名。 */
  profile: ModelProfile;
  /** 模型动作组名；与 catalog.groups 共享同一数组引用（模型加载后原地填充）。 */
  groups: string[];
  /** 当前模型句柄；未加载返回 null。 */
  model: () => Live2DModelLike | null;
  /** 渲染器（PIXI.Application）：交互层要画布与尺寸。 */
  app: () => PixiApplicationLike;
  /** 控制器是否已销毁。 */
  isDisposed: () => boolean;
  /** 台词出口（气泡属表现层，由组合根注入）。 */
  showSpeech: (text: string) => void;
}

/** 档案语义别名 → 归一化键映射。 */
function aliasMapOf(aliases: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(aliases ?? {}).map(([k, v]) => [norm(k), v]));
}

/** 装配动作/表情/交互三个子模块（构造控制器时调用一次）。 */
export function wireChannels(deps: ChannelWiringDeps): MascotChannels {
  const motionAliases = aliasMapOf(deps.profile.motionAliases);
  const expressionAliases = aliasMapOf(deps.profile.expressionAliases);
  const expressions = new ExpressionChannel(expressionAliases);
  // 目录须在模型加载前建好（模型未就绪时 count 按 1），groups 与控制器数组共享引用
  const catalog = createMotionCatalog({
    groups: deps.groups,
    aliases: motionAliases,
    countOf: (group) => motionCountOf(deps.model(), group),
  });
  const motion = new MotionChannel(catalog, deps.groups, motionAliases, {
    model: deps.model,
    isDisposed: deps.isDisposed,
    applyExpression: (name) => expressions.apply(name),
    showSpeech: deps.showSpeech,
  });
  const interaction = new MascotInteraction({
    canvas: () => deps.app().renderer.view,
    // 用 renderer.screen（CSS 逻辑像素）而非 width/height（设备像素）：命中网格与光标坐标同量纲
    viewSize: () => {
      const { screen } = deps.app().renderer;
      return { width: screen.width, height: screen.height };
    },
    bounds: () => {
      const b = deps.model()?.getBounds?.();
      return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
    },
    focus: (x, y) => deps.model()?.focus?.(x, y),
    resetFocus: () => deps.model()?.internalModel?.focusController?.focus(0, 0, true),
  });
  return { motion, expressions, interaction };
}
