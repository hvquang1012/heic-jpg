// Đổi tên hàng loạt theo mẫu: {ten} {stt} {ngay} {ngaychup} {rong} {cao}

export function removeAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

const pad2 = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export const baseName = (name) => name.replace(/\.[^.]+$/, '');

// ctx: { name, index, taken: Date|null, width, height }
export function buildName(opts, ctx) {
  if (!opts.enabled || !opts.pattern.trim()) return baseName(ctx.name);
  const vars = {
    ten: baseName(ctx.name),
    stt: String(opts.start + ctx.index).padStart(opts.pad, '0'),
    ngay: fmtDate(new Date()),
    ngaychup: ctx.taken ? fmtDate(ctx.taken) : 'khong-ro-ngay',
    rong: ctx.width ?? '…',
    cao: ctx.height ?? '…',
  };
  let s = opts.pattern.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (opts.noAccent) s = removeAccents(s);
  if (opts.lower) s = s.toLowerCase();
  if (opts.dash) s = s.trim().replace(/\s+/g, '-');
  s = s.replace(/[\\/:*?"<>|]/g, '_');
  return s || baseName(ctx.name);
}

// Tránh trùng tên trong cùng thư mục: anh.jpg, anh-1.jpg, anh-2.jpg...
export function uniquePath(path, used) {
  let p = path;
  for (let n = 1; used.has(p.toLowerCase()); n++) p = path.replace(/(\.[^./]+)?$/, `-${n}$1`);
  used.add(p.toLowerCase());
  return p;
}
