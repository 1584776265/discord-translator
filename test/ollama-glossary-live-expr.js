(async function () {
  var inv = window.__TAURI__.core.invoke;
  var out = {};

  var cfg = await inv('get_config');
  out.glossaryCount = (cfg.glossary || []).length;
  out.provider = cfg.provider;
  out.model = cfg.openaiModel;

  var SRC =
    'The new patch fixed the texture streaming issue and reduced VRAM usage, ' +
    'but ray tracing still crashes when the shader cache is cold. ' +
    'Please update your graphics driver.';

  // 走 engine，带上 glossary —— 验证提示词注入是否生效
  var t0 = Date.now();
  var r = await window.DTEngine.translate([SRC], {
    provider: 'openai',
    openaiBase: 'http://127.0.0.1:11434/v1',
    openaiKey: 'ollama',
    openaiModel: 'qwen2.5:3b',
    targetLang: 'zh-CN',
    sourceLang: 'en',
    glossary: cfg.glossary || [],
    timeout: 120000,
    retries: 1
  });

  out.ms = Date.now() - t0;
  out.ok = !!(r[0] && r[0].ok);
  out.text = (r[0] && r[0].text) || '';
  out.error = (r[0] && r[0].error) || '';

  // 术语命中
  var terms = ['显卡驱动', '纹理流送', '光线追踪', '着色器', '补丁', '显存', '崩溃'];
  out.hits = terms.filter(function (t) {
    return out.text.indexOf(t) >= 0;
  });
  out.hitRate = out.hits.length + '/' + terms.length;

  // 占位符残留（说明走了替换方案）
  out.hasPlaceholder = /<\d+>/.test(out.text);

  return JSON.stringify(out, null, 2);
})()
