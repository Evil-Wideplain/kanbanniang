/**
 * 主窗口（表现层）：装配气泡、模型管理器与 Tauri 事件通道。
 * 只做接线，不写业务分支（命令分发见 mascot/application/dispatcher.ts）。
 */
import "../styles/main.css";
import { handleCommand, type CommandCtx } from "@/mascot/application/dispatcher";
import { createModelManager } from "@/mascot/application/model-switch";
import { createBubble } from "@/mascot/ui/bubble";
import { connectTauriEvents } from "@/shared/ipc/events";
import { installLogForwarding } from "@/shared/ipc/log-forward";
import { loadSettings, onSettingsChanged } from "@/shared/ipc/settings-client";
import { moveWindow } from "@/shared/ipc/window";

/**
 * 应用看板娘不透明度：写到 CSS 变量 `--mascot-opacity`，由 `#stage` 引用。
 * 用变量而非直接改元素样式，模型热切换重建画布后仍能沿用。
 */
function applyOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent));
  document.documentElement.style.setProperty("--mascot-opacity", String(clamped / 100));
}

async function bootstrap() {
  // 0) 日志转发：安装后 [mascot] 日志经 Tauri 上报（由 tauri 插件自动落盘）
  installLogForwarding();

  // 1) 说话气泡
  const bubble = createBubble();

  // 2) 模型管理器：按已保存配置加载；缺失或未知时按默认档案启动
  const settings = await loadSettings();
  applyOpacity(settings.opacity);
  const initialCanvas = document.getElementById("stage") as HTMLCanvasElement;
  const mgr = await createModelManager(initialCanvas, settings.modelId, settings.gazeFollow);

  // 3) 指令上下文（模型切换、气泡、窗口移动注入 dispatcher）
  const ctx: CommandCtx = {
    setModel: (id) => mgr.setModel(id),
    currentModelId: () => mgr.currentModelId(),
    showBubble: (text) => bubble.show(text),
    moveWindow: (x, y) => moveWindow(x, y),
  };

  // 4) 监听设置变更：实时应用不透明度与视线跟随
  void onSettingsChanged((next) => {
    applyOpacity(next.opacity);
    mgr.setGaze(next.gazeFollow);
    console.info("[mascot] 已响应设置变更", {
      opacity: next.opacity,
      gazeFollow: next.gazeFollow,
    });
  });

  // 5) 连接 Tauri 事件通道，把指令交给前端分发器
  await connectTauriEvents((cmd) => handleCommand(cmd, mgr.controller(), ctx));
}

bootstrap();
