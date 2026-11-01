(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  var ed = document.querySelector('[role="textbox"][contenteditable="true"]');
  if (!ed) return JSON.stringify({ error: 'no editor' });

  var out = {};

  ed.focus();
  var sel = window.getSelection();
  var range = document.createRange();
  range.selectNodeContents(ed);
  sel.removeAllRanges();
  sel.addRange(range);

  out.execResult = document.execCommand('insertText', false, '中文测试ABC');
  await sleep(400);
  out.textAfterExec = ed.textContent;
  out.htmlAfterExec = ed.innerHTML.slice(0, 150);

  // 再测一次：替换已有内容
  ed.focus();
  var s2 = window.getSelection();
  var r2 = document.createRange();
  r2.selectNodeContents(ed);
  s2.removeAllRanges();
  s2.addRange(r2);
  document.execCommand('insertText', false, 'REPLACED');
  await sleep(400);
  out.textAfterReplace = ed.textContent;

  // 清理
  ed.focus();
  var s3 = window.getSelection();
  var r3 = document.createRange();
  r3.selectNodeContents(ed);
  s3.removeAllRanges();
  s3.addRange(r3);
  document.execCommand('delete');
  await sleep(250);
  out.cleared = !(ed.textContent || '').trim();

  return JSON.stringify(out, null, 2);
})()
