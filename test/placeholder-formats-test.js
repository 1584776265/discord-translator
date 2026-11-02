/**
 * 对比不同占位符格式在 LibreTranslate 下的存活率
 * 目标：找出一种模型不会篡改的标记，术语表才能用
 */
const BASE = 'http://127.0.0.1:5000';

const FORMATS = [
  { name: '私有区字符', wrap: (i) => '\uE000' + i + '\uE001' },
  { name: '双花括号', wrap: (i) => `{{${i}}}` },
  { name: '双方括号', wrap: (i) => `[[${i}]]` },
  { name: '尖括号', wrap: (i) => `<${i}>` },
  { name: '百分号', wrap: (i) => `%${i}%` },
  { name: '下划线', wrap: (i) => `__${i}__` },
  { name: '井号', wrap: (i) => `#${i}#` },
  { name: '美元符', wrap: (i) => `$${i}$$` }
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
    const t0 = f.wrap(0);
    const t1 = f.wrap(1);
    const src = `Update the ${t0} and the ${t1} before launch.`;

    try {
      const dst = await translate(src);
      const ok0 = dst.indexOf(t0) >= 0;
      const ok1 = dst.indexOf(t1) >= 0;

      rows.push({
        format: f.name,
        marker: t0,
        survived: ok0 && ok1,
        dst: dst
      });
    } catch (e) {
      rows.push({ format: f.name, marker: t0, survived: false, error: e.message });
    }
  }

  console.log(JSON.stringify(rows, null, 2));

  console.log('\n=== 存活汇总 ===');
  rows.forEach((r) => {
    console.log(`${r.survived ? '✅' : '❌'}  ${r.format.padEnd(10)} ${r.marker}`);
  });

  const best = rows.filter((r) => r.survived);
  console.log('\n可用的格式: ' + (best.length ? best.map((r) => r.format).join(', ') : '无'));
}

main();
