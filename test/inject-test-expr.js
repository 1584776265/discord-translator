(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  var out = {};

  // 从扩展页面新开一个 mock 页（等价于用户打开 Discord 标签页）
  var tab = await chrome.tabs.create({
    url: 'http://127.0.0.1:8899/test/mock-discord.html?auto=0',
    active: false
  });
  out.tabId = tab.id;
  await sleep(3000);

  // 真实注入：与 manifest 里声明的一模一样
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ['src/content/content.css']
  });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: [
      'src/core/engine.js',
      'src/core/settings.js',
      'src/core/dom.js',
      'src/content/content.js'
    ]
  });

  out.injected = true;
  await sleep(7000);

  var res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function () {
      var rows = [];
      document.querySelectorAll('li[id^="chat-messages-"]').forEach(function (li) {
        var t = li.querySelector('.dt-trans .dt-text');
        rows.push({ id: li.id, has: !!t, text: t ? t.textContent.slice(0, 34) : null });
      });
      return {
        rendered: document.querySelectorAll('.dt-trans').length,
        rows: rows,
        stats: window.DTDom ? window.DTDom.stats() : null
      };
    }
  });

  out.page = res[0].result;
  out.translatedCount = out.page.rows.filter(function (r) { return r.has; }).length;
  return JSON.stringify(out, null, 2);
})()
