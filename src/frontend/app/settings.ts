/**
 * 设置窗口入口（表现层组合根）：安装日志转发并挂载设置页，只做接线。
 * 自定义标题栏（无系统边框）的关闭 / 最小化接线见 `shared/ui/window-controls.ts`。
 */
import "../styles/settings.css";
import { installLogForwarding } from "@/shared/ipc/log-forward";
import { wireWindowControls } from "@/shared/ui/window-controls";
import { mountSettingsPage } from "@/settings/ui/settings-page";

installLogForwarding();
void mountSettingsPage();
void wireWindowControls();
