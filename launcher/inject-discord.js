/**
 * 通过 Chrome DevTools Protocol 把翻译能力注入到 Discord 桌面版。
 *
 * 原理：Discord 是 Electron 应用，用 --remote-debugging-port 启动后对外暴露 CDP。
 * 连上主窗口的渲染进程，evaluate 注入 DOM 适配层与样式。
 * 翻译请求由本进程（Node）发出再回填页面 —— 因为 Discord 的 CSP 的
 * connect-src 只放行 discord.com，页面内直接 fetch 第三方接口会被拦。
 *
 * 因此本进程必须常驻：它同时是「翻译后端」和「注入器」。
 *
 * 用法:
 *   node inject-discord.js                 # 常驻，跟随页面变化自动补注入
 *   node inject-discord.js --once          # 注入一次、跑通、截图、退出（调试用）
 *   node inject-discord.js --once --port 9223
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENGINE_SRC = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'core', 'engine.js'), 'utf8');
const DOM_SRC = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'core', 'dom.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'content', 'content.css'), 'utf8');

const engine = require(path.join(ROOT, 'extension', 'src', 'core', 'engine.js'));
const config = require('./config');

const BINDING = '__dtIpcSend';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes('--once');
const PORT_ARG = (() => {
  const i = ARGS.indexOf('--port');
  if (i >= 0 && ARGS[i + 1]) return parseInt(ARGS[i + 1], 10);
  if (process.env.CDP_PORT) return parseInt(process.env.CDP_PORT, 10);
  return null;
})();

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

let msgId = 0;

function makeClient(ws) {
  const pending = new Map();
  const handlers = [];

  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
      return;
    }
    for (const h of handlers) {
      try {
        h(m);
      } catch (e) {
        /* ignore */
      }
    }
  };

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });

  return { send, onEvent: (fn) => handlers.push(fn) };
}

async function findDiscordPage(port, retries) {
  const max = retries == null ? 60 : retries;
  for (let i = 0; i < max; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && /discord\.com/.test(String(t.url)));
      if (page) return page;
    } catch (e) {
      /* not ready */
    }
    await sleep(500);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 注入内容                                                            */
/* ------------------------------------------------------------------ */

// 用形参遮蔽 module/exports/require，避免污染 Discord 的 webpack 环境
function wrapModule(src) {
  return `(function(module, exports, require){\n${src}\n})(undefined, undefined, undefined);`;
}

function cssExpr(css) {
  return `
    (function () {
      var el = document.getElementById('dt-style');
      if (!el) {
        el = document.createElement('style');
        el.id = 'dt-style';
        el.setAttribute('data-dt', '1');
        (document.head || document.documentElement).appendChild(el);
      }
      el.textContent = ${JSON.stringify(css)};
      return el.textContent.length;
    })()
  `;
}

function shimExpr(settings) {
  return `
    (function () {
      window.__dtCfg = Object.assign({}, window.__dtCfg || {}, ${JSON.stringify(settings)});
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
                return { ok: false, error: 'IPC 不可用: ' + e.message };
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
        Object.assign(window.__dtCfg, patch);
        if (window.DTDom) window.DTDom.updateSettings(window.__dtCfg);
      };

      if (window.DTDom) {
        window.DTDom.start({
          translate: window.__dtTranslate,
          getSettings: function () { return window.__dtCfg; }
        });
      }
      return true;
    })()
  `;
}

const STATUS_EXPR = `
(function () {
  var rows = [];
  var lis = document.querySelectorAll('li[id^="chat-messages-"]');
  for (var i = 0; i < lis.length; i++) {
    var li = lis[i];
    var content = li.querySelector('[id^="message-content-"]');
    var t = li.querySelector('.dt-trans .dt-text');
    rows.push({
      id: li.id,
      src: content ? content.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50) : '',
      trans: t ? t.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null
    });
  }
  return JSON.stringify({
    url: location.href,
    injected: typeof window.DTDom === 'object',
    hasCss: !!document.getElementById('dt-style'),
    stats: window.DTDom ? window.DTDom.stats() : null,
    rendered: document.querySelectorAll('.dt-trans').length,
    total: rows.length,
    rows: rows
  });
})()
`;

/* ------------------------------------------------------------------ */
/* 注入与会话                                                          */
/* ------------------------------------------------------------------ */

async function fullInject(send) {
  // 先拆掉旧实例：重复注入会留下多套 MutationObserver，导致同样的消息被翻好几遍
  await send('Runtime.evaluate', {
    expression: `
      (function () {
        try { if (window.DTDom && window.DTDom.stop) window.DTDom.stop(); } catch (e) {}
        var olds = document.querySelectorAll('.dt-trans');
        for (var i = 0; i < olds.length; i++) { try { olds[i].remove(); } catch (e) {} }
        return true;
      })()
    `
  });

  await send('Runtime.evaluate', { expression: wrapModule(ENGINE_SRC) });
  await send('Runtime.evaluate', { expression: wrapModule(DOM_SRC) });
  await send('Runtime.evaluate', { expression: cssExpr(CSS_SRC) });
  await send('Runtime.evaluate', { expression: shimExpr(config.getTranslationSettings()) });
}

/**
 * 建立一个常驻会话：连上 Discord 页面，注入，响应翻译请求。
 * 页面重载 / 上下文重建时会自动重新注入。
 */
async function runSession(port) {
  const target = await findDiscordPage(port, 120);
  if (!target) throw new Error('找不到 Discord 页面（确认 Discord 是否带 --remote-debugging-port 启动）');

  console.log('[inject] 连接页面: ' + target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });

  const { send, onEvent } = makeClient(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Runtime.addBinding', { name: BINDING });

  // ---- 注册后立即补注入，避免出现「已注册未注入」的空窗 ----
  await fullInject(send);
  console.log('[inject] 已注入（引擎 + 样式 + 桥接）');

  let handled = 0;

  onEvent((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      console.error('[page-error] ' + (d.exception && d.exception.description ? String(d.exception.description).split('\n')[0] : d.text));
      return;
    }

    // 页面上下文被清空（Discord 重载 / Ctrl+R）→ 重新注入
    if (m.method === 'Runtime.executionContextsCleared') {
      console.log('[inject] 检测到页面重载，2 秒后重新注入');
      setTimeout(async () => {
        try {
          await fullInject(send);
          console.log('[inject] 重新注入完成');
        } catch (e) {
          console.error('[inject] 重新注入失败: ' + e.message);
        }
      }, 2000);
      return;
    }

    // 主帧导航完成（切换服务器/频道偶尔会重建上下文）
    if (m.method === 'Page.frameNavigated' && m.params.frame && !m.params.frame.parentId) {
      setTimeout(async () => {
        try {
          const chk = await send('Runtime.evaluate', {
            expression: 'typeof window.DTDom === "object" && !!document.getElementById("dt-style")',
            returnByValue: true
          });
          if (!chk.result || chk.result.value !== true) {
            await fullInject(send);
            console.log('[inject] 导航后补注入完成');
          }
        } catch (e) {
          /* ignore */
        }
      }, 1500);
      return;
    }

    if (m.method !== 'Runtime.bindingCalled' || m.params.name !== BINDING) return;

    let msg;
    try {
      msg = JSON.parse(m.params.payload);
    } catch (e) {
      return;
    }

    handled++;
    if (handled === 1 || handled % 20 === 0) {
      console.log('[translate] 第 ' + handled + ' 批，共 ' + msg.texts.length + ' 条');
    }

    (async () => {
      let results;
      try {
        const settings = Object.assign(
          {},
          config.getTranslationSettings(),
          msg.settings || {}
        );
        results = await engine.translate(msg.texts, settings);
      } catch (e) {
        results = msg.texts.map(() => ({ ok: false, error: String((e && e.message) || e) }));
      }

      const bad = results.filter((r) => r && !r.ok).length;
      if (bad > 0) {
        console.warn('[translate] ' + bad + '/' + results.length + ' 条失败: ' + (results.find((r) => r && r.error) || {}).error);
      }

      const expr = 'window.__dtReply(' + JSON.stringify(msg.id) + ',' + JSON.stringify(results) + ')';
      send('Runtime.evaluate', { expression: expr }).catch(() => {});
    })();
  });

  return { ws, send, getHandled: () => handled };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

(async () => {
  const port = PORT_ARG || config.get('cdpPort') || 9223;

  if (ONCE) {
    const session = await runSession(port);
    console.log('[test] 等待翻译稳定…');

    let last = -1;
    let stable = 0;
    let snapshot = {};
    const started = Date.now();

    while (Date.now() - started < 45000) {
      await sleep(1000);
      const r = await session.send('Runtime.evaluate', { expression: STATUS_EXPR, returnByValue: true });
      try {
        snapshot = JSON.parse(r.result.value || '{}');
      } catch (e) {
        continue;
      }
      const busy = snapshot.stats ? (snapshot.stats.inFlight || 0) + (snapshot.stats.queued || 0) : 0;
      const count = snapshot.rendered || 0;
      if (busy === 0 && count === last && count > 0) {
        if (++stable >= 3) break;
      } else {
        stable = 0;
      }
      last = count;
    }

    console.log('\n=== 结果 ===');
    console.log('消息总数: ' + snapshot.total + '，已渲染译文: ' + snapshot.rendered + '，样式: ' + (snapshot.hasCss ? 'OK' : '缺失'));
    console.log('IPC 批次数: ' + session.getHandled());
    (snapshot.rows || []).forEach((r) => {
      console.log('  [' + (r.trans ? 'OK ' : '-- ') + '] ' + (r.trans ? r.trans : r.src));
    });

    // 滚动到译文居中并截图，同时回报实际生效的样式
    const styleProbe = await session.send('Runtime.evaluate', {
      expression: `
        (function () {
          var t = document.querySelector('.dt-trans');
          if (!t) return JSON.stringify({ error: 'no .dt-trans' });
          t.scrollIntoView({ block: 'center' });
          var cs = getComputedStyle(t);
          var te = t.querySelector('.dt-text');
          var cs2 = te ? getComputedStyle(te) : null;
          var badge = t.querySelector('.dt-badge');
          return JSON.stringify({
            transColor: cs.color,
            transFontSize: cs.fontSize,
            transLineHeight: cs.lineHeight,
            transBorderLeft: cs.borderLeft,
            textColor: cs2 ? cs2.color : null,
            textOpacity: cs2 ? cs2.opacity : null,
            badgeText: badge ? badge.textContent : null,
            textLen: te ? te.textContent.length : 0
          });
        })()
      `,
      returnByValue: true
    });
    console.log('\n样式检查: ' + styleProbe.result.value);
    await sleep(1200);

    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    const outPng = path.join(ROOT, 'test', 'discord-live.png');
    fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
    fs.writeFileSync(path.join(ROOT, 'test', 'discord-live.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    console.log('\n截图: ' + outPng);

    session.ws.close();
    process.exit(0);
  }

  // ---- 常驻模式 ----
  console.log('[inject] 常驻模式启动，端口 ' + port);

  let running = true;
  process.on('SIGINT', () => {
    running = false;
    console.log('\n[inject] 收到退出信号');
    process.exit(0);
  });

  while (running) {
    try {
      const session = await runSession(port);
      await new Promise((resolve) => {
        session.ws.addEventListener('close', resolve);
        session.ws.addEventListener('error', resolve);
      });
      console.log('[inject] 连接已断开，5 秒后重连');
    } catch (e) {
      console.error('[inject] ' + e.message);
    }
    if (!running) break;
    await sleep(5000);
  }
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
