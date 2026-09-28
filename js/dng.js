// Giải mã DNG (RAW): ưu tiên ảnh JPEG nhúng sẵn nếu đủ độ phân giải (nhanh, màu giống máy chụp),
// nếu không thì giải mã RAW thật bằng LibRaw (WASM). LibRaw cần trang được cross-origin isolated
// (coi-serviceworker.js lo việc này); không được thì dùng ảnh nhúng lớn nhất.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const CFA = 32803, LINEAR_RAW = 34892;

// Đọc cấu trúc TIFF của DNG: danh sách ảnh JPEG nhúng (lớn → nhỏ), kích thước ảnh RAW, hướng xoay
export function parseDng(buffer) {
  const v = new DataView(buffer);
  const bom = v.getUint16(0);
  const le = bom === 0x4949;
  if ((!le && bom !== 0x4d4d) || v.getUint16(2, le) !== 42) throw new Error('Không phải file DNG hợp lệ');
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);

  function readIfd(off) {
    const tags = new Map();
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      const type = u16(e + 2), count = u32(e + 4), size = TYPE_SIZE[type] || 1;
      const p = size * count > 4 ? u32(e + 8) : e + 8;
      if (p + size * count > buffer.byteLength) continue;
      const vals = [];
      for (let k = 0; k < Math.min(count, 64); k++) {
        if (type === 3) vals.push(u16(p + 2 * k));
        else if (type === 4 || type === 13) vals.push(u32(p + 4 * k));
        else if (type === 5) vals.push(u32(p + 8 * k) / (u32(p + 8 * k + 4) || 1));
        else if (type === 1 || type === 7) vals.push(v.getUint8(p + k));
      }
      tags.set(u16(e), vals);
    }
    return { tags, next: u32(off + 2 + n * 12) };
  }

  const previews = [];
  let rawWidth = 0, rawHeight = 0, orientation = 1;
  const queue = [u32(4)];
  const seen = new Set();
  while (queue.length && seen.size < 64) {
    const off = queue.shift();
    if (!off || seen.has(off) || off + 2 > buffer.byteLength) continue;
    seen.add(off);
    const { tags, next } = readIfd(off);
    const get = (t, i = 0) => tags.get(t)?.[i];
    if (off === u32(4)) orientation = get(274) || 1;
    queue.push(next, ...(tags.get(330) || []));

    const photo = get(262), comp = get(259);
    const w = get(256) || 0, h = get(257) || 0;
    if ((photo === CFA || photo === LINEAR_RAW) && !((get(254) || 0) & 1)) {
      const cw = Math.round(get(50719) || w), ch = Math.round(get(50719, 1) || h);
      if (cw * ch > rawWidth * rawHeight) [rawWidth, rawHeight] = [cw, ch];
      continue;
    }
    let start, length;
    if (tags.has(513) && tags.has(514)) [start, length] = [get(513), get(514)];
    else if ((comp === 6 || comp === 7) && (photo === 2 || photo === 6) && tags.get(273)?.length === 1) [start, length] = [get(273), get(279)];
    else continue;
    if (!length || start + length > buffer.byteLength || v.getUint16(start) !== 0xffd8) continue;
    previews.push({ start, length, width: w, height: h });
  }
  previews.sort((a, b) => b.width * b.height - a.width * a.height || b.length - a.length);
  return { previews, rawWidth, rawHeight, orientation };
}

export async function decodeDng(file, thumb = false) {
  const buffer = await file.arrayBuffer();
  let info = { previews: [], rawWidth: 0, rawHeight: 0, orientation: 1 };
  try { info = parseDng(buffer); } catch { /* để LibRaw thử */ }
  const best = info.previews[0];
  // Blob sao chép dữ liệu → vẫn dùng được sau khi buffer chuyển sang worker LibRaw
  const previewBlob = best && new Blob([new Uint8Array(buffer, best.start, best.length)], { type: 'image/jpeg' });
  const preview = async () => orient(await createImageBitmap(previewBlob), info.orientation);

  const long = best ? Math.max(best.width, best.height) : 0;
  const rawLong = Math.max(info.rawWidth, info.rawHeight);
  if (best && ((thumb && long >= 600) || (rawLong && long >= 0.9 * rawLong))) return preview();

  let error;
  if (globalThis.crossOriginIsolated) {
    try { return await decodeRaw(buffer); } catch (err) { error = err; console.warn('LibRaw:', err); }
  }
  if (best) {
    const bmp = await preview();
    bmp.note = `dùng ảnh xem trước ${bmp.width}×${bmp.height}`;
    return bmp;
  }
  throw error || new Error('Không đọc được file DNG – hãy tải lại trang rồi thử lại');
}

// Xoay/lật theo tag Orientation (1–8) của DNG
async function orient(bmp, o) {
  if (!(o > 1 && o <= 8)) return bmp;
  const { width: w, height: h } = bmp;
  const swap = o >= 5;
  const c = document.createElement('canvas');
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const ctx = c.getContext('2d');
  ctx.transform(...{
    2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w],
  }[o]);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return createImageBitmap(c);
}

// ---------- LibRaw: tối đa 2 instance (mỗi cái 1 worker, tốn nhiều RAM) ----------
const RAW_MAX = Math.min(2, navigator.hardwareConcurrency || 2);
const rawIdle = [];
const rawWaiting = [];
let rawCount = 0;
let LibRaw;

async function decodeRaw(buffer) {
  LibRaw ||= (await import('../vendor/libraw/index.js')).default;
  let raw = rawIdle.pop();
  if (!raw && rawCount < RAW_MAX) { raw = new LibRaw(); rawCount++; }
  if (!raw) raw = await new Promise((r) => rawWaiting.push(r));
  let ok = false;
  try {
    await raw.open(new Uint8Array(buffer), { useCameraWb: true, outputColor: 1, outputBps: 8, userQual: 3 });
    const img = await raw.imageData();
    ok = true;
    return toBitmap(img);
  } finally {
    if (!ok) { raw.dispose(); raw = new LibRaw(); } // lỗi có thể làm hỏng WASM → thay instance mới
    const next = rawWaiting.shift();
    next ? next(raw) : rawIdle.push(raw);
  }
}

function toBitmap({ width, height, colors, data }) {
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  const g = colors > 1 ? 1 : 0, b = colors > 2 ? 2 : 0;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += colors, k += 4) {
    rgba[k] = data[j];
    rgba[k + 1] = data[j + g];
    rgba[k + 2] = data[j + b];
    rgba[k + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, width, height));
}
