/**
 * 设置窗口入口（表现层组合根）：安装日志转发并挂载设置页，只做接线。
 * 另接线自定义标题栏（窗口无系统边框）的关闭 / 最小化按钮。
 */
import "./settings.css";
import { installLogForwarding } from "./ipc/log-forward";
import { mountSettingsPage } from "./ui/settings-page";

installLogForwarding();
void mountSettingsPage();
void wireWindowControls();

/** 绑定无边框窗口的自绘按钮：关闭=隐藏（窗口复用，托盘可再唤出）、最小化。非 Tauri 环境跳过。 */
async function wireWindowControls(): Promise<void> {
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
