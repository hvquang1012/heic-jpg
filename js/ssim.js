// SSIM đơn giản trên kênh sáng (luma), cửa sổ 8x8 không chồng lấn.
// Đủ chính xác để chọn mức nén "mắt thường không thấy khác".

export function luma(img) {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

export function ssim(a, b, width, height) {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const B = 8;
  let total = 0;
  let n = 0;
  for (let y = 0; y + B <= height; y += B) {
    for (let x = 0; x + B <= width; x += B) {
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let j = 0; j < B; j++) {
        let p = (y + j) * width + x;
        for (let i = 0; i < B; i++, p++) {
          const va = a[p], vb = b[p];
          sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
        }
      }
      const N = B * B;
      const ma = sa / N, mb = sb / N;
      const va = saa / N - ma * ma;
      const vb = sbb / N - mb * mb;
      const cov = sab / N - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return n ? total / n : 1;
}

// Cắt vùng giữa ảnh ở độ phân giải gốc (giữ nguyên chi tiết để đánh giá nén)
export function centerCrop(img, size) {
  const w = Math.min(size, img.width);
  const h = Math.min(size, img.height);
  if (w === img.width && h === img.height) return img;
  const x0 = (img.width - w) >> 1;
  const y0 = (img.height - h) >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return new ImageData(out, w, h);
}
