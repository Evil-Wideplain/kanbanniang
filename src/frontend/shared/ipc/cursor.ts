/**
 * 全局光标位置源（基础设施层）。
 *
 * 仅 Tauri 环境可用：按需轮询系统光标位置（鼠标不在窗口内也有效），并换算为看板娘画布坐标
 * （画布左上角为原点、单位为 CSS 逻辑像素）。窗口移动/缩放/监视器缩放变化时刷新原点，
 * 故拖动画布后坐标依然正确。
 * 消费方：全屏视线跟随与鼠标穿透判定（渲染层据此判断是否落在角色像素上），故常驻轮询。
 * 非 Tauri 环境（浏览器调试）无全局光标接口：不做跟踪（窗口内跟随由渲染层自行处理）。
 * 纯位置传输，不理解看板娘语义；调用方负责把坐标交给控制器。
 */

/** 画布逻辑坐标点（原点为画布左上角）。 */
export interface CursorPoint {
  x: number;
  y: number;
}

/** 轮询间隔（毫秒）：约 30fps，足够驱动焦点插值且 IPC 开销可控。 */
const POLL_INTERVAL_MS = 33;

/**
 * 开始跟踪光标；返回停止函数（幂等，可重复调用）。
 * 位置以画布逻辑像素回传；非 Tauri 环境或读取失败时停止跟踪并告警一次，不阻断主流程。
 *
 * `onWindowMoved` 在窗口被移动（含拖拽移动、平滑移动命令、缩放）时回调：
 * 鼠标穿透的「按下期抑制」用它判断窗口是否仍在被拖动——Tauri 的 startDragging 会进入
 * OS 模态拖动循环，WebView 收不到 pointerup，只有窗口移动事件能反映拖动还在继续。
 *
 * `onUnavailable` 在光标源不可用/中断时回调一次：调用方据此把窗口恢复为可交互
 * （穿透态下没有光标流就再也收不到鼠标消息，必须留兜底出口）。
 */
export function startCursorTracking(
  onPoint: (point: CursorPoint) => void,
  onWindowMoved?: () => void,
  onUnavailable?: () => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanups: Array<() => void> = [];

  /** 停止跟踪并释放所有监听/定时器。 */
  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
      console.info("[mascot] 全局光标轮询已停止");
    }
    for (const fn of cleanups) {
      try {
        fn();
      } catch (e) {
        // 清理失败不应影响停止流程，仅告警
        console.warn("[mascot] 光标跟踪清理失败:", e);
      }
    }
    cleanups.length = 0;
  }

  const emit = (x: number, y: number): void => {
    if (!stopped) onPoint({ x, y });
  };

  /** Tauri：轮询全局光标，缓存窗口原点与缩放因子。 */
  const setupTauri = async (): Promise<void> => {
    const { getCurrentWindow, cursorPosition } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const readOrigin = async (): Promise<[CursorPoint, number]> => [
      await win.innerPosition(),
      await win.scaleFactor(),
    ];
    let [origin, scale] = await readOrigin();
    const refresh = async (): Promise<void> => {
      [origin, scale] = await readOrigin();
    };
    cleanups.push(
      await win.onMoved(() => {
        onWindowMoved?.();
        void refresh();
      }),
    );
    cleanups.push(await win.onResized(() => void refresh()));
    cleanups.push(await win.onScaleChanged(() => void refresh()));

    // 初始化是异步的：等待期间就被停止（如刚建好控制器又热切换）时，
    // 必须把已注册的监听清掉并且不启动定时器，否则会留下永不释放的空转 interval。
    if (stopped) {
      for (const fn of cleanups) {
        try {
          fn();
        } catch (e) {
          console.warn("[mascot] 光标跟踪清理失败:", e);
        }
      }
      cleanups.length = 0;
      return;
    }

    let busy = false;
    let samples = 0;
    timer = setInterval(() => {
      if (stopped || busy) return;
      busy = true;
      cursorPosition()
        .then((p) => {
          // 首次校准记录一次：坐标不对时（穿透区域与角色错位）能直接看出原点/缩放是否正确
          if (samples === 10) {
            console.info("[mascot] 光标坐标映射已校准", {
              origin: [origin.x, origin.y],
              scale,
              cursor: [Math.round(p.x), Math.round(p.y)],
            });
          }
          samples += 1;
          emit((p.x - origin.x) / scale, (p.y - origin.y) / scale);
        })
        .catch((e) => {
          // 读取失败（权限/平台不支持）：告警一次、通知调用方兜底并停止，避免每帧刷屏
          console.warn("[mascot] 读取全局光标失败，全屏视线跟随与鼠标穿透均不可用:", e);
          onUnavailable?.();
          stop();
        })
        .finally(() => {
          busy = false;
        });
    }, POLL_INTERVAL_MS);
    console.info("[mascot] 全局光标轮询已开启");
  };

  void setupTauri().catch((e) => {
    // 非 Tauri 环境无全局光标接口：仅记录一次，窗口内跟随由渲染层负责
    console.warn("[mascot] 全局光标不可用，全屏视线跟随仅在 Tauri 环境生效:", e);
    onUnavailable?.();
    stop();
  });

  return stop;
}
