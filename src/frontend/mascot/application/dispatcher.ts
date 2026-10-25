/**
 * MCP 指令分发（应用层）：动作 → 控制器调用 → MascotResult 成型。
 * switch 穷尽 MascotAction（default 分支为 _exhaustive 检查），漏写 case 编译失败。
 */
import type {
  ActionOutcome,
  MascotCommand,
  MascotController,
  MascotResult,
  SetModelOutcome,
  WindowMoveOutcome,
} from "@/shared/domain/types";
import { DEFAULT_MODEL_ID, MODEL_PROFILES } from "@/shared/domain/profiles";

/**
 * 指令分发所需的切换上下文（由 main.ts 注入，dispatcher 保持与 DOM 解耦）。
 */
export interface CommandCtx {
  /** 请求切换到指定档案 id（含校验/回滚语义）。 */
  setModel(id: string): Promise<SetModelOutcome>;
  /** 当前档案 id。 */
  currentModelId(): string;
  /** 显示说话气泡（由 UI 层注入，先于口型/表情反馈触发）。 */
  showBubble?(text: string): void;
  /** 平滑移动主窗口到工作区归一化坐标（Tauri 命令 move_window，由 main.ts 注入；非 Tauri 环境缺失）。 */
  moveWindow?(x: number, y: number): Promise<WindowMoveOutcome>;
}

/**
 * 把后端转发过来的 MCP 指令分发给看板娘控制器，并准备好回传结果。
 * 查询型动作（list_* / get_status / set_model / list_models / move）会返回数据，
 * 其它动作返回 "ok"。main.ts 负责把结果通过 Tauri 事件回传给后端。
 *
 * set_model 涉及异步加载、move 涉及窗口滑行，可能返回 Promise；调用方用
 * `Promise.resolve(result)` 统一处理即可。
 */
export function handleCommand(
  cmd: MascotCommand,
  c: MascotController | null,
  ctx?: CommandCtx,
): MascotResult | Promise<MascotResult> {
  const p = cmd.params ?? {};
  try {
    switch (cmd.action) {
      case "play_motion": {
        if (!c) return notReady(cmd.id);
        const requested = String(p.motion ?? p.name ?? "idle");
        const outcome = c.motion(
          requested,
          typeof p.index === "number" ? p.index : undefined,
        );
        logOutcome("play_motion", requested, outcome);
        return okValue(cmd.id, outcome);
      }
      case "set_expression": {
        if (!c) return notReady(cmd.id);
        const requested = String(p.expression ?? p.name ?? "neutral");
        const outcome = c.expression(requested);
        logOutcome("set_expression", requested, outcome);
        return okValue(cmd.id, outcome);
      }
      case "speak": {
        if (!c) return notReady(cmd.id);
        const text = String(p.text ?? "");
        console.info("[mascot] speak 气泡展示", { chars: text.length });
        ctx?.showBubble?.(text);
        c.speak(text);
        return okValue(cmd.id, "ok");
      }
      case "move": {
        const x = Number(p.x ?? 0.5);
        const y = Number(p.y ?? 0.9);
        console.info("[mascot] move 窗口移动", { x, y });
        if (!ctx?.moveWindow) {
          console.warn("[mascot] move 不可用（缺少窗口移动上下文，非 Tauri 环境？）");
          return okValue(cmd.id, { ok: false, error: "move 不可用（缺少窗口移动上下文）" });
        }
        // 结果即 Rust 命令读回的最终坐标（clamped/superseded 原样透传）；
        // 失败包成 {ok:false} 信封（同 set_model，走 Rust 的 isError 判定）。
        return Promise.resolve(ctx.moveWindow(x, y))
          .then((outcome) => {
            console.info("[mascot] move 完成", { ...outcome });
            return okValue(cmd.id, outcome);
          })
          .catch((e) =>
            okValue(cmd.id, { ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
      }
      case "move_in_window": {
        if (!c) return notReady(cmd.id);
        const x = Number(p.x ?? 0.5);
        const y = Number(p.y ?? 0.9);
        console.info("[mascot] move_in_window 窗口内移动", { x, y });
        c.moveTo(x, y);
        return okValue(cmd.id, "ok");
      }
      case "set_idle":
        if (!c) return notReady(cmd.id);
        console.info("[mascot] set_idle 回到待机");
        c.idle();
        return okValue(cmd.id, "ok");
      case "list_motions": {
        if (!c) return notReady(cmd.id);
        const motions = c.listMotions();
        console.info("[mascot] list_motions 返回", { count: motions.length });
        return okValue(cmd.id, motions);
      }
      case "list_expressions": {
        if (!c) return notReady(cmd.id);
        const expressions = c.listExpressions();
        console.info("[mascot] list_expressions 返回", { count: expressions.length });
        return okValue(cmd.id, expressions);
      }
      case "get_status": {
        if (!c) return notReady(cmd.id);
        const st = c.status();
        console.info("[mascot] get_status 快照", { mode: st.mode, modelId: st.modelId ?? null });
        return okValue(cmd.id, st);
      }
      case "list_models": {
        const current = c?.status().modelId || ctx?.currentModelId() || null;
        const models = MODEL_PROFILES.map((p2) => ({
          id: p2.id,
          name: p2.name,
          description: p2.description ?? null,
          mode: "live2d",
          modelFile: p2.config.modelFile,
          isDefault: p2.id === DEFAULT_MODEL_ID,
        }));
        console.info("[mascot] list_models 返回", { count: models.length, current });
        return okValue(cmd.id, { current, default: DEFAULT_MODEL_ID, models });
      }
      case "set_model": {
        const id = String(p.model ?? p.id ?? "");
        if (!ctx?.setModel) {
          console.warn("[mascot] set_model 不可用（缺少切换上下文）");
          return okValue(cmd.id, { ok: false, error: "set_model 不可用（缺少切换上下文）" });
        }
        // 成功与失败都以信封形式放进 result —— Rust 侧只转发 result 字段
        // （切换过程日志由 model-switch.ts 记录）
        return Promise.resolve(ctx.setModel(id))
          .then((outcome) => okValue(cmd.id, outcome))
          .catch((e) =>
            okValue(cmd.id, { ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
      }
      default: {
        // 穷尽性检查：MascotAction 新增成员若漏写 case，这里会编译失败。
        const _exhaustive: never = cmd.action;
        console.warn("[mascot] 未知动作（已忽略）", { action: String(_exhaustive) });
        return fail(cmd.id, `未知动作: ${String(_exhaustive)}`);
      }
    }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    // 控制器内部异常：必须记录，否则只能看到前端回传的 ok=false
    console.error("[mascot] 指令执行异常", { action: cmd.action, error });
    return fail(cmd.id, error);
  }
}

/** 动作/表情结果日志：命中 info；回退/无目标 warn（日志规范的「动作回退」语义）。 */
function logOutcome(kind: string, requested: string, outcome: ActionOutcome): void {
  const detail = { requested, applied: outcome.applied, index: outcome.index ?? null };
  if (outcome.applied === null) {
    console.warn(`[mascot] ${kind} 无可用目标`, detail);
  } else if (outcome.fallback) {
    console.warn(`[mascot] ${kind} 未命中，已回退`, detail);
  } else {
    console.info(`[mascot] ${kind} 生效`, detail);
  }
}

function okValue(id: string, result: unknown): MascotResult {
  return { id, ok: true, result };
}

/** 看板娘未加载（启动时无模型或 Live2D 加载失败）时的统一失败结果。 */
function notReady(id: string): MascotResult {
  return fail(id, "看板娘未加载（没有可用 Live2D 模型）");
}

function fail(id: string, error: string): MascotResult {
  return { id, ok: false, result: null, error };
}
