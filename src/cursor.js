// Injected into every page before it loads: a smooth cursor, a ring that highlights the element
// about to be clicked, a ripple at the click point, and a quick press-and-bounce on the button.
// Headless Chrome records no cursor of its own. Brand colour comes from window.__demoBrand.
(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const color = (window.__demoBrand && window.__demoBrand.primary) || '#680BBD';
    const style = document.createElement('style');
    style.textContent = `
      #__demo_cursor { position: fixed; left: 0; top: 0; width: 28px; height: 28px; z-index: 2147483647; pointer-events: none;
        will-change: transform; transition: transform 70ms linear; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      .__demo_ripple { position: fixed; width: 54px; height: 54px; margin: -27px 0 0 -27px; border-radius: 50%;
        border: 3px solid ${color}; background: ${color}2e; pointer-events: none; z-index: 2147483646;
        animation: __demo_ripple .65s cubic-bezier(.2,.7,.3,1) forwards; }
      @keyframes __demo_ripple { from { transform: scale(.25); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
      .__demo_ring { position: fixed; pointer-events: none; z-index: 2147483645; border-radius: 12px;
        border: 3px solid ${color}; box-shadow: 0 0 0 6px ${color}33, 0 0 24px ${color}66;
        animation: __demo_ring 1.1s ease-out forwards; }
      @keyframes __demo_ring { 0% { opacity: 0; transform: scale(1.12); } 18% { opacity: 1; transform: scale(1); }
        75% { opacity: 1; } 100% { opacity: 0; } }`;
    document.head.appendChild(style);

    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.5-6.9L4 19z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const move = (x, y) => { c.style.transform = `translate(${x - 4}px, ${y - 2}px)`; };
    if (window.__demoPos) move(window.__demoPos.x, window.__demoPos.y);
    document.addEventListener('mousemove', (e) => { window.__demoPos = { x: e.clientX, y: e.clientY }; move(e.clientX, e.clientY); }, true);

    // Ring around the element that is about to be used (called by the recorder).
    window.__demoHighlight = (x, y, w, h) => {
      const r = document.createElement('div');
      r.className = '__demo_ring';
      const pad = 6;
      Object.assign(r.style, { left: `${x - pad}px`, top: `${y - pad}px`, width: `${w + pad * 2}px`, height: `${h + pad * 2}px` });
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 1200);
    };

    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__demo_ripple';
      r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
      // Press-and-bounce ("vibration") on whatever control was clicked.
      const el = e.target.closest && e.target.closest('button,a,[role=button],[role=tab],[role=link],[role=menuitem],[role=option],[role=checkbox],[role=radio],input,select,label,summary');
      if (el && el.animate) {
        el.animate([
          { transform: 'scale(1)' }, { transform: 'scale(0.93)' }, { transform: 'scale(1.04) rotate(-0.8deg)' },
          { transform: 'scale(0.99) rotate(0.6deg)' }, { transform: 'scale(1)' },
        ], { duration: 420, easing: 'ease-out' });
      }
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
