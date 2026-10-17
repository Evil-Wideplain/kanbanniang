/**
 * 前端组合根（表现层）：装配气泡、模型管理器与 Tauri 事件通道。
 * 只做接线，不写业务分支（动作语义见 core/dispatcher.ts）。
 */
import "./style.css";
import { handleCommand, type CommandCtx } from "./core/dispatcher";
import { createModelManager } from "./core/model-switch";
import { createBubble } from "./ui/bubble";
import { connectTauriEvents } from "./ipc/events";
import { installLogForwarding } from "./ipc/log-forward";
import { loadSettings, onSettingsChanged } from "./ipc/settings";

/**
 * 应用看板娘不透明度：写入 CSS 变量 `--mascot-opacity`（作用于 #stage 画布）。
 * 用变量而非直接改元素样式，模型热切换重建画布后仍能沿用。
 */
function applyOpacity(percent: number): void {
  const clamped = Math.min(100, Math.max(0, percent));
  document.documentElement.style.setProperty("--mascot-opacity", String(clamped / 100));
}

async function bootstrap() {
  // 0) 日志转发：安装后 [mascot] 日志会经 Tauri 上报后端落盘（非 Tauri 环境自动降级）
  installLogForwarding();

  // 1) 说话气泡
  const bubble = createBubble();

  // 2) 模型生命周期：按已保存设置（缺失则默认档案）初始化，含静默降级；支持运行时热切换
  const settings = await loadSettings();
  applyOpacity(settings.opacity);
  const initialCanvas = document.getElementById("stage") as HTMLCanvasElement;
  const mgr = await createModelManager(initialCanvas, settings.modelId, settings.gazeFollow);

  // 3) 指令上下文：切换能力 + 气泡注入（dispatcher 保持与 DOM 解耦）
  const ctx: CommandCtx = {
    setModel: (id) => mgr.setModel(id),
    currentModelId: () => mgr.currentModelId(),
    showBubble: (text) => bubble.show(text),
  };

  // 4) 订阅设置变更：保存后实时应用不透明度与视线跟随（其它设置由后端作用于窗口/系统）
  void onSettingsChanged((next) => {
    applyOpacity(next.opacity);
    mgr.setGaze(next.gazeFollow);
    console.info("[mascot] 已应用设置变更", {
      opacity: next.opacity,
      gazeFollow: next.gazeFollow,
    });
  });

  // 5) 连接 Tauri 事件通道，把指令分发给当前控制器
  await connectTauriEvents((cmd) => handleCommand(cmd, mgr.controller(), ctx));
}

bootstrap();
