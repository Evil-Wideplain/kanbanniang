/**
 * 表情通道（渲染层）：把「语义名 → 模型真实表情名」的解析、应用与当前值收口到一个类。
 *
 * 表情与动作在 Live2D 里是两条独立通道，应用表情不打断正在播放的动作；
 * 解析顺序与原控制器实现逐字一致：档案别名 → neutral/default 重置 → 归一化匹配 → 回退默认。
 * 本文件不直接依赖 pixi / DOM：模型句柄只当作不透明对象使用，实际字段读取走 model-introspection。
 */
import type { ActionOutcome } from "@/shared/domain/types";
import { norm } from "@/shared/domain/normalize";
import { resolveExpressionNames, type Live2DModelLike } from "./model-introspection";

/** 默认表情名：未挂载模型 / 刚挂载模型时的当前值。 */
const DEFAULT_EXPRESSION_NAME = "neutral";

/**
 * 表情通道：构造时注入档案别名，模型加载后调用 `attach` 挂载并解析可用表情名。
 * 生命周期与控制器一致：热切换模型时新建实例，因此当前表情会自然回到默认值。
 */
export class ExpressionChannel {
  /** 档案语义别名（键已归一化）→ 模型真实表情名。 */
  private readonly aliasMap: Record<string, string>;
  /**
   * 已挂载的模型句柄；null 表示尚未加载。
   * 类型为 Live2DModelLike（库无类型声明），因此这里允许存 null，靠 try/catch 容错。
   */
  private model: Live2DModelLike = null;
  /** 模型可用表情名（list_expressions 用它），随 attach 重新解析。 */
  private expressions: string[] = [];
  /** 当前生效的表情名（get_status 用它）。 */
  private expressionName = DEFAULT_EXPRESSION_NAME;

  /** aliasMap 是「归一化语义名 → 模型真实表情名」。 */
  constructor(aliasMap: Record<string, string>) {
    this.aliasMap = aliasMap;
  }

  /** 挂载模型：读取可用表情名并复位当前值（未加载时传 null，内部要容错）。 */
  attach(model: Live2DModelLike | null): void {
    this.model = model;
    this.expressions = model ? resolveExpressionNames(model) : [];
    this.expressionName = DEFAULT_EXPRESSION_NAME;
  }

  /** 可用表情名（list_expressions 用它）。 */
  list(): string[] {
    return this.expressions;
  }

  /** 当前生效的表情名（get_status 用它）。 */
  current(): string {
    return this.expressionName;
  }

  /** 应用表情并返回结果；不打断动作。解析顺序：别名 → neutral/default 重置 → 归一化匹配 → 回退默认。 */
  apply(name: string): ActionOutcome {
    const target = norm(name);
    // 1) 档案语义别名（可显式接管 neutral）
    const alias = this.aliasMap[target];
    if (alias) return this.applyReal(alias, false);
    // 2) neutral/default：无参重置为模型默认表情
    if (target === "neutral" || target === "default") return this.resetDefault();
    // 3) 归一化匹配
    const real = this.expressions.find((e) => norm(e) === target);
    if (real) return this.applyReal(real, false);
    // 4) 未命中：回退为默认表情，保证状态可控（而非静默保持原样）
    return { ...this.resetDefault(), fallback: true };
  }

  /** 应用模型真实表情名：抛错时记录原因并按「无结果」返回，当前值保持不变。 */
  private applyReal(real: string, fallback: boolean): ActionOutcome {
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

  /** 无参重置为模型默认表情；模型不支持无参重置时记录原因并按「无结果」返回。 */
  private resetDefault(): ActionOutcome {
    try {
      this.model.expression();
      this.expressionName = DEFAULT_EXPRESSION_NAME;
      return { applied: DEFAULT_EXPRESSION_NAME, fallback: false };
    } catch (e) {
      // 重置默认表情失败（模型不支持无参重置）：记录真实原因
      console.warn("[mascot] 表情重置失败:", e);
      return { applied: null, fallback: false };
    }
  }
}
