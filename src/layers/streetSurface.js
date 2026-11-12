// Street surfaces shared by the road ribbons (roads.js) and the kerb strips (streets.js), so the asphalt or pavers
// filling a junction's rounded corners match the carriageway exactly. Both shaders sample it at the world position
// and need GLSL_NOISE (vnoise, hash12). style 1: light grey asphalt (Sidra 1/2, the Vistas, the estate roads);
// style 2: grey interlocking concrete pavers (Maple, Sidra 3). Returns a linear colour.
export const STREET_SURFACE = /* glsl */ `
  vec3 streetSurface(vec2 wq, float style, float fine) {
    if (style < 1.5) return vec3(0.33, 0.332, 0.338) * (0.9 + 0.12 * vnoise(wq * 0.7) + 0.05 * vnoise(wq * 0.05));
    vec2 g = wq / 0.2; vec2 f = fract(g);
    float j = smoothstep(0.0, 0.07, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    return vec3(0.36, 0.378, 0.394) * (0.93 + 0.1 * hash12(floor(g))) * mix(1.0, 0.86 + 0.14 * j, fine) * (0.96 + 0.06 * vnoise(wq * 0.3));
  }`;
