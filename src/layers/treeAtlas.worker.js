// Paints the tree impostor atlas off the main thread (see treeAtlas.js).
import { buildTreeAtlas } from './treeAtlas.js';

self.onmessage = () => {
  const a = buildTreeAtlas();
  self.postMessage(a, [a.albedo.buffer, a.normal.buffer, a.cells.buffer]);
};
