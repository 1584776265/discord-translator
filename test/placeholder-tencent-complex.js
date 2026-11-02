/**
 * 腾讯在复杂句里能不能保住 <0> 占位符
 * 之前只测了简单句，这里用和 LibreTranslate 相同的硬骨头
 */
const engine = require('../extension/src/core/engine.js');

const CASES = [
  'The new <0> fixed the <1> issue, please update your <2>.',
  'Update the <0> and the <1> before launch.',
  '<0> caused the crash on my machine.',
  'Enable <0><1> in the settings panel.',
  "We've pushed a <0> that should fix most of the <1> problems people reported."
];

async function main() {
  const settings = {
    provider: 'tencent',
    targetLang: 'zh-CN',
    sourceLang: 'en',
    concurrency: 2,
    timeout: 20000,
    retries: 1
  };

  const rows = [];

  for (const q of CASES) {
    try {
      const r = await engine.translate([q], settings);
      const text = (r[0] && r[0].text) || '';
      const kept0 = text.indexOf('<0>') >= 0;
      rows.push({ ok: !!(r[0] && r[0].ok), kept0, src: q, dst: text });
    } catch (e) {
      rows.push({ ok: false, error: e.message, src: q });
    }
  }

  console.log(JSON.stringify(rows, null, 2));

  const survived = rows.filter((r) => r.kept0).length;
  console.log(`\n=== 腾讯：${survived}/${rows.length} 个用例保住占位符 ===`);
}

main();
