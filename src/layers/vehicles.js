// Low-poly vehicle models shared by the moving traffic and the parked cars. Each is lofted from a few body
// sections (a shaped lower body, a tapered glass cabin under a body-coloured roof) with wheels, lights, mirrors and
// trim. Local axes: x forward, y up, z across. Vertex colours: white takes the instance colour (the paint), the
// rest keep their tone; aLight marks headlights (1) and tail lights (2), which glow after dark.
import * as THREE from 'three';

const GLASS = [0.1, 0.14, 0.18], DARK = [0.06, 0.065, 0.075], TRIM = [0.16, 0.17, 0.19], PAINT = [1, 1, 1];
const HEAD = [1.0, 0.96, 0.86], TAIL = [0.78, 0.1, 0.1], CHROME = [0.7, 0.72, 0.75], RIM2 = [0.5, 0.52, 0.56];

export class Shape {
  constructor() { this.pos = []; this.col = []; this.li = []; }
  // triangles are turned to face away from c (the centre of the part they belong to)
  tri(a, b, c3, col, li, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c3[0] - a[0], vy = c3[1] - a[1], vz = c3[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (a[0] + b[0] + c3[0]) / 3 - c[0], my = (a[1] + b[1] + c3[1]) / 3 - c[1], mz = (a[2] + b[2] + c3[2]) / 3 - c[2];
    const flip = nx * mx + ny * my + nz * mz < 0;
    for (const p of flip ? [a, c3, b] : [a, b, c3]) { this.pos.push(p[0], p[1], p[2]); this.col.push(col[0], col[1], col[2]); this.li.push(li); }
  }
  quad(a, b, c3, d, col, li, c) { this.tri(a, b, c3, col, li, c); this.tri(a, c3, d, col, li, c); }
  box(cx, cy, cz, sx, sy, sz, col, li = 0) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2, c = [cx, cy, cz];
    const P = (x, y, z) => [x, y, z];
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), col, li, c);
    this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), col, li, c);
    this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), col, li, c);
    this.quad(P(x1, y0, z0), P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), col, li, c);
    this.quad(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), col, li, c);
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), col, li, c);
  }
  // sections along x: [x, y0, y1, half width]; top(i) and side(i) give each span's colour
  loft(st, top, side, bottom = DARK) {
    let cx = 0, cy = 0; for (const s of st) { cx += s[0]; cy += (s[1] + s[2]) / 2; }
    const c = [cx / st.length, cy / st.length, 0];
    for (let i = 0; i < st.length - 1; i++) {
      const [xa, a0, a1, wa] = st[i], [xb, b0, b1, wb] = st[i + 1];
      this.quad([xa, a1, -wa], [xa, a1, wa], [xb, b1, wb], [xb, b1, -wb], top(i), 0, c);
      this.quad([xa, a0, -wa], [xa, a0, wa], [xb, b0, wb], [xb, b0, -wb], bottom, 0, c);
      for (const sg of [-1, 1]) this.quad([xa, a0, sg * wa], [xb, b0, sg * wb], [xb, b1, sg * wb], [xa, a1, sg * wa], side(i), 0, c);
    }
    for (const k of [0, st.length - 1]) {
      const [x, y0, y1, w] = st[k];
      if (y1 - y0 > 0.02) this.quad([x, y0, -w], [x, y0, w], [x, y1, w], [x, y1, -w], side(Math.min(k, st.length - 2)), 0, c);
    }
  }
  // rings along x, each a closed outline of [y, z] points (the same number in every ring), joined into a skin;
  // col(k, i) colours the strip between outline points k and k + 1 in span i; the ends are capped
  ringLoft(st, col, cap) {
    const n = st[0].pts.length; let cx = 0, cy = 0;
    for (const s of st) { cx += s.x; for (const q of s.pts) cy += q[0] / n; }
    const c = [cx / st.length, cy / st.length, 0];
    for (let i = 0; i < st.length - 1; i++) for (let k = 0; k < n; k++) {
      const a = st[i], b = st[i + 1], k1 = (k + 1) % n;
      this.quad([a.x, a.pts[k][0], a.pts[k][1]], [a.x, a.pts[k1][0], a.pts[k1][1]], [b.x, b.pts[k1][0], b.pts[k1][1]], [b.x, b.pts[k][0], b.pts[k][1]], col(k, i), 0, c);
    }
    for (const s of [st[0], st[st.length - 1]]) for (let k = 1; k < n - 1; k++) {
      this.tri([s.x, s.pts[0][0], s.pts[0][1]], [s.x, s.pts[k][0], s.pts[k][1]], [s.x, s.pts[k + 1][0], s.pts[k + 1][1]], cap, 0, c);
    }
  }
  disc(x, y, z, r, col, N = 12) {
    const c = [x, y, z - Math.sign(z)];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      this.tri([x, y, z], [x + Math.cos(a0) * r, y + Math.sin(a0) * r, z], [x + Math.cos(a1) * r, y + Math.sin(a1) * r, z], col, 0, c);
    }
  }
  bar(a, b, t, col) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
    const u = Math.abs(d[1]) / L > 0.9 ? [1, 0, 0] : [0, 1, 0];
    let s = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]]; const sl = Math.hypot(s[0], s[1], s[2]) || 1; s = s.map((v) => (v / sl) * t / 2);
    let v = [d[1] * s[2] - d[2] * s[1], d[2] * s[0] - d[0] * s[2], d[0] * s[1] - d[1] * s[0]]; const vl = Math.hypot(v[0], v[1], v[2]) || 1; v = v.map((q) => (q / vl) * t / 2);
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const P = (o, i, j) => [o[0] + s[0] * i + v[0] * j, o[1] + s[1] * i + v[1] * j, o[2] + s[2] * i + v[2] * j];
    for (const [i, j, i2, j2] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) this.quad(P(a, i, j), P(a, i2, j2), P(b, i2, j2), P(b, i, j), col, 0, c);
  }
  wheel(x, z, r, w) {
    const N = 10, c = [x, r, z];
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const p0 = [x + Math.cos(a0) * r, r + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, r + Math.sin(a1) * r];
      this.quad([p0[0], p0[1], z - w / 2], [p1[0], p1[1], z - w / 2], [p1[0], p1[1], z + w / 2], [p0[0], p0[1], z + w / 2], DARK, 0, c);
      for (const sg of [-1, 1]) {
        const zz = z + (sg * w) / 2;
        this.tri([x, r, zz], [p0[0], p0[1], zz], [p1[0], p1[1], zz], DARK, 0, c);
        // alloy rim with a dark hub
        const h0 = [x + Math.cos(a0) * r * 0.66, r + Math.sin(a0) * r * 0.66], h1 = [x + Math.cos(a1) * r * 0.66, r + Math.sin(a1) * r * 0.66];
        this.tri([x, r, zz + sg * 0.012], [h0[0], h0[1], zz + sg * 0.012], [h1[0], h1[1], zz + sg * 0.012], i % 2 ? CHROME : RIM2, 0, c);
        const k0 = [x + Math.cos(a0) * r * 0.2, r + Math.sin(a0) * r * 0.2], k1 = [x + Math.cos(a1) * r * 0.2, r + Math.sin(a1) * r * 0.2];
        this.tri([x, r, zz + sg * 0.02], [k0[0], k0[1], zz + sg * 0.02], [k1[0], k1[1], zz + sg * 0.02], DARK, 0, c);
      }
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aLight', new THREE.Float32BufferAttribute(this.li, 1));
    g.computeVertexNormals();
    return g;
  }
}

// A passenger car. The body is skinned over cross-sections that round the shoulders and crown the bonnet (rocker
// trim along the sills, dark underside); the cabin is a tapered glasshouse whose end spans are the raked screens and
// whose middle carries the roof. Wheels sit in dark arches; lights, grille, mirrors, pillars and bumpers are added.
// body: [x, underside y, top y, half width]; cabin: [x, base y, roof y, half width at base, at roof].
const bodyRing = ([x, yb, yt, w]) => {
  const sill = Math.min(yb + 0.2, yt - 0.06), waist = yb + (yt - yb) * 0.66, wt = w * 0.84;
  return { x, pts: [[yb, -w * 0.88], [sill, -w], [waist, -w], [yt, -wt], [yt + 0.035, 0], [yt, wt], [waist, w], [sill, w], [yb, w * 0.88]] };
};
const cabRing = ([x, y0, y1, w0, w1]) => ({ x, pts: [[y0, -w0], [y1 - 0.07, -w1], [y1, -w1 * 0.72], [y1, w1 * 0.72], [y1 - 0.07, w1], [y0, w0]] });
function car({ body, cabin, wheels, wr = 0.34, paint = PAINT, roof = paint, extras }) {
  const S = new Shape();
  S.ringLoft(body.map(bodyRing), (k) => (k === 8 ? DARK : k === 0 || k === 7 ? TRIM : paint), paint);
  const last = cabin.length - 2;
  S.ringLoft(cabin.map(cabRing), (k, i) => (k === 5 ? paint : k === 0 || k === 4 || i === 0 || i === last ? GLASS : roof), GLASS);
  // pillars at the screens and behind the front doors, so the glass reads as windows
  const half = Math.max(...body.map((b) => b[3]));
  const cA = cabin[1], cB = cabin[cabin.length - 2], belt = cA[1];
  for (const sg of [-1, 1]) {
    S.box((cA[0] + cB[0]) / 2 - 0.1, (belt + cA[2]) / 2, sg * ((cA[3] + cA[4]) / 2 + 0.012), 0.1, cA[2] - belt - 0.04, 0.05, roof === paint ? paint : DARK);
    S.box(cabin[cabin.length - 1][0] - 0.16, belt + 0.09, sg * (half + 0.09), 0.17, 0.11, 0.15, paint);              // mirrors
  }
  // bumpers, grille, lights: slim lamps at the corners, a light bar across the tail
  const x0 = body[0][0], x1 = body[body.length - 1][0], f = body[body.length - 2], rr = body[1];
  S.box(x1 - 0.02, f[1] + 0.12, 0, 0.12, 0.2, f[3] * 1.5, DARK);
  S.box(x1 - 0.05, f[2] - 0.13, 0, 0.1, 0.1, f[3] * 0.7, TRIM);
  for (const sg of [-1, 1]) S.box(x1 - 0.1, f[2] - 0.1, sg * f[3] * 0.7, 0.16, 0.11, f[3] * 0.44, HEAD, 1);
  S.box(x0 + 0.03, rr[2] - 0.13, 0, 0.1, 0.1, rr[3] * 1.84, TAIL, 2);
  S.box(x0 + 0.02, rr[1] + 0.12, 0, 0.12, 0.18, rr[3] * 1.5, DARK);
  // wheels in their arches
  for (const wx of wheels) for (const sg of [-1, 1]) {
    S.disc(wx, wr + 0.02, sg * (half + 0.008), wr + 0.1, DARK);
    S.wheel(wx, sg * (half - 0.07), wr, 0.26);
  }
  if (extras) extras(S, half);
  return S.geometry();
}

const sedan = (o = {}) => car({
  body: [[-2.32, 0.46, 0.66, 0.74], [-2.24, 0.34, 0.9, 0.86], [-1.9, 0.3, 0.98, 0.91], [-1.45, 0.3, 1.0, 0.93], [0.85, 0.3, 1.0, 0.93], [1.45, 0.3, 0.95, 0.92], [1.95, 0.3, 0.86, 0.89], [2.22, 0.36, 0.74, 0.84], [2.32, 0.46, 0.6, 0.72]],
  cabin: [[-1.58, 0.98, 1.07, 0.87, 0.84], [-0.95, 0.98, 1.43, 0.87, 0.72], [0.15, 0.98, 1.45, 0.87, 0.72], [1.0, 0.98, 1.06, 0.87, 0.84]],
  wheels: [-1.42, 1.42], ...o,
});
const hatch = () => car({
  body: [[-1.95, 0.46, 0.7, 0.74], [-1.88, 0.32, 1.0, 0.86], [-1.2, 0.3, 1.02, 0.9], [0.75, 0.3, 1.02, 0.9], [1.5, 0.3, 0.9, 0.88], [1.86, 0.36, 0.76, 0.82], [1.95, 0.46, 0.62, 0.7]],
  cabin: [[-1.88, 1.0, 1.1, 0.84, 0.8], [-1.6, 1.0, 1.46, 0.84, 0.72], [0.1, 1.0, 1.48, 0.84, 0.72], [0.86, 1.0, 1.08, 0.84, 0.8]],
  wheels: [-1.26, 1.2], wr: 0.33, roof: DARK,                                                                       // a contrast roof
});
const suv = () => car({
  body: [[-2.42, 0.52, 0.8, 0.8], [-2.34, 0.38, 1.08, 0.93], [-1.9, 0.36, 1.14, 0.97], [0.95, 0.36, 1.14, 0.97], [1.6, 0.36, 1.08, 0.96], [2.1, 0.38, 0.98, 0.93], [2.34, 0.44, 0.84, 0.87], [2.42, 0.52, 0.7, 0.78]],
  cabin: [[-2.36, 1.12, 1.22, 0.92, 0.88], [-2.08, 1.12, 1.76, 0.92, 0.79], [0.2, 1.12, 1.78, 0.92, 0.79], [1.04, 1.12, 1.2, 0.92, 0.88]],
  wheels: [-1.5, 1.5], wr: 0.42,
  extras: (S) => { for (const sg of [-1, 1]) S.box(-0.9, 1.83, sg * 0.62, 1.9, 0.05, 0.06, TRIM); },                 // roof rails
});
const pickup = () => car({
  body: [[-2.66, 0.52, 1.0, 0.84], [-2.58, 0.4, 1.1, 0.95], [1.3, 0.4, 1.1, 0.96], [1.9, 0.4, 1.05, 0.95], [2.4, 0.42, 0.94, 0.92], [2.6, 0.5, 0.8, 0.84], [2.66, 0.56, 0.7, 0.78]],
  cabin: [[-0.62, 1.08, 1.18, 0.9, 0.86], [-0.42, 1.08, 1.72, 0.9, 0.79], [0.7, 1.08, 1.74, 0.9, 0.79], [1.44, 1.08, 1.17, 0.9, 0.86]],
  wheels: [-1.7, 1.62], wr: 0.42,
  // the load bed: a dark floor sunk between the body sides, a tailgate lip, a sports bar behind the cab
  extras: (S) => { S.box(-1.62, 1.12, 0, 1.9, 0.05, 1.6, DARK); for (const sg of [-1, 1]) S.box(-1.62, 1.2, sg * 0.88, 1.98, 0.17, 0.1, PAINT); S.box(-2.6, 1.2, 0, 0.1, 0.17, 1.76, PAINT); S.box(-0.72, 1.45, 0, 0.1, 0.62, 1.7, TRIM); },
});
// a low, wide sports car: wedge nose, cabin set forward of a long rear deck, side intakes, a wing on posts
const sport = () => car({
  body: [[-2.25, 0.4, 0.62, 0.8], [-2.15, 0.26, 0.86, 0.96], [-1.5, 0.22, 0.92, 1.0], [-0.3, 0.22, 0.84, 0.99], [0.9, 0.22, 0.74, 0.97], [1.7, 0.22, 0.6, 0.93], [2.1, 0.26, 0.5, 0.86], [2.25, 0.34, 0.42, 0.74]],
  cabin: [[-1.35, 0.9, 0.98, 0.86, 0.8], [-0.62, 0.86, 1.16, 0.84, 0.64], [0.05, 0.82, 1.17, 0.84, 0.64], [0.98, 0.72, 0.8, 0.86, 0.8]],
  wheels: [-1.38, 1.36], wr: 0.37, roof: DARK,
  extras: (S) => {
    for (const sg of [-1, 1]) { S.box(-0.75, 0.56, sg * 1.0, 0.7, 0.24, 0.06, DARK); S.box(-1.95, 1.0, sg * 0.62, 0.1, 0.2, 0.08, DARK); }
    S.box(-1.98, 1.12, 0, 0.42, 0.05, 1.84, PAINT);
    S.box(1.2, 0.74, 0, 0.9, 0.03, 0.5, DARK);                                                                       // bonnet vent
  },
});
// Dubai taxi: cream body, coloured roof and a roof sign (drawn with a white instance colour)
const taxi = () => sedan({ paint: [0.93, 0.86, 0.68], roof: [0.78, 0.12, 0.13], extras: (S) => { S.box(-0.35, 1.56, 0, 0.26, 0.14, 0.62, [1.0, 0.82, 0.2], 1); } });

function bus() {
  const S = new Shape(), W = 1.27;
  // lower body, the window band and the roof as three stacked sections with a raked front
  S.loft([[-6.0, 0.42, 1.25, W - 0.04], [-5.9, 0.36, 1.25, W], [5.55, 0.36, 1.25, W], [5.98, 0.5, 1.25, W - 0.1]], () => PAINT, () => PAINT);
  S.loft([[-5.94, 1.24, 2.5, W - 0.03], [5.5, 1.24, 2.5, W - 0.03], [5.9, 1.24, 2.38, W - 0.14]], () => GLASS, () => GLASS, PAINT);
  S.loft([[-5.98, 2.49, 3.02, W], [5.2, 2.49, 3.02, W], [5.7, 2.49, 2.84, W - 0.1]], () => PAINT, () => PAINT);
  // pillars between the windows, doors, roof units
  for (let x = -5.2; x < 5.2; x += 1.3) for (const sg of [-1, 1]) S.box(x, 1.87, sg * (W - 0.01), 0.12, 1.26, 0.05, PAINT);
  S.box(-5.98, 1.9, 0, 0.06, 1.1, 1.7, PAINT);
  for (const x of [-2.6, 1.2]) S.box(x, 3.1, 0, 2.2, 0.18, 1.5, CHROME);
  S.box(0, 0.5, 0, 11.4, 0.2, W * 2 + 0.03, TRIM);
  for (const sg of [-1, 1]) { S.box(5.98, 0.82, sg * 0.84, 0.1, 0.18, 0.5, HEAD, 1); S.box(-6.0, 0.9, sg * 0.9, 0.08, 0.22, 0.4, TAIL, 2); }
  for (const wx of [-3.6, 3.9]) for (const sg of [-1, 1]) S.wheel(wx, sg * (W - 0.12), 0.48, 0.3);
  return S.geometry();
}

// kinds with their share of the traffic; `fixed` models carry their own colours (drawn with a white instance);
// `colors` gives a kind its own paint list
export const CAR_KINDS = [
  { key: 'sedan', make: sedan, share: 0.3 },
  { key: 'suv', make: suv, share: 0.31 },
  { key: 'hatch', make: hatch, share: 0.12 },
  { key: 'pickup', make: pickup, share: 0.08 },
  { key: 'sport', make: sport, share: 0.08, colors: ['#f2a01e', '#e53a2e', '#2f8fe8', '#7ccf3a', '#f4d21f', '#8a4fd6', '#f4f4f2', '#1c1d20', '#ff6a1f', '#19b6b0'] },
  { key: 'taxi', make: taxi, share: 0.11, fixed: true },
];
export const busGeometry = bus;
// the kind for a 0..1 roll
export function carKind(roll) { let x = roll; for (let i = 0; i < CAR_KINDS.length; i++) { x -= CAR_KINDS[i].share; if (x <= 0) return i; } return 0; }
// paint: mostly white, silver, black and grey, with a good share of strong colours
export const CAR_COLORS = [['#f4f4f2', 24], ['#c9ccd0', 12], ['#1c1d20', 11], ['#7d8288', 7], ['#e8dcc2', 5], ['#2a3f66', 5], ['#b3202a', 7], ['#2f7fd6', 7], ['#3d6f4a', 3], ['#e7a52e', 4], ['#ef7a22', 4], ['#6a3a8e', 2], ['#18a39c', 3]];
