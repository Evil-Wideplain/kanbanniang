/**
 * 调试面板入口（表现层组合根）：安装日志转发并挂载调试面板，只做接线。
 * 仅开发构建创建该窗口（见 Rust `debug.rs`），面板实现见 debug/panel.ts。
 */
import "../styles/debug.css";
import { mountDebugPanel } from "@/debug/panel";
import { installLogForwarding } from "@/shared/ipc/log-forward";

installLogForwarding();
mountDebugPanel();
