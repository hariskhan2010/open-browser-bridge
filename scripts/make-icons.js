'use strict';
// Generates the extension's PNG icons (orange rounded square with a white "bridge" arc).
// Zero dependencies: rasterises with simple signed-distance shapes and writes PNG via zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const clamp = v => Math.max(0, Math.min(1, v));

function pixel(x, y, s) {
  const u = x / s, v = y / s;
  // rounded square
  const r = 0.22, half = 0.5;
  const dx = Math.max(Math.abs(u - 0.5) - (half - r), 0), dy = Math.max(Math.abs(v - 0.5) - (half - r), 0);
  const dSq = Math.hypot(dx, dy) - r;
  const aa = 1 / s;
  const bgA = clamp(0.5 - dSq / aa);
  if (bgA <= 0) return [0, 0, 0, 0];
  // bridge arc: ring segment (upper half) + deck line + two pillars
  const cx = 0.5, cy = 0.68, R = 0.28, w = 0.065;
  const ring = Math.abs(Math.hypot(u - cx, v - cy) - R) - w / 2;
  const arc = v <= cy ? ring : 1;
  const deck = Math.max(Math.abs(v - 0.68) - w / 2, Math.abs(u - 0.5) - 0.36);
  const pl = Math.max(Math.abs(u - (cx - R)) - w / 2, Math.abs(v - 0.74) - 0.06);
  const pr = Math.max(Math.abs(u - (cx + R)) - w / 2, Math.abs(v - 0.74) - 0.06);
  const d = Math.min(arc, deck, pl, pr);
  const fg = clamp(0.5 - d / aa);
  const bg = [234, 88, 12];
  return [Math.round(bg[0] + (255 - bg[0]) * fg), Math.round(bg[1] + (255 - bg[1]) * fg), Math.round(bg[2] + (255 - bg[2]) * fg), Math.round(255 * bgA)];
}

const out = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${size}.png`), png(size, pixel));
console.log('Icons written to', out);
