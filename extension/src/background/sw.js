/*!
 * Discord Translator — background service worker
 * 所有跨域请求都在这里发出，绕开页面 CSP / CORS 限制
 */
importScripts('../core/engine.js', '../core/settings.js');

const CACHE_SAVE_DELAY = 2000;
let saveTimer = null;
let cachePrimed = false;

async function primeCache() {
  if (cachePrimed) return;
  cachePrimed = true;
  try {
    const raw = await DTSettings.loadCache();
    if (raw) DTEngine.importCache(raw);
  } catch (e) {
    console.warn('[Discord Translator] 缓存加载失败', e);
  }
}

function scheduleCacheSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushCache, CACHE_SAVE_DELAY);
}

async function flushCache() {
  saveTimer = null;
  try {
    await DTSettings.saveCache(DTEngine.exportCache());
  } catch (e) {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const s = await DTSettings.load();
    await DTSettings.save(s);
  }
});

chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(primeCache);

const ready = primeCache();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  const handle = async () => {
    await ready;

    switch (msg.type) {
      case 'dt:ping':
        return { ok: true, version: chrome.runtime.getManifest().version };

      case 'dt:translate': {
        const settings = await DTSettings.load();
        const merged = DTSettings.merge(settings, msg.settings || {});
        const results = await DTEngine.translate(msg.texts || [], merged);
        scheduleCacheSave();
        return { ok: true, results };
      }

      case 'dt:test': {
        const settings = await DTSettings.load();
        const merged = DTSettings.merge(settings, msg.settings || {});
        const result = await DTEngine.test(merged).catch((e) => ({
          ok: false,
          error: String((e && e.message) || e)
        }));
        return { ok: true, result };
      }

      case 'dt:clearCache':
        await ready;
        DTEngine.clearCache();
        await DTSettings.clearCacheStorage();
        return { ok: true };

      case 'dt:stats':
        await ready;
        return { ok: true, stats: DTEngine.cacheStats() };

      case 'dt:openDiscord':
        chrome.tabs.create({ url: 'https://discord.com/channels/@me' });
        return { ok: true };

      default:
        return null;
    }
  };

  handle()
    .then((payload) => {
      if (payload === null) return;
      sendResponse(payload);
    })
    .catch((e) => {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });

  return true; // 异步响应
});

/* ---------------------------------------------------------------- */
/* 快捷键：Alt+T 切换开关                                            */
/* ---------------------------------------------------------------- */

chrome.commands &&
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-translate') return;
    const s = await DTSettings.load();
    s.enabled = !s.enabled;
    await DTSettings.save(s);
    const tabs = await chrome.tabs.query({
      url: ['https://discord.com/*', 'https://ptb.discord.com/*', 'https://canary.discord.com/*']
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'dt:settingsChanged', settings: s }).catch(() => {});
    }
    try {
      await chrome.action.setBadgeText({ text: s.enabled ? '' : 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ color: '#ed4245' });
    } catch (e) {
      /* ignore */
    }
  });

/* ---------------------------------------------------------------- */
/* 点击图标时若不在 Discord 页面则提示                                */
/* ---------------------------------------------------------------- */
