use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlossaryEntry {
    pub from: String,
    pub to: String,
}

impl Default for GlossaryEntry {
    fn default() -> Self {
        Self {
            from: String::new(),
            to: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    // ---- 连接 ----
    pub cdp_port: u16,

    // ---- 翻译 ----
    pub target_lang: String,
    pub provider: String,
    pub display: String,
    pub font_size: u32,
    pub skip_same_lang: bool,
    pub concurrency: u32,
    pub timeout: u32,
    pub retries: u32,

    // ---- 各翻译源凭据 ----
    pub openai_base: String,
    pub openai_key: String,
    pub openai_model: String,
    pub google_endpoint: String,
    pub libre_url: String,
    pub libre_key: String,
    pub mymemory_email: String,
    pub caiyun_token: String,

    // ---- 用量控制 ----
    pub daily_request_limit: i64,

    // ---- 范围控制 ----
    /// 为空表示不启用白名单，所有频道都翻译
    pub channel_whitelist: Vec<String>,
    /// 命中这些用户名/ID 的消息不翻译
    pub user_blacklist: Vec<String>,

    // ---- 术语表 ----
    pub glossary: Vec<GlossaryEntry>,

    // ---- 发送前翻译 ----
    /// 启用 Alt+Enter 翻译输入框内容
    pub composer_translate: bool,
    /// 翻译后直接发送（默认关，先让人看一眼）
    pub composer_auto_send: bool,
    /// 发出去的内容翻成什么语言
    pub outgoing_lang: String,

    // ---- 界面 ----
    /// system | dark | light
    pub theme: String,
    /// stable | ptb | canary
    pub channel: String,

    // ---- 行为 ----
    pub autostart: bool,
    pub minimize_to_tray: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            cdp_port: 9223,
            target_lang: "zh-CN".into(),
            provider: "auto".into(),
            display: "below".into(),
            font_size: 13,
            skip_same_lang: true,
            concurrency: 4,
            timeout: 20000,
            retries: 2,
            openai_base: "https://api.deepseek.com/v1".into(),
            openai_key: String::new(),
            openai_model: "deepseek-chat".into(),
            google_endpoint: String::new(),
            libre_url: String::new(),
            libre_key: String::new(),
            mymemory_email: String::new(),
            caiyun_token: String::new(),
            daily_request_limit: 0,
            channel_whitelist: Vec::new(),
            user_blacklist: Vec::new(),
            glossary: Vec::new(),
            composer_translate: true,
            composer_auto_send: false,
            outgoing_lang: "en".into(),
            theme: "system".into(),
            channel: "stable".into(),
            autostart: false,
            minimize_to_tray: true,
        }
    }
}

pub fn app_data_dir() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(base).join("DiscordTranslator");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn config_path() -> PathBuf {
    app_data_dir().join("config.json")
}

pub fn log_path() -> PathBuf {
    let dir = app_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("app.log")
}

pub fn load() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            crate::logging::write("WARN", &format!("config.json 解析失败({})，使用默认值", e));
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

pub fn save(cfg: &Config) -> Result<(), String> {
    let path = config_path();
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写入配置失败: {}", e))
}
