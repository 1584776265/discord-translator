/**
 * 长文本翻译能力测试：区分是引擎限制还是 Discord DOM 截断
 */
const engine = require('../extension/src/core/engine.js');

function makeText(chars) {
  const base =
    'The renderer now uses a deferred shading pipeline, which means each light source ' +
    'requires a separate pass over the geometry buffer. This is why enabling ray tracing ' +
    'in dense scenes causes frame time to spike, and why the texture streaming budget ' +
    'matters so much on cards with limited VRAM. ';
  let out = '';
  while (out.length < chars) out += base;
  return out.slice(0, chars).trim();
}

async function run(provider, extra, sizes) {
  const settings = Object.assign(
    { provider, targetLang: 'zh-CN', sourceLang: 'en', concurrency: 4, timeout: 120000, retries: 1 },
    extra || {}
  );

  const rows = [];
  for (const size of sizes) {
    const text = makeText(size);
    const t0 = Date.now();
    try {
      const r = await engine.translate([text], settings);
      const res = r[0] || {};
      rows.push({
        chars: size,
        ok: !!res.ok,
        ms: Date.now() - t0,
        outLen: (res.text || '').length,
        head: (res.text || '').slice(0, 40),
        error: res.error || ''
      });
    } catch (e) {
      rows.push({ chars: size, ok: false, ms: Date.now() - t0, error: e.message });
    }
  }
  return rows;
}

async function main() {
  const sizes = [200, 800, 1800, 3500, 5000];

  const out = {};

  out.tencent = await run('tencent', null, sizes);
  out.ollama = await run(
    'openai',
    { openaiBase: 'http://127.0.0.1:11434/v1', openaiKey: 'ollama', openaiModel: 'qwen2.5:3b' },
    sizes
  );

  console.log(JSON.stringify(out, null, 2));

  console.log('\n=== 结论 ===');
  for (const k of ['tencent', 'ollama']) {
    console.log(k + ':');
    for (const r of out[k]) {
      const mark = r.ok ? 'OK ' : 'ERR';
      console.log(
        `  ${mark} ${String(r.chars).padStart(5)} 字  ${String(r.ms).padStart(6)}ms  输出 ${r.outLen || 0} 字  ${r.error}`
      );
    }
  }
}

main();
