/**
 * 主窗口传输（基础设施层）：封装 Tauri 窗口命令。
 * - `move_window`：把窗口平滑滑到当前显示器工作区的归一化坐标（约 0.6s）；
 * - `set_click_through`：整窗鼠标穿透开关（空白区域让鼠标事件落到下层窗口）。
 * 纯传输不理解语义；非 Tauri 环境向上抛错，由调用方决定降级方式。
 */
import type { WindowMoveOutcome } from "@/shared/domain/types";

/** 平滑移动主窗口到工作区归一化坐标；失败（含非 Tauri 环境）向上抛错。 */
export async function moveWindow(x: number, y: number): Promise<WindowMoveOutcome> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<WindowMoveOutcome>("move_window", { x, y });
}

/**
 * 切换整窗鼠标穿透：`ignore=true` 时窗口不再接收鼠标消息（点击/悬停落到下层窗口）。
 * 由渲染层按「光标是否落在角色像素上」的结果驱动；重复设置同一状态是幂等的。
 * 非 Tauri 环境（浏览器调试）向上抛错，调用方须容忍（穿透能力仅 Tauri 存在）。
 */
export async function setClickThrough(ignore: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("set_click_through", { ignore });
}
