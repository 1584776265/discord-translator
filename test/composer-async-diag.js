(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  function selectAll(ed) {
    ed.focus();
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  var ed = document.querySelector('[role="textbox"][contenteditable="true"]');
  if (!ed) return JSON.stringify({ error: 'no editor' });

  var out = {};

  // 1. 同步写入
  selectAll(ed);
  out.exec1 = document.execCommand('insertText', false, '第一次写入');
  await sleep(300);
  out.after1 = (ed.textContent || '').trim();
  out.focus1 = document.hasFocus();

  // 2. 等 3 秒（模拟翻译耗时）
  await sleep(3000);
  out.focus2 = document.hasFocus();
  out.selAfterWait = window.getSelection().rangeCount;
  out.anchorInEditor = window.getSelection().anchorNode
    ? ed.contains(window.getSelection().anchorNode)
    : false;

  // 3. 异步之后再写
  selectAll(ed);
  out.exec2 = document.execCommand('insertText', false, 'SECOND WRITE');
  await sleep(300);
  out.after2 = (ed.textContent || '').trim();

  // 4. 清理
  selectAll(ed);
  document.execCommand('delete');
  await sleep(200);
  out.cleared = !(ed.textContent || '').trim();

  return JSON.stringify(out, null, 2);
})()
