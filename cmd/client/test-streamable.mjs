#!/usr/bin/env node
/**
 * Streamable HTTP 冒烟测试（零依赖，仅用 Node 内置 fetch）。
 *
 * 覆盖 DSH 等新一代 MCP 客户端的接入路径：协议探测 → initialize（拿 Mcp-Session-Id）
 * → initialized 通知（202）→ tools/list → tools/call，并顺带验证 /health 与
 * GET /mcp 的 405 约定。旧版 SSE 传输的冒烟测试见 cmd/client/test.mjs。
 *
 * 用法：先启动应用（make run 或 npm run tauri:dev），再执行
 *   node cmd/client/test-streamable.mjs
 *
 * @module cmd/client/test-streamable
 */

const BASE_URL = process.env.MASCOT_MCP_URL ?? 'http://127.0.0.1:7432';
const ENDPOINT = `${BASE_URL}/mcp`;

/** 顺序递增的 JSON-RPC id。 */
let nextId = 1;

/** 断言失败即抛错，交由 main 统一打印。 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 发送 JSON-RPC 消息；返回解析后的响应体与响应头。 */
async function rpc(method, params, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id') ?? sessionId,
    body: text === '' ? undefined : JSON.parse(text),
  };
}

/** 发送通知（无 id），协议要求回 202。 */
async function notify(method, sessionId) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method }),
  });
  return response.status;
}

/** 调用工具并取出 content[0].text。 */
async function callTool(name, args, sessionId) {
  const { body } = await rpc('tools/call', { name, arguments: args }, sessionId);
  assert(body?.result !== undefined, `tools/call ${name} 没有 result`);
  const text = body.result.content?.[0]?.text;
  return { text: String(text), isError: body.result.isError === true };
}

/** 主流程。 */
async function main() {
  process.stdout.write(`● 端点: ${ENDPOINT}\n`);

  const health = await fetch(`${BASE_URL}/health`);
  assert(health.ok, `健康检查失败 HTTP ${health.status}`);
  const healthBody = await health.json();
  assert(healthBody.ok === true, '健康检查响应缺少 ok:true');
  process.stdout.write(`✅ /health: service=${healthBody.service} version=${healthBody.version}\n`);

  const getProbe = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
  assert(getProbe.status === 405, `GET /mcp 应回 405，实际 ${getProbe.status}`);
  process.stdout.write('✅ GET /mcp → 405（无服务端推送，符合预期）\n');

  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kanbanniang-streamable-smoke', version: '0.1.0' },
  });
  assert(init.status === 200, `initialize HTTP ${init.status}`);
  assert(typeof init.sessionId === 'string' && init.sessionId !== '', 'initialize 未下发 Mcp-Session-Id');
  const serverInfo = init.body?.result?.serverInfo;
  assert(serverInfo?.name === 'kanbanniang', 'serverInfo.name 不匹配');
  process.stdout.write(`✅ initialize: ${serverInfo.name} v${serverInfo.version} session=${init.sessionId}\n`);

  const notified = await notify('notifications/initialized', init.sessionId);
  assert(notified === 202, `initialized 通知应回 202，实际 ${notified}`);
  process.stdout.write('✅ notifications/initialized → 202\n');

  const list = await rpc('tools/list', {}, init.sessionId);
  const tools = list.body?.result?.tools ?? [];
  assert(tools.length >= 11, `工具数量异常: ${tools.length}`);
  process.stdout.write(
    `✅ tools/list: ${tools.length} 个: ${tools.map((tool) => tool.name).join(', ')}\n`,
  );

  const status = await callTool('get_status', {}, init.sessionId);
  assert(status.isError === false, `get_status 失败: ${status.text}`);
  process.stdout.write(`✅ get_status: ${status.text.replace(/\s+/g, ' ').slice(0, 120)}\n`);

  const speak = await callTool('speak', { text: 'Streamable HTTP 冒烟测试通过' }, init.sessionId);
  assert(speak.isError === false, `speak 失败: ${speak.text}`);
  process.stdout.write(`✅ speak: ${speak.text}\n`);

  process.stdout.write('\n🎉 Streamable HTTP 传输全部通过。\n');
}

main().catch((error) => {
  process.stderr.write(`❌ 冒烟测试失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
