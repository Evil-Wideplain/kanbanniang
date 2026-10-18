import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// 复用 vite.config.ts 的 root 与 `@` 别名（单一来源），仅追加测试配置。
// 仅覆盖无副作用的领域层 / 纯函数（DOM、Tauri、pixi 依赖的部分不在此测）。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["**/*.test.ts"],
      environment: "node",
    },
  }),
);
