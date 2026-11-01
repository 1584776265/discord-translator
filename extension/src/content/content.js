/*!
 * Discord Translator — content script 入口
 */
(function () {
  'use strict';

  const LOG = '[Discord Translator]';

  let settings = null;
  let started = false;
  let bootRetry = 0;

  /* ---------------------------------------------------------------- */
  /* 与 background 通信                                                */
  /* ---------------------------------------------------------------- */

  function sendToBackground(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp) {
            reject(new Error('后台无响应'));
            return;
          }
          if (resp.ok === false) {
            reject(new Error(resp.error || '翻译失败'));
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function translateViaBackground(texts, currentSettings) {
    const resp = await sendToBackground({
      type: 'dt:translate',
      texts,
      settings: currentSettings
    });
    return resp.results || [];
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  function applyDisplayMode() {
    if (!settings) return;
    document.documentElement.setAttribute('data-dt-display', settings.display || 'below');
    document.documentElement.style.setProperty('--dt-font-size', (settings.fontSize || 13) + 'px');
  }

  async function boot() {
    if (started) return;

    if (!document.body) {
      if (bootRetry++ < 30) setTimeout(boot, 300);
      return;
    }

    try {
      settings = await DTSettings.load();
    } catch (e) {
      settings = DTSettings.merge(DTSettings.DEFAULTS, null);
    }

    applyDisplayMode();

    try {
      DTDom.start({
        translate: translateViaBackground,
        getSettings: () => settings
      });
      started = true;
      console.log(LOG + ' 已启动，目标语言 ' + settings.targetLang);
    } catch (e) {
      started = false;
      console.error(LOG + ' 启动失败', e);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 监听设置变更                                                      */
  /* ---------------------------------------------------------------- */

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const entry = changes[DTSettings.STORAGE_KEY];
      if (!entry) return;
      settings = DTSettings.merge(DTSettings.DEFAULTS, entry.newValue);
      applyDisplayMode();
      if (started) DTDom.updateSettings(settings);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'dt:settingsChanged') {
      settings = DTSettings.merge(DTSettings.DEFAULTS, msg.settings);
      applyDisplayMode();
      if (started) DTDom.updateSettings(settings);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'dt:retranslate') {
      if (started) DTDom.retranslateAll();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'dt:getStats') {
      sendResponse({
        ok: true,
        running: started,
        stats: started ? DTDom.stats() : null,
        settings
      });
      return true;
    }

    if (msg.type === 'dt:toggle') {
      settings.enabled = !settings.enabled;
      DTSettings.save(settings);
      applyDisplayMode();
      if (started) DTDom.updateSettings(settings);
      sendResponse({ ok: true, enabled: settings.enabled });
      return true;
    }

    return false;
  });

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // Discord 的 SPA 有时会把整个 app 根节点重建，兜底重扫
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (started) setTimeout(() => DTDom.scanAll(), 600);
    }
  }, 1200);

  window.addEventListener('focus', () => {
    if (started) DTDom.scanAll();
  });
})();
