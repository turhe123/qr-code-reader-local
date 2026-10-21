// parse.js — small hand-written parsers for common QR payloads (Wi-Fi, links, mailto, tel, SMS, vCard, MECARD).
// Pure functions, no DOM: app.js renders the result with textContent only.

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// Split "K:v;K:v;;" style payloads (WIFI:, MECARD:, MATMSG:) on unescaped separators.
function splitEscaped(body, sep = ';') {
  const parts = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) { cur += body[++i]; continue; }
    if (ch === sep) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function keyValues(body) {
  const out = [];
  for (const part of splitEscaped(body)) {
    const i = part.indexOf(':');
    if (i > 0) out.push([part.slice(0, i).toUpperCase(), part.slice(i + 1)]);
  }
  return out;
}

export function isBinary(text) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/.test(text);
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function parseWifi(text) {
  const kv = keyValues(text.slice(5));
  const get = (k) => (kv.find(([key]) => key === k) || [])[1];
  const t = (get('T') || '').toUpperCase();
  const security = !t || t === 'NOPASS' ? 'None (open network)' : t === 'WPA' ? 'WPA/WPA2/WPA3' : t;
  const fields = [['Network name', get('S') || '(not set)']];
  fields.push(['Security', security]);
  if (get('P')) fields.push(['Password', get('P'), { secret: true }]);
  if (get('H')) fields.push(['Hidden network', /^true$/i.test(get('H')) ? 'Yes' : 'No']);
  return { type: 'wifi', label: 'Wi-Fi network', fields };
}

function parseMailto(text) {
  const rest = text.slice(7);
  const q = rest.indexOf('?');
  const to = safeDecode(q === -1 ? rest : rest.slice(0, q));
  const params = new URLSearchParams(q === -1 ? '' : rest.slice(q + 1));
  const fields = [['To', to || '(not set)']];
  for (const [key, name] of [['cc', 'Cc'], ['bcc', 'Bcc'], ['subject', 'Subject'], ['body', 'Message']]) {
    const v = params.get(key);
    if (v) fields.push([name, v]);
  }
  return { type: 'email', label: 'Email', fields };
}

function parseMatmsg(text) {
  const kv = keyValues(text.slice(7));
  const names = { TO: 'To', SUB: 'Subject', BODY: 'Message' };
  return { type: 'email', label: 'Email', fields: kv.filter(([k]) => names[k]).map(([k, v]) => [names[k], v]) };
}

function parseSms(text) {
  const m = text.match(/^(?:smsto|sms|mmsto):([^:?]*)(?:[:?](?:body=)?([\s\S]*))?$/i);
  const fields = [['Number', safeDecode(m ? m[1] : '') || '(not set)']];
  if (m && m[2]) fields.push(['Message', safeDecode(m[2])]);
  return { type: 'sms', label: 'Text message (SMS)', fields };
}

const VCARD_NAMES = { FN: 'Name', ORG: 'Organization', TITLE: 'Title', TEL: 'Phone', EMAIL: 'Email', URL: 'Website', ADR: 'Address', NOTE: 'Note', BDAY: 'Birthday' };

function parseVcard(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const fields = [];
  let n = '';
  const unescape = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const prop = line.slice(0, i).split(';')[0].replace(/^[^.]*\./, '').toUpperCase();
    const value = line.slice(i + 1);
    if (prop === 'N') n = value.split(';').filter(Boolean).reverse().join(' ');
    else if (prop === 'ADR') fields.push(['Address', value.split(';').map(unescape).filter((p) => p.trim()).join(', ')]);
    else if (VCARD_NAMES[prop] && value.trim()) fields.push([VCARD_NAMES[prop], unescape(prop === 'ORG' ? value.replace(/;/g, ', ') : value)]);
  }
  if (n && !fields.some(([k]) => k === 'Name')) fields.unshift(['Name', unescape(n)]);
  return { type: 'contact', label: 'Contact card', fields, vcard: true };
}

function parseMecard(text) {
  const kv = keyValues(text.slice(7));
  const names = { N: 'Name', ORG: 'Organization', TEL: 'Phone', EMAIL: 'Email', URL: 'Website', ADR: 'Address', NOTE: 'Note', BDAY: 'Birthday' };
  const fields = kv.filter(([k]) => names[k]).map(([k, v]) => [names[k], k === 'N' ? v.split(',').reverse().join(' ').trim() : v]);
  return { type: 'contact', label: 'Contact card', fields };
}

// ---------- links ----------
const CYRILLIC_GREEK = /[\u0370-\u03FF\u0400-\u04FF]/;

export function analyzeUrl(raw) {
  const m = raw.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i);
  if (!m) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? '' : authority.slice(0, at + 1);
  const hostPort = authority.slice(at + 1);
  const portMatch = hostPort.match(/^(.*?)(:\d*)?$/);
  const hostRaw = portMatch[1];
  const port = portMatch[2] || '';
  const ascii = url.hostname;
  const warnings = [];
  if (/[^\x00-\x7F]/.test(hostRaw) || /(^|\.)xn--/i.test(ascii)) {
    warnings.push(`The domain uses non-Latin or special characters. Its real form is ${ascii}. Lookalike domains use this trick to imitate familiar sites.`);
  }
  if (/[a-z]/i.test(hostRaw) && CYRILLIC_GREEK.test(hostRaw)) {
    warnings.push('The domain mixes Latin letters with Cyrillic or Greek letters that look identical, a common phishing trick.');
  }
  if (userinfo) warnings.push(`The address contains "@". Everything before it is ignored, so the real destination is ${ascii}.`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ascii) || ascii.startsWith('[')) warnings.push('The link points to a raw IP address instead of a domain name.');
  const labels = ascii.split('.').slice(0, -1).join('.');
  if (/[a-z][01]|[01][a-z]/i.test(labels) && !/xn--/i.test(labels)) {
    warnings.push('The domain has digits next to letters (0 and o, 1 and l look alike). Check the spelling carefully.');
  }
  if (url.protocol === 'http:') warnings.push('The link uses http, not https, so the connection would not be encrypted.');
  return { url: url.href, scheme: url.protocol, parts: [scheme + userinfo, hostRaw, port + rest], host: ascii, warnings };
}

export function parsePayload(text) {
  const t = text.trim();
  if (/^WIFI:/i.test(t)) return parseWifi(t);
  if (/^https?:\/\//i.test(t)) {
    const link = analyzeUrl(t);
    if (link) {
      const fields = [['Domain', link.host]];
      return { type: 'link', label: 'Link', fields, link };
    }
  }
  if (/^mailto:/i.test(t)) return parseMailto(t);
  if (/^MATMSG:/i.test(t)) return parseMatmsg(t);
  if (/^tel:/i.test(t)) return { type: 'phone', label: 'Phone number', fields: [['Number', safeDecode(t.slice(4))]] };
  if (/^(smsto|sms|mmsto):/i.test(t)) return parseSms(t);
  if (/^BEGIN:VCARD/i.test(t)) return parseVcard(t);
  if (/^MECARD:/i.test(t)) return parseMecard(t);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { type: 'email', label: 'Email', fields: [['Address', t]] };
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(t)) {
    return { type: 'text', label: 'Plain text', fields: [['Note', 'This looks like an app link (' + t.split(':')[0] + '). It is shown as text only.']] };
  }
  return { type: 'text', label: 'Plain text', fields: [] };
}
