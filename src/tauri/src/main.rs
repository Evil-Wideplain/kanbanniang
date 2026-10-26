// 桌面端入口（Windows 下 release 隐藏控制台窗口）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kanbanniang_lib::run();
}
