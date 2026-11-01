(function () {
  var out = {};

  out.bdApi = typeof window.BdApi;
  out.bdPlugins = !!(window.BdApi && window.BdApi.Plugins);

  if (window.BdApi && window.BdApi.Plugins) {
    try {
      var st = window.BdApi.Plugins.get('DiscordTranslator');
      out.plugin = st
        ? { found: true, enabled: st.enabled, instance: typeof st.instance }
        : { found: false };
      if (st && st.instance) {
        out.plugin.started = st.instance.started;
      }
    } catch (e) {
      out.plugin = 'ERR ' + e.message;
    }

    try {
      var at = window.BdApi.Plugins.get('AutoTranslate');
      var tr = window.BdApi.Plugins.get('Translator');
      out.others = {
        AutoTranslate: at ? at.enabled : 'absent',
        Translator: tr ? tr.enabled : 'absent'
      };
    } catch (e) {
      out.others = 'ERR';
    }
  }

  out.eng = typeof window.DTEngine;
  out.dom = typeof window.DTDom;
  out.netChannel = window.DTEngine ? window.DTEngine.networkInfo() : null;
  out.stats = window.DTDom ? window.DTDom.stats() : null;

  out.msgNodes = document.querySelectorAll('li[id^="chat-messages-"]').length;
  out.contentNodes = document.querySelectorAll('[id^="message-content-"]').length;
  out.transNodes = document.querySelectorAll('.dt-trans').length;
  out.bdfdb = !!(window.BDFDB_Global && window.BDFDB_Global.loaded);
  out.url = location.href;

  return JSON.stringify(out, null, 2);
})()
