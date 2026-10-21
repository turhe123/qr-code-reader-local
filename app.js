// app.js — QR Code Reader from Image. Everything runs on this device: images are decoded in a Web Worker
// (worker.js, jsQR from vendor/), camera frames on the main thread. Decoded text is only ever inserted with
// textContent, links are never opened without an explicit confirm, and no history is stored.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';
import { parsePayload, isBinary, toHex } from './parse.js';

const $ = (id) => document.getElementById(id);
const zone = $('dropzone');
const input = $('file-input');
const results = $('results');
const progressWrap = $('progress');
const progressBar = progressWrap.querySelector('.progress');
const progressLabel = $('progress-label');

const MAX_PIXELS = 12_000_000;
const PREVIEW_MAX = 1400;
const IMAGE_EXT = /\.(png|jpe?g|jfif|webp|gif|bmp|avif|svg|ico)$/i;
const HEIC = /\.(heic|heif)$/i;

// ---------- small DOM helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(label, className = 'btn btn--small', type = 'button') {
  const b = el('button', className, label);
  b.type = type;
  return b;
}
function showError(title, tips) {
  const box = el('div', 'alert alert--error');
  box.setAttribute('role', 'alert');
  box.append(el('strong', null, title));
  if (tips && tips.length) {
    const ul = el('ul', 'qr-tips');
    tips.forEach((t) => ul.append(el('li', null, t)));
    box.append(ul);
  }
  results.append(box);
  return box;
}
function setProgress(done, total, label) {
  const pct = total ? Math.floor((done / total) * 100) : 0;
  progressWrap.hidden = false;
  progressBar.firstElementChild.style.width = `${pct}%`;
  progressBar.setAttribute('aria-valuenow', String(pct));
  progressLabel.textContent = `${label}… ${pct}%`;
}
function hideProgress() { progressWrap.hidden = true; }

// ---------- copy ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea');
    ta.value = text;
    ta.setAttribute('aria-hidden', 'true');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------- worker ----------
let worker = null;
let jobSeq = 0;
const jobs = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker('./worker.js');
  worker.onmessage = (e) => {
    const job = jobs.get(e.data.id);
    if (!job) return;
    if (e.data.type === 'progress') job.onProgress(e.data);
    else {
      jobs.delete(e.data.id);
      if (e.data.type === 'done') job.resolve(e.data.codes);
      else job.reject(new Error(e.data.message));
    }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    jobs.forEach((job) => job.reject(new Error('The scanner could not start in this browser.')));
    jobs.clear();
    worker = null;
  };
  return worker;
}
function scanInWorker(imageData, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    jobs.set(id, { resolve, reject, onProgress });
    const { width, height, data } = imageData;
    getWorker().postMessage({ id, width, height, buffer: data.buffer }, [data.buffer]);
  });
}

// ---------- image loading ----------
async function decodeToBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // SVG and some older browsers: fall back to an <img> decoded from a local object URL.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) throw new Error('empty');
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// Returns a canvas with the image (downscaled to 12 MP at most) and its pixel data.
async function loadImage(file) {
  const src = await decodeToBitmap(file);
  const ow = src.width, oh = src.height;
  const k = ow * oh > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (ow * oh)) : 1;
  const w = Math.max(1, Math.round(ow * k)), h = Math.max(1, Math.round(oh * k));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; // transparent PNGs: QR codes are dark on light
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  return { canvas, imageData: ctx.getImageData(0, 0, w, h), originalSize: [ow, oh], downscaled: k < 1 };
}

// ---------- rendering ----------
function drawPreview(sourceCanvas, codes) {
  const k = Math.min(1, PREVIEW_MAX / Math.max(sourceCanvas.width, sourceCanvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(sourceCanvas.width * k);
  c.height = Math.round(sourceCanvas.height * k);
  c.className = 'qr-preview__canvas';
  const ctx = c.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0, c.width, c.height);
  const lw = Math.max(3, Math.round(Math.max(c.width, c.height) / 160));
  codes.forEach((code, i) => {
    const pts = code.corners.map((p) => ({ x: p.x * k, y: p.y * k }));
    ctx.beginPath();
    pts.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = lw;
    ctx.strokeStyle = '#ff2d6f';
    ctx.fillStyle = 'rgba(255, 45, 111, 0.12)';
    ctx.fill();
    ctx.stroke();
    if (codes.length > 1) {
      const r = lw * 4;
      const { x, y } = pts[0];
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#ff2d6f'; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1);
    }
  });
  const label = codes.length === 1 ? 'Image with the detected QR code outlined' : `Image with ${codes.length} detected QR codes outlined and numbered`;
  c.setAttribute('role', 'img');
  c.setAttribute('aria-label', label);
  return c;
}

function fieldsTable(fields) {
  const wrap = el('div', 'table-wrap qr-fields');
  const table = el('table');
  const tbody = el('tbody');
  for (const [name, value, opts] of fields) {
    const tr = el('tr');
    const th = el('th', null, name);
    th.scope = 'row';
    tr.append(th);
    const td = el('td');
    if (opts && opts.secret) {
      const val = el('span', 'qr-secret mono', '•'.repeat(Math.min(12, value.length || 8)));
      const toggle = button('Show', 'btn btn--small btn--ghost qr-reveal');
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', `Show ${name.toLowerCase()}`);
      toggle.addEventListener('click', () => {
        const show = toggle.getAttribute('aria-pressed') !== 'true';
        toggle.setAttribute('aria-pressed', String(show));
        toggle.textContent = show ? 'Hide' : 'Show';
        toggle.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${name.toLowerCase()}`);
        val.textContent = show ? value : '•'.repeat(Math.min(12, value.length || 8));
      });
      const copy = button('Copy', 'btn btn--small btn--ghost');
      copy.setAttribute('aria-label', `Copy ${name.toLowerCase()}`);
      copy.addEventListener('click', async () => toast((await copyText(value)) ? `${name} copied` : 'Copy failed, select the text instead'));
      const row = el('div', 'qr-secret-row');
      row.append(val, toggle, copy);
      td.append(row);
    } else {
      td.textContent = value;
    }
    tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

function linkBlock(link) {
  const box = el('div', 'qr-link');
  const line = el('p', 'qr-link__url mono');
  const [before, host, after] = link.parts;
  line.append(el('span', 'qr-link__muted', before), el('mark', 'qr-link__host', host), el('span', 'qr-link__muted', after));
  box.append(el('p', 'qr-link__label', 'Opens the site:'), line);
  if (link.warnings.length) {
    const warn = el('div', 'qr-warning');
    warn.setAttribute('role', 'note');
    warn.append(el('strong', null, 'Check before opening'));
    const ul = el('ul');
    link.warnings.forEach((w) => ul.append(el('li', null, w)));
    warn.append(ul);
    box.append(warn);
  }
  return box;
}

function baseName(name) { return (name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'image'; }

function codeCard(code, index, total, sourceName) {
  const card = el('article', 'qr-card');
  card.setAttribute('aria-label', total > 1 ? `QR code ${index + 1} of ${total}` : 'Decoded QR code');
  const text = code.data;
  const binary = !text || isBinary(text);
  const info = binary ? { type: 'binary', label: 'Binary data', fields: [['Size', formatBytes(code.bytes.length)]] } : parsePayload(text);

  const head = el('div', 'qr-card__head');
  if (total > 1) head.append(el('span', 'qr-card__num', String(index + 1)));
  head.append(el('span', 'chip qr-card__type', info.label));
  head.append(el('span', 'qr-card__meta', `QR version ${code.version}`));
  card.append(head);

  const shown = binary ? toHex(code.bytes) : text;
  card.append(el('p', 'qr-card__label', binary ? 'Raw bytes (hex):' : 'Decoded text, exactly as stored in the code:'));
  const pre = el('pre', 'code qr-text', shown);
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'Decoded text');
  card.append(pre);

  if (info.link) card.append(linkBlock(info.link));
  if (info.fields.length) card.append(fieldsTable(info.fields));

  const actions = el('div', 'row qr-card__actions');
  const copy = button('Copy text', 'btn btn--primary qr-copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(shown);
    copy.textContent = ok ? 'Copied' : 'Copy failed';
    toast(ok ? 'Decoded text copied to the clipboard' : 'Copy failed, select the text and copy it instead');
    setTimeout(() => { copy.textContent = 'Copy text'; }, 1600);
  });
  actions.append(copy);

  const stem = `${baseName(sourceName)}-qr${total > 1 ? `-${index + 1}` : ''}`;
  if (info.vcard) {
    const vcf = button('Save contact (.vcf)', 'btn qr-save');
    vcf.addEventListener('click', () => downloadBlob(new Blob([text], { type: 'text/vcard' }), `${stem}.vcf`));
    actions.append(vcf);
  }
  const save = button('Save text (.txt)', 'btn qr-save-txt');
  save.addEventListener('click', () => downloadBlob(new Blob([shown], { type: 'text/plain;charset=utf-8' }), `${stem}.txt`));
  actions.append(save);

  if (info.link) {
    const open = button('Open link…', 'btn qr-open');
    const confirmBox = el('div', 'qr-confirm');
    confirmBox.hidden = true;
    confirmBox.setAttribute('role', 'group');
    confirmBox.setAttribute('aria-label', 'Confirm opening the link');
    const q = el('p', null, `Open ${info.link.host} in a new tab? Only continue if you trust this site.`);
    const yes = button('Yes, open in new tab', 'btn btn--small btn--primary qr-open-confirm');
    const no = button('Cancel', 'btn btn--small');
    const row = el('div', 'row');
    row.append(yes, no);
    confirmBox.append(q, row);
    open.setAttribute('aria-expanded', 'false');
    open.addEventListener('click', () => {
      confirmBox.hidden = false;
      open.setAttribute('aria-expanded', 'true');
      yes.focus();
    });
    no.addEventListener('click', () => { confirmBox.hidden = true; open.setAttribute('aria-expanded', 'false'); open.focus(); });
    yes.addEventListener('click', () => {
      window.open(info.link.url, '_blank', 'noopener,noreferrer');
      confirmBox.hidden = true;
      open.setAttribute('aria-expanded', 'false');
    });
    actions.append(open);
    card.append(actions, confirmBox);
  } else {
    card.append(actions);
  }
  return card;
}

function renderItem({ name, sizeText, canvas, codes, note, showName }) {
  const item = el('section', 'qr-item result');
  item.setAttribute('aria-label', `Results for ${name}`);
  const preview = el('figure', 'qr-item__preview');
  const frame = el('div', 'preview');
  frame.append(drawPreview(canvas, codes));
  preview.append(frame);
  const cap = el('figcaption', 'qr-item__caption');
  cap.textContent = `${showName ? `${name} · ` : ''}${sizeText}${codes.length > 1 ? ` · ${codes.length} codes found` : ''}`;
  preview.append(cap);
  if (note) preview.append(el('p', 'qr-item__note', note));
  const list = el('div', 'qr-item__codes');
  codes.forEach((code, i) => list.append(codeCard(code, i, codes.length, name)));
  item.append(preview, list);
  results.append(item);
  return item;
}

const NO_CODE_TIPS = [
  'Crop closer so the code fills more of the picture, including all three corner squares.',
  'Increase the contrast or brightness, and avoid glare and reflections on the code.',
  'Use a sharper photo, held straight on rather than at a steep angle.',
  'Only QR codes are supported, not product barcodes, Data Matrix or Aztec codes.',
];

// ---------- main flow ----------
let busy = false;
async function handleFiles(files, origin = 'file') {
  if (busy) { toast('Still scanning the previous image'); return; }
  stopCamera();
  results.replaceChildren();
  const valid = [], rejected = [];
  for (const file of files) {
    if (HEIC.test(file.name) || /image\/hei[cf]/i.test(file.type)) rejected.push([file, 'HEIC/HEIF photos are not supported yet. Convert it to JPG or PNG first (or on iPhone share it as JPG, or set Camera > Formats > Most Compatible).']);
    else if (/^image\//.test(file.type) || IMAGE_EXT.test(file.name)) valid.push(file);
    else rejected.push([file, 'This is not an image. Use a PNG, JPG, WebP, GIF, BMP or SVG screenshot or photo.']);
  }
  if (rejected.length) {
    const box = showError(rejected.length === 1 ? `Skipped 1 file` : `Skipped ${rejected.length} files`);
    const ul = el('ul', 'qr-tips');
    rejected.forEach(([f, why]) => ul.append(el('li', null, `${f.name || 'Pasted item'}: ${why}`)));
    box.append(ul);
  }
  busy = true;
  let first = null;
  try {
    for (const file of valid) {
      const name = file.name || (origin === 'paste' ? 'pasted-image.png' : 'image');
      try {
        setProgress(0, 1, `Reading ${name}`);
        const { canvas, imageData, originalSize, downscaled } = await loadImage(file);
        const codes = await scanInWorker(imageData, (p) => setProgress(p.done, p.total, p.label));
        const sizeText = `${originalSize[0]}×${originalSize[1]} px · ${formatBytes(file.size)}`;
        if (!codes.length) {
          const box = showError(`No QR code found${valid.length > 1 || origin === 'file' ? ` in ${name}` : ''}.`, NO_CODE_TIPS);
          first = first || box;
          continue;
        }
        const note = downscaled ? `Large photo: scanned at ${canvas.width}×${canvas.height} px to save memory.` : '';
        const item = renderItem({ name, sizeText, canvas, codes, note, showName: valid.length > 1 || origin !== 'paste' });
        first = first || item;
      } catch (err) {
        const box = showError(`Could not read ${name}.`, [err && err.message && !/decode|source image/i.test(err.message) ? err.message : 'The file may be damaged or in a format this browser cannot open. Try saving it as PNG or JPG.']);
        first = first || box;
      }
    }
  } finally {
    busy = false;
    hideProgress();
  }
  const firstCard = results.querySelector('.qr-card') || first;
  if (firstCard) firstCard.scrollIntoView({ block: 'nearest' });
  const count = results.querySelectorAll('.qr-card').length;
  if (count) toast(`${count} QR code${count > 1 ? 's' : ''} decoded on this device`);
}

wireDropzone(zone, input, (files) => handleFiles(files, 'file'));
$('choose-btn').addEventListener('click', () => input.click());

// ---------- paste ----------
function imagesFromClipboard(dt) {
  const files = [];
  for (const item of dt?.items || []) {
    if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); }
  }
  if (!files.length) for (const f of dt?.files || []) files.push(f);
  return files;
}
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  const files = imagesFromClipboard(e.clipboardData);
  if (files.length) {
    e.preventDefault();
    handleFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-image${i ? `-${i + 1}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))), 'paste');
  } else {
    toast('The clipboard has no image. Copy the image itself (right-click → Copy image), then paste.', 3600);
  }
});
$('paste-btn').addEventListener('click', async () => {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    toast('Press Ctrl+V (⌘+V on Mac) to paste an image here', 3200);
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) files.push(new File([await item.getType(type)], `pasted-image.${type.split('/')[1].replace('jpeg', 'jpg')}`, { type }));
    }
    if (files.length) handleFiles(files, 'paste');
    else toast('The clipboard has no image. Copy the image itself, then try again.', 3200);
  } catch {
    toast('Clipboard access was blocked. Press Ctrl+V (⌘+V on Mac) instead.', 3200);
  }
});

// ---------- camera ----------
const cameraBox = $('camera');
const video = $('camera-video');
const cameraStatus = $('camera-status');
const cameraBtn = $('camera-btn');
let stream = null;
let rafId = 0;
const frameCanvas = document.createElement('canvas');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

function stopCamera() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  cameraBox.hidden = true;
  cameraBtn.setAttribute('aria-expanded', 'false');
}

function cameraError(err) {
  stopCamera();
  results.replaceChildren();
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    showError('Camera permission was denied.', ['Allow camera access in your browser’s site settings and press Use camera again.', 'Or take a photo or screenshot of the code and drop it here instead.']);
  } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    showError('No camera was found on this device.', ['Drop, choose or paste an image of the QR code instead.']);
  } else if (name === 'NotReadableError') {
    showError('The camera is busy in another app.', ['Close other apps or tabs using the camera and try again.']);
  } else {
    showError('The camera could not be started.', [String((err && err.message) || err)]);
  }
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    results.replaceChildren();
    showError('The camera is not available on this page.', ['Camera access needs a secure (https) page and a browser that supports it.', 'You can still drop, choose or paste an image of the code.']);
    return;
  }
  if (typeof jsQR !== 'function') { showError('The scanner did not load. Reload the page and try again.'); return; }
  stopCamera();
  results.replaceChildren();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (err) {
    cameraError(err);
    return;
  }
  cameraBox.hidden = false;
  cameraBtn.setAttribute('aria-expanded', 'true');
  cameraStatus.textContent = 'Point the camera at a QR code.';
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay is allowed for muted video after a click */ }
  cameraBox.scrollIntoView({ block: 'nearest' });
  let last = 0;
  const tick = (now) => {
    if (!stream) return;
    rafId = requestAnimationFrame(tick);
    if (now - last < 100 || video.readyState < 2 || !video.videoWidth) return; // about 10 frames per second
    last = now;
    const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
    if (frameCanvas.width !== w) frameCanvas.width = w;
    if (frameCanvas.height !== h) frameCanvas.height = h;
    frameCtx.drawImage(video, 0, 0, w, h);
    const frame = frameCtx.getImageData(0, 0, w, h);
    const code = jsQR(frame.data, w, h, { inversionAttempts: 'attemptBoth' });
    if (!code) return;
    const L = code.location;
    const snapshot = document.createElement('canvas');
    snapshot.width = w; snapshot.height = h;
    snapshot.getContext('2d').drawImage(frameCanvas, 0, 0);
    stopCamera();
    results.replaceChildren();
    const corners = [L.topLeftCorner, L.topRightCorner, L.bottomRightCorner, L.bottomLeftCorner];
    const item = renderItem({ name: 'camera-scan', sizeText: 'Camera snapshot', canvas: snapshot, codes: [{ data: code.data, bytes: code.binaryData, version: code.version, corners }], showName: false });
    item.querySelector('.qr-card').scrollIntoView({ block: 'nearest' });
    toast('QR code read, camera stopped');
  };
  rafId = requestAnimationFrame(tick);
}

cameraBtn.setAttribute('aria-expanded', 'false');
cameraBtn.addEventListener('click', () => (stream ? stopCamera() : startCamera()));
$('camera-stop').addEventListener('click', () => { stopCamera(); cameraBtn.focus(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { stopCamera(); toast('Camera stopped while the page was hidden'); } });
window.addEventListener('pagehide', stopCamera);

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample-two-codes.png');
  const blob = await res.blob();
  await handleFiles([new File([blob], 'bistro-table-card.png', { type: 'image/png' })], 'file');
};

export { handleFiles };
