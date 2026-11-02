/**
 * 对比三条路线在 Ollama 上的术语表效果：
 *   A. 不带术语
 *   B. 占位符方案（<0> 替换再还原）—— 腾讯/Libre 用的那套
 *   C. 提示词方案（把术语表写进 system prompt）—— LLM 推荐
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

const SRC =
  'The new patch fixed the texture streaming issue and reduced VRAM usage, ' +
  'but ray tracing still crashes when the shader cache is cold. ' +
  'Please update your graphics driver.';

const BASE_RULES = [
  '你是一个翻译引擎，不是助手。',
  '把用户给出的文本翻译成简体中文。',
  '只输出译文，不要任何解释、前言或代码块围栏。',
  '保留原文中的 @提及、#频道、URL、`代码`、表情符号。'
];

function systemPlain() {
  return BASE_RULES.join('\n');
}

function systemWithGlossary() {
  const lines = BASE_RULES.slice();
  lines.push('');
  lines.push('必须使用以下术语对照，不要自行另译：');
  for (const g of GLOSSARY) lines.push(`${g.from} = ${g.to}`);
  return lines.join('\n');
}

/** 占位符方案：<0> <1> ... */
function applyPlaceholders(text) {
  let out = text;
  const map = [];
  GLOSSARY.forEach((g, i) => {
    const token = `<${i}>`;
    const re = new RegExp(
      '(?<![A-Za-z0-9])' + g.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])',
      'gi'
    );
    if (re.test(out)) {
      out = out.replace(re, token);
      map.push({ token, to: g.to });
    }
  });
  return { text: out, map };
}

function restore(text, map) {
  let out = text;
  let lost = 0;
  for (const m of map) {
    if (out.indexOf(m.token) >= 0) out = out.split(m.token).join(m.to);
    else lost++;
  }
  return { text: out, lost };
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

function score(text) {
  // 检查术语是否按要求出现
  const checks = {
    显卡驱动: /显卡驱动/.test(text),
    纹理流送: /纹理流送|纹理流式/.test(text),
    光线追踪: /光线追踪|光辉追踪/.test(text),
    着色器: /着色器/.test(text),
    补丁: /补丁/.test(text),
    显存: /显存|视频内存/.test(text),
    崩溃: /崩溃/.test(text)
  };
  // 错误译法
  const wrong = {
    司机: /司机/.test(text),
    修补程序: /修补程序/.test(text)
  };
  return { hit: Object.entries(checks).filter(([, v]) => v).map(([k]) => k), wrong: Object.entries(wrong).filter(([, v]) => v).map(([k]) => k) };
}

async function main() {
  const out = {};

  // A. 无术语
  try {
    const a = await chat(systemPlain(), SRC);
    out.A_plain = { ms: a.ms, text: a.text, ...score(a.text) };
  } catch (e) {
    out.A_plain = { error: e.message };
  }

  // B. 占位符
  try {
    const p = applyPlaceholders(SRC);
    const b = await chat(systemPlain(), p.text);
    const r = restore(b.text, p.map);
    out.B_placeholder = {
      ms: b.ms,
      marked: p.text,
      raw: b.text,
      text: r.text,
      lost: r.lost,
      ...score(r.text)
    };
  } catch (e) {
    out.B_placeholder = { error: e.message };
  }

  // C. 提示词
  try {
    const c = await chat(systemWithGlossary(), SRC);
    out.C_prompt = { ms: c.ms, text: c.text, ...score(c.text) };
  } catch (e) {
    out.C_prompt = { error: e.message };
  }

  console.log(JSON.stringify(out, null, 2));

  console.log('\n=== 术语命中数 ===');
  for (const k of ['A_plain', 'B_placeholder', 'C_prompt']) {
    const v = out[k];
    if (v.error) {
      console.log(`${k}: 失败 ${v.error}`);
      continue;
    }
    console.log(
      `${k.padEnd(14)} 命中 ${v.hit.length}/${GLOSSARY.length}  错译 ${v.wrong.length}` +
        (v.lost !== undefined ? `  占位符丢失 ${v.lost}` : '')
    );
  }
}

main();
