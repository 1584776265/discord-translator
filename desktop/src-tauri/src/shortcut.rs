//! 接管 / 还原 Discord 的桌面与开始菜单快捷方式。
//!
//! 目的：用户习惯直接双击 Discord 图标。如果不接管，那个图标启动的
//! Discord 没有调试端口，翻译完全不工作 —— 这是本方案最致命的体验缺口。
//!
//! 实现上**不调用 PowerShell**：一律走 Win32 COM (IShellLinkW)。
//! 之前用 `powershell -Command ...` 改 .lnk，即使加了 CREATE_NO_WINDOW，
//! 在部分机器上仍会闪一下黑窗，应用一启动就能看到，观感很差。

use crate::i18n;
use std::path::{Path, PathBuf};

use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ, STGM_READWRITE,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, FOLDERID_Desktop, KF_FLAG_DEFAULT,
    SHGetKnownFolderPath};

const MAX_PATH_LEN: usize = 1024;

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

fn known_desktop() -> Option<PathBuf> {
    unsafe {
        let ptr = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None).ok()?;
        let text = ptr.to_string().ok();
        CoTaskMemFree(Some(ptr.0 as *const _));
        text.map(PathBuf::from)
    }
}

/// Discord 装好后会在开始菜单放一个 Discord.lnk
fn start_menu_lnk() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(
        PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Discord Inc")
            .join("Discord.lnk"),
    )
}

fn desktop_lnk() -> Option<PathBuf> {
    Some(known_desktop()?.join("Discord.lnk"))
}

/// 所有可能被接管的快捷方式
fn targets() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = desktop_lnk() {
        if p.exists() {
            out.push(p);
        }
    }
    if let Some(p) = start_menu_lnk() {
        if p.exists() {
            out.push(p);
        }
    }
    out
}

/* ------------------------------------------------------------------ */
/* COM 封装                                                            */
/* ------------------------------------------------------------------ */

fn open_link() -> Option<IShellLinkW> {
    unsafe {
        // 重复调用只会返回 S_FALSE，可忽略
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()
    }
}

pub fn read_target(path: &Path) -> Option<String> {
    unsafe {
        let link = open_link()?;
        let persist: IPersistFile = link.cast().ok()?;
        let file = HSTRING::from(path.to_string_lossy().to_string());

        persist.Load(PCWSTR(file.as_ptr()), STGM_READ).ok()?;

        let mut buf = [0u16; MAX_PATH_LEN];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;

        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        if end == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

fn write_target(path: &Path, target: &str) -> Result<(), String> {
    unsafe {
        let link = open_link().ok_or(i18n::t("无法创建 ShellLink 对象", "Cannot create a ShellLink object"))?;
        let persist: IPersistFile = link.cast().map_err(|e| i18n::t(&format!("cast 失败: {}", e), &format!("cast failed: {}", e)))?;

        let file = HSTRING::from(path.to_string_lossy().to_string());
        persist
            .Load(PCWSTR(file.as_ptr()), STGM_READWRITE)
            .map_err(|e| i18n::t(&format!("打开快捷方式失败: {}", e), &format!("Cannot open the shortcut: {}", e)))?;

        let value = HSTRING::from(target);
        link.SetPath(PCWSTR(value.as_ptr()))
            .map_err(|e| i18n::t(&format!("设置目标失败: {}", e), &format!("Cannot set the target: {}", e)))?;

        persist
            .Save(PCWSTR(file.as_ptr()), true)
            .map_err(|e| i18n::t(&format!("保存快捷方式失败: {}", e), &format!("Cannot save the shortcut: {}", e)))?;

        Ok(())
    }
}

/* ------------------------------------------------------------------ */
/* 备份                                                                */
/* ------------------------------------------------------------------ */

fn backup_path() -> PathBuf {
    crate::config::app_data_dir().join("shortcut-backup.json")
}

fn load_backup() -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(backup_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_backup(map: &std::collections::HashMap<String, String>) {
    if let Ok(text) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(backup_path(), text);
    }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

pub struct State {
    pub desktop: String,
    pub startmenu: String,
    pub taken_over: bool,
}

pub fn info() -> State {
    let me = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let desktop = desktop_lnk()
        .filter(|p| p.exists())
        .and_then(|p| read_target(&p))
        .unwrap_or_default();

    let startmenu = start_menu_lnk()
        .filter(|p| p.exists())
        .and_then(|p| read_target(&p))
        .unwrap_or_default();

    let taken_over = (!desktop.is_empty() && desktop.to_lowercase() == me)
        || (!startmenu.is_empty() && startmenu.to_lowercase() == me);

    State {
        desktop,
        startmenu,
        taken_over,
    }
}

pub fn takeover() -> Result<usize, String> {
    let exe = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    let list = targets();
    if list.is_empty() {
        return Err(i18n::t(
            "没找到 Discord 的快捷方式（桌面和开始菜单都没有）",
            "No Discord shortcut found (neither on the desktop nor in the Start menu)",
        ));
    }

    let mut backup = load_backup();
    let mut count = 0;

    for path in list {
        let key = path.to_string_lossy().to_string();
        let original = match read_target(&path) {
            Some(t) if !t.is_empty() => t,
            _ => continue,
        };

        // 已经指向我们自己就不重复备份，避免把备份覆盖成自己
        if original.eq_ignore_ascii_case(&exe) {
            count += 1;
            continue;
        }

        backup.entry(key).or_insert(original);
        write_target(&path, &exe)?;
        count += 1;
    }

    save_backup(&backup);
    crate::logging::write("INFO", &format!("已接管 Discord 快捷方式（{} 个）", count));
    Ok(count)
}

pub fn restore() -> Result<usize, String> {
    let backup = load_backup();
    if backup.is_empty() {
        return Err(i18n::t(
            "没有找到快捷方式备份，可能从未接管过",
            "No shortcut backup found — the shortcut was probably never hooked",
        ));
    }

    let mut count = 0;
    for (key, original) in backup.iter() {
        let path = PathBuf::from(key);
        if !path.exists() {
            continue;
        }
        write_target(&path, original)?;
        count += 1;
    }

    // 清空备份，避免重复还原
    save_backup(&std::collections::HashMap::new());
    crate::logging::write("INFO", &format!("已还原 Discord 快捷方式（{} 个）", count));
    Ok(count)
}
