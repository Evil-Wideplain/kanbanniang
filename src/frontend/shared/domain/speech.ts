/**
 * 说话时长（毫秒）：气泡展示按时长自动收尾。
 */
export function speakDurationMs(text: string): number {
  return Math.min(8000, 1500 + text.length * 90);
}
