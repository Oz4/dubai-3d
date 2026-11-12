// Map region: Dubai is built section by section (scripts/sections.json). The pipeline processes the
// union of the built sections; for now that union has to be a rectangle (sections are chosen so it is).
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('./sections.json', import.meta.url), 'utf8'));

// Fixed projection origin shared by every section (never change it: built sections would move).
export const ORIGIN = cfg.origin;
export const SECTIONS = cfg.sections;
export const BUILT = SECTIONS.filter((s) => s.built);
export const REGION = BUILT.flatMap((s) => s.rects.map((r) => ({ ...r, section: s.id })));

// bounding box of the built sections
export const BBOX = REGION.reduce((b, r) => ({ s: Math.min(b.s, r.s), w: Math.min(b.w, r.w), n: Math.max(b.n, r.n), e: Math.max(b.e, r.e) }), { s: 90, w: 180, n: -90, e: -180 });

{
  const area = (r) => (r.n - r.s) * (r.e - r.w);
  const sum = REGION.reduce((a, r) => a + area(r), 0);
  if (Math.abs(sum - area(BBOX)) > 1e-9) throw new Error(`built sections must tile a rectangle for now (union ${sum.toFixed(6)} vs bbox ${area(BBOX).toFixed(6)} deg2)`);
}

// split the bbox into Overpass-sized tiles (degrees)
export function tiles(step = 0.03, b = BBOX) {
  const out = [];
  for (let s = b.s; s < b.n - 1e-9; s += step) for (let w = b.w; w < b.e - 1e-9; w += step) {
    out.push({ s: +s.toFixed(4), w: +w.toFixed(4), n: +Math.min(b.n, s + step).toFixed(4), e: +Math.min(b.e, w + step).toFixed(4) });
  }
  return out;
}
