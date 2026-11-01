(function () {
  var out = {};

  var candidates = document.querySelectorAll('[role="textbox"][contenteditable="true"]');
  out.count = candidates.length;

  var items = [];
  for (var i = 0; i < candidates.length; i++) {
    var ed = candidates[i];
    var r = ed.getBoundingClientRect();
    items.push({
      tag: ed.tagName,
      cls: String(ed.className).slice(0, 100),
      ariaLabel: ed.getAttribute('aria-label'),
      dataSlateEditor: ed.getAttribute('data-slate-editor'),
      rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
      textLen: (ed.textContent || '').length,
      parentCls: ed.parentElement ? String(ed.parentElement.className).slice(0, 80) : null,
      gpCls: ed.parentElement && ed.parentElement.parentElement ? String(ed.parentElement.parentElement.className).slice(0, 80) : null
    });
  }
  out.editors = items;

  // 找发送按钮
  var btns = document.querySelectorAll('button[aria-label]');
  var sendLabels = [];
  for (var j = 0; j < btns.length; j++) {
    var lb = btns[j].getAttribute('aria-label') || '';
    if (/发送|Send/i.test(lb)) {
      sendLabels.push({ label: lb, cls: String(btns[j].className).slice(0, 60) });
    }
  }
  out.sendButtons = sendLabels;

  // 探测 Slate/React 内部结构
  if (candidates.length) {
    var ed0 = candidates[0];
    var fiberKey = Object.keys(ed0).find(function (k) {
      return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactProps$') === 0;
    });
    out.hasReactKey = !!fiberKey;
    out.reactKeyName = fiberKey ? fiberKey.slice(0, 24) : null;
  }

  return JSON.stringify(out, null, 2);
})()
