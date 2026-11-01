// One place that talks to the AI through OpenRouter, so the model is a setting, not code. Set on the
// dashboard's Settings page (or AUTHOR_MODEL / REPAIR_MODEL on Render):
//   planning model — plans videos from a prompt
//   takeover model — takes over when a saved step stops working during recording (defaults to the planning model)
// Any OpenRouter model id works; screenshots are only sent to the takeover, which needs a model that
// can read images.
import { get } from './settings.mjs';
export const authorModel = () => get('authorModel');
export const repairModel = () => get('repairModel') || authorModel();

export const newUsage = (model) => ({ calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, model });

export async function chat(messages, usage, { model = authorModel(), maxTokens = 900 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set, so the AI cannot plan or fix the video.');
  // OpenAI GPT models think before answering, and that thinking counts toward max_tokens: keep the effort
  // low (these are small, one-step decisions) and leave room so the answer isn't cut off.
  const reasoning = model.startsWith('openai/');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'docs-to-video' },
    body: JSON.stringify({
      model, messages,
      ...(reasoning
        ? { max_tokens: Math.max(maxTokens, 4000), reasoning: { effort: get('reasoningEffort') || 'low', exclude: true } }
        : { max_tokens: maxTokens, temperature: 0 }),
      // Anthropic models: prefer Anthropic's own servers, fall back to other hosts if they're busy.
      ...(model.startsWith('anthropic/') ? { provider: { order: ['anthropic'], allow_fallbacks: true } } : {}),
      usage: { include: true },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  usage.calls += 1;
  usage.costUsd += Number(data.usage?.cost || 0);
  usage.inputTokens += data.usage?.prompt_tokens || 0;
  usage.outputTokens += data.usage?.completion_tokens || 0;
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error(`${model} returned an empty reply (finish reason: ${data.choices?.[0]?.finish_reason || 'unknown'}).`);
  return content;
}

export function parseJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error(`No JSON in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(s, e + 1));
}

// The page as text: every button, link and field with its visible name.
const SNAPSHOT_CHARS = 14000;
export async function snapshot(page) {
  let snap = '';
  try { snap = await page.locator('body').ariaSnapshot({ timeout: 8000 }); } catch (e) { snap = `(snapshot failed: ${e.message.split('\n')[0]})`; }
  snap = snap.split('\n').filter((l) => !l.trim().startsWith('- /url:')).join('\n');
  return snap.length > SNAPSHOT_CHARS ? `${snap.slice(0, SNAPSHOT_CHARS)}\n... (truncated)` : snap;
}

export const describe = (a) => `${a.do} ${a.target ? JSON.stringify(a.target) : a.url || a.key || (a.text ? `until "${a.text}" (${a.seconds || 120}s max)` : '')}${a.value ? ` value="${a.value}"` : ''}`;
