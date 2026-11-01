(function () {
  function info(msgId) {
    var li = document.getElementById('chat-messages-1000-' + msgId);
    if (!li) return { id: msgId, error: 'li not found' };
    var content = li.querySelector('[id^="message-content-"]');
    var trans = li.querySelector('.dt-trans');
    var textEl = trans ? trans.querySelector('.dt-text') : null;
    return {
      id: msgId,
      hasContent: !!content,
      hasTrans: !!trans,
      transText: textEl ? textEl.textContent : null,
      attrFor: trans ? trans.getAttribute('data-dt-for') : null,
      attrSrcLen: trans ? (trans.getAttribute('data-dt-src') || '').length : null,
      attrLang: trans ? trans.getAttribute('data-dt-lang') : null,
      attrTarget: trans ? trans.getAttribute('data-dt-target') : null,
      contentLen: content ? content.textContent.length : 0,
      contentPreview: content ? content.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : null,
      detected: window.DTEngine ? window.DTEngine.detectScript(content ? content.textContent : '') : null
    };
  }

  var ids = ['2001', '2006', '2008', '2010'];
  var out = { items: ids.map(info) };
  out.stats = window.DTDom ? window.DTDom.stats() : null;
  out.cacheSize = window.DTEngine ? window.DTEngine.cacheStats().size : null;

  if (window.DTEngine && window.__settings) {
    var t = document.getElementById('chat-messages-1000-2010');
    var c = t ? t.querySelector('[id^="message-content-"]') : null;
    out.probeText2010 = c ? c.textContent.replace(/\s+/g, ' ').trim() : null;
    out.probeTranslatable = c && window.DTDom ? window.DTDom.isTranslatable(window.DTDom.extractText(c)) : null;
    out.probeExtract = c && window.DTDom ? window.DTDom.extractText(c).slice(0, 120) : null;
  }

  return JSON.stringify(out, null, 2);
})()
