// 无条件使用 Windows GUI 子系统。
// 之前用 cfg_attr(not(debug_assertions), ...) 让 debug 构建保留控制台，
// 结果一运行就多一个黑窗口 —— 这不是我们想要的，调试信息一律写日志文件。
#![windows_subsystem = "windows"]

fn main() {
    discord_translator_lib::run()
}
