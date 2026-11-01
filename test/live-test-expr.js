(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var result = {};

  // ---- 1. 动态插入新消息（模拟 Discord 收到新消息 / 滚动加载） ----
  var ol = document.querySelector('.scroller_test');
  var li = document.createElement('li');
  li.id = 'chat-messages-1000-3001';
  li.className = 'messageListItem_x';
  li.innerHTML =
    '<div class="contents_zz"><img class="avatar"><h3 class="header_1"><span class="username_2">NewUser</span></h3>' +
    '<div id="message-content-3001" class="messageContent_4">This message was inserted dynamically, please translate it.</div></div>';
  ol.appendChild(li);

  await sleep(4500);
  var t1 = li.querySelector('.dt-trans .dt-text');
  result.dynamicInsert = { translated: !!t1, text: t1 ? t1.textContent : null };

  // ---- 2. 编辑已有消息 ----
  var el = document.getElementById('message-content-2001');
  el.textContent = 'The message was edited and now the content is completely different.';
  await sleep(4500);
  var li2001 = document.getElementById('chat-messages-1000-2001');
  var t2 = li2001.querySelector('.dt-trans .dt-text');
  result.editMessage = { translated: !!t2, text: t2 ? t2.textContent : null };

  // ---- 3. React 复用节点：把 li 指向另一条消息 ----
  var li3001 = document.getElementById('chat-messages-1000-3001');
  var oldId = li3001.getAttribute('data-probe');
  li3001.id = 'chat-messages-1000-3002';
  var c = li3001.querySelector('[id^="message-content-"]');
  c.id = 'message-content-3002';
  c.textContent = 'Reused DOM node now showing a brand new message, does it retranslate?';
  await sleep(4500);
  var t3 = li3001.querySelector('.dt-trans .dt-text');
  result.reuseNode = { translated: !!t3, text: t3 ? t3.textContent : null };

  // ---- 4. 批量插入 20 条，看性能 ----
  var t0 = Date.now();
  for (var i = 0; i < 20; i++) {
    var nli = document.createElement('li');
    nli.id = 'chat-messages-1000-' + (4000 + i);
    nli.className = 'messageListItem_x';
    nli.innerHTML =
      '<div class="contents_zz"><img class="avatar"><h3 class="header_1"><span class="username_2">Bulk' +
      i +
      '</span></h3><div id="message-content-' +
      (4000 + i) +
      '" class="messageContent_4">Bulk message number ' +
      (i + 1) +
      ': the quick brown fox jumps over the lazy dog.</div></div>';
    ol.appendChild(nli);
  }
  await sleep(6000);
  var done = 0;
  for (var j = 0; j < 20; j++) {
    var bl = document.getElementById('chat-messages-1000-' + (4000 + j));
    if (bl && bl.querySelector('.dt-trans .dt-text')) done++;
  }
  result.bulk20 = { translated: done, elapsedMs: Date.now() - t0, stats: DTDom.stats() };

  return JSON.stringify(result, null, 2);
})()
