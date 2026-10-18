/**
 * 主窗口位置传输（基础设施层）：封装 Tauri 命令 `move_window`
 * （把窗口平滑滑到当前显示器工作区的归一化坐标，约 0.6s）。
 * 纯传输不理解语义；非 Tauri 环境向上抛错，由 dispatcher 转成 {ok:false,error} 失败信封。
 */
import type { WindowMoveOutcome } from "@/shared/domain/types";

/** 平滑移动主窗口到工作区归一化坐标；失败（含非 Tauri 环境）向上抛错。 */
export async function moveWindow(x: number, y: number): Promise<WindowMoveOutcome> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<WindowMoveOutcome>("move_window", { x, y });
}
