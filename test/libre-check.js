/**
 * 用 Node 直接测 LibreTranslate，避开 PowerShell 的 UTF-8 解码问题
 */
const BASE = 'http://127.0.0.1:5000';

async function main() {
  const out = {};

  try {
    const langs = await fetch(BASE + '/languages').then((r) => r.json());
    out.languageCount = langs.length;
    out.languages = langs
      .filter((l) => ['en', 'zh', 'ja', 'ko', 'ru'].includes(l.code))
      .map((l) => l.code);
  } catch (e) {
    out.languagesError = e.message;
  }

  const cases = [
    { q: 'Hello everyone, the update is out, remember to update the driver.', source: 'en', target: 'zh' },
    { q: 'I will be online later tonight.', source: 'en', target: 'zh' },
    { q: '大家好，今天的更新已经发布了。', source: 'zh', target: 'en' }
  ];

  out.translations = [];

  for (const c of cases) {
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + '/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: c.q, source: c.source, target: c.target, format: 'text' })
      });
      const j = await res.json();
      out.translations.push({
        from: c.source,
        to: c.target,
        ms: Date.now() - t0,
        src: c.q.slice(0, 40),
        dst: (j.translatedText || '').slice(0, 80),
        error: j.error || null
      });
    } catch (e) {
      out.translations.push({ from: c.source, to: c.target, error: e.message });
    }
  }

  console.log(JSON.stringify(out, null, 2));
}

main();
