/**
 * 无边框窗口的自绘标题栏接线（表现层共享）：绑定 `#win-close`（隐藏，窗口复用）与 `#win-min`（最小化）。
 * 设置窗口与调试面板共用；非 Tauri 环境静默跳过，绑定失败仅告警。
 */
export async function wireWindowControls(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return;
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    document.getElementById("win-close")?.addEventListener("click", () => void win.hide());
    document.getElementById("win-min")?.addEventListener("click", () => void win.minimize());
  } catch (e) {
    console.warn("[mascot] 绑定窗口控制按钮失败：", e);
  }
}
