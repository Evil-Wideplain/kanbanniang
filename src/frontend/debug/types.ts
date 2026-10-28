/**
 * MCP 调试面板的类型契约（表现层）：JSON Schema 子集与 `tools/call` 响应帧的精简视图。
 * 工具清单本体来自单一来源 `src/mcp/tools.json`（经 `shared/domain/types.ts` 的 `MCP_TOOLS`）。
 */

/** 工具入参属性（JSON Schema 子集，仅取渲染所需字段）。 */
export interface InputProperty {
  type?: string;
  description?: string;
}

/** 工具入参 schema（JSON Schema 子集）。 */
export interface InputSchema {
  properties?: Record<string, InputProperty>;
  required?: string[];
}

/** 工具定义（本文档仅用到的字段）。 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: InputSchema;
  query: boolean;
}

/** 调用经命令返回的完整 JSON-RPC 响应帧（rpc.rs 封套）。 */
export interface JsonRpcResponse {
  id?: unknown;
  jsonrpc?: string;
  error?: { code?: number; message?: string };
  result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
}

/** 单个参数控件（取值时从 DOM 读取，避免两处状态）。 */
export interface Field {
  key: string;
  el: HTMLInputElement | HTMLTextAreaElement;
  numeric: boolean;
  /** 数组型参数：控件里是 JSON 文本，收集时解析成数组（容错留在调试层，不进 MCP 契约）。 */
  json?: boolean;
}
