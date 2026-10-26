import { afterEach, describe, expect, it, vi } from 'vitest';

import { FRONTEND_PROBE_TOOL, probeFrontend } from './runtime.js';

/**
 * 前端链路探活的单元测试。
 *
 * 这层探活的意义是区分「后端健康」与「前端真的在响应」：`/health` 通过但前端白屏
 * （例如 exe 由 cargo build 直接编出来、前端加载 devUrl 失败）时，插件过去会照写
 * 「就绪」，用户看到的是空白窗口。因此对四种应答形态都要有确定结论：
 * 正常结果 / 工具级错误 / HTTP 错误 / 网络异常或超时。
 */
describe('probeFrontend', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 构造 JSON-RPC 响应。 */
  function jsonRpc(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  }

  it('工具正常返回时判定为就绪', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonRpc({
        jsonrpc: '2.0',
        id: 'kanbanniang-frontend-probe',
        result: { content: [{ type: 'text', text: '{"mode":"live2d"}' }] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeFrontend('http://127.0.0.1:7432/mcp')).resolves.toEqual({ ok: true });

    // 必须真的发出 tools/call，否则探活退化成又一次 /health。
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('http://127.0.0.1:7432/mcp');
    const request = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
    expect(request.method).toBe('tools/call');
    expect(request.params.name).toBe(FRONTEND_PROBE_TOOL);
  });

  it('工具结果标记 isError 时判定为未就绪并带上原因', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRpc({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [{ type: 'text', text: '前端响应超时（5s）' }],
          },
        }),
      ),
    );

    await expect(probeFrontend('http://127.0.0.1:7432/mcp')).resolves.toEqual({
      ok: false,
      reason: '前端未响应: 前端响应超时（5s）',
    });
  });

  it('JSON-RPC error 帧判定为未就绪', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonRpc({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: '方法不存在' } }),
      ),
    );

    await expect(probeFrontend('http://127.0.0.1:7432/mcp')).resolves.toEqual({
      ok: false,
      reason: '工具调用失败: 方法不存在',
    });
  });

  it('HTTP 非 2xx 时给出状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 405 })));

    await expect(probeFrontend('http://127.0.0.1:7432/mcp')).resolves.toEqual({
      ok: false,
      reason: 'HTTP 405',
    });
  });

  it('事件流形式的响应也能解析', async () => {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(`event: message\ndata: ${frame}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );

    await expect(probeFrontend('http://127.0.0.1:7432/mcp')).resolves.toEqual({ ok: true });
  });

  it('连接失败时把异常信息作为原因', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    await expect(probeFrontend('http://127.0.0.1:7432/mcp')).resolves.toEqual({
      ok: false,
      reason: 'connect ECONNREFUSED',
    });
  });

  it('超时判定为前端无响应', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          }),
      ),
    );

    await expect(probeFrontend('http://127.0.0.1:7432/mcp', 10)).resolves.toEqual({
      ok: false,
      reason: '前端响应超时（10ms）',
    });
  });
});
