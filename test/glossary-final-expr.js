(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var inv = window.__TAURI__.core.invoke;
  var out = {};

  // 加载推荐术语表
  document.getElementById('btnPresetGlossary').click();
  await sleep(900);

  var cfg = await inv('get_config');
  out.glossaryCount = (cfg.glossary || []).length;

  var SRC =
    'The new patch fixed the texture streaming issue, please update your graphics driver.';

  // 复现 applyGlossary 的替换（闭包内函数无法直接调用）
  var marked = SRC.replace(/graphics driver/gi, '<0>')
    .replace(/texture streaming/gi, '<1>')
    .replace(/\bpatch\b/gi, '<2>');

  function restore(t) {
    return String(t)
      .split('<0>').join('显卡驱动')
      .split('<1>').join('纹理流送')
      .split('<2>').join('补丁');
  }

  // --- 腾讯 ---
  var a = await window.DTEngine.translate([marked], {
    provider: 'tencent',
    targetLang: 'zh-CN',
    sourceLang: 'en'
  });
  out.tencent = {
    raw: (a[0] && a[0].text) || '',
    kept: ((a[0] && a[0].text) || '').indexOf('<0>') >= 0
  };
  out.tencent.final = restore(out.tencent.raw);

  // --- LibreTranslate ---
  var b = await window.DTEngine.translate([marked], {
    provider: 'libre',
    targetLang: 'zh-CN',
    sourceLang: 'en',
    libreUrl: 'http://127.0.0.1:5000'
  });
  out.libre = {
    raw: (b[0] && b[0].text) || '',
    kept: ((b[0] && b[0].text) || '').indexOf('<0>') >= 0
  };

  return JSON.stringify(out, null, 2);
})()
