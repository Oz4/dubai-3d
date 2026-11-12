import * as THREE from 'three';
import { createContext } from './core/context.js';
import { createEnvironment, dubaiDate, dubaiParts } from './core/environment.js';
import { buildGround } from './layers/ground.js';
import { buildGrass } from './layers/grass.js';
import { createBuildings } from './layers/buildings.js';
import { buildRoads } from './layers/roads.js';
import { buildRails } from './layers/rails.js';
import { buildStations } from './layers/stations.js';
import { startTreeAtlas } from './layers/trees.js';
import { buildMarina } from './layers/marina.js';
import { buildSeaLife } from './layers/sealife.js';
import { buildClouds } from './layers/clouds.js';
import { createTraffic } from './layers/traffic.js';
import { createLabels } from './layers/labels.js';
import { MAP_ONLY, fetchData, loadDataImage } from './core/data.js';
import { createUI } from './ui/ui.js';
import { createLayers } from './ui/layers.js';
import { createSections } from './core/sections.js';
import { createBurjShow } from './layers/burjShow.js';
import { buildBurjLake } from './layers/burjLake.js';

const stepEl = document.getElementById('loader-step');
// each loader step's duration goes to the console ([startup]) for keeping start-up fast as the map grows
const timings = []; let stepAt = performance.now(), stepMsg = 'start';
const step = async (msg) => {
  const now = performance.now(); timings.push(`${stepMsg.replace(/…$/, '')} ${Math.round(now - stepAt)} ms`); stepAt = now; stepMsg = msg;
  stepEl.textContent = msg; await new Promise((r) => setTimeout(r, 0));
};
// requestAnimationFrame pauses in hidden/background pages; fall back to a timer so the scene keeps updating.
const schedule = (fn) => (document.hidden ? setTimeout(() => fn(), 100) : requestAnimationFrame(fn));

async function main() {
  // the map-only build leaves out the real-estate features: no developer filters, search, building cards or units
  if (MAP_ONLY) document.body.classList.add('map-only');
  const treeAtlas = startTreeAtlas(); // painted in a worker while everything else loads
  await step('Loading the city…');
  // the whole city in light form; each section's detail streams in later (core/sections.js)
  const data = await (await fetchData('data/world.json')).json();
  const ctx = createContext(document.getElementById('scene'), data);
  // the sections' detail files start downloading now, so streaming has them at hand when the city appears
  ctx.prefetch = {};
  for (const s of data.meta.sections || []) if (s.file) ctx.prefetch[s.file] = fetchData(s.file);
  // 2026 vegetation index (Sentinel-2) for the ground painter; optional
  if (data.meta.ndvi) {
    ctx.ndvi = await loadDataImage(data.meta.ndvi.src);
  }
  window.__ctx = ctx; // handy for debugging in the console

  await step('Lighting the scene…');
  const env = createEnvironment(ctx);
  await step('Shaping coastline, water & landscape…');
  const ground = buildGround(ctx, env);
  const grass = buildGrass(ctx, ground);
  const nB = data.buildings.length.toLocaleString();
  await step(`Raising ${nB} buildings…`);
  const buildings = await createBuildings(ctx, { progress: (f) => { stepEl.textContent = `Raising ${nB} buildings… ${Math.round(f * 100)}%`; } });
  await step('Paving roads, bridges & rail…');
  const roads = buildRoads(ctx);
  const rails = buildRails(ctx);
  const stations = buildStations(ctx);
  await step('Mooring yachts, launching jet skis & spinning Ain Dubai…');
  const marina = buildMarina(ctx);
  const sealife = buildSeaLife(ctx, ground);
  const clouds = buildClouds(ctx);
  await step('Starting traffic…');
  const traffic = createTraffic(ctx);
  const labels = createLabels(ctx, buildings);
  let realestate = {};
  if (import.meta.env.MODE !== 'map') { // (written out, so the map-only build drops the module entirely)
    await step('Loading developers & projects…');
    const { createRealEstate } = await import('./realestate/realestate.js');
    realestate = await createRealEstate(ctx, { buildings, ground, env, labels });
  }
  const ui = createUI(ctx, { env, buildings, realestate });

  // initial time: today in Dubai at noon. The sun stands high in the south, so the ground in an iso view is
  // sunlit and the towers' shadows fall mostly behind them, out of sight.
  const now = dubaiParts(new Date());
  ui.setDateTime(now.y, now.m, now.d, 12 * 60);

  // trees, gardens, parked cars, street life, amenities and people arrive with each section
  await step('Planting trees & opening the streets…');
  const sections = createSections(ctx, { buildings, ground, treeAtlas: await treeAtlas });

  Object.assign(ctx, { env, ground, grass, buildings, roads, rails, stations, marina, sealife, clouds, traffic, labels, realestate, ui, sections });
  ctx.show = createBurjShow(ctx, { buildings });
  buildBurjLake(ctx, { labels });
  ctx.layers = createLayers(ctx, { env, traffic, rails, sealife, marina, clouds, labels, sunpath: ui.sunpath, sections });

  // quality presets (and Auto stepping down on slow devices) live in the Layers panel

  // ---- render loop
  const clock = new THREE.Clock();
  const failed = new WeakSet(); // a failing updater is reported once and must never stop the loop
  const run = (fn, dt) => { try { fn(dt, ctx.time); } catch (e) { if (!failed.has(fn)) { failed.add(fn); console.error(e); } } };
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    ctx.time += dt;
    ctx.controls.enabled = ctx.activeCamera === ctx.camera && !ctx.inputLocked;
    if (ctx.activeCamera === ctx.camera) ctx.controls.update();
    for (const fn of ctx.updaters) run(fn, dt);
    try { ctx.composer.render(dt); } catch (e) { if (!failed.has(frame)) { failed.add(frame); console.error(e); } }
    schedule(frame);
  }
  ctx.renderNow = () => { for (const fn of ctx.updaters) fn(0, ctx.time); ctx.composer.render(0); };
  schedule(frame);
  await step('done');
  console.info('[startup] ' + timings.join(' | '));
  const loader = document.getElementById('loader');
  loader.classList.add('done');
  setTimeout(() => loader.remove(), 900);
}

main().catch((err) => {
  console.error(err);
  stepEl.textContent = 'Failed to load: ' + err.message;
});
