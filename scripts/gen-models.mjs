/**
 * 构建前扫描 models/ 生成可切换模型清单（供 core/profiles.ts 与设置页动态展示）。
 *
 * 逐个读取 models/<目录>/ 下的 *.model3.json；有则登记为可切换模型。
 * 输出 src/frontend/core/models.generated.json —— 新增模型只需放入目录并重新构建。
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const modelsDir = join(root, "models");
const outFile = join(root, "src", "frontend", "core", "models.generated.json");

/** @type {{ dir: string, file: string }[]} */
const models = [];
if (existsSync(modelsDir)) {
  for (const entry of readdirSync(modelsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(modelsDir, entry.name);
    const file = readdirSync(dir).find((f) => f.endsWith(".model3.json"));
    if (file) models.push({ dir: entry.name, file });
  }
}
models.sort((a, b) => a.dir.localeCompare(b.dir));

writeFileSync(outFile, `${JSON.stringify(models, null, 2)}\n`);
console.log(`[gen-models] 扫描到 ${models.length} 个模型 → ${outFile}`);
