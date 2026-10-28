/**
 * 领域常量与工具契约的互校单测：守住 play_motion 上限的「单一来源」。
 * 直接读仓库根 `src/mcp/tools.json`（相对路径写法与 `shared/domain/types.ts` 一致），
 * 常量与契约漂移（改了一侧忘另一侧）时这里直接失败，而不是留到运行时行为不一致。
 */
import { describe, expect, it } from "vitest";
import tools from "../../../mcp/tools.json";
import { PLAY_MOTION_HOLD_MS_MAX, PLAY_MOTION_STEP_WAIT_MS } from "./motion-limits";

/** holdMs 的 JSON Schema 子集（只取上下界，渲染/校验均不看其它字段）。 */
interface HoldMsSchema {
  minimum?: number;
  maximum?: number;
}

/** steps 的 JSON Schema 子集：minItems 与每步 holdMs 定义。 */
interface StepsSchema {
  minItems?: number;
  items?: { properties?: { holdMs?: HoldMsSchema } };
}

/** play_motion 工具定义中本测试关心的字段。 */
interface PlayMotionTool {
  description?: string;
  inputSchema?: { properties?: { steps?: StepsSchema } };
}

// JSON 导入的元素是逐工具的联合字面量类型，深层字段并非所有成员都有；
// 这里先整体收窄成本测试关心的结构（`as unknown as` 是调试面板同类先例，项目禁用 any）。
const playMotion = tools.find((tool) => tool.action === "play_motion") as unknown as
  | PlayMotionTool
  | undefined;
const steps = playMotion?.inputSchema?.properties?.steps;
const holdMs = steps?.items?.properties?.holdMs;

describe("play_motion 上限与 tools.json 契约一致", () => {
  it("tools.json 中存在 play_motion 的 steps 与 holdMs 定义", () => {
    expect(playMotion).toBeDefined();
    expect(steps).toBeDefined();
    expect(holdMs).toBeDefined();
  });

  it("steps.minItems 为 1（至少一步）", () => {
    expect(steps?.minItems).toBe(1);
  });

  it("holdMs 上界等于 PLAY_MOTION_HOLD_MS_MAX、下界为 0", () => {
    expect(holdMs?.maximum).toBe(PLAY_MOTION_HOLD_MS_MAX);
    expect(holdMs?.minimum).toBe(0);
  });

  it("工具描述里的兜底时长与 PLAY_MOTION_STEP_WAIT_MS 换算的秒数一致", () => {
    expect(playMotion?.description).toContain(`${PLAY_MOTION_STEP_WAIT_MS / 1000}s`);
  });
});
