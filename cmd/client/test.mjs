// 无依赖的 MCP 冒烟测试：覆盖 tools/list 返回的**全部**工具，并做覆盖率校验。
// 先 `npm run tauri:dev` 启动看板娘，再 `node cmd/client/test.mjs`。
// SSE/RPC 细节复用 ./client.mjs；退出码 0=全通过，1=有步骤失败或有工具未覆盖。

import { connect } from "./client.mjs";

/** 把查询型工具返回的 content[0].text 当 JSON 数组解析（非数组给空数组）。 */
function parseList(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function main() {
  const c = await connect({ name: "test-client", version: "0.0.1" });

  const results = [];
  const exercised = new Set();
  let toolNames = [];

  /** 调用工具并取结果文本；isError 视为失败抛出。 */
  const call = async (name, args) => {
    exercised.add(name);
    const result = (await c.call(name, args ?? {}))?.result ?? {};
    const text = result.content?.[0]?.text ?? "";
    if (result.isError) throw new Error(text);
    return text;
  };

  /** 单步执行：成功/失败都记录，不中断后续步骤。 */
  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      console.log(`✅ ${name} (${Date.now() - started}ms): ${detail}`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      console.error(`❌ ${name}: ${e.message}`);
    }
  };

  await step("initialize", () => {
    const info = c.init?.result?.serverInfo;
    return info ? `${info.name} v${info.version}` : "ok";
  });

  await step("tools/list", async () => {
    const res = await c.rpc("tools/list", {});
    toolNames = (res?.result?.tools ?? []).map((t) => t.name);
    if (!toolNames.length) throw new Error("工具清单为空");
    return `${toolNames.length} 个: ${toolNames.join(", ")}`;
  });

  let motions = [];
  await step("list_motions", async () => {
    motions = parseList(await call("list_motions"));
    return `${motions.length} 个`;
  });

  let expressions = [];
  await step("list_expressions", async () => {
    expressions = parseList(await call("list_expressions"));
    return `${expressions.length} 个`;
  });

  await step("get_status", async () => {
    const st = JSON.parse(await call("get_status"));
    return `mode=${st.mode} modelId=${st.modelId ?? "(未指定)"}`;
  });

  await step("play_motion", () => call("play_motion", { motion: motions[0] ?? "idle" }));
  await step("set_expression", () =>
    call("set_expression", { expression: expressions[0] ?? "neutral" }),
  );
  await step("speak", () => call("speak", { text: "你好，我是你的看板娘～" }));
  await step("move", async () => {
    // 非默认坐标：保证窗口产生可见位移（相对当前显示器工作区 0~1）
    const out = JSON.parse(await call("move", { x: 0.2, y: 0.3 }));
    if (typeof out.x !== "number" || typeof out.y !== "number") {
      throw new Error(`move 未返回坐标: ${JSON.stringify(out)}`);
    }
    return `最终 (${out.x.toFixed(2)}, ${out.y.toFixed(2)}) 物理 (${out.physicalX}, ${out.physicalY})${out.clamped ? " [已截断]" : ""}`;
  });
  await step("move_in_window", () => call("move_in_window", { x: 0.5, y: 0.9 }));
  await step("set_idle", () => call("set_idle"));

  await step("list_models", async () => {
    const parsed = JSON.parse(await call("list_models"));
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    // 供下一步 set_model 使用（优先当前模型，回退默认/首个）
    return `${models.length} 个，当前 ${parsed?.current ?? parsed?.default ?? models[0]?.id ?? "无"}`;
  });

  await step("set_model", async () => {
    const parsed = JSON.parse(await call("list_models"));
    const id = parsed?.current ?? parsed?.default ?? parsed?.models?.[0]?.id;
    if (!id) throw new Error("无可用模型 id");
    await call("set_model", { model: id });
    return `切换到 ${id}`;
  });

  const missing = toolNames.filter((n) => !exercised.has(n));
  const failed = results.filter((r) => !r.ok);

  console.log("\n—— 结果 ——");
  console.log(`步骤：${results.length - failed.length}/${results.length} 成功`);
  if (missing.length) console.error(`未覆盖工具：${missing.join(", ")}`);

  await c.close();

  if (failed.length || missing.length) {
    console.error("\n❌ 冒烟测试未全通过。");
    process.exit(1);
  }
  console.log("\n🎉 全部工具调用完成，看板娘应有对应反应。");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ 测试失败（应用是否已通过 `npm run tauri:dev` 启动？）:", e.message);
  process.exit(1);
});
