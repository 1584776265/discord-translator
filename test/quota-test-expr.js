(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  var out = {};

  // 再跑一次探测：这次 mymemory 应该命中 quota 缓存，不发请求直接报恢复时间
  document.getElementById('btnTest').click();
  await sleep(9000);

  out.healthSecond = Array.prototype.map.call(document.querySelectorAll('.health-row'), function (r) {
    var dot = r.querySelector('.dot');
    return {
      dot: dot ? dot.className : '',
      text: r.textContent.replace(/\s+/g, ' ').trim().slice(0, 70)
    };
  });

  // auto 模式应该直接跳过 mymemory
  var t0 = Date.now();
  var res = await window.DTEngine.translate(['Hello there, how are you doing?'], {
    provider: 'auto',
    targetLang: 'zh-CN',
    sourceLang: 'auto'
  });

  out.auto = {
    ms: Date.now() - t0,
    ok: !!(res[0] && res[0].ok),
    provider: res[0] && res[0].provider,
    text: res[0] && res[0].text
  };

  return JSON.stringify(out, null, 2);
})()
