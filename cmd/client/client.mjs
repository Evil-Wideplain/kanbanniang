// 共享 MCP 客户端（Streamable HTTP）：initialize 握手 + JSON-RPC 调用。
// 无状态传输：每个请求独立 POST，响应同步回来；initialize 响应的 Mcp-Session-Id
// 由服务端下发，后续请求带上便于代理/日志排查（服务端不校验会话归属）。
// 供 preview.mjs 等交互脚本复用（旧版 HTTP+SSE 传输已下线，不再走长连接）。

export const BASE = process.env.MCP_BASE || "http://127.0.0.1:7432";

/**
 * 建立连接并完成 initialize 握手。
 * 返回 { rpc(method, params), call(tool, args), init, close() }。
 */
export async function connect({ name = "mcp-client", version = "0.0.1" } = {}) {
  let nextId = 1;
  let sessionId = null;

  /** 发送一条 JSON-RPC 消息；通知类（无 id）返回 null（服务端回 202）。 */
  const post = async (payload) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status !== 202) throw new Error(`POST 失败: ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (res.status === 202) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const rpc = async (method, params) => {
    const id = nextId++;
    const body = await post({ jsonrpc: "2.0", id, method, params });
    if (body && body.error) {
      throw new Error(body.error.message ?? `JSON-RPC 错误 ${body.error.code}`);
    }
    return body;
  };

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name, version },
  });
  // 协议要求 initialize 之后发一次 initialized 通知（服务端回 202）。
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    rpc,
    call: (tool, args) => rpc("tools/call", { name: tool, arguments: args ?? {} }),
    init,
    // 无长连接可关：保留 close() 以维持调用方顺序（preview.mjs 末尾会 await）。
    close: async () => {},
  };
}
