/**
 * MCP 调试面板（表现层）：左侧工具清单、右上参数卡、右下调用日志的三栏实现。
 * 由组合根 `app/debug.ts` 调用 `mountDebugPanel()` 挂载。
 *
 * 仅开发构建创建该窗口（见 Rust `debug.rs`）；工具清单与参数取自单一来源 `src/mcp/tools.json`
 * （经 `shared/domain/types.ts` 的 `MCP_TOOLS` 导入，与 Rust 侧同源）。
 * 调用经命令 `mcp_debug_call`（见 `./ipc.ts`）走完整 `tools/call`，日志展示原始响应帧。
 * 参数纯函数在 `./args.ts`，日志视图在 `./log-view.ts`。
 */
import { MCP_TOOLS } from "@/shared/domain/types";
import { wireWindowControls } from "@/shared/ui/window-controls";
import { asModelIds, asStringArray, collect, defaultArgs, isNumeric, prefillFor } from "./args";
import { callToolFrame, queryResult } from "./ipc";
import { createLogView } from "./log-view";
import type { Field, InputProperty, ToolDef } from "./types";

/** 需要候选值（datalist）的参数名 → 提供候选的工具名。 */
const CANDIDATE_SOURCES: Record<string, string> = {
  motion: "list_motions",
  expression: "list_expressions",
  model: "list_models",
};

const TOOLS = MCP_TOOLS as unknown as ToolDef[];
/** 参数候选值（开场经 list_* 工具拉取，随后填充 datalist 与空参数）。 */
const candidates: Record<string, string[]> = {};
/** 左侧当前选中工具的下标；-1 表示未选。 */
let selected = 0;
/** 当前参数卡上的控件集合（collect 取值用），切工具时整卡重建。 */
let activeFields: Field[] = [];

const toolsRoot = requireEl("tools");
const paramsRoot = requireEl("params");
const logRoot = requireEl("log");
const logView = createLogView(logRoot);

/** 按 id 取元素，缺失即抛（页面结构固定，属编程缺陷而非运行时输入）。 */
function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`[mascot] 调试面板缺少元素 #${id}`);
  }
  return el;
}

/** 左侧工具清单：工具名 + 「查询/动作」徽标，点击选中。 */
function renderTools(): void {
  const items = TOOLS.map((tool, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tool-item";

    const name = document.createElement("span");
    name.className = "tool-item__name";
    name.textContent = tool.name;

    const badge = document.createElement("span");
    badge.className = `badge${tool.query ? " badge--query" : " badge--act"}`;
    badge.textContent = tool.query ? "查询" : "动作";

    btn.append(name, badge);
    btn.title = tool.description;
    btn.addEventListener("click", () => selectTool(index));
    return btn;
  });
  toolsRoot.replaceChildren(...items);
}

/** 选中某工具：高亮左侧项，重建右上参数卡，并把右下日志切到该工具自己的记录。 */
function selectTool(index: number): void {
  selected = index;
  Array.from(toolsRoot.children).forEach((el, i) => el.classList.toggle("on", i === index));
  renderParams();
  logView.show(TOOLS[selected].name);
}

/** 构建一个参数控件并登记到 `out`（预填默认值；候选型参数挂 datalist）。 */
function buildField(key: string, prop: InputProperty, out: Field[]): HTMLElement {
  const numeric = isNumeric(prop);
  let el: HTMLInputElement | HTMLTextAreaElement;
  if (key === "text") {
    const area = document.createElement("textarea");
    area.rows = 2;
    el = area;
  } else {
    const input = document.createElement("input");
    input.type = numeric ? "number" : "text";
    if (numeric) {
      input.step = key === "index" ? "1" : "0.1";
    }
    el = input;
  }
  el.className = "field-input";
  el.title = prop.description ?? "";
  el.setAttribute("placeholder", prop.description ?? key);
  el.value = prefillFor(candidates, key);
  if (!numeric && key in CANDIDATE_SOURCES) {
    el.setAttribute("list", `cand-${key}`);
  }
  out.push({ key, el, numeric });
  return el;
}

/** 重建右上参数卡：工具名 + 说明 + 参数行 + 调用按钮。 */
function renderParams(): void {
  const tool = TOOLS[selected];
  activeFields = [];

  const tape = document.createElement("span");
  tape.className = "tape";
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = "参数";

  const body = document.createElement("div");
  body.className = "params-body";

  const title = document.createElement("div");
  title.className = "params-name";
  title.textContent = tool.name;

  const desc = document.createElement("p");
  desc.className = "params-desc";
  desc.textContent = tool.description;

  body.append(title, desc);

  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  for (const [key, prop] of Object.entries(props)) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.className = "lbl";
    label.textContent = required.has(key) ? `${key} *` : key;
    row.append(label, buildField(key, prop, activeFields));
    body.append(row);
  }
  if (activeFields.length === 0) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.className = "lbl";
    label.textContent = "参数";
    const none = document.createElement("span");
    none.className = "mono";
    none.textContent = "无参数，直接调用";
    row.append(label, none);
    body.append(row);
  }

  const actions = document.createElement("footer");
  actions.className = "actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "save";
  btn.textContent = "调用";
  btn.addEventListener("click", () => {
    void callTool(tool.name, collect(activeFields));
  });
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = tool.query ? "查询型：等待看板娘回传（最多 5s）" : "动作型：下发即返回";
  actions.append(btn, msg);

  // 内容装进滚动层：窗口/内容变矮时参数卡内部滚动，卡片与胶带整体不越出背景
  const scroll = document.createElement("div");
  scroll.className = "params-scroll";
  scroll.append(body, actions);

  paramsRoot.replaceChildren(tape, tag, scroll);
}

/** 调用一个工具并追加日志：展示完整 JSON-RPC 响应帧；失败不中断调用方流程。 */
async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  const entry = logView.begin(name, args);
  try {
    const frame = await callToolFrame(name, args);
    logView.finish(entry, frame.error === undefined, JSON.stringify(frame, null, 2));
  } catch (e) {
    logView.finish(entry, false, e instanceof Error ? e.message : String(e));
  }
}

/** 取得（必要时创建）参数候选用的 datalist。 */
function ensureDatalist(key: string): HTMLDataListElement {
  const id = `cand-${key}`;
  const existing = document.getElementById(id);
  if (existing instanceof HTMLDataListElement) {
    return existing;
  }
  const list = document.createElement("datalist");
  list.id = id;
  document.body.append(list);
  return list;
}

/** 记录候选值 → 填 datalist → 给参数卡上仍为空的对应字段补首项（不覆盖已输入内容）。 */
function assignCandidates(key: string, values: string[]): void {
  candidates[key] = values;
  const list = ensureDatalist(key);
  list.replaceChildren(
    ...values.map((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      return opt;
    }),
  );
  const first = values[0];
  if (first === undefined) {
    return;
  }
  for (const field of activeFields) {
    if (field.key === key && field.el.value.trim() === "") {
      field.el.value = first;
    }
  }
}

/** 开场拉取动作 / 表情 / 模型候选值（失败仅告警，不影响手动输入）。 */
async function loadCandidates(): Promise<void> {
  try {
    const [motions, expressions, models] = await Promise.all([
      queryResult("list_motions"),
      queryResult("list_expressions"),
      queryResult("list_models"),
    ]);
    assignCandidates("motion", asStringArray(motions));
    assignCandidates("expression", asStringArray(expressions));
    assignCandidates("model", asModelIds(models));
  } catch (e) {
    console.warn("[mascot] 拉取工具候选值失败（可手动输入）：", e);
  }
}

/** 依次调用全部工具（默认参数；顺序 await 保证日志顺序，失败不中断）。 */
async function callAll(): Promise<void> {
  for (const tool of TOOLS) {
    await callTool(tool.name, defaultArgs(candidates, tool));
  }
}

/** 挂载调试面板：渲染工具清单与首个参数卡、拉取候选值、接线按钮（仅调用一次）。 */
export function mountDebugPanel(): void {
  document.getElementById("call-all")?.addEventListener("click", () => void callAll());
  // 清空仅作用于当前选中工具的日志（日志按工具分组，不共享）
  document.getElementById("clear-log")?.addEventListener("click", () => {
    logView.clear(TOOLS[selected].name);
  });

  renderTools();
  selectTool(0);
  void loadCandidates();
  void wireWindowControls();
}
