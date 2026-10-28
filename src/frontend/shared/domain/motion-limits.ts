/**
 * play_motion 的队列上限常量（领域层唯一来源）。
 *
 * 这两个值同时约束「契约文案」与「实现行为」，任何一处单独硬编码都会漂移，因此在此集中：
 * - `PLAY_MOTION_HOLD_MS_MAX` 必须等于 `src/mcp/tools.json` 中
 *   `play_motion.inputSchema.properties.steps.items.properties.holdMs.maximum`（工具描述里的 0~5000ms 也据此）；
 * - `PLAY_MOTION_STEP_WAIT_MS` 对应工具描述里的「动作异常时单步兜底 12s」，
 *   渲染层「等本步播完」的兜底计时器与文档文案共用该值。
 *
 * 一致性由 `./motion-limits.test.ts` 直接读取 `src/mcp/tools.json` 守住：
 * 改常量而不同步契约（或反之）单测即失败，故消费方只允许引用本文件，禁止再写一份字面量。
 */

/** 单步「播完后额外停留」的上限（毫秒），避免一步把动作队列长期占死。 */
export const PLAY_MOTION_HOLD_MS_MAX = 5000;

/**
 * 单步「等动作真正播完」的兜底时长（毫秒）。
 * 正常动作都在一两秒到十秒内结束，这里只作兜底——动作异常（未触发结束回调）时防止队列永久卡住。
 */
export const PLAY_MOTION_STEP_WAIT_MS = 12000;
