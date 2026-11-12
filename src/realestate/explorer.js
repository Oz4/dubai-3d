import * as THREE from 'three';
import { triangulate, signedArea, centroid, easeInOut } from '../core/util.js';
import { MODE } from '../layers/buildings.js';
import { floorLayout, priceUnit } from './units.js';
import { analyseView } from './analysis.js';

export const STATUS_COLORS = { available: '#3fcf8e', reserved: '#f5b942', sold: '#9aa3b2' };
const FRUSTUM_H = 2400;

function prism(ring, y0, y1, opts = {}) {
  const pos = [], nor = [], idx = []; let v = 0;
  const r = signedArea(ring) < 0 ? ring.slice().reverse() : ring;
  if (opts.walls !== false) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length]; const dx = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(dx, dn); if (L < 0.01) continue;
    const nx = dn / L, nz = dx / L;
    pos.push(a[0], y0, -a[1], b[0], y0, -b[1], b[0], y1, -b[1], a[0], y1, -a[1]);
    for (let k = 0; k < 4; k++) nor.push(nx, 0, nz);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
  }
  if (opts.top !== false) {
    const t = triangulate([r]);
    if (t) { const s = v; for (const p of t.verts) { pos.push(p[0], y1, -p[1]); nor.push(0, 1, 0); v++; } for (const i of t.tris) idx.push(s + i); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}
function inset(ring, d) {
  const c = centroid(ring);
  return ring.map((p) => { const dx = p[0] - c[0], dy = p[1] - c[1], L = Math.hypot(dx, dy) || 1; const k = Math.max(0.6, 1 - d / L); return [c[0] + dx * k, c[1] + dy * k]; });
}

export function createExplorer(ctx, { buildings, grid }) {
  const group = new THREE.Group(); group.name = 'explorer'; group.visible = false;
  ctx.scene.add(group);
  const labelRoot = document.getElementById('labels');
  const uSel = { value: -1 }, uLift = { value: 0 };
  const st = { active: false, info: null, floors: 0, fh: 3.5, floor: 0, layout: null, units: [], unitMeshes: [], selected: null, hover: null, labels: [], firstPerson: false };
  let stackMesh = null, floorGroup = null, liftAnim = null;

  const stackMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 });
  stackMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uSel, uLift });
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFloor; uniform float uSel, uLift;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aFloor > uSel + 0.5) transformed.y += uLift;
        if (abs(aFloor - uSel) < 0.5) transformed.y = -2000.0;`);
  };
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { uSel, uLift });
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFloor; uniform float uSel, uLift;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (aFloor > uSel + 0.5) transformed.y += uLift;
        if (abs(aFloor - uSel) < 0.5) transformed.y = -2000.0;`);
  };

  function buildStack(info, floors, fh) {
    const ring = signedArea(info.plate[0]) < 0 ? info.plate[0].slice().reverse() : info.plate[0];
    const pos = [], nor = [], col = [], fl = [], idx = []; let v = 0;
    const slabC = new THREE.Color('#f3f1ec');
    const glassC = info.wall.clone().lerp(new THREE.Color('#7ea6c4'), 0.55).multiplyScalar(0.92);
    const t = triangulate([ring]);
    for (let f = 0; f < floors; f++) {
      const y0 = f * fh, ySlab = y0 + 0.5, y1 = y0 + fh;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length]; const dx = b[0] - a[0], dn = b[1] - a[1], L = Math.hypot(dx, dn); if (L < 0.01) continue;
        const nx = dn / L, nz = dx / L;
        for (const [ya, yb, c] of [[y0, ySlab, slabC], [ySlab, y1, glassC]]) {
          pos.push(a[0], ya, -a[1], b[0], ya, -b[1], b[0], yb, -b[1], a[0], yb, -a[1]);
          for (let k = 0; k < 4; k++) { nor.push(nx, 0, nz); col.push(c.r, c.g, c.b); fl.push(f); }
          idx.push(v, v + 1, v + 2, v, v + 2, v + 3); v += 4;
        }
      }
      if (t) { // ceiling cap of each floor (visible on the top of the stack and below the gap)
        const s = v;
        for (const p of t.verts) { pos.push(p[0], y1, -p[1]); nor.push(0, 1, 0); col.push(slabC.r, slabC.g, slabC.b); fl.push(f); v++; }
        for (const i of t.tris) idx.push(s + i);
        const s2 = v; // underside, seen through the gap when floors above are lifted
        for (const p of t.verts) { pos.push(p[0], y0, -p[1]); nor.push(0, -1, 0); col.push(0.75, 0.75, 0.75); fl.push(f); v++; }
        for (let i = 0; i < t.tris.length; i += 3) idx.push(s2 + t.tris[i], s2 + t.tris[i + 2], s2 + t.tris[i + 1]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aFloor', new THREE.Float32BufferAttribute(fl, 1));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, stackMat);
    m.customDepthMaterial = depthMat; m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  function clearFloor() {
    if (floorGroup) { floorGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose && !o.material.shared) o.material.dispose(); }); group.remove(floorGroup); }
    floorGroup = null; st.unitMeshes = [];
    for (const l of st.labels) l.el.remove();
    st.labels = [];
  }

  function buildFloor(f) {
    clearFloor();
    const info = st.info, fh = st.fh;
    const yF = f * fh;
    const layout = floorLayout(info.plate, info, f + 1, st.floors);
    st.layout = layout;
    floorGroup = new THREE.Group();
    const slab = new THREE.Mesh(prism(layout.plate, yF - 0.05, yF + 0.45), new THREE.MeshStandardMaterial({ color: '#e9e6df', roughness: 0.8 }));
    slab.receiveShadow = true; slab.castShadow = true;
    floorGroup.add(slab);
    if (layout.corridor) floorGroup.add(new THREE.Mesh(prism(layout.corridor, yF + 0.46, yF + 0.5, { walls: false }), new THREE.MeshStandardMaterial({ color: '#d9d4c8', roughness: 0.9 })));
    // units (with view analysis + pricing)
    for (const u of layout.units) {
      u.view = analyseView(ctx, buildings, grid, info, u, yF);
      Object.assign(u, priceUnit(u, info, st.floors, u.view));
      const mat = new THREE.MeshStandardMaterial({ color: STATUS_COLORS[u.status], roughness: 0.55, emissive: '#ffffff', emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(prism(inset(u.poly, 0.45), yF + 0.45, yF + 0.95), mat);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.unit = u;
      floorGroup.add(mesh); st.unitMeshes.push(mesh);
      const el = document.createElement('div');
      el.className = 'lbl unit';
      el.textContent = u.number;
      el.title = `${u.beds} · ${Math.round(u.sqft).toLocaleString()} sq ft`;
      el.addEventListener('click', (e) => { e.stopPropagation(); selectUnit(u); });
      labelRoot.appendChild(el);
      st.labels.push({ el, pos: new THREE.Vector3(u.centroid[0], yF + 1.2, -u.centroid[1]) });
    }
    if (layout.core) {
      const core = new THREE.Mesh(prism(layout.core, yF + 0.45, yF + 3.4), new THREE.MeshStandardMaterial({ color: '#7b8494', roughness: 0.7 }));
      core.castShadow = true; floorGroup.add(core);
    }
    // low glass parapet around the plate
    const glass = new THREE.Mesh(prism(layout.plate, yF + 0.45, yF + 1.9, { top: false }),
      new THREE.MeshStandardMaterial({ color: '#bfe3f2', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
    floorGroup.add(glass);
    group.add(floorGroup);
    st.selected = null;
  }

  // camera target that puts the plate in the free screen area left of the floor picker + details card
  function framedTarget(f, zoom) {
    const c = st.info.center, W = window.innerWidth;
    const offsetPx = W > 700 ? -(430 - 16) / 2 : 0;
    const wpp = (FRUSTUM_H * (W / window.innerHeight)) / (zoom || ctx.camera.zoom) / W;
    const s = new THREE.Spherical().setFromVector3(ctx.camera.position.clone().sub(ctx.controls.target));
    const right = new THREE.Vector3(Math.cos(s.theta), 0, -Math.sin(s.theta));
    return new THREE.Vector3(c[0], f * st.fh, -c[1]).addScaledVector(right, -offsetPx * wpp);
  }

  function setFloor(f, animate = true) {
    f = THREE.MathUtils.clamp(f, 0, st.floors - 1);
    st.floor = f;
    uSel.value = f;
    buildFloor(f);
    const lift = Math.max(28, st.fh * 9);
    liftAnim = { t: animate ? 0 : 1, from: animate ? 0 : lift, to: lift };
    ctx.flyTo({ target: framedTarget(f, st.zoom), duration: animate ? 0.7 : 0.01 });
    ctx.emit('floor-changed', { floor: f, floors: st.floors, layout: st.layout });
  }

  function open(info) {
    close(true);
    st.active = true; st.info = info;
    // floors of the typical plate: OSM level count when known, otherwise ~3.5 m per floor
    const top = info.plateTop || info.height;
    st.floors = Math.max(1, Math.min(160, Math.round(Math.min(info.levels || top / 3.5, top / 2.8))));
    st.fh = top / st.floors;
    buildings.setState(info.index, MODE.HIDDEN); buildings.commit();
    stackMesh = buildStack(info, st.floors, st.fh);
    group.add(stackMesh);
    group.visible = true;
    const side = Math.sqrt(Math.max(200, Math.abs(signedArea(info.plate[0]))));
    const aspect = window.innerWidth / window.innerHeight;
    const W = window.innerWidth;
    const freeW = W > 700 ? W - 446 : W;
    const zoomH = (FRUSTUM_H * aspect * 0.72 * freeW) / (side * 1.3 * W);
    const zoomV = (FRUSTUM_H * 0.5) / side;
    const zoom = THREE.MathUtils.clamp(Math.min(zoomH, zoomV), 1.5, 40);
    st.zoom = zoom;
    const start = Math.min(st.floors - 1, Math.max(0, Math.round(st.floors * 0.62)));
    setFloor(start, true);
    ctx.flyTo({ target: framedTarget(start, zoom), zoom, polar: THREE.MathUtils.degToRad(44), duration: 1.1 });
  }

  function close(silent) {
    if (!st.active) return;
    if (st.firstPerson) exitView();
    clearFloor();
    if (stackMesh) { stackMesh.geometry.dispose(); group.remove(stackMesh); stackMesh = null; }
    group.visible = false;
    st.active = false;
    const info = st.info; st.info = null;
    if (!silent && info) ctx.emit('floors-closed', info);
  }

  function selectUnit(u) {
    st.selected = u;
    for (const m of st.unitMeshes) {
      const sel = m.userData.unit === u;
      m.material.color.set(sel ? '#ffd166' : STATUS_COLORS[m.userData.unit.status]);
      m.material.emissive.set(sel ? '#ffb000' : '#ffffff');
      m.material.emissiveIntensity = sel ? 0.35 : 0;
    }
    ctx.emit('unit-selected', u);
  }

  // ---------------------------------------------------------------- first-person view from a unit
  const look = { yaw: 0, pitch: -0.08, base: 0, dragging: false, x: 0, y: 0 };
  const canvas = ctx.renderer.domElement;
  function applyLook() {
    const p = ctx.persp;
    const dir = new THREE.Vector3(Math.cos(look.yaw) * Math.cos(look.pitch), Math.sin(look.pitch), -Math.sin(look.yaw) * Math.cos(look.pitch));
    p.lookAt(p.position.clone().add(dir));
  }
  canvas.addEventListener('pointerdown', (e) => { if (!st.firstPerson) return; look.dragging = true; look.x = e.clientX; look.y = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!st.firstPerson || !look.dragging) return;
    look.yaw += (e.clientX - look.x) * 0.0035; look.pitch -= (e.clientY - look.y) * 0.0035;
    look.yaw = THREE.MathUtils.clamp(look.yaw, look.base - 1.75, look.base + 1.75);
    look.pitch = THREE.MathUtils.clamp(look.pitch, -0.9, 0.45);
    look.x = e.clientX; look.y = e.clientY; applyLook();
  });
  canvas.addEventListener('pointerup', () => { look.dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    if (!st.firstPerson) return;
    ctx.persp.fov = THREE.MathUtils.clamp(ctx.persp.fov + e.deltaY * 0.03, 28, 80); ctx.persp.updateProjectionMatrix();
  }, { passive: true });

  function viewFromUnit(u) {
    if (!u || !u.facade) return;
    const fac = u.facade, [nx, ny] = fac.normal;
    const H = st.floor * st.fh + 1.6;
    ctx.persp.position.set(fac.mid[0] + nx * 1.5, H, -(fac.mid[1] + ny * 1.5));
    ctx.persp.fov = 66; ctx.persp.updateProjectionMatrix();
    look.base = look.yaw = Math.atan2(ny, nx); look.pitch = -0.1;
    applyLook();
    group.visible = false;
    buildings.setState(st.info.index, MODE.NORMAL); buildings.commit();
    st.firstPerson = true; ctx.inputLocked = true;
    ctx.useCamera(ctx.persp);
    for (const l of st.labels) l.el.classList.add('hidden');
    ctx.emit('first-person', { on: true, unit: u, info: st.info });
  }
  function exitView() {
    if (!st.firstPerson) return;
    st.firstPerson = false; ctx.inputLocked = false;
    ctx.useCamera(ctx.camera);
    group.visible = true;
    buildings.setState(st.info.index, MODE.HIDDEN); buildings.commit();
    ctx.emit('first-person', { on: false });
  }

  // ---------------------------------------------------------------- per-frame: lift animation + unit labels
  const v = new THREE.Vector3();
  ctx.updaters.push((dt) => {
    if (liftAnim && liftAnim.t < 1) {
      liftAnim.t = Math.min(1, liftAnim.t + dt / 0.6);
      uLift.value = liftAnim.from + (liftAnim.to - liftAnim.from) * easeInOut(liftAnim.t);
    } else if (liftAnim) uLift.value = liftAnim.to;
    if (!st.active || st.firstPerson) return;
    const cam = ctx.activeCamera, W = window.innerWidth, Hh = window.innerHeight;
    const showLabels = cam.zoom > 3.2;
    for (const l of st.labels) {
      v.copy(l.pos).project(cam);
      l.el.style.left = `${(v.x * 0.5 + 0.5) * W}px`; l.el.style.top = `${(-v.y * 0.5 + 0.5) * Hh}px`;
      l.el.classList.toggle('hidden', !showLabels);
    }
  });

  return {
    state: st, open, close, setFloor, selectUnit, viewFromUnit, exitView,
    get active() { return st.active; },
    pickUnit(raycaster) {
      if (!st.active || !st.unitMeshes.length) return null;
      const hits = raycaster.intersectObjects(st.unitMeshes, false);
      return hits.length ? hits[0].object.userData.unit : null;
    },
    setHover(u) {
      if (st.hover === u) return;
      st.hover = u;
      for (const m of st.unitMeshes) if (m.userData.unit !== st.selected) m.material.emissiveIntensity = m.userData.unit === u ? 0.18 : 0;
    },
  };
}
