/* 用法: URL=... OUT=... W=... H=... node test/shot-url.js */
const fs = require('fs');

const PORT = parseInt(process.env.CDP_PORT || '9334', 10);
const URL = process.env.URL;
const OUT = process.env.OUT || 'shot-url.png';
const W = parseInt(process.env.W || '420', 10);
const H = parseInt(process.env.H || '900', 10);
const WAIT = parseInt(process.env.WAIT || '2500', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.filter((t) => t.type === 'page' && !String(t.url).startsWith('edge://')).pop();
      if (page) return page;
    } catch (e) {
      /* retry */
    }
    await sleep(300);
  }
  throw new Error('无法连接 CDP');
}

let msgId = 0;

(async () => {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws fail'));
  });

  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
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
          reject(new Error('timeout ' + method));
        }
      }, 30000);
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

  if (URL && URL !== '-') {
    await send('Page.navigate', { url: URL });
  }
  await sleep(WAIT);

  if (logs.length) {
    console.log('--- console ---');
    logs.slice(0, 25).forEach((l) => console.log('  ' + l));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved ' + OUT);

  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL ' + e.message);
  process.exit(1);
});
