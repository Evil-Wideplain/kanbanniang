/**
 * 设置页（表现层）：渲染 MCP 服务、看板娘模型与通用偏好，读写经 ipc/settings。
 * 模型选项来自档案注册表（新增模型只改 core/profiles.ts）；纯 DOM，无框架。
 *
 * 交互策略（即时反馈）：
 * - 模型 / 置顶 / 视线跟随 / 自启 / 不透明度：交互后立刻保存并广播，主窗口即时生效；
 * - 端口：改动会重启 MCP 服务，需点「保存」，期间状态显示「重启中…」；
 * - 运行状态与地址来自后端真实运行态（get_runtime_status），非写死文本。
 */
import { MODEL_PROFILES } from "../core/profiles";
import { DEFAULT_SETTINGS, validateOpacity, validatePort } from "../core/settings";
import { getRuntimeStatus, loadSettings, saveSettings } from "../ipc/settings";
import type { MascotSettings } from "../core/types";

/** 当前选中的模型 id（点击模型芯片时更新）。 */
let selectedModelId: string = DEFAULT_SETTINGS.modelId;

/** 最近一次成功持久化的设置（自动保存以此为基线，避免带上未保存的端口输入）。 */
let persisted: MascotSettings = { ...DEFAULT_SETTINGS };

/** 表单控件的引用集合（初始化时收集，避免各函数重复查询）。 */
interface Controls {
  portInput: HTMLInputElement;
  modelOptions: HTMLElement;
  address: HTMLElement;
  statusPill: HTMLElement;
  mcpEnabled: HTMLButtonElement;
  mcpDetail: HTMLElement;
  alwaysOnTop: HTMLButtonElement;
  gazeFollow: HTMLButtonElement;
  opacity: HTMLInputElement;
  opacityValue: HTMLElement;
  autostart: HTMLButtonElement;
  status: HTMLElement;
}

/** 挂载设置页：绑定表单控件，载入当前设置并回显。 */
export async function mountSettingsPage(): Promise<void> {
  const form = document.getElementById("settings-form") as HTMLFormElement | null;
  const controls = collectControls();
  if (!form || !controls) {
    console.warn("[mascot] 设置页缺少必要节点，跳过初始化");
    return;
  }

  const {
    portInput,
    modelOptions,
    address,
    mcpEnabled,
    opacity,
    opacityValue,
    autostart,
    status,
  } = controls;

  renderModelChips(modelOptions, (name) => {
    void autoApply(controls, `已切换到「${name}」`);
  });

  // 载入当前设置（非 Tauri 环境回退默认值）；模型为空或未知时回显默认档案
  persisted = await loadSettings();
  applySelection(controls, persisted);
  void refreshRuntimeStatus(controls);

  // 端口输入实时预览地址（仅合法时更新，避免回显无效地址）
  portInput.addEventListener("input", () => {
    const port = Number(portInput.value);
    if (validatePort(port) === null) {
      address.textContent = formatAddress(port);
    }
  });

  // 立即生效区：MCP 开关 / 置顶 / 自启 / 不透明度（交互即保存）
  mcpEnabled.addEventListener("click", () => {
    toggleSwitch(mcpEnabled);
    syncMcpDetail(controls);
    void autoApply(controls, isSwitchOn(mcpEnabled) ? "已启用 MCP 服务" : "已关闭 MCP 服务");
  });
  controls.alwaysOnTop.addEventListener("click", () => {
    toggleSwitch(controls.alwaysOnTop);
    void autoApply(controls, "已更新窗口置顶");
  });
  controls.gazeFollow.addEventListener("click", () => {
    toggleSwitch(controls.gazeFollow);
    void autoApply(controls, "已更新视线跟随");
  });
  autostart.addEventListener("click", () => {
    toggleSwitch(autostart);
    void autoApply(controls, "已更新开机自启");
  });
  opacity.addEventListener("input", () => {
    opacityValue.textContent = `${opacity.value}%`;
  });
  opacity.addEventListener("change", () => {
    void autoApply(controls, "已更新不透明度");
  });

  document.getElementById("reset")?.addEventListener("click", () => {
    applySelection(controls, DEFAULT_SETTINGS);
    setStatus(status, "已恢复默认，点「保存」生效", false);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit(controls);
  });
}

/** 收集表单控件；任一缺失返回 null（页面结构异常时跳过初始化）。 */
function collectControls(): Controls | null {
  const portInput = document.getElementById("mcp-port") as HTMLInputElement | null;
  const modelOptions = document.getElementById("model-options") as HTMLElement | null;
  const address = document.getElementById("mcp-address") as HTMLElement | null;
  const statusPill = document.getElementById("mcp-status") as HTMLElement | null;
  const mcpEnabled = document.getElementById("mcp-enabled") as HTMLButtonElement | null;
  const mcpDetail = document.getElementById("mcp-detail") as HTMLElement | null;
  const alwaysOnTop = document.getElementById("always-on-top") as HTMLButtonElement | null;
  const gazeFollow = document.getElementById("gaze-follow") as HTMLButtonElement | null;
  const opacity = document.getElementById("opacity") as HTMLInputElement | null;
  const opacityValue = document.getElementById("opacity-value") as HTMLElement | null;
  const autostart = document.getElementById("autostart") as HTMLButtonElement | null;
  const status = document.getElementById("status") as HTMLElement | null;
  if (
    !portInput ||
    !modelOptions ||
    !address ||
    !statusPill ||
    !mcpEnabled ||
    !mcpDetail ||
    !alwaysOnTop ||
    !gazeFollow ||
    !opacity ||
    !opacityValue ||
    !autostart ||
    !status
  ) {
    return null;
  }
  return {
    portInput,
    modelOptions,
    address,
    statusPill,
    mcpEnabled,
    mcpDetail,
    alwaysOnTop,
    gazeFollow,
    opacity,
    opacityValue,
    autostart,
    status,
  };
}

/** 把设置回显到端口输入、模型芯片、开关、不透明度与地址展示。 */
function applySelection(c: Controls, settings: MascotSettings): void {
  c.portInput.value = String(settings.mcpPort);
  c.address.textContent = formatAddress(settings.mcpPort);
  c.opacity.value = String(settings.opacity);
  c.opacityValue.textContent = `${settings.opacity}%`;
  setSwitch(c.mcpEnabled, settings.mcpEnabled);
  syncMcpDetail(c);
  setSwitch(c.alwaysOnTop, settings.alwaysOnTop);
  setSwitch(c.gazeFollow, settings.gazeFollow);
  setSwitch(c.autostart, settings.autostart);
  selectedModelId = MODEL_PROFILES.some((p) => p.id === settings.modelId)
    ? settings.modelId
    : DEFAULT_SETTINGS.modelId;
  syncChips(c.modelOptions);
}

/** 按 MCP 开关状态置灰/恢复「端口/地址/状态」明细区。 */
function syncMcpDetail(c: Controls): void {
  c.mcpDetail.classList.toggle("disabled", !isSwitchOn(c.mcpEnabled));
}

/** 渲染模型芯片：来自档案注册表，点击即切换选中并立即保存（回调由挂载处注入）。 */
function renderModelChips(root: HTMLElement, onSelect: (name: string) => void): void {
  root.replaceChildren();
  for (const profile of MODEL_PROFILES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.modelId = profile.id;
    chip.textContent = profile.name;
    if (profile.description) {
      chip.title = profile.description;
    }
    chip.addEventListener("click", () => {
      if (selectedModelId === profile.id) {
        return;
      }
      selectedModelId = profile.id;
      syncChips(root);
      onSelect(profile.name);
    });
    root.append(chip);
  }
}

/** 同步芯片选中态（.on / aria-pressed）。 */
function syncChips(root: HTMLElement): void {
  for (const chip of root.querySelectorAll<HTMLButtonElement>(".chip")) {
    const on = chip.dataset.modelId === selectedModelId;
    chip.classList.toggle("on", on);
    chip.setAttribute("aria-pressed", String(on));
  }
}

/** 设置开关的选中态（.on / aria-checked）。 */
function setSwitch(el: HTMLButtonElement, on: boolean): void {
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", String(on));
}

/** 翻转开关选中态。 */
function toggleSwitch(el: HTMLButtonElement): void {
  setSwitch(el, el.getAttribute("aria-checked") !== "true");
}

/** 开关是否处于选中态。 */
function isSwitchOn(el: HTMLButtonElement): boolean {
  return el.getAttribute("aria-checked") === "true";
}

/** 从表单读取当前设置（端口沿用最近一次已保存值）；自动保存与提交共用。 */
function readForm(c: Controls): MascotSettings {
  return {
    ...persisted,
    mcpEnabled: isSwitchOn(c.mcpEnabled),
    modelId: selectedModelId,
    alwaysOnTop: isSwitchOn(c.alwaysOnTop),
    gazeFollow: isSwitchOn(c.gazeFollow),
    opacity: Number(c.opacity.value),
    autostart: isSwitchOn(c.autostart),
  };
}

/**
 * 即时保存非端口项（模型 / 置顶 / 视线跟随 / 自启 / 不透明度），端口沿用最近一次已保存值。
 * 成功后更新基线与提示；失败回滚基线并报错。
 */
async function autoApply(c: Controls, message: string): Promise<void> {
  try {
    persisted = await saveSettings(readForm(c));
    setStatus(c.status, message, false);
  } catch (e) {
    applySelection(c, persisted);
    const text = e instanceof Error ? e.message : String(e);
    setStatus(c.status, `保存失败：${text}`, true);
    console.error("[mascot] 设置自动保存失败", text);
  } finally {
    await refreshRuntimeStatus(c);
  }
}

/** 刷新运行状态药丸与地址（读取后端真实运行态）。 */
async function refreshRuntimeStatus(c: Controls): Promise<void> {
  if (!isSwitchOn(c.mcpEnabled)) {
    setPill(c.statusPill, "off", "已关闭");
    return;
  }
  const { mcpRunning, mcpPort } = await getRuntimeStatus();
  setPill(c.statusPill, mcpRunning ? "running" : "off", mcpRunning ? "运行中" : "未运行");
  // 未重启时地址以真实运行端口为准（配置端口仅作期望值展示）
  if (mcpRunning && validatePort(Number(c.portInput.value)) !== null) {
    c.address.textContent = formatAddress(mcpPort);
  }
}

/** 设置状态药丸的样式与文案（running=绿 / busy=琥珀 / off=灰）。 */
function setPill(pill: HTMLElement, state: "running" | "busy" | "off", text: string): void {
  pill.classList.toggle("off", state === "off");
  pill.classList.toggle("busy", state === "busy");
  const label = pill.querySelector("span");
  if (label) {
    label.textContent = text;
  }
}

/** 组装 MCP 服务地址展示文本。 */
function formatAddress(port: number): string {
  return `127.0.0.1:${port}/mcp/sse`;
}

/** 提交表单：校验端口 → 保存全部设置（端口变化会重启服务）→ 刷新运行状态。 */
async function submit(c: Controls): Promise<void> {
  const port = Number(c.portInput.value);
  const portError = validatePort(port);
  if (portError) {
    setStatus(c.status, portError, true);
    return;
  }
  const opacity = Number(c.opacity.value);
  const opacityError = validateOpacity(opacity);
  if (opacityError) {
    setStatus(c.status, opacityError, true);
    return;
  }

  const restarting =
    isSwitchOn(c.mcpEnabled) && (port !== persisted.mcpPort || !persisted.mcpEnabled);
  if (restarting) {
    setPill(c.statusPill, "busy", "重启中…");
    setStatus(c.status, "正在重启 MCP 服务…", false);
  } else {
    setStatus(c.status, "保存中…", false);
  }

  const payload: MascotSettings = { ...readForm(c), mcpPort: port };
  try {
    persisted = await saveSettings(payload);
    setStatus(c.status, "已保存", false);
    console.info("[mascot] 设置已保存", payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus(c.status, `保存失败：${message}`, true);
    console.error("[mascot] 设置保存失败", message);
  } finally {
    await refreshRuntimeStatus(c);
  }
}

/** 更新状态提示文本；错误态用红色样式。 */
function setStatus(el: HTMLElement, text: string, isError: boolean): void {
  el.textContent = text;
  el.classList.toggle("error", isError);
}
