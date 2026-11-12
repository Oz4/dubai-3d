// The map-only version: the 3D map with its layers, time of day, the Burj Khalifa show and the hide-the-interface
// controls, without the real-estate features (developer and community filters, tower search, building cards,
// floors, units). Writes a static site to dist-map/ that any static host can serve.
//   node scripts/build-map.mjs
// The data files go in gzipped (<file>.gz; src/core/data.js unpacks them in the browser), which takes the whole
// city from about 95 MB to about 33 MB and keeps every file under 20 MB.
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { gzipSync, constants } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-map');
execSync('npx vite build --mode map', { cwd: root, stdio: 'inherit' });

const files = ['data/world.json', ...readdirSync(join(root, 'public/data/sections')).filter((f) => f.endsWith('.json')).map((f) => `data/sections/${f}`)];
let total = 0;
for (const f of files) {
  const src = join(root, 'public', f), dst = join(out, f + '.gz');
  mkdirSync(dirname(dst), { recursive: true });
  const gz = gzipSync(readFileSync(src), { level: constants.Z_BEST_COMPRESSION });
  writeFileSync(dst, gz); total += gz.length;
  console.log(`  ${f}.gz  ${(gz.length / 1e6).toFixed(1)} MB`);
}
mkdirSync(join(out, 'data'), { recursive: true });
copyFileSync(join(root, 'public/data/ndvi.png'), join(out, 'data/ndvi.png'));
total += statSync(join(out, 'data/ndvi.png')).size;
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const all = walk(out), size = all.reduce((s, f) => s + statSync(f).size, 0);
console.log(`dist-map: ${all.length} files, ${(size / 1e6).toFixed(1)} MB in all (data ${(total / 1e6).toFixed(1)} MB)`);
