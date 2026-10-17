/**
 * Tauri 事件传输（基础设施层）：mascot:action 进 / mascot:result 出。
 * 纯传输不理解动作语义；非 Tauri 环境仅警告降级，不影响界面调试。
 */
import type { MascotCommand, MascotResult } from "../core/types";
import { CHANNELS } from "../core/types";

type EmitFn = (event: string, payload?: unknown) => Promise<unknown>;

/** 回传结果：失败仅记录日志（日志是旁路，不阻断事件循环）。 */
function emitResult(emit: EmitFn, res: MascotResult): void {
  void emit(CHANNELS.result, res).catch((e) => {
    console.error("[mascot] 结果回传失败:", e);
  });
}

/**
 * 连接 Tauri 事件通道（mascot:action 进 / mascot:result 出）。
 * 纯传输层：不理解任何 action，指令语义由 dispatcher 处理。
 * 非 Tauri 环境（纯浏览器 `npm run dev`）下仅警告并降级，不影响界面调试。
 */
export async function connectTauriEvents(
  onCommand: (cmd: MascotCommand) => MascotResult | Promise<MascotResult>,
): Promise<void> {
  try {
    const { listen, emit } = await import("@tauri-apps/api/event");
    await listen<MascotCommand>(CHANNELS.action, (event) => {
      const cmd = event.payload;
      // 指令进入即记日志：前端卡死导致 5s 超时时，这是定位问题的第一线索
      console.info("[mascot] 收到指令", { action: cmd.action, id: cmd.id });
      // onCommand 可能返回 Promise（set_model 等异步动作），统一等待后回传结果
      Promise.resolve(onCommand(cmd))
        .then((res) => emitResult(emit, res))
        .catch((e) => {
          console.error("[mascot] 指令处理失败:", cmd.action, e);
          emitResult(emit, {
            id: cmd.id,
            ok: false,
            result: { ok: false, error: e instanceof Error ? e.message : String(e) },
          });
        });
    });
    console.info("[mascot] 已连接 MCP 事件通道 (mascot:action)");
  } catch (err) {
    // 非 Tauri 环境（如纯浏览器 `npm run dev`）：仅用于界面调试，MCP 不可用。
    console.warn("[mascot] 未运行在 Tauri 中，MCP 事件通道已禁用（仅界面调试）：", err);
  }
}
