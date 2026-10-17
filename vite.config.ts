import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Tauri 期望一个固定端口且禁用了文件请求的 CORS。
// 开发服务器监听 127.0.0.1:5173，与 tauri.conf.json 的 devUrl 保持一致。
export default defineConfig({
  // 入口 HTML 在 src/frontend/ 下，Vite 以 src/frontend 为工程根
  root: "src/frontend",
  clearScreen: false,
  // 静态资源根：models/（仅模型目录；Cubism Core 在 src/frontend/core/live2d/ 内随源码打包），其内容映射到站点根路径，
  // 如 models/Haru/... → /Haru/...
  publicDir: "../../models",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  // Tauri 使用原生 WebView，不需要 HMR 的 websocket 注入到生产构建
  build: {
    target: "es2020",
    outDir: "../../dist",
    emptyOutDir: true,
    // 多入口：看板娘主窗口（index.html）与设置窗口（settings.html）
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./src/frontend/index.html", import.meta.url)),
        settings: fileURLToPath(new URL("./src/frontend/settings.html", import.meta.url)),
      },
    },
  },
});
