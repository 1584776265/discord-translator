(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  var eds = document.querySelectorAll('[role="textbox"][contenteditable="true"]');
  var ed = eds[0];
  var out = { count: eds.length };
  if (!ed) return JSON.stringify(out);

  out.edCls = String(ed.className).slice(0, 70);
  out.edAria = ed.getAttribute('aria-label');
  out.edTextBefore = JSON.stringify(ed.textContent);
  out.edHtmlBefore = ed.innerHTML.slice(0, 200);

  ed.focus();
  await sleep(100);
  out.focusWorked = document.activeElement === ed;
  out.activeDesc = document.activeElement
    ? document.activeElement.tagName + '|' + String(document.activeElement.className).slice(0, 50)
    : null;

  var sel = window.getSelection();
  var range = document.createRange();
  range.selectNodeContents(ed);
  sel.removeAllRanges();
  sel.addRange(range);
  out.rangeCount = sel.rangeCount;
  out.anchorInEditor = sel.anchorNode ? ed.contains(sel.anchorNode) : false;

  var dt = new DataTransfer();
  dt.setData('text/plain', '中文测试TEST123');
  out.dtReadBack = dt.getData('text/plain');

  var ev = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true
  });
  out.hasClipboardData = !!ev.clipboardData;
  out.evData = ev.clipboardData ? ev.clipboardData.getData('text/plain') : null;

  ed.dispatchEvent(ev);
  out.defaultPrevented = ev.defaultPrevented;
  await sleep(500);

  out.edTextAfter = JSON.stringify(ed.textContent);
  out.edHtmlAfter = ed.innerHTML.slice(0, 200);

  // 清理
  ed.focus();
  var s2 = window.getSelection();
  var r2 = document.createRange();
  r2.selectNodeContents(ed);
  s2.removeAllRanges();
  s2.addRange(r2);
  document.execCommand('delete');
  await sleep(200);
  out.cleared = !(ed.textContent || '').trim();

  return JSON.stringify(out, null, 2);
})()
