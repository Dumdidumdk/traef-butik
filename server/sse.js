'use strict';
// Server-Sent Events: åbne forbindelser for kunder (pr. deltager) og butik (personale)

const kunder = new Map(); // deltager_id -> Set(res)
const butik = new Set();
let pingTimer = null;

function aabn(req, res) {
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 30000);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
}

const pakke = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function skriv(res, tekst) {
  if (!res.writableEnded && !res.destroyed) res.write(tekst);
}

function tilfoejKunde(deltagerId, req, res) {
  aabn(req, res);
  let s = kunder.get(deltagerId);
  if (!s) kunder.set(deltagerId, (s = new Set()));
  s.add(res);
  const ryd = () => {
    s.delete(res);
    if (s.size === 0 && kunder.get(deltagerId) === s) kunder.delete(deltagerId);
  };
  res.on('close', ryd);
  res.on('error', ryd);
}

function tilfoejButik(req, res, personaleId = null) {
  aabn(req, res);
  res.personaleId = personaleId;
  butik.add(res);
  const ryd = () => butik.delete(res);
  res.on('close', ryd);
  res.on('error', ryd);
}

function sendEn(res, event, data) {
  skriv(res, pakke(event, data));
}

function tilKunde(deltagerId, event, data) {
  const s = kunder.get(deltagerId);
  if (!s) return;
  const t = pakke(event, data);
  for (const res of s) skriv(res, t);
}

function tilAlleKunder(event, data) {
  const t = pakke(event, data);
  for (const s of kunder.values()) for (const res of s) skriv(res, t);
}

function tilButik(event, data) {
  const t = pakke(event, data);
  for (const res of butik) skriv(res, t);
}

// Luk butiksforbindelser for en spærret medarbejder
function lukPersonale(personaleId) {
  for (const res of [...butik]) {
    if (res.personaleId === personaleId) {
      butik.delete(res);
      res.end();
    }
  }
}

function startPing(ms = 20000) {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const s of kunder.values()) for (const res of s) skriv(res, ': ping\n\n');
    for (const res of butik) skriv(res, ': ping\n\n');
  }, ms);
  pingTimer.unref();
}

function lukAlle() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
  for (const s of kunder.values()) for (const res of s) res.end();
  for (const res of butik) res.end();
  kunder.clear();
  butik.clear();
}

function antal() {
  let k = 0;
  for (const s of kunder.values()) k += s.size;
  return { kunder: k, butik: butik.size };
}

module.exports = { tilfoejKunde, tilfoejButik, lukPersonale, sendEn, tilKunde, tilAlleKunder, tilButik, startPing, lukAlle, antal };
