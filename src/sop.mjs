// The written SOP for a video (idea from aidemo's walkthrough export): the same steps as the video,
// as numbered instructions with one screenshot per step. Built from the saved storyboard and the
// step screenshots taken from the final video, so text and pictures always match the video.

import { introText, outroText, checksFor } from './narrative.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mdEsc = (s) => String(s ?? '').replace(/([*_`[\]])/g, '\\$1');


// One plain-English instruction per recorded action, following the Microsoft / Google UI-writing style:
// location first, the exact label in bold, "select" / "enter" / "choose", no element-type words.
const named = (t = {}) => t.name || t.label || t.placeholder || t.text || t.testId || '';
export function instructions(scene) {
  return (scene.steps || []).map((st) => {
    const n = named(st.target);
    const role = st.target?.role;
    switch (st.do) {
      case 'click':
        if (role === 'combobox') return n ? { verb: 'Open the', what: n, tail: 'list' } : { verb: 'Open the list.', plain: true, what: '' };
        if (role === 'checkbox') return { verb: 'Select', what: n || 'the checkbox' };
        if (role === 'switch') return { verb: 'Turn on', what: n || 'the setting' };
        return { verb: 'Select', what: n || 'the highlighted item' };
      case 'fill': return st.value ? { where: n, verb: 'enter', value: st.value } : { verb: 'Clear', what: n };
      case 'select': return { where: n, verb: 'choose', what: st.value };
      case 'press': return { verb: 'Press', what: st.key || 'Enter' };
      case 'hover': return { verb: 'Point to', what: n };
      case 'goto': return { verb: 'Go to', what: st.url };
      case 'scroll': return { verb: 'Scroll', what: (st.dy || 500) < 0 ? 'up' : 'down', plain: true };
      case 'wait': return st.gone
        ? { verb: 'Wait until', what: st.text || 'the busy indicator', tail: 'disappears', note: 'this can take a few minutes' }
        : { verb: 'Wait until you see', what: st.text || 'the result', note: 'this can take a few minutes' };
      default: return null; // expect / pause: nothing for the reader to do
    }
  }).filter(Boolean);
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
function line(i, bold, code, esc0) {
  if (i.plain) return `${i.verb}${i.what ? ` ${esc0(i.what)}` : ''}${/[.]$/.test(i.verb) ? '' : '.'}`;
  if (i.where !== undefined && i.value !== undefined) return i.where ? `In ${bold(i.where)}, ${i.verb} ${code(i.value)}.` : `${cap(i.verb)} ${code(i.value)}.`;
  if (i.where !== undefined) return i.where ? `In ${bold(i.where)}, ${i.verb} ${bold(i.what)}.` : `${cap(i.verb)} ${bold(i.what)}.`;
  return `${i.verb} ${bold(i.what)}${i.tail ? ` ${i.tail}` : ''}${i.note ? ` (${esc0(i.note)})` : ''}.`;
}
const mdLine = (i) => line(i, (t) => `**${mdEsc(t)}**`, (t) => `\`${t}\``, (t) => t);
const htmlLine = (i) => line(i, (t) => `<strong>${esc(t)}</strong>`, (t) => `<code>${esc(t)}</code>`, esc);

export function sopMarkdown(v, baseUrl) {
  const scenes = v.storyboard?.scenes || [];
  const sb = v.storyboard || { title: v.title, scenes };
  const lines = [`# ${v.title}`, '', v.description || '', '', `▶ Watch the video: ${baseUrl}/v/${v.slug}`, '', '## Overview', '', introText(sb), '', '## Steps', ''];
  scenes.forEach((s, k) => {
    lines.push(`### ${k + 1}. ${s.chapter}`, '', s.narration || '', '');
    instructions(s).forEach((i, j) => lines.push(`${j + 1}. ${mdLine(i)}`));
    if (v.files?.steps?.[k]) lines.push('', `![Step ${k + 1}: ${mdEsc(s.chapter)}](${baseUrl}/videos/${v.slug}/steps/${k + 1}?v=${v.version})`);
    lines.push('');
  });
  lines.push('## Finish', '', outroText(sb), '');
  const checks = checksFor(sb);
  if (checks.length) lines.push('**Check your work**', '', ...checks.map((c) => `- [ ] ${c}`), '');
  lines.push('---', `_Generated from the recorded video (version ${v.version}, ${new Date(v.updatedAt || Date.now()).toISOString().slice(0, 10)}). Re-recording the video updates this guide._`, '');
  return lines.join('\n');
}

// Step-by-step section for the share page; each step can jump the video to that point.
export function guideHtml(v) {
  const scenes = v.storyboard?.scenes || [];
  if (!scenes.length) return '';
  const checks = checksFor(v.storyboard);
  return `<section class="guide"><div class="guide-head"><h2>Step-by-step guide</h2><a href="/videos/${esc(v.slug)}/sop.md?v=${v.version}" download="${esc(v.slug)}-sop.md">Download as Markdown</a></div>
${scenes.map((s, k) => {
    const at = v.chapters?.[k]?.startSec ?? 0;
    return `<article class="step"><div class="step-text"><h3><span class="num">${k + 1}</span>${esc(s.chapter)}</h3>
<p>${esc(s.narration)}</p><ol>${instructions(s).map((i) => `<li>${htmlLine(i)}</li>`).join('')}</ol>
<button class="jump" data-t="${at}">▶ Watch this step (${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, '0')})</button></div>
${v.files?.steps?.[k] ? `<img loading="lazy" src="/videos/${esc(v.slug)}/steps/${k + 1}?v=${v.version}" alt="Step ${k + 1}: ${esc(s.chapter)}">` : ''}</article>`;
  }).join('\n')}
${checks.length ? `<div class="checks"><h3>Check your work</h3><ul>${checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}</section>`;
}
