// GIF recording: frames are captured after each recorded action, then encoded with
// overlays (click indicators, drag paths, action labels, progress bar, watermark).
// Self-contained GIF89a encoder (fixed 256-colour palette + ordered dithering + LZW).

const recordings = new Map(); // groupId -> { recording, frames: [] }
const MAX_FRAMES = 120;
const FRAME_MAX_WIDTH = 960;

export function state(groupId) {
  let s = recordings.get(groupId);
  if (!s) recordings.set(groupId, (s = { recording: false, frames: [] }));
  return s;
}

export function isRecording(groupId) {
  return !!recordings.get(groupId)?.recording;
}

/** Add a frame: jpegBlob of the viewport + the action that led to it (CSS coords). */
export function addFrame(groupId, frame) {
  const s = state(groupId);
  if (!s.recording) return;
  s.frames.push(frame);
  if (s.frames.length > MAX_FRAMES) s.frames.shift();
}

export function clear(groupId) {
  recordings.delete(groupId);
}

export function frameWidthFor(cssWidth) {
  return Math.min(FRAME_MAX_WIDTH, cssWidth);
}

// ---------------- palette & quantisation ----------------
const PALETTE = (() => {
  const p = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) {
    p[i++] = Math.round((r * 255) / 5); p[i++] = Math.round((g * 255) / 6); p[i++] = Math.round((b * 255) / 5);
  }
  // 252 colours used; 4 extra greys.
  for (const v of [64, 128, 192, 224]) { p[i++] = v; p[i++] = v; p[i++] = v; }
  return p;
})();

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v / 16 - 0.5));

function quantize(rgba, w, h, dither) {
  const out = new Uint8Array(w * h);
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const o = p * 4;
      const d = dither ? BAYER[(y & 3) * 4 + (x & 3)] : 0;
      const r = Math.min(5, Math.max(0, Math.round((rgba[o] / 255) * 5 + d)));
      const g = Math.min(6, Math.max(0, Math.round((rgba[o + 1] / 255) * 6 + d)));
      const b = Math.min(5, Math.max(0, Math.round((rgba[o + 2] / 255) * 5 + d)));
      out[p] = r * 42 + g * 6 + b;
    }
  }
  return out;
}

// ---------------- LZW ----------------
function lzw(indices, minCodeSize, writeByte) {
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let table = new Map();
  let cur = 0, bits = 0;
  const emit = code => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) { writeByte(cur & 0xff); cur >>>= 8; bits -= 8; }
  };
  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clearCode);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) writeByte(cur & 0xff);
}

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 20); this.len = 0; }
  byte(b) {
    if (this.len >= this.buf.length) { const n = new Uint8Array(this.buf.length * 2); n.set(this.buf); this.buf = n; }
    this.buf[this.len++] = b;
  }
  bytes(arr) { for (const b of arr) this.byte(b); }
  u16(v) { this.byte(v & 0xff); this.byte((v >> 8) & 0xff); }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  result() { return this.buf.subarray(0, this.len); }
}

export function encodeGif(frames, w, h, { dither = true } = {}) {
  const out = new ByteWriter();
  out.str('GIF89a');
  out.u16(w); out.u16(h);
  out.byte(0xf7); out.byte(0); out.byte(0);
  out.bytes(PALETTE);
  // Loop forever
  out.bytes([0x21, 0xff, 0x0b]); out.str('NETSCAPE2.0'); out.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  for (const f of frames) {
    out.bytes([0x21, 0xf9, 0x04, 0x00]); out.u16(f.delay); out.bytes([0x00, 0x00]);
    out.byte(0x2c); out.u16(0); out.u16(0); out.u16(w); out.u16(h); out.byte(0x00);
    out.byte(8);
    const indices = quantize(f.rgba, w, h, dither);
    let block = [];
    lzw(indices, 8, b => {
      block.push(b);
      if (block.length === 255) { out.byte(255); out.bytes(block); block = []; }
    });
    if (block.length) { out.byte(block.length); out.bytes(block); }
    out.byte(0x00);
  }
  out.byte(0x3b);
  return out.result();
}

// ---------------- overlays & export ----------------
function drawArrow(ctx, x1, y1, x2, y2) {
  ctx.strokeStyle = '#e5322d'; ctx.fillStyle = '#e5322d'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  const a = Math.atan2(y2 - y1, x2 - x1), L = 12;
  ctx.beginPath(); ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45));
  ctx.lineTo(x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill();
}

function drawLabel(ctx, text, W) {
  ctx.font = '600 14px system-ui, -apple-system, Segoe UI, sans-serif';
  const t = text.length > 90 ? text.slice(0, 89) + '…' : text;
  const tw = Math.min(ctx.measureText(t).width, W - 40);
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.beginPath(); ctx.roundRect(12, 12, tw + 20, 28, 6); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle';
  ctx.fillText(t, 22, 26, W - 40);
}

export async function exportGif(groupId, options = {}) {
  const s = recordings.get(groupId);
  if (!s || !s.frames.length) throw new Error('No frames recorded. Call gif_creator start_recording, perform actions (take a screenshot right after starting and right before stopping), then export.');
  const o = { showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, showWatermark: true, quality: 10, ...options };
  const first = await createImageBitmap(s.frames[0].blob);
  const W = first.width, H = first.height;
  first.close();
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const encoded = [];
  for (let i = 0; i < s.frames.length; i++) {
    const f = s.frames[i];
    const bmp = await createImageBitmap(f.blob);
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close();
    const k = W / f.cssWidth;
    const a = f.action || {};
    if (o.showDragPaths && a.start && a.end) drawArrow(ctx, a.start[0] * k, a.start[1] * k, a.end[0] * k, a.end[1] * k);
    if (o.showClickIndicators && a.point) {
      const [x, y] = [a.point[0] * k, a.point[1] * k];
      ctx.strokeStyle = '#f97316'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(249,115,22,0.45)';
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    }
    if (o.showActionLabels && a.label) drawLabel(ctx, a.label, W);
    if (o.showProgressBar) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(0, H - 5, W, 5);
      ctx.fillStyle = '#f97316'; ctx.fillRect(0, H - 5, (W * (i + 1)) / s.frames.length, 5);
    }
    if (o.showWatermark) {
      ctx.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.textBaseline = 'alphabetic';
      const t = 'Open Browser Bridge';
      const tw = ctx.measureText(t).width;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.beginPath(); ctx.roundRect(W - tw - 24, H - 32, tw + 14, 20, 5); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillText(t, W - tw - 17, H - 18);
    }
    const isLast = i === s.frames.length - 1;
    encoded.push({ rgba: ctx.getImageData(0, 0, W, H).data, delay: isLast ? 300 : a.delay || 100 });
  }
  const bytes = encodeGif(encoded, W, H, { dither: (o.quality ?? 10) <= 20 });
  return { bytes, width: W, height: H, frames: s.frames.length };
}
