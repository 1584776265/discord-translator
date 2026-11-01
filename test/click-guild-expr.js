(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  var el = document.querySelector('[data-list-item-id="guildsnav___1545589274840272946"]');
  if (!el) return 'no guild element found';
  el.click();
  await sleep(5000);

  var out = {
    url: location.href,
    channelItems: document.querySelectorAll('[data-list-item-id^="channels___"]').length,
    msgCount: document.querySelectorAll('li[id^="chat-messages-"]').length,
    contents: document.querySelectorAll('[id^="message-content-"]').length
  };

  if (out.msgCount === 0) {
    // 再点第一个文字频道
    var ch = document.querySelector('[data-list-item-id^="channels___"]');
    if (ch) {
      ch.click();
      await sleep(5000);
      out.url2 = location.href;
      out.msgCount2 = document.querySelectorAll('li[id^="chat-messages-"]').length;
      out.contents2 = document.querySelectorAll('[id^="message-content-"]').length;
    }
  }

  return JSON.stringify(out, null, 2);
})()
