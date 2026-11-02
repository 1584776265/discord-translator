/**
 * 纯函数单测：不联网、不依赖浏览器，可直接在 CI 里跑。
 *   node test/unit.test.js
 */
const assert = require('assert');
const engine = require('../extension/src/core/engine.js');

const { splitLongText, looksEchoed, packBatches, LONG_TEXT_LIMIT } = engine.__test__ || {};

let pass = 0;
const failed = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('OK   ' + name);
  } catch (e) {
    failed.push(name);
    console.log('FAIL ' + name + ' :: ' + e.message);
  }
}

const squash = (s) => String(s).replace(/\s+/g, '');

/* ---------------- 长文本分段 ---------------- */

t('短文本原样返回', () => {
  assert.deepStrictEqual(splitLongText('hello', 100), ['hello']);
});

t('空输入不炸', () => {
  assert.deepStrictEqual(splitLongText('', 100), ['']);
});

t('超长文本被切成多段且每段不超限', () => {
  const src = 'This is a sentence about the renderer. '.repeat(200).trim();
  const parts = splitLongText(src, 1200);

  assert.ok(parts.length > 1, '应该被切成多段');
  parts.forEach((p) => assert.ok(p.length <= 1200, '分段超限: ' + p.length));
  assert.strictEqual(squash(parts.join('')), squash(src), '拼回去内容必须一致');
});

t('超长段落里没有标点时硬切', () => {
  const src = 'x'.repeat(5000);
  const parts = splitLongText(src, 1200);

  assert.ok(parts.length >= 4);
  parts.forEach((p) => assert.ok(p.length <= 1200));
  assert.strictEqual(squash(parts.join('')), src);
});

t('优先在空行处断开', () => {
  const a = 'A'.repeat(600) + '.';
  const b = 'B'.repeat(600) + '.';
  const parts = splitLongText(a + '\n\n' + b, 1200);

  assert.deepStrictEqual(parts, [a, b]);
});

t('每个引擎都有安全长度', () => {
  ['tencent', 'google', 'libre', 'openai'].forEach((k) => {
    assert.ok(LONG_TEXT_LIMIT[k] > 0, k + ' 缺少安全长度');
  });
});

/* ---------------- 回显检测 ---------------- */

t('英文进英文出 → 判为回显', () => {
  assert.strictEqual(
    looksEchoed('The renderer uses a deferred shading pipeline.', 'The renderer uses a deferred shading pipeline.', 'zh-CN'),
    true
  );
});

t('正常中文译文不算回显', () => {
  assert.strictEqual(
    looksEchoed('The renderer uses a deferred shading pipeline.', '渲染器使用延迟着色管线。', 'zh-CN'),
    false
  );
});

t('目标语言是英文时不判回显', () => {
  assert.strictEqual(looksEchoed('你好，这是一段中文消息内容。', '你好，这是一段中文消息内容。', 'en'), false);
});

t('太短的文本不判回显', () => {
  assert.strictEqual(looksEchoed('GG WP', 'GG WP', 'zh-CN'), false);
});

t('纯表情不判回显', () => {
  assert.strictEqual(looksEchoed('😀😀😀', '😀😀😀', 'zh-CN'), false);
});

/* ---------------- 分批 ---------------- */

t('按条数上限分批', () => {
  const texts = new Array(10).fill('hi');
  const batches = packBatches(texts, 4, 1000);

  assert.strictEqual(batches.length, 3);
  assert.deepStrictEqual(
    batches.map((b) => b.length),
    [4, 4, 2]
  );
});

t('按字符数上限分批，长文本单独成批', () => {
  const texts = ['a'.repeat(900), 'a'.repeat(900), 'b'.repeat(100), 'b'.repeat(100)];
  const batches = packBatches(texts, 16, 1600);

  // 第 0 条占满 900 后，第 1 条会触发换批；剩下两条都很短，挤在同一批
  assert.deepStrictEqual(batches, [[0], [1, 2, 3]]);
});

t('分批不丢索引也不重复', () => {
  const texts = ['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(500), 'd'.repeat(500)];
  const flat = packBatches(texts, 2, 1000).flat();

  assert.deepStrictEqual(flat.slice().sort(), [0, 1, 2, 3]);
});

/* ---------------- 汇总 ---------------- */

console.log('');
console.log(`通过 ${pass}/${pass + failed.length}`);
if (failed.length) {
  console.log('失败: ' + failed.join(', '));
  process.exit(1);
}
