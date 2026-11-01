/* 探测哪些翻译端点在本机网络下可用 */

const targets = [
  {
    name: 'youdao-web',
    url: 'https://fanyi.youdao.com/translate?&doctype=json&type=AUTO&i=' + encodeURIComponent('hello world'),
    method: 'GET'
  },
  {
    name: 'youdao-jsonapi',
    url: 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent('hello world'),
    method: 'GET'
  },
  {
    name: 'mymemory',
    url: 'https://api.mymemory.translated.net/get?q=hello%20world&langpair=en|zh-CN',
    method: 'GET'
  },
  {
    name: 'google-translate',
    url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=hello',
    method: 'GET'
  },
  {
    name: 'edge-auth',
    url: 'https://edge.microsoft.com/translate/auth',
    method: 'GET'
  },
  {
    name: 'bing-ttranslate',
    url: 'https://cn.bing.com/ttranslatev3?isVertical=1&IG=1&IID=translator.5028.1',
    method: 'POST',
    body: 'fromLang=auto-detect&text=hello+world&to=zh-Hans',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  },
  {
    name: 'libretranslate-public',
    url: 'https://libretranslate.com/translate',
    method: 'POST',
    body: JSON.stringify({ q: 'hello world', source: 'auto', target: 'zh', format: 'text' }),
    headers: { 'Content-Type': 'application/json' }
  }
];

const TIMEOUT = 6000;

async function probe(t) {
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
    const text = (await res.text()).slice(0, 220).replace(/\s+/g, ' ');
    return { name: t.name, status: res.status, ms: Date.now() - started, body: text };
  } catch (e) {
    return { name: t.name, status: 0, ms: Date.now() - started, body: 'ERR ' + e.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const results = await Promise.all(targets.map(probe));
  for (const r of results) {
    const flag = r.status >= 200 && r.status < 400 ? 'OK  ' : 'FAIL';
    console.log(`[${flag}] ${r.name.padEnd(24)} ${String(r.status).padEnd(4)} ${r.ms}ms`);
    console.log(`       ${r.body}`);
  }
})();
