/**
 * 调试面板参数纯函数（表现层）：schema → 控件取值/默认值的转换，均无副作用，便于单测与复用。
 */
import type { Field, InputProperty, ToolDef } from "./types";

/** 参数是否为数字型（number/integer schema）。 */
export function isNumeric(prop: InputProperty): boolean {
  return prop.type === "number" || prop.type === "integer";
}

/** 参数默认预填值：坐标/文案给惯用值，其余取候选首项（保证一键即可调用）。 */
export function prefillFor(candidates: Record<string, string[]>, key: string): string {
  switch (key) {
    case "x":
      return "0.5";
    case "y":
      return "0.9";
    case "text":
      return "来自 MCP 调试面板的问候";
    case "steps":
      // play_motion 的 steps 是数组：面板里用 JSON 文本编辑，collect 时解析成数组
      return '[{"motion":"idle"}]';
    default:
      return candidates[key]?.[0] ?? "";
  }
}

/** 从参数控件收集调用载荷：空值跳过；数值型转 number，数组型按 JSON 解析，其余转字符串。 */
export function collect(fields: Field[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = field.el.value.trim();
    if (raw === "") {
      continue;
    }
    if (field.json) {
      args[field.key] = parseJsonField(field.key, raw);
    } else {
      args[field.key] = field.numeric ? Number(raw) : raw;
    }
  }
  return args;
}

/** 解析数组型参数的 JSON 文本：非法 JSON 直接抛错，由调用方在日志视图里提示（不静默吞掉）。 */
function parseJsonField(key: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`参数 ${key} 不是合法 JSON：${raw}`);
  }
}

/** 按默认预填组装参数（「依次调用全部」用，不依赖当前选中的参数卡）。 */
export function defaultArgs(
  candidates: Record<string, string[]>,
  tool: ToolDef,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
    const value = prefillFor(candidates, key);
    if (value === "") {
      continue;
    }
    if (prop.type === "array") {
      // 数组型：预填值是 JSON 文本，解析失败退回原文本（由分发层报出可读错误）
      try {
        args[key] = parseJsonField(key, value);
      } catch {
        args[key] = value;
      }
    } else {
      args[key] = isNumeric(prop) ? Number(value) : value;
    }
  }
  return args;
}

/** 从任意值中筛出字符串数组。 */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** 从 list_models 的结果中筛出模型 id 列表。 */
export function asModelIds(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return [];
  }
  return models.flatMap((m) => {
    const id = typeof m === "object" && m !== null ? (m as { id?: unknown }).id : undefined;
    return typeof id === "string" ? [id] : [];
  });
}
