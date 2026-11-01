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
  if (!ed) return JSON.stringify({ error: 'no editor found' });

  var out = {};
  var SRC = '大家好，今天的更新已经发布了，记得更新显卡驱动。';

  // ---- 1. 用 execCommand 写入中文（模拟用户打字）----
  selectAll(ed);
  document.execCommand('insertText', false, SRC);
  await sleep(400);
  out.before = (ed.textContent || '').trim();

  // ---- 2. 触发翻译（等价于 Alt+Enter）----
  out.hasApi = typeof window.DTDom.translateComposer === 'function';
  await window.DTDom.translateComposer();
  await sleep(4000);
  out.after = (ed.textContent || '').trim();

  var toast = document.getElementById('dt-toast');
  out.toast = toast ? toast.textContent : null;
  out.toastVisible = toast ? toast.classList.contains('show') : false;

  // ---- 3. 清空，不影响用户 ----
  selectAll(ed);
  document.execCommand('delete');
  await sleep(250);
  out.cleared = !(ed.textContent || '').trim();

  return JSON.stringify(out, null, 2);
})()
