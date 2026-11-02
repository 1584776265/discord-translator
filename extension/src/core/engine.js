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
    // Tauri 桌面版注入的通道（走 Rust 侧的 reqwest，绕开 WebView2 的 CORS）
    if (typeof root.__DT_FETCH__ === 'function') {
      return { fn: root.__DT_FETCH__, viaHost: true, name: 'tauri-ipc' };
    }
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
        // 留 400 字符：MyMemory 的 429 响应里带 "NEXT AVAILABLE IN 02 HOURS 08 MINUTES"，
        // 截太短会让额度恢复时间解析不出来，只能退回保守估计
        detail = (await res.text()).slice(0, 400);
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
      // 留 200 字符：额度提示里带 "NEXT AVAILABLE IN 02 HOURS 11 MINUTES"，
      // 截太短会导致恢复时间解析不出来，只能退回保守的 3 小时
      if (/^MYMEMORY WARNING/i.test(text2)) throw makeError(text2.slice(0, 200));
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

  /**
   * LLM 的术语表走提示词，不走占位符替换。
   *
   * 实测对比（qwen2.5:3b，7 条术语的一整句）：
   *   不带术语      → 命中 5/7
   *   占位符 <0>    → 命中 7/7，但句子生硬（"解决了…" 而非 "修复了…"）
   *   提示词        → 命中 7/7，且用词和语序都更自然
   * 所以对 openai / ollama 这类模型，把术语当上下文给比强行替换更划算 ——
   * 既保证了术语，又不会因为拆词破坏句式。
   */
  const OPENAI_SYSTEM = (langStr, glossary) => {
    const rules = [
      '你是一个翻译引擎，不是助手。',
      '把用户给出的每一条「编号行」翻译成' + langStr + '。',
      '严格规则：',
      '1. 原样保留行首的 [数字] 前缀，输出行数必须与输入行数完全一致，不得合并或拆分。',
      '2. 只输出译文行，禁止任何解释、前言、注释、代码块围栏。',
      '3. 保留原文中的 @提及、#频道、URL、`代码`、表情符号、Markdown 符号。',
      '4. 如果某条本身已经是' + langStr + '，原样输出该条。',
      '5. 不要翻译专有名词、游戏 ID、用户名。'
    ];

    if (glossary && glossary.length) {
      // 只加一句提醒，术语本身放到 user 消息里 —— 实测把十几条术语堆进
      // system 会让 3B 模型忽略掉「保留 [数字] 前缀」的格式要求。
      rules.push('6. 用户消息开头若给出「术语参考」，必须严格采用其中译法。');
    }

    return rules.join('\n');
  };

  /**
   * 拼 user 消息：术语参考放最前面，正文按 [n] 编号。
   * 术语贴近正文时模型注意力更集中，格式也不会乱。
   */
  function buildUserContent(texts, glossary) {
    let prefix = '';

    if (glossary && glossary.length) {
      const refs = glossary
        .slice(0, 60)
        .filter((g) => g && g.from)
        .map((g) => g.from + '=' + g.to)
        .join('；');
      if (refs) prefix = '（术语参考：' + refs + '）\n\n';
    }

    const body = texts
      .map((t, i) => '[' + (i + 1) + '] ' + String(t).replace(/\r?\n/g, ' ⏎ '))
      .join('\n');

    return prefix + body;
  }

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

    const userContent = buildUserContent(texts, s.glossary);

    const payload = {
      model: s.openaiModel || 'gpt-4o-mini',
      temperature: 0,
      stream: false,
      messages: [
        { role: 'system', content: OPENAI_SYSTEM(langStr, s.glossary) },
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

  /**
   * 按「条数 + 总字符数」双重上限分批。
   *
   * 只用条数分批会翻车：24 条短消息塞一批完全没问题（省往返），
   * 但 3 条 1200 字的长文塞一起，本地 3B 模型就要生成几千 token，等到超时。
   */
  function packBatches(texts, maxItems, maxChars) {
    const batches = [];
    let cur = [];
    let chars = 0;

    for (let i = 0; i < texts.length; i++) {
      const len = String(texts[i] || '').length;

      if (cur.length > 0 && (cur.length >= maxItems || chars + len > maxChars)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }

      cur.push(i);
      chars += len;
    }

    if (cur.length > 0) batches.push(cur);
    return batches;
  }

  async function openaiTranslate(texts, s) {
    const results = new Array(texts.length);

    // LLM 生成比 API 慢一个数量级：本地 3B 在 CPU 上吐 1000 字要一两分钟。
    const isLocal = /127\.0\.0\.1|localhost/.test(String(s.openaiBase || ''));

    const maxItems = isLocal ? 16 : 40;
    const maxChars = isLocal ? 1600 : 6000;

    const timeout = isLocal
      ? Math.max(s.timeout || 0, 240000)
      : Math.max(s.timeout || 0, 90000);

    const settings = Object.assign({}, s, { timeout });

    for (const part of packBatches(texts, maxItems, maxChars)) {
      const payload = part.map((i) => texts[i]);
      try {
        const r = await withRetry(() => openaiTranslateBatch(payload, settings), s.retries || 1);
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

  /** 把 LibreTranslate 的技术报错翻成人话 */
  function friendlyLibreError(e) {
    const msg = String((e && e.message) || e);

    if (/is not available as a (target|source) language/i.test(msg)) {
      const m = msg.match(/from ([A-Za-z ]+?)\s*\(([a-z]{2})\)/i);
      const from = m ? m[1] + ' (' + m[2] + ')' : '该语言';
      return (
        '本机 LibreTranslate 没有安装 ' + from + ' 的翻译模型。' +
        '重新部署时多勾几种语言，或者把翻译服务切回「自动」。'
      );
    }

    if (/HTTP 400/i.test(msg)) {
      return 'LibreTranslate 请求被拒绝：' + msg.slice(0, 100);
    }

    return msg;
  }

  async function libreTranslate(texts, s) {
    return mapLimit(texts, Math.min(s.concurrency || 4, 3), async (text) => {
      try {
        return await withRetry(() => libreTranslateOne(text, s), s.retries || 2);
      } catch (e) {
        return { ok: false, error: friendlyLibreError(e) };
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

  /** 额度类错误：不是网络抖动，重试没用，只能等额度恢复 */
  function looksLikeQuotaError(msg) {
    const t = String(msg || '');
    return /MYMEMORY WARNING|ALL AVAILABLE FREE TRANSLATIONS|quota|insufficient|余额|欠费|HTTP 429/i.test(
      t
    );
  }

  /**
   * 从 MyMemory 的提示里抠出恢复时间，抠不到就按 3 小时算。
   * 注意：原文是 "NEXT AVAILABLE IN  02 HOURS 05 MINUTES"，
   * IN 后面是**两个空格**，正则必须用 \s+ 而不是单个空格。
   */
  function parseQuotaMs(msg) {
    const m = String(msg || '').match(
      /NEXT AVAILABLE IN\s+(\d+)\s*HOURS?\s*(\d+)\s*MINUTES?/i
    );
    if (m) {
      const ms = (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 60 * 1000;
      return Math.max(ms + 60 * 1000, 5 * 60 * 1000);
    }
    return 3 * 60 * 60 * 1000;
  }

  function markQuota(name, msg) {
    const h = providerHealth[name] || (providerHealth[name] = { fails: 0, cooldownUntil: 0 });
    h.quotaUntil = Date.now() + parseQuotaMs(msg);
    h.fails = 0;
    h.cooldownUntil = 0;
    h.quotaMsg = String(msg || '').slice(0, 120);
  }

  function isCoolingDown(name) {
    const h = providerHealth[name];
    if (!h) return false;
    // 额度耗尽优先于普通冷却，两者都不应被调用
    if (h.quotaUntil && h.quotaUntil > Date.now()) return true;
    return !!(h.cooldownUntil && h.cooldownUntil > Date.now());
  }

  function markFail(name) {
    const h = providerHealth[name] || (providerHealth[name] = { fails: 0, cooldownUntil: 0 });
    h.fails++;
    if (h.fails >= 2) {
      h.cooldownUntil = Date.now() + Math.min(5 * 60 * 1000, 30000 * Math.pow(2, h.fails - 2));
    }
  }

  function markOk(name) {
    // 成功说明额度已恢复
    providerHealth[name] = { fails: 0, cooldownUntil: 0, quotaUntil: 0 };
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
        if (looksLikeQuotaError(lastError)) markQuota(name, lastError);
        else markFail(name);
        continue;
      }

      const stillMissing = [];
      let quotaMsg = '';

      remaining.forEach((originalIndex, k) => {
        const r = out[k];
        if (r && r.ok && r.text) {
          results[originalIndex] = r;
        } else {
          if (r && r.error) {
            lastError = r.error;
            if (!quotaMsg && looksLikeQuotaError(r.error)) quotaMsg = r.error;
          }
          stillMissing.push(originalIndex);
        }
      });

      // 整批都没出来、且报的是额度类错误 → 把这个源踢出链，别再白试
      if (quotaMsg && stillMissing.length === remaining.length) {
        markQuota(name, quotaMsg);
      } else if (stillMissing.length > 0) {
        markFail(name);
      }

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

  /**
   * 各引擎单条能安全处理的字符数。
   * 实测：腾讯超过约 1800 字后会被静默截断（3500 字只返回 540 字译文），
   * Ollama qwen2.5:3b 在 CPU 上超过 3000 字直接超时。
   */
  const LONG_TEXT_LIMIT = {
    tencent: 1500,
    google: 1500,
    mymemory: 1500,
    caiyun: 1500,
    libre: 1200,
    openai: 1200
  };

  /**
   * 把长文本切成若干段：优先按段落，其次按句子，实在不行硬切。
   * 切完分段翻译再拼回去，避免截断丢内容和超时。
   */
  function splitLongText(text, maxChars) {
    const t = String(text || '');
    if (t.length <= maxChars) return [t];

    const parts = [];
    let buf = '';

    const push = () => {
      const v = buf.trim();
      if (v) parts.push(v);
      buf = '';
    };

    for (const block of t.split(/\n{2,}/)) {
      if (block.length <= maxChars) {
        if (buf.length + block.length + 2 > maxChars) push();
        buf += (buf ? '\n\n' : '') + block;
        continue;
      }

      // 单段超长，按句子切
      const sentences = block.match(/[^.!?。！？\n]+[.!?。！？]*\s*/g) || [block];

      for (const sent of sentences) {
        if (sent.length > maxChars) {
          push();
          let rest = sent;
          while (rest.length > maxChars) {
            parts.push(rest.slice(0, maxChars));
            rest = rest.slice(maxChars);
          }
          if (rest.trim()) buf = rest;
          continue;
        }
        if (buf.length + sent.length > maxChars) push();
        buf += sent;
      }
    }

    push();
    return parts.length ? parts : [t.slice(0, maxChars)];
  }

  /**
   * 目标语言是中日韩，译文却一个 CJK 字符都没有 —— 认为模型把原文吐回来了。
   * 纯表情/纯符号的原文不算，太短的不算（"GG" 这种本来就不翻）。
   */
  const CJK_TARGET = /^(zh|ja|ko)/i;
  const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/;

  function looksEchoed(src, out, targetLang) {
    if (!CJK_TARGET.test(String(targetLang || ''))) return false;
    if (!out) return false;
    if (CJK_CHAR.test(out)) return false;

    const letters = String(src || '').replace(/[^\p{L}]/gu, '');
    return letters.length >= 12;
  }

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

    const provider = s.provider || 'auto';
    const maxChars = LONG_TEXT_LIMIT[provider] || 1500;

    // ---- 长文本拆段 ----
    const segments = [];
    for (const i of todo) {
      const parts = splitLongText(texts[i], maxChars);
      for (const p of parts) segments.push({ src: i, text: p });
    }

    const segTexts = segments.map((x) => x.text);

    let out;
    if (provider === 'auto') {
      out = await autoTranslate(segTexts, s);
    } else {
      out = await runProvider(provider, segTexts, s);
    }

    // ---- 按原文合并 ----
    const grouped = new Map();
    segments.forEach((seg, k) => {
      if (!grouped.has(seg.src)) grouped.set(seg.src, []);
      grouped.get(seg.src).push(out[k] || { ok: false, error: '无结果' });
    });

    for (const i of todo) {
      const parts = grouped.get(i) || [];

      if (parts.length === 0) {
        results[i] = { ok: false, error: '无结果' };
        continue;
      }

      const allOk = parts.every((r) => r && r.ok);

      if (allOk) {
        const joined = parts
          .map((r) => r.text)
          .filter(Boolean)
          .join('\n\n');

        // 本地小模型偶尔会把原文吐回来（内容高度重复 / 超出上下文时尤其明显），
        // 这种结果一旦渲染出去，用户会以为译文就是英文。宁可报失败让人点重译。
        if (looksEchoed(texts[i], joined, s.targetLang)) {
          results[i] = { ok: false, error: '模型没有翻译，返回了原文' };
          continue;
        }

        results[i] = {
          ok: true,
          text: joined,
          detected: (parts[0] && parts[0].detected) || ''
        };
        if (joined) cacheSet(texts[i], s, results[i]);
      } else {
        const bad = parts.find((r) => r && !r.ok);
        results[i] = {
          ok: false,
          error: (bad && bad.error) || '部分分段翻译失败',
          partial: parts.length > 1
        };
      }
    }

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
      const h = providerHealth[name];

      // 额度已耗尽：别再发请求白耗一个往返，直接报恢复时间
      if (h && h.quotaUntil && h.quotaUntil > Date.now()) {
        const mins = Math.max(1, Math.ceil((h.quotaUntil - Date.now()) / 60000));
        out.push({
          provider: name,
          ok: false,
          quota: true,
          ms: 0,
          text: '',
          error: '额度已用完，约 ' + mins + ' 分钟后可用'
        });
        continue;
      }

      const t0 = Date.now();
      try {
        const r = await PROVIDERS[name](['Hello there'], s);
        const ok = !!(r[0] && r[0].ok && r[0].text);
        const errText = (r[0] && r[0].error) || '';

        if (!ok && looksLikeQuotaError(errText)) markQuota(name, errText);

        out.push({
          provider: name,
          ok,
          ms: Date.now() - t0,
          text: (r[0] && r[0].text) || '',
          error: errText
        });
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (looksLikeQuotaError(msg)) markQuota(name, msg);
        out.push({ provider: name, ok: false, ms: Date.now() - t0, text: '', error: msg });
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
    AUTO_CHAIN,
    // 纯函数，给 CI 单测用（不联网）
    __test__: { splitLongText, looksEchoed, packBatches, LONG_TEXT_LIMIT, chunkArray }
  };

  root.DTEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
