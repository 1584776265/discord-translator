(async function () {
  var results = {};

  // 1. 后台连接
  results.ping = await new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: 'dt:ping' }, function (r) {
      resolve(chrome.runtime.lastError ? 'ERR ' + chrome.runtime.lastError.message : r);
    });
  });

  // 2. 真实翻译请求
  var t0 = Date.now();
  results.translate = await new Promise(function (resolve) {
    chrome.runtime.sendMessage(
      { type: 'dt:translate', texts: ['Hello world, this is a test.', 'こんにちは'] },
      function (r) {
        resolve(chrome.runtime.lastError ? 'ERR ' + chrome.runtime.lastError.message : r);
      }
    );
  });
  results.translateMs = Date.now() - t0;

  // 3. 缓存统计
  results.stats = await new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: 'dt:stats' }, function (r) {
      resolve(chrome.runtime.lastError ? 'ERR' : r);
    });
  });

  // 4. 按钮流程
  document.getElementById('btnTest').click();
  await new Promise(function (r) {
    setTimeout(r, 3500);
  });
  results.toast = document.getElementById('toast').textContent;

  return JSON.stringify(results, null, 2);
})()
