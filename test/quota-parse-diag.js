(async function () {
  var r = await window.DTEngine.translate(['hello there'], {
    provider: 'mymemory',
    targetLang: 'zh-CN',
    sourceLang: 'auto'
  });

  var err = (r[0] && r[0].error) || '';
  var re = /NEXT AVAILABLE IN (\d+)\s*HOURS?\s*(\d+)\s*MINUTES?/i;
  var m = String(err).match(re);

  return JSON.stringify(
    {
      errLen: err.length,
      errHead: err.slice(0, 150),
      errTail: err.slice(-80),
      hasPhrase: /NEXT AVAILABLE IN/i.test(err),
      matched: m ? { full: m[0], h: m[1], min: m[2] } : null,
      regexSource: String(re)
    },
    null,
    2
  );
})()
