import { defineConfig } from "vitest/config";

// 插件宿主半侧（src/plugin）的单测配置：
// 与前端 vitest.config.ts 分开，因为前端配置以 src/frontend 为 root，
// 两套代码的依赖环境（node vs 浏览器）也不同。
export default defineConfig({
  test: {
    root: ".",
    include: ["src/plugin/**/*.test.ts"],
    environment: "node",
  },
});
