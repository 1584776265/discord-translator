(function () {
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  var lis = document.querySelectorAll('li[id^="chat-messages-"]');
  var out = { total: lis.length, items: [] };

  for (var i = 0; i < Math.min(3, lis.length); i++) {
    var li = lis[i];
    var content = li.querySelector('[id^="message-content-"]');
    var trans = li.querySelector('.dt-trans');
    var cs = trans ? getComputedStyle(trans) : null;
    var parent = content ? content.parentElement : null;

    out.items.push({
      id: li.id,
      liClass: String(li.className).slice(0, 100),
      liRect: rect(li),
      contentRect: rect(content),
      transRect: rect(trans),
      contentParentClass: parent ? String(parent.className).slice(0, 100) : null,
      contentParentDisplay: parent ? getComputedStyle(parent).display : null,
      contentParentPosition: parent ? getComputedStyle(parent).position : null,
      transCss: cs
        ? {
            display: cs.display,
            position: cs.position,
            opacity: cs.opacity,
            fontSize: cs.fontSize,
            color: cs.color,
            zIndex: cs.zIndex,
            marginTop: cs.marginTop,
            gridColumn: cs.gridColumn,
            maxHeight: cs.maxHeight,
            overflow: cs.overflow
          }
        : null,
      siblings: parent
        ? Array.prototype.map.call(parent.children, function (e) {
            return (
              String(e.className).slice(0, 40) +
              ' | h=' +
              Math.round(e.getBoundingClientRect().height) +
              ' y=' +
              Math.round(e.getBoundingClientRect().y)
            );
          })
        : null
    });
  }

  return JSON.stringify(out, null, 2);
})()
