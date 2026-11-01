/**
 * Discord 桌面版翻译启动器。
 *
 * 做的事：
 *   1. 确认 Discord 以 --remote-debugging-port 方式运行（没有就重启它）
 *   2. 把翻译引擎注入 Discord 渲染进程
 *   3. 常驻，作为翻译后端随时响应
 *
 * 关闭这个窗口 = 停止翻译（Discord 本身不受影响，只是译文不再出现/更新）。
 *
 * 用法:
 *   node start.js                # 正常启动
 *   node start.js --no-restart   # 检测到 Discord 已运行且无调试端口时，不自动重启
 *   node start.js --port 9333    # 指定端口
 */
'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = require('./config');

const ARGS = process.argv.slice(2);
const NO_RESTART = ARGS.includes('--no-restart');
const PORT = (() => {
  const i = ARGS.indexOf('--port');
  if (i >= 0 && ARGS[i + 1]) return parseInt(ARGS[i + 1], 10);
  return config.get('cdpPort') || 9223;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + msg);
}

/* ------------------------------------------------------------------ */

function discordRoot() {
  const base = process.env.LOCALAPPDATA;
  return path.join(base, 'Discord');
}

function findUpdater() {
  const p = path.join(discordRoot(), 'Update.exe');
  return fs.existsSync(p) ? p : null;
}

function isDiscordRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Discord.exe" /NH', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return /Discord\.exe/i.test(out);
  } catch (e) {
    return false;
  }
}

async function portAlive(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function stopDiscord() {
  log('正在关闭 Discord（需要重启才能开启调试端口）…');

  // 先尝试优雅关闭，避免丢消息草稿
  try {
    execSync(
      'powershell -NoProfile -Command "Get-Process Discord -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() | Out-Null }"',
      { stdio: 'ignore' }
    );
  } catch (e) {
    /* ignore */
  }

  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!isDiscordRunning()) {
      log('Discord 已关闭');
      return;
    }
  }

  log('优雅关闭超时，强制结束进程');
  try {
    execSync('taskkill /IM Discord.exe /F', { stdio: 'ignore' });
  } catch (e) {
    /* ignore */
  }
  await sleep(1500);
}

function findLatestDiscordExe() {
  const root = discordRoot();
  if (!fs.existsSync(root)) return null;
  const versions = fs
    .readdirSync(root)
    .filter((n) => /^app-\d/.test(n))
    .sort((a, b) => {
      const pa = a.replace(/^app-/, '').split('.').map(Number);
      const pb = b.replace(/^app-/, '').split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    });
  for (let i = versions.length - 1; i >= 0; i--) {
    const exe = path.join(root, versions[i], 'Discord.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

async function waitForPort(port, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    await sleep(1000);
    if (await portAlive(port)) return Math.round((Date.now() - started) / 1000);
  }
  return null;
}

function launchDetached(file, args) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function startDiscord(port) {
  log('启动 Discord（调试端口 ' + port + '）…');

  // 优先用 Squirrel 的 Update.exe（能保证用最新版并补齐运行环境）
  const updater = findUpdater();
  if (updater) {
    launchDetached(updater, [
      '--processStart',
      'Discord.exe',
      '--process-start-args',
      '--remote-debugging-port=' + port
    ]);
    const secs = await waitForPort(port, 35000);
    if (secs !== null) {
      log('Discord 已就绪（' + secs + ' 秒）');
      return;
    }
    log('Update.exe 方式未生效，改用直接启动 Discord.exe');
    try {
      execSync('taskkill /IM Discord.exe /F', { stdio: 'ignore' });
    } catch (e) {
      /* ignore */
    }
    await sleep(1500);
  }

  // 退路：直接跑最新版本目录下的 Discord.exe
  const exe = findLatestDiscordExe();
  if (!exe) {
    throw new Error('找不到 Discord 安装（' + discordRoot() + '）');
  }
  launchDetached(exe, ['--remote-debugging-port=' + port]);

  const secs = await waitForPort(port, 45000);
  if (secs === null) {
    throw new Error('等待 Discord 调试端口超时');
  }
  log('Discord 已就绪（' + secs + ' 秒）');
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log('==============================================');
  console.log('  Discord 自动翻译（桌面版）');
  console.log('  配置: ' + config.FILE);
  console.log('  关闭本窗口即停止翻译');
  console.log('==============================================\n');

  const alive = await portAlive(PORT);

  if (alive) {
    log('Discord 已带调试端口运行，直接注入');
  } else {
    const running = isDiscordRunning();

    if (running) {
      if (NO_RESTART) {
        console.error('\nDiscord 正在运行，但不是由本启动器启动的，因此没有开启调试端口。');
        console.error('请先完全退出 Discord（右下角托盘图标右键 → 退出），再运行本启动器。\n');
        process.exit(2);
      }
      log('Discord 正在运行但没有调试端口，需要重启一次');
      await stopDiscord();
    }

    await startDiscord(PORT);
  }

  // 交给注入器常驻
  process.env.CDP_PORT = String(PORT);
  require('./inject-discord.js');
})().catch((e) => {
  console.error('\n启动失败: ' + e.message);
  console.error('\n排查建议:');
  console.error('  1. 确认 Discord 已安装（默认 %LOCALAPPDATA%\\Discord）');
  console.error('  2. 完全退出 Discord 后重试');
  console.error('  3. 端口 ' + PORT + ' 若被占用，用 --port 换一个');
  process.exit(1);
});
