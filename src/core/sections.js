// Streaming, section by section and cell by cell. world.json carries the whole city in a light form (coast,
// roads, rail, every building's massing). Each section's detail lives in its own file: it is fetched when the view
// comes near and split into 1 km cells. The cells near the view are then built part by part (detailed buildings,
// trees, gardens and parked cars, walkways and street furniture, amenities, people), nearest first, each part a
// short job that only runs while the map is still, so panning and zooming never wait for it. Parts that fall out
// of reach are dropped again; a section's data goes once none of it has been wanted for a while. How far each part
// reaches is set by the quality preset (ctx.quality), and tiny things are skipped when zoomed far out.
import * as THREE from 'three';
import { buildTrees } from '../layers/trees.js';
import { buildDetails } from '../layers/details.js';
import { buildAmenities } from '../layers/amenities.js';
import { buildStreets } from '../layers/streets.js';
import { buildPeople } from '../layers/people.js';
import { CELL } from '../layers/buildings.js'; // the light building chunks share this grid
import { centroid } from './util.js';
import { fetchData } from './data.js';
const SECTION_LINGER = 30;  // seconds a section's data stays once none of it is wanted
const PART_LINGER = 6;      // seconds a built part stays after leaving its reach
// a cell's parts in build order (at equal distance); `reach` names the quality preset's radius, `zoom` the
// closest-in orthographic zoom below which the part is too small to matter
const PARTS = [
  { key: 'buildings', reach: 'buildings', zoom: 0.75 },
  { key: 'trees', reach: 'trees', zoom: 0, build: (s, d) => buildTrees(s, d.treeAtlas) },
  { key: 'details', reach: 'details', zoom: 0.65, build: (s) => buildDetails(s) },
  { key: 'streets', reach: 'details', zoom: 0.65, build: (s) => buildStreets(s) },
  { key: 'amenities', reach: 'details', zoom: 0.65, build: (s) => buildAmenities(s) },
  { key: 'people', reach: 'people', zoom: 1.2, build: (s, d) => buildPeople(s, d.ground) },
];
const POINT_LISTS = ['trees', 'parked', 'bays', 'canopies', 'xwalks', 'lamps', 'umbrellas', 'aprons', 'figures', 'buggies'];
const DEFAULT_QUALITY = { reach: { buildings: 4000, trees: 7000, details: 2000, people: 1400 }, treeDensity: 1, treeShadows: true, peopleShadows: true };

export function createSections(ctx, deps) {
  const { buildings, ground } = deps;
  const q = new URLSearchParams(location.search);
  const OFF = q.get('stream') === 'off'; // ?stream=off: the light city only (for comparison)
  const metas = ctx.data.meta.sections || [];
  const S = metas.map((m) => ({ meta: m, id: m.id, state: 'idle', data: null, cells: null, group: null, token: null, farFor: 0, dist: Infinity, ms: 0 }));
  const modListeners = [], unloadListeners = [];
  const toast = createToast();
  let loading = null, building = false, tick = 0, density = -1, treeShadows = null, grow = 1;
  const Q = () => ctx.quality || DEFAULT_QUALITY;
  const gate = () => (ctx.workGate ? ctx.workGate() : new Promise((r) => setTimeout(r, 0)));
  const layerOn = (k) => !ctx.layers || ctx.layers.state[k] !== false;
  const partOn = (key) => (key === 'people' ? layerOn('people') : key === 'trees' ? layerOn('palms') || layerOn('trees') || layerOn('shrubs') : true);

  // ---- the view: centre, radius of what can be seen (with a margin), zoom
  function view() {
    const cam = ctx.activeCamera;
    if (cam.isOrthographicCamera) {
      const t = ctx.focus ? ctx.focus() : ctx.controls.target; // the ground at the centre of the view
      const R = (Math.hypot(cam.right - cam.left, cam.top - cam.bottom) / cam.zoom) * 0.7 + 700;
      return { x: t.x, y: -t.z, R, zoom: cam.zoom };
    }
    return { x: cam.position.x, y: -cam.position.z, R: 2500, zoom: Infinity };
  }
  const rectDist = (x, y, r) => Math.hypot(Math.max(r[0] - x, 0, x - r[2]), Math.max(r[1] - y, 0, y - r[3]));
  const distTo = (x, y, rects) => rects.reduce((d, r) => Math.min(d, rectDist(x, y, r)), Infinity);
  // Trees reach as far as the view when it is zoomed out (up to three times the preset's radius), so a far view
  // keeps the green of the close one; they are thinned there and drawn larger to hold the canopy (applyDensity)
  const reachOf = (v, def) => {
    if (v.zoom < def.zoom) return -1;
    const base = Q().reach[def.reach];
    // detailed buildings always cover a view that fits in 2.6 km, so no preset shows light buildings at its edges
    if (def.key === 'buildings') return Math.min(v.R, Math.max(base, 2600));
    return Math.min(v.R, def.key === 'trees' && v.zoom < 1.6 ? base * 3 : base);
  };

  // ---- a section's data, split into cells
  function partition(sec, data) {
    const cells = new Map();
    const amenKeys = Object.keys(data.amenities || {});
    const cellAt = (x, y) => {
      const i = Math.floor(x / CELL), j = Math.floor(y / CELL), key = i + ',' + j;
      let c = cells.get(key);
      if (!c) {
        const d = { buildings: data.buildings, plots: [], paths: [], bikeLanes: [], kerbs: [], amenities: Object.fromEntries(amenKeys.map((k) => [k, []])) };
        for (const k of POINT_LISTS) d[k] = [];
        c = { key, r: [i * CELL, j * CELL, (i + 1) * CELL, (j + 1) * CELL], data: d, b: [], parts: {}, dist: Infinity };
        cells.set(key, c);
      }
      return c;
    };
    for (const k of POINT_LISTS) for (const it of data[k] || []) cellAt(it[0], it[1]).data[k].push(it);
    for (const pl of data.plots || []) cellAt(pl.p[0][0], pl.p[0][1]).data.plots.push(pl);
    // walkways and cycle lanes are cut where they cross into another cell
    for (const k of ['paths', 'bikeLanes']) for (const ln of data[k] || []) {
      const pts = ln.p; if (!pts || pts.length < 2) continue;
      let cur = null, piece = null;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], c = cellAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        if (c !== cur) { if (piece) cur.data[k].push(piece.length === pts.length ? ln : { ...ln, p: piece }); cur = c; piece = [a]; }
        piece.push(b);
      }
      cur.data[k].push(piece.length === pts.length ? ln : { ...ln, p: piece });
    }
    // kerb lines too, with their per-vertex fillet widths and dropped-kerb values
    for (const ln of data.kerbs || []) {
      const pts = ln.p; if (!pts || pts.length < 2) continue;
      const cut = (a, b) => (a === 0 && b === pts.length - 1 ? ln : { ...ln, p: pts.slice(a, b + 1), f: ln.f.slice(a, b + 1), d: ln.d.slice(a, b + 1) });
      let cur = null, i0 = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], c = cellAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        if (c !== cur) { if (cur) cur.data.kerbs.push(cut(i0, i - 1)); cur = c; i0 = i - 1; }
      }
      cur.data.kerbs.push(cut(i0, pts.length - 1));
    }
    for (const k of amenKeys) for (const it of data.amenities[k]) {
      const at = Array.isArray(it) ? (Array.isArray(it[0]) ? it[0] : it) : it.c || (it.p && (Array.isArray(it.p[0][0]) ? it.p[0][0] : it.p[0])) || [0, 0];
      cellAt(at[0], at[1]).data.amenities[k].push(it);
    }
    // the same point (and so the same cell) the light chunks were bucketed by
    const lite = ctx.data.buildings, b0 = sec.meta.b0;
    for (let k = 0; k < (data.buildings || []).length; k++) { const c = centroid(lite[b0 + k].p[0]); cellAt(c[0], c[1]).b.push(k); }
    // the cell's share of the section (people place swimmers inside it)
    for (const c of cells.values()) {
      c.rects = sec.meta.rects.map((r) => [Math.max(r[0], c.r[0]), Math.max(r[1], c.r[1]), Math.min(r[2], c.r[2]), Math.min(r[3], c.r[3])]).filter((r) => r[2] > r[0] && r[3] > r[1]);
      if (!c.rects.length) c.rects = [c.r];
    }
    return cells;
  }

  async function loadSection(sec) {
    const token = {};
    sec.token = token; sec.state = 'loading'; loading = sec;
    const alive = () => sec.token === token;
    const t0 = performance.now();
    toast.show(`Loading ${sec.meta.name}…`);
    try {
      // (the files start downloading while the city is still being set up: main.js)
      const early = ctx.prefetch && ctx.prefetch[sec.meta.file];
      if (early) delete ctx.prefetch[sec.meta.file];
      const res = (early && (await early.catch(() => null))) || (await fetchData(sec.meta.file));
      if (!res.ok) throw new Error(`${sec.meta.file}: HTTP ${res.status}`);
      await gate();
      if (!alive()) return;
      const data = await res.json();
      await gate();
      if (!alive()) return;
      sec.cells = partition(sec, data);
      sec.data = data;
      sec.group = new THREE.Group(); sec.group.name = 'section-' + sec.id;
      ctx.scene.add(sec.group);
      sec.state = 'loaded';
      await ground.addSection(sec.id, data, sec.meta.rects);
      sec.ms = performance.now() - t0;
      console.info(`[sections] ${sec.id}: ${sec.cells.size} cells ready in ${(sec.ms / 1000).toFixed(1)} s`);
    } catch (e) {
      console.error(`[sections] ${sec.id} failed`, e);
      if (alive()) { unloadSection(sec); sec.state = 'failed'; }
    } finally {
      if (loading === sec) loading = null;
      if (!loading) toast.hide();
    }
  }

  function unloadSection(sec) {
    sec.token = null;
    if (sec.cells) for (const c of sec.cells.values()) for (const inst of Object.values(c.parts)) disposePart(inst);
    ground.removeSection(sec.id);
    if (sec.group) sec.group.removeFromParent();
    sec.cells = null; sec.data = null; sec.group = null; sec.state = 'idle'; sec.farFor = 0;
    console.info(`[sections] ${sec.id} unloaded`);
  }

  // ---- one part of one cell: its own scope (data, scene group, updaters, subscriptions, reflective materials)
  function scope(sec, cell, key) {
    const group = new THREE.Group(); group.name = key + '-' + cell.key;
    sec.group.add(group);
    const updaters = [], offs = [], reflective = [];
    const s = Object.create(ctx);
    // a material left in the environment's reflection list would keep its module (and the data) alive
    const env = ctx.env && Object.assign(Object.create(ctx.env), { addReflective(m, k) { reflective.push(m); ctx.env.addReflective(m, k); } });
    Object.assign(s, {
      root: ctx, data: cell.data, scene: group, updaters, env,
      section: { ...sec.meta, rects: cell.rects, cell: true },
      // subscribe through the root, remember it for disposal, and catch up with the latest payload
      on(name, fn) { const off = ctx.on(name, fn); offs.push(off); if (ctx.last[name] !== undefined) fn(ctx.last[name]); return off; },
    });
    return { s, group, updaters, offs, reflective };
  }
  async function buildPart(sec, cell, def) {
    const inst = { id: `${sec.id}:${cell.key}:${def.key}`, key: def.key, sec, cell, scope: null, mod: null, farFor: 0, building: true };
    cell.parts[def.key] = inst;
    inst.scope = scope(sec, cell, def.key);
    if (def.key === 'buildings') {
      await buildings.buildCell(sec.id, cell.key, sec.data.buildings, cell.b, inst.scope.group);
      if (cell.parts[def.key] !== inst || !inst.scope) return inst; // dropped while it was being built
      inst.mod = { group: inst.scope.group };
    } else {
      inst.mod = def.build(inst.scope.s, deps);
      applyTo(inst);
      for (const l of modListeners) l(inst, def.key, inst.mod);
    }
    inst.building = false;
    return inst;
  }
  function disposePart(inst) {
    const { sec, cell } = inst;
    if (cell.parts[inst.key] === inst) delete cell.parts[inst.key];
    if (inst.key === 'buildings') buildings.disposeCell(sec.id, cell.key);
    const sc = inst.scope;
    if (sc) {
      for (const off of sc.offs) off();
      if (ctx.env) for (const m of sc.reflective) ctx.env.removeReflective(m);
      sc.updaters.length = 0;
      sc.s.data = null;
      disposeTree(sc.group, ctx.env);
      sc.group.removeFromParent();
    }
    for (const l of unloadListeners) l(inst);
    inst.scope = null; inst.mod = null;
  }
  function* parts(key) {
    for (const sec of S) if (sec.cells) for (const c of sec.cells.values()) for (const inst of Object.values(c.parts)) if (inst.mod && (!key || inst.key === key)) yield inst;
  }
  // quality settings on a freshly built part
  function applyTo(inst) {
    const m = inst.mod, Qs = Q();
    if (inst.key === 'trees') { if (density >= 0) m.setDensity(density, grow); m.setShadows(treeShadows ?? Qs.treeShadows); }
    if (inst.key === 'people') { m.setShadows(Qs.peopleShadows); if (!layerOn('people')) m.setEnabled(false); }
  }

  // part updaters run from the main loop
  const failed = new WeakSet();
  ctx.updaters.push((dt, t) => {
    for (const inst of parts()) for (const fn of inst.scope.updaters) {
      try { fn(dt, t); } catch (e) { if (!failed.has(fn)) { failed.add(fn); console.error(`[sections] ${inst.id}`, e); } }
    }
  });

  // ---- what to build next: the nearest wanted part (buildings and trees first at equal distance)
  function nextJob() {
    const v = view();
    let best = null, bestScore = Infinity;
    for (const sec of S) {
      if (sec.state !== 'loaded') continue;
      for (const c of sec.cells.values()) {
        const d = rectDist(v.x, v.y, c.r);
        PARTS.forEach((def, pi) => {
          if (c.parts[def.key] || !partOn(def.key) || d >= reachOf(v, def)) return;
          if (def.key === 'buildings' && !c.b.length) return;
          if (def.key === 'trees' && !c.data.trees.length) return;
          const score = d + pi * 150;
          if (score < bestScore) { bestScore = score; best = { sec, cell: c, def }; }
        });
      }
    }
    return best;
  }
  async function pump() {
    building = true;
    try {
      for (;;) {
        await gate();
        const job = nextJob();
        if (!job) break;
        await buildPart(job.sec, job.cell, job.def);
      }
    } catch (e) {
      console.error('[sections] build failed', e);
    } finally { building = false; }
  }

  // tree density: the quality preset's share, thinned further when zoomed far out (where tree shadows are
  // too small to see and are skipped too)
  function applyDensity(v) {
    const zf = v.zoom === Infinity ? 1 : Math.min(1, Math.max(0.35, 0.35 + (0.65 * (v.zoom - 0.35)) / 0.85));
    const d = Math.round(Q().treeDensity * zf * 50) / 50;
    const sh = Q().treeShadows && v.zoom >= 0.45;
    if (d === density && sh === treeShadows) return;
    density = d; treeShadows = sh;
    // the plants left stand in for the ones dropped: each is drawn larger by the root of the share shown
    // (only the zoom's thinning is made up for, not the quality preset's own share)
    grow = Math.min(1.7, 1 / Math.sqrt(zf));
    for (const inst of parts('trees')) { inst.mod.setDensity(d, grow); inst.mod.setShadows(sh); }
  }

  // ---- scheduler, four times a second
  ctx.updaters.push((dt) => {
    tick += dt;
    if (tick < 0.25) return;
    const step = tick; tick = 0;
    const v = view();
    const maxReach = Math.max(...PARTS.map((def) => reachOf(v, def)));
    for (const sec of S) {
      sec.dist = distTo(v.x, v.y, sec.meta.rects);
      const wanted = !OFF && sec.dist < maxReach;
      sec.farFor = wanted ? 0 : sec.farFor + step;
      if ((sec.state === 'loaded' || sec.state === 'loading') && sec.farFor > SECTION_LINGER) unloadSection(sec);
    }
    // drop parts that have left their reach for a while
    for (const sec of S) {
      if (sec.state !== 'loaded') continue;
      for (const c of sec.cells.values()) {
        c.dist = rectDist(v.x, v.y, c.r);
        for (const def of PARTS) {
          const inst = c.parts[def.key]; if (!inst || inst.building) continue;
          const want = partOn(def.key) && c.dist < reachOf(v, def) * 1.2 + 200;
          inst.farFor = want ? 0 : inst.farFor + step;
          if (inst.farFor > PART_LINGER) disposePart(inst);
        }
      }
    }
    applyDensity(v);
    if (!loading && !OFF) {
      const cand = S.filter((sec) => sec.state === 'idle' && sec.dist < maxReach).sort((a, b) => a.dist - b.dist)[0];
      if (cand) loadSection(cand);
    }
    if (!building) pump();
  });

  return {
    list: S,
    parts,
    onModule(fn) { modListeners.push(fn); for (const inst of parts()) fn(inst, inst.key, inst.mod); },
    onUnload(fn) { unloadListeners.push(fn); },
    busy: () => !!loading || building,
    // re-apply the quality preset to everything already built
    applyQuality() { density = -1; treeShadows = null; applyDensity(view()); for (const inst of parts()) applyTo(inst); },
    counts() {
      const out = { sections: 0, cells: 0 };
      for (const sec of S) if (sec.cells) { out.sections++; out.cells += sec.cells.size; }
      for (const inst of parts()) out[inst.key] = (out[inst.key] || 0) + 1;
      return out;
    },
  };
}

// dispose everything a part created (shared materials and textures are marked and kept)
function disposeTree(root, env) {
  const mats = new Set();
  root.traverse((o) => {
    if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared)) o.geometry.dispose();
    if (o.isInstancedMesh) o.dispose();
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
    if (o.customDepthMaterial) mats.add(o.customDepthMaterial);
  });
  for (const m of mats) {
    if (m.userData && m.userData.shared) continue;
    for (const v of Object.values(m)) if (v && v.isTexture && !(v.userData && v.userData.shared)) v.dispose();
    if (env && env.removeReflective) env.removeReflective(m);
    m.dispose();
  }
}

function createToast() {
  const el = document.createElement('div');
  el.id = 'section-toast'; el.className = 'panel'; el.hidden = true;
  el.innerHTML = '<span class="st-spin"></span><span class="st-text"></span>';
  document.getElementById('app').appendChild(el);
  const text = el.querySelector('.st-text');
  let hideT = 0;
  return {
    show(msg) { clearTimeout(hideT); text.textContent = msg; el.hidden = false; el.classList.add('on'); },
    hide() { el.classList.remove('on'); hideT = setTimeout(() => { el.hidden = true; }, 400); },
  };
}
