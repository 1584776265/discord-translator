//! 本地翻译引擎（LibreTranslate / Ollama）的一键部署与探测。
//!
//! 为什么不做成"内置"：
//!   LibreTranslate = Python 运行时(约 60MB) + Argos 语言模型(每个语言对 100~200MB)，
//!   完整部署 400MB 起步。而本程序的 exe 只有 4.98MB，
//!   把引擎塞进去会让体积红线彻底失效，而且每次更新 exe 都要重发几百 MB。
//!
//! 折中做法：exe 里带"按钮"，检测环境后引导部署。
//!   - 有 Docker  → 一键 docker run，镜像由 Docker 自己缓存
//!   - 有 Ollama  → 直接建议用 openai 兼容模式接本地模型
//!   - 什么都没有 → 给出明确的安装指引，不静默失败

use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const LIBRE_PORT: u16 = 5000;
const OLLAMA_PORT: u16 = 11434;

/// 部署任务的实时状态，前端轮询
#[derive(Clone, serde::Serialize, Default)]
pub struct DeployState {
    pub running: bool,
    /// libre | ollama，前端据此知道该自动填哪套配置
    pub target: String,
    pub phase: String,
    pub message: String,
    pub done: bool,
    pub ok: bool,
}

static STATE: Mutex<Option<DeployState>> = Mutex::new(None);

fn set_state(f: impl FnOnce(&mut DeployState)) {
    if let Ok(mut guard) = STATE.lock() {
        let st = guard.get_or_insert_with(DeployState::default);
        f(st);
    }
}

pub fn state() -> DeployState {
    STATE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
}

/// 用系统默认浏览器打开链接。
/// 走 ShellExecuteW 而不是 `cmd /c start`：后者会闪一下黑窗。
fn open_url(url: &str) {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        unsafe {
            let _ = ShellExecuteW(
                None,
                &HSTRING::from("open"),
                &HSTRING::from(url),
                None,
                None,
                SW_SHOWNORMAL,
            );
        }
    }

    #[cfg(not(windows))]
    {
        let _ = url;
    }
}

const DOCKER_DOWNLOAD_URL: &str = "https://www.docker.com/products/docker-desktop/";
const OLLAMA_DOWNLOAD_URL: &str = "https://ollama.com/download";

/// 尝试拉起已安装但没运行的 Docker Desktop
fn try_start_docker_desktop() -> bool {
    let candidates = [
        r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
        r"C:\Program Files\Docker\Docker\frontend\Docker Desktop.exe",
    ];

    for path in candidates.iter() {
        if std::path::Path::new(path).exists() {
            let mut cmd = Command::new(path);
            cmd.creation_flags_safe();
            if cmd.spawn().is_ok() {
                crate::logging::write("INFO", "已尝试启动 Docker Desktop");
                return true;
            }
        }
    }

    false
}

fn run_quiet(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.output() {
        Ok(o) if o.status.success() => {
            Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => None,
    }
}

pub struct LocalEnv {
    pub docker: bool,
    pub docker_running: bool,
    pub libre_running: bool,
    pub ollama_running: bool,
    pub docker_version: String,
}

pub fn detect() -> LocalEnv {
    let docker_version = run_quiet("docker", &["--version"]).unwrap_or_default();
    let docker = !docker_version.is_empty();

    // docker --version 成功不代表守护进程在跑，info 才需要连 daemon
    let docker_running = docker && run_quiet("docker", &["info", "--format", "{{.ServerVersion}}"]).is_some();

    LocalEnv {
        docker,
        docker_running,
        libre_running: port_open(LIBRE_PORT),
        ollama_running: port_open(OLLAMA_PORT),
        docker_version,
    }
}

/// 后台线程执行部署，前端通过 deploy_state 轮询进度
pub fn start_deploy() {
    {
        let mut guard = match STATE.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let st = guard.get_or_insert_with(DeployState::default);
        if st.running {
            return;
        }
        *st = DeployState {
            running: true,
            target: "libre".into(),
            phase: "prepare".into(),
            message: "检查环境…".into(),
            done: false,
            ok: false,
        };
    }

    std::thread::spawn(|| {
        let env = detect();

        if !env.docker {
            // 直接打开下载页，省得用户自己去找
            open_url(DOCKER_DOWNLOAD_URL);
            finish(
                false,
                "没有检测到 Docker，已为你打开 Docker Desktop 下载页。装好并启动它之后，重启本程序再点一次部署。",
            );
            return;
        }

        if !env.docker_running {
            // 装了但没启动：顺手把 Docker Desktop 拉起来
            let started = try_start_docker_desktop();
            finish(
                false,
                if started {
                    "Docker 已安装但没在运行，正在为你启动 Docker Desktop。等托盘图标变成运行中（约 30~60 秒）后，再点一次部署。"
                } else {
                    "Docker 已安装但没在运行。请手动启动 Docker Desktop，等它显示 Running 后再点部署。"
                },
            );
            return;
        }

        if env.libre_running {
            finish(true, "本机已经有 LibreTranslate 在 5000 端口运行，无需重复部署。");
            return;
        }

        set_state(|s| {
            s.phase = "pull".into();
            s.message = "正在拉取镜像（首次约 1GB，慢的话 10 分钟以上）…".into();
        });
        crate::logging::write("INFO", "开始拉取 libretranslate 镜像");

        // 先单独 pull，这样能明确区分「拉取失败」和「启动失败」
        let pull = Command::new("docker")
            .args(["pull", "libretranslate/libretranslate:latest"])
            .creation_flags_safe()
            .output();

        match pull {
            Ok(o) if !o.status.success() => {
                let err = String::from_utf8_lossy(&o.stderr);
                finish(
                    false,
                    &format!("镜像拉取失败：{}", first_line(&err)),
                );
                return;
            }
            Err(e) => {
                finish(false, &format!("无法执行 docker：{}", e));
                return;
            }
            _ => {}
        }

        set_state(|s| {
            s.phase = "start".into();
            s.message = "镜像就绪，正在启动容器…".into();
        });

        // 已经存在同名容器就先删掉，避免端口冲突
        let _ = Command::new("docker")
            .args(["rm", "-f", "discord-translator-libre"])
            .creation_flags_safe()
            .output();

        let run = Command::new("docker")
            .args([
                "run",
                "-d",
                "--name",
                "discord-translator-libre",
                "--restart",
                "unless-stopped",
                "-p",
                "5000:5000",
                "libretranslate/libretranslate:latest",
            ])
            .creation_flags_safe()
            .output();

        match run {
            Ok(o) if !o.status.success() => {
                let err = String::from_utf8_lossy(&o.stderr);
                finish(false, &format!("容器启动失败：{}", first_line(&err)));
                return;
            }
            Err(e) => {
                finish(false, &format!("无法启动容器：{}", e));
                return;
            }
            _ => {}
        }

        set_state(|s| {
            s.phase = "wait".into();
            s.message = "容器已启动，等待服务就绪（首次要加载语言模型，约 1~2 分钟）…".into();
        });

        // LibreTranslate 冷启动要加载模型，给足 150 秒
        for i in 0..75 {
            std::thread::sleep(Duration::from_secs(2));
            if port_open(LIBRE_PORT) {
                // 端口通了还要确认真的能翻译
                std::thread::sleep(Duration::from_secs(3));
                finish(
                    true,
                    "LibreTranslate 已就绪（http://127.0.0.1:5000）。请在「翻译服务」里选择 LibreTranslate 并保存。",
                );
                crate::logging::write("INFO", "LibreTranslate 部署完成");
                return;
            }
            if i % 10 == 9 {
                set_state(|s| {
                    s.message = format!("仍在等待服务就绪…（已等 {} 秒）", (i + 1) * 2);
                });
            }
        }

        finish(
            false,
            "容器已启动但 150 秒内端口没通。可能是镜像首次下载语言模型较慢，稍后点「检测」看看。",
        );
    });
}

fn first_line(s: &str) -> String {
    s.lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("未知错误")
        .trim()
        .chars()
        .take(180)
        .collect()
}

fn finish(ok: bool, msg: &str) {
    crate::logging::write(if ok { "INFO" } else { "ERROR" }, msg);
    set_state(|s| {
        s.running = false;
        s.done = true;
        s.ok = ok;
        s.phase = if ok { "done".into() } else { "failed".into() };
        s.message = msg.to_string();
    });
}

/* ------------------------------------------------------------------ */
/* Ollama 一键部署                                                     */
/* ------------------------------------------------------------------ */

/// 默认模型：3B 参数，约 2GB，CPU 上也能跑出可用的速度
const OLLAMA_MODEL: &str = "qwen2.5:3b";

/// 找 ollama 可执行文件：先看 PATH，再看默认安装目录
fn find_ollama() -> Option<std::path::PathBuf> {
    if run_quiet("ollama", &["--version"]).is_some() {
        return Some(std::path::PathBuf::from("ollama"));
    }

    let local = std::env::var("LOCALAPPDATA").ok()?;
    let p = std::path::PathBuf::from(local)
        .join("Programs")
        .join("Ollama")
        .join("ollama.exe");

    if p.exists() {
        Some(p)
    } else {
        None
    }
}

pub fn start_deploy_ollama() {
    {
        let mut guard = match STATE.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let st = guard.get_or_insert_with(DeployState::default);
        if st.running {
            return;
        }
        *st = DeployState {
            running: true,
            target: "ollama".into(),
            phase: "prepare".into(),
            message: "检查 Ollama…".into(),
            done: false,
            ok: false,
        };
    }

    std::thread::spawn(deploy_ollama);
}

fn deploy_ollama() {
    // ---- 1. 没装就先装 ----
    let mut exe = find_ollama();

    if exe.is_none() {
        set_state(|s| {
            s.phase = "install".into();
            s.message = "未检测到 Ollama，正在尝试用 winget 安装…".into();
        });

        if run_quiet("winget", &["--version"]).is_none() {
            open_url(OLLAMA_DOWNLOAD_URL);
            finish(
                false,
                "没有检测到 Ollama，也没有 winget，已为你打开下载页。装好后重启本程序再点一次部署。",
            );
            return;
        }

        crate::logging::write("INFO", "使用 winget 安装 Ollama");

        let attempt = Command::new("winget")
            .args([
                "install",
                "--id",
                "Ollama.Ollama",
                "-e",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--silent",
            ])
            .creation_flags_safe()
            .output();

        match attempt {
            Ok(o) if !o.status.success() => {
                let mut detail = String::from_utf8_lossy(&o.stdout).to_string();
                detail.push_str(&String::from_utf8_lossy(&o.stderr));
                finish(
                    false,
                    &format!(
                        "winget 安装失败：{}。也可以到 https://ollama.com/download 手动下载。",
                        first_line(&detail)
                    ),
                );
                return;
            }
            Err(e) => {
                finish(false, &format!("无法执行 winget：{}", e));
                return;
            }
            _ => {}
        }

        std::thread::sleep(Duration::from_secs(3));
        exe = find_ollama();

        if exe.is_none() {
            finish(
                false,
                "安装完成但找不到 ollama.exe。请重启本程序后再点一次「部署 Ollama」。",
            );
            return;
        }
    }

    let ollama = match exe {
        Some(p) => p,
        None => return,
    };

    // ---- 2. 起服务 ----
    if !port_open(OLLAMA_PORT) {
        set_state(|s| {
            s.phase = "serve".into();
            s.message = "正在启动 Ollama 服务…".into();
        });

        let mut cmd = Command::new(&ollama);
        cmd.arg("serve");
        cmd.creation_flags_safe();

        // serve 是常驻进程，spawn 之后不能等它退出
        if let Err(e) = cmd.spawn() {
            finish(false, &format!("启动 Ollama 服务失败：{}", e));
            return;
        }

        for _ in 0..45 {
            std::thread::sleep(Duration::from_secs(1));
            if port_open(OLLAMA_PORT) {
                break;
            }
        }

        if !port_open(OLLAMA_PORT) {
            finish(
                false,
                "Ollama 服务启动后 45 秒内端口没通。可以手动运行 ollama serve 看看报什么错。",
            );
            return;
        }
    }

    // ---- 3. 拉模型 ----
    set_state(|s| {
        s.phase = "pull".into();
        s.message = format!(
            "正在拉取模型 {}（约 2GB，视网速 5~20 分钟）…",
            OLLAMA_MODEL
        );
    });
    crate::logging::write("INFO", &format!("开始拉取 Ollama 模型 {}", OLLAMA_MODEL));

    let pull = Command::new(&ollama)
        .args(["pull", OLLAMA_MODEL])
        .creation_flags_safe()
        .output();

    match pull {
        Ok(o) if !o.status.success() => {
            let e = String::from_utf8_lossy(&o.stderr);
            finish(false, &format!("模型拉取失败：{}", first_line(&e)));
            return;
        }
        Err(e) => {
            finish(false, &format!("无法拉取模型：{}", e));
            return;
        }
        _ => {}
    }

    finish(
        true,
        &format!(
            "Ollama 已就绪（http://127.0.0.1:11434），模型 {}。已自动切到 OpenAI 兼容模式。",
            OLLAMA_MODEL
        ),
    );
    crate::logging::write("INFO", "Ollama 部署完成");
}

/// 小工具：给 Command 加 CREATE_NO_WINDOW，避免弹黑窗
trait NoWindow {
    fn creation_flags_safe(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    fn creation_flags_safe(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}
