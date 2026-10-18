/**
 * 调试面板的 Tauri 传输封装（表现层 → 基础设施）：经命令 `mcp_debug_call` 复用工具真链路。
 * 面板不直连 MCP SSE（WebView origin `tauri://localhost` 与 `http://127.0.0.1:<port>` 跨源、axum 无 CORS），故走命令转发。
 */
import type { JsonRpcResponse } from "./types";

/** 调用一个工具，返回完整 JSON-RPC 响应帧（含 id/jsonrpc/result|error）。 */
export async function callToolFrame(
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<JsonRpcResponse>("mcp_debug_call", { name, args });
}

/** 执行一次查询型工具并取回其 result（帧 → result.content[0].text → MascotResult.result）。 */
export async function queryResult(name: string): Promise<unknown> {
  const frame = await callToolFrame(name, {});
  const text = frame.result?.content?.[0]?.text ?? "";
  try {
    return (JSON.parse(text) as { result?: unknown }).result ?? null;
  } catch {
    return null;
  }
}
