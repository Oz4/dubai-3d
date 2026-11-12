// Sun-path overlay: a dome drawn over the area you are looking at, with a compass ring (N/E/S/W),
// today's arc of the sun from sunrise to sunset with hour marks, and a glowing sun at its current
// position with its ray to the ground. Appears while the time is being changed; can be pinned.
import * as THREE from 'three';
import * as SunCalc from 'suncalc';
import { dubaiDate } from '../core/environment.js';

function textSprite(text, color = '#ffffff', size = 64) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.font = `700 ${size * 0.62}px Inter, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(15,22,38,0.85)'; g.strokeText(text, 64, 34);
  g.fillStyle = color; g.fillText(text, 64, 34);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.renderOrder = 32;
  return s;
}
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,240,1)'); grd.addColorStop(0.18, 'rgba(255,236,170,1)'); grd.addColorStop(0.32, 'rgba(255,196,80,0.75)'); grd.addColorStop(1, 'rgba(255,170,40,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function createSunPath(ctx, env) {
  const { scene, data } = ctx;
  const group = new THREE.Group(); group.name = 'sun-path'; group.visible = false; scene.add(group);
  const mats = [];
  const M = (m) => { m.transparent = true; m.depthTest = false; m.depthWrite = false; mats.push(m); return m; };
  const dirOf = (az, alt) => new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));

  // compass ring + ticks + letters (unit radius; the group is scaled to the view)
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.0, 160).rotateX(-Math.PI / 2), M(new THREE.MeshBasicMaterial({ color: '#ffffff', opacity: 0.75 })));
  ring.renderOrder = 30; group.add(ring);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.985, 96).rotateX(-Math.PI / 2), M(new THREE.MeshBasicMaterial({ color: '#0d1830', opacity: 0.12 })));
  inner.renderOrder = 29; group.add(inner);
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, major = i % 18 === 0, mid = i % 6 === 0;
    const L = major ? 0.07 : mid ? 0.04 : 0.02, w = major ? 0.008 : 0.004;
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(w, L).rotateX(-Math.PI / 2).translate(0, 0, -(1 - L / 2)), ring.material);
    tick.rotation.y = -a; tick.renderOrder = 30; group.add(tick);
  }
  for (const [t, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const s = textSprite(t, t === 'N' ? '#ff6b6b' : '#ffffff'); const r = THREE.MathUtils.degToRad(a);
    s.position.set(Math.sin(r) * 1.1, 0.02, -Math.cos(r) * 1.1); s.scale.set(0.14, 0.07, 1); mats.push(s.material); group.add(s);
  }
  // today's sun arc, hour marks, sunrise/sunset markers (rebuilt when the date changes)
  const arcGroup = new THREE.Group(); group.add(arcGroup);
  function rebuildDay(y, m, d) {
    while (arcGroup.children.length) { const c = arcGroup.children.pop(); c.geometry && c.geometry.dispose(); if (c.material) { const i = mats.indexOf(c.material); if (i >= 0) mats.splice(i, 1); c.material.dispose(); } }
    const { lat0, lon0 } = data.meta;
    const pts = [], hours = [];
    for (let min = 0; min <= 1440; min += 6) {
      const p = SunCalc.getPosition(dubaiDate(y, m, d, min), lat0, lon0);
      if (p.altitude < -0.5) continue;
      const v = dirOf(THREE.MathUtils.degToRad(p.azimuth), THREE.MathUtils.degToRad(Math.max(0, p.altitude)));
      pts.push(v);
      if (min % 60 === 0 && p.altitude > 2) hours.push([min / 60, v]);
    }
    if (pts.length < 3) return;
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.008, 6, false), M(new THREE.MeshBasicMaterial({ color: '#ffc34d', opacity: 0.95 })));
    tube.renderOrder = 31; arcGroup.add(tube);
    // the arc's footprint on the ground, so the sun's daily sweep reads in plan as well
    const foot = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, 0.002, p.z))), 120, 0.003, 4, false), M(new THREE.MeshBasicMaterial({ color: '#ffc34d', opacity: 0.35 })));
    foot.renderOrder = 30; arcGroup.add(foot);
    for (const [h, v] of hours) {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), M(new THREE.MeshBasicMaterial({ color: '#fff2c8', opacity: 1 })));
      dot.position.copy(v); dot.renderOrder = 31; arcGroup.add(dot);
      if (h % 3 === 0) { const s = textSprite(String(h).padStart(2, '0'), '#ffe7a6'); s.position.copy(v).multiplyScalar(1.09); s.scale.set(0.12, 0.06, 1); mats.push(s.material); arcGroup.add(s); }
    }
    const t = SunCalc.getTimes(dubaiDate(y, m, d, 720), lat0, lon0);
    for (const [when, label] of [[t.sunrise, 'sunrise'], [t.sunset, 'sunset']]) {
      if (!when || isNaN(when)) continue;
      const p = SunCalc.getPosition(when, lat0, lon0);
      const v = dirOf(THREE.MathUtils.degToRad(p.azimuth), 0);
      const mk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 8).translate(0, 0.04, 0), M(new THREE.MeshBasicMaterial({ color: label === 'sunrise' ? '#ffb15a' : '#ff8a4a', opacity: 1 })));
      mk.position.copy(v); mk.renderOrder = 31; arcGroup.add(mk);
      const s = textSprite(label, '#ffd29a', 48); s.position.copy(v).multiplyScalar(1.16).setY(0.05); s.scale.set(0.2, 0.1, 1); mats.push(s.material); arcGroup.add(s);
    }
  }
  // the sun now, its ray to the centre and a plumb line to the ground
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), depthTest: false, transparent: true, blending: THREE.AdditiveBlending }));
  sun.scale.set(0.22, 0.22, 1); sun.renderOrder = 33; mats.push(sun.material); group.add(sun);
  const ray = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1, 6).translate(0, 0.5, 0), M(new THREE.MeshBasicMaterial({ color: '#ffd36a', opacity: 0.85 })));
  ray.renderOrder = 31; group.add(ray);
  const plumb = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 1, 4).translate(0, 0.5, 0), M(new THREE.MeshBasicMaterial({ color: '#ffffff', opacity: 0.5 })));
  plumb.renderOrder = 31; group.add(plumb);
  const lc = document.createElement('canvas'); lc.width = 256; lc.height = 96;
  const ltex = new THREE.CanvasTexture(lc); ltex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: ltex, depthTest: false, transparent: true }));
  label.renderOrder = 34; label.scale.set(0.34, 0.13, 1); mats.push(label.material); group.add(label);
  const drawLabel = (txt) => {
    const g = lc.getContext('2d'); g.clearRect(0, 0, 256, 96);
    g.fillStyle = 'rgba(15,22,38,0.78)'; g.beginPath(); g.roundRect(18, 14, 220, 68, 34); g.fill();
    g.font = '700 38px Inter, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#ffd36a'; g.fillText('\u2600 ' + txt, 128, 50);
    ltex.needsUpdate = true;
  };
  let lastLabel = '';
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compassName = (az) => DIRS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

  function updateSun() {
    const s = env.state; const up = s.altitude > -0.5;
    const v = dirOf(THREE.MathUtils.degToRad(s.azimuth), THREE.MathUtils.degToRad(Math.max(0, s.altitude)));
    sun.visible = ray.visible = plumb.visible = label.visible = up;
    if (!up) return;
    sun.position.copy(v);
    ray.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize()); ray.scale.set(1, 1, 1);
    plumb.position.set(v.x, 0, v.z); plumb.scale.set(1, Math.max(0.001, v.y), 1);
    const txt = `${compassName(s.azimuth)} ${Math.round(s.altitude)}°`;
    if (txt !== lastLabel) { lastLabel = txt; drawLabel(txt); }
    label.position.copy(v).add(new THREE.Vector3(0, 0.13, 0));
  }

  let pinned = false, showUntil = 0, fade = 0, clock = 0;
  ctx.updaters.push((dt) => {
    clock += dt;
    const want = pinned || clock < showUntil ? 1 : 0;
    fade += (want - fade) * Math.min(1, dt * 5);
    group.visible = fade > 0.01;
    if (!group.visible) return;
    for (const m of mats) { if (m.userData.base == null) m.userData.base = m.opacity; m.opacity = m.userData.base * fade; }
    // sit over the middle of the view, sized to it
    const cam = ctx.activeCamera;
    let R = 400;
    if (cam.isOrthographicCamera) R = Math.min((cam.right - cam.left) / cam.zoom, (cam.top - cam.bottom) / cam.zoom) * 0.24;
    else R = 260;
    group.position.copy(ctx.focus ? ctx.focus() : ctx.controls.target).setY(2);
    group.scale.setScalar(R);
    updateSun();
  });
  return {
    group,
    poke(seconds = 5) { showUntil = clock + seconds; },
    setPinned(v) { pinned = v; },
    rebuildDay,
    compassName,
  };
}
