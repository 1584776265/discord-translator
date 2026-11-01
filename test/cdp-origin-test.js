/**
 * 验证 Chromium CDP WebSocket 的 Origin 限制。
 *
 * 结论决定架构：
 *   若带 Origin 的 WebSocket 被拒 → WebView2 前端无法直连 CDP，必须 Rust 侧连
 *   若加了 --remote-allow-origins=* 就能通 → 前端 JS 可以直连，架构可简化
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killEdgeByProfile(tag) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { stdio: 'ignore' }
    );
  } catch (e) {
    /* ignore */
  }
}

async function startEdge(port, extraArgs) {
  const profile = path.join(os.tmpdir(), 'dt_origin_' + port);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    ...extraArgs,
    'about:blank'
  ];
  spawn(EDGE, args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch (e) {
      /* retry */
    }
  }
  return false;
}

async function getPageTarget(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  return list.find((t) => t.type === 'page');
}

/** 手工发一次 WebSocket 握手，看服务器是 upgrade 还是拒绝 */
function tryUpgrade(port, wsPath, origin) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13'
    };
    if (origin) headers.Origin = origin;

    const req = http.request({ host: '127.0.0.1', port, path: wsPath, headers, method: 'GET' });

    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    req.on('upgrade', (res, socket) => {
      socket.destroy();
      done({ ok: true, status: 101 });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => done({ ok: false, status: res.statusCode, body: body.slice(0, 120) }));
    });
    req.on('error', (e) => done({ ok: false, status: 0, body: e.message }));

    req.setTimeout(5000, () => {
      req.destroy();
      done({ ok: false, status: 0, body: 'timeout' });
    });
    req.end();
  });
}

async function scenario(label, port, extraArgs) {
  killEdgeByProfile('dt_origin_' + port);
  await sleep(800);

  const up = await startEdge(port, extraArgs);
  if (!up) return { label, error: 'edge did not start' };

  const target = await getPageTarget(port);
  if (!target) return { label, error: 'no page target' };

  const wsPath = new URL(target.webSocketDebuggerUrl).pathname;

  const noOrigin = await tryUpgrade(port, wsPath, null);
  const withOrigin = await tryUpgrade(port, wsPath, 'http://tauri.localhost');
  const withEdgeOrigin = await tryUpgrade(port, wsPath, 'http://localhost:1420');

  killEdgeByProfile('dt_origin_' + port);

  return {
    label,
    extraArgs: extraArgs.join(' ') || '(none)',
    'no-Origin': noOrigin,
    'Origin: tauri.localhost': withOrigin,
    'Origin: localhost:1420': withEdgeOrigin
  };
}

(async () => {
  const results = [];

  results.push(await scenario('A. 默认参数（当前 Discord 的启动方式）', 9451, []));
  results.push(await scenario('B. 加 --remote-allow-origins=*', 9452, ['--remote-allow-origins=*']));
  results.push(
    await scenario('C. 逗号分隔的精确 Origin（生产+开发）', 9453, [
      '--remote-allow-origins=http://tauri.localhost,http://localhost:1420'
    ])
  );

  console.log(JSON.stringify(results, null, 2));

  console.log('\n=== 结论 ===');
  for (const r of results) {
    if (r.error) {
      console.log(r.label + ' -> 失败: ' + r.error);
      continue;
    }
    console.log('\n' + r.label + '  [' + r.extraArgs + ']');
    console.log('  无 Origin        : ' + (r['no-Origin'].ok ? '接受 (101)' : '拒绝 (' + r['no-Origin'].status + ')'));
    console.log('  Origin tauri     : ' + (r['Origin: tauri.localhost'].ok ? '接受 (101)' : '拒绝 (' + r['Origin: tauri.localhost'].status + ')'));
    console.log('  Origin localhost : ' + (r['Origin: localhost:1420'].ok ? '接受 (101)' : '拒绝 (' + r['Origin: localhost:1420'].status + ')'));
  }
})();
