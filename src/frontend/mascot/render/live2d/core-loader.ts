/**
 * Cubism Core 运行时装载（渲染层基础设施）：注入 live2dcubismcore.min.js，
 * 并为 Cubism Core 6 补上 pixi-live2d-display 0.4.0 仍读取的旧字段。
 * 只在创建控制器时使用，与控制器状态无关。
 */
import cubismCoreUrl from "./live2dcubismcore.min.js?url";

/**
 * Cubism Core 6 把渲染顺序从 `drawables.renderOrders` 移到 `model.getRenderOrders()`，
 * 而 pixi-live2d-display 0.4.0 仍读取旧字段；缺失时渲染阶段拿到 undefined，
 * 表现为模型加载成功却完全不显示。这里给每个新建模型补一个只读兼容 getter。
 */
function patchCubismCoreCompat(core: unknown): void {
  // 第三方运行时无类型定义，统一在此收口；类型断言只用于读取其内部结构。
  const coreAny = core as any;
  const Model = coreAny?.Model;
  if (!Model || typeof Model.fromMoc !== "function" || typeof Model.prototype?.getRenderOrders !== "function") return;
  if (coreAny?.Version?.csmGetLatestMocVersion?.() < 6) return;
  if (Model.fromMoc.__renderOrdersCompat) return;

  const original = Model.fromMoc;
  let logged = false;
  const fromMoc = function (this: unknown, moc: unknown) {
    const model = original.call(this, moc);
    const drawables = model?.drawables;
    if (drawables && !("renderOrders" in drawables)) {
      Object.defineProperty(drawables, "renderOrders", {
        configurable: true,
        get: () => model.getRenderOrders(),
      });
      if (!logged) {
        logged = true;
        console.info("[mascot] Cubism Core 6 兼容层已启用：drawables.renderOrders → model.getRenderOrders()");
      }
    }
    return model;
  };
  Object.defineProperty(fromMoc, "__renderOrdersCompat", { value: true });
  Model.fromMoc = fromMoc;
}

/** 装载 Cubism Core：已存在则只补兼容层，否则注入脚本后补兼容层。 */
export async function loadCubismCore(): Promise<void> {
  const existing = (window as any).Live2DCubismCore;
  if (existing) {
    patchCubismCoreCompat(existing);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = cubismCoreUrl;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("无法加载 Cubism Core 运行时资源（src/frontend/mascot/render/live2d/live2dcubismcore.min.js）"));
    document.head.appendChild(s);
  });
  patchCubismCoreCompat((window as any).Live2DCubismCore);
}
