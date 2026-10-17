// 无依赖的 MCP SSE 冒烟测试。先 `npm run tauri:dev` 启动看板娘，再 `node cmd/client/test.mjs`。
// 演示：initialize → tools/list → speak → get_status → list_motions → play_motion → set_expression
// SSE/RPC 细节复用 ./client.mjs。

import { connect } from "./client.mjs";

async function main() {
  const c = await connect({ name: "test-client", version: "0.0.1" });

  // initialize（握手在 connect 内完成）
  console.log("\n✅ initialize:\n", JSON.stringify(c.init.result, null, 2));

  // tools/list
  const list = await c.rpc("tools/list", {});
  console.log("\n✅ tools/list:", (list.result.tools || []).map((t) => t.name).join(", "));

  // 让看板娘说话
  const speak = await c.call("speak", { text: "你好，我是你的看板娘～" });
  console.log("\n✅ speak:", speak.result.content?.[0]?.text);

  // 查询状态
  const status = await c.call("get_status");
  console.log("\n✅ get_status:\n", status.result.content?.[0]?.text);

  // 列出动作
  const motions = await c.call("list_motions");
  console.log("\n✅ list_motions:", motions.result.content?.[0]?.text);

  // 挥手
  const wave = await c.call("play_motion", { motion: "wave" });
  console.log("\n✅ play_motion(wave):", wave.result.content?.[0]?.text);

  // 开心表情
  const exp = await c.call("set_expression", { expression: "happy" });
  console.log("\n✅ set_expression(happy):", exp.result.content?.[0]?.text);

  console.log("\n🎉 全部工具调用完成。看板娘应有对应反应。");
  await c.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 测试失败:", e.message);
  process.exit(1);
});
