(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    enabled: $('enabled'),
    targetLang: $('targetLang'),
    provider: $('provider'),
    googleEndpoint: $('googleEndpoint'),
    openaiBase: $('openaiBase'),
    openaiKey: $('openaiKey'),
    openaiModel: $('openaiModel'),
    libreUrl: $('libreUrl'),
    libreKey: $('libreKey'),
    display: $('display'),
    fontSize: $('fontSize'),
    skipSameLang: $('skipSameLang'),
    statusText: $('statusText'),
    cacheInfo: $('cacheInfo'),
    toast: $('toast'),
    btnTest: $('btnTest'),
    btnRetranslate: $('btnRetranslate'),
    btnClearCache: $('btnClearCache')
  };

  let settings = null;
  let saveTimer = null;
  let toastTimer = null;

  const DISCORD_URL_PATTERNS = [
    'https://discord.com/*',
    'https://ptb.discord.com/*',
    'https://canary.discord.com/*'
  ];

  /* ---------------------------------------------------------------- */
  /* 工具                                                              */
  /* ---------------------------------------------------------------- */

  function toast(message, kind) {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.className = 'toast';
    }, kind === 'err' ? 4200 : 2400);
  }

  function setStatus(text, kind) {
    els.statusText.textContent = text;
    els.statusText.className = kind || '';
  }

  function queryTabs(query) {
    return new Promise((resolve) => chrome.tabs.query(query, (tabs) => resolve(tabs || [])));
  }

  function sendToTab(tabId, payload) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function broadcastSettings() {
    const tabs = await queryTabs({ url: DISCORD_URL_PATTERNS });
    for (const tab of tabs) {
      sendToTab(tab.id, { type: 'dt:settingsChanged', settings });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 表单                                                              */
  /* ---------------------------------------------------------------- */

  function buildLangOptions() {
    els.targetLang.innerHTML = '';
    for (const item of DTSettings.PRESET_LANGS) {
      const opt = document.createElement('option');
      opt.value = item.code;
      opt.textContent = item.label;
      els.targetLang.appendChild(opt);
    }
  }

  function fillForm(s) {
    els.enabled.checked = !!s.enabled;
    els.targetLang.value = s.targetLang;
    els.provider.value = s.provider;
    els.googleEndpoint.value = s.googleEndpoint || '';
    els.openaiBase.value = s.openaiBase || '';
    els.openaiKey.value = s.openaiKey || '';
    els.openaiModel.value = s.openaiModel || '';
    els.libreUrl.value = s.libreUrl || '';
    els.libreKey.value = s.libreKey || '';
    els.display.value = s.display || 'below';
    els.fontSize.value = String(s.fontSize || 13);
    els.skipSameLang.checked = s.skipSameLang !== false;
    syncProviderBlocks();
  }

  function syncProviderBlocks() {
    const p = els.provider.value;
    document.querySelectorAll('.provider-google').forEach((el) => {
      el.classList.toggle('hidden', p !== 'google' && p !== 'auto');
    });
    document.querySelectorAll('.provider-openai').forEach((el) => {
      el.classList.toggle('hidden', p !== 'openai');
    });
    document.querySelectorAll('.provider-libre').forEach((el) => {
      el.classList.toggle('hidden', p !== 'libre');
    });
  }

  function readForm() {
    return {
      enabled: els.enabled.checked,
      targetLang: els.targetLang.value,
      provider: els.provider.value,
      googleEndpoint: els.googleEndpoint.value.trim(),
      openaiBase: els.openaiBase.value.trim(),
      openaiKey: els.openaiKey.value.trim(),
      openaiModel: els.openaiModel.value.trim(),
      libreUrl: els.libreUrl.value.trim(),
      libreKey: els.libreKey.value.trim(),
      display: els.display.value,
      fontSize: parseInt(els.fontSize.value, 10) || 13,
      skipSameLang: els.skipSameLang.checked
    };
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      settings = DTSettings.merge(DTSettings.DEFAULTS, readForm());
      await DTSettings.save(settings);
      await broadcastSettings();
      refreshStatus();
    }, 260);
  }

  /* ---------------------------------------------------------------- */
  /* 状态                                                              */
  /* ---------------------------------------------------------------- */

  async function refreshStatus() {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const tab = tabs[0];

    if (!tab || !tab.url) {
      setStatus('无法读取当前标签页', 'warn');
      return;
    }

    const onDiscord = /^https:\/\/(ptb\.|canary\.)?discord\.com\//.test(tab.url);
    if (!onDiscord) {
      setStatus('当前页面不是 Discord，打开 discord.com 后生效', 'warn');
      els.btnRetranslate.disabled = true;
      return;
    }

    els.btnRetranslate.disabled = false;

    const stats = await sendToTab(tab.id, { type: 'dt:getStats' });
    if (!stats || !stats.ok) {
      setStatus('页面脚本未就绪，请刷新 Discord 页面', 'warn');
      return;
    }

    if (!stats.running) {
      setStatus('翻译未启动，请刷新 Discord 页面', 'warn');
      return;
    }

    const n = stats.stats ? stats.stats.rendered : 0;
    if (!stats.settings || stats.settings.enabled === false) {
      setStatus('已暂停 · 当前显示 ' + n + ' 条译文', 'warn');
    } else {
      setStatus('运行中 · 已显示 ' + n + ' 条译文', 'ok');
    }
  }

  async function refreshCacheInfo() {
    chrome.runtime.sendMessage({ type: 'dt:stats' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        els.cacheInfo.textContent = '缓存：—';
        return;
      }
      els.cacheInfo.textContent = '缓存：' + resp.stats.size + ' 条';
    });
  }

  /* ---------------------------------------------------------------- */
  /* 按钮                                                              */
  /* ---------------------------------------------------------------- */

  els.btnTest.addEventListener('click', () => {
    const s = DTSettings.merge(DTSettings.DEFAULTS, readForm());
    els.btnTest.disabled = true;
    toast('正在测试连接…');

    chrome.runtime.sendMessage({ type: 'dt:test', settings: s }, (resp) => {
      els.btnTest.disabled = false;
      if (chrome.runtime.lastError) {
        toast('后台无响应：' + chrome.runtime.lastError.message, 'err');
        return;
      }
      if (!resp || !resp.ok) {
        toast('测试失败：' + ((resp && resp.error) || '未知错误'), 'err');
        return;
      }
      const r = resp.result;
      if (r && r.ok) {
        const via = r.provider ? '[' + r.provider + '] ' : '';
        toast('连接正常 · ' + via + r.ms + ' ms → ' + r.text, 'ok');
      } else {
        toast('测试失败：' + ((r && r.error) || '无返回'), 'err');
      }
    });
  });

  els.btnRetranslate.addEventListener('click', async () => {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    const resp = await sendToTab(tabs[0].id, { type: 'dt:retranslate' });
    if (resp && resp.ok) {
      toast('已重新翻译当前页面', 'ok');
      setTimeout(refreshStatus, 800);
    } else {
      toast('页面未响应，请刷新 Discord', 'err');
    }
  });

  els.btnClearCache.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'dt:clearCache' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        toast('清除失败', 'err');
        return;
      }
      toast('缓存已清除', 'ok');
      refreshCacheInfo();
      els.btnRetranslate.click();
    });
  });

  /* ---------------------------------------------------------------- */
  /* 绑定                                                              */
  /* ---------------------------------------------------------------- */

  ['targetLang', 'provider', 'display', 'fontSize'].forEach((key) => {
    els[key].addEventListener('change', () => {
      if (key === 'provider') syncProviderBlocks();
      scheduleSave();
    });
  });

  ['googleEndpoint', 'openaiBase', 'openaiKey', 'openaiModel', 'libreUrl', 'libreKey'].forEach((key) => {
    els[key].addEventListener('input', scheduleSave);
  });

  ['enabled', 'skipSameLang'].forEach((key) => {
    els[key].addEventListener('change', scheduleSave);
  });

  /* ---------------------------------------------------------------- */
  /* 初始化                                                            */
  /* ---------------------------------------------------------------- */

  (async function init() {
    buildLangOptions();
    settings = await DTSettings.load();
    fillForm(settings);
    refreshStatus();
    refreshCacheInfo();
  })();
})();
