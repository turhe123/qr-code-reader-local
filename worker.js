// worker.js — scans one image for QR codes off the main thread (classic worker).
// Strategy: full image, then rescaled, contrast-stretched and mirrored copies, then overlapping tiles at half
// and quarter size to catch small codes and several codes in one picture. Every distinct payload is returned
// with its corner points in the coordinates of the image that was sent.
importScripts('vendor/jsqr/jsQR.js');

const WORK_MAX = 1600;   // longest side used for whole-image passes
const TILE_MAX = 1200;   // longest side of a tile before it is shrunk
const TILE_MIN = 400;    // tiles smaller than this are enlarged 2x

function makeImage(width, height, data) { return { width, height, data }; }

// Area-average when shrinking, bilinear when enlarging. RGBA in, RGBA out.
function resize(src, dw, dh) {
  const { width: sw, height: sh, data: s } = src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  if (xr >= 1 && yr >= 1) {
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * yr), y1 = Math.max(y0 + 1, Math.floor((y + 1) * yr));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * xr), x1 = Math.max(x0 + 1, Math.floor((x + 1) * xr));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < sh; yy++) {
          let i = (yy * sw + x0) * 4;
          for (let xx = x0; xx < x1 && xx < sw; xx++, i += 4) { r += s[i]; g += s[i + 1]; b += s[i + 2]; n++; }
        }
        const o = (y * dw + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < dh; y++) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < dw; x++) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
        const o = (y * dw + x) * 4;
        for (let c = 0; c < 3; c++) {
          const a = s[(y0 * sw + x0) * 4 + c] * (1 - wx) + s[(y0 * sw + x1) * 4 + c] * wx;
          const b = s[(y1 * sw + x0) * 4 + c] * (1 - wx) + s[(y1 * sw + x1) * 4 + c] * wx;
          out[o + c] = a * (1 - wy) + b * wy;
        }
        out[o + 3] = 255;
      }
    }
  }
  return makeImage(dw, dh, out);
}

function crop(src, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    const start = ((y + r) * src.width + x) * 4;
    out.set(src.data.subarray(start, start + w * 4), r * w * 4);
  }
  return makeImage(w, h, out);
}

function mirror(src) {
  const { width: w, height: h, data } = src;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = (y * w + x) * 4, b = (y * w + (w - 1 - x)) * 4;
    out[b] = data[a]; out[b + 1] = data[a + 1]; out[b + 2] = data[a + 2]; out[b + 3] = 255;
  }
  return makeImage(w, h, out);
}

// Grayscale + stretch the 2nd..98th luminance percentiles to full range.
function stretch(src) {
  const { data } = src;
  const n = data.length / 4;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
    lum[i] = v; hist[v]++;
  }
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
  if (hi - lo < 8) { lo = 0; hi = 255; }
  const k = 255 / (hi - lo);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < n; i++) {
    const v = (lum[i] - lo) * k;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return makeImage(src.width, src.height, out);
}

// Copy of `src` with the bounding boxes of already-found codes painted white, to reveal the next code.
function maskOut(src, boxes) {
  const out = new Uint8ClampedArray(src.data);
  for (const b of boxes) {
    const pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.08;
    const x0 = Math.max(0, Math.floor(b.x0 - pad)), x1 = Math.min(src.width, Math.ceil(b.x1 + pad));
    const y0 = Math.max(0, Math.floor(b.y0 - pad)), y1 = Math.min(src.height, Math.ceil(b.y1 + pad));
    for (let y = y0; y < y1; y++) out.fill(255, (y * src.width + x0) * 4, (y * src.width + x1) * 4);
  }
  return makeImage(src.width, src.height, out);
}

function fitScale(w, h, max) { return Math.min(1, max / Math.max(w, h)); }

// Square tiles sized from the longer side, so wide screenshots still get tiles tall enough for a code.
function tileJobs(img, fraction) {
  const side = Math.round(Math.max(img.width, img.height) * fraction);
  const tw = Math.max(1, Math.min(img.width, side));
  const th = Math.max(1, Math.min(img.height, side));
  const xs = new Set(), ys = new Set();
  const stepX = tw / 2, stepY = th / 2;
  for (let x = 0; x + tw <= img.width + 1; x += stepX) xs.add(Math.min(img.width - tw, Math.round(x)));
  for (let y = 0; y + th <= img.height + 1; y += stepY) ys.add(Math.min(img.height - th, Math.round(y)));
  const jobs = [];
  for (const y of ys) for (const x of xs) jobs.push({ x, y, w: tw, h: th });
  return jobs;
}

function scan(img, post) {
  const found = [];
  const seen = new Set();
  const area = img.width * img.height;
  let coverage = 0;

  // Try one prepared image; `map` converts its coordinates back to the original image.
  const attempt = (im, map) => {
    const code = jsQR(im.data, im.width, im.height, { inversionAttempts: 'attemptBoth' });
    if (!code) return false;
    const key = code.data || code.binaryData.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    const L = code.location;
    const corners = [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner].map((p) => map(p.x, p.y));
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    coverage = Math.max(coverage, ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / area);
    found.push({ data: code.data, bytes: code.binaryData, version: code.version, corners });
    return true;
  };

  const s0 = fitScale(img.width, img.height, WORK_MAX);
  const work = s0 < 1 ? resize(img, Math.round(img.width * s0), Math.round(img.height * s0)) : img;
  const fromWork = (k) => (x, y) => ({ x: x / (s0 * k), y: y / (s0 * k) });

  const steps = [
    { label: 'Reading the whole image', run: () => attempt(work, fromWork(1)) },
    {
      label: 'Looking for more codes', when: () => found.length > 0,
      run: () => {
        // Hide every code found so far and rescan, until nothing new turns up.
        for (let i = 0; i < 12; i++) {
          const boxes = found.map(({ corners }) => {
            const xs = corners.map((p) => p.x * s0), ys = corners.map((p) => p.y * s0);
            return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
          });
          if (!attempt(maskOut(work, boxes), fromWork(1))) break;
        }
      },
    },
    {
      label: 'Trying a smaller copy', when: () => !found.length && Math.min(work.width, work.height) >= 300,
      run: () => attempt(resize(work, Math.round(work.width / 2), Math.round(work.height / 2)), fromWork(0.5)),
    },
    {
      label: 'Trying an enlarged copy', when: () => !found.length && Math.max(work.width, work.height) <= 800,
      run: () => attempt(resize(work, work.width * 2, work.height * 2), fromWork(2)),
    },
    { label: 'Boosting contrast', when: () => !found.length, run: () => attempt(stretch(work), fromWork(1)) },
    {
      label: 'Trying a mirrored copy', when: () => !found.length,
      run: () => attempt(mirror(work), (x, y) => ({ x: (work.width - x) / s0, y: y / s0 })),
    },
  ];

  const addTiles = (fraction, label, when) => {
    for (const t of tileJobs(img, fraction)) {
      steps.push({
        label, when,
        run: () => {
          let tile = crop(img, t.x, t.y, t.w, t.h);
          let k = fitScale(t.w, t.h, TILE_MAX);
          if (Math.max(t.w, t.h) < TILE_MIN) k = 2;
          if (k !== 1) tile = resize(tile, Math.max(1, Math.round(t.w * k)), Math.max(1, Math.round(t.h * k)));
          attempt(tile, (x, y) => ({ x: t.x + x / k, y: t.y + y / k }));
        },
      });
    }
  };
  // Half-size tiles look for more codes unless one code already fills most of the picture.
  addTiles(0.5, 'Looking for more codes in tiles', () => coverage < 0.3 && Math.min(img.width, img.height) >= 120);
  // Quarter-size tiles only when nothing was found yet (small codes in big photos).
  addTiles(0.25, 'Looking for small codes', () => !found.length && Math.min(img.width, img.height) >= 240);

  steps.forEach((step, i) => {
    if (!step.when || step.when()) step.run();
    post({ type: 'progress', done: i + 1, total: steps.length, label: step.label });
  });
  // Number codes in reading order: rows (quarters of the height), then left to right.
  const center = (c) => ({ x: c.reduce((a, p) => a + p.x, 0) / 4, y: c.reduce((a, p) => a + p.y, 0) / 4 });
  const band = img.height / 4;
  return found.sort((a, b) => {
    const ca = center(a.corners), cb = center(b.corners);
    return Math.floor(ca.y / band) - Math.floor(cb.y / band) || ca.x - cb.x;
  });
}

self.onmessage = (e) => {
  const { id, width, height, buffer } = e.data;
  try {
    const img = makeImage(width, height, new Uint8ClampedArray(buffer));
    let last = 0;
    const codes = scan(img, (msg) => {
      const now = Date.now();
      if (now - last > 60 || msg.done === msg.total) { last = now; self.postMessage({ id, ...msg }); }
    });
    self.postMessage({ id, type: 'done', codes });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
