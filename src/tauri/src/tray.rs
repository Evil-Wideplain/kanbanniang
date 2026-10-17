//! 系统托盘装配（基础设施层）：托盘图标 + 右键菜单 + 显示/隐藏与退出。
//! 目的是让应用「常驻小图标」：任务栏不占位（`skipTaskbar`），左键切换看板娘显隐，
//! 右键菜单可打开设置窗口，关窗只隐藏不退出（见 `lib.rs`），真正结束进程的唯一入口是
//! 托盘菜单的「退出」。
//!
//! 平台差异：Windows 落在右下通知区域；macOS 落在顶部菜单栏（无 `skipTaskbar` 概念，
//! Dock 图标由 `lib.rs` 关闭 activation policy 处理）；Linux 走 AppIndicator
//! （需系统安装 libayatana-appindicator，GNOME 需 AppIndicator 扩展）。

#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager,
};

/// 主窗口标签（与 `tauri.conf.json` 的 `windows[].label` 对应）。
pub(crate) const MAIN_WINDOW: &str = "main";
/// 设置窗口标签（`tauri.conf.json` 中初始隐藏，托盘「设置…」唤出）。
const SETTINGS_WINDOW: &str = "settings";

/// macOS 菜单栏模板图标（单色：黑 + alpha，系统按深浅色自动反色）。
/// 打包图标是彩色且不透明，直接当模板会渲染成实心方块，故单独提供单色素材。
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_PNG: &[u8] = include_bytes!("../icons/tray.png");

/// 托盘右键菜单项 id：切换看板娘显隐。
const MENU_TOGGLE: &str = "toggle";
/// 托盘右键菜单项 id：打开设置窗口。
const MENU_SETTINGS: &str = "settings";
/// 托盘右键菜单项 id：退出应用（常驻托盘的唯一退出入口）。
const MENU_QUIT: &str = "quit";

/// 装配系统托盘：图标、右键菜单与事件回调。
/// 失败必须上抛：托盘是常驻应用隐藏后唯一的找回入口，缺托盘等于无法再唤出看板娘。
pub(crate) fn init(app: &App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, MENU_TOGGLE, "显示/隐藏看板娘", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        // 左键留给显隐切换，右键才弹菜单（符合 Windows 托盘习惯）
        .show_menu_on_left_click(false)
        .tooltip("看板娘")
        .on_menu_event(|app, event| match event.id.as_ref() {
            MENU_TOGGLE => toggle_window(app),
            MENU_SETTINGS => show_settings_window(app),
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    // 托盘图标按平台区分：macOS 用单色模板图（随深浅色反色）；其余平台复用默认窗口图标。
    // 图标缺失或解码失败都不阻塞启动，仅告警（托盘仍会以内置占位图出现）。
    #[cfg(target_os = "macos")]
    match Image::from_bytes(TRAY_TEMPLATE_PNG) {
        Ok(icon) => builder = builder.icon(icon).icon_as_template(true),
        Err(e) => {
            log::warn!("[tray] 加载 macOS 模板图标失败，回退默认图标: {e}");
            builder = with_default_icon(app, builder);
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = with_default_icon(app, builder);
    }

    builder.build(app)?;
    Ok(())
}

/// 复用应用默认窗口图标（与打包图标同源）；缺失时仅告警，交由系统占位。
fn with_default_icon(
    app: &App,
    builder: TrayIconBuilder<tauri::Wry>,
) -> TrayIconBuilder<tauri::Wry> {
    match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()),
        None => {
            log::warn!("[tray] 缺少默认窗口图标，托盘将使用系统占位图标");
            builder
        }
    }
}

/// 切换主窗口显隐：可见则隐藏到托盘，隐藏则显示并聚焦。
fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("[tray] 未找到主窗口 {MAIN_WINDOW}，忽略显示/隐藏请求");
        return;
    };
    match window.is_visible() {
        Ok(true) => {
            // 隐藏失败不能静默：否则用户以为已收起，实际仍在桌面上
            if let Err(e) = window.hide() {
                log::warn!("[tray] 隐藏主窗口失败: {e}");
            }
        }
        Ok(false) => {
            if let Err(e) = window.show().and_then(|()| window.set_focus()) {
                log::warn!("[tray] 显示主窗口失败: {e}");
            }
        }
        Err(e) => log::warn!("[tray] 读取主窗口可见性失败: {e}"),
    }
}

/// 打开设置窗口：设置窗口常驻（初始隐藏），显示并聚焦即可复用同一实例。
fn show_settings_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW) else {
        log::warn!("[tray] 未找到设置窗口 {SETTINGS_WINDOW}，忽略打开请求");
        return;
    };
    if let Err(e) = window.show().and_then(|()| window.set_focus()) {
        log::warn!("[tray] 显示设置窗口失败: {e}");
    }
}
