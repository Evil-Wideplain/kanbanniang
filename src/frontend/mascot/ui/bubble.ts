/** 说话气泡（表现层）：show 后按时长自动隐藏，重复 show 会重置计时。 */
import { speakDurationMs } from "@/shared/domain/speech";

export interface Bubble {
  /** 显示文本，并在 speakDurationMs 到期后自动隐藏。 */
  show(text: string): void;
}

/** 创建气泡控制器（绑定 index.html 的 #bubble 单例节点）。 */
export function createBubble(): Bubble {
  const el = document.getElementById("bubble") as HTMLDivElement;
  let timer = 0;
  return {
    show(text: string) {
      el.textContent = text;
      el.classList.remove("hidden");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => el.classList.add("hidden"), speakDurationMs(text));
    },
  };
}
