/**
 * 主窗口（表现层）：装配气泡、模型管理器与 Tauri 事件通道。
 * 只做接线，不写业务分支（命令分发见 mascot/application/dispatcher.ts）。
 */
import "../styles/main.css";
import { handleCommand, type CommandCtx } from "@/mascot/application/dispatcher";
import { installModelImport } from "@/mascot/application/model-import";
import { createModelManager } from "@/mascot/application/model-switch";
import { createBubble } from "@/mascot/ui/bubble";
import { createDropOverlay } from "@/mascot/ui/drop-overlay";
import { connectTauriEvents } from "@/shared/ipc/events";
import { installLogForwarding } from "@/shared/ipc/log-forward";
import { loadImportedProfiles } from "@/shared/ipc/model-import";
import { loadSettings, onSettingsChanged } from "@/shared/ipc/settings-client";
import { moveWindow, setClickThrough } from "@/shared/ipc/window";

/**
 * 应用看板娘不透明度：写到 CSS 变量 `--mascot-opacity`，由 `#stage` 引用。
 * 用变量而非直接改元素样式，模型热切换重建画布后仍能沿用。
 */
function applyOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent));
  document.documentElement.style.setProperty("--mascot-opacity", String(clamped / 100));
}

/**
 * 气泡底边距：渲染层在每次布局后算出「距窗口底部的距离」（跟着实际模型高度与锚点走），
 * 这里只负责写进 CSS 变量 —— 气泡因此贴在角色头顶而不是窗口顶部/底部。
 */
function applyBubbleBottom(bottomPx: number): void {
  document.documentElement.style.setProperty("--bubble-bottom", `${bottomPx}px`);
}

async function bootstrap() {
  // 0) 日志转发：安装后 [mascot] 日志经 Tauri 上报（由 tauri 插件自动落盘）
  installLogForwarding();

  // 1) 说话气泡与拖放浮层
  const bubble = createBubble();
  const dropOverlay = createDropOverlay();

  // 2) 先注册运行时导入的模型档案：已保存的 modelId 可能指向某个导入模型
  await loadImportedProfiles();

  // 3) 模型管理器：按已保存配置加载；缺失或未知时按默认档案启动
  const settings = await loadSettings();
  applyOpacity(settings.opacity);
  const initialCanvas = document.getElementById("stage") as HTMLCanvasElement;
  const mgr = await createModelManager(initialCanvas, settings.modelId, settings.gazeFollow);
  // 台词出口：动作序列里每步的 text 也走同一个气泡（热切换后自动沿用）
  mgr.setSpeechSink((text) => bubble.show(text));
  // 气泡底边出口：布局每次变化（窗口缩放/锚点/换模型）都会回调，写进 CSS 变量即可
  mgr.setBubbleBottomSink(applyBubbleBottom);
  // 鼠标穿透出口：渲染层按「光标是否在角色像素上」算出 ignore，这里执行整窗开关。
  // 非 Tauri 环境（浏览器调试）命令不存在：失败仅告警，不影响其他功能。
  mgr.setClickThroughSink((ignore) => {
    void setClickThrough(ignore).catch((e: unknown) => {
      console.warn("[mascot] 设置鼠标穿透失败:", e);
    });
  });

  // 4) 指令上下文（模型切换、窗口移动注入 dispatcher；气泡唯一出口是控制器的 speechSink）
  const ctx: CommandCtx = {
    setModel: (id) => mgr.setModel(id),
    currentModelId: () => mgr.currentModelId(),
    moveWindow: (x, y) => moveWindow(x, y),
  };

  // 5) 拖拽导入模型：拖入 .zip / 模型文件夹即解析配置、落盘并热切换
  await installModelImport({
    setModel: (id) => mgr.setModel(id),
    showBubble: (text) => bubble.show(text),
    setDropActive: (active) => dropOverlay.setActive(active),
  });

  // 6) 监听设置变更：实时应用不透明度与视线跟随
  void onSettingsChanged((next) => {
    applyOpacity(next.opacity);
    mgr.setGaze(next.gazeFollow);
    console.info("[mascot] 已响应设置变更", {
      opacity: next.opacity,
      gazeFollow: next.gazeFollow,
    });
  });

  // 7) 连接 Tauri 事件通道，把指令交给前端分发器
  await connectTauriEvents((cmd) => handleCommand(cmd, mgr.controller(), ctx));
}

bootstrap();
