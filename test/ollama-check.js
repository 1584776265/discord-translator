/**
 * 用 Node 测 Ollama 翻译（避开 PowerShell 的 UTF-8 解码问题）
 */
const BASE = 'http://127.0.0.1:11434';
const MODEL = 'qwen2.5:3b';

const SYSTEM =
  'You are a professional translator for a gaming community. Translate into Simplified Chinese. ' +
  'Keep technical terms accurate: driver=驱动程序, patch=补丁, texture streaming=纹理流送. ' +
  'Output only the translation, no explanation.';

const CASES = [
  'The new patch fixed the texture streaming issue, please update your graphics driver.',
  'Yeah it is broken, same as last time.',
  'Can anyone help me with the mod installation?'
];

async function translate(text) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text }
      ],
      temperature: 0.2,
      stream: false
    })
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return {
    ms: Date.now() - t0,
    text: (j.choices[0].message.content || '').trim(),
    promptTokens: j.usage?.prompt_tokens,
    completionTokens: j.usage?.completion_tokens
  };
}

async function main() {
  const out = [];
  for (const c of CASES) {
    try {
      const r = await translate(c);
      out.push({ src: c, dst: r.text, ms: r.ms, tokens: `${r.promptTokens}/${r.completionTokens}` });
    } catch (e) {
      out.push({ src: c, error: e.message });
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

main();
