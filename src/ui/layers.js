// Layers panel: every switchable part of the scene in one place (remembered between visits),
// two quick presets, and an FPS meter for checking performance on the device at hand.
import * as THREE from 'three';
import { PRESETS, ORDER } from '../core/quality.js';

const KEY = 'dubai3d.layers.v1';
const QKEY = 'dubai3d.quality.v1';
// the FPS meter is a developer tool: off unless switched on in the panel, or for one visit with ?debug
const DEBUG = new URLSearchParams(location.search).has('debug');
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON = {
  traffic: 'M5 16V11l2-5h10l2 5v5M5 16h14M5 16v2M19 16v2M7.5 13h.01M16.5 13h.01',
  trains: 'M7 4h10a2 2 0 0 1 2 2v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a2 2 0 0 1 2-2ZM5 11h14M8 20l-1.5 2M16 20l1.5 2M9 14h.01M15 14h.01',
  people: 'M12 3.6a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4ZM9.5 21l1.6-6.4-1.6-2.4 1-4h3l2 3.4h2.4M11.1 14.6 14 17.2V21M10.5 8.2 7.6 11',
  boats: 'M3 18c1.5 1.2 3 1.2 4.5 0s3-1.2 4.5 0 3 1.2 4.5 0 3-1.2 4.5 0M5 15l1.4-3.6h11.2L19 15M12 11.4V3l5.4 6.2H12',
  parked: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM10 16.5V7.5h3.2a2.6 2.6 0 0 1 0 5.2H10',
  palms: 'M12.5 21c.2-4.6.4-8.3.9-11.6M13.4 9.4c-1.8-2.6-5.4-3-7.9-1.2M13.4 9.4c1.9-2.6 5.5-2.9 8-1M13.4 9.4c-2.9-.6-5.9 1.1-6.9 4.1M13.4 9.4c2.9-.5 5.8 1.3 6.6 4.3M13.4 9.4c.2-2.6-.9-4.8-3.1-6',
  trees: 'M12 21v-7M12 14c-4 0-6-2.5-6-5.5S8.7 3 12 3s6 2.5 6 5.5-2 5.5-6 5.5Z',
  shrubs: 'M4 20h16M5.5 20c-.6-3.4 1.6-6.2 4.6-6.4.8-2.2 3.6-3 5.4-1.4 2.5.1 3.8 3.4 2.9 7.8M9 10.5a1.5 1.5 0 1 1 0-.01M15 8.5a1.5 1.5 0 1 1 0-.01',
  clouds: 'M7 18.5h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 11a3.75 3.75 0 0 0 .8 7.5Z',
  lights: 'M8.5 21h7M12 21V8.5c0-2.6 1.5-4.5 4.2-4.5h.8M17 4v2.4M15.4 6.4h3.2M16.9 9.6l.5 1.4M14.9 9.6l-.8 1.2M18.9 9.6l.9 1.1',
  amenities: 'M4 10.5h16M5 14.5h14M6.5 10.5V19M17.5 10.5V19M5 6.5h14v4H5z',
  walkways: 'M6 17.5a3 3 0 1 0 0-.01M18 17.5a3 3 0 1 0 0-.01M6 17.5 9.5 10h5l3.5 7.5M9.5 10l2.6 7.5M13.8 6.5h2.6',
  labels: 'M4 7h16M4 12h10M4 17h13',
  sunpath: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8',
  ao: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16ZM12 4a8 8 0 0 0 0 16',
  shadows: 'M4 9.2 9 6.3l5 2.9v5.6l-5 2.9-5-2.9zM9 12v5.7M9 12 4 9.2M9 12l5-2.8M14 14.8l6.3 2.6-4.9 2.9L9 17.7',
  glow: 'M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M5.6 5.6l2.5 2.5M15.9 15.9l2.5 2.5M5.6 18.4l2.5-2.5M15.9 8.1l2.5-2.5M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z',
  fps: 'M4 16.5a8 8 0 1 1 16 0M12 16.5l4.2-5.2M7 16.5h.01M17 16.5h.01',
};

export function createLayers(ctx, parts) {
  const { env, traffic, rails, sealife, marina, clouds, labels, sunpath, sections } = parts;

  // ---- each streamed part's objects are gathered under switchable groups as it arrives
  // (their own visibility logic stays intact)
  const byName = (root, ...names) => {
    const out = [];
    if (root) root.traverse((o) => { if (names.includes(o.name)) out.push(o); });
    return out;
  };
  const bundle = (parent, name) => { const g = new THREE.Group(); g.name = 'layer-' + name; parent.add(g); return g; };
  const into = (g, objs) => { for (const o of objs) if (o) g.add(o); };
  const secB = new Map(); // part id -> { parked, lights, places, walks }
  const bundlesOf = (inst) => {
    let b = secB.get(inst.id);
    if (!b) {
      const p = inst.scope.group;
      b = { parked: bundle(p, 'parked'), lights: bundle(p, 'lights'), places: bundle(p, 'amenities'), walks: bundle(p, 'walkways') };
      secB.set(inst.id, b);
    }
    return b;
  };
  const eachB = (fn) => { for (const b of secB.values()) fn(b); };
  const eachPart = (key, fn) => { if (sections) for (const inst of sections.parts(key)) fn(inst.mod); };
  const setKind = (k, v) => eachPart('trees', (m) => m.setKind(k, v));

  // ---- FPS meter
  const fps = createFpsMeter(ctx);

  const DEFS = [
    { title: 'City life', items: [
      { key: 'traffic', label: 'Traffic', set: (v) => traffic.setEnabled(v) },
      { key: 'trains', label: 'Metro & tram', set: (v) => rails.setTrainsVisible && rails.setTrainsVisible(v) },
      { key: 'people', label: 'People', set: (v) => eachPart('people', (m) => m.setEnabled(v)) },
      { key: 'boats', label: 'Boats & water sports', set: (v) => { if (sealife && sealife.setEnabled) sealife.setEnabled(v); if (marina && marina.boatMesh) marina.boatMesh.visible = v; } },
      { key: 'parked', label: 'Parked cars', set: (v) => eachB((b) => { b.parked.visible = v; }) },
    ] },
    { title: 'Nature', items: [
      { key: 'palms', label: 'Palms', set: (v) => setKind('palms', v) },
      { key: 'trees', label: 'Trees', set: (v) => setKind('trees', v) },
      { key: 'shrubs', label: 'Shrubs & flowers', set: (v) => setKind('shrubs', v) },
      { key: 'clouds', label: 'Clouds', set: (v) => clouds && clouds.setEnabled(v) },
    ] },
    { title: 'Streets & places', items: [
      { key: 'lights', label: 'Street lights', set: (v) => eachB((b) => { b.lights.visible = v; }) },
      { key: 'amenities', label: 'Parks, beach & amenities', set: (v) => eachB((b) => { b.places.visible = v; }) },
      { key: 'walkways', label: 'Walkways & cycle lanes', set: (v) => eachB((b) => { b.walks.visible = v; }) },
    ] },
    { title: 'Map & display', items: [
      { key: 'labels', label: 'Labels', set: (v) => labels.setVisible(v) },
      { key: 'sunpath', label: 'Sun path', on: false, set: (v) => { sunpath.setPinned(v); if (v) sunpath.poke(); } },
      { key: 'ao', label: 'Depth shading', set: (v) => ctx.setAO(v) },
      { key: 'shadows', label: 'Shadows', set: (v) => {
        env.setShadows(v);
      } },
      { key: 'glow', label: 'Night glow', set: (v) => { ctx.bloomAllowed = v; ctx.bloomPass.enabled = v && env.state.night > 0.05; } },
      { key: 'fps', label: 'FPS counter', on: false, set: (v) => fps.setVisible(v) },
    ] },
  ];
  const items = DEFS.flatMap((g) => g.items);
  const byKey = Object.fromEntries(items.map((it) => [it.key, it]));
  const state = Object.fromEntries(items.map((it) => [it.key, it.on !== false]));
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* private mode */ }
  for (const k of Object.keys(state)) if (!byKey[k]) delete state[k];
  // ?debug shows the meter without changing the saved choice
  const savedFps = state.fps;
  if (DEBUG) state.fps = true;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(DEBUG ? { ...state, fps: savedFps } : state)); } catch { /* ignore */ } };

  // ---- panel
  const panel = document.createElement('div');
  panel.id = 'layers-panel'; panel.className = 'panel'; panel.hidden = true;
  panel.innerHTML = `
    <div class="lp-head"><h2>Layers</h2><button class="lp-close" title="Close (L)" aria-label="Close the layers panel">✕</button></div>
    <div class="lp-body">
      <section class="lp-quality"><h3>Quality</h3>
        <div class="seg lp-q">${['auto', ...ORDER].map((k) => `<button data-q="${k}">${k === 'auto' ? 'Auto' : PRESETS[k].label}</button>`).join('')}</div>
        <p class="lp-qhint"></p>
      </section>${DEFS.map((g) => `
      <section><h3>${g.title}</h3>${g.items.map((it) => `
        <label class="lp-row" data-key="${it.key}">${svg(ICON[it.key])}<span>${it.label}</span><input type="checkbox" class="sw" data-key="${it.key}" /></label>`).join('')}
      </section>`).join('')}
    </div>
    <div class="lp-foot"><button data-preset="clean" title="Hide moving traffic, crowds, boats and clouds">Clean view</button><button data-preset="all">Show everything</button></div>`;
  document.getElementById('app').appendChild(panel);
  const btn = document.getElementById('layers-btn');

  function sync(k) {
    panel.querySelectorAll(`input[data-key="${k}"]`).forEach((el) => { el.checked = state[k]; });
    document.querySelectorAll(`#toolbar [data-layer="${k}"]`).forEach((el) => { el.classList.toggle('on', state[k]); el.setAttribute('aria-pressed', String(state[k])); });
  }
  function set(k, v, persist = true) {
    if (!byKey[k]) return;
    state[k] = !!v;
    byKey[k].set(state[k]);
    sync(k);
    if (persist) save();
  }
  panel.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.key; if (k) set(k, e.target.checked); });
  panel.querySelector('.lp-close').addEventListener('click', () => toggle(false));
  panel.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.preset === 'clean') for (const k of ['traffic', 'trains', 'people', 'boats', 'parked', 'clouds', 'sunpath']) set(k, false);
    else for (const it of items) if (it.key !== 'fps' && it.key !== 'sunpath') set(it.key, true);
  }));
  document.querySelectorAll('#toolbar [data-layer]').forEach((el) => el.addEventListener('click', () => set(el.dataset.layer, !state[el.dataset.layer])));

  function toggle(open = panel.hidden) {
    panel.hidden = !open;
    if (btn) { btn.classList.toggle('on', open); btn.setAttribute('aria-expanded', String(open)); }
  }
  if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('pointerdown', (e) => {
    if (panel.hidden || panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    toggle(false);
  });
  const app = document.getElementById('app');
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Ctrl+L and the like belong to the browser
    // no Layers panel while the interface is hidden (H, see ui.js)
    if ((e.key === 'l' || e.key === 'L') && !app.classList.contains('ui-hidden')) toggle();
    if (e.key === 'Escape' && !panel.hidden) toggle(false);
  });
  ctx.on('ui-hidden', (hidden) => { if (hidden) toggle(false); });
  // the adaptive-quality check may switch depth shading off on slow devices
  ctx.on('quality', ({ ao }) => { state.ao = ao; sync('ao'); });

  for (const it of items) set(it.key, state[it.key], false);

  // ---- quality presets (chosen, or Auto: High, stepping down if the device struggles)
  let qChoice = 'auto', qName = 'high';
  try { const v = localStorage.getItem(QKEY); if (v === 'auto' || PRESETS[v]) qChoice = v; } catch { /* private mode */ }
  const qButtons = panel.querySelectorAll('[data-q]'), qHint = panel.querySelector('.lp-qhint');
  function applyQuality(name) {
    const P = PRESETS[name];
    qName = name; ctx.quality = P;
    ctx.setPixelRatio(P.pixelRatio(window.devicePixelRatio || 1));
    env.setShadowSize(P.shadowSize);
    if (traffic && traffic.setDensity) traffic.setDensity(P.traffic);
    set('ao', P.ao, false); set('glow', P.glow, false);
    if (sections) sections.applyQuality();
    qButtons.forEach((b) => b.classList.toggle('on', b.dataset.q === qChoice));
    qHint.textContent = (qChoice === 'auto' ? `Auto (now ${P.label}). ` : '') + P.hint;
  }
  function setQuality(choice) {
    qChoice = choice;
    try { localStorage.setItem(QKEY, choice); } catch { /* ignore */ }
    auto.stage = choice === 'auto' ? 0 : 2; auto.t = 0; auto.frames = 0;
    applyQuality(choice === 'auto' ? 'high' : choice);
  }
  qButtons.forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
  // Auto: once the map is idle, measure a few seconds; step down (High, Medium, Low) while it runs slowly
  const auto = { t: 0, frames: 0, stage: qChoice === 'auto' ? 0 : 2 };
  ctx.updaters.push((dt) => {
    if (auto.stage >= 2 || document.hidden) return;
    if ((sections && sections.busy()) || (ctx.isInteracting && ctx.isInteracting())) { auto.t = 0; auto.frames = 0; return; }
    auto.t += dt; auto.frames++;
    if (auto.t < 4) return;
    const fps = auto.frames / auto.t; auto.t = 0; auto.frames = 0;
    if (fps < 34 && qName !== 'low') {
      const next = ORDER[Math.max(0, ORDER.indexOf(qName) - 1)];
      console.info(`[quality] ${fps.toFixed(0)} fps on ${qName}: switching to ${next}`);
      applyQuality(next); auto.stage++;
    } else auto.stage = 2;
  });
  applyQuality(qChoice === 'auto' ? 'high' : qChoice);

  // a cell's parts arrive one by one: sort their objects into the switchable groups, then apply the switches
  if (sections) {
    sections.onModule((inst, key, mod) => {
      if (key === 'trees') { for (const k of ['palms', 'trees', 'shrubs']) mod.setKind(k, state[k]); return; }
      if (key === 'people') { if (mod.setEnabled) mod.setEnabled(state.people); return; }
      if (key !== 'details' && key !== 'streets' && key !== 'amenities') return;
      const b = bundlesOf(inst);
      if (key === 'details') {
        into(b.parked, byName(mod.group, 'parked-cars'));
        into(b.lights, byName(mod.group, 'street-lamps', 'lamp-pools'));
        into(b.places, byName(mod.group, 'umbrellas', 'loungers'));
      } else if (key === 'streets') {
        into(b.lights, byName(mod.group, 'promenade-lamps', 'promenade-light'));
        into(b.places, byName(mod.group, 'promenade-sails', 'sail-masts', 'bike-docks'));
        into(b.walks, byName(mod.group, 'walkways', 'bike-lanes'));
      } else if (key === 'amenities') into(b.places, [mod.group]);
      b.parked.visible = state.parked; b.lights.visible = state.lights; b.places.visible = state.amenities; b.walks.visible = state.walkways;
    });
    sections.onUnload((inst) => secB.delete(inst.id));
  }
  return { state, set, toggle, fps, setQuality, quality: () => ({ choice: qChoice, preset: qName }) };
}

// ------------------------------------------------------------------ FPS meter
function createFpsMeter(ctx) {
  const el = document.createElement('div');
  el.id = 'fps'; el.className = 'panel'; el.hidden = true;
  el.innerHTML = `<div class="fps-top"><b class="fps-num">--</b><span>FPS</span><canvas width="96" height="26"></canvas></div><div class="fps-sub">-- ms</div>`;
  document.getElementById('app').appendChild(el);
  const num = el.querySelector('.fps-num'), sub = el.querySelector('.fps-sub'), cv = el.querySelector('canvas');
  const g = cv.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = 96 * dpr; cv.height = 26 * dpr; cv.style.width = '96px'; cv.style.height = '26px';
  const hist = [];
  let on = false, last = performance.now(), frames = 0, acc = 0, worst = 0, calls = 0, tris = 0;
  const info = ctx.renderer.info;
  const color = (f) => (f >= 50 ? '#5fd38d' : f >= 30 ? '#f4b942' : '#ff6b6b');
  const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
  function draw() {
    const W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (const f of [30, 60]) { const y = H - (f / 75) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    if (hist.length < 2) return;
    const step = W / 59;
    g.beginPath();
    hist.forEach((f, i) => { const x = W - (hist.length - 1 - i) * step, y = H - Math.min(1, f / 75) * (H - 2) - 1; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.strokeStyle = color(hist[hist.length - 1]); g.lineWidth = 1.6 * dpr; g.stroke();
  }
  ctx.updaters.unshift(() => {
    const now = performance.now(), dt = now - last; last = now;
    if (!on) return;
    // renderer.info has accumulated everything drawn in the previous frame (shadows and post passes included)
    calls = info.render.calls; tris = info.render.triangles; info.reset();
    frames++; acc += dt; worst = Math.max(worst, dt);
    if (acc < 500) return;
    const f = (frames * 1000) / acc;
    hist.push(f); if (hist.length > 60) hist.shift();
    num.textContent = Math.round(f); num.style.color = color(f);
    sub.textContent = `${(acc / frames).toFixed(1)} ms · worst ${worst.toFixed(0)} · ${fmt(calls)} draws · ${fmt(tris)} tris`;
    frames = 0; acc = 0; worst = 0;
    draw();
  });
  return {
    setVisible(v) {
      on = v; el.hidden = !v; info.autoReset = !v;
      if (v) { info.reset(); frames = 0; acc = 0; worst = 0; last = performance.now(); }
    },
  };
}
