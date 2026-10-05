// Screenshots with a token-budget downscale. The agent always works in the
// "frame": the scale-1 screenshot's pixel space. Frame coords map to CSS viewport
// pixels via frameScale, so coordinates stay valid whatever `scale` was requested.

import { send, viewport } from './cdp.js';

const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;
const store = new Map(); // imageId -> { data, mimeType, ts }
const TTL_MS = 5 * 60 * 1000;

export function frameScaleFor(w, h) {
  return Math.min(1, MAX_EDGE / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
}

/** Viewport info + frame mapping for a tab. */
export async function frameInfo(tabId) {
  const vp = await viewport(tabId);
  const fs = frameScaleFor(vp.width, vp.height);
  return { ...vp, frameScale: fs, frameW: Math.round(vp.width * fs), frameH: Math.round(vp.height * fs) };
}

export function toCss(info, [x, y]) {
  return [x / info.frameScale, y / info.frameScale];
}

export function toFrame(info, [x, y]) {
  return [Math.round(x * info.frameScale), Math.round(y * info.frameScale)];
}

async function dpr(tabId) {
  const r = await send(tabId, 'Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true });
  return r.result?.value || 1;
}

async function decode(base64) {
  const blob = await (await fetch('data:image/png;base64,' + base64)).blob();
  return createImageBitmap(blob);
}

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function render(bitmap, w, h, mimeType, quality) {
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  return { data: await blobToBase64(blob), width: canvas.width, height: canvas.height };
}

/** Full viewport screenshot. Returns base64 image + frame info. */
export async function screenshot(tabId, { scale = 1, mimeType = 'image/jpeg', quality = 0.85 } = {}) {
  const info = await frameInfo(tabId);
  const shot = await send(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
  const bitmap = await decode(shot.data);
  const s = Math.min(1, Math.max(0.1, scale || 1));
  const img = await render(bitmap, info.frameW * s, info.frameH * s, mimeType, quality);
  bitmap.close?.();
  return { ...img, mimeType, info, scale: s };
}

/** Zoomed capture of region [x0,y0,x1,y1] given in frame coordinates. */
export async function zoom(tabId, region, { scale = 1 } = {}) {
  if (!Array.isArray(region) || region.length !== 4) throw new Error('region must be [x0, y0, x1, y1].');
  const info = await frameInfo(tabId);
  let [x0, y0] = toCss(info, [region[0], region[1]]);
  let [x1, y1] = toCss(info, [region[2], region[3]]);
  if (x1 < x0) [x0, x1] = [x1, x0];
  if (y1 < y0) [y0, y1] = [y1, y0];
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(info.width, x1); y1 = Math.min(info.height, y1);
  const w = x1 - x0, h = y1 - y0;
  if (w < 1 || h < 1) throw new Error('Zoom region is empty or outside the viewport.');
  const ratio = await dpr(tabId);
  const shot = await send(tabId, 'Page.captureScreenshot', {
    format: 'png', fromSurface: true,
    clip: { x: x0 + (info.pageX || 0), y: y0 + (info.pageY || 0), width: w, height: h, scale: 1 },
  });
  const bitmap = await decode(shot.data);
  // Native resolution of the region, capped by the same token budget.
  const natW = w * ratio, natH = h * ratio;
  const fit = frameScaleFor(natW, natH) * Math.min(1, Math.max(0.1, scale || 1));
  const img = await render(bitmap, natW * fit, natH * fit, 'image/png');
  bitmap.close?.();
  return { ...img, mimeType: 'image/png', info };
}

export function remember(img) {
  const now = Date.now();
  for (const [k, v] of store) if (now - v.ts > TTL_MS) store.delete(k);
  const id = 'ss_' + Math.random().toString(36).slice(2, 10);
  store.set(id, { data: img.data, mimeType: img.mimeType, ts: now });
  return id;
}

export function recall(id) {
  const v = store.get(id);
  if (!v || Date.now() - v.ts > TTL_MS) {
    store.delete(id);
    throw new Error(`Screenshot ID "${id}" is unknown or expired. Take a new screenshot right before uploading.`);
  }
  return v;
}
