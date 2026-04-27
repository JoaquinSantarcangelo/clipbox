const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');

const PORT = process.env.PORT || 3377;
const DATA_DIR = path.join(__dirname, 'data');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_CLIPS = 100;
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15MB (base64 overhead for 10MB files)
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB

// --- MIME Map ---

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

function getMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// --- Data Layer ---

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function readClips() {
  if (!fs.existsSync(CLIPS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CLIPS_FILE, 'utf-8')); }
  catch { return []; }
}

function writeClips(clips) {
  fs.writeFileSync(CLIPS_FILE, JSON.stringify(clips, null, 2));
}

function deleteUploadFile(clip) {
  if (!clip.file || !clip.file.stored) return;
  const filePath = path.join(UPLOADS_DIR, clip.file.stored);
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}

function pruneClips(clips) {
  while (clips.length > MAX_CLIPS) {
    let idx = -1;
    for (let i = clips.length - 1; i >= 0; i--) {
      if (!clips[i].pinned) { idx = i; break; }
    }
    if (idx === -1) break;
    deleteUploadFile(clips[idx]);
    clips.splice(idx, 1);
  }
}

function getStorageBytes() {
  let total = 0;
  if (fs.existsSync(CLIPS_FILE)) total += fs.statSync(CLIPS_FILE).size;
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      total += fs.statSync(path.join(UPLOADS_DIR, f)).size;
    }
  } catch { /* noop */ }
  return total;
}

// --- SSE ---

const sseClients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function broadcastDeviceCount() {
  broadcast('devices', { count: sseClients.size });
}

// --- Helpers ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        return reject(new Error('Body too large'));
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function extractId(url) {
  const match = url.match(/\/api\/clips\/([^/?]+)/);
  return match ? match[1] : null;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveUploadedFile(id, base64Data, originalName, mime) {
  const ext = path.extname(originalName) || mimeToExt(mime);
  const storedName = id + ext;
  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > MAX_FILE_BYTES) return null;
  fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buffer);
  return { name: originalName, size: buffer.length, mime, stored: storedName };
}

function mimeToExt(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
    'application/zip': '.zip', 'text/plain': '.txt', 'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
  };
  return map[mime] || '.bin';
}

// --- QR Code Generator (zero-dep, alphanumeric mode) ---

function generateQR(text) {
  // Minimal QR code encoder for short URLs (version 2-4, error correction L)
  // Uses byte mode encoding
  const data = encodeQRData(text);
  const size = data.length;
  const moduleCount = size;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${moduleCount + 8} ${moduleCount + 8}" shape-rendering="crispEdges">`;
  svg += `<rect width="100%" height="100%" fill="#ffffff"/>`;

  for (let r = 0; r < moduleCount; r++) {
    for (let c = 0; c < moduleCount; c++) {
      if (data[r][c]) {
        svg += `<rect x="${c + 4}" y="${r + 4}" width="1" height="1" fill="#000000"/>`;
      }
    }
  }
  svg += '</svg>';
  return svg;
}

// Simple QR encoder — enough for short URLs
function encodeQRData(text) {
  const bytes = Buffer.from(text, 'utf-8');
  const len = bytes.length;

  // Determine version (1-4, byte mode, EC level L)
  let version, totalDataCodewords, ecCodewordsPerBlock, numBlocks;
  if (len <= 17) { version = 1; totalDataCodewords = 19; ecCodewordsPerBlock = 7; numBlocks = 1; }
  else if (len <= 32) { version = 2; totalDataCodewords = 34; ecCodewordsPerBlock = 10; numBlocks = 1; }
  else if (len <= 53) { version = 3; totalDataCodewords = 55; ecCodewordsPerBlock = 15; numBlocks = 1; }
  else if (len <= 78) { version = 4; totalDataCodewords = 80; ecCodewordsPerBlock = 20; numBlocks = 1; }
  else if (len <= 106) { version = 5; totalDataCodewords = 108; ecCodewordsPerBlock = 26; numBlocks = 1; }
  else if (len <= 134) { version = 6; totalDataCodewords = 136; ecCodewordsPerBlock = 18; numBlocks = 2; }
  else if (len <= 154) { version = 7; totalDataCodewords = 156; ecCodewordsPerBlock = 20; numBlocks = 2; }
  else { throw new Error('Text too long for QR'); }

  const size = version * 4 + 17;

  // Build data stream
  const dataBits = [];
  function pushBits(val, count) {
    for (let i = count - 1; i >= 0; i--) dataBits.push((val >> i) & 1);
  }

  // Mode indicator: byte mode = 0100
  pushBits(4, 4);
  // Character count (8 bits for versions 1-9)
  pushBits(len, version <= 9 ? 8 : 16);
  // Data
  for (let i = 0; i < len; i++) pushBits(bytes[i], 8);
  // Terminator
  const totalDataBits = totalDataCodewords * 8;
  const termLen = Math.min(4, totalDataBits - dataBits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (dataBits.length % 8 !== 0) dataBits.push(0);
  // Pad codewords
  const pads = [0xEC, 0x11];
  let padIdx = 0;
  while (dataBits.length < totalDataBits) {
    pushBits(pads[padIdx % 2], 8);
    padIdx++;
  }

  // Convert bits to codewords
  const dataCodewords = [];
  for (let i = 0; i < dataBits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | (dataBits[i + j] || 0);
    dataCodewords.push(val);
  }

  // Reed-Solomon error correction
  const ecCodewords = rsEncode(dataCodewords, ecCodewordsPerBlock, numBlocks);

  // Interleave data + EC
  const allCodewords = interleave(dataCodewords, ecCodewords, numBlocks, totalDataCodewords, ecCodewordsPerBlock);

  // Create modules
  const modules = Array.from({ length: size }, () => Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => Array(size).fill(false));

  // Place finder patterns
  placeFinder(modules, reserved, 0, 0, size);
  placeFinder(modules, reserved, size - 7, 0, size);
  placeFinder(modules, reserved, 0, size - 7, size);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) { modules[6][i] = i % 2 === 0; reserved[6][i] = true; }
    if (!reserved[i][6]) { modules[i][6] = i % 2 === 0; reserved[i][6] = true; }
  }

  // Alignment patterns (version >= 2)
  if (version >= 2) {
    const positions = getAlignmentPositions(version, size);
    for (const r of positions) {
      for (const c of positions) {
        if (reserved[r][c]) continue;
        placeAlignment(modules, reserved, r, c, size);
      }
    }
  }

  // Dark module
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // Reserve format info areas
  reserveFormatInfo(reserved, size);

  // Reserve version info (version >= 7)
  if (version >= 7) reserveVersionInfo(reserved, size);

  // Place data bits
  placeData(modules, reserved, allCodewords, size);

  // Apply mask (pattern 0: (r + c) % 2 === 0)
  const bestMask = applyBestMask(modules, reserved, size);

  // Place format info
  placeFormatInfo(modules, size, 0, bestMask); // EC level L = 01

  // Place version info
  if (version >= 7) placeVersionInfo(modules, version, size);

  return modules.map(row => row.map(v => v === true));
}

function placeFinder(modules, reserved, row, col, size) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const mr = row + r, mc = col + c;
      if (mr < 0 || mr >= size || mc < 0 || mc >= size) continue;
      const isBlack = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                      (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                      (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      modules[mr][mc] = isBlack;
      reserved[mr][mc] = true;
    }
  }
}

function placeAlignment(modules, reserved, centerR, centerC, size) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const mr = centerR + r, mc = centerC + c;
      if (mr < 0 || mr >= size || mc < 0 || mc >= size) continue;
      const isBlack = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      modules[mr][mc] = isBlack;
      reserved[mr][mc] = true;
    }
  }
}

function getAlignmentPositions(version, size) {
  if (version === 1) return [];
  const table = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
    [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86],
    [6, 34, 62, 90],
  ];
  return table[version - 1] || table[0];
}

function reserveFormatInfo(reserved, size) {
  for (let i = 0; i < 8; i++) {
    reserved[8][i] = true;
    reserved[8][size - 1 - i] = true;
    reserved[i][8] = true;
    reserved[size - 1 - i][8] = true;
  }
  reserved[8][8] = true;
}

function reserveVersionInfo(reserved, size) {
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      reserved[i][size - 11 + j] = true;
      reserved[size - 11 + j][i] = true;
    }
  }
}

function placeData(modules, reserved, codewords, size) {
  const bits = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip timing column
    const rows = upward ? range(size - 1, -1) : range(0, size);
    for (const row of rows) {
      for (const col of [right, right - 1]) {
        if (col < 0) continue;
        if (reserved[row][col]) continue;
        modules[row][col] = bitIdx < bits.length ? bits[bitIdx] === 1 : false;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

function range(start, end) {
  const arr = [];
  if (start > end) { for (let i = start; i > end; i--) arr.push(i); }
  else { for (let i = start; i < end; i++) arr.push(i); }
  return arr;
}

function applyBestMask(modules, reserved, size) {
  let bestMask = 0;
  let bestPenalty = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const test = modules.map(r => [...r]);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (shouldMask(mask, r, c)) test[r][c] = !test[r][c];
      }
    }
    const penalty = calculatePenalty(test, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
  }

  // Apply best mask
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (shouldMask(bestMask, r, c)) modules[r][c] = !modules[r][c];
    }
  }
  return bestMask;
}

function shouldMask(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r * c) % 2 + (r * c) % 3 === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
    default: return false;
  }
}

function calculatePenalty(modules, size) {
  let penalty = 0;

  // Rule 1: runs of same color
  for (let r = 0; r < size; r++) {
    let count = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === modules[r][c - 1]) { count++; }
      else { if (count >= 5) penalty += count - 2; count = 1; }
    }
    if (count >= 5) penalty += count - 2;
  }
  for (let c = 0; c < size; c++) {
    let count = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === modules[r - 1][c]) { count++; }
      else { if (count >= 5) penalty += count - 2; count = 1; }
    }
    if (count >= 5) penalty += count - 2;
  }

  // Rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  return penalty;
}

function placeFormatInfo(modules, size, ecLevel, mask) {
  // EC level L = 01, format = ecLevel << 3 | mask
  const formatVal = (1 << 3) | mask; // L=01
  const encoded = bchEncode(formatVal, 0x537, 15) ^ 0x5412;

  const bits = [];
  for (let i = 14; i >= 0; i--) bits.push((encoded >> i) & 1);

  // Place around top-left finder
  const positions1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    modules[positions1[i][0]][positions1[i][1]] = bits[i] === 1;
  }

  // Place around other finders
  const positions2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
    [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
    [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    modules[positions2[i][0]][positions2[i][1]] = bits[i] === 1;
  }
}

function placeVersionInfo(modules, version, size) {
  if (version < 7) return;
  const encoded = bchEncode(version, 0x1F25, 18);
  const bits = [];
  for (let i = 17; i >= 0; i--) bits.push((encoded >> i) & 1);

  let idx = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      modules[i][size - 11 + j] = bits[idx] === 1;
      modules[size - 11 + j][i] = bits[idx] === 1;
      idx++;
    }
  }
}

function bchEncode(data, poly, totalBits) {
  const dataBits = totalBits === 15 ? 5 : 6;
  let val = data << (totalBits - dataBits);
  const polyLen = poly.toString(2).length;
  let rem = val;
  for (let i = dataBits - 1; i >= 0; i--) {
    if ((rem >> (totalBits - dataBits + i)) & 1) {
      rem ^= poly << i;
    }
  }
  return val | rem;
}

// Reed-Solomon in GF(256) with polynomial 0x11D
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  GF_LOG[0] = undefined;
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

function rsGenPoly(numEC) {
  let poly = [1];
  for (let i = 0; i < numEC; i++) {
    const factor = [1, GF_EXP[i]];
    const newPoly = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      for (let k = 0; k < factor.length; k++) {
        newPoly[j + k] ^= gfMul(poly[j], factor[k]);
      }
    }
    poly = newPoly;
  }
  return poly;
}

function rsEncode(dataCodewords, ecPerBlock, numBlocks) {
  const blockSize = Math.floor(dataCodewords.length / numBlocks);
  const allEC = [];

  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSize;
    const blockData = dataCodewords.slice(start, start + blockSize + (b < dataCodewords.length % numBlocks ? 1 : 0));
    const gen = rsGenPoly(ecPerBlock);
    const padded = [...blockData, ...new Array(ecPerBlock).fill(0)];

    for (let i = 0; i < blockData.length; i++) {
      const coeff = padded[i];
      if (coeff !== 0) {
        for (let j = 0; j < gen.length; j++) {
          padded[i + j] ^= gfMul(gen[j], coeff);
        }
      }
    }
    allEC.push(padded.slice(blockData.length));
  }
  return allEC;
}

function interleave(dataCodewords, ecBlocks, numBlocks, totalDataCW, ecPerBlock) {
  const result = [];
  const blockSize = Math.floor(totalDataCW / numBlocks);
  const blocks = [];

  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSize;
    blocks.push(dataCodewords.slice(start, start + blockSize + (b < totalDataCW % numBlocks ? 1 : 0)));
  }

  // Interleave data
  const maxDataLen = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blocks[b].length) result.push(blocks[b][i]);
    }
  }

  // Interleave EC
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      result.push(ecBlocks[b][i]);
    }
  }

  return result;
}

// --- mDNS Responder (clipbox.local) ---

const MDNS_HOST = process.env.MDNS_HOST || 'clipbox';
const MDNS_PORT = 5353;
const MDNS_ADDR = '224.0.0.251';

function encodeDNSName(name) {
  const parts = name.split('.');
  const bufs = [];
  for (const p of parts) {
    bufs.push(Buffer.from([p.length]));
    bufs.push(Buffer.from(p, 'ascii'));
  }
  bufs.push(Buffer.from([0]));
  return Buffer.concat(bufs);
}

function readDNSName(buf, offset) {
  const labels = [];
  while (offset < buf.length && buf[offset] !== 0) {
    if ((buf[offset] & 0xC0) === 0xC0) break;
    const len = buf[offset++];
    if (offset + len > buf.length) break;
    labels.push(buf.slice(offset, offset + len).toString('ascii'));
    offset += len;
  }
  return labels.join('.').toLowerCase();
}

function buildAResponse(id, nameBytes, ipOctets) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8400, 2);    // QR=1 AA=1
  header.writeUInt16BE(0, 4);         // QDCOUNT
  header.writeUInt16BE(1, 6);         // ANCOUNT

  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(1, 0);           // TYPE A
  meta.writeUInt16BE(0x8001, 2);      // CLASS IN + cache-flush
  meta.writeUInt32BE(120, 4);         // TTL 120s
  meta.writeUInt16BE(4, 8);           // RDLENGTH

  return Buffer.concat([header, nameBytes, meta, Buffer.from(ipOctets)]);
}

function startMDNS(ip) {
  const targetName = `${MDNS_HOST}.local`;
  const nameBytes = encodeDNSName(targetName);
  const ipOctets = ip.split('.').map(Number);

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg) => {
    if (msg.length < 12) return;
    if (msg.readUInt16BE(2) & 0x8000) return;       // ignore responses
    if (msg.readUInt16BE(4) === 0) return;           // no questions

    const name = readDNSName(msg, 12);
    if (name !== targetName) return;

    const res = buildAResponse(msg.readUInt16BE(0), nameBytes, ipOctets);
    sock.send(res, 0, res.length, MDNS_PORT, MDNS_ADDR);
  });

  sock.on('error', () => { try { sock.close(); } catch {} });

  sock.bind(MDNS_PORT, () => {
    try {
      sock.addMembership(MDNS_ADDR);
      sock.setMulticastTTL(255);
      // Announce ourselves on startup
      const ann = buildAResponse(0, nameBytes, ipOctets);
      sock.send(ann, 0, ann.length, MDNS_PORT, MDNS_ADDR);
    } catch { try { sock.close(); } catch {} }
  });

  return sock;
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // Serve uploaded files
  if (method === 'GET' && url.startsWith('/uploads/')) {
    const fileName = path.basename(url.split('?')[0]);
    const filePath = path.join(UPLOADS_DIR, fileName);
    if (!fs.existsSync(filePath)) return json(res, 404, { error: 'File not found' });
    const mime = getMime(filePath);
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // Serve static files from public/
  if (method === 'GET' && !url.startsWith('/api/')) {
    const urlPath = url === '/' ? '/index.html' : url.split('?')[0];
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, safePath);

    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const mime = getMime(filePath);
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      return res.end(content);
    }
    return json(res, 404, { error: 'Not found' });
  }

  // SSE
  if (method === 'GET' && url === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n');
    sseClients.add(res);
    broadcastDeviceCount();
    req.on('close', () => {
      sseClients.delete(res);
      broadcastDeviceCount();
    });
    return;
  }

  // GET status
  if (method === 'GET' && url === '/api/status') {
    const clips = readClips();
    return json(res, 200, {
      devices: sseClients.size,
      clipCount: clips.length,
      storageBytes: getStorageBytes(),
    });
  }

  // GET clips
  if (method === 'GET' && url === '/api/clips') {
    return json(res, 200, readClips());
  }

  // QR code endpoint
  if (method === 'GET' && url === '/api/qr') {
    try {
      const ip = getLocalIP();
      const qrUrl = `http://${ip}:${PORT}`;
      const svg = generateQR(qrUrl);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(svg);
    } catch (err) {
      return json(res, 500, { error: 'QR generation failed' });
    }
  }

  // POST clip (text or file, with duplicate detection + auto-prune)
  if (method === 'POST' && url === '/api/clips') {
    try {
      const body = await parseBody(req);

      // File upload
      if (body.file) {
        const { data, name, mime } = body.file;
        if (!data || !name) return json(res, 400, { error: 'File data and name required' });

        const id = generateId();
        const fileInfo = saveUploadedFile(id, data, name, mime || 'application/octet-stream');
        if (!fileInfo) return json(res, 400, { error: 'File too large (max 10MB)' });

        const isImage = (mime || '').startsWith('image/');
        const clip = {
          id,
          type: isImage ? 'image' : 'file',
          file: fileInfo,
          pinned: false,
          createdAt: Date.now(),
        };

        const clips = readClips();
        clips.unshift(clip);
        pruneClips(clips);
        writeClips(clips);
        broadcast('update', { action: 'add', clip });
        return json(res, 201, clip);
      }

      // Text clip
      const { text, pinned } = body;
      if (!text || !text.trim()) return json(res, 400, { error: 'Text required' });

      const trimmed = text.trim();
      const clips = readClips();

      // Duplicate detection — move existing to top
      const dupIdx = clips.findIndex(c => c.type !== 'image' && c.type !== 'file' && c.text === trimmed);
      if (dupIdx !== -1) {
        const existing = clips.splice(dupIdx, 1)[0];
        existing.createdAt = Date.now();
        clips.unshift(existing);
        writeClips(clips);
        broadcast('update', { action: 'duplicate', clip: existing });
        return json(res, 200, { ...existing, duplicate: true });
      }

      const clip = {
        id: generateId(),
        type: 'text',
        text: trimmed,
        pinned: !!pinned,
        createdAt: Date.now(),
      };
      clips.unshift(clip);
      pruneClips(clips);
      writeClips(clips);
      broadcast('update', { action: 'add', clip });
      return json(res, 201, clip);
    } catch (err) {
      const msg = err.message === 'Body too large' ? 'File too large (max 15MB)' : 'Invalid request';
      return json(res, 400, { error: msg });
    }
  }

  // PATCH clip (toggle pin or edit text)
  const patchId = method === 'PATCH' ? extractId(url) : null;
  if (patchId) {
    const clips = readClips();
    const clip = clips.find(c => c.id === patchId);
    if (!clip) return json(res, 404, { error: 'Not found' });

    try {
      const body = await parseBody(req).catch(() => null);
      if (body && typeof body.text === 'string') {
        // Edit text
        clip.text = body.text.trim();
      } else {
        // Toggle pin
        clip.pinned = !clip.pinned;
      }
    } catch {
      clip.pinned = !clip.pinned;
    }

    writeClips(clips);
    broadcast('update', { action: 'patch', clip });
    return json(res, 200, clip);
  }

  // DELETE all unpinned clips
  if (method === 'DELETE' && url === '/api/clips') {
    const clips = readClips();
    const removed = clips.filter(c => !c.pinned);
    removed.forEach(deleteUploadFile);
    const kept = clips.filter(c => c.pinned);
    writeClips(kept);
    broadcast('update', { action: 'clear' });
    return json(res, 200, { ok: true, removed: removed.length });
  }

  // DELETE single clip
  const deleteId = method === 'DELETE' ? extractId(url) : null;
  if (deleteId) {
    const clips = readClips();
    const idx = clips.findIndex(c => c.id === deleteId);
    if (idx === -1) return json(res, 404, { error: 'Not found' });
    const deleted = clips.splice(idx, 1)[0];
    deleteUploadFile(deleted);
    writeClips(clips);
    broadcast('update', { action: 'delete', id: deleteId });
    return json(res, 200, { ok: true, clip: deleted });
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const mdnsUrl = `http://${MDNS_HOST}.local:${PORT}`;
  const networkUrl = `http://${ip}:${PORT}`;

  let mdnsActive = false;
  try {
    startMDNS(ip);
    mdnsActive = true;
  } catch { /* mDNS unavailable */ }

  const pad = (s, len) => s + ' '.repeat(Math.max(0, len - s.length));

  console.log('\n  ┌──────────────────────────────────────────┐');
  console.log('  │             C L I P B O X                │');
  console.log('  ├──────────────────────────────────────────┤');
  console.log(`  │  Local:   http://localhost:${PORT}          │`);
  console.log(`  │  Network: ${pad(networkUrl, 30)}│`);
  if (mdnsActive) {
    console.log(`  │  LAN:     ${pad(mdnsUrl, 30)}│`);
  }
  console.log('  └──────────────────────────────────────────┘\n');

  if (mdnsActive) {
    console.log(`  Any device on this network can open ${mdnsUrl}`);
  }
  console.log(`  Max clips: ${MAX_CLIPS} | Files up to 10MB | QR code in the header.\n`);
});
