/**
 * @name DiscordTranslator
 * @author 1584776265
 * @version 1.0.0
 * @description 自动翻译 Discord 中的英文与其他语言消息，译文以小字显示在原文下方。支持 Google / OpenAI 兼容（DeepSeek、Ollama、OneAPI）/ LibreTranslate。
 * @source https://github.com/1584776265
 */

(function (module, exports, require) {
/*!
 * Discord Translator — 翻译引擎
 * 同时被 MV3 background service worker 与 BetterDiscord 插件复用。
 * 暴露 self.DTEngine
 *
 * 支持的翻译源：
 *   tencent  腾讯交互翻译（国内直连，默认首选，支持批量）
 *   google   Google 翻译（质量最好，需要能访问 Google）
 *   caiyun   彩云小译
 *   mymemory MyMemory（免费兜底，几乎不会被墙）
 *   openai   OpenAI 兼容接口（DeepSeek / Ollama / OneAPI …）
 *   libre    LibreTranslate 自建
 *   auto     依次尝试上面的免费源，自动降级
 */
(function (root) {
  'use strict';

  const DEFAULT_GOOGLE = 'https://translate.googleapis.com/translate_a/single';
  const TENCENT_URL = 'https://transmart.qq.com/api/imt';
  const TENCENT_CLIENT_KEY = 'browser-chrome-131.0.0-Windows_10-undefined';
  const CAIYUN_URL = 'https://api.interpreter.caiyunai.com/v1/translator';
  const CAIYUN_TOKEN = '3975l6lr5pcbvidl6jl2';
  const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

  const LANG_NAMES = {
    'zh-CN': '简体中文',
    'zh-TW': '繁体中文',
    'zh-HK': '繁体中文',
    zh: '中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    ru: '俄语',
    fr: '法语',
    de: '德语',
    es: '西班牙语',
    pt: '葡萄牙语',
    it: '意大利语',
    ar: '阿拉伯语',
    th: '泰语',
    vi: '越南语',
    id: '印尼语',
    ms: '马来语',
    tr: '土耳其语',
    pl: '波兰语',
    nl: '荷兰语',
    uk: '乌克兰语',
    hi: '印地语',
    sv: '瑞典语',
    fi: '芬兰语',
    da: '丹麦语',
    cs: '捷克语',
    el: '希腊语',
    he: '希伯来语',
    fa: '波斯语',
    ro: '罗马尼亚语',
    hu: '匈牙利语',
    bg: '保加利亚语',
    auto: '自动检测'
  };

  /* ================================================================== */
  /* 工具                                                                */
  /* ================================================================== */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function langName(code) {
    if (!code) return '';
    const c = String(code);
    return LANG_NAMES[c] || LANG_NAMES[c.toLowerCase()] || LANG_NAMES[c.split('-')[0].toLowerCase()] || c;
  }

  function baseLang(code) {
    return String(code || '').toLowerCase().split('-')[0];
  }

  function isSameLang(detected, target) {
    if (!detected || !target) return false;
    const d = baseLang(detected);
    const t = baseLang(target);
    if (d === t) return true;
    // 繁体 / 简体 视作不同语言，允许互转由用户决定；这里仍判为同语种
    return false;
  }

  function makeError(message, status) {
    const err = new Error(message);
    if (status) err.status = status;
    return err;
  }

  function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max);
  }

  /* ================================================================== */
  /* 本地语种检测（Unicode script）                                       */
  /* ================================================================== */

  const RE_HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  const RE_HAN_ALL = /^[\u4e00-\u9fff\u3400-\u4dbf\s\p{P}\p{S}\p{N}]+$/u;
  const RE_KANA = /[\u3040-\u309f\u30a0-\u30ff]/;
  const RE_HANGUL = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
  const RE_CYRIL = /[\u0400-\u04ff]/;
  const RE_ARABIC = /[\u0600-\u06ff\u0750-\u077f]/;
  const RE_THAI = /[\u0e00-\u0e7f]/;
  const RE_HEBREW = /[\u0590-\u05ff]/;
  const RE_GREEK = /[\u0370-\u03ff]/;
  const RE_DEVANAGARI = /[\u0900-\u097f]/;
  const RE_LATIN = /[A-Za-z\u00c0-\u024f]/;

  const LATIN_HINTS = {
    en: ['the', 'and', 'you', 'is', 'are', 'to', 'of', 'what', 'how', 'this', 'that', 'with', 'for', 'have', 'not', 'was', 'but', 'they', 'from', 'been', 'just'],
    fr: ['le', 'la', 'les', 'est', 'vous', 'que', 'pas', 'pour', 'avec', 'dans', 'une', 'des', 'je', 'ne', 'sur', 'mais', 'nous', 'cette', 'qui'],
    de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'sie', 'mit', 'für', 'ein', 'eine', 'ich', 'zu', 'auf', 'sich', 'auch', 'aber', 'wird'],
    es: ['el', 'la', 'los', 'es', 'que', 'por', 'para', 'con', 'una', 'pero', 'como', 'más', 'este', 'esta', 'muy', 'pero', 'está'],
    pt: ['que', 'para', 'com', 'uma', 'não', 'mais', 'este', 'esta', 'muito', 'como', 'dos', 'das', 'você', 'isso'],
    it: ['il', 'gli', 'che', 'per', 'con', 'una', 'non', 'più', 'questo', 'questa', 'sono', 'anche', 'della', 'molto'],
    nl: ['het', 'een', 'niet', 'van', 'dat', 'met', 'voor', 'zijn', 'maar', 'ook', 'deze', 'wordt'],
    tr: ['bir', 've', 'bu', 'için', 'ile', 'çok', 'daha', 'ama', 'değil', 'olarak'],
    id: ['yang', 'dan', 'ini', 'itu', 'untuk', 'dengan', 'tidak', 'saya', 'kami', 'dari', 'akan'],
    vi: ['và', 'của', 'là', 'không', 'được', 'này', 'cho', 'với', 'những', 'người']
  };

  function tokens(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^\p{L}\s']/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);
  }

  function detectLatin(text) {
    const words = tokens(text);
    if (words.length === 0) return 'en';
    const bag = new Set(words);
    let best = 'en';
    let bestScore = 0;
    for (const code of Object.keys(LATIN_HINTS)) {
      let score = 0;
      for (const hint of LATIN_HINTS[code]) {
        if (bag.has(hint)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        best = code;
      }
    }
    // 有重音符号的辅助判断
    if (bestScore === 0) {
      if (/[ñ¿¡]/i.test(text)) return 'es';
      if (/[ãõç]/i.test(text) && !/[àèù]/i.test(text)) return 'pt';
      if (/[äöüß]/i.test(text)) return 'de';
      if (/[àâçéèêëîïôûùüÿœ]/i.test(text)) return 'fr';
    }
    return best;
  }

  /**
   * 粗略检测一句话的语种，返回 ISO 639-1 代码。
   * 只用于分组批量翻译，不追求学术精度。
   */
  function detectScript(text) {
    if (!text) return '';
    const sample = text.slice(0, 400);
    if (RE_KANA.test(sample)) return 'ja';
    if (RE_HANGUL.test(sample)) return 'ko';
    if (RE_CYRIL.test(sample)) return 'ru';
    if (RE_ARABIC.test(sample)) return 'ar';
    if (RE_THAI.test(sample)) return 'th';
    if (RE_HEBREW.test(sample)) return 'he';
    if (RE_GREEK.test(sample)) return 'el';
    if (RE_DEVANAGARI.test(sample)) return 'hi';
    if (RE_HAN.test(sample)) return 'zh';
    if (RE_LATIN.test(sample)) return detectLatin(sample);
    return '';
  }

  /* ================================================================== */
  /* 缓存                                                                */
  /* ================================================================== */

  const CACHE_MAX = 4000;
  const memCache = new Map();

  function cacheKey(text, s) {
    return [s.provider || 'auto', s.sourceLang || 'auto', s.targetLang, text].join('\u0001');
  }

  function cacheGet(text, s) {
    const k = cacheKey(text, s);
    if (!memCache.has(k)) return null;
    const v = memCache.get(k);
    memCache.delete(k);
    memCache.set(k, v);
    return v;
  }

  function cacheSet(text, s, value) {
    const k = cacheKey(text, s);
    if (memCache.has(k)) memCache.delete(k);
    memCache.set(k, value);
    while (memCache.size > CACHE_MAX) {
      const first = memCache.keys().next().value;
      memCache.delete(first);
    }
  }

  function exportCache() {
    return Array.from(memCache.entries());
  }

  function importCache(entries) {
    if (!Array.isArray(entries)) return;
    for (const pair of entries) {
      if (Array.isArray(pair) && typeof pair[0] === 'string') memCache.set(pair[0], pair[1]);
    }
  }

  function clearCache() {
    memCache.clear();
  }

  function cacheStats() {
    return { size: memCache.size, max: CACHE_MAX };
  }

  /* ================================================================== */
  /* HTTP                                                                */
  /* ================================================================== */

  /**
   * 挑选可用的网络通道。
   *
   * 在 BetterDiscord / Vencord 这类客户端 mod 里，代码跑在 Discord 的渲染进程中，
   * 页面 CSP 的 connect-src 只放行 discord.com，直接 fetch 第三方翻译接口会被拦截。
   * 必须改走宿主提供的通道（BdApi.Net.fetch 走 Electron 主进程，不受 CSP 约束）。
   */
  function pickFetcher() {
    if (root.BdApi && root.BdApi.Net && typeof root.BdApi.Net.fetch === 'function') {
      return { fn: root.BdApi.Net.fetch.bind(root.BdApi.Net), viaHost: true, name: 'BdApi.Net' };
    }
    if (typeof fetch === 'function') {
      return { fn: fetch, viaHost: false, name: 'fetch' };
    }
    return null;
  }

  function networkInfo() {
    const f = pickFetcher();
    return f ? f.name : 'none';
  }

  async function rawFetch(url, init, timeoutMs) {
    const f = pickFetcher();
    if (!f) throw makeError('当前环境不支持网络请求');

    const ms = timeoutMs || 20000;
    const canAbort = !f.viaHost && typeof AbortController === 'function';
    const ctrl = canAbort ? new AbortController() : null;

    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (ctrl) {
          try {
            ctrl.abort();
          } catch (_) {
            /* ignore */
          }
        }
        reject(makeError('请求超时'));
      }, ms);
    });

    const opts = Object.assign({}, init);
    if (f.viaHost) {
      // Electron net 不认这些 Web 专有字段
      delete opts.credentials;
      delete opts.cache;
      delete opts.signal;
    } else {
      opts.credentials = 'omit';
      opts.cache = 'no-store';
      opts.redirect = 'follow';
      if (ctrl) opts.signal = ctrl.signal;
    }

    const request = f.fn(url, opts);
    // 超时后原请求可能仍会 reject，避免 unhandled rejection
    if (request && typeof request.catch === 'function') request.catch(() => {});

    try {
      return await Promise.race([request, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchJSON(url, init, timeoutMs) {
    const res = await rawFetch(url, init, timeoutMs);
    const status = res && typeof res.status === 'number' ? res.status : 200;

    // 部分宿主返回 status=0 表示"已完成但无 HTTP 状态行"，按成功处理
    if (status !== 0 && (status < 200 || status >= 300)) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 160);
      } catch (_) {
        /* ignore */
      }
      throw makeError('HTTP ' + status + (detail ? ': ' + detail : ''), status);
    }

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      throw makeError('响应不是 JSON：' + text.slice(0, 100));
    }
  }

  async function withRetry(fn, attempts) {
    const max = attempts || 3;
    let last;
    for (let i = 0; i < max; i++) {
      try {
        return await fn(i);
      } catch (e) {
        last = e;
        const status = e && e.status;
        const retryable = !status || status === 429 || status === 408 || status >= 500;
        if (!retryable || i === max - 1) break;
        await sleep(400 * Math.pow(2, i) + Math.random() * 200);
      }
    }
    throw last;
  }

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    const size = Math.max(1, Math.min(limit || 4, items.length));
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < size; w++) {
      workers.push(
        (async () => {
          for (;;) {
            const idx = cursor++;
            if (idx >= items.length) return;
            results[idx] = await fn(items[idx], idx);
          }
        })()
      );
    }
    await Promise.all(workers);
    return results;
  }

  /* ================================================================== */
  /* 翻译源：腾讯交互翻译（批量）                                          */
  /* ================================================================== */

  const TENCENT_SUPPORTED = new Set(['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt', 'it', 'tr', 'ar', 'th', 'vi', 'id']);

  function toTencentLang(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'zh-cn' || c === 'zh-hans' || c === 'zh') return 'zh';
    if (c === 'zh-tw' || c === 'zh-hk' || c === 'zh-hant') return 'zh-TW';
    return c.split('-')[0];
  }

  async function tencentRequest(items, sourceLang, targetLang, s) {
    const body = {
      header: { fn: 'auto_translation', client_key: TENCENT_CLIENT_KEY },
      type: 'text',
      model_category: 'normal',
      source: { lang: sourceLang, text_list: items.map((x) => truncate(x, 1800)) },
      target: { lang: targetLang }
    };

    const data = await fetchJSON(
      TENCENT_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://transmart.qq.com/zh-CN/index'
        },
        body: JSON.stringify(body)
      },
      s.timeout || 25000
    );

    if (!data || !Array.isArray(data.auto_translation)) {
      const code = data && data.header && data.header.ret_code;
      throw makeError('腾讯翻译无结果' + (code ? '（' + code + '）' : ''));
    }
    if (data.auto_translation.length !== items.length) {
      throw makeError('腾讯翻译返回条数不匹配');
    }
    return { list: data.auto_translation, detected: data.src_lang || sourceLang };
  }

  async function tencentTranslate(texts, s) {
    const target = toTencentLang(s.targetLang);
    const groups = new Map();
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
      let lang = detectScript(texts[i]);
      if (s.sourceLang && s.sourceLang !== 'auto') lang = toTencentLang(s.sourceLang);
      if (!lang) lang = 'en';
      if (!TENCENT_SUPPORTED.has(lang)) {
        // 交给下一个翻译源处理，别硬塞成英语
        results[i] = { ok: false, error: '腾讯不支持源语言 ' + lang };
        continue;
      }
      if (!groups.has(lang)) groups.set(lang, []);
      groups.get(lang).push(i);
    }

    const jobs = [];

    for (const [lang, indexes] of groups.entries()) {
      const parts = chunkArray(indexes, 40);
      for (const part of parts) {
        jobs.push({ lang, indexes: part });
      }
    }

    await mapLimit(jobs, s.concurrency || 4, async (job) => {
      const payload = job.indexes.map((i) => texts[i]);
      let out;
      try {
        out = await withRetry(() => tencentRequest(payload, job.lang, target, s), s.retries || 2);
      } catch (e) {
        job.indexes.forEach((i) => {
          results[i] = { ok: false, error: String((e && e.message) || e) };
        });
        return;
      }
      job.indexes.forEach((originalIndex, k) => {
        const t = out.list[k];
        results[originalIndex] = {
          ok: true,
          text: String(t == null ? '' : t).trim(),
          detected: out.detected || job.lang
        };
      });
    });

    return results;
  }

  /* ================================================================== */
  /* 翻译源：Google                                                      */
  /* ================================================================== */

  async function googleTranslateOne(text, s) {
    const endpoint = (s.googleEndpoint || DEFAULT_GOOGLE).trim() || DEFAULT_GOOGLE;
    const u = new URL(endpoint);
    u.searchParams.set('client', 'gtx');
    u.searchParams.set('sl', s.sourceLang && s.sourceLang !== 'auto' ? s.sourceLang : 'auto');
    u.searchParams.set('tl', s.targetLang);
    u.searchParams.set('dt', 't');
    u.searchParams.set('dj', '1');
    u.searchParams.set('q', text);

    // Google 不通时不要拖住整条降级链
    const data = await fetchJSON(u.toString(), { method: 'GET' }, Math.min(s.timeout || 20000, 8000));

    if (data && Array.isArray(data.sentences)) {
      const out = data.sentences.map((seg) => (seg && seg.trans) || '').join('').trim();
      return { ok: true, text: out, detected: data.src || '' };
    }
    if (Array.isArray(data) && Array.isArray(data[0])) {
      const out = data[0].map((seg) => (seg && seg[0]) || '').join('').trim();
      return { ok: true, text: out, detected: data[2] || '' };
    }
    throw makeError('无法解析 Google 翻译响应');
  }

  async function googleTranslate(texts, s) {
    return mapLimit(texts, s.concurrency || 4, async (text) => {
      try {
        // Google 在墙内是直接超时，重试只会拖长时间，所以只试一次
        const r = await withRetry(() => googleTranslateOne(text, s), 1);
        return r;
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
  }

  /* ================================================================== */
  /* 翻译源：彩云小译                                                     */
  /* ================================================================== */

  const CAIYUN_PAIRS = new Set(['zh', 'en', 'ja', 'ko']);

  function toCaiyunType(src, tgt) {
    const from = CAIYUN_PAIRS.has(src) ? src : 'en';
    const to = CAIYUN_PAIRS.has(tgt) ? tgt : 'zh';
    return from + '2' + to;
  }

  async function caiyunTranslate(texts, s) {
    const target = baseLang(s.targetLang);
    const groups = new Map();
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i++) {
      let lang = detectScript(texts[i]);
      if (!lang) lang = 'en';
      if (!CAIYUN_PAIRS.has(lang)) {
        results[i] = { ok: false, error: '彩云不支持源语言 ' + lang };
        continue;
      }
      if (!groups.has(lang)) groups.set(lang, []);
      groups.get(lang).push(i);
    }

    const jobs = [];
    for (const [lang, indexes] of groups.entries()) {
      for (const part of chunkArray(indexes, 20)) jobs.push({ lang, indexes: part });
    }

    await mapLimit(jobs, Math.min(s.concurrency || 4, 3), async (job) => {
      const payload = job.indexes.map((i) => truncate(texts[i], 4000));
      try {
        const data = await withRetry(
          () =>
            fetchJSON(
              CAIYUN_URL,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-authorization': 'token ' + (s.caiyunToken || CAIYUN_TOKEN)
                },
                body: JSON.stringify({
                  source: payload,
                  trans_type: toCaiyunType(job.lang, target),
                  request_id: 'dt-' + Date.now(),
                  detect: true
                })
              },
              s.timeout || 25000
            ),
          s.retries || 2
        );

        if (!data || !Array.isArray(data.target) || data.target.length !== job.indexes.length) {
          throw makeError('彩云返回异常');
        }
        job.indexes.forEach((originalIndex, k) => {
          results[originalIndex] = {
            ok: true,
            text: String(data.target[k] == null ? '' : data.target[k]).trim(),
            detected: data.src_lang || job.lang
          };
        });
      } catch (e) {
        job.indexes.forEach((i) => {
          results[i] = { ok: false, error: String((e && e.message) || e) };
        });
      }
    });

    return results;
  }

  /* ================================================================== */
  /* 翻译源：MyMemory（兜底，任意语言对）                                  */
  /* ================================================================== */

  function mapMyMemoryLang(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'zh-cn' || c === 'zh' || c === 'zh-hans') return 'zh-CN';
    if (c === 'zh-tw' || c === 'zh-hant' || c === 'zh-hk') return 'zh-TW';
    return c.split('-')[0];
  }

  function splitByLength(text, max) {
    if (text.length <= max) return [text];
    const out = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) out.push(rest);
    return out;
  }

  async function mymemoryTranslateOne(text, s) {
    const src = s.sourceLang && s.sourceLang !== 'auto' ? baseLang(s.sourceLang) : detectScript(text) || 'en';
    const tgt = mapMyMemoryLang(s.targetLang);
    const parts = splitByLength(text, 420);
    const out = [];
    let detected = '';

    for (const part of parts) {
      const url =
        MYMEMORY_URL +
        '?q=' +
        encodeURIComponent(part) +
        '&langpair=' +
        encodeURIComponent(src + '|' + tgt) +
        (s.mymemoryEmail ? '&de=' + encodeURIComponent(s.mymemoryEmail) : '');
      const data = await fetchJSON(url, { method: 'GET' }, s.timeout || 20000);
      const text2 = data && data.responseData && data.responseData.translatedText;
      if (!text2) throw makeError('MyMemory 返回空');
      if (/^MYMEMORY WARNING/i.test(text2)) throw makeError(text2.slice(0, 80));
      out.push(text2);
      if (!detected && data.responseData.detectedLanguage) detected = data.responseData.detectedLanguage;
    }

    return { ok: true, text: out.join(' ').trim(), detected: detected || src };
  }

  async function mymemoryTranslate(texts, s) {
    return mapLimit(texts, Math.min(s.concurrency || 4, 3), async (text) => {
      try {
        return await withRetry(() => mymemoryTranslateOne(text, s), s.retries || 2);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
  }

  /* ================================================================== */
  /* 翻译源：OpenAI 兼容                                                  */
  /* ================================================================== */

  const OPENAI_SYSTEM = (langStr) =>
    [
      '你是一个翻译引擎，不是助手。',
      '把用户给出的每一条「编号行」翻译成' + langStr + '。',
      '严格规则：',
      '1. 原样保留行首的 [数字] 前缀，输出行数必须与输入行数完全一致，不得合并或拆分。',
      '2. 只输出译文行，禁止任何解释、前言、注释、代码块围栏。',
      '3. 保留原文中的 @提及、#频道、URL、`代码`、表情符号、Markdown 符号。',
      '4. 如果某条本身已经是' + langStr + '，原样输出该条。',
      '5. 不要翻译专有名词、游戏 ID、用户名。'
    ].join('\n');

  function parseNumbered(text) {
    const map = new Map();
    let current = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const m = raw.match(/^\s*\[(\d+)\]\s*(.*)$/);
      if (m) {
        current = parseInt(m[1], 10);
        map.set(current, m[2]);
      } else if (current !== null && raw.trim() !== '') {
        map.set(current, (map.get(current) || '') + '\n' + raw);
      }
    }
    return map;
  }

  async function openaiTranslateBatch(texts, s) {
    const base = (s.openaiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = base + '/chat/completions';
    const langStr = langName(s.targetLang) || s.targetLang;

    const userContent = texts
      .map((t, i) => '[' + (i + 1) + '] ' + String(t).replace(/\r?\n/g, ' ⏎ '))
      .join('\n');

    const payload = {
      model: s.openaiModel || 'gpt-4o-mini',
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: OPENAI_SYSTEM(langStr) },
        { role: 'user', content: userContent }
      ]
    };

    const headers = { 'Content-Type': 'application/json' };
    if (s.openaiKey) headers['Authorization'] = 'Bearer ' + s.openaiKey;

    const data = await fetchJSON(
      url,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      s.timeout || 60000
    );

    const content =
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    if (!content) throw makeError('模型返回空内容');

    const parsed = parseNumbered(content);
    return texts.map((orig, i) => {
      const translated = parsed.get(i + 1);
      if (!translated) return { ok: false, error: '模型漏译第 ' + (i + 1) + ' 条' };
      return { ok: true, text: translated.replace(/ ⏎ /g, '\n').trim(), detected: detectScript(orig) };
    });
  }

  async function openaiTranslate(texts, s) {
    const results = new Array(texts.length);
    for (const part of chunkArray(
      texts.map((t, i) => i),
      25
    )) {
      const payload = part.map((i) => texts[i]);
      try {
        const r = await withRetry(() => openaiTranslateBatch(payload, s), s.retries || 2);
        part.forEach((originalIndex, k) => {
          results[originalIndex] = r[k];
        });
      } catch (e) {
        part.forEach((i) => {
          results[i] = { ok: false, error: String((e && e.message) || e) };
        });
      }
    }
    return results;
  }

  /* ================================================================== */
  /* 翻译源：LibreTranslate                                              */
  /* ================================================================== */

  async function libreTranslateOne(text, s) {
    const base = (s.libreUrl || '').replace(/\/+$/, '');
    if (!base) throw makeError('未配置 LibreTranslate 地址');
    const body = {
      q: text,
      source: s.sourceLang && s.sourceLang !== 'auto' ? baseLang(s.sourceLang) : 'auto',
      target: baseLang(s.targetLang),
      format: 'text'
    };
    if (s.libreKey) body.api_key = s.libreKey;

    const data = await fetchJSON(
      base + '/translate',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      s.timeout || 30000
    );
    const out = (data && (data.translatedText || data.translation)) || '';
    if (!out) throw makeError('LibreTranslate 返回空');
    const det = data && data.detectedLanguage;
    return { ok: true, text: String(out).trim(), detected: (det && (det.language || det)) || '' };
  }

  async function libreTranslate(texts, s) {
    return mapLimit(texts, Math.min(s.concurrency || 4, 3), async (text) => {
      try {
        return await withRetry(() => libreTranslateOne(text, s), s.retries || 2);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    });
  }

  /* ================================================================== */
  /* 调度                                                                */
  /* ================================================================== */

  const PROVIDERS = {
    tencent: tencentTranslate,
    google: googleTranslate,
    caiyun: caiyunTranslate,
    mymemory: mymemoryTranslate,
    openai: openaiTranslate,
    libre: libreTranslate
  };

  // auto 模式的降级顺序：国内直连的排前面，Google 放最后（不通时会长时间超时）
  // mymemory 排在 caiyun 之前，因为彩云用的公开 demo token 经常被限流
  const AUTO_CHAIN = ['tencent', 'mymemory', 'caiyun', 'google'];

  const providerHealth = {
    // name: { fails: number, cooldownUntil: number }
  };

  function isCoolingDown(name) {
    const h = providerHealth[name];
    return !!(h && h.cooldownUntil && h.cooldownUntil > Date.now());
  }

  function markFail(name) {
    const h = providerHealth[name] || (providerHealth[name] = { fails: 0, cooldownUntil: 0 });
    h.fails++;
    if (h.fails >= 2) {
      h.cooldownUntil = Date.now() + Math.min(5 * 60 * 1000, 30000 * Math.pow(2, h.fails - 2));
    }
  }

  function markOk(name) {
    providerHealth[name] = { fails: 0, cooldownUntil: 0 };
  }

  async function runProvider(name, texts, s) {
    const fn = PROVIDERS[name];
    if (!fn) return texts.map(() => ({ ok: false, error: '未知翻译源 ' + name }));
    const started = Date.now();
    const results = await fn(texts, s);
    const anyOk = results.some((r) => r && r.ok && r.text);
    if (anyOk) markOk(name);
    else markFail(name);
    return results.map((r) => Object.assign({ provider: name, ms: Date.now() - started }, r));
  }

  async function autoTranslate(texts, s) {
    let chain = AUTO_CHAIN.filter((n) => !isCoolingDown(n));
    if (chain.length === 0) chain = AUTO_CHAIN.slice();

    const results = new Array(texts.length).fill(null);
    let remaining = texts.map((_, i) => i);
    let lastError = '';

    for (const name of chain) {
      if (remaining.length === 0) break;

      const payload = remaining.map((i) => texts[i]);
      let out;
      try {
        out = await runProvider(name, payload, s);
      } catch (e) {
        lastError = String((e && e.message) || e);
        markFail(name);
        continue;
      }

      const stillMissing = [];
      remaining.forEach((originalIndex, k) => {
        const r = out[k];
        if (r && r.ok && r.text) {
          results[originalIndex] = r;
        } else {
          if (r && r.error) lastError = r.error;
          stillMissing.push(originalIndex);
        }
      });
      remaining = stillMissing;
    }

    for (const i of remaining) {
      if (!results[i]) results[i] = { ok: false, error: lastError || '所有翻译源均不可用' };
    }

    return results;
  }

  /* ================================================================== */
  /* 对外 API                                                            */
  /* ================================================================== */

  async function translate(texts, settings) {
    const s = settings || {};
    if (!Array.isArray(texts) || texts.length === 0) return [];
    if (!s.targetLang) throw makeError('未设置目标语言');

    const results = new Array(texts.length);
    const todo = [];

    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t || !t.trim()) {
        results[i] = { ok: true, text: '', detected: '', cached: true };
        continue;
      }
      const hit = cacheGet(t, s);
      if (hit) results[i] = Object.assign({}, hit, { cached: true });
      else todo.push(i);
    }

    if (todo.length === 0) return results;

    const todoTexts = todo.map((i) => texts[i]);
    const provider = s.provider || 'auto';

    let out;
    if (provider === 'auto') {
      out = await autoTranslate(todoTexts, s);
    } else {
      out = await runProvider(provider, todoTexts, s);
    }

    todo.forEach((originalIndex, k) => {
      const r = out[k] || { ok: false, error: '无结果' };
      results[originalIndex] = r;
      if (r.ok && r.text) cacheSet(texts[originalIndex], s, r);
    });

    return results;
  }

  async function translateOne(text, settings) {
    const [r] = await translate([text], settings);
    return r;
  }

  async function test(settings) {
    const started = Date.now();
    const probe = 'Hello, this is a connectivity test.';
    const out = await translate([probe], Object.assign({}, settings, { provider: settings.provider || 'auto' })).catch(
      (e) => [{ ok: false, error: String((e && e.message) || e) }]
    );
    const r = out[0] || {};
    return {
      ok: !!(r.ok && r.text),
      text: r.text || '',
      detected: r.detected || '',
      provider: r.provider || settings.provider || 'auto',
      error: r.error || '',
      ms: Date.now() - started
    };
  }

  /** 各翻译源连通性体检 */
  async function diagnose(settings) {
    const s = Object.assign({}, settings);
    const out = [];
    for (const name of ['tencent', 'google', 'caiyun', 'mymemory']) {
      const t0 = Date.now();
      try {
        const r = await PROVIDERS[name](['Hello there'], s);
        const ok = !!(r[0] && r[0].ok && r[0].text);
        out.push({ provider: name, ok, ms: Date.now() - t0, text: (r[0] && r[0].text) || '', error: (r[0] && r[0].error) || '' });
      } catch (e) {
        out.push({ provider: name, ok: false, ms: Date.now() - t0, text: '', error: String((e && e.message) || e) });
      }
    }
    return out;
  }

  const api = {
    translate,
    translateOne,
    test,
    diagnose,
    detectScript,
    isSameLang,
    langName,
    exportCache,
    importCache,
    clearCache,
    cacheStats,
    networkInfo,
    LANG_NAMES,
    PROVIDERS,
    AUTO_CHAIN
  };

  root.DTEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);

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

/*!
 * Discord Translator — DOM 适配层
 * 负责：扫描消息 / 提取文本 / 排队翻译 / 插入译文 / 跟随 Discord 虚拟列表更新
 * 暴露 self.DTDom
 */
(function (root) {
  'use strict';

  const NS = 'dt';

  const SEL = {
    listItem: 'li[id^="chat-messages-"]',
    content: '[id^="message-content-"]',
    replied: '[class*="repliedMessage_"]',
    username: '[class*="username_"]',
    timestamp: 'time[datetime]',
    toolbar: '[class*="messageButtons_"], [class*="buttons_"]'
  };

  const SKIP_TAGS = {
    PRE: 1,
    CODE: 1,
    SCRIPT: 1,
    STYLE: 1,
    VIDEO: 1,
    AUDIO: 1,
    CANVAS: 1,
    SVG: 1,
    BUTTON: 1,
    TEXTAREA: 1
  };

  let bridge = null;
  let settings = {};
  let observer = null;
  let scanTimer = null;
  let running = false;
  let debugMode = false;

  function dbg() {
    if (!debugMode) return;
    const args = Array.prototype.slice.call(arguments);
    args.unshift('[DT:dom]');
    console.log.apply(console, args);
  }

  const inFlight = new Set(); // li.id 正在翻译
  const queue = []; // 待翻译项
  const skipped = new Map(); // key -> 原文，记录「确认无需译文」的消息，防止反复重试
  let flushTimer = null;
  let flushing = false;

  function markSkipped(key, srcText) {
    skipped.set(key, srcText);
    if (skipped.size > 1000) {
      const iter = skipped.keys();
      for (let i = 0; i < 500; i++) {
        const next = iter.next();
        if (next.done) break;
        skipped.delete(next.value);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 文本提取                                                            */
  /* ------------------------------------------------------------------ */

  function collect(node, out) {
    if (!node) return;

    if (node.nodeType === 3) {
      out.push(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName;
    if (tag === 'BR') {
      out.push('\n');
      return;
    }
    if (SKIP_TAGS[tag]) {
      out.push(' ');
      return;
    }
    if (tag === 'IMG') {
      const alt = node.getAttribute('alt') || node.getAttribute('data-name') || '';
      out.push(alt);
      return;
    }
    // Discord 的 spoiler 内容默认遮盖，不主动翻译（避免剧透外泄）
    const cls = node.getAttribute && node.getAttribute('class');
    if (cls) {
      if (cls.indexOf('spoiler') !== -1) {
        out.push(' ');
        return;
      }
      if (cls.indexOf('repliedMessage') !== -1) {
        out.push(' ');
        return;
      }
    }

    for (let i = 0; i < node.childNodes.length; i++) collect(node.childNodes[i], out);
  }

  function extractText(el) {
    const out = [];
    collect(el, out);
    let text = out.join('');
    text = text.replace(/\u00a0/g, ' ');
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();
    return text;
  }

  function isTranslatable(text) {
    if (!text) return false;
    // 去掉纯符号 / 纯数字
    const stripped = text.replace(/[\s\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
    return stripped.length >= 2;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function buildNode() {
    const wrap = document.createElement('div');
    wrap.className = NS + '-trans';
    const badge = document.createElement('span');
    badge.className = NS + '-badge';
    badge.textContent = '译';
    const text = document.createElement('span');
    text.className = NS + '-text';
    wrap.appendChild(badge);
    wrap.appendChild(text);
    return wrap;
  }

  function render(item, result) {
    const { li, contentEl, key, srcText } = item;
    if (!li.isConnected || !contentEl.isConnected) {
      dbg('render skip (detached)', key, li.isConnected, contentEl && contentEl.isConnected);
      return;
    }

    let node = li.querySelector(':scope > .' + NS + '-trans');
    if (!node) {
      // 可能挂在 contentEl 的父节点下
      node = contentEl.parentElement && contentEl.parentElement.querySelector(':scope > .' + NS + '-trans');
    }
    if (!node) {
      node = buildNode();
      contentEl.insertAdjacentElement('afterend', node);
    }

    node.setAttribute('data-dt-for', key);
    node.setAttribute('data-dt-src', srcText);
    node.setAttribute('data-dt-lang', result.detected || '');
    node.setAttribute('data-dt-target', settings.targetLang || '');
    node.classList.remove(NS + '-trans--error');

    const badge = node.querySelector('.' + NS + '-badge');
    const textEl = node.querySelector('.' + NS + '-text');

    if (badge) {
      const from = result.detected ? root.DTEngine.langName(result.detected) || result.detected : '自动';
      badge.title = from + ' → ' + (root.DTEngine.langName(settings.targetLang) || settings.targetLang);
    }
    if (textEl) textEl.textContent = result.text;

    // replace 模式：隐藏原文
    if (settings.display === 'replace') {
      contentEl.classList.add(NS + '-orig-hidden');
    } else {
      contentEl.classList.remove(NS + '-orig-hidden');
    }
  }

  function restoreOrigins(scope) {
    const root2 = scope || document;
    const hidden = root2.querySelectorAll('.' + NS + '-orig-hidden');
    for (let i = 0; i < hidden.length; i++) hidden[i].classList.remove(NS + '-orig-hidden');
  }

  function removeNode(li) {
    if (!li) return;
    const nodes = li.querySelectorAll('.' + NS + '-trans');
    for (let i = 0; i < nodes.length; i++) nodes[i].remove();
    restoreOrigins(li);
  }

  function removeAllNodes() {
    const nodes = document.querySelectorAll('.' + NS + '-trans');
    for (let i = 0; i < nodes.length; i++) nodes[i].remove();
    restoreOrigins(document);
    queue.length = 0;
    inFlight.clear();
    skipped.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 扫描                                                                */
  /* ------------------------------------------------------------------ */

  function getSettingsSnapshot() {
    return settings || {};
  }

  function enqueue(item) {
    queue.push(item);
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 120);
    }
  }

  async function flush() {
    if (flushing || !running) return;
    if (queue.length === 0) return;
    flushing = true;

    const batch = queue.splice(0, queue.length);
    const currentSettings = getSettingsSnapshot();

    // 相同文本合并，减少请求
    const groups = new Map();
    for (const item of batch) {
      if (!groups.has(item.srcText)) groups.set(item.srcText, []);
      groups.get(item.srcText).push(item);
      inFlight.add(item.key);
    }

    const texts = Array.from(groups.keys());
    const CHUNK = 24;

    try {
      for (let i = 0; i < texts.length; i += CHUNK) {
        if (!running) break;
        const chunk = texts.slice(i, i + CHUNK);
        let results;
        try {
          results = await bridge.translate(chunk, currentSettings);
        } catch (e) {
          console.warn('[Discord Translator] 翻译失败', e);
          chunk.forEach((t) => groups.get(t).forEach((it) => inFlight.delete(it.key)));
          continue;
        }

        dbg(
          'chunk',
          'len=' + chunk.length,
          'results=' + (results ? results.length : 'null'),
          JSON.stringify(chunk.map((s) => s.slice(0, 14)))
        );

        for (let ci = 0; ci < chunk.length; ci++) {
          // 逐条独立 try/catch：任何一条出错都不能拖累同批其它消息
          try {
            const src = chunk[ci];
            const items = groups.get(src) || [];
            const r = results && results[ci];
            for (const it of items) inFlight.delete(it.key);

            dbg('result', ci, 'ok=' + (r && r.ok), 'src=' + src.slice(0, 26));

            if (!r || !r.ok) {
              if (r && r.error) console.warn('[Discord Translator] ' + r.error);
              continue;
            }
            if (!r.text) {
              // 空译文，标记为无需翻译，避免反复重试
              for (const it of items) {
                markSkipped(it.key, it.srcText);
                removeNode(it.li);
              }
              continue;
            }

            const same = root.DTEngine.isSameLang(r.detected, currentSettings.targetLang);
            if (same && currentSettings.skipSameLang !== false) {
              for (const it of items) {
                markSkipped(it.key, it.srcText);
                removeNode(it.li);
              }
              continue;
            }

            // 译文与原文一致（例如 "lol"），标记后不再重复请求
            if (r.text.trim() === src.trim()) {
              for (const it of items) {
                markSkipped(it.key, it.srcText);
                removeNode(it.li);
              }
              continue;
            }

            for (const it of items) render(it, r);
          } catch (err) {
            console.warn('[Discord Translator] 单条处理失败', (err && err.message) || err);
          }
        }
      }
    } finally {
      flushing = false;
      if (queue.length > 0 && running) {
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flush();
          }, 200);
        }
      }
    }
  }

  function inspect(li) {
    if (!li || !li.isConnected) return;

    const contents = li.querySelectorAll(SEL.content);
    if (contents.length === 0) {
      removeNode(li);
      return;
    }

    // 取不在"回复预览"里的第一个 message-content
    let contentEl = null;
    for (let i = 0; i < contents.length; i++) {
      const el = contents[i];
      if (el.closest(SEL.replied)) continue;
      contentEl = el;
      break;
    }
    if (!contentEl) return;

    const key = li.id || contentEl.id;
    const srcText = extractText(contentEl);

    const existing = li.querySelector('.' + NS + '-trans');
    if (existing) {
      const forKey = existing.getAttribute('data-dt-for');
      const oldSrc = existing.getAttribute('data-dt-src');
      const oldTarget = existing.getAttribute('data-dt-target');

      // li 被 React 复用于其它消息
      if (forKey && forKey !== key) {
        removeNode(li);
      } else if (oldTarget && oldTarget !== (settings.targetLang || '')) {
        removeNode(li);
      } else if (oldSrc === srcText) {
        // 已翻译且内容未变
        if (!isTranslatable(srcText) && settings.skipSameLang !== false) {
          // noop
        }
        return;
      } else {
        // 消息被编辑
        removeNode(li);
      }
    }

    if (!settings.enabled) return;
    if (!isTranslatable(srcText)) return;

    // 已经确认过「无需译文」的消息（同语种 / 译不出东西），不再重复请求
    if (skipped.get(key) === srcText) return;

    // 本地语种预判：已经是目标语言的消息直接跳过，省一次请求
    if (settings.skipSameLang !== false) {
      const detected = root.DTEngine.detectScript(srcText);
      const targetBase = String(settings.targetLang || '').toLowerCase().split('-')[0];
      if (detected && targetBase && detected === targetBase) {
        markSkipped(key, srcText);
        return;
      }
    }

    if (inFlight.has(key)) return;

    const dupe = queue.some((q) => q.key === key);
    if (dupe) return;

    enqueue({ li, contentEl, key, srcText });
  }

  function scanAll() {
    if (!running) return;
    if (!settings.enabled) {
      removeAllNodes();
      return;
    }
    const items = document.querySelectorAll(SEL.listItem);
    for (let i = 0; i < items.length; i++) inspect(items[i]);
    // 消息可能不在 li 里（极少数布局），兜底扫描
    if (items.length === 0) {
      const contents = document.querySelectorAll(SEL.content);
      for (let i = 0; i < contents.length; i++) {
        const li = contents[i].closest('li') || contents[i].parentElement;
        if (li) inspect(li);
      }
    }
  }

  function scheduleScan(delay) {
    if (!running) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAll();
    }, delay || 200);
  }

  /* ------------------------------------------------------------------ */
  /* MutationObserver                                                    */
  /* ------------------------------------------------------------------ */

  function isOurMutation(record) {
    const t = record.target;
    if (!t || t.nodeType !== 1) return false;
    if (t.classList && (t.classList.contains(NS + '-trans') || t.classList.contains(NS + '-text'))) return true;
    return false;
  }

  function onMutations(records) {
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (isOurMutation(r)) continue;
      if (r.type === 'characterData') {
        scheduleScan(260);
        return;
      }
      if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) {
        scheduleScan(160);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  function start(options) {
    if (running) return;
    bridge = options;
    settings = options.getSettings() || {};
    running = true;

    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // 首次与后续补扫
    scheduleScan(300);
    const t1 = setTimeout(scanAll, 1500);
    const t2 = setTimeout(scanAll, 4000);

    // 滚动时补扫
    window.addEventListener('scroll', onScroll, true);

    if (root.DTEngine) {
      // 预热：把已渲染消息先翻一遍
      scheduleScan(800);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }

  let scrollTimer = null;
  function onScroll() {
    if (!running) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      scanAll();
    }, 180);
  }

  function stop() {
    running = false;
    if (observer) observer.disconnect();
    observer = null;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    window.removeEventListener('scroll', onScroll, true);
    removeAllNodes();
  }

  function updateSettings(next) {
    const prev = settings || {};
    settings = next || {};

    const targetChanged = prev.targetLang !== settings.targetLang;
    const providerChanged = prev.provider !== settings.provider;
    const displayChanged = prev.display !== settings.display;

    if (targetChanged || providerChanged) {
      removeAllNodes();
    }

    if (displayChanged && settings.display !== 'replace') {
      restoreOrigins(document);
    }

    if (!settings.enabled) {
      removeAllNodes();
      return;
    }

    scheduleScan(60);
  }

  function retranslateAll() {
    removeAllNodes();
    scanAll();
  }

  function stats() {
    return {
      rendered: document.querySelectorAll('.' + NS + '-trans').length,
      queued: queue.length,
      inFlight: inFlight.size,
      queuedKeys: queue.map((q) => q.key),
      inFlightKeys: Array.from(inFlight),
      running
    };
  }

  const api = {
    start,
    stop,
    updateSettings,
    retranslateAll,
    scanAll: () => scanAll(),
    stats,
    extractText,
    isTranslatable,
    setDebug: (v) => {
      debugMode = !!v;
    },
    SEL
  };

  root.DTDom = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);

})(undefined, undefined, undefined);

const DT_PLUGIN_ID = 'DiscordTranslator';

module.exports = class DiscordTranslator {
  constructor(meta) {
    this.meta = meta || {};
    this.settings = null;
    this.started = false;
    this.panelEl = null;
    this.translateBridge = (texts, settings) => DTEngine.translate(texts, settings);
  }

  /* ---------------------------------------------------------------- */

  async loadSettings() {
    this.settings = await DTSettings.load();
    if (!this.settings.targetLang) this.settings.targetLang = 'zh-CN';
    return this.settings;
  }

  saveSettings(patch) {
    this.settings = DTSettings.merge(this.settings || DTSettings.DEFAULTS, patch);
    DTSettings.save(this.settings);
    if (this.started) DTDom.updateSettings(this.settings);
  }

  /* ---------------------------------------------------------------- */

  async start() {
    if (this.started) return;
    await this.loadSettings();

    if (!document.body) {
      await new Promise((r) => setTimeout(r, 800));
    }

    try {
      DTDom.start({
        translate: this.translateBridge,
        getSettings: () => this.settings
      });
      this.started = true;
    } catch (e) {
      this.started = false;
      console.error('[DiscordTranslator] 启动失败', e);
      try {
        BdApi.UI.showToast('翻译启动失败：' + e.message, { type: 'error', timeout: 5000 });
      } catch (_) {
        /* ignore */
      }
      return;
    }

    try {
      BdApi.UI.showToast('Discord 翻译已启动 → ' + (this.settings.targetLang || 'zh-CN'), {
        type: 'success',
        timeout: 2000
      });
    } catch (e) {
      /* ignore */
    }
  }

  stop() {
    if (!this.started) return;
    try {
      DTDom.stop();
    } catch (e) {
      /* ignore */
    }
    this.started = false;
    this.panelEl = null;
  }

  /* ---------------------------------------------------------------- */

  makeSelect(options, value, onChange) {
    const sel = document.createElement('select');
    sel.style.cssText =
      'width:100%;padding:8px 10px;border-radius:6px;background:var(--background-tertiary,#1e1f22);color:var(--text-normal,#dbdee1);border:1px solid var(--background-modifier-accent,#3f4147);font-size:13px;outline:none;';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  fieldLabel(text) {
    const l = document.createElement('div');
    l.textContent = text;
    l.style.cssText =
      'font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--header-secondary,#949ba4);margin-bottom:6px;';
    return l;
  }

  getSettingsPanel() {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'padding:18px;display:flex;flex-direction:column;gap:16px;max-width:520px;font-family:var(--font-primary,system-ui);';

    const title = document.createElement('div');
    title.textContent = 'Discord 自动翻译';
    title.style.cssText = 'font-size:18px;font-weight:700;color:var(--header-primary,#fff);';
    wrap.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = '译文会以带「译」标记的小字显示在每条消息下方。修改后立即生效。';
    subtitle.style.cssText = 'font-size:12.5px;color:var(--text-muted,#949ba4);line-height:1.5;';
    wrap.appendChild(subtitle);

    // 开关
    const toggleRow = document.createElement('label');
    toggleRow.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;';
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !!this.settings.enabled;
    toggle.style.cssText = 'width:18px;height:18px;accent-color:#5865f2;cursor:pointer;';
    toggle.addEventListener('change', () => this.saveSettings({ enabled: toggle.checked }));
    const toggleText = document.createElement('span');
    toggleText.textContent = '启用自动翻译';
    toggleText.style.cssText = 'font-size:14px;color:var(--text-normal,#dbdee1);';
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(toggleText);
    wrap.appendChild(toggleRow);

    // 目标语言
    const langBlock = document.createElement('div');
    langBlock.appendChild(this.fieldLabel('翻译成'));
    langBlock.appendChild(
      this.makeSelect(
        DTSettings.PRESET_LANGS.map((x) => ({ value: x.code, label: x.label })),
        this.settings.targetLang,
        (v) => this.saveSettings({ targetLang: v })
      )
    );
    wrap.appendChild(langBlock);

    // 服务商
    const provBlock = document.createElement('div');
    provBlock.appendChild(this.fieldLabel('翻译服务'));
    const provSelect = this.makeSelect(
      [
        { value: 'auto', label: '自动（国内直连优先，推荐）' },
        { value: 'tencent', label: '腾讯交互翻译（国内直连）' },
        { value: 'google', label: 'Google 翻译' },
        { value: 'caiyun', label: '彩云小译' },
        { value: 'mymemory', label: 'MyMemory' },
        { value: 'openai', label: 'OpenAI 兼容（DeepSeek / Ollama）' },
        { value: 'libre', label: 'LibreTranslate（自建）' }
      ],
      this.settings.provider,
      (v) => {
        this.saveSettings({ provider: v });
        openaiBlock.style.display = v === 'openai' ? 'flex' : 'none';
        libreBlock.style.display = v === 'libre' ? 'flex' : 'none';
      }
    );
    provBlock.appendChild(provSelect);

    const netHint = document.createElement('div');
    netHint.textContent = '网络通道：' + DTEngine.networkInfo() + '（客户端内需走 BdApi.Net 绕过 CSP）';
    netHint.style.cssText = 'font-size:11px;color:var(--text-muted,#949ba4);margin-top:6px;';
    provBlock.appendChild(netHint);
    wrap.appendChild(provBlock);

    // OpenAI 配置
    const openaiBlock = document.createElement('div');
    openaiBlock.style.cssText =
      'display:' + (this.settings.provider === 'openai' ? 'flex' : 'none') + ';flex-direction:column;gap:10px;';

    const mkInput = (key, placeholder) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.value = this.settings[key] || '';
      i.placeholder = placeholder;
      i.spellcheck = false;
      i.style.cssText =
        'width:100%;padding:8px 10px;border-radius:6px;background:var(--background-tertiary,#1e1f22);color:var(--text-normal,#dbdee1);border:1px solid var(--background-modifier-accent,#3f4147);font-size:13px;outline:none;box-sizing:border-box;';
      i.addEventListener('input', () => this.saveSettings({ [key]: i.value.trim() }));
      return i;
    };

    const baseLbl = document.createElement('div');
    baseLbl.appendChild(this.fieldLabel('API Base'));
    baseLbl.appendChild(mkInput('openaiBase', 'https://api.deepseek.com/v1'));
    openaiBlock.appendChild(baseLbl);

    const keyLbl = document.createElement('div');
    keyLbl.appendChild(this.fieldLabel('API Key'));
    const keyInput = mkInput('openaiKey', 'sk-...');
    keyInput.type = 'password';
    keyLbl.appendChild(keyInput);
    openaiBlock.appendChild(keyLbl);

    const modelLbl = document.createElement('div');
    modelLbl.appendChild(this.fieldLabel('模型'));
    modelLbl.appendChild(mkInput('openaiModel', 'deepseek-chat'));
    openaiBlock.appendChild(modelLbl);

    wrap.appendChild(openaiBlock);

    // LibreTranslate 配置
    const libreBlock = document.createElement('div');
    libreBlock.style.cssText =
      'display:' + (this.settings.provider === 'libre' ? 'flex' : 'none') + ';flex-direction:column;gap:10px;';

    const libreUrlLbl = document.createElement('div');
    libreUrlLbl.appendChild(this.fieldLabel('LibreTranslate 地址'));
    libreUrlLbl.appendChild(mkInput('libreUrl', 'http://127.0.0.1:5000'));
    libreBlock.appendChild(libreUrlLbl);

    const libreKeyLbl = document.createElement('div');
    libreKeyLbl.appendChild(this.fieldLabel('API Key（没有就留空）'));
    libreKeyLbl.appendChild(mkInput('libreKey', ''));
    libreBlock.appendChild(libreKeyLbl);

    wrap.appendChild(libreBlock);

    // 显示模式
    const disBlock = document.createElement('div');
    disBlock.appendChild(this.fieldLabel('显示方式'));
    disBlock.appendChild(
      this.makeSelect(
        [
          { value: 'below', label: '原文下方小字' },
          { value: 'replace', label: '隐藏原文，只显示译文' }
        ],
        this.settings.display,
        (v) => this.saveSettings({ display: v })
      )
    );
    wrap.appendChild(disBlock);

    // 跳过同语言
    const skipRow = document.createElement('label');
    skipRow.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;';
    const skipBox = document.createElement('input');
    skipBox.type = 'checkbox';
    skipBox.checked = this.settings.skipSameLang !== false;
    skipBox.style.cssText = 'width:18px;height:18px;accent-color:#5865f2;cursor:pointer;';
    skipBox.addEventListener('change', () => this.saveSettings({ skipSameLang: skipBox.checked }));
    const skipText = document.createElement('span');
    skipText.textContent = '已经是目标语言的消息不显示译文';
    skipText.style.cssText = 'font-size:14px;color:var(--text-normal,#dbdee1);';
    skipRow.appendChild(skipBox);
    skipRow.appendChild(skipText);
    wrap.appendChild(skipRow);

    // 字号
    const sizeBlock = document.createElement('div');
    sizeBlock.appendChild(this.fieldLabel('译文字号'));
    sizeBlock.appendChild(
      this.makeSelect(
        [12, 13, 14, 15, 16].map((n) => ({ value: String(n), label: n + ' px' })),
        String(this.settings.fontSize || 13),
        (v) => this.saveSettings({ fontSize: parseInt(v, 10) })
      )
    );
    wrap.appendChild(sizeBlock);

    // 操作按钮
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    const mkBtn = (text, onClick, danger) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText =
        'flex:1;padding:9px 12px;border-radius:6px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-accent,#3f4147);background:var(--background-secondary-alt,#2b2d31);color:var(--text-normal,#dbdee1);' +
        (danger ? 'color:#ff9a9c;' : '');
      b.addEventListener('click', onClick);
      return b;
    };

    btnRow.appendChild(
      mkBtn('测试连接', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '测试中…';
        try {
          const r = await DTEngine.test(this.settings);
          BdApi.UI.showToast(r.ok ? '连接正常 · ' + r.ms + 'ms → ' + r.text : '失败：' + r.error, {
            type: r.ok ? 'success' : 'error',
            timeout: 4000
          });
        } catch (err) {
          BdApi.UI.showToast('失败：' + err.message, { type: 'error' });
        } finally {
          btn.disabled = false;
          btn.textContent = '测试连接';
        }
      })
    );

    btnRow.appendChild(
      mkBtn('重新翻译', () => {
        DTDom.retranslateAll();
        BdApi.UI.showToast('已重新翻译当前页面', { type: 'info', timeout: 1500 });
      })
    );

    btnRow.appendChild(
      mkBtn(
        '清空缓存',
        () => {
          DTEngine.clearCache();
          DTSettings.clearCacheStorage();
          DTDom.retranslateAll();
          BdApi.UI.showToast('缓存已清空', { type: 'success', timeout: 1500 });
        },
        true
      )
    );

    wrap.appendChild(btnRow);

    this.panelEl = wrap;
    return wrap;
  }
};
