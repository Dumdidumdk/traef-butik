'use strict';
// Lille zip-udpakker (kun indbygget Node). Håndterer stier med "\" (fra Compress-Archive) og lange stier,
// som PowerShells Expand-Archive har problemer med. Understøtter "stored" og "deflate" uden zip64.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function udpak(zipFil, maal) {
  const buf = fs.readFileSync(zipFil);

  // End of central directory: findes bagfra (efter den kan der stå en kommentar på op til 64 KB)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Filen er ikke en gyldig zip');
  const antal = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (antal === 0xffff || pos === 0xffffffff) throw new Error('Zip64 understøttes ikke');

  const rodAbs = path.resolve(maal);
  const filer = [];
  for (let n = 0; n < antal; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Ødelagt zip (central directory)');
    const flag = buf.readUInt16LE(pos + 8);
    const metode = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const kompStr = buf.readUInt32LE(pos + 20);
    const str = buf.readUInt32LE(pos + 24);
    const navnLgd = buf.readUInt16LE(pos + 28);
    const ekstraLgd = buf.readUInt16LE(pos + 30);
    const kommLgd = buf.readUInt16LE(pos + 32);
    const lokal = buf.readUInt32LE(pos + 42);
    const raaNavn = buf.subarray(pos + 46, pos + 46 + navnLgd).toString(flag & 0x800 ? 'utf8' : 'latin1');
    pos += 46 + navnLgd + ekstraLgd + kommLgd;
    if (kompStr === 0xffffffff || str === 0xffffffff || lokal === 0xffffffff) throw new Error('Zip64 understøttes ikke');
    if (flag & 0x1) throw new Error('Krypteret zip understøttes ikke');

    // Sti: "\" -> "/", ingen absolutte stier, drevbogstaver eller ".."
    const navn = raaNavn.replace(/\\/g, '/');
    const dele = navn.split('/').filter((d) => d !== '' && d !== '.');
    if (/^[a-z]:/i.test(navn) || navn.startsWith('/') || dele.includes('..')) throw new Error(`Ugyldig sti i zip: ${raaNavn}`);
    if (!dele.length) continue;
    const ud = path.join(rodAbs, ...dele);
    if (!ud.startsWith(rodAbs + path.sep)) throw new Error(`Ugyldig sti i zip: ${raaNavn}`);
    if (navn.endsWith('/')) {
      fs.mkdirSync(ud, { recursive: true });
      continue;
    }

    if (buf.readUInt32LE(lokal) !== 0x04034b50) throw new Error('Ødelagt zip (local header)');
    const start = lokal + 30 + buf.readUInt16LE(lokal + 26) + buf.readUInt16LE(lokal + 28);
    const komp = buf.subarray(start, start + kompStr);
    let data;
    if (metode === 0) data = komp;
    else if (metode === 8) data = zlib.inflateRawSync(komp);
    else throw new Error(`Ukendt komprimering (${metode}) i ${raaNavn}`);
    if (data.length !== str || (zlib.crc32(data) >>> 0) !== crc) throw new Error(`Fejl i ${raaNavn} (kontrolsum)`);

    fs.mkdirSync(path.dirname(ud), { recursive: true });
    fs.writeFileSync(ud, data);
    filer.push(dele.join('/'));
  }
  return filer;
}

module.exports = { udpak };
