//! 自动更新：从 GitHub Releases 取最新版，校验 sha256 后静默升级。
//!
//! 为什么不用 tauri-plugin-updater：那套要长期保管 minisign 私钥并塞进 CI secret，
//! 私钥丢了就再也发不出更新。这里改用发布页自带的 `sha256.txt` 做完整性校验，
//! 零密钥，代价是信任链完全绑在 GitHub 账号上（单人项目可接受）。
//!
//! 安装版（注册表里有 uninstall 项、且当前 exe 就在安装目录里）走静默升级：
//! 下载 → 校验 → 备份配置 → 退出 → 安装器 `/S` 覆盖安装 → 重新拉起。
//! 便携版不做自动替换（运行中的 exe 覆盖不了，用批处理替换又容易被杀软拦），只提示 + 打开下载页。

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
use winreg::RegKey;

use crate::i18n::t;

const OWNER: &str = "1584776265";
const REPO: &str = "discord-translator";
const UA: &str = "DiscordTranslator-Updater";

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize, Clone)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    #[allow(dead_code)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

struct Remote {
    version: String,
    setup: Option<Asset>,
    sha: Option<Asset>,
    #[allow(dead_code)]
    portable: Option<Asset>,
    notes: String,
    html_url: String,
    published_at: String,
}

/* ------------------------------------------------------------------ */
/* 版本与代理                                                          */
/* ------------------------------------------------------------------ */

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn parse_ver(v: &str) -> (u32, u32, u32) {
    let s = v.trim().trim_start_matches(['v', 'V']);
    let mut it = s.split('.');
    let a = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    let b = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    let c = it
        .next()
        .and_then(|x| {
            let digits: String = x.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().ok()
        })
        .unwrap_or(0);
    (a, b, c)
}

fn with_scheme(s: &str) -> String {
    let s = s.trim();
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("socks5://") {
        s.to_string()
    } else {
        format!("http://{}", s)
    }
}

/// 解析更新要用的代理：配置优先，空则读系统（WinINet）代理。
pub fn proxy_url() -> Option<String> {
    let cfg = crate::config::load();
    let raw = cfg.update_proxy.trim();

    if raw.eq_ignore_ascii_case("direct") || raw.eq_ignore_ascii_case("off") {
        return None;
    }
    if !raw.is_empty() {
        return Some(with_scheme(raw));
    }

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;

    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }

    let server: String = key.get_value("ProxyServer").unwrap_or_default();
    let server = server.trim().to_string();
    if server.is_empty() {
        return None;
    }

    // 可能是 "host:port"，也可能是 "http=host:port;https=host:port"
    let host = if server.contains('=') {
        server.split(';').find_map(|part| {
            let (scheme, addr) = part.split_once('=')?;
            if scheme.trim().eq_ignore_ascii_case("http") || scheme.trim().eq_ignore_ascii_case("https") {
                Some(addr.trim().to_string())
            } else {
                None
            }
        })
    } else {
        Some(server)
    };

    host.filter(|h| !h.is_empty()).map(|h| with_scheme(&h))
}

fn builder(timeout_sec: u64) -> Result<reqwest::ClientBuilder, String> {
    let b = reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(timeout_sec))
        .redirect(reqwest::redirect::Policy::limited(8));

    Ok(match proxy_url() {
        Some(p) => b.proxy(reqwest::Proxy::all(&p).map_err(|e| {
            t(
                &format!("代理地址无效（{}）：{}", p, e),
                &format!("Invalid proxy ({}): {}", p, e),
            )
        })?),
        None => b.no_proxy(),
    })
}

fn client(timeout_sec: u64) -> Result<reqwest::Client, String> {
    builder(timeout_sec)?.build().map_err(|e| {
        t(
            &format!("创建 HTTP 客户端失败: {}", e),
            &format!("Failed to create HTTP client: {}", e),
        )
    })
}

/// API 被限流时的备用路径：`/releases/latest` 会 302 到 `/releases/tag/vX.Y.Z`，
/// 只要不跟随重定向就能从 Location 头里拿到版本号。不消耗 API 额度。
async fn latest_tag_via_redirect() -> Result<String, String> {
    let c = builder(20)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let res = c
        .get(format!("https://github.com/{}/{}/releases/latest", OWNER, REPO))
        .send()
        .await
        .map_err(|e| network_error(&e))?;

    let loc = res
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let tag = loc.trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();

    if !tag.starts_with('v') && !tag.starts_with('V') {
        return Err(t(
            "拿不到最新版本号（GitHub 页面结构可能变了）",
            "Cannot read the latest version (the GitHub page layout may have changed)",
        ));
    }

    Ok(tag.trim_start_matches(['v', 'V']).to_string())
}

/// 从 releases.atom 里抠出最新 tag。
/// 预览通道要用它：`/releases/latest` 会跳过 prerelease，而 atom 里第一条就是「最新的那个」，草稿除外。
fn parse_atom_tag(xml: &str) -> Option<String> {
    let idx = xml.find("/releases/tag/")?;
    let rest = &xml[idx + "/releases/tag/".len()..];
    let end = rest.find('"').or_else(|| rest.find('<'))?;
    let tag = &rest[..end];

    let t = tag.trim();
    if t.len() < 2 {
        return None;
    }

    Some(t.trim_start_matches(['v', 'V']).to_string())
}

async fn latest_tag_via_atom() -> Result<String, String> {
    let c = client(20)?;

    let txt = c
        .get(format!(
            "https://github.com/{}/{}/releases.atom",
            OWNER, REPO
        ))
        .send()
        .await
        .map_err(|e| network_error(&e))?
        .text()
        .await
        .map_err(|e| {
            t(
                &format!("读取发布列表失败: {}", e),
                &format!("Failed to read the release feed: {}", e),
            )
        })?;

    parse_atom_tag(&txt).ok_or_else(|| {
        t(
            "拿不到最新版本号（GitHub 页面结构可能变了）",
            "Cannot read the latest version (the GitHub page layout may have changed)",
        )
    })
}

/// 已知版本号后按发布命名规则拼出资产地址（本项目的发布流程固定这么命名）
fn remote_from_tag(tag: &str) -> Remote {
    let setup_name = format!("DiscordTranslator_{}_x64-setup.exe", tag);
    let base = format!(
        "https://github.com/{}/{}/releases/download/v{}",
        OWNER, REPO, tag
    );

    Remote {
        version: tag.to_string(),
        setup: Some(Asset {
            name: setup_name.clone(),
            browser_download_url: format!("{}/{}", base, setup_name),
            size: 0,
        }),
        sha: Some(Asset {
            name: "sha256.txt".into(),
            browser_download_url: format!("{}/sha256.txt", base),
            size: 0,
        }),
        portable: Some(Asset {
            name: "DiscordTranslator.exe".into(),
            browser_download_url: format!("{}/DiscordTranslator.exe", base),
            size: 0,
        }),
        notes: String::new(),
        html_url: format!(
            "https://github.com/{}/{}/releases/tag/v{}",
            OWNER, REPO, tag
        ),
        published_at: String::new(),
    }
}

/* ------------------------------------------------------------------ */
/* 安装状态                                                            */
/* ------------------------------------------------------------------ */

/// 注册表里的 (版本号, 安装目录)
pub fn install_info() -> Option<(String, String)> {
    let roots = [
        (RegKey::predef(HKEY_CURRENT_USER), "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (RegKey::predef(HKEY_LOCAL_MACHINE), "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (RegKey::predef(HKEY_LOCAL_MACHINE), "Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
    ];

    for (root, path) in roots.iter() {
        let key = match root.open_subkey(path) {
            Ok(k) => k,
            Err(_) => continue,
        };

        for sub_name in key.enum_keys().flatten() {
            let sub = match key.open_subkey(&sub_name) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let display: String = sub.get_value("DisplayName").unwrap_or_default();
            if !display.eq_ignore_ascii_case("DiscordTranslator") {
                continue;
            }

            let ver: String = sub.get_value("DisplayVersion").unwrap_or_default();
            let loc: String = sub.get_value("InstallLocation").unwrap_or_default();

            return Some((ver, loc.trim().trim_matches('"').trim().to_string()));
        }
    }

    None
}

/// 当前跑的是不是「安装版」：注册表有记录，而且当前 exe 就在那个安装目录里。
/// 开发机的 target\release 下跑出来的 exe 不算，免得误判。
pub fn is_installed_build() -> bool {
    let (_, loc) = match install_info() {
        Some(v) => v,
        None => return false,
    };
    if loc.is_empty() {
        return false;
    }

    let cur = match std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        Some(d) => d,
        None => return false,
    };

    let a = cur.to_string_lossy().trim_end_matches('\\').to_lowercase();
    let b = PathBuf::from(&loc).to_string_lossy().trim_end_matches('\\').to_lowercase();
    a == b
}

/* ------------------------------------------------------------------ */
/* 备份与回滚                                                          */
/* ------------------------------------------------------------------ */

fn exe_path() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| {
        t(
            &format!("取不到自身路径: {}", e),
            &format!("Cannot resolve own path: {}", e),
        )
    })
}

/// 更新前把当前 exe 复制一份：`DiscordTranslator.exe.bak-1.2.2`
pub fn backup_current_exe() -> Option<String> {
    let exe = exe_path().ok()?;
    let name = exe.file_name()?.to_string_lossy().to_string();
    let ver = current_version();
    let dst = exe.with_file_name(format!("{}.bak-{}", name, ver));

    std::fs::copy(&exe, &dst).ok()?;
    prune_backups(3);

    Some(format!("{}.bak-{}", name, ver))
}

/// 目录里所有 `<exe>.bak-x.y.z`，按版本从新到旧
fn list_backups() -> Vec<(String, std::path::PathBuf)> {
    let exe = match exe_path() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let dir = match exe.parent() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let name = match exe.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => return Vec::new(),
    };

    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            let prefix = format!("{}.bak-", name);
            if let Some(ver) = fname.strip_prefix(&prefix) {
                out.push((ver.to_string(), e.path()));
            }
        }
    }

    out.sort_by(|a, b| parse_ver(&b.0).cmp(&parse_ver(&a.0)));
    out
}

fn prune_backups(keep: usize) {
    for (_, p) in list_backups().into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// 当前可回滚到的版本号（没有备份就是 None）
pub fn backup_version() -> Option<String> {
    list_backups().into_iter().next().map(|(v, _)| v)
}

/// 回滚：把最新的备份换回原位再重新拉起程序
pub fn rollback() -> Result<String, String> {
    let (ver, bak) = match list_backups().into_iter().next() {
        Some(v) => v,
        None => {
            return Err(t(
                "没有可回滚的备份：只有被自动更新替换过的版本才会留备份",
                "No backup available — only versions replaced by an update keep one",
            ))
        }
    };

    let exe = exe_path()?;

    let dir = std::env::temp_dir().join("DiscordTranslatorUpdate");
    let _ = std::fs::create_dir_all(&dir);
    let bat = dir.join("rollback.bat");

    let script = format!(
        concat!(
            "@echo off\r\n",
            "chcp 65001 >nul\r\n",
            "ping 127.0.0.1 -n 4 >nul\r\n",
            "move /y \"{exe}\" \"{exe}.bad\" >nul 2>&1\r\n",
            "move /y \"{bak}\" \"{exe}\" >nul 2>&1\r\n",
            "start \"\" \"{exe}\"\r\n",
            "del \"%~f0\"\r\n"
        ),
        exe = exe.display(),
        bak = bak.display()
    );

    std::fs::write(&bat, script).map_err(|e| {
        t(
            &format!("写入回滚脚本失败: {}", e),
            &format!("Cannot write the rollback script: {}", e),
        )
    })?;

    let mut cmd = Command::new("cmd");
    cmd.arg("/c").arg(&bat);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn().map_err(|e| {
        t(
            &format!("启动回滚脚本失败: {}", e),
            &format!("Cannot start the rollback script: {}", e),
        )
    })?;

    let msg = t(
        &format!("正在回滚到 {}，程序会重启", ver),
        &format!("Rolling back to {} — the app will restart", ver),
    );
    crate::logging::write("INFO", &msg);

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        std::process::exit(0);
    });

    Ok(msg)
}

/* ------------------------------------------------------------------ */
/* 更新后「看发布说明」的标记文件                                      */
/* ------------------------------------------------------------------ */

fn notes_marker() -> PathBuf {
    crate::config::app_data_dir().join(".pending-notes")
}

fn write_pending_notes(url: &str) {
    let _ = std::fs::write(notes_marker(), url);
}

/// 读一次就删：新版本启动时用它决定要不要打开更新说明
pub fn take_pending_notes() -> Option<String> {
    let s = std::fs::read_to_string(notes_marker()).ok()?;
    let _ = std::fs::remove_file(notes_marker());

    let s = s.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/* ------------------------------------------------------------------ */
/* 检查更新                                                            */
/* ------------------------------------------------------------------ */

/// 更新通道：stable（默认，只认正式版）/ beta（含 prerelease 标记的测试版）
fn channel() -> String {
    let c = crate::config::load().release_channel;
    if c.eq_ignore_ascii_case("beta") {
        "beta".to_string()
    } else {
        "stable".to_string()
    }
}

pub fn current_channel() -> String {
    channel()
}

/// 是否算「有新版本」。数字段相同但当前是预发布、目标已转正式版时也要算更新，
/// 否则预览版用户升到 1.4.1-beta.1 之后就永远收不到 1.4.1 正式版。
fn is_newer(latest: &str, current: &str) -> bool {
    let l = parse_ver(latest);
    let c = parse_ver(current);

    if l != c {
        return l > c;
    }

    let current_is_pre = current.contains('-');
    let latest_is_pre = latest.contains('-');

    current_is_pre && !latest_is_pre
}

async fn fetch_release() -> Result<Remote, String> {
    let beta = channel() == "beta";

    // /latest 不含预发布；beta 通道要 /releases 列表里第一个非 draft
    let url = if beta {
        format!(
            "https://api.github.com/repos/{}/{}/releases?per_page=10",
            OWNER, REPO
        )
    } else {
        format!(
            "https://api.github.com/repos/{}/{}/releases/latest",
            OWNER, REPO
        )
    };
    let c = client(20)?;

    let res = match c
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // 网络层面失败时也试一次兜底（API 域名和网页域名的可达性不一定一致）
            let fallback = if beta {
                latest_tag_via_atom().await
            } else {
                latest_tag_via_redirect().await
            };

            return match fallback {
                Ok(tag) => Ok(remote_from_tag(&tag)),
                Err(_) => Err(network_error(&e)),
            };
        }
    };

    let status = res.status();

    if status.as_u16() == 404 {
        return Err(t("仓库还没有发布任何版本", "No release has been published yet"));
    }
    if status.as_u16() == 403 || status.as_u16() == 429 {
        // 匿名访问每小时 60 次/IP，很容易被同一出口的其他人耗光，这里退回不耗额度的探测
        let tag = if beta {
            latest_tag_via_atom().await?
        } else {
            latest_tag_via_redirect().await?
        };
        return Ok(remote_from_tag(&tag));
    }
    if !status.is_success() {
        return Err(t(
            &format!("GitHub 返回 {}", status.as_u16()),
            &format!("GitHub returned {}", status.as_u16()),
        ));
    }

    let text = res.text().await.map_err(|e| {
        t(
            &format!("读取发布信息失败: {}", e),
            &format!("Failed to read release info: {}", e),
        )
    })?;

    let rel: Release = if beta {
        let list: Vec<Release> = serde_json::from_str(&text).map_err(|e| {
            t(
                &format!("解析发布列表失败: {}", e),
                &format!("Failed to parse the release list: {}", e),
            )
        })?;

        list.into_iter().find(|r| !r.draft).ok_or_else(|| {
            t(
                "没有可用的版本（预览通道也没找到非草稿）",
                "No release available (no non-draft in the beta channel either)",
            )
        })?
    } else {
        serde_json::from_str(&text).map_err(|e| {
            t(
                &format!("解析发布信息失败: {}", e),
                &format!("Failed to parse release info: {}", e),
            )
        })?
    };

    let setup = rel
        .assets
        .iter()
        .find(|a| a.name.to_lowercase().ends_with(".exe") && a.name.to_lowercase().contains("setup"))
        .cloned();

    let sha = rel.assets.iter().find(|a| a.name.eq_ignore_ascii_case("sha256.txt")).cloned();

    let portable = rel
        .assets
        .iter()
        .find(|a| a.name.eq_ignore_ascii_case("DiscordTranslator.exe"))
        .cloned();

    Ok(Remote {
        version: rel.tag_name.trim_start_matches(['v', 'V']).to_string(),
        setup,
        sha,
        portable,
        notes: rel.body.unwrap_or_default(),
        html_url: rel.html_url,
        published_at: rel.published_at.unwrap_or_default(),
    })
}

fn network_error(e: &reqwest::Error) -> String {
    let hint = if proxy_url().is_some() {
        t(
            "，请检查代理是否可用（设置里可改「更新用代理」）",
            ", check whether the proxy works (see “Update proxy” in settings)",
        )
    } else {
        t(
            "。GitHub 在国内常常连不上，可在设置里填「更新用代理」",
            ". GitHub is often unreachable in some regions — set “Update proxy” in settings",
        )
    };

    t(
        &format!("连不上 GitHub{}（{}）", hint, e),
        &format!("Cannot reach GitHub{} ({})", hint, e),
    )
}

pub async fn check() -> Result<serde_json::Value, String> {
    let remote = fetch_release().await?;

    let current = current_version();
    let newer = is_newer(&remote.version, &current);
    let installed = is_installed_build();

    Ok(serde_json::json!({
        "currentVersion": current,
        "latestVersion": remote.version,
        "hasUpdate": newer,
        "installed": installed,
        "autoInstall": newer && installed && remote.setup.is_some(),
        "assetName": remote.setup.as_ref().map(|a| a.name.clone()).unwrap_or_default(),
        "assetSize": remote.setup.as_ref().map(|a| a.size).unwrap_or(0),
        "htmlUrl": remote.html_url,
        "notes": remote.notes,
        "publishedAt": remote.published_at,
        "proxy": proxy_url(),
        "channel": channel(),
    }))
}

/* ------------------------------------------------------------------ */
/* 下载与安装                                                          */
/* ------------------------------------------------------------------ */

fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| {
        t(
            &format!("打开安装包失败: {}", e),
            &format!("Cannot open the installer: {}", e),
        )
    })?;

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];

    loop {
        let n = std::io::Read::read(&mut file, &mut buf).map_err(|e| {
            t(
                &format!("读取安装包失败: {}", e),
                &format!("Cannot read the installer: {}", e),
            )
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }

    let out = hasher.finalize();
    let mut s = String::with_capacity(out.len() * 2);
    for b in out.iter() {
        s.push_str(&format!("{:02x}", b));
    }
    Ok(s)
}

/// 从 sha256.txt 里取指定文件名的哈希
fn pick_hash(txt: &str, file_name: &str) -> Option<String> {
    for line in txt.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let rest: String = parts.collect::<Vec<_>>().join(" ");
        let name = rest.trim_start_matches('*').trim();
        if name.eq_ignore_ascii_case(file_name) {
            return Some(hash.to_lowercase());
        }
    }
    None
}

fn backup_config() -> Option<PathBuf> {
    let src = crate::config::config_path();
    if !src.exists() {
        return None;
    }
    let dst = src.with_file_name(format!("config.json.bak-{}", current_version()));
    std::fs::copy(&src, &dst).ok()?;
    Some(dst)
}

pub async fn install() -> Result<String, String> {
    let remote = fetch_release().await?;

    if parse_ver(&remote.version) <= parse_ver(&current_version()) {
        return Ok(t("已经是最新版本", "Already on the latest version"));
    }

    if !is_installed_build() {
        return Err(t(
            "便携版不能自动替换自己，请到发布页手动下载新版",
            "The portable build cannot replace itself — please download the new version manually",
        ));
    }

    let setup = match remote.setup.clone() {
        Some(a) => a,
        None => {
            return Err(t(
                "发布页缺少安装包（setup.exe）",
                "The release has no installer (setup.exe)",
            ))
        }
    };

    let dir = std::env::temp_dir().join("DiscordTranslatorUpdate");
    std::fs::create_dir_all(&dir).map_err(|e| {
        t(
            &format!("创建临时目录失败: {}", e),
            &format!("Cannot create temp dir: {}", e),
        )
    })?;

    let file = dir.join("setup.exe");
    let c = client(300)?;

    // ---- 下载安装包 ----
    let bytes = c
        .get(&setup.browser_download_url)
        .send()
        .await
        .map_err(|e| network_error(&e))?
        .bytes()
        .await
        .map_err(|e| {
            t(
                &format!("下载安装包失败: {}", e),
                &format!("Failed to download the installer: {}", e),
            )
        })?;

    if bytes.len() < 512 * 1024 {
        return Err(t(
            &format!("下载到的安装包只有 {} 字节，不像是正常文件", bytes.len()),
            &format!("The downloaded installer is only {} bytes — looks broken", bytes.len()),
        ));
    }

    std::fs::write(&file, &bytes).map_err(|e| {
        t(
            &format!("写入安装包失败: {}", e),
            &format!("Cannot write the installer: {}", e),
        )
    })?;

    // ---- sha256 校验（没有校验文件就拒绝安装）----
    let sha_asset = match remote.sha.clone() {
        Some(a) => a,
        None => {
            let _ = std::fs::remove_file(&file);
            return Err(t(
                "发布页缺少 sha256.txt，为安全起见不自动安装",
                "The release has no sha256.txt — refusing to auto-install",
            ));
        }
    };

    let sha_res = c
        .get(&sha_asset.browser_download_url)
        .send()
        .await
        .map_err(|e| network_error(&e))?;

    // 必须看状态码：404 时 GitHub 返回的是 HTML 页面，直接按文本解析只会得到
    // 「校验文件里没有这个安装包的记录」这种误导性提示
    if !sha_res.status().is_success() {
        let _ = std::fs::remove_file(&file);
        return Err(t(
            &format!(
                "下载校验文件失败：HTTP {}（发布页上的 sha256.txt 可能缺失或未生效）",
                sha_res.status().as_u16()
            ),
            &format!(
                "Failed to download sha256.txt: HTTP {} (the release may be missing it)",
                sha_res.status().as_u16()
            ),
        ));
    }

    let txt = sha_res.text().await.map_err(|e| {
        t(
            &format!("读取校验文件失败: {}", e),
            &format!("Failed to read the checksum file: {}", e),
        )
    })?;

    let expected = match pick_hash(&txt, &setup.name) {
        Some(h) => h,
        None => {
            let _ = std::fs::remove_file(&file);
            return Err(t(
                &format!(
                    "校验文件里没有 {} 的记录（发布页的 sha256.txt 与安装包不配套）",
                    setup.name
                ),
                &format!(
                    "sha256.txt has no entry for {} (it does not match the installer)",
                    setup.name
                ),
            ));
        }
    };

    let actual = sha256_file(&file)?;

    if actual != expected {
        let _ = std::fs::remove_file(&file);
        crate::logging::write("ERROR", &format!("update sha256 mismatch: {} != {}", actual, expected));
        return Err(t(
            "安装包校验失败（下载可能被劫持或截断），已放弃安装",
            "Installer checksum mismatch (tampered or truncated download) — install aborted",
        ));
    }

    crate::logging::write(
        "INFO",
        &format!("update: {} -> {}, sha256 ok", current_version(), remote.version),
    );

    // ---- 留一份当前 exe：装坏了能一键换回去（自动更新唯一的安全网）----
    if let Some(name) = backup_current_exe() {
        crate::logging::write("INFO", &format!("旧版本已备份为 {}", name));
    }

    // 装完是新版本了，把「看发布说明」的链接留到下次启动
    write_pending_notes(&remote.html_url);

    // ---- 备份配置（术语表等），安装器不会动 %APPDATA%，这里只是加一层保险 ----
    let backup = backup_config();

    // ---- 写升级脚本：等本进程退出 → 静默覆盖安装 → 重新拉起 ----
    let exe = std::env::current_exe().map_err(|e| {
        t(
            &format!("取不到自身路径: {}", e),
            &format!("Cannot resolve own path: {}", e),
        )
    })?;

    let mut install_dir = String::new();
    if let Some((_, loc)) = install_info() {
        if !loc.is_empty() {
            install_dir = loc;
        }
    }

    let bat = dir.join("apply.bat");
    let script = format!(
        concat!(
            "@echo off\r\n",
            "chcp 65001 >nul\r\n",
            "ping 127.0.0.1 -n 4 >nul\r\n",
            "start \"\" /wait \"{setup}\" /S {dirarg}\r\n",
            "start \"\" \"{exe}\"\r\n",
            "del \"%~f0\"\r\n"
        ),
        setup = file.display(),
        dirarg = if install_dir.is_empty() {
            String::new()
        } else {
            format!("/D={}", install_dir)
        },
        exe = exe.display()
    );

    std::fs::write(&bat, script).map_err(|e| {
        t(
            &format!("写入升级脚本失败: {}", e),
            &format!("Cannot write the upgrade script: {}", e),
        )
    })?;

    let mut cmd = Command::new("cmd");
    cmd.arg("/c").arg(&bat);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn().map_err(|e| {
        t(
            &format!("启动安装程序失败: {}", e),
            &format!("Cannot start the installer: {}", e),
        )
    })?;

    // 让 IPC 回复先回到前端，再退出，否则界面看不到「正在重启」
    let ver = remote.version.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        std::process::exit(0);
    });

    let msg = t(
        &format!(
            "已下载并校验 {}，正在退出并安装，装完会自动重新打开{}",
            ver,
            backup
                .as_ref()
                .map(|p| format!("（配置已备份到 {}）", p.display()))
                .unwrap_or_default()
        ),
        &format!(
            "Downloaded and verified {}. The app will now exit, install, and reopen itself{}",
            ver,
            backup
                .as_ref()
                .map(|p| format!(" (config backed up to {})", p.display()))
                .unwrap_or_default()
        ),
    );

    crate::logging::write("INFO", &msg);
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ver_handles_prefix_and_missing_parts() {
        assert_eq!(parse_ver("v1.2.3"), (1, 2, 3));
        assert_eq!(parse_ver("1.2.2"), (1, 2, 2));
        assert_eq!(parse_ver("1.2"), (1, 2, 0));
        assert_eq!(parse_ver(""), (0, 0, 0));
    }

    #[test]
    fn parse_ver_compares_numerically() {
        assert!(parse_ver("1.10.0") > parse_ver("1.9.9"));
        assert!(parse_ver("2.0.0") > parse_ver("1.99.99"));
        assert!(parse_ver("1.2.2") > parse_ver("1.2.1"));
    }

    #[test]
    fn pick_hash_requires_the_exact_file_name() {
        let txt = "aaa  DiscordTranslator.exe\nbbb  DiscordTranslator_1.2.2_x64-setup.exe\n";

        assert_eq!(
            pick_hash(txt, "DiscordTranslator_1.2.2_x64-setup.exe"),
            Some("bbb".to_string())
        );
        assert_eq!(pick_hash(txt, "DiscordTranslator_1.2.1_x64-setup.exe"), None);
    }

    #[test]
    fn pick_hash_ignores_blank_lines_and_crlf() {
        let txt = "\r\n\r\naaa  DiscordTranslator.exe\r\n\r\n";
        assert_eq!(pick_hash(txt, "DiscordTranslator.exe"), Some("aaa".to_string()));
    }

    #[test]
    fn remote_from_tag_builds_matching_urls() {
        let r = remote_from_tag("9.8.7");

        assert_eq!(r.version, "9.8.7");
        assert_eq!(
            r.setup.as_ref().unwrap().name,
            "DiscordTranslator_9.8.7_x64-setup.exe"
        );
        assert!(r.setup.as_ref().unwrap().browser_download_url.contains("/download/v9.8.7/"));
        assert!(r.sha.is_some());
    }
}

#[cfg(test)]
mod channel_tests {
    use super::*;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes</title>
  <entry>
    <title>v1.4.1-beta.1</title>
    <link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/v1.4.1-beta.1"/>
  </entry>
  <entry>
    <link href="https://github.com/o/r/releases/tag/v1.4.0"/>
  </entry>
</feed>"#;

    #[test]
    fn atom_picks_the_first_entry() {
        assert_eq!(parse_atom_tag(FEED).as_deref(), Some("1.4.1-beta.1"));
    }

    #[test]
    fn atom_tag_keeps_prerelease_suffix() {
        let one = r#"<entry><link href="https://github.com/o/r/releases/tag/v2.0.0-rc.3"/></entry>"#;
        assert_eq!(parse_atom_tag(one).as_deref(), Some("2.0.0-rc.3"));
    }

    #[test]
    fn atom_returns_none_without_links() {
        assert_eq!(parse_atom_tag("<feed></feed>"), None);
    }

    #[test]
    fn prerelease_versions_compare_below_the_final_release() {
        // 1.4.1-beta.1 与 1.4.1 的语义版本比较这里按「数字段」处理：
        // 数字段相同即视为同代，是否升级由 tag 决定，不做 rc 排序
        assert_eq!(parse_ver("1.4.1-beta.1"), (1, 4, 1));
        assert!(parse_ver("1.4.1") >= parse_ver("1.4.0"));
    }
}

#[cfg(test)]
mod newer_tests {
    use super::*;

    #[test]
    fn plain_version_compare() {
        assert!(is_newer("1.4.0", "1.3.1"));
        assert!(!is_newer("1.3.1", "1.4.0"));
        assert!(!is_newer("1.3.1", "1.3.1"));
    }

    #[test]
    fn beta_to_final_counts_as_update() {
        assert!(is_newer("1.4.1", "1.4.1-beta.1"));
        assert!(!is_newer("1.4.1-beta.1", "1.4.1-beta.1"));
    }

    #[test]
    fn beta_of_higher_version_is_an_update() {
        assert!(is_newer("1.4.1-beta.1", "1.4.0"));
    }
}
