"""Vegetation index (NDVI) for the map area from a recent, cloud-free Sentinel-2 L2A scene.

Reads only the needed window of the red (B04) and near-infrared (B08) 10 m bands straight from the
public Cloud-Optimised GeoTIFFs on AWS (Element 84 Earth Search STAC), then resamples NDVI onto the
app's local metre grid (same equirectangular projection as scripts/build-data.mjs).

Outputs
  data-raw/ndvi.bin + data-raw/ndvi.json   uint8 grid for the Node data pipeline (tree placement)
  public/data/ndvi.png                      the same grid as a greyscale image for the ground shader
  data-raw/s2-truecolor.png                 true-colour preview (reference only, not shipped)

Licence: Copernicus Sentinel data are free and open; credit "Contains modified Copernicus Sentinel
data 2026".  Usage:  python -I scripts/fetch-ndvi.py
"""
import json
import math
import os
import sys
import urllib.request

import numpy as np
import rasterio
from rasterio.warp import transform as warp_transform
from rasterio.windows import from_bounds
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = 5.0  # output metres per pixel (Sentinel-2 itself is 10 m; bilinear upsampling smooths edges)

# --- region and projection shared with scripts/config.mjs (built sections in scripts/sections.json)
with open(os.path.join(ROOT, "scripts", "sections.json"), encoding="utf-8") as fh:
    _cfg = json.load(fh)
_rects = [r for sec in _cfg["sections"] if sec.get("built") for r in sec["rects"]]
BBOX = dict(s=min(r["s"] for r in _rects), w=min(r["w"] for r in _rects), n=max(r["n"] for r in _rects), e=max(r["e"] for r in _rects))
lat0 = _cfg["origin"]["lat0"]
lon0 = _cfg["origin"]["lon0"]
phi = math.radians(lat0)
MLAT = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi) - 0.0023 * math.cos(6 * phi)
MLON = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi) + 0.118 * math.cos(5 * phi)
x0, x1 = (BBOX['w'] - lon0) * MLON, (BBOX['e'] - lon0) * MLON
y0, y1 = (BBOX['s'] - lat0) * MLAT, (BBOX['n'] - lat0) * MLAT


def search():
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": [BBOX['w'], BBOX['s'], BBOX['e'], BBOX['n']],
        "datetime": "2026-06-01T00:00:00Z/2026-12-31T00:00:00Z",
        "query": {"eo:cloud_cover": {"lt": 1}, "s2:nodata_pixel_percentage": {"lt": 1}},
        "limit": 20,
        "sortby": [{"field": "properties.datetime", "direction": "desc"}],
    }
    req = urllib.request.Request("https://earth-search.aws.element84.com/v1/search", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": "dubai-3d-data-pipeline"})
    feats = json.load(urllib.request.urlopen(req, timeout=60))["features"]
    if not feats:
        sys.exit("no cloud-free scene found")
    # most recent among the clearest few
    feats.sort(key=lambda f: (round(f["properties"]["eo:cloud_cover"], 1), f["properties"]["datetime"]), reverse=False)
    clear = [f for f in feats if f["properties"]["eo:cloud_cover"] < 0.1] or feats
    clear.sort(key=lambda f: f["properties"]["datetime"], reverse=True)
    return clear[0]


def read_band(href, bounds_utm):
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
        with rasterio.open(href) as src:
            win = from_bounds(*bounds_utm, transform=src.transform).round_offsets().round_lengths()
            arr = src.read(1, window=win).astype(np.float32)
            return arr, src.window_transform(win), src.crs


def main():
    f = search()
    p = f["properties"]
    print(f"scene {f['id']} {p['datetime'][:10]} cloud {p['eo:cloud_cover']:.3f}%")
    # bbox -> UTM bounds (padded)
    lons = [BBOX['w'], BBOX['e'], BBOX['w'], BBOX['e']]
    lats = [BBOX['s'], BBOX['s'], BBOX['n'], BBOX['n']]
    epsg = p.get("proj:code") or f"EPSG:{p.get('proj:epsg')}"
    ux, uy = warp_transform("EPSG:4326", epsg, lons, lats)
    pad = 60
    bounds = (min(ux) - pad, min(uy) - pad, max(ux) + pad, max(uy) + pad)
    bands = {}
    for key in ["red", "nir", "green", "blue"]:
        arr, tr, crs = read_band(f["assets"][key]["href"], bounds)
        # L2A digital numbers -> reflectance. Baseline >= 04.00 products carry a +1000 DN offset that
        # the metadata says to remove, but some archives already removed it (then dark water sits far
        # below 1000 DN): only subtract when the data really carries it.
        off, scale = 0.0, 1e-4
        for rb in f["assets"][key].get("raster:bands", []):
            off = rb.get("offset", 0.0) or 0.0
            scale = rb.get("scale", 1e-4) or 1e-4
        valid = arr[arr > 0]
        if valid.size and np.percentile(valid, 1) < 900:
            off = 0.0
        bands[key] = np.clip(arr * scale + off, 0, 1.5)
        print(f"  {key}: {arr.shape}")
    red, nir = bands["red"], bands["nir"]
    ndvi = (nir - red) / np.maximum(nir + red, 1e-4)

    # sample onto the local grid
    W = int(math.ceil((x1 - x0) / RES)); H = int(math.ceil((y1 - y0) / RES))
    gx = x0 + (np.arange(W) + 0.5) * RES
    gy = y1 - (np.arange(H) + 0.5) * RES  # image rows go north -> south
    X, Y = np.meshgrid(gx, gy)
    lon = lon0 + X / MLON
    lat = lat0 + Y / MLAT
    ex, ey = warp_transform("EPSG:4326", epsg, lon.ravel().tolist(), lat.ravel().tolist())
    inv = ~tr
    cols, rows = inv * (np.array(ex), np.array(ey))
    cols = cols.reshape(H, W) - 0.5
    rows = rows.reshape(H, W) - 0.5

    def bilinear(a):
        c0 = np.clip(np.floor(cols).astype(int), 0, a.shape[1] - 2)
        r0 = np.clip(np.floor(rows).astype(int), 0, a.shape[0] - 2)
        fc = np.clip(cols - c0, 0, 1); fr = np.clip(rows - r0, 0, 1)
        return (a[r0, c0] * (1 - fc) * (1 - fr) + a[r0, c0 + 1] * fc * (1 - fr) +
                a[r0 + 1, c0] * (1 - fc) * fr + a[r0 + 1, c0 + 1] * fc * fr)

    nd = bilinear(ndvi)
    # NDVI -0.1..0.8 -> 0..255 (sand ~0.05-0.1, irrigated lawns 0.35-0.6, dense trees/golf 0.6+)
    q = np.clip((nd + 0.1) / 0.9 * 255, 0, 255).astype(np.uint8)
    os.makedirs(os.path.join(ROOT, "public", "data"), exist_ok=True)
    Image.fromarray(q, "L").save(os.path.join(ROOT, "public", "data", "ndvi.png"), optimize=True)
    q.tofile(os.path.join(ROOT, "data-raw", "ndvi.bin"))
    meta = dict(scene=f["id"], date=p["datetime"][:10], cloud=p["eo:cloud_cover"], w=W, h=H, res=RES,
                x0=x0, y1=y1, encode="ndvi = v / 255 * 0.9 - 0.1", credit="Contains modified Copernicus Sentinel data 2026")
    with open(os.path.join(ROOT, "data-raw", "ndvi.json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    # true-colour reference
    rgb = np.dstack([bilinear(bands[k]) for k in ["red", "green", "blue"]])
    rgb = np.clip((rgb / 0.25) ** (1 / 1.6) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(os.path.join(ROOT, "data-raw", "s2-truecolor.png"))
    veg = (nd > 0.3).mean() * 100
    print(f"grid {W}x{H} @ {RES} m, vegetated (NDVI>0.3) {veg:.1f}% of area")


if __name__ == "__main__":
    main()
