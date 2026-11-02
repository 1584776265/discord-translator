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

/// 真正请求一次 /languages，判断服务是否已经能响应。
///
/// 不能只看端口：LibreTranslate 容器刚创建时 Docker 就把 5000 端口映射好了，
/// 但里面的 Python 进程还在下载模型、根本没监听，此时 port_open 会是 true，
/// 连接上去却被立即重置 —— 照着端口判断会误报"部署完成"。
fn libre_http_ready() -> bool {
    use std::io::{Read, Write};

    let addr: SocketAddr = ([127, 0, 0, 1], LIBRE_PORT).into();
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));

    let req = "GET /languages HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }

    let mut buf = [0u8; 512];
    match stream.read(&mut buf) {
        Ok(n) if n > 12 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
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

/// 找 docker 可执行文件。
/// Docker Desktop 4.30+ 默认 per-user 安装，CLI 不在 Program Files 也不一定在 PATH 里。
fn find_docker() -> Option<String> {
    if run_quiet("docker", &["--version"]).is_some() {
        return Some("docker".to_string());
    }

    let mut candidates: Vec<String> = Vec::new();

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(format!(
            r"{}\Programs\DockerDesktop\resources\bin\docker.exe",
            local
        ));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(format!(r"{}\Docker\Docker\resources\bin\docker.exe", pf));
    }

    for path in candidates {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }

    None
}

/// 已经下载了多少个语言模型 —— 用来给用户显示真实进度
fn libre_model_count(docker_bin: &str) -> Option<u32> {
    let out = Command::new(docker_bin)
        .args([
            "exec",
            "discord-translator-libre",
            "sh",
            "-c",
            "ls /home/libretranslate/.local/share/argos-translate/packages 2>/dev/null | wc -l",
        ])
        .creation_flags_safe()
        .output()
        .ok()?;

    if !out.status.success() {
        return None;
    }

    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

pub struct LocalEnv {
    pub docker: bool,
    pub docker_running: bool,
    pub libre_running: bool,
    pub ollama_running: bool,
    pub docker_version: String,
}

pub fn detect() -> LocalEnv {
    let docker_path = find_docker();

    let docker_version = docker_path
        .as_deref()
        .and_then(|p| run_quiet(p, &["--version"]))
        .unwrap_or_default();
    let docker = !docker_version.is_empty();

    // docker --version 成功不代表守护进程在跑，info 才需要连 daemon
    let docker_running = docker
        && docker_path
            .as_deref()
            .and_then(|p| run_quiet(p, &["info", "--format", "{{.ServerVersion}}"]))
            .is_some();

    LocalEnv {
        docker,
        docker_running,
        // 同样不能用端口判断：容器创建瞬间端口就映射好了
        libre_running: libre_http_ready(),
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
            finish(true, "本机已经有 LibreTranslate 在 5000 端口正常运行，无需重复部署。");
            return;
        }

        let docker_bin = match find_docker() {
            Some(p) => p,
            None => {
                finish(false, "环境检测到 Docker 但找不到 docker 命令，请重启本程序后再试。");
                return;
            }
        };

        set_state(|s| {
            s.phase = "pull".into();
            s.message = "正在拉取镜像（首次约 1GB，慢的话 10 分钟以上）…".into();
        });
        crate::logging::write("INFO", "开始拉取 libretranslate 镜像");

        // 先单独 pull，这样能明确区分「拉取失败」和「启动失败」
        let pull = Command::new(&docker_bin)
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
        let _ = Command::new(&docker_bin)
            .args(["rm", "-f", "discord-translator-libre"])
            .creation_flags_safe()
            .output();

        // --load-only 是关键：不加它，容器启动时会下载全部 60 多个语言模型
        // （2~3GB，10~20 分钟才开始监听端口）。只加载常用语言能压到几分钟。
        let run = Command::new(&docker_bin)
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
                "--load-only",
                "en,zh,ja,ko,ru",
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
            s.message = "容器已启动，正在下载语言模型（中英日韩俄，首次约 3~8 分钟）…".into();
        });

        // 下载模型 + 加载，给足 12 分钟
        for i in 0..360 {
            std::thread::sleep(Duration::from_secs(2));

            if libre_http_ready() {
                finish(
                    true,
                    "LibreTranslate 已就绪（http://127.0.0.1:5000）。已自动切换翻译服务。",
                );
                crate::logging::write("INFO", "LibreTranslate 部署完成");
                return;
            }

            // 每 16 秒刷新一次真实进度：直接数容器里的模型目录
            if i % 8 == 7 {
                let waited = (i + 1) * 2;
                let count = libre_model_count(&docker_bin).unwrap_or(0);

                set_state(|s| {
                    s.message = if count > 0 {
                        format!(
                            "正在下载语言模型… 已完成 {} 个（已等 {} 秒，首次最长约 12 分钟）",
                            count, waited
                        )
                    } else {
                        format!("正在启动容器并准备下载模型…（已等 {} 秒）", waited)
                    };
                });
            }
        }

        finish(
            false,
            "容器起来了但 12 分钟内接口没响应。多半是模型还没下完，可以过几分钟点「重新检测」看看，或运行 docker logs discord-translator-libre 查看进度。",
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
