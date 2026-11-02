//! 极简双语支持：中文是「原文」，英文是译文。
//!
//! 约定：代码里写中文，需要英文时用 `t("中文", "English")` 二选一。
//! 前端（app.js / index.html）用同一套思路：中文当 key 查英文字典。

use std::sync::RwLock;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

static LANG: RwLock<Option<String>> = RwLock::new(None);

/// 把配置里的 auto/zh/en 解析成实际的 zh 或 en
pub fn effective(cfg: &crate::config::Config) -> String {
    match cfg.language.as_str() {
        "en" => "en".into(),
        "zh" => "zh".into(),
        // auto：看系统 locale，非中文一律按英文处理
        _ => system_lang(),
    }
}

fn system_lang() -> String {
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Control Panel\\International") {
        if let Ok(name) = key.get_value::<String, _>("LocaleName") {
            return if name.to_lowercase().starts_with("zh") {
                "zh".into()
            } else {
                "en".into()
            };
        }
    }
    "zh".into()
}

/// 启动时与保存配置后调用，避免每条消息都去读一次 config.json
pub fn set_lang(lang: &str) {
    if let Ok(mut guard) = LANG.write() {
        *guard = Some(lang.to_string());
    }
}

pub fn current() -> String {
    if let Some(l) = LANG.read().ok().and_then(|g| g.clone()) {
        return l;
    }
    let l = effective(&crate::config::load());
    set_lang(&l);
    l
}

pub fn is_en() -> bool {
    current() == "en"
}

/// 二选一：当前是英文返回 en，否则 zh
pub fn t(zh: &str, en: &str) -> String {
    if is_en() {
        en.to_string()
    } else {
        zh.to_string()
    }
}
