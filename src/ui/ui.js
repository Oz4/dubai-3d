import * as THREE from 'three';
import * as SunCalc from 'suncalc';
import { dubaiDate } from '../core/environment.js';
import { easeInOut } from '../core/util.js';
import { createSunPath } from '../layers/sunpath.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const fmtMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.floor(m % 60))}`;
const fmtDate = (d) => { const t = new Date(d.getTime() + 240 * 60000); return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; };

export function createUI(ctx, { env, buildings, realestate }) {
  const timeEl = $('time'), dateEl = $('date'), clockEl = $('clock'), stateEl = $('sunstate'), sunTimesEl = $('suntimes');
  let cur = { y: 2026, m: 11, d: 5, minutes: 720 };
  const sunpath = createSunPath(ctx, env);
  const sunMark = $('compass-sun');
  let viewHeading = 0; // radians, 0 = looking north
  const placeCompassSun = () => {
    const s = env.state, up = s.altitude > -0.5;
    const th = THREE.MathUtils.degToRad(s.azimuth) - viewHeading;
    sunMark.setAttribute('transform', `translate(${20 + Math.sin(th) * 18.5} ${20 - Math.cos(th) * 18.5})`);
    sunMark.querySelector('circle').setAttribute('fill', up ? '#ffc94a' : '#8a93a8');
    $('compass').title = up ? `Sun: ${sunpath.compassName(s.azimuth)} (${Math.round(s.azimuth)}°), ${Math.round(s.altitude)}° above the horizon` : 'Sun below the horizon';
  };

  function apply() {
    const date = dubaiDate(cur.y, cur.m, cur.d, cur.minutes);
    env.setDate(date);
    clockEl.textContent = fmtMin(cur.minutes);
    timeEl.value = Math.round(cur.minutes);
    const alt = env.state.altitude;
    const phase = alt < -6 ? 'Night' : alt < 0 ? (cur.minutes < 720 ? 'Dawn' : 'Dusk') : alt < 6 ? (cur.minutes < 720 ? 'Sunrise' : 'Sunset') : alt < 18 ? (cur.minutes < 720 ? 'Morning light' : 'Golden hour') : cur.minutes < 690 ? 'Morning' : cur.minutes < 810 ? 'Midday sun' : 'Afternoon';
    stateEl.textContent = alt > -0.5 ? `${phase} \u00b7 sun ${sunpath.compassName(env.state.azimuth)} ${Math.round(alt)}\u00b0` : phase;
    placeCompassSun();
  }
  function paintDaylight() {
    const { lat0, lon0 } = ctx.data.meta;
    const stops = [];
    for (let i = 0; i <= 48; i++) {
      const alt = SunCalc.getPosition(dubaiDate(cur.y, cur.m, cur.d, i * 30), lat0, lon0).altitude;
      const c = alt < -6 ? '#1b2442' : alt < 0 ? '#5a4a7a' : alt < 8 ? '#f29a5a' : alt < 20 ? '#f6c56b' : '#ffe08a';
      stops.push(`${c} ${(i / 48) * 100}%`);
    }
    $('daylight-band').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
    const t = env.state.times;
    if (t && t.sunrise && t.sunset) sunTimesEl.textContent = `☀ ${fmtDate(t.sunrise)} · ☾ ${fmtDate(t.sunset)}`;
  }

  timeEl.addEventListener('input', () => { cur.minutes = +timeEl.value; apply(); sunpath.poke(); });
  dateEl.addEventListener('change', () => {
    const [y, m, d] = dateEl.value.split('-').map(Number);
    if (y && m && d) { cur = { ...cur, y, m, d }; apply(); paintDaylight(); sunpath.rebuildDay(y, m, d); sunpath.poke(); }
  });
  // play the day
  let playing = false;
  const playBtn = $('play');
  const setPlaying = (v) => {
    playing = v; playBtn.classList.toggle('on', v);
    playBtn.title = v ? 'Pause' : 'Play the day'; playBtn.setAttribute('aria-label', playBtn.title);
  };
  playBtn.addEventListener('click', () => setPlaying(!playing));
  ctx.updaters.push((dt) => {
    if (!playing) return;
    cur.minutes += dt * 32; // ~45 s for a full day
    if (cur.minutes >= 1440) cur.minutes -= 1440;
    apply(); sunpath.poke(1.5);
  });

  // (layer switches live in ui/layers.js)

  // ---- panels: each can be minimised (remembered); H hides them all to leave the map alone (not remembered)
  const app = $('app');
  const UI_KEY = 'dubai3d.ui.v1';
  let saved = {};
  try { const v = JSON.parse(localStorage.getItem(UI_KEY)); if (v && typeof v === 'object') saved = v; } catch { /* private mode */ }
  function collapsible(panel, btn, key, what, fallback) {
    const set = (v, persist = true) => {
      panel.classList.toggle('collapsed', v);
      btn.setAttribute('aria-expanded', String(!v));
      btn.title = (v ? 'Expand ' : 'Minimise ') + what; btn.setAttribute('aria-label', btn.title);
      if (!persist) return;
      saved[key] = v;
      try { localStorage.setItem(UI_KEY, JSON.stringify(saved)); } catch { /* ignore */ }
    };
    btn.addEventListener('click', () => set(!panel.classList.contains('collapsed')));
    set(typeof saved[key] === 'boolean' ? saved[key] : fallback, false);
    return set;
  }
  // small screens start with the filters folded to the search pill
  collapsible($('filter'), $('filter-collapse'), 'filterCollapsed', 'the filters', window.matchMedia('(max-width: 900px)').matches);
  const timebar = $('timebar');
  const foldTimebar = collapsible(timebar, $('timebar-collapse'), 'timebarCollapsed', 'the time bar', false);
  // the folded time bar is one big target: a click anywhere but its buttons opens it again
  timebar.addEventListener('click', (e) => { if (timebar.classList.contains('collapsed') && !e.target.closest('button')) foldTimebar(false); });

  const hideBtn = $('ui-hide'), restoreBtn = $('ui-restore');
  let uiHidden = false;
  function setUiHidden(v) {
    if (v === uiHidden) return;
    uiHidden = v;
    app.classList.toggle('ui-hidden', v);
    ctx.emit('ui-hidden', v); // the Layers panel closes itself
    // keyboard focus must not stay on a control that has just gone
    const a = document.activeElement;
    if (v && a && a.closest('.brand, #filter, #toolbar, #compass, #timebar, #layers-panel')) restoreBtn.focus({ preventScroll: true });
    else if (!v && a === restoreBtn) hideBtn.focus({ preventScroll: true });
  }
  hideBtn.addEventListener('click', () => setUiHidden(true));
  restoreBtn.addEventListener('click', () => setUiHidden(false));

  // the attribution wraps on narrow screens: give the CSS its height (and the time bar's) so nothing sits on it
  const measure = () => {
    app.style.setProperty('--attr-h', $('attribution').offsetHeight + 'px');
    app.style.setProperty('--timebar-h', timebar.offsetHeight + 'px');
  };
  if (window.ResizeObserver) { const ro = new ResizeObserver(measure); ro.observe($('attribution')); ro.observe(timebar); }
  measure();

  // ---- camera animation helpers
  const cam = ctx.camera, controls = ctx.controls;
  let anim = null;
  function sph() {
    const off = cam.position.clone().sub(controls.target);
    return new THREE.Spherical().setFromVector3(off);
  }
  function flyTo({ target, zoom, azimuth, polar, duration = 1.2 }) {
    // a turn in place pivots on what is at the centre of the screen (see context.js)
    if (!target && (azimuth != null || polar != null) && ctx.pivotOnCentre) ctx.pivotOnCentre();
    const s = sph();
    let a0 = s.theta, a1 = azimuth ?? s.theta;
    while (a1 - a0 > Math.PI) a1 -= Math.PI * 2;
    while (a1 - a0 < -Math.PI) a1 += Math.PI * 2;
    anim = {
      t: 0, duration,
      t0: controls.target.clone(), t1: target ? target.clone() : controls.target.clone(),
      z0: cam.zoom, z1: zoom ?? cam.zoom, a0, a1, p0: s.phi, p1: polar ?? s.phi, r: s.radius,
    };
  }
  ctx.flyTo = flyTo;
  ctx.updaters.unshift((dt) => {
    if (!anim) return;
    anim.t += dt / anim.duration;
    const k = easeInOut(Math.min(1, anim.t));
    controls.target.lerpVectors(anim.t0, anim.t1, k);
    cam.zoom = anim.z0 * Math.pow(anim.z1 / anim.z0, k);
    const off = new THREE.Vector3().setFromSphericalCoords(anim.r, anim.p0 + (anim.p1 - anim.p0) * k, anim.a0 + (anim.a1 - anim.a0) * k);
    cam.position.copy(controls.target).add(off);
    cam.updateProjectionMatrix();
    cam.lookAt(controls.target);
    if (anim.t >= 1) anim = null;
  });
  const rotate = (dir) => { const s = sph(); flyTo({ azimuth: Math.round((s.theta + dir * Math.PI / 2 - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4, duration: 0.7 }); };
  $('rot-left').addEventListener('click', () => rotate(-1));
  $('rot-right').addEventListener('click', () => rotate(1));
  const resetView = () => flyTo({ target: ctx.home.target, zoom: ctx.home.zoom, azimuth: ctx.home.azimuth, polar: ctx.home.polar, duration: 1.2 });
  $('reset-view').addEventListener('click', resetView);
  const faceNorth = () => { const s = sph(); flyTo({ azimuth: 0.0001, polar: s.phi, duration: 0.8 }); };
  $('compass').addEventListener('click', faceNorth);
  $('compass').addEventListener('keydown', (e) => { if (e.key === 'Enter') faceNorth(); }); // it is a div, so no built-in key
  const inField = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  window.addEventListener('keydown', (e) => {
    if (inField(e) || e.ctrlKey || e.metaKey || e.altKey) return; // typing, or a browser shortcut
    if (e.key === 'q' || e.key === 'Q') rotate(-1);
    if (e.key === 'e' || e.key === 'E') rotate(1);
    if (e.key === 'r' || e.key === 'R') resetView();
    if (e.key === 'h' || e.key === 'H') setUiHidden(!uiHidden);
    if (e.key === ' ') { setPlaying(!playing); e.preventDefault(); }
  });
  // Esc first closes what is open on the map (card, floors, unit view: realestate.js); with nothing open it
  // brings the panels back. Capture phase: this must look before realestate's handler closes things.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !uiHidden || inField(e)) return;
    if ($('details').hidden && $('floor-picker').hidden && $('exit-view').hidden) setUiHidden(false);
  }, true);
  const needle = $('compass-needle');
  ctx.updaters.push(() => {
    const c = ctx.activeCamera;
    const dir = new THREE.Vector3(); c.getWorldDirection(dir);
    const ang = Math.atan2(dir.x, -dir.z); // heading of the view, 0 = looking north
    needle.setAttribute('transform', `rotate(${(-ang * 180) / Math.PI} 20 20)`);
    if (Math.abs(ang - viewHeading) > 1e-3) { viewHeading = ang; placeCompassSun(); }
  });

  // ---- hover + click picking
  const raycaster = new THREE.Raycaster(); raycaster.firstHitOnly = false;
  const ndc = new THREE.Vector2();
  const tip = $('tooltip');
  let hoverAt = 0, lastMove = null, downAt = null;
  const canvas = ctx.renderer.domElement;
  canvas.addEventListener('pointermove', (e) => { lastMove = e; });
  canvas.addEventListener('pointerleave', () => { lastMove = null; tip.hidden = true; buildings.uHover.value = -1; });
  canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    if (moved > 6 || performance.now() - downAt.t > 600) return;
    if (ctx.activeCamera !== ctx.camera) return;
    setNdc(e);
    raycaster.setFromCamera(ndc, ctx.activeCamera);
    if (realestate.handleClick && realestate.handleClick(raycaster)) return;
    const hit = buildings.pick(raycaster);
    if (hit) ctx.emit('select-building', hit.index);
    else ctx.emit('deselect');
  });
  function setNdc(e) { const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
  ctx.updaters.push(() => {
    if (!lastMove || ctx.activeCamera !== ctx.camera) return;
    const now = performance.now(); if (now - hoverAt < 60) return; hoverAt = now;
    const e = lastMove; lastMove = null;
    setNdc(e);
    raycaster.setFromCamera(ndc, ctx.activeCamera);
    const custom = realestate.handleHover && realestate.handleHover(raycaster, e);
    if (custom) { buildings.uHover.value = -1; return; }
    const hit = buildings.pick(raycaster);
    if (hit) {
      const b = buildings.info[hit.index];
      buildings.uHover.value = hit.index;
      const dev = b.developer ? ` · ${b.developer.name}` : '';
      tip.innerHTML = `<b>${b.name || (b.type !== 'building' && b.type !== 'yes' ? cap(b.type) : 'Building')}</b><span>${Math.round(b.height)} m${dev}</span>`;
      tip.style.left = `${e.clientX + 14}px`; tip.style.top = `${e.clientY + 12}px`; tip.hidden = false;
      canvas.style.cursor = 'pointer';
    } else { buildings.uHover.value = -1; tip.hidden = true; canvas.style.cursor = ''; }
  });

  return {
    setDateTime(y, m, d, minutes) {
      cur = { y, m, d, minutes };
      dateEl.value = `${y}-${pad(m)}-${pad(d)}`;
      apply(); paintDaylight();
      sunpath.rebuildDay(y, m, d); sunpath.poke(7); // introduce the sun path once on load
    },
    get current() { return { ...cur }; },
    setMinutes(m) { cur.minutes = m; apply(); },
    flyTo,
    setUiHidden,
    tooltip: tip,
    sunpath,
  };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
