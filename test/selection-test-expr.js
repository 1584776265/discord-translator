(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };
  var out = {};

  var contents = document.querySelectorAll('[id^="message-content-"]');
  out.totalMessages = contents.length;

  var target = null;
  for (var i = 0; i < contents.length; i++) {
    var t = (contents[i].textContent || '').trim();
    if (t.length > 20 && /[a-zA-Z]{3,}/.test(t)) {
      target = contents[i];
      break;
    }
  }

  if (!target) {
    return JSON.stringify({ error: '没有找到英文消息', total: contents.length }, null, 2);
  }

  out.sample = target.textContent.trim().slice(0, 70);

  // 选中前 30 个字符
  var walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, null);
  var textNode = walker.nextNode();
  if (!textNode) return JSON.stringify({ error: 'no text node' });

  var len = Math.min(30, textNode.textContent.length);
  var range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, len);

  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));

  await sleep(600);

  var btn = document.querySelector('.dt-selbtn');
  out.btnExists = !!btn;
  out.btnShown = btn ? btn.classList.contains('show') : false;
  out.btnPos = btn ? { left: btn.style.left, top: btn.style.top } : null;

  if (btn && out.btnShown) {
    // 点它
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(1200);

    var pop = document.querySelector('.dt-selpop');
    out.popExists = !!pop;
    out.popShown = pop ? pop.classList.contains('show') : false;
    out.popText = pop ? pop.textContent.slice(0, 120) : '';
    out.popIsError = pop ? pop.classList.contains('dt-selpop--err') : null;

    // 再等一会，看是否变成译文
    await sleep(3000);
    var pop2 = document.querySelector('.dt-selpop');
    out.popTextFinal = pop2 ? pop2.textContent.slice(0, 160) : '';
  }

  return JSON.stringify(out, null, 2);
})()
