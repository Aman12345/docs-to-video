// The written SOP for a video (idea from aidemo's walkthrough export): the same steps as the video,
// as numbered instructions with one screenshot per step. Built from the saved storyboard and the
// step screenshots taken from the final video, so text and pictures always match the video.

import { introText, outroText, checksFor } from './narrative.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mdEsc = (s) => String(s ?? '').replace(/([*_`[\]])/g, '\\$1');

const targetName = (t = {}) => t.name || t.label || t.placeholder || t.text || t.testId || 'the highlighted item';

// One plain-English instruction per recorded action.
export function instructions(scene) {
  return (scene.steps || []).map((st) => {
    const n = targetName(st.target);
    switch (st.do) {
      case 'click': return { verb: 'Click', what: n };
      case 'fill': return st.value ? { verb: 'Enter', value: st.value, what: n } : { verb: 'Clear', what: n };
      case 'select': return { verb: 'Choose', value: st.value, what: n };
      case 'press': return { verb: 'Press', what: st.key || 'Enter' };
      case 'hover': return { verb: 'Point at', what: n };
      case 'goto': return { verb: 'Go to', what: st.url };
      case 'scroll': return { verb: 'Scroll', what: (st.dy || 500) < 0 ? 'up' : 'down', plain: true };
      case 'wait': return st.gone
        ? { verb: 'Wait until', what: st.text || 'the busy indicator', note: 'disappears; this can take a few minutes' }
        : { verb: 'Wait until you see', what: st.text || 'the result', note: 'this can take a few minutes' };
      default: return null; // expect / pause: nothing for the reader to do
    }
  }).filter(Boolean);
}

const mdLine = (i) => i.plain ? `${i.verb} ${i.what}.`
  : i.value !== undefined ? `${i.verb} \`${i.value}\` in **${mdEsc(i.what)}**.`
    : `${i.verb} **${mdEsc(i.what)}**${i.note ? ` (${i.note})` : ''}.`;
const htmlLine = (i) => i.plain ? `${esc(i.verb)} ${esc(i.what)}.`
  : i.value !== undefined ? `${esc(i.verb)} <code>${esc(i.value)}</code> in <strong>${esc(i.what)}</strong>.`
    : `${esc(i.verb)} <strong>${esc(i.what)}</strong>${i.note ? ` (${esc(i.note)})` : ''}.`;

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
