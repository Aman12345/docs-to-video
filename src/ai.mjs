// One place that talks to the AI through OpenRouter, so the model is a setting, not code. Set on the
// dashboard's Settings page (or AUTHOR_MODEL / REPAIR_MODEL on Render):
//   planning model — plans videos from a prompt
//   takeover model — takes over when a saved step stops working during recording (defaults to the planning model)
// Any OpenRouter model id works; screenshots are only sent to the takeover, which needs a model that
// can read images.
import { get } from './settings.mjs';
export const authorModel = () => get('authorModel');
export const repairModel = () => get('repairModel') || authorModel();
// The editor that reviews finished videos: a frontier model by default, since it judges what viewers need.
export const reviewModel = () => get('reviewModel') || 'anthropic/claude-opus-5.5';

export const newUsage = (model) => ({ calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, model });

export async function chat(messages, usage, { model = authorModel(), maxTokens = 900 } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set, so the AI cannot plan or fix the video.');
  // OpenAI GPT models think before answering, and that thinking counts toward max_tokens: keep the effort
  // low (these are small, one-step decisions) and leave room so the answer isn't cut off.
  const reasoning = model.startsWith('openai/');
  // Prompt caching for Anthropic models: the long instructions (system prompt) are the same on every step of
  // a planning run, so mark them cacheable; repeats then cost about a tenth. (Other providers cache automatically.)
  if (model.startsWith('anthropic/')) {
    messages = messages.map((m) => (m.role === 'system' && typeof m.content === 'string' && m.content.length > 3000
      ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m));
  }
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
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 402 || /credit|limit exceeded/i.test(body)) throw new Error(`OpenRouter credits ran out (${res.status}): add credits on openrouter.ai, or raise the API key's credit limit, then select Retry. ${body.slice(0, 120)}`);
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }
  const data = await res.json();
  usage.calls += 1;
  usage.costUsd += Number(data.usage?.cost || 0);
  usage.inputTokens += data.usage?.prompt_tokens || 0;
  usage.cachedTokens = (usage.cachedTokens || 0) + (data.usage?.prompt_tokens_details?.cached_tokens || 0);
  usage.outputTokens += data.usage?.completion_tokens || 0;
  const content = data.choices?.[0]?.message?.content || '';
  if (!content) throw new Error(`${model} returned an empty reply (finish reason: ${data.choices?.[0]?.finish_reason || 'unknown'}).`);
  return content;
}

// chat() + parseJson() for replies that must be one JSON object. If the reply is cut off or malformed (long
// storyboards can outgrow the token limit), ask once more with twice the room instead of failing the whole job.
export async function chatJson(messages, usage, { model, maxTokens = 900 } = {}) {
  try {
    return parseJson(await chat(messages, usage, { model, maxTokens }));
  } catch (e) {
    if (!/JSON/.test(e.message)) throw e;
    const again = [...messages, { role: 'user', content: 'Your last reply was cut off or was not valid JSON. Reply again with the complete JSON object only, keeping text fields short.' }];
    return parseJson(await chat(again, usage, { model, maxTokens: maxTokens * 2 }));
  }
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
