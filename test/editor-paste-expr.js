(async function () {
  var sleep = function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  };

  function getEditor() {
    return document.querySelector('[role="textbox"][contenteditable="true"]');
  }

  function selectAll(ed) {
    ed.focus();
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function clear(ed) {
    ed.focus();
    selectAll(ed);
    document.execCommand('delete', false, null);
    // 双保险
    if ((ed.textContent || '').trim()) {
      ed.innerHTML = '';
    }
  }

  var ed = getEditor();
  if (!ed) return JSON.stringify({ error: 'no editor' });

  var out = { before: (ed.textContent || '').slice(0, 60), methods: {} };

  // ---- 方法 1：paste 事件 ----
  try {
    selectAll(ed);
    var dt = new DataTransfer();
    dt.setData('text/plain', 'PASTE TEST 你好');
    var ev = new ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true
    });
    ed.dispatchEvent(ev);
    await sleep(350);
    out.methods.paste = {
      text: (ed.textContent || '').slice(0, 60),
      defaultPrevented: ev.defaultPrevented
    };
  } catch (e) {
    out.methods.paste = 'ERR ' + e.message;
  }

  clear(ed);
  await sleep(200);

  // ---- 方法 2：execCommand insertText ----
  try {
    ed.focus();
    selectAll(ed);
    document.execCommand('insertText', false, 'INSERTTEXT TEST 世界');
    await sleep(350);
    out.methods.execCommand = { text: (ed.textContent || '').slice(0, 60) };
  } catch (e) {
    out.methods.execCommand = 'ERR ' + e.message;
  }

  clear(ed);
  await sleep(200);

  // ---- 方法 3：beforeinput 事件 ----
  try {
    ed.focus();
    selectAll(ed);
    var ev2 = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'BEFOREINPUT TEST',
      bubbles: true,
      cancelable: true
    });
    ed.dispatchEvent(ev2);
    await sleep(350);
    out.methods.beforeinput = {
      text: (ed.textContent || '').slice(0, 60),
      defaultPrevented: ev2.defaultPrevented
    };
  } catch (e) {
    out.methods.beforeinput = 'ERR ' + e.message;
  }

  clear(ed);
  await sleep(300);

  out.afterAll = (ed.textContent || '').slice(0, 60);
  out.cleaned = !(ed.textContent || '').trim();

  return JSON.stringify(out, null, 2);
})()
