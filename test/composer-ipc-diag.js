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

  // 写入原文
  selectAll(ed);
  document.execCommand('insertText', false, '原始中文内容');
  await sleep(300);
  out.before = (ed.textContent || '').trim();

  // 走一次真实 IPC 往返（和 translateComposer 里一样）
  var t0 = Date.now();
  var res = await window.__dtTranslate(['hello world this is a test'], window.__dtCfg);
  out.ipcMs = Date.now() - t0;
  out.ipcOk = !!(res && res[0] && res[0].ok);
  out.ipcText = res && res[0] ? res[0].text : null;

  // IPC 之后检查编辑器状态
  out.edStillConnected = ed.isConnected;
  out.selRanges = window.getSelection().rangeCount;
  out.activeIsEditor = document.activeElement === ed;

  // IPC 之后写入
  selectAll(ed);
  out.execOk = document.execCommand('insertText', false, 'AFTER IPC WRITE');
  await sleep(350);
  out.afterIpc = (ed.textContent || '').trim();

  // 清理
  selectAll(ed);
  document.execCommand('delete');
  await sleep(200);
  out.cleared = !(ed.textContent || '').trim();

  return JSON.stringify(out, null, 2);
})()
