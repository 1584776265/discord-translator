/**
 * 交叉验证：<0> 占位符在腾讯 / Google / LibreTranslate 下是否都能保留
 * 术语表要在所有引擎上一致生效，不能只为某一家定制
 */
const engine = require('../extension/src/core/engine.js');

const MARK = (i) => `<${i}>`;

const SRC = `Update the ${MARK(0)} and the ${MARK(1)} before launch.`;

async function tryProvider(provider, extra) {
  const settings = Object.assign(
    {
      provider,
      targetLang: 'zh-CN',
      sourceLang: 'en',
      concurrency: 2,
      timeout: 20000,
      retries: 1
    },
    extra || {}
  );

  const t0 = Date.now();
  try {
    const r = await engine.translate([SRC], settings);
    const text = (r[0] && r[0].text) || '';
    return {
      provider,
      ok: !!(r[0] && r[0].ok),
      ms: Date.now() - t0,
      kept0: text.indexOf(MARK(0)) >= 0,
      kept1: text.indexOf(MARK(1)) >= 0,
      text
    };
  } catch (e) {
    return { provider, ok: false, ms: Date.now() - t0, error: e.message };
  }
}

async function main() {
  const results = [];

  results.push(await tryProvider('tencent'));
  results.push(await tryProvider('libre', { libreUrl: 'http://127.0.0.1:5000' }));
  results.push(await tryProvider('google'));

  console.log(JSON.stringify(results, null, 2));

  console.log('\n=== 汇总 ===');
  for (const r of results) {
    if (!r.ok) {
      console.log(`⚠️  ${r.provider}: 不可用 (${r.error || 'no result'})`);
      continue;
    }
    const both = r.kept0 && r.kept1;
    console.log(`${both ? '✅' : '❌'}  ${r.provider.padEnd(8)} ${r.text}`);
  }
}

main();
