/**
 * 动作组名 / 表情名的归一化规则（领域层）。Live2D 控制器与档案别名映射
 * 共用同一套归一化，避免各自实现漂移。规则：小写并去掉下划线
 * （如 "TapBody" / "tap_body" 均归一为 "tapbody"）。
 */
export function norm(s: string): string {
  return s.toLowerCase().replace(/_/g, "");
}
