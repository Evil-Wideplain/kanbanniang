/**
 * 模型档案注册表（动态发现 + 静态覆盖）。
 *
 * 可切换模型来自构建期扫描 `models/` 生成的 `models.generated.json`
 * （新增模型：把目录放入 models/ 后重新构建即可，无需改本文件）。
 * 本文件只在 `MODEL_OVERRIDES` 里为特定模型补充「展示名 / 语义别名 / 微调」，
 * 未覆盖的模型用目录名作默认档案。
 *
 * 语义别名：不同模型的动作组名、表情名各不相同（官方系 Idle/TapBody，
 * 社区模型可能是 standby/flick_head…），通过别名把稳定调用名（idle / speak / neutral …）
 * 映射到该模型的真实名字（键按归一化匹配，忽略大小写与下划线）。
 */
import generatedModels from "./models.generated.json";

export interface ModelConfig {
  /** 模型所在目录（models/ 下的子目录，经 Vite publicDir 映射为根路径 /<名>）。 */
  modelDir: string;
  /** 主模型文件名（位于 modelDir 下）。 */
  modelFile: string;
  /** 相对自动适配的缩放微调：1 = 恰好贴合窗口，0.9 = 缩小 10%。 */
  scale?: number;
  /** 初始锚点 x（0~1，默认居中 0.5）。 */
  anchorX?: number;
  /** 脚底基线的 y（0~1，默认 0.98，即贴近窗口底部）。 */
  anchorY?: number;
}

export interface ModelProfile {
  /** MCP 调用使用的稳定短 id。 */
  id: string;
  /** 展示名。 */
  name: string;
  description?: string;
  /** Live2D 模型配置（档案只描述真实模型）。 */
  config: ModelConfig;
  /** 语义别名：调用名 → 该模型真实动作组名（键按归一化匹配）。 */
  motionAliases?: Record<string, string>;
  /** 语义别名：调用名 → 该模型真实表情名（键按归一化匹配）。 */
  expressionAliases?: Record<string, string>;
}

/** 单个模型的静态覆盖项（缺省则按目录名生成档案）。 */
interface ModelOverride {
  /** 覆盖 MCP 调用 id（默认取目录名小写）。 */
  id?: string;
  /** 展示名（默认取目录名）。 */
  name?: string;
  description?: string;
  scale?: number;
  anchorX?: number;
  anchorY?: number;
  motionAliases?: Record<string, string>;
  expressionAliases?: Record<string, string>;
}

/**
 * 按目录名登记的覆盖项（键 = models/ 下的目录名）。
 * Haru 的表情 F01..F08 无语义名；Natori 的表情是语义命名，故显式映射。
 */
const MODEL_OVERRIDES: Record<string, ModelOverride> = {
  Haru: {
    description: "官方示例模型（26 组自定义动作 + Idle/TapBody + 8 表情）",
    // 组名 Idle/TapBody 本身能被归一化匹配命中；显式列出既是自描述，也示范写法。
    motionAliases: { idle: "Idle", speak: "TapBody", tap_body: "TapBody" },
  },
  Natori: {
    description: "官方示例模型（8 组动作 + 11 表情，表情为语义命名）",
    motionAliases: { idle: "Idle", speak: "TapBody", tap_body: "TapBody" },
    expressionAliases: {
      neutral: "Normal",
      happy: "Smile",
      angry: "Angry",
      sad: "Sad",
      surprised: "Surprised",
    },
  },
};

/** 由扫描结果生成 Live2D 档案（叠加静态覆盖）。 */
function buildLive2dProfiles(): ModelProfile[] {
  return generatedModels.map(({ dir, file }) => {
    const ov = MODEL_OVERRIDES[dir] ?? {};
    return {
      id: ov.id ?? dir.toLowerCase(),
      name: ov.name ?? dir,
      description: ov.description,
      config: {
        modelDir: dir,
        modelFile: file,
        scale: ov.scale ?? 1,
        anchorX: ov.anchorX ?? 0.5,
        anchorY: ov.anchorY ?? 0.98,
      },
      motionAliases: ov.motionAliases,
      expressionAliases: ov.expressionAliases,
    };
  });
}

/** 全部可切换档案：由 `models/` 扫描结果动态生成。 */
export const MODEL_PROFILES: ModelProfile[] = buildLive2dProfiles();

/** 启动时加载的默认档案 id（首个模型；没有模型时为空串）。 */
export const DEFAULT_MODEL_ID = MODEL_PROFILES[0]?.id ?? "";

/** 全部档案 id（模型切换错误信息与校验复用；只在此处派生一次）。 */
export const MODEL_IDS: string[] = MODEL_PROFILES.map((p) => p.id);

export function getProfile(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((p) => p.id === id);
}
