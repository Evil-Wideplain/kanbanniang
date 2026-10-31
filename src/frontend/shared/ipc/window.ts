/**
 * 主窗口传输（基础设施层）：窗口位置与鼠标穿透。
 * - `moveWindow`：把窗口平滑滑到当前显示器工作区的归一化坐标（约 0.6s、smoothstep 缓入缓出）；
 * - `setClickThrough`：整窗鼠标穿透开关（空白区域让鼠标事件落到下层窗口）。
 * 几何换算与结果回读是纯函数（`shared/domain/window-move.ts`），本模块只做窗口 API 读写；
 * 非 Tauri 环境向上抛错，由调用方决定降级方式。
 */
import type { WindowMoveOutcome } from "@/shared/domain/types";
import { easeAt, planMove, readOutcome, type MoveFrame } from "@/shared/domain/window-move";

/** 滑行时长（毫秒）：须远小于查询型工具的 5s 超时。 */
const GLIDE_MS = 600;
/** 步进间隔（毫秒）：约 60fps。 */
const FRAME_MS = 16;

/**
 * 滑行代次：新请求递增，旧循环发现代次变化即让位并把结果标记为 superseded。
 * 位置写入是「后写者赢」，抢占只需旧循环停下，故不需要锁。
 */
let glideGeneration = 0;

/**
 * 平滑移动主窗口到工作区归一化坐标（MCP `move` 工具经 `dispatcher` 调入）。
 * 失败（含非 Tauri 环境、窗口不在任何显示器上）向上抛错，由调用方决定降级方式。
 */
export async function moveWindow(x: number, y: number): Promise<WindowMoveOutcome> {
  const { PhysicalPosition, currentMonitor, getCurrentWindow } = await import(
    "@tauri-apps/api/window"
  );
  const win = getCurrentWindow();
  const generation = (glideGeneration += 1);

  // 托盘隐藏的窗口先显示（只 show 不聚焦，避免抢用户焦点）。
  if (!(await win.isVisible())) {
    await win.show();
  }

  const monitor = await currentMonitor();
  if (monitor === null) {
    throw new Error("当前窗口不在任何显示器上");
  }
  const frame = planMove(
    { x, y },
    {
      workArea: {
        x: monitor.workArea.position.x,
        y: monitor.workArea.position.y,
        width: monitor.workArea.size.width,
        height: monitor.workArea.size.height,
      },
      outerSize: await win.outerSize(),
      start: await win.outerPosition(),
    },
  );

  const setPosition = async (px: number, py: number): Promise<void> => {
    await win.setPosition(new PhysicalPosition(px, py));
  };
  // 已在目标点：幂等快路径，不空转 600ms。
  const arrived = frame.startX === frame.targetX && frame.startY === frame.targetY;
  const superseded = arrived ? false : await glide(setPosition, frame, generation);

  // 读回真实终点，而不是假定目标达成：被抢占或被窗口管理器吸附时以实际位置为准。
  const outcome = readOutcome(frame, await win.outerPosition(), superseded);
  console.info("[mascot] 窗口移动完成", { ...outcome });
  return outcome;
}

/**
 * 滑行循环：按 elapsed / GLIDE_MS 求缓动进度并写窗口位置。
 * 被更新的移动请求抢占时提前返回 true（本请求未滑到终点）。
 */
async function glide(
  setPosition: (x: number, y: number) => Promise<void>,
  frame: MoveFrame,
  generation: number,
): Promise<boolean> {
  const began = performance.now();
  for (;;) {
    if (glideGeneration !== generation) {
      return true; // 已有更新请求：让位，不再写位置
    }
    const t = Math.min((performance.now() - began) / GLIDE_MS, 1);
    const ease = easeAt(t);
    await setPosition(
      Math.round(frame.startX + (frame.targetX - frame.startX) * ease),
      Math.round(frame.startY + (frame.targetY - frame.startY) * ease),
    );
    if (t >= 1) {
      return false;
    }
    await sleep(FRAME_MS);
  }
}

/** 等待若干毫秒。用定时器而非 `requestAnimationFrame`：隐藏窗口下 rAF 会被节流甚至停帧。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 切换整窗鼠标穿透：`ignore=true` 时窗口不再接收鼠标消息（点击/悬停落到下层窗口）。
 * 由渲染层按「光标是否落在角色像素上」的结果驱动；重复设置同一状态是幂等的。
 * 非 Tauri 环境（浏览器调试）向上抛错，调用方须容忍（穿透能力仅 Tauri 存在）。
 */
export async function setClickThrough(ignore: boolean): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke<void>("set_click_through", { ignore });
}
