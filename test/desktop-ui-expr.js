(function () {
  function txt(id) {
    var el = document.getElementById(id);
    return el ? el.textContent : null;
  }

  return JSON.stringify(
    {
      title: document.title,
      status: txt('statusText'),
      detail: txt('statusDetail'),
      hint: txt('hint'),
      btnConnect: txt('btnConnect'),
      metrics: {
        translated: txt('mTranslated'),
        total: txt('mTotal'),
        usage: txt('mUsage'),
        provider: txt('mProvider')
      },
      diag: {
        port: txt('dPort'),
        cdp: txt('dCdp'),
        net: txt('dNet'),
        url: txt('dUrl'),
        cache: txt('dCache'),
        config: txt('dConfig')
      },
      log: (txt('logBox') || '').slice(-600)
    },
    null,
    2
  );
})()
