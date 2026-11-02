/**
 * 第二轮：找出真正不会被小模型篡改的术语标记
 * 上一轮 <0> 在简单句里能活，复杂句里被换成 " 2 "
 */
const BASE = 'http://127.0.0.1:5000';

// 用同一句"硬骨头"，之前私有区和尖括号都翻车的句子
const SENTENCE = (a, b, c) =>
  `The new ${a} fixed the ${b} issue, please update your ${c}.`;

const FORMATS = [
  { name: '全大写', wrap: (w) => w.toUpperCase().replace(/\s+/g, '') },
  { name: '下划线', wrap: (w) => w.toUpperCase().replace(/\s+/g, '_') },
  { name: '数字后缀', wrap: (w) => w.toUpperCase().replace(/\s+/g, '') + '7' },
  { name: '井号包围', wrap: (w) => '#' + w.replace(/\s+/g, '') + '#' },
  { name: '中括号', wrap: (w) => `[${w.replace(/\s+/g, '')}]` },
  { name: '全角括号', wrap: (w) => `【${w.replace(/\s+/g, '')}】` },
  { name: '反斜杠转义', wrap: (w) => `\\${w.replace(/\s+/g, '')}\\` }
];

async function translate(q) {
  const res = await fetch(BASE + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, source: 'en', target: 'zh', format: 'text' })
  });
  const j = await res.json();
  return j.translatedText || '';
}

async function main() {
  const rows = [];

  for (const f of FORMATS) {
    const a = f.wrap('patch');
    const b = f.wrap('texture streaming');
    const c = f.wrap('graphics driver');
    const src = SENTENCE(a, b, c);

    try {
      const dst = await translate(src);
      const kept = dst.indexOf(a) >= 0 && dst.indexOf(b) >= 0 && dst.indexOf(c) >= 0;

      rows.push({ format: f.name, kept, dst });
    } catch (e) {
      rows.push({ format: f.name, kept: false, error: e.message });
    }
  }

  console.log(JSON.stringify(rows, null, 2));

  console.log('\n=== 汇总 ===');
  rows.forEach((r) => console.log(`${r.kept ? '✅' : '❌'}  ${r.format}`));

  const best = rows.filter((r) => r.kept);
  console.log('\n可用: ' + (best.length ? best.map((r) => r.format).join(', ') : '全部失败'));
}

main();
