import type { ActionOutcome, MascotController, MascotStatus } from "./types";
import { speakDurationMs } from "./speech";
import { norm } from "./normalize";

/**
 * 降级看板娘：纯 Canvas 2D 动画，无需 Live2D SDK 即可运行。
 * 用于在没有 Cubism 模型时也能完整验证 MCP 工具链路。
 * 表情/动作以颜色与弹跳幅度区分，足以让 Agent 的调用"可见"。
 */

const EXPRESSIONS: Record<string, { body: string; cheek: string; brow: number }> = {
  neutral: { body: "#8ec5ff", cheek: "#bfe0ff", brow: 0 },
  happy: { body: "#ffd36e", cheek: "#ffb3c1", brow: -0.18 },
  angry: { body: "#ff8a8a", cheek: "#ffc1c1", brow: 0.28 },
  surprised: { body: "#c4a7ff", cheek: "#e2d4ff", brow: -0.36 },
  sad: { body: "#9fb6ff", cheek: "#cdd8ff", brow: 0.22 },
  shy: { body: "#ffc9de", cheek: "#ff9dbb", brow: 0.12 },
  sleepy: { body: "#b7c4ea", cheek: "#d6ddf6", brow: 0.1 },
};

const FALLBACK_MOTIONS = [
  "idle",
  "tap_body",
  "pinch_in",
  "pinch_out",
  "wave",
  "shake",
  "jump",
  "nod",
  "spin",
];

/** 只产生一次性弹跳冲量的动作（idle / nod / spin 另有副作用，见 applyMotion）。 */
const MOTION_IMPULSE: Record<string, number> = {
  wave: 1.2,
  jump: 2.4,
  shake: -1.6,
  tap_body: 1.6,
  pinch_in: 1.0,
  pinch_out: 1.4,
};

export class FallbackMascot implements MascotController {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private t = 0;

  private expressionName = "neutral";
  private target = { x: 0.5, y: 0.9 };
  private pos = { x: 0.5, y: 0.9 };
  private bounce = 0; // 动作弹跳衰减量
  private bounceVel = 0;
  private blink = 0; // 0 睁 -> 1 闭
  private blinkTimer = 2 + Math.random() * 3;
  private mouthOpen = 0; // 说话口型 0..1
  private speakingUntil = 0;
  private pendingImpulses: { delay: number; vel: number }[] = []; // 延迟弹跳（如 nod 的第二下）
  private spinUntil = 0; // spin 旋转动画截止时间
  private dpr = Math.min(window.devicePixelRatio || 1, 2);
  private rafHandle = 0;
  private destroyed = false;
  private onResize = () => this.resize();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.resize();
    window.addEventListener("resize", this.onResize);
    this.rafHandle = requestAnimationFrame(this.loop);
  }

  private resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  private loop = () => {
    if (this.destroyed) return;
    this.t += 1 / 60;
    this.update();
    this.draw();
    this.rafHandle = requestAnimationFrame(this.loop);
  };

  private update() {
    // 位置缓动
    this.pos.x += (this.target.x - this.pos.x) * 0.12;
    this.pos.y += (this.target.y - this.pos.y) * 0.12;
    // 弹跳弹簧
    this.bounceVel += -this.bounce * 40 * (1 / 60);
    this.bounceVel *= 0.86;
    this.bounce += this.bounceVel * (1 / 60);
    // 延迟弹跳补发（nod 的第二下等）
    for (let i = this.pendingImpulses.length - 1; i >= 0; i--) {
      const p = this.pendingImpulses[i];
      p.delay -= 1 / 60;
      if (p.delay <= 0) {
        this.bounceVel += p.vel;
        this.pendingImpulses.splice(i, 1);
      }
    }
    // 眨眼
    this.blinkTimer -= 1 / 60;
    if (this.blinkTimer <= 0) {
      this.blink = Math.min(1, this.blink + 0.35);
      if (this.blink >= 1) this.blinkTimer = 2 + Math.random() * 3;
    } else {
      this.blink = Math.max(0, this.blink - 0.12);
    }
    // 说话口型（仅在说话窗口内）
    if (performance.now() < this.speakingUntil) {
      this.mouthOpen = 0.5 + 0.5 * Math.sin(this.t * 18);
    } else {
      this.mouthOpen *= 0.85;
    }
  }

  private draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    const ex = EXPRESSIONS[this.expressionName] ?? EXPRESSIONS.neutral;
    const baseX = this.pos.x * W;
    const baseY = this.pos.y * H + this.bounce * 28 * this.dpr;
    const R = Math.min(W, H) * 0.22;

    // spin：用水平缩放模拟转身（约 0.7s 一圈）
    ctx.save();
    if (performance.now() < this.spinUntil) {
      const p = 1 - (this.spinUntil - performance.now()) / 700;
      ctx.translate(baseX, baseY);
      ctx.scale(Math.max(0.08, Math.cos(p * Math.PI * 2)), 1);
      ctx.translate(-baseX, -baseY);
    }

    // 阴影
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(baseX, this.pos.y * H + R * 1.1, R * 0.7, R * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 身体
    ctx.fillStyle = ex.body;
    ctx.beginPath();
    ctx.ellipse(baseX, baseY, R, R * 1.05, 0, 0, Math.PI * 2);
    ctx.fill();

    // 腮红
    ctx.fillStyle = ex.cheek;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.ellipse(baseX - R * 0.5, baseY + R * 0.18, R * 0.18, R * 0.12, 0, 0, Math.PI * 2);
    ctx.ellipse(baseX + R * 0.5, baseY + R * 0.18, R * 0.18, R * 0.12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // 眼睛（随眨眼闭合）
    const eyeY = baseY - R * 0.12;
    const eyeDx = R * 0.34;
    const eyeOpen = R * 0.16 * (1 - this.blink);
    ctx.fillStyle = "#222";
    for (const dx of [-eyeDx, eyeDx]) {
      ctx.beginPath();
      if (eyeOpen < 1) {
        ctx.ellipse(baseX + dx, eyeY, R * 0.1, Math.max(1.5 * this.dpr, eyeOpen), 0, 0, Math.PI * 2);
      } else {
        ctx.arc(baseX + dx, eyeY, R * 0.1, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    // 眉毛（表情）
    ctx.strokeStyle = "#222";
    ctx.lineWidth = Math.max(2 * this.dpr, R * 0.03);
    const browY = eyeY - R * 0.3 + ex.brow * R;
    for (const dx of [-eyeDx, eyeDx]) {
      ctx.beginPath();
      ctx.moveTo(baseX + dx - R * 0.12, browY + R * 0.1);
      ctx.lineTo(baseX + dx + R * 0.12, browY - R * 0.1);
      ctx.stroke();
    }

    // 嘴（说话时张开发光）
    const mouthY = baseY + R * 0.4;
    ctx.fillStyle = "#7a3b3b";
    ctx.beginPath();
    ctx.ellipse(baseX, mouthY, R * 0.16, R * 0.06 + this.mouthOpen * R * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore(); // spin 变换
  }

  // ---- MascotController 实现 ----
  motion(name: string): ActionOutcome {
    const key = norm(name);
    const resolved = FALLBACK_MOTIONS.find((m) => norm(m) === key);
    if (!resolved) {
      // 未命中：回退随机非 idle 动作，保证调用始终有反应
      const pool = FALLBACK_MOTIONS.filter((m) => m !== "idle");
      const pick = pool[Math.floor(Math.random() * pool.length)];
      this.applyMotion(pick);
      return { applied: pick, fallback: true };
    }
    this.applyMotion(resolved);
    return { applied: resolved, fallback: false };
  }

  private applyMotion(name: string) {
    switch (name) {
      case "idle":
        this.bounceVel = 0;
        break;
      case "nod": // 两段小弹：立即 + 延迟补发
        this.bounceVel += 0.9;
        this.pendingImpulses.push({ delay: 0.2, vel: 0.8 });
        break;
      case "spin":
        this.spinUntil = performance.now() + 700;
        break;
      default:
        // 其余动作只产生一次性弹跳冲量
        this.bounceVel += MOTION_IMPULSE[name] ?? 0;
    }
  }

  expression(name: string): ActionOutcome {
    const key = norm(name);
    const real = Object.keys(EXPRESSIONS).find((e) => norm(e) === key);
    if (real) {
      this.expressionName = real;
      return { applied: real, fallback: false };
    }
    // 未命中：回退默认表情，保证状态可控
    this.expressionName = "neutral";
    return { applied: "neutral", fallback: true };
  }

  speak(text: string): void {
    this.speakingUntil = performance.now() + speakDurationMs(text);
    // 说话时默认带一点开心表情（除非已指定）
    if (this.expressionName === "neutral") this.expressionName = "happy";
  }

  moveTo(x: number, y: number): void {
    this.target.x = Math.max(0, Math.min(1, x));
    this.target.y = Math.max(0, Math.min(1, y));
  }

  idle(): void {
    this.expressionName = "neutral";
    this.target = { x: 0.5, y: 0.9 };
    this.bounceVel = 0;
  }

  setGaze(_enabled: boolean): void {
    // 降级模式为纯 Canvas 绘制，不实现视线跟随（保持接口一致的空实现）。
  }

  listMotions(): string[] {
    return [...FALLBACK_MOTIONS];
  }

  listExpressions(): string[] {
    return Object.keys(EXPRESSIONS);
  }

  status(): MascotStatus {
    return {
      mode: "fallback",
      model: null,
      modelId: "fallback",
      expression: this.expressionName,
      position: { x: this.pos.x, y: this.pos.y },
      speaking: performance.now() < this.speakingUntil,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.rafHandle);
    window.removeEventListener("resize", this.onResize);
  }
}
