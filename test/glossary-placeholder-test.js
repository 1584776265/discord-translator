/**
 * 验证：LibreTranslate 会不会破坏术语表的私有区占位符
 *
 * 术语表机制是 原文 → \uE000{index}\uE001 → 翻译 → 还原成译文
 * 如果模型把占位符吃掉或改掉，这套机制就废了。
 */
const BASE = 'http://127.0.0.1:5000';

const TOKEN = (i) => '\uE000' + i + '\uE001';

const CASES = [
  {
    name: '单个占位符',
    text: `The ${TOKEN(0)} is broken, please update it.`
  },
  {
    name: '两个占位符',
    text: `Update the ${TOKEN(0)} and the ${TOKEN(1)} before launch.`
  },
  {
    name: '占位符在句首',
    text: `${TOKEN(0)} caused the crash on my machine.`
  },
  {
    name: '占位符连续出现',
    text: `Enable ${TOKEN(0)}${TOKEN(1)} in the settings panel.`
  }
];

async function translate(q, source = 'en', target = 'zh') {
  const res = await fetch(BASE + '/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, source, target, format: 'text' })
  });
  return res.json();
}

async function main() {
  const results = [];

  for (const c of CASES) {
    try {
      const j = await translate(c.text);
      const dst = j.translatedText || '';

      // 统计占位符存活情况
      const found = [];
      for (let i = 0; i < 3; i++) {
        if (dst.indexOf(TOKEN(i)) >= 0) found.push(i);
      }

      results.push({
        case: c.name,
        src: c.text,
        dst: dst,
        survived: found,
        privateUseChars: (dst.match(/[\uE000-\uF8FF]/g) || []).length,
        broken: dst.indexOf('\uE000') < 0
      });
    } catch (e) {
      results.push({ case: c.name, error: e.message });
    }
  }

  console.log(JSON.stringify(results, null, 2));

  const brokenCount = results.filter((r) => r.broken).length;
  console.log('\n=== 结论 ===');
  if (brokenCount === 0) {
    console.log('全部保留占位符 → 术语表机制对 LibreTranslate 有效');
  } else {
    console.log(`${brokenCount}/${results.length} 个用例丢失占位符 → 术语表机制需要改方案`);
  }
}

main();
