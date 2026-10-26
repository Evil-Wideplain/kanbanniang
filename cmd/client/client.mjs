// 共享 MCP SSE 客户端：连接 / endpoint 握手 / JSON-RPC。
// pending + msgQueue 双缓冲：响应先于等待方注册到达时入队，waitFor 先查队列，
// 不会丢失（若只用 pending，早到的响应会被静默丢弃）。
// 供 test.mjs 等脚本复用。

export const BASE = process.env.MCP_BASE || "http://127.0.0.1:7432";

/**
 * 建立 SSE 连接并完成 initialize 握手。
 * 返回 { rpc(method, params), call(tool, args), init, close() }。
 */
export async function connect({ name = "mcp-client", version = "0.0.1" } = {}) {
  let endpoint = null;
  const msgQueue = [];
  const pending = new Map();
  let nextId = 1;

  // 1) 建立 SSE 长连接并持续读取
  const sseRes = await fetch(`${BASE}/mcp/sse`);
  if (!sseRes.ok || !sseRes.body) throw new Error(`SSE 连接失败: ${sseRes.status}`);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const onSseEvent = (event, data) => {
    if (event === "endpoint") {
      endpoint = data;
      console.log("● 收到 endpoint:", endpoint);
      return;
    }
    if (event === "message") {
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const id = json.id;
      if (id !== undefined && pending.has(id)) {
        const resolve = pending.get(id);
        pending.delete(id);
        resolve(json);
      } else {
        msgQueue.push(json);
      }
    }
  };

  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length) onSseEvent(event, dataLines.join("\n"));
      }
    }
  })();

  // 2) 等待 endpoint 就绪
  for (let i = 0; i < 50 && !endpoint; i++) await new Promise((r) => setTimeout(r, 100));
  if (!endpoint) throw new Error("未在超时内收到 endpoint 事件");

  const waitFor = (id) =>
    new Promise((resolve) => {
      const i = msgQueue.findIndex((m) => m.id === id);
      if (i >= 0) {
        resolve(msgQueue.splice(i, 1)[0]);
        return;
      }
      pending.set(id, resolve);
    });

  const rpc = async (method, params) => {
    const id = nextId++;
    const res = await fetch(`${BASE}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`POST 失败: ${res.status}`);
    }
    return waitFor(id);
  };

  const call = (tool, args) => rpc("tools/call", { name: tool, arguments: args ?? {} });

  // 本客户端走旧版 SSE 通道，故声明该通道所属的协议版本（2024-11-05）；
  // 服务端按请求回显，不必与 Streamable HTTP 通道的版本号保持一致。
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name, version },
  });

  return {
    rpc,
    call,
    init,
    // cancel 后等底层连接真正关闭再返回：立即 process.exit 会在
    // Windows 上撞到 libuv "UV_HANDLE_CLOSING" 断言。
    close: async () => {
      try {
        await reader.cancel();
      } catch {
        /* 连接已断则忽略 */
      }
      await new Promise((r) => setTimeout(r, 150));
    },
  };
}
