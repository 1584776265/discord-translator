(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var out = {};

  // 1. 加载推荐术语表
  document.getElementById('btnPresetGlossary').click();
  await sleep(900);

  var cfg = await window.__TAURI__.core.invoke('get_config');
  out.glossaryCount = (cfg.glossary || []).length;
  out.hasDriver = (cfg.glossary || []).some(function (g) {
    return g.from === 'driver';
  });

  var SRC =
    'The new patch fixed the texture streaming issue, please update your graphics driver.';

  // 2. 不加术语：直接翻
  var plain = await window.DTEngine.translate([SRC], {
    provider: 'libre',
    targetLang: 'zh-CN',
    sourceLang: 'en',
    libreUrl: 'http://127.0.0.1:5000'
  });
  out.withoutGlossary = (plain[0] && plain[0].text) || '';

  // 3. 加术语：替换成占位符再翻（复现 handleTranslate 的流程）
  //    graphics driver -> <0>, texture streaming -> <1>, patch -> <2>
  var marked = SRC.replace(/graphics driver/gi, '<0>')
    .replace(/texture streaming/gi, '<1>')
    .replace(/\bpatch\b/gi, '<2>');

  out.marked = marked;

  var withG = await window.DTEngine.translate([marked], {
    provider: 'libre',
    targetLang: 'zh-CN',
    sourceLang: 'en',
    libreUrl: 'http://127.0.0.1:5000'
  });

  var raw = (withG[0] && withG[0].text) || '';
  out.rawWithTokens = raw;
  out.tokensSurvived = raw.indexOf('<0>') >= 0 && raw.indexOf('<1>') >= 0;

  out.withGlossary = raw
    .split('<0>').join('显卡驱动')
    .split('<1>').join('纹理流送')
    .split('<2>').join('补丁');

  return JSON.stringify(out, null, 2);
})()
