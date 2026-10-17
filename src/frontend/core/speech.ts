/**
 * 说话时长（毫秒）。
 * 气泡展示与降级口型共用同一公式，保证两者同步收尾。
 */
export function speakDurationMs(text: string): number {
  return Math.min(8000, 1500 + text.length * 90);
}
