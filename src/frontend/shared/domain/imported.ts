/**
 * 运行时导入模型（拖入的 .zip 压缩包 / 模型文件夹）领域契约与档案换算。
 *
 * 与 Rust `src/tauri/src/model_store.rs` 的 `ImportedModel` / `ImportOutcome` 成对镜像
 *（camelCase）；自定义协议 scheme 也在两侧成对维护。
 *
 * 这些模型不在构建期扫描的 `models/` 里，而是由后端落盘到应用数据目录、
 * 经只读协议 `mascot-model://` 提供资源；本模块负责把元数据换算成通用 `ModelProfile`，
 * 让模型切换、MCP `list_models` / `set_model` 与设置页复用同一套档案语义。
 */
import { norm } from "./normalize";
import type { ModelProfile } from "./profiles";

/** 自定义只读协议 scheme（与 Rust `model_store::ASSET_SCHEME` 成对维护）。 */
export const IMPORTED_ASSET_SCHEME = "mascot-model";

/** 导入模型元数据（与 Rust `model_store::ImportedModel` 成对镜像，camelCase）。 */
export interface ImportedModel {
  /** 稳定 id（也是仓库目录名），形如 `imported-haru`；MCP `set_model` 用该 id。 */
  id: string;
  /** 展示名（模型配置文件名去掉后缀，保留原始大小写）。 */
  name: string;
  /** 主模型配置文件名（位于模型目录根部，如 `Haru.model3.json`）。 */
  modelFile: string;
  /** 配置里声明的动作组名。 */
  motions: string[];
  /** 配置里声明的表情名。 */
  expressions: string[];
  /** 贴图数量。 */
  textures: number;
  /** 来源类型。 */
  source: "folder" | "zip";
}

/** 一次拖拽导入的结果（与 Rust `model_store::ImportOutcome` 成对镜像）。 */
export interface ImportOutcome {
  /** 本次新导入（或替换）的模型。 */
  models: ImportedModel[];
  /** 逐路径的失败原因，可直接展示给用户。 */
  errors: string[];
}

/**
 * 导入模型资产根地址（由基础设施层按平台解析后传入，领域层不读 `navigator`）。
 *
 * Tauri 自定义协议在 Windows/Android 上是 `http://<scheme>.localhost`，
 * 在 macOS/iOS/Linux 上是 `<scheme>://localhost`（与 Tauri 官方文档一致）；
 * 具体判定见 `shared/ipc/model-import.ts::importedAssetOrigin`。
 */

/** 单个导入模型的资源根（模型配置里的相对路径都相对它解析）。 */
export function importedModelDir(assetOrigin: string, id: string): string {
  return `${assetOrigin}/${id}`;
}

/** 由导入元数据生成模型档案（自动派生常用语义别名，让 Agent 的稳定调用名能命中）。 */
export function profileFromImported(model: ImportedModel, assetOrigin: string): ModelProfile {
  return {
    id: model.id,
    name: model.name,
    description: `导入模型（${model.motions.length} 组动作 / ${model.expressions.length} 表情 / ${model.textures} 张贴图）`,
    config: {
      modelDir: importedModelDir(assetOrigin, model.id),
      modelFile: model.modelFile,
      scale: 1,
      anchorX: 0.5,
      anchorY: 0.98,
    },
    motionAliases: deriveMotionAliases(model.motions),
    expressionAliases: deriveExpressionAliases(model.expressions),
  };
}

/** 在真实名字池里按归一化匹配挑第一个候选（找不到返回 undefined）。 */
function pickReal(pool: string[], candidates: string[]): string | undefined {
  const normed = new Map(pool.map((name) => [norm(name), name]));
  for (const candidate of candidates) {
    const hit = normed.get(norm(candidate));
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * 从动作组名派生 `idle` / `speak` / `tap_body` 语义别名。
 * 模型作者命名各异（Idle / standby / flick_head…），未命中就不配置，
 * 由控制器内建的「归一化匹配 + 随机点触回退」兜底。
 */
function deriveMotionAliases(motions: string[]): Record<string, string> | undefined {
  const aliases: Record<string, string> = {};
  const idle = pickReal(motions, ["idle", "standby", "loop"]);
  if (idle) {
    aliases.idle = idle;
  }
  const tap = motions.find((name) => /^(tap|flick|touch)/i.test(name));
  if (tap) {
    aliases.speak = tap;
    aliases.tap_body = tap;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

/** 从表情名派生常用语义表情别名（未命中就不配置，走默认表情重置回退）。 */
function deriveExpressionAliases(expressions: string[]): Record<string, string> | undefined {
  const groups: Array<[string, string[]]> = [
    ["neutral", ["normal", "default", "neutral"]],
    ["happy", ["smile", "happy", "joy"]],
    ["angry", ["angry", "anger"]],
    ["sad", ["sad", "sorrow"]],
    ["surprised", ["surprised", "surprise", "shock"]],
  ];
  const aliases: Record<string, string> = {};
  for (const [semantic, candidates] of groups) {
    const real = pickReal(expressions, candidates);
    if (real) {
      aliases[semantic] = real;
    }
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}
