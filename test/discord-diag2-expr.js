(function () {
  function rect(el) {
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  var lis = document.querySelectorAll('li[id^="chat-messages-"]');
  var withTrans = 0;
  var withContent = 0;
  var sample = null;
  var missing = [];

  for (var i = 0; i < lis.length; i++) {
    var li = lis[i];
    var content = li.querySelector('[id^="message-content-"]');
    if (content) withContent++;
    var t = li.querySelector('.dt-trans');
    if (t) {
      withTrans++;
      if (!sample) sample = { li: li, content: content, t: t };
    } else if (content && missing.length < 6) {
      missing.push({
        id: li.id,
        text: content.textContent.replace(/\s+/g, ' ').trim().slice(0, 50)
      });
    }
  }

  var out = {
    total: lis.length,
    withContent: withContent,
    withTrans: withTrans,
    missingSample: missing
  };

  if (sample) {
    var cs = getComputedStyle(sample.t);
    var te = sample.t.querySelector('.dt-text');
    var badge = sample.t.querySelector('.dt-badge');
    out.sample = {
      liId: sample.li.id,
      textLen: te ? te.textContent.length : 0,
      textStart: te ? te.textContent.slice(0, 60) : null,
      hasBadge: !!badge,
      liRect: rect(sample.li),
      contentRect: rect(sample.content),
      transRect: rect(sample.t),
      css: {
        display: cs.display,
        position: cs.position,
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        color: cs.color,
        opacity: cs.opacity,
        whiteSpace: cs.whiteSpace,
        paddingLeft: cs.paddingLeft,
        marginTop: cs.marginTop,
        borderLeft: cs.borderLeft
      },
      transHtmlHead: sample.t.outerHTML.slice(0, 320)
    };
  }

  out.hasStyleTag = !!document.getElementById('dt-style');
  out.injectedCssAny = Array.prototype.some.call(document.querySelectorAll('style'), function (s) {
    return s.textContent && s.textContent.indexOf('dt-trans') >= 0;
  });

  return JSON.stringify(out, null, 2);
})()
