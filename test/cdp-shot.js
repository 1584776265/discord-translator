/* 通过 CDP 驱动 headless Edge：导航 -> 等待翻译完成 -> 截图 + 导出结果 */
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.CDP_PORT || '9333', 10);
const TARGET_URL = process.env.URL || 'http://127.0.0.1:8899/test/mock-discord.html';
const OUT_PNG = path.join(__dirname, 'shot.png');
const OUT_JSON = path.join(__dirname, 'result.json');
const MAX_WAIT_MS = 45000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('edge://')).pop();
      if (page) return page;
    } catch (e) {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('无法连接到 Edge 调试端口');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('ws error'));
  });
}

let msgId = 0;
function makeClient(ws) {
  const pending = new Map();
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  return (method, params) =>
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
}

(async () => {
  const target = await getTarget();
  console.log('target:', target.url);

  const ws = await connect(target.webSocketDebuggerUrl);
  const send = makeClient(ws);

  await send('Page.enable');
  await send('Runtime.enable');

  const consoleLogs = [];
  ws.addEventListener('message', (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        consoleLogs.push(
          m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' ')
        );
      }
    } catch (e) {
      /* ignore */
    }
  });

  await send('Page.navigate', { url: TARGET_URL });

  // 等页面就绪
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await send('Runtime.evaluate', {
        expression: 'typeof window.__dumpResult === "function"',
        returnByValue: true
      });
      if (r.result && r.result.value === true) {
        ready = true;
        break;
      }
    } catch (e) {
      /* keep waiting */
    }
  }
  if (!ready) console.log('!! 页面未就绪');

  // 等待译文数量稳定
  let lastCount = -1;
  let stableTimes = 0;
  const started = Date.now();
  let snapshot = [];

  while (Date.now() - started < MAX_WAIT_MS) {
    await sleep(600);
    const r = await send('Runtime.evaluate', {
      expression:
        'JSON.stringify({ d: window.__dumpResult ? window.__dumpResult() : [], s: window.DTDom ? window.DTDom.stats() : null })',
      returnByValue: true
    });
    let parsed = {};
    try {
      parsed = JSON.parse(r.result.value || '{}');
    } catch (e) {
      parsed = {};
    }
    snapshot = parsed.d || [];
    const st = parsed.s || {};
    const busy = (st.inFlight || 0) + (st.queued || 0) > 0;
    const count = snapshot.filter((x) => x.trans).length;

    if (!busy && count === lastCount && count > 0) {
      stableTimes++;
      if (stableTimes >= 3) break;
    } else {
      stableTimes = 0;
    }
    lastCount = count;
  }

  console.log('\n=== 翻译结果 (' + snapshot.filter((x) => x.trans).length + '/' + snapshot.length + ') ===');
  snapshot.forEach((x) => {
    console.log('\n[' + (x.trans ? 'OK ' : '---') + '] ' + x.lang + '  ' + x.id);
    console.log('  原文: ' + x.src);
    console.log('  译文: ' + (x.trans || '(无)'));
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify(snapshot, null, 2), 'utf8');

  if (consoleLogs.length) {
    console.log('\n=== console ===');
    consoleLogs.slice(0, 20).forEach((l) => console.log('  ' + l));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(OUT_PNG, Buffer.from(shot.data, 'base64'));
  console.log('\n截图已保存: ' + OUT_PNG);

  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
