(async function () {
  var inv = window.__TAURI__.core.invoke;
  var out = {};
  var path = 'C:\\Users\\Hi\\AppData\\Local\\Temp\\dt-glossary-test.txt';

  out.imported = await inv('import_glossary', { path: path });

  var cfg = await inv('get_config');
  out.exported = await inv('export_glossary', {
    cfg: Object.assign({}, cfg, { glossary: out.imported }),
    path: path + '.out.txt'
  });

  return JSON.stringify(out, null, 2);
})()
