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

  function read(ed) {
    return String(ed.textContent || '')
      .replace(/^\uFEFF/, '')
      .trim();
  }

  var ed = document.querySelector('[role="textbox"][contenteditable="true"]');
  if (!ed) return JSON.stringify({ error: 'no editor' });

  var out = {};

  // 1. 写入原文
  selectAll(ed);
  document.execCommand('insertText', false, '大家好今天的更新发布了');
  await sleep(300);
  out.original = read(ed);

  // 2. 真翻译（走 IPC）
  var res = await window.__dtTranslate([out.original], Object.assign({}, window.__dtCfg, {
    targetLang: 'en',
    skipSameLang: true
  }));
  out.translated = res && res[0] ? res[0].text : null;

  // 3. 重新取编辑器（模拟 translateComposer 的 getComposer）
  var now = document.querySelector('[role="textbox"][contenteditable="true"]');
  out.sameNode = now === ed;
  out.nowText = now ? read(now) : null;
  out.textUnchanged = out.nowText === out.original;

  // 4. 替换（完全照搬 replaceComposer 的步骤）
  selectAll(now);
  out.rangeCount = window.getSelection().rangeCount;
  out.anchorInEditor = window.getSelection().anchorNode
    ? now.contains(window.getSelection().anchorNode)
    : false;

  var ok = false;
  try {
    ok = document.execCommand('insertText', false, out.translated);
  } catch (e) {
    out.execError = String(e);
  }
  out.execOk = ok;

  await sleep(300);
  out.after = read(now);
  out.success = !!out.after && out.after !== out.original;

  // 5. 清理
  selectAll(now);
  document.execCommand('delete');
  await sleep(200);
  out.cleared = !read(now);

  return JSON.stringify(out, null, 2);
})()
