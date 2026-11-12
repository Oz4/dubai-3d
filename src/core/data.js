// Loading the map's data files. The normal build serves them as plain JSON. The map-only build
// (`npm run build:map`, Vite mode "map") ships them gzipped as `<file>.gz`, so the whole city fits hosts with
// per-file and total size limits; they are unpacked here in the browser. A host that already decodes the gzip
// on the wire is handled too: the first two bytes say whether the body is still compressed.
export const MAP_ONLY = import.meta.env.MODE === 'map';

const url = (file) => `${import.meta.env.BASE_URL}${file}${MAP_ONLY ? '.gz' : ''}`;

// fetch a data file; resolves to a Response whose .json() / .blob() give the plain content
export async function fetchData(file) {
  const res = await fetch(url(file));
  if (!MAP_ONLY || !res.ok) return res;
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (head[0] === 0x1f && head[1] === 0x8b) return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Response(buf);
}

// an image among the data files (the vegetation index); loaded through a blob: URL, which every host allows
export async function loadDataImage(file) {
  try {
    const src = MAP_ONLY ? URL.createObjectURL(await (await fetch(`${import.meta.env.BASE_URL}${file}`)).blob()) : `${import.meta.env.BASE_URL}${file}`;
    return await new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = src; });
  } catch { return null; }
}
