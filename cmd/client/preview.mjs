// 逐个播放当前模型的真实动作/表情，边看边命名（用于生成语义别名）。
// 用法（在仓库根目录）：node cmd/client/preview.mjs [每次间隔秒=1.5] [motions|expressions|all]
// 交互：输入语义名回车记录；直接回车跳过；r 重播当前项；q 结束并保存。
// 结果写入 cmd/client/preview-result.json，格式 { "m01": "wave", ... }。

import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { connect } from "./client.mjs";

const intervalMs = Number(process.argv[2] ?? 1.5) * 1000;
const which = process.argv[3] ?? "all";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseList(res) {
  const text = res?.result?.content?.[0]?.text ?? "[]";
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const c = await connect({ name: "preview-client", version: "0.0.1" });
const rl = createInterface({ input: process.stdin, output: process.stdout });
const mapping = {};

async function ask(prompt) {
  try {
    return (await rl.question(prompt)).trim();
  } catch {
    return "q"; // 输入流结束（EOF）视作退出
  }
}

async function preview(kind) {
  const label = kind === "motions" ? "动作" : "表情";
  const list =
    kind === "motions"
      ? parseList(await c.call("list_motions"))
      : parseList(await c.call("list_expressions"));
  if (!list.length) {
    console.log(`（当前模型没有可用${label}）`);
    return;
  }
  console.log(`\n== ${label}预览：共 ${list.length} 个，看板娘上逐个播放 ==`);
  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    if (kind === "motions") {
      await c.call("play_motion", { motion: name });
    } else {
      await c.call("set_expression", { expression: name });
    }
    await sleep(intervalMs);
    const ans = await ask(`▶ [${i + 1}/${list.length}] ${name} → 语义名（回车跳过 / r 重播 / q 结束）: `);
    if (ans === "q") return;
    if (ans === "r") {
      i--;
      continue;
    }
    if (ans) mapping[name] = ans;
    if (kind === "expressions") await c.call("set_expression", { expression: "neutral" });
  }
}

if (which === "motions" || which === "all") await preview("motions");
if (which === "expressions" || which === "all") await preview("expressions");

await c.call("set_idle");
writeFileSync("cmd/client/preview-result.json", JSON.stringify(mapping, null, 2) + "\n", "utf8");
console.log("\n命名结果已保存到 cmd/client/preview-result.json：");
console.log(JSON.stringify(mapping, null, 2));
rl.close();
await c.close();
process.exit(0);
