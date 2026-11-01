/* 第二轮探测：国内可直连的翻译端点 + 质量验证 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const tests = [
  {
    name: 'youdao-dict-translate',
    method: 'GET',
    url: 'https://dict.youdao.com/translate?doctype=json&type=AUTO&i=' + encodeURIComponent('Hello everyone, how are you today?'),
    headers: { 'User-Agent': UA }
  },
  {
    name: 'youdao-fanyi-ua',
    method: 'GET',
    url: 'https://fanyi.youdao.com/translate?doctype=json&type=AUTO&i=' + encodeURIComponent('Hello everyone, how are you today?'),
    headers: { 'User-Agent': UA, Referer: 'https://fanyi.youdao.com/' }
  },
  {
    name: 'baidu-transapi',
    method: 'POST',
    url: 'https://fanyi.baidu.com/transapi',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'from=auto&to=zh&query=' + encodeURIComponent('Hello everyone, how are you today?') + '&source=web'
  },
  {
    name: 'caiyun-demo',
    method: 'POST',
    url: 'https://api.interpreter.caiyunai.com/v1/translator',
    headers: {
      'Content-Type': 'application/json',
      'x-authorization': 'token 3975l6lr5pcbvidl6jl2',
      'User-Agent': UA
    },
    body: JSON.stringify({
      source: ['Hello everyone, how are you today?'],
      trans_type: 'auto2zh',
      request_id: 'demo',
      detect: true
    })
  },
  {
    name: 'qq-transmart',
    method: 'POST',
    url: 'https://transmart.qq.com/api/imt',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, Referer: 'https://transmart.qq.com/zh-CN/index' },
    body: JSON.stringify({
      header: { fn: 'auto_translation', client_key: 'browser-chrome-131.0.0-Windows_10-undefined' },
      type: 'text',
      model_category: 'normal',
      source: { lang: 'en', text_list: ['Hello everyone, how are you today?'] },
      target: { lang: 'zh' }
    })
  },
  {
    name: 'mymemory-ja',
    method: 'GET',
    url: 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent('こんにちは、今日はいい天気ですね。') + '&langpair=ja|zh-CN'
  },
  {
    name: 'mymemory-long',
    method: 'GET',
    url:
      'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent('This is a longer sentence used to check how the service behaves with more than a few words in a single request.') +
      '&langpair=en|zh-CN'
  }
];

const TIMEOUT = 9000;

async function run(t) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      method: t.method,
      headers: t.headers || {},
      body: t.body,
      signal: ctrl.signal,
      credentials: 'omit'
    });
    const text = (await res.text()).slice(0, 400).replace(/\s+/g, ' ');
    return { name: t.name, status: res.status, ms: Date.now() - started, body: text };
  } catch (e) {
    return { name: t.name, status: 0, ms: Date.now() - started, body: 'ERR ' + e.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const results = await Promise.all(tests.map(run));
  for (const r of results) {
    console.log(`\n[${r.status}] ${r.name}  (${r.ms}ms)`);
    console.log('  ' + r.body);
  }
})();
