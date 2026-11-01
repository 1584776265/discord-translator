/* 腾讯交互翻译：批量 / auto 检测 / 多语言 验证 */

const URL_IMT = 'https://transmart.qq.com/api/imt';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function call(sourceLang, texts, targetLang) {
  const body = {
    header: { fn: 'auto_translation', client_key: 'browser-chrome-131.0.0-Windows_10-undefined' },
    type: 'text',
    model_category: 'normal',
    source: { lang: sourceLang, text_list: texts },
    target: { lang: targetLang }
  };
  const t0 = Date.now();
  const res = await fetch(URL_IMT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Referer: 'https://transmart.qq.com/zh-CN/index' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { ms: Date.now() - t0, status: res.status, json };
}

(async () => {
  console.log('--- 1. auto 检测 + 单条 ---');
  console.log(JSON.stringify(await call('auto', ['Hello everyone'], 'zh'), null, 1).slice(0, 600));

  console.log('\n--- 2. auto 检测 + 多条批量 ---');
  const t = await call(
    'auto',
    [
      'Hello everyone, how are you today?',
      'こんにちは、今日はいい天気ですね。',
      '안녕하세요, 반갑습니다.',
      'Привет, как дела?',
      '你好，这是一条中文消息',
      'lol',
      'gg wp',
      'This is a very long message that keeps going for a while so we can see whether the batch endpoint handles longer single entries properly without truncation.'
    ],
    'zh'
  );
  console.log('status', t.status, 'ms', t.ms);
  console.log('src_lang:', t.json.src_lang, '| tgt:', t.json.tgt_lang, '| ret:', t.json.header && t.json.header.ret_code);
  (t.json.auto_translation || []).forEach((s, i) => console.log('  [' + i + ']', s));

  console.log('\n--- 3. 反向：中文 -> 英文 ---');
  const e = await call('auto', ['大家好，今天过得怎么样？', '这个模组真好用'], 'en');
  console.log('src:', e.json.src_lang, '|', JSON.stringify(e.json.auto_translation));

  console.log('\n--- 4. 其他目标语言 ---');
  for (const lang of ['ja', 'ko', 'ru', 'fr', 'de', 'es']) {
    try {
      const r = await call('auto', ['Hello, nice to meet you'], lang);
      console.log('  ->', lang, JSON.stringify((r.json.auto_translation || [])[0] || r.json));
    } catch (err) {
      console.log('  ->', lang, 'ERR', err.message);
    }
  }

  console.log('\n--- 5. 空串 / 特殊字符 ---');
  const es = await call('auto', ['', '   ', '😀😀', '@user #channel `code` **bold**'], 'zh');
  console.log(JSON.stringify(es.json.auto_translation));

  console.log('\n--- 6. 50 条压力 ---');
  const many = Array.from({ length: 50 }, (_, i) => 'Test message number ' + (i + 1) + ' for batch testing');
  const big = await call('auto', many, 'zh');
  console.log('status', big.status, 'ms', big.ms, 'returned', (big.json.auto_translation || []).length);
  console.log('  [0]', (big.json.auto_translation || [])[0]);
  console.log('  [49]', (big.json.auto_translation || [])[49]);
})();
