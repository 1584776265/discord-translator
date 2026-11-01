use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// stable | ptb | canary，由启动时从配置注入
static CHANNEL: Mutex<String> = Mutex::new(String::new());

pub fn set_channel(channel: &str) {
    if let Ok(mut cur) = CHANNEL.lock() {
        *cur = channel.to_string();
    }
}

fn channel_now() -> String {
    CHANNEL.lock().map(|c| c.clone()).unwrap_or_default()
}

/// 当前渠道的进程名
fn exe_name() -> &'static str {
    match channel_now().as_str() {
        "ptb" => "DiscordPTB.exe",
        "canary" => "DiscordCanary.exe",
        _ => "Discord.exe",
    }
}

/// 当前渠道的安装目录名
fn dir_name() -> &'static str {
    match channel_now().as_str() {
        "ptb" => "DiscordPTB",
        "canary" => "DiscordCanary",
        _ => "Discord",
    }
}

pub fn discord_root() -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let p = PathBuf::from(base).join(dir_name());
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

pub fn find_updater() -> Option<PathBuf> {
    let p = discord_root()?.join("Update.exe");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

pub fn find_latest_exe() -> Option<PathBuf> {
    let root = discord_root()?;
    let mut best: Option<(Vec<u32>, PathBuf)> = None;

    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return None,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("app-") {
            continue;
        }
        let ver: Vec<u32> = name[4..]
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect();
        let exe = entry.path().join(exe_name());
        if !exe.exists() {
            continue;
        }
        let better = match &best {
            None => true,
            Some((v, _)) => ver > *v,
        };
        if better {
            best = Some((ver, exe));
        }
    }

    best.map(|(_, p)| p)
}

/// 枚举指定进程名的所有 PID。
/// 用 Toolhelp 快照而不是 tasklist —— 少一次子进程，也不会闪黑窗。
#[cfg(windows)]
fn find_pids(exe_name: &str) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut pids = Vec::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return pids,
        };

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]);

                if name.eq_ignore_ascii_case(exe_name) {
                    pids.push(entry.th32ProcessID);
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snap);
    }
    pids
}

pub fn is_running() -> bool {
    #[cfg(windows)]
    {
        !find_pids(exe_name()).is_empty()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub fn port_alive(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// 找一个既没被监听、也能绑定成功的端口
pub fn pick_port(start: u16) -> u16 {
    for p in start..start.saturating_add(50) {
        if port_alive(p) {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    start
}

/// 给 Discord 的主窗口发 WM_CLOSE，让它自己正常退出（保住草稿）。
pub fn graceful_close() {
    #[cfg(windows)]
    {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
        };

        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let pids = &*(lparam.0 as *const Vec<u32>);
            let mut pid = 0u32;
            let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));

            if pids.contains(&pid) && IsWindowVisible(hwnd).as_bool() {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            BOOL(1)
        }

        let pids = find_pids(exe_name());
        if pids.is_empty() {
            return;
        }

        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&pids as *const Vec<u32> as isize));
        }
    }

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if !is_running() {
            return;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

pub fn kill_all() {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, TerminateProcess, PROCESS_TERMINATE,
        };

        for pid in find_pids(exe_name()) {
            unsafe {
                if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(handle, 1);
                    let _ = CloseHandle(handle);
                }
            }
        }
    }
}

pub fn stop() {
    if !is_running() {
        return;
    }
    graceful_close();
    if is_running() {
        kill_all();
        std::thread::sleep(Duration::from_millis(1200));
    }
}

pub struct StartResult {
    pub port: u16,
    pub mode: String,
    pub elapsed_ms: u128,
}

/// 启动 Discord 并等待调试端口就绪。
/// 返回实际生效的方式（updater / direct）。
pub fn start(port: u16, origins: &str) -> Result<StartResult, String> {
    let begun = Instant::now();

    // 优先直接启动最新版本目录下的 Discord.exe。
    // 不走 Squirrel 的 Update.exe：它要求把启动参数整体塞进 --process-start-args
    // 再转义一层引号，Windows 命令行转义极易出错，实测经常起不来、白等 35 秒。
    if let Some(exe) = find_latest_exe() {
        let mut cmd = Command::new(&exe);
        cmd.args([
            format!("--remote-debugging-port={}", port),
            format!("--remote-allow-origins={}", origins),
        ]);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        cmd.spawn()
            .map_err(|e| format!("启动 Discord 失败: {}", e))?;

        for _ in 0..28 {
            std::thread::sleep(Duration::from_millis(1000));
            if port_alive(port) {
                return Ok(StartResult {
                    port,
                    mode: "direct".into(),
                    elapsed_ms: begun.elapsed().as_millis(),
                });
            }
        }

        kill_all();
        std::thread::sleep(Duration::from_millis(1200));
    }

    // 退路：交给 Update.exe，它会补齐运行环境
    let updater = find_updater().ok_or("找不到 Discord 安装（%LOCALAPPDATA%\\Discord）")?;
    let start_args = format!(
        "--remote-debugging-port={} --remote-allow-origins={}",
        port, origins
    );
    let mut cmd = Command::new(&updater);
    cmd.args([
        "--processStart",
        exe_name(),
        "--process-start-args",
        &format!("\"{}\"", start_args),
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| format!("启动 Update.exe 失败: {}", e))?;

    for _ in 0..35 {
        std::thread::sleep(Duration::from_millis(1000));
        if port_alive(port) {
            return Ok(StartResult {
                port,
                mode: "updater".into(),
                elapsed_ms: begun.elapsed().as_millis(),
            });
        }
    }

    Err("等待 Discord 调试端口超时".into())
}
