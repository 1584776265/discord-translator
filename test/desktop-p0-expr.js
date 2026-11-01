(async function () {
  var invoke = window.__TAURI__.core.invoke;
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var out = {};

  // ---- 1. 只翻译这个频道 ----
  document.getElementById('btnCurOnly').click();
  await sleep(900);
  var cfg1 = await invoke('get_config');
  out.whitelistAfterCurOnly = cfg1.channelWhitelist;
  out.chState = document.getElementById('chState').textContent;
  out.removeDisabled = document.getElementById('btnRemoveWhite').disabled;

  // ---- 2. 移出白名单 ----
  document.getElementById('btnRemoveWhite').click();
  await sleep(900);
  var cfg2 = await invoke('get_config');
  out.whitelistAfterRemove = cfg2.channelWhitelist;
  out.chStateFinal = document.getElementById('chState').textContent;

  // ---- 3. 翻译源健康度 ----
  document.getElementById('btnTest').click();
  await sleep(10000);
  out.health = Array.prototype.map.call(document.querySelectorAll('.health-row'), function (r) {
    return r.textContent.replace(/\s+/g, ' ').trim();
  });

  // ---- 4. 关闭窗口行为（模拟：检查 tray hint 标记是否已存在）----
  out.trayHintMarker = '见 Rust 侧';

  return JSON.stringify(out, null, 2);
})()
