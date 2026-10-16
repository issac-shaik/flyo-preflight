// Provider-agnostic vision LLM call that returns parsed JSON. Uses plain fetch, no SDKs.
// Supported: Gemini, OpenAI, Anthropic. Configure LLM_PROVIDER + LLM_API_KEY (+ optional LLM_MODEL).
import { config, llmEnabled } from '../../shared/env.mjs';

const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-4-5',
};

export { llmEnabled };
export const llmLabel = () => (llmEnabled() ? `${config.llm.provider}:${config.llm.model || DEFAULT_MODELS[config.llm.provider] || '?'}` : 'off');

/**
 * @param {{ system: string, prompt: string, files?: { mime: string, data: Buffer, name?: string }[] }} input
 * @returns {Promise<object>}
 */
export async function llmJson({ system, prompt, files = [] }) {
  if (!llmEnabled()) throw new Error('LLM not configured');
  const provider = config.llm.provider;
  const model = config.llm.model || DEFAULT_MODELS[provider];
  const signal = AbortSignal.timeout(60_000);
  let text;

  if (provider === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.llm.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [...files.map((f) => ({ inline_data: { mime_type: f.mime, data: f.data.toString('base64') } })), { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    const body = await asJson(res, 'Gemini');
    text = body.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  } else if (provider === 'openai') {
    const content = [
      ...files.map((f) => f.mime === 'application/pdf'
        ? { type: 'file', file: { filename: f.name || 'document.pdf', file_data: `data:application/pdf;base64,${f.data.toString('base64')}` } }
        : { type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data.toString('base64')}` } }),
      { type: 'text', text: prompt },
    ];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
    });
    const body = await asJson(res, 'OpenAI');
    text = body.choices?.[0]?.message?.content || '';
  } else if (provider === 'anthropic') {
    const content = [
      ...files.map((f) => f.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') } }
        : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } }),
      { type: 'text', text: `${prompt}\n\nRespond with a single JSON object only.` },
    ];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.llm.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, system, messages: [{ role: 'user', content }] }),
    });
    const body = await asJson(res, 'Anthropic');
    text = body.content?.map((c) => c.text || '').join('') || '';
  } else {
    throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
  }
  return parseJsonLoose(text);
}

async function asJson(res, name) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name} API ${res.status}: ${body.error?.message || JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function parseJsonLoose(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try { return JSON.parse(t); } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('LLM did not return JSON');
  }
}
