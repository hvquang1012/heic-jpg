// Web Worker giải mã HEIC bằng libheif (WASM) – màu chính xác, tự xoay theo metadata ảnh.
import libheifFactory from '../vendor/libheif/libheif-bundle.mjs';

const libheif = libheifFactory();
const decoder = new libheif.HeifDecoder();

function display(image, width, height) {
  return new Promise((resolve, reject) =>
    image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) =>
      d ? resolve(d) : reject(new Error('Giải mã HEIC thất bại'))
    )
  );
}

self.onmessage = async (e) => {
  const { id, buffer } = e.data;
  let images = [];
  try {
    images = decoder.decode(new Uint8Array(buffer));
    if (!images.length) throw new Error('Không đọc được file HEIC (hỏng hoặc không hỗ trợ)');
    // Ảnh đầu tiên là ảnh chính (burst/Live Photo chỉ lấy khung chính)
    const img = images[0];
    const width = img.get_width();
    const height = img.get_height();
    const { data } = await display(img, width, height);
    self.postMessage({ id, width, height, data: data.buffer }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  } finally {
    images.forEach((i) => i.free());
  }
};
