mod config;
mod discord;
mod http;
mod local_engine;
mod logging;
mod shortcut;
mod store;

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Discord 启动时放行的 Origin。只放行我们自己的 WebView，不用 `*`。
const ALLOWED_ORIGINS: &str =
    "http://tauri.localhost,https://tauri.localhost,http://localhost:1420";

pub struct AppState {
    pub store: store::Store,
    pub cfg: Mutex<config::Config>,
}

/* ------------------------------------------------------------------ */
/* 命令：网络                                                          */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn http_request(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout: Option<u64>,
) -> Result<serde_json::Value, String> {
    let (status, text) = http::request(
        &url,
        method.as_deref().unwrap_or("GET"),
        headers,
        body,
        timeout.unwrap_or(20_000),
    )
    .await?;

    Ok(serde_json::json!({ "status": status, "body": text }))
}

/* ------------------------------------------------------------------ */
/* 命令：配置                                                          */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn get_config(state: tauri::State<'_, AppState>) -> config::Config {
    state.cfg.lock().map(|c| c.clone()).unwrap_or_default()
}

#[tauri::command]
fn save_config(state: tauri::State<'_, AppState>, cfg: config::Config) -> Result<(), String> {
    config::save(&cfg)?;
    discord::set_channel(&cfg.channel);
    if let Ok(mut cur) = state.cfg.lock() {
        *cur = cfg;
    }
    logging::write("INFO", "配置已保存");
    Ok(())
}

#[tauri::command]
fn config_path() -> String {
    config::config_path().to_string_lossy().to_string()
}

/* ------------------------------------------------------------------ */
/* 命令：本地翻译引擎                                                  */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn local_engine_env() -> serde_json::Value {
    let env = tauri::async_runtime::spawn_blocking(local_engine::detect)
        .await
        .unwrap_or(local_engine::LocalEnv {
            docker: false,
            docker_running: false,
            libre_running: false,
            ollama_running: false,
            docker_version: String::new(),
        });

    serde_json::json!({
        "docker": env.docker,
        "dockerRunning": env.docker_running,
        "libreRunning": env.libre_running,
        "ollamaRunning": env.ollama_running,
        "dockerVersion": env.docker_version,
    })
}

#[tauri::command]
fn local_engine_deploy() -> Result<(), String> {
    local_engine::start_deploy();
    Ok(())
}

#[tauri::command]
fn local_engine_deploy_ollama() -> Result<(), String> {
    local_engine::start_deploy_ollama();
    Ok(())
}

#[tauri::command]
fn local_engine_state() -> local_engine::DeployState {
    local_engine::state()
}

#[tauri::command]
fn open_data_dir() -> Result<(), String> {
    let dir = config::app_data_dir();
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* 命令：Discord                                                       */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn discord_status(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let port = state.cfg.lock().map(|c| c.cdp_port).unwrap_or(9223);
    serde_json::json!({
        "installed": discord::find_latest_exe().is_some(),
        "running": discord::is_running(),
        "portOpen": discord::port_alive(port),
        "port": port,
        "root": discord::discord_root().map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
async fn start_discord(port: Option<u16>) -> Result<serde_json::Value, String> {
    let cfg = config::load();
    let desired = port.unwrap_or(cfg.cdp_port);

    logging::write("INFO", &format!("开始启动 Discord（期望端口 {}）", desired));

    let joined = tauri::async_runtime::spawn_blocking(move || {
        let p = discord::pick_port(desired);
        discord::stop();
        std::thread::sleep(std::time::Duration::from_millis(800));
        discord::start(p, ALLOWED_ORIGINS)
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?;

    match joined {
        Ok(r) => {
            logging::write(
                "INFO",
                &format!(
                    "Discord 已就绪，端口 {}，方式 {}，耗时 {} ms",
                    r.port, r.mode, r.elapsed_ms
                ),
            );
            Ok(serde_json::json!({
                "ok": true,
                "port": r.port,
                "mode": r.mode,
                "elapsedMs": r.elapsed_ms,
            }))
        }
        Err(e) => {
            logging::write("ERROR", &format!("启动 Discord 失败: {}", e));
            Err(e)
        }
    }
}

#[tauri::command]
async fn stop_discord() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(discord::stop)
        .await
        .map_err(|e| e.to_string())?;
    logging::write("INFO", "Discord 已停止");
    Ok(())
}

#[tauri::command]
fn pick_port(start: u16) -> u16 {
    discord::pick_port(start)
}

/* ------------------------------------------------------------------ */
/* 命令：快捷方式接管                                                  */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn shortcut_info() -> serde_json::Value {
    let s = shortcut::info();
    serde_json::json!({
        "desktop": s.desktop,
        "startmenu": s.startmenu,
        "takenOver": s.taken_over,
        "self": std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

#[tauri::command]
fn takeover_shortcut() -> Result<serde_json::Value, String> {
    let n = shortcut::takeover()?;
    Ok(serde_json::json!({ "ok": true, "count": n }))
}

#[tauri::command]
fn restore_shortcut() -> Result<serde_json::Value, String> {
    let n = shortcut::restore()?;
    Ok(serde_json::json!({ "ok": true, "count": n }))
}

/* ------------------------------------------------------------------ */
/* 命令：缓存与用量                                                    */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn cache_get(state: tauri::State<'_, AppState>, hash: String) -> Option<String> {
    state.store.cache_get(&hash)
}

#[tauri::command]
fn cache_put(state: tauri::State<'_, AppState>, hash: String, src: String, dst: String, provider: String) {
    state.store.cache_put(&hash, &src, &dst, &provider);
}

#[tauri::command]
fn cache_stats(state: tauri::State<'_, AppState>) -> serde_json::Value {
    serde_json::json!({ "count": state.store.cache_count() })
}

#[tauri::command]
fn clear_cache(state: tauri::State<'_, AppState>) -> serde_json::Value {
    state.store.cache_clear();
    logging::write("INFO", "缓存已清空");
    serde_json::json!({ "ok": true })
}

/// 只清理 N 天之前的缓存
#[tauri::command]
fn prune_cache(state: tauri::State<'_, AppState>, days: i64) -> serde_json::Value {
    state.store.cache_prune(days);
    let left = state.store.cache_count();
    logging::write(
        "INFO",
        &format!("已清理 {} 天前的缓存，剩余 {} 条", days, left),
    );
    serde_json::json!({ "ok": true, "remaining": left })
}

/// 术语表导出：写成一个纯文本，每行 原文=译文
#[tauri::command]
fn export_glossary(cfg: config::Config, path: String) -> Result<usize, String> {
    let text = cfg
        .glossary
        .iter()
        .filter(|g| !g.from.is_empty())
        .map(|g| format!("{}={}", g.from, g.to))
        .collect::<Vec<_>>()
        .join("\n");

    std::fs::write(&path, text).map_err(|e| format!("写入失败: {}", e))?;
    logging::write("INFO", &format!("术语表已导出到 {}", path));
    Ok(cfg.glossary.len())
}

/// 术语表导入：读 原文=译文 每行一条
#[tauri::command]
fn import_glossary(path: String) -> Result<Vec<config::GlossaryEntry>, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {}", e))?;

    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let idx = match line.find('=') {
            Some(i) if i > 0 => i,
            _ => continue,
        };
        let from = line[..idx].trim().to_string();
        let to = line[idx + 1..].trim().to_string();
        if !from.is_empty() {
            out.push(config::GlossaryEntry { from, to });
        }
    }

    logging::write("INFO", &format!("从 {} 导入 {} 条术语", path, out.len()));
    Ok(out)
}

#[tauri::command]
fn usage_get(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let (requests, chars, messages) = state.store.usage_today();
    serde_json::json!({
        "requests": requests,
        "chars": chars,
        "messages": messages,
    })
}

#[tauri::command]
fn usage_add(state: tauri::State<'_, AppState>, requests: i64, chars: i64, messages: i64) {
    state.store.usage_add(requests, chars, messages);
}

/* ------------------------------------------------------------------ */
/* 命令：日志                                                          */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn write_log(level: String, message: String) {
    logging::write(&level, &message);
}

#[tauri::command]
fn read_log(lines: Option<usize>) -> String {
    let path = config::log_path();
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let want = lines.unwrap_or(300);
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(want);
    all[start..].join("\n")
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */

/// 第一次"关窗口"时提示用户：程序还在托盘里活着，翻译没停。
/// 只在首次触发（标记文件落盘），避免每次都打扰。
fn hint_tray_once(app: &tauri::AppHandle) {
    let marker = config::app_data_dir().join(".tray-hint-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::write(&marker, b"1");
    let _ = app.emit("dt:tray-hint", ());
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "暂停 / 继续翻译", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show, &toggle, &sep, &quit])?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?
        .clone();

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Discord 自动翻译")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "toggle" => {
                let _ = app.emit("dt:toggle", ());
            }
            "quit" => {
                logging::write("INFO", "用户从托盘退出");
                // 先让前端把注入到 Discord 里的译文清掉，避免留下"僵尸译文"
                let _ = app.emit("dt:cleanup", ());
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    handle.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let visible = w.is_visible().unwrap_or(false);
                    if visible {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let store = store::Store::open().map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;
            store.cache_prune(30);

            let cfg = config::load();
            discord::set_channel(&cfg.channel);
            app.manage(AppState {
                store,
                cfg: Mutex::new(cfg),
            });

            if let Err(e) = build_tray(app.handle()) {
                logging::write("WARN", &format!("托盘创建失败: {}", e));
            }

            logging::write("INFO", "应用启动");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 关闭窗口 = 收到托盘，翻译不能停
                api.prevent_close();
                let _ = window.hide();
                hint_tray_once(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            http_request,
            get_config,
            save_config,
            config_path,
            open_data_dir,
            discord_status,
            start_discord,
            stop_discord,
            pick_port,
            shortcut_info,
            takeover_shortcut,
            restore_shortcut,
            local_engine_env,
            local_engine_deploy,
            local_engine_deploy_ollama,
            local_engine_state,
            cache_get,
            cache_put,
            cache_stats,
            clear_cache,
            prune_cache,
            export_glossary,
            import_glossary,
            usage_get,
            usage_add,
            write_log,
            read_log,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
