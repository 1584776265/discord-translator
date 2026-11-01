/**
 * 启动器配置。存放在 %APPDATA%\DiscordTranslator\config.json，
 * 与浏览器扩展的设置互相独立（扩展用 chrome.storage）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'DiscordTranslator');
const FILE = path.join(DIR, 'config.json');

const DEFAULTS = {
  // 调试端口。用随机端口可减少被本机其它程序扫到的概率
  cdpPort: 9223,

  // ---- 翻译设置 ----
  targetLang: 'zh-CN',
  provider: 'auto',
  display: 'below',
  fontSize: 13,
  skipSameLang: true,
  concurrency: 4,
  timeout: 20000,
  retries: 2,

  // ---- 可选的高级配置 ----
  openaiBase: 'https://api.deepseek.com/v1',
  openaiKey: '',
  openaiModel: 'deepseek-chat',
  googleEndpoint: '',
  libreUrl: '',
  libreKey: '',
  mymemoryEmail: '',
  caiyunToken: ''
};

let cache = null;

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function load() {
  if (cache) return cache;
  ensureDir();

  let disk = {};
  if (fs.existsSync(FILE)) {
    try {
      disk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.warn('[config] 配置文件解析失败，使用默认值: ' + e.message);
      disk = {};
    }
  }

  cache = Object.assign({}, DEFAULTS, disk);
  return cache;
}

function save(patch) {
  const cur = load();
  const next = Object.assign({}, cur, patch || {});
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}

function get(key) {
  return load()[key];
}

/** 取出传给 engine 的翻译参数 */
function getTranslationSettings() {
  const c = load();
  return {
    enabled: true,
    provider: c.provider,
    targetLang: c.targetLang,
    sourceLang: 'auto',
    skipSameLang: c.skipSameLang,
    display: c.display,
    fontSize: c.fontSize,
    concurrency: c.concurrency,
    timeout: c.timeout,
    retries: c.retries,
    openaiBase: c.openaiBase,
    openaiKey: c.openaiKey,
    openaiModel: c.openaiModel,
    googleEndpoint: c.googleEndpoint,
    libreUrl: c.libreUrl,
    libreKey: c.libreKey,
    mymemoryEmail: c.mymemoryEmail,
    caiyunToken: c.caiyunToken
  };
}

module.exports = { DEFAULTS, DIR, FILE, load, save, get, getTranslationSettings };
