/**
 * 拖放提示浮层（表现层）。
 * 拖拽文件悬停在看板娘窗口时显示，离开或松手后隐藏；纯 DOM，无框架。
 * 节点动态创建并挂在 body 末尾（主窗口只有一个画布，无需改 index.html）。
 */
export interface DropOverlay {
  /** 显示或隐藏浮层（幂等）。 */
  setActive(active: boolean): void;
}

/** 创建浮层并挂到 body（样式见 styles/main.css 的 .drop-overlay）。 */
export function createDropOverlay(): DropOverlay {
  const el = document.createElement("div");
  el.className = "drop-overlay";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <div class="drop-overlay-card">
      <span class="drop-overlay-icon" aria-hidden="true">⤓</span>
      <p class="drop-overlay-title">松开以导入 Live2D 模型</p>
      <p class="drop-overlay-hint">支持 .zip 压缩包，或包含 *.model3.json 的模型文件夹</p>
    </div>`;
  document.body.append(el);
  return {
    setActive(active: boolean): void {
      el.classList.toggle("show", active);
      el.setAttribute("aria-hidden", String(!active));
    },
  };
}
