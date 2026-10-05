// Round-trips the extension's GIF encoder through an independent LZW decoder.
import test from 'node:test';
import assert from 'node:assert';
import { encodeGif } from '../extension/lib/gif.js';

function decodeGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const sig = String.fromCharCode(...bytes.slice(0, 6)); p = 6;
  assert.equal(sig, 'GIF89a');
  const w = u16(), h = u16(), packed = u8(); u8(); u8();
  const palette = bytes.slice(p, p + 3 * (1 << ((packed & 7) + 1))); p += palette.length;
  const frames = [];
  for (;;) {
    const b = u8();
    if (b === 0x3b) break;
    if (b === 0x21) { u8(); let n; while ((n = u8())) p += n; continue; }
    assert.equal(b, 0x2c);
    u16(); u16(); const fw = u16(), fh = u16(); u8();
    const min = u8();
    const data = [];
    let n;
    while ((n = u8())) { for (let i = 0; i < n; i++) data.push(u8()); }
    frames.push(lzwDecode(data, min, fw * fh));
  }
  return { w, h, palette, frames };
}

function lzwDecode(data, min, count) {
  const clear = 1 << min, eoi = clear + 1;
  let size = min + 1, dict = [], prev = null;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = null; size = min + 1; prev = null; };
  reset();
  const out = [];
  let bit = 0;
  const read = () => {
    let v = 0;
    for (let i = 0; i < size; i++, bit++) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return v;
  };
  for (;;) {
    const code = read();
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = [...prev, prev[0]];
    else throw new Error('bad code ' + code);
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === (1 << size) && size < 12) size++;
  }
  assert.equal(out.length, count);
  return out;
}

test('GIF encoder output decodes to the same palette indices', () => {
  const w = 97, h = 61;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    rgba[o] = (x * 37) & 255; rgba[o + 1] = (y * 91) & 255; rgba[o + 2] = ((x ^ y) * 13) & 255; rgba[o + 3] = 255;
  }
  const bytes = encodeGif([{ rgba, delay: 100 }, { rgba, delay: 300 }], w, h, { dither: false });
  const gif = decodeGif(bytes);
  assert.equal(gif.w, w);
  assert.equal(gif.h, h);
  assert.equal(gif.frames.length, 2);
  // Each decoded index must be the nearest 6x7x6 palette colour of its pixel.
  for (let i = 0; i < w * h; i++) {
    const r = Math.round(rgba[i * 4] / 255 * 5), g = Math.round(rgba[i * 4 + 1] / 255 * 6), b = Math.round(rgba[i * 4 + 2] / 255 * 5);
    assert.equal(gif.frames[0][i], r * 42 + g * 6 + b, `pixel ${i}`);
  }
});

test('GIF encoder handles large images that overflow the 4096-code LZW table', () => {
  const w = 640, h = 400;
  const rgba = new Uint8ClampedArray(w * h * 4);
  let seed = 1;
  for (let i = 0; i < rgba.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rgba[i] = i % 4 === 3 ? 255 : seed & 255; }
  const gif = decodeGif(encodeGif([{ rgba, delay: 100 }], w, h, { dither: true }));
  assert.equal(gif.frames[0].length, w * h);
});
