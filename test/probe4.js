/* 腾讯接口细节：指定源语言 / 繁体目标 / 并发限流 */

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
  const json = await res.json().catch(() => ({}));
  return { ms: Date.now() - t0, status: res.status, json };
}

(async () => {
  console.log('--- 指定源语言 ru ---');
  const ru = await call('ru', ['Привет, как дела?', 'Этот мод очень хороший'], 'zh');
  console.log(' src:', ru.json.src_lang, '->', JSON.stringify(ru.json.auto_translation));

  console.log('\n--- 指定源语言 ja ---');
  const ja = await call('ja', ['こんにちは、今日はいい天気ですね。', 'この武器は強い'], 'zh');
  console.log(' src:', ja.json.src_lang, '->', JSON.stringify(ja.json.auto_translation));

  console.log('\n--- 指定源语言 ko ---');
  const ko = await call('ko', ['안녕하세요, 반갑습니다.', '이 모드는 정말 좋아요'], 'zh');
  console.log(' src:', ko.json.src_lang, '->', JSON.stringify(ko.json.auto_translation));

  console.log('\n--- 目标语言 zh-TW ---');
  const tw = await call('en', ['This mod is really great, I love it'], 'zh-TW');
  console.log(' tgt:', tw.json.tgt_lang, '->', JSON.stringify(tw.json.auto_translation));

  console.log('\n--- 目标语言 zh-Hant ---');
  const hant = await call('en', ['This mod is really great'], 'zh-Hant');
  console.log(' tgt:', hant.json.tgt_lang, '->', JSON.stringify(hant.json.auto_translation));

  console.log('\n--- 英->德 质量（指定 en 源） ---');
  const de = await call('en', ['Hello, nice to meet you'], 'de');
  console.log(' ->', JSON.stringify(de.json.auto_translation));

  console.log('\n--- 英->法 ---');
  const fr = await call('en', ['Hello, nice to meet you'], 'fr');
  console.log(' ->', JSON.stringify(fr.json.auto_translation));

  console.log('\n--- 并发 8 个请求 ---');
  const t0 = Date.now();
  const tasks = Array.from({ length: 8 }, (_, i) => call('en', ['Concurrent test number ' + i], 'zh'));
  const rs = await Promise.all(tasks);
  console.log(' 总耗时', Date.now() - t0, 'ms');
  rs.forEach((r, i) => console.log('  [' + i + ']', r.status, r.json.header ? r.json.header.ret_code : 'NO_HEADER', JSON.stringify((r.json.auto_translation || [])[0])));
})();
