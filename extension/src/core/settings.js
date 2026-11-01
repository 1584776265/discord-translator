/*!
 * Discord Translator — 设置模型与存储
 * 暴露 self.DTSettings
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'dt.settings';
  const CACHE_KEY = 'dt.cache';

  const DEFAULTS = {
    enabled: true,

    // 翻译服务商：auto | tencent | google | caiyun | mymemory | openai | libre
    provider: 'auto',
    targetLang: 'zh-CN',
    sourceLang: 'auto',

    // 已经是指定语言的消息不重复显示译文
    skipSameLang: true,

    // 显示模式：below（原文下方小字）/ replace（隐藏原文，只留译文）
    display: 'below',
    fontSize: 13,

    // 性能
    concurrency: 5,
    timeout: 20000,
    retries: 3,

    // Google
    googleEndpoint: 'https://translate.googleapis.com/translate_a/single',

    // OpenAI 兼容
    openaiBase: 'https://api.deepseek.com/v1',
    openaiKey: '',
    openaiModel: 'deepseek-chat',

    // LibreTranslate
    libreUrl: '',
    libreKey: ''
  };

  const PRESET_LANGS = [
    { code: 'zh-CN', label: '简体中文' },
    { code: 'zh-TW', label: '繁体中文' },
    { code: 'en', label: '英语 English' },
    { code: 'ja', label: '日语 日本語' },
    { code: 'ko', label: '韩语 한국어' },
    { code: 'ru', label: '俄语 Русский' },
    { code: 'fr', label: '法语 Français' },
    { code: 'de', label: '德语 Deutsch' },
    { code: 'es', label: '西班牙语 Español' },
    { code: 'pt', label: '葡萄牙语 Português' },
    { code: 'it', label: '意大利语 Italiano' },
    { code: 'tr', label: '土耳其语 Türkçe' },
    { code: 'ar', label: '阿拉伯语 العربية' },
    { code: 'th', label: '泰语 ไทย' },
    { code: 'vi', label: '越南语 Tiếng Việt' },
    { code: 'id', label: '印尼语 Indonesia' }
  ];

  function isExtStorage() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  }

  function merge(base, patch) {
    const out = Object.assign({}, base);
    if (patch && typeof patch === 'object') {
      for (const k of Object.keys(patch)) {
        if (patch[k] !== undefined) out[k] = patch[k];
      }
    }
    return out;
  }

  function load() {
    return new Promise((resolve) => {
      if (isExtStorage()) {
        chrome.storage.local.get([STORAGE_KEY], (obj) => {
          resolve(merge(DEFAULTS, obj && obj[STORAGE_KEY]));
        });
        return;
      }
      try {
        const raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
        resolve(merge(DEFAULTS, raw ? JSON.parse(raw) : null));
      } catch (e) {
        resolve(merge(DEFAULTS, null));
      }
    });
  }

  function save(settings) {
    return new Promise((resolve) => {
      const value = merge(DEFAULTS, settings);
      if (isExtStorage()) {
        chrome.storage.local.set({ [STORAGE_KEY]: value }, () => resolve(value));
        return;
      }
      try {
        root.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch (e) {
        /* ignore */
      }
      resolve(value);
    });
  }

  function loadCache() {
    return new Promise((resolve) => {
      if (isExtStorage()) {
        chrome.storage.local.get([CACHE_KEY], (obj) => resolve((obj && obj[CACHE_KEY]) || null));
        return;
      }
      try {
        const raw = root.localStorage && root.localStorage.getItem(CACHE_KEY);
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  function saveCache(entries) {
    return new Promise((resolve) => {
      if (isExtStorage()) {
        chrome.storage.local.set({ [CACHE_KEY]: entries }, () => resolve());
        return;
      }
      try {
        root.localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
      } catch (e) {
        /* ignore */
      }
      resolve();
    });
  }

  function clearCacheStorage() {
    return new Promise((resolve) => {
      if (isExtStorage()) {
        chrome.storage.local.remove([CACHE_KEY], () => resolve());
        return;
      }
      try {
        root.localStorage.removeItem(CACHE_KEY);
      } catch (e) {
        /* ignore */
      }
      resolve();
    });
  }

  const api = {
    STORAGE_KEY,
    CACHE_KEY,
    DEFAULTS,
    PRESET_LANGS,
    merge,
    load,
    save,
    loadCache,
    saveCache,
    clearCacheStorage
  };

  root.DTSettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
