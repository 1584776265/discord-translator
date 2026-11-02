//! 本地引擎的卸载与状态查询。
//!
//! 只做「我们创建的东西」：LibreTranslate 容器/镜像、Ollama 的模型。
//! Docker Desktop 和 Ollama 本体属于用户自己装的应用，不替用户静默卸载，
//! 只负责给出占用情况和卸载入口。

use crate::i18n;
use std::process::{Command, Stdio};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const LIBRE_CONTAINER: &str = "discord-translator-libre";
const LIBRE_IMAGE: &str = "libretranslate/libretranslate:latest";

fn hidden(program: &str, args: &[&str]) -> Option<String> {
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

fn docker_bin() -> Option<String> {
    crate::local_engine::find_docker()
}

fn ollama_bin() -> Option<std::path::PathBuf> {
    crate::local_engine::find_ollama()
}

/* ------------------------------------------------------------------ */
/* LibreTranslate                                                      */
/* ------------------------------------------------------------------ */

pub struct LibreInfo {
    pub installed: bool,
    pub running: bool,
    /// Docker Desktop 装了但没启动时，不能把容器报成「未安装」误导用户
    pub docker_running: bool,
    pub image_size: String,
    pub languages: Vec<String>,
    pub models: usize,
}

pub fn libre_info() -> LibreInfo {
    let mut info = LibreInfo {
        installed: false,
        running: false,
        docker_running: false,
        image_size: String::new(),
        languages: Vec::new(),
        models: 0,
    };

    let docker = match docker_bin() {
        Some(d) => d,
        None => return info,
    };

    // daemon 没起来时 docker ps 会直接失败，此时无从判断容器是否存在
    info.docker_running = hidden(&docker, &["info", "--format", "{{.ServerVersion}}"]).is_some();
    if !info.docker_running {
        return info;
    }

    // 容器是否存在
    let ps = hidden(
        &docker,
        &[
            "ps",
            "-a",
            "--filter",
            &format!("name={}", LIBRE_CONTAINER),
            "--format",
            "{{.State}}",
        ],
    )
    .unwrap_or_default();

    let state = ps.lines().next().unwrap_or("").trim().to_string();
    info.installed = !state.is_empty();
    info.running = state == "running";

    if !info.installed {
        return info;
    }

    // 镜像体积
    info.image_size = hidden(
        &docker,
        &["images", LIBRE_IMAGE, "--format", "{{.Size}}"],
    )
    .unwrap_or_default();

    // 已装语言：目录名形如 translate-en_zh-1_9
    if let Some(raw) = hidden(
        &docker,
        &[
            "exec",
            LIBRE_CONTAINER,
            "sh",
            "-c",
            "ls /home/libretranslate/.local/share/argos-translate/packages 2>/dev/null",
        ],
    ) {
        let mut set = std::collections::BTreeSet::new();
        let mut count = 0usize;

        for line in raw.lines() {
            let name = line.trim();
            if !name.starts_with("translate-") {
                continue;
            }
            count += 1;

            // translate-en_zh-1_9 -> en, zh
            let core = name
                .trim_start_matches("translate-")
                .rsplitn(2, '-')
                .nth(1)
                .unwrap_or("");

            for part in core.split('_') {
                let p = part.trim();
                if p.len() >= 2 && p.len() <= 3 {
                    set.insert(p.to_string());
                }
            }
        }

        info.models = count;
        info.languages = set.into_iter().collect();
    }

    info
}

fn libre_table() -> String {
    LIBRE_CONTAINER.to_string()
}

pub fn uninstall_libre(remove_image: bool) -> Result<String, String> {
    let docker = docker_bin().ok_or(i18n::t("找不到 docker 命令", "docker command not found"))?;

    let rm = hidden(&docker, &["rm", "-f", &libre_table()]);
    let rm_ok = rm.is_some();

    let mut msg = if rm_ok {
        i18n::t("已删除 LibreTranslate 容器", "LibreTranslate container removed")
    } else {
        i18n::t(
            "没有找到可删除的容器（可能已经不存在）",
            "No container found (it may already be gone)",
        )
    };

    if remove_image {
        if hidden(&docker, &["rmi", LIBRE_IMAGE]).is_some() {
            msg.push_str(&i18n::t("，并删除了镜像", ", and the image was removed"));
        } else {
            msg.push_str(&i18n::t(
            "，镜像删除失败（可能被其他容器引用）",
            ", but the image could not be removed (it may be used by another container)",
        ));
        }
    }

    crate::logging::write("INFO", &msg);
    Ok(msg)
}

/* ------------------------------------------------------------------ */
/* Ollama                                                              */
/* ------------------------------------------------------------------ */

pub struct OllamaInfo {
    pub installed: bool,
    pub running: bool,
    pub models: Vec<(String, String)>, // (名称, 大小)
}

pub fn ollama_info() -> OllamaInfo {
    let mut info = OllamaInfo {
        installed: false,
        running: false,
        models: Vec::new(),
    };

    let bin = match ollama_bin() {
        Some(b) => b,
        None => return info,
    };
    info.installed = true;

    let addr: std::net::SocketAddr = ([127, 0, 0, 1], 11434).into();
    info.running =
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).is_ok();

    if let Some(raw) = hidden(bin.to_string_lossy().as_ref(), &["list"]) {
        for (idx, line) in raw.lines().enumerate() {
            if idx == 0 || line.trim().is_empty() {
                continue; // 跳过表头
            }
            // NAME  ID  SIZE  MODIFIED
            let cells: Vec<&str> = line.split_whitespace().collect();
            if cells.len() >= 3 {
                let name = cells[0].to_string();
                // SIZE 形如 1.9 GB / 487 MB，可能被拆成两格
                let size = if cells[2] == "GB" || cells[2] == "MB" {
                    format!("{} {}", cells[2 - 1], cells[2])
                } else {
                    format!("{} {}", cells[2], cells.get(3).copied().unwrap_or(""))
                };
                info.models.push((name, size.trim().to_string()));
            }
        }
    }

    info
}

pub fn uninstall_ollama_model(model: &str) -> Result<String, String> {
    let bin = ollama_bin().ok_or(i18n::t("找不到 ollama 命令", "ollama command not found"))?;

    if model.trim().is_empty() {
        return Err(i18n::t("模型名不能为空", "Model name cannot be empty"));
    }

    // ollama rm 走的是本地 11434 服务，服务没起会直接失败。
    // 用户常常是「应用没开着就来点卸载」，这里顺手把它拉起来。
    let _ = ensure_ollama_serving();

    let out = hidden(bin.to_string_lossy().as_ref(), &["rm", model]);
    match out {
        Some(_) => {
            let msg = i18n::t(
                &format!("已删除模型 {}", model),
                &format!("Model {} removed", model),
            );
            crate::logging::write("INFO", &msg);
            Ok(msg)
        }
        None => Err(i18n::t(
            &format!("删除模型 {} 失败（可能模型不存在，或 Ollama 服务未运行）", model),
            &format!(
                "Failed to remove model {} (it may not exist, or the Ollama service is not running)",
                model
            ),
        )),
    }
}

/// 只在需要时用：启动 Ollama 里带的服务以便删除模型
pub fn ensure_ollama_serving() -> bool {
    let bin = match ollama_bin() {
        Some(b) => b,
        None => return false,
    };

    let addr: std::net::SocketAddr = ([127, 0, 0, 1], 11434).into();
    if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).is_ok() {
        return true;
    }

    let mut cmd = Command::new(&bin);
    cmd.arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let _ = cmd.spawn();

    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(400)).is_ok()
        {
            return true;
        }
    }

    false
}
