import { defineConfig } from 'vite';

// `vite build --mode map` (npm run build:map) makes the map-only version in dist-map/: the data files are
// added there gzipped by scripts/build-map.mjs, so Vite does not copy public/.
export default defineConfig(({ mode }) => ({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  publicDir: mode === 'map' ? false : 'public',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, outDir: mode === 'map' ? 'dist-map' : 'dist', emptyOutDir: true },
}));
