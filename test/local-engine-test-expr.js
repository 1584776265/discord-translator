(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  var out = {};

  // 1. 点部署（本机没 Docker，应该给出明确指引而不是静默失败）
  document.getElementById('btnDeployLibre').click();
  await sleep(4000);
  out.deployMsg = document.getElementById('deployMsg').textContent;
  out.deployBtnDisabled = document.getElementById('btnDeployLibre').disabled;

  // 2. 测各翻译源，看 mymemory 是否被标成额度耗尽
  document.getElementById('btnTest').click();
  await sleep(13000);

  out.health = Array.prototype.map.call(document.querySelectorAll('.health-row'), function (r) {
    var dot = r.querySelector('.dot');
    return {
      dotClass: dot ? dot.className : '',
      text: r.textContent.replace(/\s+/g, ' ').trim()
    };
  });

  return JSON.stringify(out, null, 2);
})()
