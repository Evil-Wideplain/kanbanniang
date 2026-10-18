/**
 * 调试面板调用日志视图（表现层）：按工具分组存储条目、渲染当前工具日志。
 * 每个工具各有独立日志组（不共享）：切换左侧工具即切换右下日志内容。
 */

/** 日志视图：持有日志分组与当前可见工具，供面板调用。 */
export interface LogView {
  /** 切换可见工具：右下日志替换为该工具自己的记录并滚到底。 */
  show(name: string): void;
  /** 追加「调用中」条目：登记到该工具分组；仅当该工具可见时才上屏并滚到底。 */
  begin(name: string, args: Record<string, unknown>): HTMLElement;
  /** 以结果更新条目：状态 pill + 返回文本（完整 JSON-RPC 响应帧；高度不截断）。 */
  finish(entry: HTMLElement, ok: boolean, text: string): void;
  /** 清空指定工具的日志并刷新视图。 */
  clear(name: string): void;
}

/** 创建日志视图，绑定到日志容器 `root`。 */
export function createLogView(root: HTMLElement): LogView {
  const groups: Record<string, HTMLElement[]> = {};
  let visible = "";

  function show(name: string): void {
    visible = name;
    root.replaceChildren(...(groups[name] ?? []));
    root.scrollTop = root.scrollHeight;
  }

  function begin(name: string, args: Record<string, unknown>): HTMLElement {
    const box = document.createElement("div");
    box.className = "lrow lrow--busy";

    const head = document.createElement("div");
    head.className = "lrow__head";
    const time = document.createElement("span");
    time.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const tool = document.createElement("span");
    tool.className = "mono";
    tool.textContent = `${name} ${JSON.stringify(args)}`;
    const pill = document.createElement("span");
    pill.className = "pill busy";
    pill.textContent = "调用中";
    head.append(time, tool, pill);

    const pre = document.createElement("pre");
    pre.className = "lrow__text";
    pre.textContent = "…";

    box.append(head, pre);
    const list = (groups[name] ??= []);
    list.push(box);
    if (visible === name) {
      root.append(box);
      root.scrollTop = root.scrollHeight;
    }
    return box;
  }

  function finish(entry: HTMLElement, ok: boolean, text: string): void {
    entry.classList.remove("lrow--busy");
    entry.classList.add(ok ? "lrow--ok" : "lrow--err");
    const pill = entry.querySelector(".pill");
    if (pill) {
      pill.className = ok ? "pill ok" : "pill err";
      pill.textContent = ok ? "成功" : "失败";
    }
    const pre = entry.querySelector("pre");
    if (pre) {
      pre.textContent = text || "（空响应）";
    }
    if (entry.parentElement === root) {
      root.scrollTop = root.scrollHeight;
    }
  }

  function clear(name: string): void {
    groups[name] = [];
    if (visible === name) {
      show(name);
    }
  }

  return { show, begin, finish, clear };
}
