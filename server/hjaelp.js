'use strict';
// Fælles hjælpefunktioner: fejl, JSON-svar, body, cookies og validering

const crypto = require('node:crypto');

class Fejl extends Error {
  constructor(status, kode, besked) {
    super(besked);
    this.status = status;
    this.kode = kode;
  }
}
const fejl = (status, kode, besked) => new Fejl(status, kode, besked);

const nu = () => new Date().toISOString();

function sendJson(res, status, data, headers = {}) {
  const krop = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(krop),
    ...headers,
  });
  res.end(krop);
}

function sendFejl(res, f) {
  sendJson(res, f.status, { fejl: f.message, kode: f.kode });
}

// Læs hele body som Buffer med en maksgrænse
function laesBody(req, maks, kode = 'for_stor', besked = 'Forespørgslen er for stor.') {
  return new Promise((resolve, reject) => {
    const laengde = Number(req.headers['content-length'] || 0);
    if (laengde > maks) {
      req.resume();
      return reject(fejl(413, kode, besked));
    }
    const dele = [];
    let str = 0;
    let faerdig = false;
    req.on('data', (d) => {
      if (faerdig) return;
      str += d.length;
      if (str > maks) {
        faerdig = true;
        req.resume();
        return reject(fejl(413, kode, besked));
      }
      dele.push(d);
    });
    req.on('end', () => { if (!faerdig) { faerdig = true; resolve(Buffer.concat(dele)); } });
    req.on('error', (e) => { if (!faerdig) { faerdig = true; reject(e); } });
  });
}

const JSON_MAKS = 64 * 1024;

async function laesJson(req) {
  const buf = await laesBody(req, JSON_MAKS);
  if (buf.length === 0) return {};
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    throw fejl(400, 'ugyldig_json', 'Forespørgslen kunne ikke læses (ugyldig JSON).');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw fejl(400, 'ugyldig_json', 'Forespørgslen skal være et JSON-objekt.');
  }
  return data;
}

function laesCookies(req) {
  const ud = {};
  const h = req.headers.cookie;
  if (!h) return ud;
  for (const del of h.split(';')) {
    const i = del.indexOf('=');
    if (i < 0) continue;
    const navn = del.slice(0, i).trim();
    const vaerdi = del.slice(i + 1).trim();
    if (navn && !(navn in ud)) ud[navn] = vaerdi;
  }
  return ud;
}

const COOKIE_ALDER = 30 * 24 * 3600;
const saetCookie = (navn, token) =>
  `${navn}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_ALDER}`;
const sletCookie = (navn) => `${navn}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// --- Validering ---

// Heltal (accepterer også heltal som streng, fx fra inputfelter)
function heltal(v, min, max, kode, besked) {
  if (typeof v === 'string' && /^\s*-?\d{1,15}\s*$/.test(v)) v = Number(v);
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
    throw fejl(400, kode, besked);
  }
  return v;
}

// Tekst: trimmes, kontroltegn fjernes, længde tjekkes
function tekst(v, min, max, kode, besked) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw fejl(400, kode, besked);
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (v.length < min || v.length > max) throw fejl(400, kode, besked);
  return v;
}

function bool(v, kode, besked) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  throw fejl(400, kode, besked);
}

// --- Hashing (scrypt med salt) ---

function hash(hemmelig) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(hemmelig), salt, 32, (err, h) => (err ? reject(err) : resolve({ salt, hash: h.toString('hex') })));
  });
}

function tjekHash(hemmelig, salt, forventet) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(hemmelig), salt, 32, (err, h) => {
      if (err) return reject(err);
      const f = Buffer.from(forventet, 'hex');
      resolve(f.length === h.length && crypto.timingSafeEqual(f, h));
    });
  });
}

const nytToken = () => crypto.randomBytes(32).toString('hex');

module.exports = {
  Fejl, fejl, nu, sendJson, sendFejl, laesBody, laesJson, laesCookies,
  saetCookie, sletCookie, heltal, tekst, bool, hash, tjekHash, nytToken,
};
