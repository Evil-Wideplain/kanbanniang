/**
 * 设置读写传输（基础设施层）：封装 Tauri 命令 get_settings / save_settings，
 * 以及后端广播的设置变更事件 `mascot:settings`。
 * 纯传输，不理解设置语义；非 Tauri 环境（浏览器调试）读取回退默认值，仅告警。
 */
import { DEFAULT_SETTINGS } from "@/shared/domain/settings";
import { CHANNELS } from "@/shared/domain/types";
import type { MascotSettings, RuntimeStatus } from "@/shared/domain/types";

/**
 * 读取设置；非 Tauri 环境或命令不可用时回退默认值（不阻断界面渲染）。
 */
export async function loadSettings(): Promise<MascotSettings> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<MascotSettings>("get_settings");
  } catch (e) {
    console.warn("[mascot] 读取设置失败，使用默认值：", e);
    return DEFAULT_SETTINGS;
  }
}

/**
 * 读取 MCP 服务运行时状态（实际端口 / 是否运行）；非 Tauri 环境回退「未运行 + 默认端口」。
 */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<RuntimeStatus>("get_runtime_status");
  } catch (e) {
    console.warn("[mascot] 读取运行状态失败（非 Tauri 环境？）：", e);
    return { mcpRunning: false, mcpPort: DEFAULT_SETTINGS.mcpPort };
  }
}

/**
 * 保存设置；失败向上抛错（设置页需要展示失败原因）。
 * 载荷即 `MascotSettings` 契约本身，直接转发，勿逐字段重列（新增设置会被静默丢弃）。
 */
export async function saveSettings(settings: MascotSettings): Promise<MascotSettings> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<MascotSettings>("save_settings", { settings });
}

/**
 * 订阅后端广播的设置变更（保存后由 `save_settings` 推送）。
 * 返回取消订阅函数；非 Tauri 环境返回空函数（无事件）。
 */
export async function onSettingsChanged(
  cb: (settings: MascotSettings) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<MascotSettings>(CHANNELS.settings, (event) => cb(event.payload));
  } catch (e) {
    console.warn("[mascot] 监听设置变更失败（非 Tauri 环境？）：", e);
    return () => {};
  }
}
