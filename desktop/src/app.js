/* global DTEngine */
/**
 * Discord 自动翻译 — 桌面版前端
 *
 * 职责：
 *   1. 通过 CDP 连上 Discord 渲染进程（Origin 已在 Discord 启动参数里放行）
 *   2. 把 dom.js + 样式注入过去
 *   3. 常驻充当翻译后端：Discord 页面通过 CDP binding 发来文本，
 *      这里调用 DTEngine.translate（HTTP 走 Rust），再把结果回填
 */
(function () {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // 双语：中文是原文，英文查 i18n.js 里的字典（见 i18n.js 顶部说明）
  const t = (s, vars) => (window.DTI18n ? window.DTI18n.t(s, vars) : s);

  const BINDING = '__dtIpcSend';
  const POLL_MS = 2000;

  /* ---------------------------------------------------------------- */
  /* 状态                                                              */
  /* ---------------------------------------------------------------- */

  const S = {
    cfg: null,
    enabled: true,
    ws: null,
    cdpReady: false,
    msgId: 0,
    pending: new Map(),
    port: 9223,
    pageUrl: '',
    lastStats: { rendered: 0, total: 0, inFlight: 0, queued: 0 },
    usage: { requests: 0, chars: 0, messages: 0 },
    lastError: '',
    connecting: false,
    reinjecting: false,
    autoRestarted: false,
    autoReconnect: false,
    reconnectTimer: null,
    deadChecks: 0,
    channelId: '',
    channelName: '',
    pollTimer: null,
    logs: [],
    appInfo: { version: '', installed: false, lang: 'zh', proxy: '' },
    updateInfo: null
  };

  let DOM_SRC = '';
  let CSS_SRC = '';
  let ENGINE_SRC = '';

  const $ = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- */
  /* 小工具                                                            */
  /* ---------------------------------------------------------------- */

  function log(level, message) {
    const line = `[${new Date().toTimeString().slice(0, 8)}] [${level}] ${message}`;
    S.logs.push(line);
    if (S.logs.length > 400) S.logs.splice(0, S.logs.length - 400);

    const box = $('logBox');
    if (box) box.textContent = S.logs.slice(-120).join('\n');

    invoke('write_log', { level, message }).catch(() => {});
    if (level === 'ERROR') console.error(message);
    else console.log(message);
  }

  function setStatus(kind, text, detail) {
    const dot = $('dot');
    dot.className = 'dot ' + (kind || '');
    $('statusText').textContent = text;
    $('statusDetail').textContent = detail || '';
  }

  function setHint(text, isError) {
    const el = $('hint');
    el.textContent = text || '';
    el.className = 'hint' + (isError ? ' err' : '');
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ---------------------------------------------------------------- */
  /* 术语表：翻译前用私有区字符占位，翻译后还原                          */
  /* ---------------------------------------------------------------- */

  /**
   * 术语占位符格式：<0> <1> ...
   *
   * 实测对比过 8 种格式（私有区字符、{{0}}、[[0]]、%0%、__0__、$0$$ 等），
   * 只有尖括号 <0> 和井号 #0# 能被小模型原样保留：
   *   - 私有区字符会被 LibreTranslate 当普通文本，变成 "QQ0+++" 甚至直接吞掉
   *   - {{0}} / [[0]] / %0% 全被改写
   *   - 腾讯和 LibreTranslate 都保留了 <0>，所以统一用它
   */
  const GLOSSARY_TOKEN = (i) => '<' + i + '>';

  function applyGlossary(text, glossary) {
    if (!glossary || !glossary.length) return { text, map: [] };
    let out = text;
    const map = [];

    for (let i = 0; i < glossary.length; i++) {
      const g = glossary[i];
      if (!g || !g.from) continue;
      const token = GLOSSARY_TOKEN(i);

      // 纯英文/数字的术语要加词边界，否则 "mod" 会吃掉 "mode"、"modern" 里的 mod
      const isAscii = /^[A-Za-z0-9][A-Za-z0-9\s\-_.]*$/.test(g.from);
      const pattern = isAscii
        ? '(?<![A-Za-z0-9])' + escapeRe(g.from) + '(?![A-Za-z0-9])'
        : escapeRe(g.from);

      let re;
      try {
        re = new RegExp(pattern, 'gi');
      } catch (e) {
        continue;
      }

      if (re.test(out)) {
        out = out.replace(re, token);
        map.push({ token, to: g.to || g.from });
      }
    }
    return { text: out, map };
  }

  /**
   * 推荐术语表：游戏 / 显卡 / MOD 圈高频词。
   * 长词必须排在短词之前（"graphics driver" 要在 "driver" 前面），
   * 因为 applyGlossary 是按顺序逐个替换的。
   */
  const RECOMMENDED_GLOSSARY = [
    { from: 'graphics driver', to: '显卡驱动' },
    { from: 'display driver', to: '显示驱动' },
    { from: 'texture streaming', to: '纹理流送' },
    { from: 'ray tracing', to: '光线追踪' },
    { from: 'frame rate', to: '帧率' },
    { from: 'patch notes', to: '更新日志' },
    { from: 'upscaling', to: '超分辨率' },
    { from: 'changelog', to: '更新日志' },
    { from: 'shader', to: '着色器' },
    { from: 'texture', to: '纹理' },
    { from: 'driver', to: '驱动程序' },
    { from: 'patch', to: '补丁' },
    { from: 'crash', to: '崩溃' },
    { from: 'stutter', to: '卡顿' },
    { from: 'VRAM', to: '显存' },
    { from: 'GPU', to: '显卡' },
    { from: 'mod', to: 'MOD' }
  ];

  /**
   * 还原占位符。
   * 返回丢失数量：LibreTranslate 这类逐词对齐的小模型会把 <0> 改写成 " 0 "
   * 甚至直接吞掉，此时术语不会生效 —— 要能检测出来而不是悄悄错译。
   */
  function restoreGlossary(text, map) {
    let out = text;
    let lost = 0;

    for (const m of map) {
      if (out.indexOf(m.token) >= 0) {
        out = out.split(m.token).join(m.to);
      } else {
        lost++;
      }
    }

    return { text: out, lost };
  }

  /* ---------------------------------------------------------------- */
  /* 翻译设置                                                          */
  /* ---------------------------------------------------------------- */

  function translateSettings() {
    const c = S.cfg || {};
    return {
      enabled: true,
      provider: c.provider || 'auto',
      targetLang: c.targetLang || 'zh-CN',
      sourceLang: 'auto',
      skipSameLang: c.skipSameLang !== false,
      display: c.display || 'below',
      fontSize: c.fontSize || 13,
      concurrency: c.concurrency || 4,
      timeout: c.timeout || 20000,
      retries: c.retries || 2,
      openaiBase: c.openaiBase || '',
      openaiKey: c.openaiKey || '',
      openaiModel: c.openaiModel || '',
      googleEndpoint: c.googleEndpoint || '',
      libreUrl: c.libreUrl || '',
      libreKey: c.libreKey || '',
      mymemoryEmail: c.mymemoryEmail || '',
      caiyunToken: c.caiyunToken || '',
      channelWhitelist: c.channelWhitelist || [],
      userBlacklist: c.userBlacklist || [],
      // LLM 走提示词注入术语，不用占位符那套
      glossary: c.glossary || [],
      selectionTranslate: c.selectionTranslate !== false,
      composerTranslate: c.composerTranslate !== false,
      composerAutoSend: !!c.composerAutoSend,
      outgoingLang: c.outgoingLang || 'en'
    };
  }

  /* ---------------------------------------------------------------- */
  /* Rust HTTP 通道（engine.js 通过 __DT_FETCH__ 使用）                 */
  /* ---------------------------------------------------------------- */

  window.__DT_FETCH__ = async function (url, init) {
    const opts = init || {};
    const res = await invoke('http_request', {
      url,
      method: opts.method || 'GET',
      headers: opts.headers || null,
      body: typeof opts.body === 'string' ? opts.body : null,
      timeout: 25000
    });

    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      text: async () => res.body,
      json: async () => JSON.parse(res.body)
    };
  };

  /* ---------------------------------------------------------------- */
  /* CDP 客户端                                                        */
  /* ---------------------------------------------------------------- */

  function cdpSend(method, params) {
    return new Promise((resolve, reject) => {
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(t('CDP 未连接')));
        return;
      }
      const id = ++S.msgId;
      S.pending.set(id, { resolve, reject });
      S.ws.send(JSON.stringify({ id, method, params: params || {} }));

      setTimeout(() => {
        if (S.pending.has(id)) {
          S.pending.delete(id);
          reject(new Error(t('CDP 超时: ') + method));
        }
      }, 30000);
    });
  }

  async function cdpEvaluate(expression, awaitPromise) {
    const r = await cdpSend('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: !!awaitPromise
    });
    if (r && r.exceptionDetails) {
      throw new Error(
        (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
          r.exceptionDetails.text
      );
    }
    return r && r.result ? r.result.value : undefined;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * 找到 Discord 主窗口的 CDP target。
   * Discord 刚启动时页面还在加载，需要轮询等待。
   */
  async function findDiscordTarget(port, attempts) {
    const max = attempts || 1;

    for (let i = 0; i < max; i++) {
      try {
        const res = await invoke('http_request', {
          url: `http://127.0.0.1:${port}/json/list`,
          method: 'GET',
          headers: null,
          body: null,
          timeout: 4000
        });
        const pages = JSON.parse(res.body).filter(
          (t) => t.type === 'page' && typeof t.url === 'string'
        );

        // 优先主窗口：/channels/ 才是真正的聊天界面
        const main = pages.find((t) => /discord\.com\/channels\//.test(t.url));
        if (main) return main;

        // 其次任何 discord 页面，排除弹窗/登录/验证这类干扰项
        const usable = pages.find(
          (t) => /discord\.com/.test(t.url) && !/\/popout|login|verify|splash/.test(t.url)
        );
        if (usable && i >= 2) return usable;

        const any = pages.find((t) => /discord\.com/.test(t.url));
        if (any && i >= 5) return any;
      } catch (e) {
        /* 端口还没起来，继续等 */
      }

      if (i < max - 1) await sleep(1500);
    }

    return null;
  }

  /* ---------------------------------------------------------------- */
  /* 注入                                                              */
  /* ---------------------------------------------------------------- */

  function wrapModule(src) {
    return `(function(module, exports, require){\n${src}\n})(undefined, undefined, undefined);`;
  }

  const SHIM = `
(function () {
  window.__dtReplies = window.__dtReplies || {};
  window.__dtSeq = window.__dtSeq || 0;

  if (!window.__dtTranslate) {
    window.__dtTranslate = function (texts, s) {
      return new Promise(function (resolve) {
        var id = 'r' + (++window.__dtSeq);
        window.__dtReplies[id] = resolve;
        try {
          window.${BINDING}(JSON.stringify({ id: id, texts: texts, settings: s }));
        } catch (e) {
          resolve(texts.map(function () {
            return { ok: false, error: t('IPC 不可用: ') + e.message };
          }));
        }
      });
    };
  }

  if (!window.__dtReply) {
    window.__dtReply = function (id, payload) {
      var fn = window.__dtReplies[id];
      if (!fn) return false;
      delete window.__dtReplies[id];
      fn(payload);
      return true;
    };
  }

  window.__dtSetCfg = function (patch) {
    window.__dtCfg = Object.assign(window.__dtCfg || {}, patch);
    if (window.DTDom) window.DTDom.updateSettings(window.__dtCfg);
  };

  return true;
})();
`;

  async function injectAll() {
    // 清掉旧实例，避免多套 MutationObserver 同时工作
    await cdpEvaluate(`
      (function () {
        try { if (window.DTDom && window.DTDom.stop) window.DTDom.stop(); } catch (e) {}
        var olds = document.querySelectorAll('.dt-trans');
        for (var i = 0; i < olds.length; i++) { try { olds[i].remove(); } catch (e) {} }
        return true;
      })()
    `);

    await cdpEvaluate(wrapModule(ENGINE_SRC));
    await cdpEvaluate(wrapModule(DOM_SRC));

    await cdpEvaluate(`
      (function () {
        var el = document.getElementById('dt-style');
        if (!el) {
          el = document.createElement('style');
          el.id = 'dt-style';
          (document.head || document.documentElement).appendChild(el);
        }
        el.textContent = ${JSON.stringify(CSS_SRC)};
        return el.textContent.length;
      })()
    `);

    await cdpEvaluate(SHIM);

    const cfg = translateSettings();
    cfg.enabled = S.enabled;
    await cdpEvaluate(
      `(function(){ window.__dtCfg = ${JSON.stringify(cfg)}; return true; })()`
    );

    await cdpEvaluate(`
      (function () {
        if (!window.DTDom) return 'no DTDom';
        window.DTDom.start({
          translate: window.__dtTranslate,
          getSettings: function () { return window.__dtCfg; },
          onError: function (key, err, src) {
            window.__dtErrorReport && window.__dtErrorReport(key, err, src);
          }
        });
        return 'ok';
      })()
    `);
  }

  /* ---------------------------------------------------------------- */
  /* 翻译请求处理                                                      */
  /* ---------------------------------------------------------------- */

  /** 稳定 hash：把 provider / 目标语言 / 术语表 / 原文一起算进去 */
  function hashText(text, settings) {
    const g = (S.cfg && S.cfg.glossary) || [];
    const key = [
      settings.provider,
      settings.targetLang,
      g.map((x) => x.from + '>' + x.to).join(','),
      text
    ].join('\u0001');

    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 + c, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  async function handleTranslate(msg) {
    // 页面可以覆盖部分设置（发送前翻译会临时把 targetLang 改成英文），
    // 之前这里直接用 translateSettings() 把页面传来的设置整个丢掉了，
    // 导致"翻成英文"实际还是按中文目标翻译，译文等于原文。
    const settings = Object.assign({}, translateSettings(), msg.settings || {});
    const limit = (S.cfg && S.cfg.dailyRequestLimit) || 0;

    if (limit > 0 && S.usage.requests >= limit) {
      const blocked = msg.texts.map(() => ({
        ok: false,
        error: t('已达每日请求上限（{n}）', { n: limit })
      }));
      await cdpEvaluate(
        `window.__dtReply(${JSON.stringify(msg.id)}, ${JSON.stringify(blocked)})`
      ).catch(() => {});
      return;
    }

    const glossary = (S.cfg && S.cfg.glossary) || [];

    // LLM（openai / ollama）把术语表写进提示词，不再做占位符替换 ——
    // 替换会把句子拆开，反而让译文变生硬；提示词方案命中率同样是 100%。
    const usePromptGlossary = settings.provider === 'openai';

    const prepared = msg.texts.map((t) =>
      usePromptGlossary ? { text: t, map: [] } : applyGlossary(t, glossary)
    );
    const hashes = prepared.map((p) => hashText(p.text, settings));

    // ---- 1. 先查 SQLite 持久化缓存 ----
    const results = new Array(msg.texts.length).fill(null);
    const cachedHits = await Promise.all(
      hashes.map((h) => invoke('cache_get', { hash: h }).catch(() => null))
    );

    const todo = [];
    for (let i = 0; i < msg.texts.length; i++) {
      if (cachedHits[i]) {
        results[i] = { ok: true, text: cachedHits[i], detected: '', cached: true };
      } else {
        todo.push(i);
      }
    }

    // ---- 2. 未命中的走引擎 ----
    if (todo.length > 0) {
      const todoTexts = todo.map((i) => prepared[i].text);
      let out;
      try {
        out = await DTEngine.translate(todoTexts, settings);
      } catch (e) {
        out = todoTexts.map(() => ({ ok: false, error: String((e && e.message) || e) }));
      }

      for (let k = 0; k < todo.length; k++) {
        const i = todo[k];
        const r = out[k] || { ok: false, error: t('无结果') };
        results[i] = r;
        if (r.ok && r.text) {
          invoke('cache_put', {
            hash: hashes[i],
            src: prepared[i].text,
            dst: r.text,
            provider: r.provider || ''
          }).catch(() => {});
        }
      }

      const chars = todoTexts.reduce((n, t) => n + String(t || '').length, 0);
      invoke('usage_add', { requests: 1, chars, messages: todo.length })
        .then(() => refreshUsage())
        .catch(() => {});
    }

    // ---- 3. 还原术语 ----
    let lostTotal = 0;

    const final = results.map((r, i) => {
      if (!r) return { ok: false, error: t('无结果') };
      if (r.ok && r.text && !r.cached) {
        const out = restoreGlossary(r.text, prepared[i].map);
        lostTotal += out.lost;
        if (out.text !== r.text) return Object.assign({}, r, { text: out.text });
      }
      return r;
    });

    // 占位符被模型改写：说明当前引擎不遵守标记，提示一次就好
    if (lostTotal > 0 && !S.glossaryLostWarned) {
      S.glossaryLostWarned = true;
      log(
        'WARN',
        t('{n} 个术语占位符被当前翻译引擎改写，术语表未生效。', { n: lostTotal }) +
          t('本地小模型（LibreTranslate）对术语表支持有限，建议改用腾讯 / DeepSeek / Ollama。')
      );
      setHint(t('当前翻译引擎不支持术语占位符，术语表未生效。建议换腾讯 / DeepSeek / Ollama。'), true);
    }

    const bad = final.filter((r) => r && !r.ok).length;
    if (bad > 0) {
      const first = final.find((r) => r && r.error);
      S.lastError = first ? first.error : '';
      log('WARN', t('{bad}/{total} 条翻译失败: {err}', { bad: bad, total: final.length, err: S.lastError }));
    }

    await cdpEvaluate(
      `window.__dtReply(${JSON.stringify(msg.id)}, ${JSON.stringify(final)})`
    ).catch((e) => log('ERROR', t('回填失败: ') + e.message));
  }

  /* ---------------------------------------------------------------- */
  /* 连接                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * @param {boolean} userInitiated 用户点了按钮（允许启动 Discord）
   * @param {boolean} internal      内部递归调用，穿过防重入锁
   */
  async function connect(userInitiated, internal) {
    if (S.connecting && !internal) {
      log('WARN', t('已有连接流程进行中，忽略本次请求'));
      return;
    }
    S.connecting = true;

    const btn = $('btnConnect');
    btn.disabled = true;
    setHint('');

    try {
      const st = await invoke('discord_status');
      S.port = (S.cfg && S.cfg.cdpPort) || st.port || 9223;

      if (!st.installed) {
        setStatus('err', t('未安装 Discord'), t('找不到 %LOCALAPPDATA%\\Discord'));
        setHint('请先安装 Discord 桌面版。', true);
        return;
      }

      // 需要（重新）启动 Discord 的两种情况：
      //   - 端口没开：Discord 没带调试端口运行
      //   - forceRestart：用户点了按钮 / 握手被拒后需要重新授权
      if (!st.portOpen) {
        if (!userInitiated) {
          // 启动时只做提示，绝不擅自启动或杀进程
          setStatus('warn', t('未连接'), st.running ? t('Discord 未开启调试端口') : t('Discord 未运行'));
          setHint(
            st.running
              ? t('Discord 正在运行但未开启翻译所需的调试端口。点上面按钮会重启 Discord——当前语音通话会中断，未发送的草稿会丢失。')
              : t('Discord 没有运行。点击按钮会启动它并开启调试端口。')
          );
          btn.textContent = st.running ? t('重启 Discord 并连接') : t('启动 Discord 并连接');
          return;
        }

        setStatus('busy', t('正在启动 Discord…'), t('首次启动约需 10–20 秒'));
        btn.textContent = t('正在连接…');
        log('INFO', t('开始启动 Discord（会先关闭现有进程）'));

        const r = await invoke('start_discord', { port: S.port });
        S.port = r.port;
        log('INFO', t('Discord 就绪：端口 {port}，方式 {mode}，耗时 {ms}ms', { port: r.port, mode: r.mode, ms: r.elapsedMs }));

        // 端口可能因被占用而顺延，写回配置，下次直接用对的
        if (S.cfg && r.port !== S.cfg.cdpPort) {
          saveCfg({ cdpPort: r.port });
          $('dPort').textContent = String(r.port);
        }
      }

      if (!S.cdpReady) {
        setStatus('busy', t('等待 Discord 页面…'), t('正在加载聊天界面'));
      }

      const target = await findDiscordTarget(S.port, 24);
      if (!target) {
        setStatus('err', t('连接失败'), t('Discord 页面未就绪'));
        setHint('Discord 可能还在加载，稍等几秒再点一次。', true);
        log('ERROR', t('等待 Discord 页面超时'));
        return;
      }

      S.pageUrl = target.url;

      try {
        await openWebSocket(target.webSocketDebuggerUrl);
      } catch (wsErr) {
        // 端口开着但握手被拒：几乎一定是 Discord 没带 --remote-allow-origins 启动。
        // 自动重启一次（只一次，避免无限循环）。
        if (!S.autoRestarted) {
          S.autoRestarted = true;
          log('WARN', t('握手被拒，重启 Discord 以开启调试权限'));
          setStatus('busy', t('正在重启 Discord…'), t('需要重新授权调试连接'));
          S.connecting = false;
          return connect(true, true);
        }
        throw wsErr;
      }
    } catch (e) {
      setStatus('err', t('连接失败'), String((e && e.message) || e));
      setHint('连接出错：' + ((e && e.message) || e), true);
      log('ERROR', t('连接失败: ') + ((e && e.message) || e));
    } finally {
      S.connecting = false;
      btn.disabled = false;
      if (!S.cdpReady) btn.textContent = t('连接 Discord');
    }
  }

  function openWebSocket(wsUrl) {
    return new Promise((resolve, reject) => {
      if (S.ws) {
        try {
          S.ws.close();
        } catch (e) {
          /* ignore */
        }
        S.ws = null;
      }

      const ws = new WebSocket(wsUrl);
      S.ws = ws;
      let opened = false;

      const failTimer = setTimeout(() => {
        if (!opened) {
          try {
            ws.close();
          } catch (e) {
            /* ignore */
          }
          reject(new Error(t('WebSocket 连接超时')));
        }
      }, 8000);

      ws.onopen = async () => {
        opened = true;
        clearTimeout(failTimer);
        try {
          await cdpSend('Runtime.enable');
          await cdpSend('Page.enable');
          await cdpSend('Runtime.addBinding', { name: BINDING });
          await injectAll();

          S.cdpReady = true;
          S.autoRestarted = false;
          setStatus('ok', t('已连接'), shortUrl(S.pageUrl));
          $('subtitle').textContent = S.enabled ? t('翻译已开启') : t('翻译已暂停');
          setHint(t('译文会显示在每条消息下方。关闭窗口后仍在托盘运行。'));
          $('btnConnect').textContent = t('重新连接');
          log('INFO', t('已注入到 Discord: ') + S.pageUrl);
          startPolling();
          selfCheck();
          resolve();
        } catch (e) {
          S.cdpReady = false;
          setStatus('err', t('注入失败'), String((e && e.message) || e));
          log('ERROR', t('注入失败: ') + ((e && e.message) || e));
          reject(e);
        }
      };

      ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }

        if (m.id && S.pending.has(m.id)) {
          const { resolve: res, reject: rej } = S.pending.get(m.id);
          S.pending.delete(m.id);
          if (m.error) rej(new Error(m.error.message));
          else res(m.result);
          return;
        }

        if (m.method === 'Runtime.bindingCalled' && m.params.name === BINDING) {
          let msg;
          try {
            msg = JSON.parse(m.params.payload);
          } catch (e) {
            return;
          }
          handleTranslate(msg);
          return;
        }

        if (m.method === 'Runtime.executionContextsCleared') {
          log('WARN', t('检测到 Discord 页面重载，2 秒后重新注入'));
          setTimeout(async () => {
            try {
              await injectAll();
              cdpEvaluate('location.href').then((u) => {
                if (u) {
                  S.pageUrl = u;
                  setStatus('ok', t('已连接'), shortUrl(u));
                }
              });
              log('INFO', t('重新注入完成'));
            } catch (e) {
              log('ERROR', t('重新注入失败: ') + e.message);
            }
          }, 2000);
        }
      };

      ws.onclose = () => {
        S.cdpReady = false;
        stopPolling();
        if (S.ws === ws) {
          S.ws = null;
          setStatus('warn', t('连接已断开'), t('正在尝试重连…'));
          $('btnConnect').textContent = t('连接 Discord');
          log('WARN', t('CDP 连接已断开'));
          scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (!opened) {
          clearTimeout(failTimer);
          reject(
            new Error(
              t('调试端口拒绝了本程序的连接。Discord 必须由本程序启动（需要 --remote-allow-origins），请点【重启 Discord 并连接】')
            )
          );
        }
      };
    });
  }

  function shortUrl(u) {
    if (!u) return '';
    if (S.channelName) return S.channelName;
    const m = String(u).match(/\/channels\/(\d+)\/(\d+)/);
    if (m) return t('频道 {name}', { name: m[2] });
    if (String(u).indexOf('@me') >= 0) return t('私信');
    return String(u).slice(0, 48);
  }

  /* ---------------------------------------------------------------- */
  /* 系统通知                                                          */
  /* ---------------------------------------------------------------- */

  function notify(title, body) {
    try {
      const api = window.__TAURI__ && window.__TAURI__.notification;
      if (api && typeof api.sendNotification === 'function') {
        api.sendNotification({ title, body }).catch(() => {});
      }
    } catch (e) {
      /* 通知失败不影响主流程 */
    }
  }

  /* ---------------------------------------------------------------- */
  /* 断线自动重连                                                      */
  /* ---------------------------------------------------------------- */

  function scheduleReconnect() {
    if (S.reconnectTimer) return;
    S.autoReconnect = true;
    S.deadChecks = 0;
    S.reconnectTimer = setTimeout(reconnectTick, 3000);
  }

  function stopReconnect() {
    if (S.reconnectTimer) {
      clearTimeout(S.reconnectTimer);
      S.reconnectTimer = null;
    }
  }

  async function reconnectTick() {
    S.reconnectTimer = null;
    if (S.cdpReady || !S.autoReconnect) return;

    try {
      const st = await invoke('discord_status');

      if (st.portOpen) {
        S.deadChecks = 0;
        log('INFO', t('自动重连：调试端口在线，尝试连接'));
        await connect(false, true);
        if (S.cdpReady) {
          S.autoReconnect = false;
          notify(t('翻译已恢复'), t('已重新连接到 Discord。'));
          return;
        }
      } else if (st.running) {
        // Discord 在跑但没有调试端口 —— 多半是它自己重启/更新了
        S.deadChecks++;
        if (S.deadChecks >= 3) {
          S.autoReconnect = false;
          setStatus('warn', t('需要重新连接'), t('Discord 重启后未开启调试端口'));
          setHint('Discord 重新启动了，但没有调试端口。点【重启 Discord 并连接】恢复（语音会断）。');
          notify(t('Discord 重启了，翻译已断开'), t('Discord 重启后没有开启调试端口。打开本程序点【重启 Discord 并连接】即可恢复。'));
          log('WARN', t('Discord 重启且无调试端口，停止自动重连'));
          return;
        }
      } else {
        // Discord 没在跑，继续等它起来
        setStatus('warn', t('等待 Discord'), t('Discord 未运行'));
      }
    } catch (e) {
      /* 忽略，下一轮再试 */
    }

    if (S.autoReconnect && !S.cdpReady) {
      S.reconnectTimer = setTimeout(reconnectTick, 5000);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 轮询状态                                                          */
  /* ---------------------------------------------------------------- */

  const STATS_EXPR = `
(function () {
  var lis = document.querySelectorAll('li[id^="chat-messages-"]');
  var seg = location.pathname.split('/');
  var chId = seg[3] || '';
  var chName = '';
  if (chId) {
    var item = document.querySelector('[data-list-item-id$="' + chId + '"]');
    if (item) chName = item.getAttribute('aria-label') || '';
  }
  return JSON.stringify({
    total: lis.length,
    rendered: document.querySelectorAll('.dt-trans').length,
    injected: typeof window.DTDom === 'object' && !!document.getElementById('dt-style'),
    stats: window.DTDom ? window.DTDom.stats() : null,
    url: location.href,
    channelId: chId,
    channelName: chName
  });
})()
`;

  function startPolling() {
    stopPolling();
    S.pollTimer = setInterval(poll, POLL_MS);
    poll();
  }

  function stopPolling() {
    if (S.pollTimer) {
      clearInterval(S.pollTimer);
      S.pollTimer = null;
    }
  }

  async function poll() {
    if (!S.cdpReady) return;
    try {
      const raw = await cdpEvaluate(STATS_EXPR);
      const d = JSON.parse(raw || '{}');
      S.lastStats = {
        total: d.total || 0,
        rendered: d.rendered || 0,
        inFlight: (d.stats && d.stats.inFlight) || 0,
        queued: (d.stats && d.stats.queued) || 0
      };
      if (d.url && d.url !== S.pageUrl) {
        S.pageUrl = d.url;
        setStatus('ok', t('已连接'), shortUrl(d.url));
      }

      const chId = d.channelId || '';
      if (chId !== S.channelId) {
        S.channelId = chId;
        S.channelName = d.channelName || '';
        setStatus('ok', t('已连接'), S.channelName || shortUrl(d.url));
        updateChannelUI();
      } else if (d.channelName && d.channelName !== S.channelName) {
        S.channelName = d.channelName;
        setStatus('ok', t('已连接'), S.channelName);
        updateChannelUI();
      }

      // Discord 是 SPA：从启动画面切到频道不会触发 executionContextsCleared，
      // 注入可能已经丢了，靠轮询发现并补回去。
      if (!d.injected && !S.reinjecting) {
        S.reinjecting = true;
        log('WARN', t('注入已丢失（页面路由切换），正在重新注入'));
        setTimeout(async () => {
          try {
            await injectAll();
            log('INFO', t('重新注入完成'));
          } catch (e) {
            log('ERROR', t('重新注入失败: ') + e.message);
          } finally {
            S.reinjecting = false;
          }
        }, 700);
      }

      renderMetrics();
      refreshCacheStat(false);
    } catch (e) {
      /* 轮询失败不打扰用户 */
    }
  }

  async function refreshUsage() {
    try {
      S.usage = await invoke('usage_get');
      renderMetrics();
    } catch (e) {
      /* ignore */
    }
  }

  function renderMetrics() {
    const st = S.lastStats;
    $('mTranslated').textContent = st.rendered;
    $('mTotal').textContent = st.total;
    $('mUsage').textContent = S.usage.requests;

    const prov = (S.cfg && S.cfg.provider) || 'auto';
    const map = {
      auto: t('自动'),
      tencent: t('腾讯'),
      google: 'Google',
      caiyun: t('彩云'),
      mymemory: 'MyMemory',
      openai: t('大模型'),
      libre: 'Libre'
    };
    $('mProvider').textContent = map[prov] || prov;
  }

  /* ---------------------------------------------------------------- */
  /* 主题                                                              */
  /* ---------------------------------------------------------------- */

  let themeMedia = null;

  function applyTheme() {
    const mode = (S.cfg && S.cfg.theme) || 'system';
    let actual = mode;
    if (mode === 'system') {
      actual = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = actual;
  }

  function watchSystemTheme() {
    if (themeMedia) return;
    themeMedia = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (((S.cfg && S.cfg.theme) || 'system') === 'system') applyTheme();
    };
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', onChange);
    else if (themeMedia.addListener) themeMedia.addListener(onChange);
  }

  function updateChannelUI() {
    if (!S.cfg) return;

    const has = !!S.channelId;
    const wl = S.cfg.channelWhitelist || [];
    const inList = has && wl.indexOf(S.channelId) >= 0;

    $('chName').textContent = has ? S.channelName || S.channelId : t('未在频道内');
    $('btnCurOnly').disabled = !has;
    $('btnAddWhite').disabled = !has;
    $('btnRemoveWhite').disabled = !inList;

    const state = $('chState');
    if (!has) {
      state.textContent = t('打开一个文字频道后可以把它单独加入白名单。');
      state.className = 'note';
    } else if (wl.length === 0) {
      state.textContent = t('白名单为空，当前所有频道都会翻译。');
      state.className = 'note';
    } else if (inList) {
      state.textContent = t('已在白名单中（共 {n} 个频道）。', { n: wl.length });
      state.className = 'note';
    } else {
      state.textContent = t('当前频道不在白名单里，这个频道不会翻译（共 {n} 个频道在白名单）。', { n: wl.length });
      state.className = 'note warn';
    }
  }

  async function refreshLibreDetail(running) {
    const el = $('libreDetail');
    const meta = $('libreMeta');

    try {
      const info = await invoke('libre_info');

      // Docker daemon 没起来时读不到容器，这跟「没装」是两回事
      if (!info.dockerRunning) {
        meta.textContent = t('Docker 未运行');
        el.textContent = t(
          'Docker Desktop 没有运行，读不到容器状态。启动 Docker 后这里会显示已装的语言包。'
        );
        $('btnUninstallLibre').disabled = true;
        return;
      }

      $('btnUninstallLibre').disabled = false;

      if (!info.installed) {
        meta.textContent = t('未部署');
        el.textContent = t('还没有部署。点下面的按钮会自动拉镜像、起容器并填好地址。');
        $('btnDeployLibre').textContent = t('部署 LibreTranslate');
        return;
      }

      const langs = (info.languages || []).join(', ') || t('未知');
      meta.textContent = running ? t('运行中') : t('已停止');
      el.textContent =
        t('{n} 个语言包（{langs}）', { n: info.models, langs: langs }) +
        (info.imageSize ? t(' · 镜像 {size}', { size: info.imageSize }) : '');
    } catch (e) {
      meta.textContent = t('读取失败');
      el.textContent = String((e && e.message) || e);
    }
  }

  async function refreshOllamaDetail(running) {
    const el = $('ollamaDetail');
    const meta = $('ollamaMeta');

    try {
      const info = await invoke('ollama_info');

      if (!info.installed) {
        meta.textContent = t('未安装');
        el.textContent = t('还没有安装。点下面的按钮会用 winget 自动安装并下载 qwen2.5:3b（约 2GB）。');
        return;
      }

      const models = info.models || [];

      if (!models.length) {
        meta.textContent = t('无模型');
        el.textContent = t('Ollama 已安装，但没有已下载的模型。点下面的按钮下载 qwen2.5:3b（约 2GB）。');
        $('btnUninstallOllama').disabled = true;
        return;
      }

      $('btnUninstallOllama').disabled = false;
      meta.textContent = running ? t('运行中') : t('已停止');

      const list = models.map((m) => `${m.name}（${m.size}）`).join('、');
      el.textContent = t('已装模型：{list}', { list: list });
    } catch (e) {
      meta.textContent = t('读取失败');
      el.textContent = String((e && e.message) || e);
    }
  }

  async function refreshShortcut() {
    try {
      const s = await invoke('shortcut_info');
      const on = !!s.takenOver;
      $('scDot').className = 'dot ' + (on ? 'ok' : '');
      $('scText').textContent = on
        ? t('已接管：点 Discord 图标会经本程序启动')
        : t('未接管：点 Discord 图标启动的客户端无法翻译');
    } catch (e) {
      $('scText').textContent = t('读取快捷方式失败：') + ((e && e.message) || e);
    }
  }

  /** 各翻译源连通性，显示在诊断区 */
  async function renderProviderHealth() {
    const box = $('providerHealth');
    if (!box) return;
    box.textContent = t('检测中…');

    let list = [];
    try {
      list = await DTEngine.diagnose(translateSettings());
    } catch (e) {
      box.textContent = t('检测失败：') + ((e && e.message) || e);
      return;
    }

    box.innerHTML = '';
    for (const r of list) {
      const row = document.createElement('div');
      row.className = 'health-row';

      const dot = document.createElement('span');
      // 额度耗尽用黄色，和"网络不通"的红色区分开
      dot.className = 'dot ' + (r.ok ? 'ok' : r.quota ? 'warn' : 'err');

      const name = document.createElement('span');
      name.textContent = r.provider;

      const meta = document.createElement('span');
      meta.className = 'health-meta';
      meta.textContent = r.ok ? r.ms + 'ms' : r.error || t('不可用');

      row.appendChild(dot);
      row.appendChild(name);
      row.appendChild(meta);
      box.appendChild(row);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 本地引擎                                                          */
  /* ---------------------------------------------------------------- */

  let deployPollTimer = null;

  async function refreshLocalEnv() {
    $('eDocker').textContent = t('检测中…');
    $('eLibre').textContent = t('检测中…');
    $('eOllama').textContent = t('检测中…');

    try {
      const e = await invoke('local_engine_env');

      $('eDocker').textContent = e.docker
        ? e.dockerRunning
          ? t('已安装 · 运行中')
          : t('已安装 · 未启动')
        : t('未安装');

      $('eLibre').textContent = e.libreRunning ? t('运行中（127.0.0.1:5000）') : t('未运行');
      $('eOllama').textContent = e.ollamaRunning ? t('运行中（127.0.0.1:11434）') : t('未运行');

      if (e.libreRunning) {
        $('btnDeployLibre').textContent = t('已部署（重新部署）');
      }
      if (e.ollamaRunning) {
        $('btnDeployOllama').textContent = t('已部署（重新部署）');
      }

      // 各自引擎的详细信息：已装语言 / 已装模型
      refreshLibreDetail(e.libreRunning);
      refreshOllamaDetail(e.ollamaRunning);
    } catch (err) {
      $('eDocker').textContent = t('检测失败');
      log('ERROR', t('检测本地引擎失败: ') + ((err && err.message) || err));
    }
  }

  function watchDeploy() {
    if (deployPollTimer) return;

    deployPollTimer = setInterval(async () => {
      try {
        const st = await invoke('local_engine_state');
        if (!st.running && !st.done) return;

        $('deployMsg').textContent = st.message || '';

        if (st.done) {
          clearInterval(deployPollTimer);
          deployPollTimer = null;
          $('btnDeployLibre').disabled = false;
          $('btnDeployOllama').disabled = false;

          const isOllama = st.target === 'ollama';

          if (isOllama) {
            $('btnDeployOllama').textContent = st.ok ? t('已部署（重新部署）') : t('部署 Ollama');
          } else {
            $('btnDeployLibre').textContent = st.ok ? t('已部署（重新部署）') : t('部署 LibreTranslate');
          }

          setHint(st.ok ? t('本地引擎已就绪。') : t('部署未完成：') + st.message, !st.ok);
          log(st.ok ? 'INFO' : 'ERROR', t('本地引擎部署: ') + st.message);
          refreshLocalEnv();

          if (st.ok) {
            if (isOllama) {
              // Ollama 走 OpenAI 兼容接口
              $('provider').value = 'openai';
              $('openaiBlock').hidden = false;
              $('openaiBase').value = 'http://127.0.0.1:11434/v1';
              $('openaiKey').value = 'ollama';
              $('openaiModel').value = 'qwen2.5:3b';
              saveCfg({
                provider: 'openai',
                openaiBase: 'http://127.0.0.1:11434/v1',
                openaiKey: 'ollama',
                openaiModel: 'qwen2.5:3b'
              });
              setHint('已自动切到本地大模型（Ollama · qwen2.5:3b），完全不联网。');
            } else {
              $('provider').value = 'libre';
              $('openaiBlock').hidden = true;
              saveCfg({ provider: 'libre', libreUrl: 'http://127.0.0.1:5000' });
              setHint('已自动切到 LibreTranslate（http://127.0.0.1:5000）。');
            }
          }
        }
      } catch (err) {
        /* 轮询失败忽略 */
      }
    }, 1500);
  }

  let cacheTick = 0;

  async function refreshCacheStat(force) {
    if (!force && ++cacheTick % 5 !== 0) return;
    try {
      const r = await invoke('cache_stats');
      $('dCache').textContent = r.count + t(' 条');
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- */
  /* UI 绑定                                                           */
  /* ---------------------------------------------------------------- */

  const LANG_ORDER = [
    ['zh-CN', t('简体中文')],
    ['zh-TW', t('繁体中文')],
    ['en', t('英语')],
    ['ja', t('日语')],
    ['ko', t('韩语')],
    ['ru', t('俄语')],
    ['fr', t('法语')],
    ['de', t('德语')],
    ['es', t('西班牙语')]
  ];

  function fillLangs() {
    for (const id of ['targetLang', 'outgoingLang']) {
      const sel = $(id);
      if (!sel) continue;
      sel.innerHTML = '';
      for (const [code, label] of LANG_ORDER) {
        const o = document.createElement('option');
        o.value = code;
        o.textContent = label;
        sel.appendChild(o);
      }
    }
  }

  function bindUI() {
    $('power').addEventListener('click', () => {
      S.enabled = !S.enabled;
      $('power').classList.toggle('on', S.enabled);
      $('subtitle').textContent = S.enabled ? t('翻译已开启') : t('翻译已暂停');
      if (S.cdpReady) {
        cdpEvaluate(
          `(function(){ if (window.__dtSetCfg) window.__dtSetCfg({ enabled: ${S.enabled} }); return true; })()`
        ).catch(() => {});
      }
    });

    $('btnConnect').addEventListener('click', () => {
      S.autoRestarted = false;
      connect(true);
    });

    $('btnRetranslate').addEventListener('click', async () => {
      if (!S.cdpReady) {
        setHint('还没有连接到 Discord。', true);
        return;
      }
      try {
        await cdpEvaluate('(function(){ if(window.DTDom) window.DTDom.retranslateAll(); return true; })()');
        setHint('已重新翻译当前页面。');
      } catch (e) {
        setHint('重新翻译失败：' + e.message, true);
      }
    });

    $('provider').addEventListener('change', (e) => {
      $('openaiBlock').hidden = e.target.value !== 'openai';
      saveCfg({ provider: e.target.value });
    });

    $('targetLang').addEventListener('change', (e) => saveCfg({ targetLang: e.target.value }));
    $('display').addEventListener('change', (e) => saveCfg({ display: e.target.value }));
    $('fontSize').addEventListener('change', (e) => saveCfg({ fontSize: parseInt(e.target.value, 10) }));
    $('skipSameLang').addEventListener('change', (e) => saveCfg({ skipSameLang: e.target.checked }));
    $('dailyLimit').addEventListener('change', (e) =>
      saveCfg({ dailyRequestLimit: parseInt(e.target.value, 10) || 0 })
    );

    for (const id of ['openaiBase', 'openaiKey', 'openaiModel', 'mymemoryEmail']) {
      $(id).addEventListener('change', (e) => saveCfg({ [id]: e.target.value.trim() }));
    }

    $('whitelist').addEventListener('change', (e) =>
      saveCfg({ channelWhitelist: splitLines(e.target.value) })
    );
    $('userBlacklist').addEventListener('change', (e) =>
      saveCfg({ userBlacklist: splitLines(e.target.value) })
    );
    $('glossary').addEventListener('change', (e) => {
      const list = splitLines(e.target.value)
        .map((line) => {
          const i = line.indexOf('=');
          if (i <= 0) return null;
          return { from: line.slice(0, i).trim(), to: line.slice(i + 1).trim() };
        })
        .filter((x) => x && x.from);
      saveCfg({ glossary: list });
    });

    $('autostart').addEventListener('change', (e) => {
      saveCfg({ autostart: e.target.checked });
      invoke('plugin:autostart|' + (e.target.checked ? 'enable' : 'disable')).catch(() => {});
    });

    $('btnClearCache').addEventListener('click', async () => {
      await invoke('clear_cache');
      DTEngine.clearCache();
      if (S.cdpReady) {
        cdpEvaluate('(function(){ if(window.DTDom) window.DTDom.retranslateAll(); return true; })()').catch(
          () => {}
        );
      }
      setHint('缓存已清空（内存 + 数据库）。');
      refreshCacheStat(true);
    });

    $('btnOpenData').addEventListener('click', () => invoke('open_data_dir').catch(() => {}));

    $('btnCurOnly').addEventListener('click', () => {
      if (!S.channelId) return;
      saveCfg({ channelWhitelist: [S.channelId] });
      setHint(t('现在只翻译「{name}」。', { name: S.channelName || S.channelId }));
      log('INFO', t('白名单设为当前频道: ') + S.channelId);
      updateChannelUI();
    });

    $('btnAddWhite').addEventListener('click', () => {
      if (!S.channelId) return;
      const wl = (S.cfg.channelWhitelist || []).slice();
      if (wl.indexOf(S.channelId) < 0) wl.push(S.channelId);
      saveCfg({ channelWhitelist: wl });
      setHint(t('已加入白名单，共 {n} 个频道。', { n: wl.length }));
      updateChannelUI();
    });

    $('btnRemoveWhite').addEventListener('click', () => {
      if (!S.channelId) return;
      const wl = (S.cfg.channelWhitelist || []).filter((x) => x !== S.channelId);
      saveCfg({ channelWhitelist: wl });
      setHint(
        wl.length === 0
          ? t('白名单已清空，所有频道都会翻译。')
          : t('已移出白名单，剩 {n} 个。', { n: wl.length })
      );
      updateChannelUI();
    });

    $('btnRefreshEnv').addEventListener('click', refreshLocalEnv);

    $('btnCheckUpdate').addEventListener('click', () => checkUpdate(true));

    $('btnProbe').addEventListener('click', probePage);

    $('btnInstallUpdate').addEventListener('click', installUpdate);

    $('btnOpenRelease').addEventListener('click', () => {
      const url =
        (S.updateInfo && S.updateInfo.htmlUrl) ||
        'https://github.com/1584776265/discord-translator/releases/latest';
      invoke('open_url', { url }).catch((e) =>
        setHint(t('更新失败：') + ((e && e.message) || e), true)
      );
    });

    $('autoCheckUpdate').addEventListener('change', (e) =>
      saveCfg({ autoCheckUpdate: e.target.checked })
    );

    $('openNotesAfterUpdate').addEventListener('change', (e) =>
      saveCfg({ openNotesAfterUpdate: e.target.checked })
    );

    $('btnRollback').addEventListener('click', async () => {
      const v = (S.appInfo && S.appInfo.backup) || '';
      const ok = confirm(
        t('回滚到 {v}？\n\n程序会退出、把旧版本换回来，然后自动重新打开。\n配置和术语表不受影响。', {
          v: v
        })
      );
      if (!ok) return;

      setHint(t('正在回滚…'));
      try {
        const msg = await invoke('rollback_update');
        setHint(msg);
        log('INFO', msg);
      } catch (e) {
        setHint(t('回滚失败：') + ((e && e.message) || e), true);
      }
    });

    $('updateProxy').addEventListener('change', (e) =>
      saveCfg({ updateProxy: e.target.value.trim() })
    );

    // 换语言：Rust 侧在 save_config 里已同步，这里整页重载最省事，
    // 免得把几千条动态文案逐个重刷（状态行、引擎面板都是即时算出来的）
    $('language').addEventListener('change', async (e) => {
      await saveCfg({ language: e.target.value });
      window.location.reload();
    });

    $('btnUninstallLibre').addEventListener('click', async () => {
      const ok = confirm(
        t('卸载 LibreTranslate？\n\n') +
          t('会删除容器和镜像（约 1GB 磁盘）。\n') +
          t('Docker Desktop 本体不会被卸载，其他容器也不受影响。')
      );
      if (!ok) return;

      setHint('正在卸载 LibreTranslate…');
      try {
        const msg = await invoke('uninstall_libre', { removeImage: true });
        setHint(msg);
        log('INFO', msg);
        await refreshLocalEnv();
      } catch (e) {
        setHint('卸载失败：' + ((e && e.message) || e), true);
        log('ERROR', t('卸载 LibreTranslate 失败: ') + ((e && e.message) || e));
      }
    });

    $('btnUninstallOllama').addEventListener('click', async () => {
      let info;
      try {
        info = await invoke('ollama_info');
      } catch (e) {
        setHint('读取 Ollama 信息失败：' + ((e && e.message) || e), true);
        return;
      }

      const models = (info && info.models) || [];
      if (!models.length) {
        setHint('没有可删除的 Ollama 模型。');
        return;
      }

      // 优先删当前正在用的那个
      const wanted = (S.cfg && S.cfg.openaiModel) || '';
      const target = models.find((m) => m.name === wanted) || models[0];

      const ok = confirm(
        t('删除模型 {name}（{size}）？\n\n', { name: target.name, size: target.size }) +
          t('只删除模型文件，Ollama 程序本身保留。\n') +
          t('删掉后【部署 Ollama】需要重新下载约 2GB。')
      );
      if (!ok) return;

      const inUse =
        (S.cfg.provider || '') === 'openai' && (S.cfg.openaiModel || '') === target.name;

      setHint('正在删除模型…');
      try {
        const msg = await invoke('uninstall_ollama_model', { model: target.name });
        log('INFO', msg);

        // 删掉的正是当前在用的模型：不切走的话接下来每条都会失败
        if (inUse) {
          await saveCfg({ provider: 'auto' });
          setHint(msg + t('。当前翻译源已切回「自动」。'));
        } else {
          setHint(msg);
        }

        await refreshLocalEnv();
      } catch (e) {
        setHint('删除失败：' + ((e && e.message) || e), true);
      }
    });

    $('btnDeployOllama').addEventListener('click', async () => {
      const btn = $('btnDeployOllama');
      btn.disabled = true;
      $('deployMsg').textContent = t('正在准备部署 Ollama…');
      setHint('');
      try {
        await invoke('local_engine_deploy_ollama');
        watchDeploy();
      } catch (e) {
        btn.disabled = false;
        setHint('部署启动失败：' + ((e && e.message) || e), true);
      }
    });

    $('btnDeployLibre').addEventListener('click', async () => {
      const btn = $('btnDeployLibre');
      btn.disabled = true;
      $('deployMsg').textContent = t('正在准备部署…');
      setHint('');
      try {
        await invoke('local_engine_deploy');
        watchDeploy();
      } catch (e) {
        btn.disabled = false;
        setHint('部署启动失败：' + ((e && e.message) || e), true);
      }
    });

    $('theme').addEventListener('change', (e) => {
      saveCfg({ theme: e.target.value });
      applyTheme();
    });

    $('channel').addEventListener('change', (e) => {
      const label = e.target.selectedOptions[0].textContent;
      saveCfg({ channel: e.target.value });
      setHint(t('已切换为 {label}，重新连接后生效。', { label: label }));
      log('INFO', t('Discord 渠道切换为 ') + e.target.value);
    });

    $('btnPruneCache').addEventListener('click', async () => {
      try {
        const r = await invoke('prune_cache', { days: 7 });
        setHint(t('已清理 7 天前的缓存，剩余 {n} 条。', { n: r.remaining }));
        refreshCacheStat(true);
      } catch (e) {
        setHint('清理失败：' + e.message, true);
      }
    });

    $('btnPresetGlossary').addEventListener('click', async () => {
      const cur = (S.cfg.glossary || []).slice();
      const existing = new Set(cur.map((g) => String(g.from || '').toLowerCase()));

      let added = 0;
      for (const item of RECOMMENDED_GLOSSARY) {
        if (!existing.has(item.from.toLowerCase())) {
          cur.push(item);
          added++;
        }
      }

      await saveCfg({ glossary: cur });
      $('glossary').value = cur.map((g) => `${g.from}=${g.to}`).join('\n');
      setHint(
        added > 0
          ? t('已添加 {n} 条推荐术语（共 {total} 条），对本地小模型效果最明显。', {
            n: added,
            total: cur.length
          })
          : t('推荐术语已经全部存在了。')
      );
      log('INFO', t('加载推荐术语表，新增 {n} 条', { n: added }));
    });

    $('btnImportGlossary').addEventListener('click', async () => {
      try {
        const path = await window.__TAURI__.dialog.open({
          title: t('导入术语表'),
          multiple: false,
          filters: [{ name: t('文本文件'), extensions: ['txt'] }]
        });
        if (!path) return;

        const list = await invoke('import_glossary', { path });
        await saveCfg({ glossary: list });
        $('glossary').value = list.map((g) => `${g.from}=${g.to}`).join('\n');
        setHint(t('已导入 {n} 条术语。', { n: list.length }));
      } catch (e) {
        setHint('导入失败：' + ((e && e.message) || e), true);
      }
    });

    $('btnExportGlossary').addEventListener('click', async () => {
      try {
        const path = await window.__TAURI__.dialog.save({
          title: t('导出术语表'),
          defaultPath: 'discord-translator-glossary.txt',
          filters: [{ name: t('文本文件'), extensions: ['txt'] }]
        });
        if (!path) return;

        const n = await invoke('export_glossary', { cfg: S.cfg, path });
        setHint(t('已导出 {n} 条术语。', { n: n }));
      } catch (e) {
        setHint('导出失败：' + ((e && e.message) || e), true);
      }
    });

    $('selectionTranslate').addEventListener('change', (e) =>
      saveCfg({ selectionTranslate: e.target.checked })
    );
    $('composerTranslate').addEventListener('change', (e) =>
      saveCfg({ composerTranslate: e.target.checked })
    );
    $('composerAutoSend').addEventListener('change', (e) =>
      saveCfg({ composerAutoSend: e.target.checked })
    );
    $('outgoingLang').addEventListener('change', (e) =>
      saveCfg({ outgoingLang: e.target.value })
    );

    $('btnTakeover').addEventListener('click', async () => {
      try {
        const r = await invoke('takeover_shortcut');
        setHint(t('已接管 {n} 个快捷方式，现在点 Discord 图标即可带翻译启动。', { n: r.count }));
        log('INFO', t('接管快捷方式 {n} 个', { n: r.count }));
        await refreshShortcut();
      } catch (e) {
        setHint('接管失败：' + e.message, true);
        log('ERROR', t('接管快捷方式失败: ') + e.message);
      }
    });

    $('btnRestore').addEventListener('click', async () => {
      try {
        const r = await invoke('restore_shortcut');
        setHint(t('已还原 {n} 个快捷方式。', { n: r.count }));
        log('INFO', t('还原快捷方式 {n} 个', { n: r.count }));
        await refreshShortcut();
      } catch (e) {
        setHint('还原失败：' + e.message, true);
      }
    });

    $('btnTest').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = t('测试中…');
      try {
        const r = await DTEngine.test(translateSettings());
        if (r.ok)
      setHint(
        t('翻译源正常 · [{provider}] {ms}ms → {text}', { provider: r.provider, ms: r.ms, text: r.text })
      );
        else setHint('测试失败：' + (r.error || t('无返回')), true);
        log(
      r.ok ? 'INFO' : 'ERROR',
      t('测试翻译源: {text}', { text: r.ok ? 'OK ' + r.ms + 'ms' : r.error })
    );
        renderProviderHealth();
      } catch (err) {
        setHint('测试失败：' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = t('测试翻译源');
      }
    });
  }

  function splitLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function saveCfg(patch) {
    S.cfg = Object.assign({}, S.cfg || {}, patch);
    try {
      await invoke('save_config', { cfg: S.cfg });
      if (S.cdpReady) {
        const cfg = translateSettings();
        cfg.enabled = S.enabled;
        await cdpEvaluate(
          `(function(){ if (window.__dtSetCfg) window.__dtSetCfg(${JSON.stringify(cfg)}); return true; })()`
        );
      }
      renderMetrics();
    } catch (e) {
      setHint('保存配置失败：' + e.message, true);
    }
  }

  function applyCfgToUI() {
    const c = S.cfg;
    $('targetLang').value = c.targetLang || 'zh-CN';
    $('provider').value = c.provider || 'auto';
    $('display').value = c.display || 'below';
    $('fontSize').value = String(c.fontSize || 13);
    $('skipSameLang').checked = c.skipSameLang !== false;
    $('dailyLimit').value = c.dailyRequestLimit || 0;
    $('openaiBase').value = c.openaiBase || '';
    $('openaiKey').value = c.openaiKey || '';
    $('openaiModel').value = c.openaiModel || '';
    $('mymemoryEmail').value = c.mymemoryEmail || '';
    $('openaiBlock').hidden = (c.provider || 'auto') !== 'openai';
    $('whitelist').value = (c.channelWhitelist || []).join('\n');
    $('userBlacklist').value = (c.userBlacklist || []).join('\n');
    $('glossary').value = (c.glossary || []).map((g) => `${g.from}=${g.to}`).join('\n');
    $('selectionTranslate').checked = c.selectionTranslate !== false;
    $('composerTranslate').checked = c.composerTranslate !== false;
    $('composerAutoSend').checked = !!c.composerAutoSend;
    $('outgoingLang').value = c.outgoingLang || 'en';
    $('theme').value = c.theme || 'system';
    $('channel').value = c.channel || 'stable';
    $('language').value = c.language || 'auto';
    $('autoCheckUpdate').checked = c.autoCheckUpdate !== false;
    $('openNotesAfterUpdate').checked = c.openNotesAfterUpdate !== false;
    $('updateProxy').value = c.updateProxy || '';
    $('autostart').checked = !!c.autostart;
    applyTheme();
    $('dPort').textContent = String(c.cdpPort || 9223);
    $('dNet').textContent = DTEngine.networkInfo();
  }

  /* ---------------------------------------------------------------- */
  /* 语言与自动更新                                                    */
  /* ---------------------------------------------------------------- */

  async function applyLanguage() {
    try {
      S.appInfo = await invoke('app_info');
    } catch (e) {
      return;
    }

    if (window.DTI18n) {
      window.DTI18n.setLang(S.appInfo.lang);
      window.DTI18n.applyStatic();
    }

    $('verText').textContent = 'v' + (S.appInfo.version || '?');
    $('verMode').textContent = S.appInfo.installed ? t('安装版') : t('便携版');
    $('verDetail').textContent = S.appInfo.installed
      ? t('安装版：下载校验后静默升级，配置与术语表自动保留。')
      : t('便携版：只提示新版本，需要手动替换 exe。');

    // 有备份才显示回滚按钮（只有被自动更新替换过的版本才有）
    const rb = $('btnRollback');
    if (S.appInfo.backup) {
      rb.hidden = false;
      rb.textContent = t('回滚到 {v}', { v: S.appInfo.backup });
    } else {
      rb.hidden = true;
    }
  }

  async function checkUpdate(manual) {
    const btn = $('btnCheckUpdate');
    if (manual) {
      btn.disabled = true;
      btn.textContent = t('正在检查…');
    }

    $('btnInstallUpdate').hidden = true;
    $('btnOpenRelease').hidden = true;

    try {
      const info = await invoke('update_check');
      S.updateInfo = info;

      if (!info.hasUpdate) {
        $('verText').textContent = 'v' + info.currentVersion;
        $('verMode').textContent = t('已是最新版本');
        if (manual) setHint(t('已是最新版本'));
        return;
      }

      $('verText').textContent = 'v' + info.currentVersion + ' → v' + info.latestVersion;
      $('verMode').textContent = t('有新版本 {v}', { v: info.latestVersion });

      if (info.autoInstall) {
        $('btnInstallUpdate').hidden = false;
        if (manual) setHint(t('有新版本 {v}', { v: info.latestVersion }));
      } else {
        $('btnOpenRelease').hidden = false;
        if (manual) setHint(t('便携版请到发布页手动下载新版。'));
      }

      log('INFO', `update available: ${info.currentVersion} -> ${info.latestVersion}`);
    } catch (e) {
      const msg = String((e && e.message) || e);

      // 状态行只放一句「检查失败」，原始报错（可能很长）进提示条和日志
      $('verMode').textContent = t('检查失败');
      if (manual) setHint(t('检查失败：') + msg, true);
      log('WARN', 'update check failed: ' + msg);
      $('verDetail').textContent = msg.slice(0, 160);

      // 自动检查失败多半是代理/网络抖一下，隔 20 秒重试一次
      if (!manual && !S.updateRetried) {
        S.updateRetried = true;
        setTimeout(() => checkUpdate(false), 20000);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = t('检查更新');
    }
  }

  async function installUpdate() {
    const btn = $('btnInstallUpdate');
    btn.disabled = true;
    btn.textContent = t('正在下载更新…');
    setHint(t('正在下载并校验') + '…');

    try {
      const msg = await invoke('update_install');
      setHint(msg);
      log('INFO', msg);
      btn.textContent = t('更新已开始，程序即将重启');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = t('下载并安装');
      setHint(t('更新失败：') + ((e && e.message) || e), true);
      log('ERROR', 'update install failed: ' + ((e && e.message) || e));
    }
  }

  /* ---------------------------------------------------------------- */
  /* 注入自检与页面结构探测                                             */
  /* ---------------------------------------------------------------- */

  /**
   * 注入 15 秒后回头确认「注入层真的在工作」。
   * 没有这一步，Discord 改版时用户看到的只是「翻译没反应」，
   * 而界面一切正常，最后只能来问人。
   */
  async function selfCheck() {
    await sleep(15000);
    if (!S.cdpReady) return;

    let h;
    try {
      h = await cdpEvaluate(
        '(window.DTDom && window.DTDom.health) ? window.DTDom.health() : null'
      );
    } catch (e) {
      return;
    }
    if (!h) return;

    if (h.listItemSel > 0 || h.contentSel > 0) {
      log(
        'WARN',
        `备用选择器已启用（listItem #${h.listItemSel + 1} / content #${h.contentSel + 1}），` +
          'Discord 可能改过类名，建议确认译文是否正常'
      );
    }

    if (h.items === 0 && h.contents === 0 && /\/channels\//.test(String(h.url || ''))) {
      log('ERROR', `自检失败：页面上找不到任何消息节点（${h.url}）`);
      setHint(t('页面上找不到消息节点，Discord 可能改了页面结构。点【探测页面结构】看诊断。'), true);
      notify(t('翻译可能失效'), t('Discord 页面结构似乎变了，请打开设置点【探测页面结构】。'));
    }
  }

  async function probePage() {
    try {
      const p = await cdpEvaluate(
        '(window.DTDom && window.DTDom.probe) ? window.DTDom.probe() : { error: "未注入" }'
      );
      log('INFO', 'structure probe: ' + JSON.stringify(p));
      setHint(t('页面结构已写进下方日志。'));
    } catch (e) {
      setHint(t('探测失败：') + ((e && e.message) || e), true);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  async function loadSources() {
    const read = async (p) => {
      const r = await fetch(p);
      if (!r.ok) throw new Error(t('读取 {name} 失败', { name: p }));
      return r.text();
    };
    ENGINE_SRC = await read('engine.js');
    DOM_SRC = await read('dom.js');
    CSS_SRC = await read('content.css');
  }

  async function init() {
    fillLangs();
    bindUI();
    watchSystemTheme();
    applyTheme();

    try {
      await loadSources();
    } catch (e) {
      setStatus('err', t('初始化失败'), e.message);
      log('ERROR', t('加载资源失败: ') + e.message);
      return;
    }

    try {
      S.cfg = await invoke('get_config');
      applyCfgToUI();
      await applyLanguage();
      updateChannelUI();
      $('dConfig').textContent = await invoke('config_path');
    } catch (e) {
      log('ERROR', t('读取配置失败: ') + e.message);
      S.cfg = {};
    }

    // 刚被自动更新过：把发布说明留到这次启动处理
    try {
      const notes = await invoke('take_update_notes');
      if (notes) {
        log('INFO', '更新完成，发布说明: ' + notes);
        $('verDetail').textContent = t('已更新到 v{v}。', { v: S.appInfo.version });
        if (S.cfg.openNotesAfterUpdate !== false) {
          setTimeout(() => invoke('open_url', { url: notes }).catch(() => {}), 2500);
        }
      }
    } catch (e) {
      /* 标记文件读取失败不影响主流程 */
    }

    // 启动后静默查一次更新（不抢焦点、不弹窗，发现问题只在卡片里提示）
    if (S.cfg && S.cfg.autoCheckUpdate !== false) {
      setTimeout(() => {
        if (!S.updateInfo) checkUpdate(false);
      }, 8000);
    }

    await refreshUsage();
    await refreshShortcut();
    refreshLocalEnv();

    const st = await invoke('discord_status').catch(() => null);
    if (st) {
      $('dPort').textContent = String(st.port);
      if (st.portOpen) {
        setStatus('busy', t('正在连接…'), '');
        $('subtitle').textContent = t('检测到 Discord 已就绪');
        connect(false);
      } else if (st.running) {
        setStatus('warn', t('Discord 正在运行'), t('但未开启调试端口'));
        $('subtitle').textContent = t('需要重启 Discord 才能连接');
        setHint('Discord 已在运行但没开调试端口。点【重启 Discord 并连接】——语音会断，草稿会丢。');
        $('btnConnect').textContent = t('重启 Discord 并连接');
      } else {
        setStatus('', t('未连接'), '');
        $('subtitle').textContent = t('Discord 未运行');
        $('btnConnect').textContent = t('启动 Discord 并连接');
      }
    }

    listen('dt:toggle', () => {
      $('power').click();
    }).catch(() => {});

    // 托盘菜单里的两项
    listen('dt:check-update', () => checkUpdate(true)).catch(() => {});
    listen('dt:rollback-failed', (e) =>
      setHint(t('回滚失败：') + String((e && e.payload) || ''), true)
    ).catch(() => {});

    // 首次"关窗口"时 Rust 侧会发这个事件
    listen('dt:tray-hint', () => {
      notify(t('已最小化到托盘'), t('翻译仍在后台运行。右键托盘图标可以退出。'));
      log('INFO', t('首次关闭窗口，已提示最小化到托盘'));
    }).catch(() => {});

    // 托盘"退出"前，先把注入到 Discord 的译文清掉，避免留下僵尸译文
    listen('dt:cleanup', async () => {
      try {
        if (!S.cdpReady) return;
        await cdpEvaluate(`
          (function () {
            try { if (window.DTDom && window.DTDom.stop) window.DTDom.stop(); } catch (e) {}
            var n = document.querySelectorAll('.dt-trans, .dt-error');
            for (var i = 0; i < n.length; i++) { try { n[i].remove(); } catch (e) {} }
            var s = document.getElementById('dt-style');
            if (s) s.remove();
            return true;
          })()
        `);
        log('INFO', t('退出前已清理页面上的译文'));
      } catch (e) {
        /* ignore */
      }
    }).catch(() => {});

    // 前面的连接流程会改按钮与状态文案，末尾补扫一遍，兜住漏翻的静态文本
    if (window.DTI18n) window.DTI18n.applyStatic();

    setInterval(() => {
      $('dCdp').textContent = S.cdpReady ? t('已连接') : t('未连接');
      $('dUrl').textContent = S.pageUrl || '-';
      $('dUrl').title = S.pageUrl || '';
    }, 1500);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
