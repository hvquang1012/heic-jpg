// Web Worker nén ảnh – chạy nền để giao diện không bị đơ.
import encodeJpeg from '../vendor/jsquash/jpeg/encode.js';
import decodeJpeg from '../vendor/jsquash/jpeg/decode.js';
import encodeWebp from '../vendor/jsquash/webp/encode.js';
import decodeWebp from '../vendor/jsquash/webp/decode.js';
import optimisePng from '../vendor/jsquash/oxipng/optimise.js';
import { utils, buildPaletteSync, applyPaletteSync } from '../vendor/image-q.mjs';
import { luma, ssim, centerCrop } from './ssim.js';

// Ngưỡng SSIM cho từng mức nén (càng gần 1 càng giống ảnh gốc)
const TARGET = { light: 0.993, smart: 0.985, strong: 0.97 };
const PNG_COLORS = { smart: 256, strong: 128 };

const codecs = {
  'image/jpeg': { enc: (img, q) => encodeJpeg(img, { quality: q }), dec: decodeJpeg },
  'image/webp': { enc: (img, q) => encodeWebp(img, { quality: q }), dec: decodeWebp },
};

// Tìm nhị phân quality thấp nhất mà vẫn đạt ngưỡng SSIM, thử trên vùng giữa ảnh
async function searchQuality(img, codec, target) {
  const crop = centerCrop(img, 1024);
  const ref = luma(crop);
  let lo = 30, hi = 92, best = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const back = await codec.dec(await codec.enc(crop, mid));
    if (ssim(ref, luma(back), crop.width, crop.height) >= target) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return best;
}

function quantize(img, colors) {
  const pc = utils.PointContainer.fromUint8Array(img.data, img.width, img.height);
  const palette = buildPaletteSync([pc], { colors, paletteQuantization: 'wuquant', colorDistanceFormula: 'euclidean-bt709' });
  const out = applyPaletteSync(pc, palette, { imageQuantization: 'floyd-steinberg', colorDistanceFormula: 'euclidean-bt709' });
  return new ImageData(new Uint8ClampedArray(out.toUint8Array().buffer), img.width, img.height);
}

async function encodePng(img, level, quality) {
  if (level === 'none') return { buffer: await optimisePng(img, { level: 1 }) };
  if (level === 'light') return { buffer: await optimisePng(img, { level: 2 }) };
  // Lượng tử hoá màu kiểu TinyPNG, rồi OxiPNG nén không mất dữ liệu
  const colors = level === 'custom' ? Math.max(16, Math.round((quality / 100) * 256)) : PNG_COLORS[level];
  const q = quantize(img, colors);
  if (level === 'smart') {
    const a = centerCrop(img, 1024), b = centerCrop(q, 1024);
    // Ảnh nhiều dải màu mượt (ảnh chụp) có thể bị vệt – khi đó giữ bản không mất dữ liệu
    if (ssim(luma(a), luma(b), a.width, a.height) < TARGET.smart - 0.02) {
      return { buffer: await optimisePng(img, { level: 2 }), note: 'lossless' };
    }
  }
  return { buffer: await optimisePng(q, { level: 2 }), colors };
}

async function handle({ imageData: img, type, level, quality }) {
  if (type === 'image/png') return encodePng(img, level, quality);
  const codec = codecs[type];
  if (!codec) throw new Error('Định dạng không hỗ trợ: ' + type);
  const q = TARGET[level] ? await searchQuality(img, codec, TARGET[level]) : quality;
  return { buffer: await codec.enc(img, q), quality: q };
}

self.onmessage = async (e) => {
  const { id } = e.data;
  try {
    const res = await handle(e.data);
    self.postMessage({ id, ...res }, [res.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
