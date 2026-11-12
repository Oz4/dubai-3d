// Quality presets: one choice that sets render resolution, depth shading, night glow, shadow resolution and how
// often shadows are redrawn, how far each kind of detail streams in around the view, tree density, traffic, and
// whether trees and people cast shadows. "Auto" starts at High and steps down if the device struggles.
export const PRESETS = {
  low: {
    label: 'Low', hint: 'Fastest: lower resolution, no depth shading, fewer trees and cars, detail only close by.',
    pixelRatio: (dpr) => Math.min(dpr, 1) * 0.8, ao: false, glow: false, shadowSize: 2048, shadowHz: 6,
    grass: 0.3, treeDensity: 0.5, treeShadows: false, peopleShadows: false, traffic: 0.35,
    reach: { buildings: 1500, trees: 2500, details: 900, people: 700 },
  },
  medium: {
    label: 'Medium', hint: 'Balanced: standard resolution, softer shadows, most trees, detail within about 2.5 km.',
    pixelRatio: (dpr) => Math.min(dpr, 1), ao: true, glow: true, shadowSize: 2048, shadowHz: 12,
    grass: 0.6, treeDensity: 0.75, treeShadows: true, peopleShadows: false, traffic: 0.65,
    reach: { buildings: 2500, trees: 4500, details: 1400, people: 1000 },
  },
  high: {
    label: 'High', hint: 'Sharp: high resolution, crisp shadows, every tree, detail within about 4 km.',
    pixelRatio: (dpr) => Math.min(dpr, 1.5), ao: true, glow: true, shadowSize: 4096, shadowHz: 24,
    grass: 0.85, treeDensity: 1, treeShadows: true, peopleShadows: true, traffic: 1,
    reach: { buildings: 4000, trees: 7000, details: 2000, people: 1400 },
  },
  ultra: {
    label: 'Ultra', hint: 'Everything: full display resolution, shadows every frame, detail across the whole map.',
    pixelRatio: (dpr) => Math.min(dpr, 2), ao: true, glow: true, shadowSize: 4096, shadowHz: 0,
    grass: 1, treeDensity: 1, treeShadows: true, peopleShadows: true, traffic: 1,
    reach: { buildings: 9000, trees: 16000, details: 3000, people: 2000 },
  },
};
export const ORDER = ['low', 'medium', 'high', 'ultra'];
