(function () {
  var out = {
    logs: (window.__logs || []).slice(0, 40),
    stats: window.DTDom ? window.DTDom.stats() : null,
    rendered: [],
    transCount: document.querySelectorAll('.dt-trans').length
  };
  document.querySelectorAll('li[id^="chat-messages-"]').forEach(function (li) {
    var t = li.querySelector('.dt-trans .dt-text');
    out.rendered.push({ id: li.id.replace('chat-messages-1000-', ''), has: !!t, text: t ? t.textContent.slice(0, 40) : null });
  });
  return JSON.stringify(out, null, 2);
})()
