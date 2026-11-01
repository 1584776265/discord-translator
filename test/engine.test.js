/* 引擎冒烟测试：node test/engine.test.js */
const path = require('path');

const engine = require(path.join(__dirname, '..', 'extension', 'src', 'core', 'engine.js'));

const S = {
  provider: 'auto',
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  concurrency: 4,
  timeout: 20000,
  retries: 2,
  googleEndpoint: 'https://translate.googleapis.com/translate_a/single'
};

const SAMPLES = [
  'Hello everyone, how are you doing today?',
  'こんにちは、今日はいい天気ですね。',
  '안녕하세요, 반갑습니다.',
  'Привет, как дела?',
  'Bonjour tout le monde, comment allez-vous ?',
  'Hola a todos, ¿cómo están?',
  '你好，这是一条中文消息',
  'lol',
  'gg wp',
  'This is a very long message that keeps going for a while so we can see whether the endpoint handles longer entries properly without truncation or dropping content in the middle of the sentence.'
];

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}

(async () => {
  console.log('=== 语种检测 ===');
  SAMPLES.forEach((s) => console.log('  ' + pad(engine.detectScript(s), 4) + ' | ' + s.slice(0, 56)));

  console.log('\n=== 各源体检 ===');
  const diag = await engine.diagnose(S);
  diag.forEach((d) => console.log(`  ${d.ok ? 'OK  ' : 'FAIL'} ${pad(d.provider, 10)} ${d.ms}ms  ${(d.text || d.error).slice(0, 50)}`));

  const usable = diag.filter((d) => d.ok);
  if (usable.length === 0) {
    console.log('\n!! 所有翻译源都不可用');
    process.exit(2);
  }

  console.log('\n=== 批量翻译（auto） ===');
  const t0 = Date.now();
  const results = await engine.translate(SAMPLES, S);
  const elapsed = Date.now() - t0;

  SAMPLES.forEach((src, i) => {
    const r = results[i] || {};
    const same = engine.isSameLang(r.detected, S.targetLang);
    console.log(
      [
        r.ok ? 'OK ' : 'ERR',
        pad(r.provider || '-', 9),
        pad(r.detected || '--', 4),
        same ? 'SKIP' : '    ',
        '|',
        src.slice(0, 34),
        '=>',
        (r.text || r.error || '').slice(0, 46)
      ].join(' ')
    );
  });
  console.log('\n耗时 ' + elapsed + 'ms / ' + SAMPLES.length + ' 条');

  console.log('\n=== 缓存 ===');
  const t1 = Date.now();
  await engine.translate(SAMPLES, S);
  console.log('第二次 ' + (Date.now() - t1) + 'ms，缓存 ' + engine.cacheStats().size + ' 条');

  console.log('\n=== 边界 ===');
  console.log(JSON.stringify(await engine.translate(['', '   ', '😀😀😀', 'a'], S)));

  console.log('\n=== 反向：中 -> 英 ===');
  const rev = await engine.translate(['大家好，今天过得怎么样？', '这个模组真好用，推荐给大家'], {
    ...S,
    targetLang: 'en'
  });
  rev.forEach((r) => console.log('  ' + (r.text || r.error)));

  console.log('\n=== 繁体目标 ===');
  const tw = await engine.translate(['This mod is really great, I love it'], { ...S, targetLang: 'zh-TW' });
  console.log('  ' + (tw[0].text || tw[0].error));

  const okCount = results.filter((r) => r && r.ok && r.text).length;
  console.log('\n通过: ' + okCount + '/' + SAMPLES.length);
  process.exit(okCount >= SAMPLES.length - 1 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
