// Injected into every page while RECORDING: blurs sensitive values on screen before they are captured.
// By default: Social Security numbers (123-45-6789), EINs (12-3456789) and long account/routing
// numbers (9+ digits in a row). Configured via window.__demoRedact = { patterns: [regex strings] }.
// Blurs the closest element holding the value (and inputs whose value matches), and keeps doing so
// as the page changes.
(() => {
  const cfg = window.__demoRedact;
  if (!cfg || cfg.off) return;
  const res = (cfg.patterns || []).map((p) => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean);
  if (!res.length) return;
  const hit = (t) => !!t && res.some((r) => r.test(t));
  const blur = (el) => {
    if (!el || el.dataset.demoRedacted) return;
    el.dataset.demoRedacted = '1';
    el.style.setProperty('filter', 'blur(7px)', 'important');
  };
  const scan = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (hit(n.nodeValue)) blur(n.parentElement);
    root.querySelectorAll?.('input, textarea').forEach((i) => { if (hit(i.value)) blur(i); });
  };
  const start = () => {
    scan(document.body);
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; scan(document.body); });
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    document.addEventListener('input', (e) => { if (hit(e.target.value)) blur(e.target); }, true);
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
