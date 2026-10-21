// make-fixtures.js — generates the small, fictional QR fixtures used by __demo and smoke.spec.js.
// Run with `node tests/make-fixtures.js`. Contains a minimal QR encoder (byte mode, EC level M, versions 1–10)
// and a grayscale PNG writer, so no third-party package is needed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- Reed–Solomon over GF(256) ----------
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function rsEncode(data, n) {
  const gen = rsGenerator(n);
  const res = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) {
    const c = res[i];
    if (c) for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], c);
  }
  return res.slice(data.length);
}

// EC level M: [ecPerBlock, [blocks, dataPerBlock], [blocks, dataPerBlock]?]
const BLOCKS_M = [null, [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]],
  [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

function dataCapacity(v) { const [, a, b] = BLOCKS_M[v]; return a[0] * a[1] + (b ? b[0] * b[1] : 0); }

function encode(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  let v = 1;
  while (v <= 10 && dataCapacity(v) * 8 < 4 + (v < 10 ? 8 : 16) + bytes.length * 8) v++;
  if (v > 10) throw new Error('text too long for this tiny encoder');
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  put(0b0100, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  const cap = dataCapacity(v) * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < cap / 8; pad++) data.push(pad % 2 ? 0x11 : 0xec);

  // split into blocks, add EC, interleave
  const [ecLen, ...groups] = BLOCKS_M[v];
  const blocks = []; let off = 0;
  for (const [count, size] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(off, off + size)); off += size; }
  const ecs = blocks.map((b) => rsEncode(b, ecLen));
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) blocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
  for (let i = 0; i < ecLen; i++) ecs.forEach((e) => out.push(e[i]));
  return { v, codewords: out };
}

function buildMatrix(text, mask = 0) {
  const { v, codewords } = encode(text);
  const size = 17 + 4 * v;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, val) => { m[r][c] = val; fn[r][c] = true; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, dark ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 ? 0 : 1); set(i, 6, i % 2 ? 0 : 1); }
  const al = ALIGN[v];
  for (const r of al) for (const c of al) {
    if (fn[r][c]) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
    }
  }
  set(size - 8, 8, 1); // dark module
  // reserve format areas
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, 0); if (!fn[i][8]) set(i, 8, 0); }
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, 0); if (!fn[size - 1 - i][8]) set(size - 1 - i, 8, 0); }
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const vbits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (vbits >> i) & 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }

  // place data
  const bits = [];
  codewords.forEach((cw) => { for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1); });
  for (let i = 0; i < REMAINDER[v]; i++) bits.push(0);
  const maskFn = [(r, c) => (r + c) % 2 === 0][mask];
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        let bit = k < bits.length ? bits[k] : 0; k++;
        if (maskFn(r, c)) bit ^= 1;
        m[r][c] = bit;
      }
    }
  }

  // format info: EC level M = 0b00
  const fdata = (0b00 << 3) | mask;
  let rem = fdata;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const fbits = ((fdata << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) m[i][8] = (fbits >> i) & 1;
  m[7][8] = (fbits >> 6) & 1; m[8][8] = (fbits >> 7) & 1; m[8][7] = (fbits >> 8) & 1;
  for (let i = 9; i < 15; i++) m[8][14 - i] = (fbits >> i) & 1;
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = (fbits >> i) & 1;
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = (fbits >> i) & 1;
  m[size - 8][8] = 1;
  return m;
}

// ---------- tiny raster + PNG writer ----------
function canvas(w, h, bg = 255) { return { w, h, px: new Uint8Array(w * h).fill(bg) }; }
function fillRect(cv, x, y, w, h, val) {
  for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) if (r >= 0 && c >= 0 && r < cv.h && c < cv.w) cv.px[r * cv.w + c] = val;
}
function drawQR(cv, text, x, y, scale, { dark = 20, light = 255 } = {}) {
  const m = buildMatrix(text);
  const quiet = 4, n = m.length;
  fillRect(cv, x, y, (n + quiet * 2) * scale, (n + quiet * 2) * scale, light);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) fillRect(cv, x + (c + quiet) * scale, y + (r + quiet) * scale, scale, scale, dark);
  return (n + quiet * 2) * scale;
}
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(cv) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(cv.w, 0); ihdr.writeUInt32BE(cv.h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((cv.w + 1) * cv.h);
  for (let y = 0; y < cv.h; y++) { raw[y * (cv.w + 1)] = 0; Buffer.from(cv.px.buffer, y * cv.w, cv.w).copy(raw, y * (cv.w + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- fixtures (all fictional) ----------
const MENU = 'https://menu.example.org/copper-spoon-bistro/dinner';
const WIFI = 'WIFI:T:WPA;S:LanternGuest;P:paper-lantern-42;;';
const out = (name, cv) => { fs.writeFileSync(path.join(__dirname, 'fixtures', name), png(cv)); console.log('wrote', name); };

{ const cv = canvas(330, 330); drawQR(cv, MENU, 5, 5, 8); out('sample-qr.png', cv); }
{ const cv = canvas(330, 330); drawQR(cv, WIFI, 5, 5, 8); out('sample-wifi.png', cv); }
{
  // a "screenshot" with two codes side by side and some fake UI bars around them
  const cv = canvas(900, 420, 240);
  fillRect(cv, 0, 0, 900, 40, 70);
  fillRect(cv, 40, 380, 820, 12, 200);
  drawQR(cv, MENU, 60, 60, 7);
  drawQR(cv, WIFI, 520, 60, 7);
  out('sample-two-codes.png', cv);
}

if (require.main === module && process.argv.includes('--verify')) {
  const jsQR = require('../vendor/jsqr/jsQR.js');
  for (const name of ['sample-qr.png', 'sample-wifi.png']) {
    const cv = canvas(330, 330); drawQR(cv, name.includes('wifi') ? WIFI : MENU, 5, 5, 8);
    const rgba = new Uint8ClampedArray(cv.w * cv.h * 4);
    cv.px.forEach((v, i) => { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; });
    const res = jsQR(rgba, cv.w, cv.h);
    console.log(name, '->', res && res.data);
  }
}

module.exports = { buildMatrix };
