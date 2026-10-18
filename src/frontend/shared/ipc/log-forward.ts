/**
 * 前端日志转发（基础设施层）：拦截带 [mascot] 前缀的 console 日志，
 * 经官方日志插件 JS 桥（@tauri-apps/plugin-log）上报后端统一落盘（release 无 DevTools 时仍可追溯）。
 * 由组合根在启动早期安装；非 Tauri 环境静默降级为仅本地 console。
 */

/** 附加数据序列化后的长度上限（字符）：防止大对象把日志文件撑爆。 */
const MAX_DATA_CHARS = 2000;

type LogLevel = "info" | "warn" | "error";
type LogFn = (message: string) => Promise<void>;

let senders: Record<LogLevel, LogFn> | null = null;
let unavailable = false;

/** 安装转发：包装 console.info/warn/error；其他方法与无前缀日志不受影响。 */
export function installLogForwarding(): void {
  const levels: LogLevel[] = ["info", "warn", "error"];
  for (const level of levels) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const message = args[0];
      if (typeof message !== "string" || !message.startsWith("[mascot")) return;
      void forward(level, message, args.slice(1));
    };
  }
}

/** 尽力转发：任何失败都不影响本地 console 输出与主流程（日志是旁路）。 */
async function forward(level: LogLevel, message: string, extra: unknown[]): Promise<void> {
  const log = await sendersOf();
  if (!log) return;
  const data = serialize(extra);
  try {
    await log[level](data ? `${message} data=${data}` : message);
  } catch {
    // 单次转发失败（如权限缺失）忽略，下次仍会尝试
  }
}

/** 懒加载官方插件 JS 桥；不可用（非 Tauri 环境）时停止后续尝试。 */
async function sendersOf(): Promise<Record<LogLevel, LogFn> | null> {
  if (senders) return senders;
  if (unavailable) return null;
  try {
    const mod = await import("@tauri-apps/plugin-log");
    senders = { info: mod.info, warn: mod.warn, error: mod.error };
    return senders;
  } catch {
    unavailable = true;
    return null;
  }
}

/** 附加参数 → 可读字符串：Error 提级为 {name,message}，循环引用等退回 String。 */
function serialize(extra: unknown[]): string | null {
  if (extra.length === 0) return null;
  let text: string;
  try {
    text =
      JSON.stringify(extra, (_key, value) =>
        value instanceof Error ? { name: value.name, message: value.message } : value,
      ) ?? String(extra);
  } catch {
    text = extra.map((v) => String(v)).join(" ");
  }
  return text.length > MAX_DATA_CHARS ? `${text.slice(0, MAX_DATA_CHARS)}…(截断)` : text;
}
