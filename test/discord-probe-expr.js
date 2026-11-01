(function () {
  var out = {};

  out.url = location.href;
  out.title = document.title;
  out.readyState = document.readyState;

  // 服务器栏
  var guilds = document.querySelectorAll('[data-list-item-id^="guildsnav_"]');
  out.guilds = Array.prototype.map.call(guilds, function (e) {
    return {
      id: e.getAttribute('data-list-item-id'),
      label: (e.getAttribute('aria-label') || '').slice(0, 40)
    };
  });

  // 频道列表
  var channels = document.querySelectorAll('[data-list-item-id^="channels___"]');
  out.channels = Array.prototype.slice.call(channels, 0, 15).map(function (e) {
    return {
      id: e.getAttribute('data-list-item-id'),
      label: (e.getAttribute('aria-label') || '').slice(0, 40)
    };
  });

  // 消息相关节点
  out.msgListItems = document.querySelectorAll('li[id^="chat-messages-"]').length;
  out.messageContents = document.querySelectorAll('[id^="message-content-"]').length;
  out.anyLi = document.querySelectorAll('ol[data-list-id="chat-messages"] > li').length;

  // 看看消息容器长什么样
  var ol = document.querySelector('ol[data-list-id="chat-messages"]');
  if (ol) {
    out.olClass = ol.className;
    var firstLi = ol.querySelector('li');
    if (firstLi) {
      out.firstLiId = firstLi.id;
      out.firstLiClass = String(firstLi.className).slice(0, 120);
      out.firstLiHtml = firstLi.outerHTML.slice(0, 600);
    }
  }

  // React root 探测
  out.hasReactRoot = !!document.querySelector('#app-mount');

  return JSON.stringify(out, null, 2);
})()
