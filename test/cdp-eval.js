/* 用法: node test/cdp-eval.js <url|-> <expressionFile|inline-expression> [waitMs] */
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.CDP_PORT || '9333', 10);
const url = process.argv[2];
const exprArg = process.argv[3];
const waitMs = parseInt(process.argv[4] || '6000', 10);

let expression = exprArg;
if (exprArg && fs.existsSync(exprArg)) expression = fs.readFileSync(exprArg, 'utf8');

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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
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

  if (url && url !== '-') {
    await send('Page.navigate', { url });
    await sleep(waitMs);
  }

  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (r.exceptionDetails) {
    console.log('EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description, null, 2));
  } else {
    const v = r.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }

  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
