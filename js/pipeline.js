// Pipeline xử lý 1 ảnh: giải mã → xoay → resize → watermark → mã hoá.
// Vẽ qua canvas nên metadata EXIF/GPS luôn bị loại bỏ.

export const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/.test(f.type);

// Giải mã: Safari (macOS 14+) đọc HEIC trực tiếp; trình duyệt khác dùng libheif (WASM) trong Worker
export async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    if (!isHeic(file)) throw err;
  }
  const buffer = await file.arrayBuffer();
  const res = await heicPool.run({ buffer }, [buffer]);
  return createImageBitmap(new ImageData(new Uint8ClampedArray(res.data), res.width, res.height));
}

function targetSize(w, h, resize) {
  if (!resize || resize.mode === 'none' || !(resize.value > 0)) return [w, h];
  let s = 1;
  if (resize.mode === 'percent') s = resize.value / 100;
  else s = Math.min(1, resize.value / Math.max(w, h)); // cạnh dài tối đa, không phóng to
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

// Thu nhỏ từng bước /2 để ảnh sắc nét hơn khi giảm kích thước nhiều
function scaleDown(src, w, h) {
  let cur = src, cw = src.width, ch = src.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const c = new Canvas2D(Math.round(cw / 2), Math.round(ch / 2));
    c.ctx.drawImage(cur, 0, 0, c.width, c.height);
    cur = c.canvas; cw = c.width; ch = c.height;
  }
  const out = new Canvas2D(w, h);
  out.ctx.drawImage(cur, 0, 0, w, h);
  return out.canvas;
}

class Canvas2D {
  constructor(w, h) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width = w;
    this.canvas.height = this.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }
}

function drawWatermark(ctx, w, h, wm) {
  const size = Math.max(10, Math.round((w * wm.size) / 100));
  const pad = Math.round(size * 0.8);
  ctx.save();
  ctx.globalAlpha = wm.opacity / 100;
  ctx.font = `600 ${size}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = size / 6;
  const [v, hz] = { tl: ['top', 'left'], tr: ['top', 'right'], c: ['middle', 'center'], bl: ['bottom', 'left'], br: ['bottom', 'right'] }[wm.pos];
  ctx.textBaseline = v;
  ctx.textAlign = hz;
  const x = hz === 'left' ? pad : hz === 'right' ? w - pad : w / 2;
  const y = v === 'top' ? pad : v === 'bottom' ? h - pad : h / 2;
  ctx.fillText(wm.text, x, y);
  ctx.restore();
}

// Trả về canvas đã áp dụng xoay / resize / watermark
export function render(bitmap, opts = {}) {
  const rot = ((opts.rotate || 0) % 360 + 360) % 360;
  const [tw, th] = targetSize(bitmap.width, bitmap.height, opts.resize);
  let src = tw < bitmap.width ? scaleDown(bitmap, tw, th) : bitmap;
  const swap = rot === 90 || rot === 270;
  const out = new Canvas2D(swap ? th : tw, swap ? tw : th);
  const { ctx } = out;
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(src, -tw / 2, -th / 2, tw, th);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.watermark?.text) drawWatermark(ctx, out.width, out.height, opts.watermark);
  return out.canvas;
}

// ---------- Pool Web Worker ----------
// Mỗi worker xử lý 1 việc một lúc; việc thừa xếp hàng chờ.
function createPool(url, size) {
  const workers = [];
  const idle = [];
  const waiting = [];
  const pending = new Map();
  let seq = 0;

  function spawn() {
    const w = new Worker(url, { type: 'module' });
    w.onmessage = (e) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      release(w);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data);
    };
    w.onerror = (e) => {
      // Lỗi nạp module/WASM hoặc worker crash – báo lỗi việc đang chạy, thay worker mới
      for (const [id, p] of pending) if (p.worker === w) { pending.delete(id); p.reject(new Error(e.message || 'Worker error')); }
      w.terminate();
      workers.splice(workers.indexOf(w), 1);
      const next = waiting.shift();
      if (next) acquire().then(next);
    };
    workers.push(w);
    return w;
  }
  function acquire() {
    if (idle.length) return Promise.resolve(idle.pop());
    if (workers.length < size) return Promise.resolve(spawn());
    return new Promise((r) => waiting.push(r));
  }
  function release(w) {
    const next = waiting.shift();
    next ? next(w) : idle.push(w);
  }
  return {
    async run(msg, transfer) {
      const w = await acquire();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, worker: w });
        w.postMessage({ id, ...msg }, transfer);
      });
    },
  };
}

const cores = navigator.hardwareConcurrency || 2;
const heicPool = createPool(new URL('./heic.worker.js', import.meta.url), Math.min(3, cores));
const codecPool = createPool(new URL('./codec.worker.js', import.meta.url), Math.min(3, cores));

const toBlob = (canvas, type, q) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Không mã hoá được ảnh'))), type, q));

// level: none | light | smart | strong | custom
export async function encode(canvas, type, { level = 'none', quality = 85 } = {}) {
  // Không nén: dùng encoder của trình duyệt (nhanh). WEBP luôn qua libwebp vì Safari không hỗ trợ toBlob WEBP.
  if (level === 'none' && type !== 'image/webp') {
    return { blob: await toBlob(canvas, type, quality / 100), quality };
  }
  const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const res = await codecPool.run({ imageData, type, level: level === 'none' ? 'custom' : level, quality }, [imageData.data.buffer]);
  return { blob: new Blob([res.buffer], { type }), quality: res.quality, colors: res.colors, note: res.note };
}
