// Injected into every page while recording: a smooth cursor and a pulsing ring around the control that
// is about to be clicked. No ripple or bounce: the pulse alone shows what gets clicked.
// The page may be zoomed (we record the app at 150% for sharpness); this layer cancels that zoom, so
// it works in real screen pixels, the same ones the recorder's mouse and element boxes use.
(() => {
  const install = () => {
    if (document.getElementById('__demo_layer')) return;
    const color = (window.__demoBrand && window.__demoBrand.primary) || '#680BBD';
    const zoom = Number(window.__demoZoom) || 1;
    const style = document.createElement('style');
    style.textContent = `
      #__demo_layer { position: fixed; left: 0; top: 0; width: ${100 * zoom}%; height: ${100 * zoom}%; zoom: ${1 / zoom};
        pointer-events: none; z-index: 2147483647; }
      #__demo_layer * { box-sizing: border-box; }
      #__demo_cursor { position: fixed; left: 0; top: 0; width: 34px; height: 34px; will-change: transform;
        transition: transform 60ms linear; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); }
      .__demo_ring, .__demo_halo { position: fixed; border-radius: 14px; opacity: 0; transition: opacity .25s ease; }
      .__demo_ring { border: 4px solid ${color}; box-shadow: 0 0 0 7px ${color}29, 0 8px 24px ${color}40;
        animation: __demo_ring 1.1s ease-in-out infinite; }
      .__demo_halo { background: ${color}38; animation: __demo_halo 1.1s ease-out infinite; }
      .__demo_on { opacity: 1; }
      @keyframes __demo_ring { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
      @keyframes __demo_halo { 0% { transform: scale(1); opacity: .75; } 100% { transform: scale(1.45); opacity: 0; } }`;
    document.documentElement.appendChild(style);

    const layer = document.createElement('div');
    layer.id = '__demo_layer';
    layer.innerHTML = '<svg id="__demo_cursor" viewBox="0 0 24 24" width="34" height="34"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.5-6.9L4 19z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(layer);
    const cursor = layer.firstChild;
    const move = (x, y) => { cursor.style.transform = `translate(${x - 5}px, ${y - 2}px)`; };
    if (window.__demoPos) move(window.__demoPos.x, window.__demoPos.y);
    document.addEventListener('mousemove', (e) => { window.__demoPos = { x: e.clientX, y: e.clientY }; move(e.clientX, e.clientY); }, true);

    // Pulsing ring centred on the control (x, y, w, h in screen pixels), until __demoHighlightOff().
    // Safety net: the ring removes itself after ms (default 3 s), even if the "off" call never arrives
    // (e.g. the page was busy or re-rendered at the moment of the click).
    let ring, halo, auto;
    window.__demoHighlight = (x, y, w, h, ms = 3000) => {
      window.__demoHighlightOff?.(true);
      clearTimeout(auto); auto = setTimeout(() => window.__demoHighlightOff?.(), ms);
      const pad = 8;
      const place = (el) => Object.assign(el.style, { left: `${x - pad}px`, top: `${y - pad}px`, width: `${w + pad * 2}px`, height: `${h + pad * 2}px` });
      halo = document.createElement('div'); halo.className = '__demo_halo'; place(halo);
      ring = document.createElement('div'); ring.className = '__demo_ring'; place(ring);
      layer.insertBefore(halo, cursor); layer.insertBefore(ring, cursor);
      requestAnimationFrame(() => { halo.classList.add('__demo_on'); ring.classList.add('__demo_on'); });
    };
    window.__demoHighlightOff = (now) => {
      clearTimeout(auto);
      for (const el of document.querySelectorAll('.__demo_ring, .__demo_halo')) if (el !== ring && el !== halo) el.remove(); // strays
      for (const el of [ring, halo]) {
        if (!el) continue;
        if (now) el.remove();
        else { el.classList.remove('__demo_on'); setTimeout(() => el.remove(), 300); }
      }
      ring = halo = null;
    };
  };
  if (document.documentElement) install(); else document.addEventListener('DOMContentLoaded', install);
  document.addEventListener('DOMContentLoaded', install);
})();
