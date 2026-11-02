/**
 * 看加了术语表后，3B 模型到底输出了什么（格式为什么会丢）
 */
const BASE = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:3b';

const GLOSSARY = [
  { from: 'graphics driver', to: '显卡驱动' },
  { from: 'texture streaming', to: '纹理流送' },
  { from: 'ray tracing', to: '光线追踪' },
  { from: 'shader', to: '着色器' },
  { from: 'patch', to: '补丁' },
  { from: 'VRAM', to: '显存' },
  { from: 'crash', to: '崩溃' }
];

const SRC_NUM =
  '[1] The new patch fixed the texture streaming issue and reduced VRAM usage, but ray tracing still crashes when the shader cache is cold.\n' +
  '[2] Yeah it is broken, same as last time.';

function sysPlain() {
  return [
    '你是一个翻译引擎，不是助手。',
    '把用户给出的每一条「编号行」翻译成简体中文。',
    '严格规则：',
    '1. 原样保留行首的 [数字] 前缀，输出行数必须与输入行数完全一致。',
    '2. 只输出译文行，禁止任何解释、前言、注释、代码块围栏。',
    '3. 保留原文中的 @提及、#频道、URL、`代码`、表情符号。'
  ].join('\n');
}

function sysWithGloss() {
  const lines = sysPlain().split('\n');
  lines.push('4. 下列术语必须严格使用给定译法：');
  for (const g of GLOSSARY) lines.push('   ' + g.from + ' = ' + g.to);
  return lines.join('\n');
}

// 方案 D：术语表放进 user 消息，不污染 system
function userWithGloss() {
  const refs = GLOSSARY.map((g) => g.from + '=' + g.to).join('；');
  return '（术语参考：' + refs + '）\n\n' + SRC_NUM;
}

async function chat(system, user) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0,
      stream: false
    })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return { ms: Date.now() - t0, text: (j.choices[0].message.content || '').trim() };
}

function check(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const numbered = lines.filter((l) => /^\s*\[\d+\]/.test(l)).length;
  return {
    lineCount: lines.length,
    numberedLines: numbered,
    formatOk: numbered >= 2,
    hasGloss: /显卡驱动|纹理流送/.test(text)
  };
}

async function main() {
  const out = {};

  try {
    const a = await chat(sysPlain(), SRC_NUM);
    out.A_noGlossary = { ms: a.ms, ...check(a.text), text: a.text };
  } catch (e) {
    out.A_noGlossary = { error: e.message };
  }

  try {
    const b = await chat(sysWithGloss(), SRC_NUM);
    out.B_glossInSystem = { ms: b.ms, ...check(b.text), text: b.text };
  } catch (e) {
    out.B_glossInSystem = { error: e.message };
  }

  try {
    const c = await chat(sysPlain(), userWithGloss());
    out.C_glossInUser = { ms: c.ms, ...check(c.text), text: c.text };
  } catch (e) {
    out.C_glossInUser = { error: e.message };
  }

  console.log(JSON.stringify(out, null, 2));

  console.log('\n=== 格式与术语 ===');
  for (const k of ['A_noGlossary', 'B_glossInSystem', 'C_glossInUser']) {
    const v = out[k];
    if (v.error) {
      console.log(`${k}: 失败`);
      continue;
    }
    console.log(
      `${k.padEnd(16)} 编号行 ${v.numberedLines}/${v.lineCount}  格式${v.formatOk ? 'OK' : '✗'}  术语${v.hasGloss ? 'OK' : '✗'}`
    );
  }
}

main();
