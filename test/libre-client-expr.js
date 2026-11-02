(async function () {
  var inv = window.__TAURI__.core.invoke;
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var out = {};

  // 打开设置面板以便观察
  document.querySelectorAll('details.card').forEach(function (d) {
    d.open = true;
  });

  // 切到 LibreTranslate 并保存地址
  var sel = document.getElementById('provider');
  sel.value = 'libre';
  sel.dispatchEvent(new Event('change'));
  await sleep(600);

  var cfg = await inv('get_config');
  cfg.libreUrl = 'http://127.0.0.1:5000';
  cfg.provider = 'libre';
  await inv('save_config', { cfg: cfg });
  out.savedProvider = 'libre';

  // 通过引擎走一次真实翻译（和 Discord 里走的同一条路径）
  var t0 = Date.now();
  var r = await window.DTEngine.translate(
    ['The new patch fixed the texture streaming issue.', 'See you tomorrow.'],
    {
      provider: 'libre',
      targetLang: 'zh-CN',
      sourceLang: 'auto',
      libreUrl: 'http://127.0.0.1:5000',
      concurrency: 4,
      timeout: 30000,
      retries: 1
    }
  );

  out.translate = r.map(function (x) {
    return { ok: !!(x && x.ok), text: (x && x.text) || '', error: (x && x.error) || '' };
  });
  out.totalMs = Date.now() - t0;

  return JSON.stringify(out, null, 2);
})()
