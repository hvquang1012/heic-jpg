import { decode, render, encode, isHeic } from './pipeline.js';
import { buildName, uniquePath, baseName, fmtDate } from './rename.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ACCEPT = /\.(heic|heif|jpe?g|png|webp)$/i;
const CONCURRENCY = 3;

const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(2)} MB`);
const pct = (from, to) => Math.round((1 - to / from) * 100);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function stamp() {
  const d = new Date();
  return `${fmtDate(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- Đọc tuỳ chọn từ form ----------
function convertOptions() {
  const r = $('#c-resize').value;
  const custom = +$('#c-resize-value').value;
  return {
    type: $('input[name=c-format]:checked').value,
    quality: +$('#c-quality').value,
    level: $('#c-compress').value,
    resize: r === 'none' ? null : r === 'percent' ? { mode: 'percent', value: custom } : { mode: 'long', value: r === 'custom' ? custom : +r },
    rotate: +$('#c-rotate').value,
    watermark: $('#c-wm-on').checked && $('#c-wm-text').value.trim()
      ? { text: $('#c-wm-text').value.trim(), pos: $('#c-wm-pos').value, size: +$('#c-wm-size').value, opacity: +$('#c-wm-op').value }
      : null,
    rename: {
      enabled: $('#c-rn-on').checked,
      pattern: $('#c-rn-pattern').value,
      start: +$('#c-rn-start').value || 0,
      pad: Math.min(6, Math.max(1, +$('#c-rn-pad').value || 1)),
      noAccent: $('#c-rn-noaccent').checked,
      lower: $('#c-rn-lower').checked,
      dash: $('#c-rn-dash').checked,
    },
    pdfPage: $('#c-pdf-page').value,
  };
}

function compressOptions() {
  const r = $('#z-resize').value;
  return {
    level: $('input[name=z-level]:checked').value,
    quality: +$('#z-quality').value,
    resize: r === 'none' ? null : { mode: 'long', value: +r },
  };
}

// Nén ảnh: giữ định dạng gốc (HEIC → JPG)
function compressType(file) {
  if (/\.png$/i.test(file.name) || file.type === 'image/png') return 'image/png';
  if (/\.webp$/i.test(file.name) || file.type === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

// ---------- Không gian làm việc (mỗi tab một cái) ----------
class Workspace {
  constructor(root, mode) {
    this.root = root;
    this.mode = mode;
    this.items = [];
    this.nextId = 0;
    this.busy = false;
    root.appendChild($('#workspace-tpl').content.cloneNode(true));
    this.list = $('.file-list', root);
    this.toolbar = $('.toolbar', root);
    $('.dz-accept', root).textContent =
      mode === 'convert' ? 'Hỗ trợ HEIC, HEIF, JPG, PNG, WEBP' : 'Hỗ trợ JPG, PNG, WEBP (HEIC sẽ nén thành JPG)';
    if (mode !== 'convert') $('.pdf', root).classList.add('hidden');
    this.bind();
  }

  options() {
    return this.mode === 'convert' ? convertOptions() : compressOptions();
  }

  bind() {
    const r = this.root;
    const dz = $('.dropzone', r);
    const fileInput = $('.file-input', r);
    const dirInput = $('.dir-input', r);
    $('.pick-files', r).onclick = (e) => { e.stopPropagation(); fileInput.click(); };
    $('.pick-dir', r).onclick = (e) => { e.stopPropagation(); dirInput.click(); };
    dz.onclick = () => fileInput.click();
    dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
    fileInput.onchange = () => { this.add([...fileInput.files].map((file) => ({ file, dir: '' }))); fileInput.value = ''; };
    dirInput.onchange = () => {
      this.add([...dirInput.files].map((file) => ({ file, dir: file.webkitRelativePath.split('/').slice(0, -1).join('/') })));
      dirInput.value = '';
    };
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', async (e) => this.add(await filesFromDrop(e.dataTransfer)));

    $('.start', r).onclick = () => this.run();
    $('.zip', r).onclick = () => this.downloadZip();
    $('.pdf', r).onclick = () => this.downloadPdf();
    $('.clear', r).onclick = () => this.clear();
    this.list.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const it = this.items.find((i) => i.id === +btn.closest('.file-row').dataset.id);
      if (btn.dataset.act === 'remove') this.remove(it);
      if (btn.dataset.act === 'compare') openCompare(it, this.options());
    });
  }

  add(entries) {
    const ok = entries.filter(({ file }) => ACCEPT.test(file.name) && !file.name.startsWith('.'));
    const skipped = entries.length - ok.length;
    if (!ok.length) return toast('Không có ảnh hợp lệ (HEIC, JPG, PNG, WEBP)');
    if (skipped) toast(`Bỏ qua ${skipped} file không phải ảnh`);
    for (const { file, dir } of ok) {
      const it = { id: this.nextId++, file, dir, status: 'pending', taken: null };
      this.items.push(it);
      // Đọc ngày chụp từ EXIF cho {ngaychup}
      exifr.parse(file, ['DateTimeOriginal', 'CreateDate'])
        .then((d) => { it.taken = d?.DateTimeOriginal || d?.CreateDate || null; this.render(); })
        .catch(() => {});
    }
    this.render();
  }

  remove(it) {
    if (it.status === 'working') return;
    if (it.url) URL.revokeObjectURL(it.url);
    this.items = this.items.filter((i) => i !== it);
    this.render();
  }

  clear() {
    if (this.busy) return toast('Đang xử lý, vui lòng đợi');
    this.items.forEach((i) => i.url && URL.revokeObjectURL(i.url));
    this.items = [];
    this.render();
  }

  // Tính tên/đường dẫn đầu ra cho tất cả ảnh (giữ thứ tự {stt}, tránh trùng tên)
  assignNames() {
    const o = this.options();
    const used = new Set();
    this.items.forEach((it, index) => {
      let name, ext;
      if (this.mode === 'convert') {
        ext = EXT[o.type];
        name = buildName(o.rename, {
          name: it.file.name, index, taken: it.taken || new Date(it.file.lastModified), width: it.width, height: it.height,
        });
      } else {
        const type = it.outType || compressType(it.file);
        const origExt = it.file.name.match(/\.([^.]+)$/)?.[1] || '';
        ext = compressType(it.file) === type && !isHeic(it.file) ? origExt : EXT[type];
        name = baseName(it.file.name);
      }
      it.outPath = uniquePath(`${it.dir ? it.dir + '/' : ''}${name}.${ext}`, used);
    });
  }

  render() {
    this.assignNames();
    const done = this.items.filter((i) => i.out);
    this.toolbar.classList.toggle('hidden', !this.items.length);
    $('.zip', this.root).disabled = !done.length || this.busy;
    $('.pdf', this.root).disabled = !done.length || this.busy;
    $('.start', this.root).disabled = this.busy;
    $('.start', this.root).textContent = this.busy ? 'Đang xử lý…' : 'Bắt đầu';

    const before = done.reduce((s, i) => s + i.file.size, 0);
    const after = done.reduce((s, i) => s + i.out.size, 0);
    $('.summary', this.root).innerHTML =
      `<b>${this.items.length}</b> ảnh` +
      (done.length ? ` · xong ${done.length} · ${fmtSize(before)} → <b>${fmtSize(after)}</b> <span class="${after < before ? 'good' : ''}">(${after < before ? '-' : '+'}${Math.abs(pct(before, after))}%)</span>` : '');

    this.list.innerHTML = '';
    for (const it of this.items) {
      const row = document.createElement('div');
      row.className = `file-row ${it.status}`;
      row.dataset.id = it.id;
      const status = {
        pending: 'Chờ',
        working: 'Đang xử lý…',
        done: it.out ? `<span class="${it.out.size < it.file.size ? 'good' : ''}">${it.out.size < it.file.size ? '-' : '+'}${Math.abs(pct(it.file.size, it.out.size))}%</span>` : '',
        error: 'Lỗi',
      }[it.status];
      row.innerHTML = `
        <div class="thumb">${it.url ? `<img src="${it.url}" alt="" loading="lazy">` : `<span>${(it.file.name.split('.').pop() || '').toUpperCase()}</span>`}</div>
        <div class="meta">
          <div class="name"></div>
          <div class="sub-line"></div>
        </div>
        <div class="status">${status}</div>
        <div class="row-actions"></div>`;
      $('.name', row).textContent = (it.dir ? it.dir + '/' : '') + it.file.name;
      const sub = $('.sub-line', row);
      const outName = it.outPath.split('/').pop();
      sub.textContent = [
        `→ ${outName}`,
        it.out ? `${fmtSize(it.file.size)} → ${fmtSize(it.out.size)}` : fmtSize(it.file.size),
        it.width ? `${it.width}×${it.height}` : '',
        it.note || '',
        it.error || '',
      ].filter(Boolean).join(' · ');
      const actions = $('.row-actions', row);
      if (it.out) {
        if (this.mode === 'compress') actions.insertAdjacentHTML('beforeend', '<button class="btn small ghost" data-act="compare">So sánh</button>');
        const a = document.createElement('a');
        a.className = 'btn small';
        a.href = it.url;
        a.download = outName;
        a.textContent = 'Tải';
        actions.appendChild(a);
      }
      if (it.status !== 'working') actions.insertAdjacentHTML('beforeend', '<button class="btn small ghost icon" data-act="remove" title="Xoá">✕</button>');
      this.list.appendChild(row);
    }
  }

  async process(it, o) {
    it.status = 'working';
    it.error = it.note = '';
    this.render();
    try {
      const bmp = await decode(it.file);
      const canvas = render(bmp, o);
      bmp.close?.();
      const type = this.mode === 'convert' ? o.type : compressType(it.file);
      const res = await encode(canvas, type, { level: o.level, quality: o.quality });
      let blob = res.blob;
      const notes = [];
      if (res.quality && o.level !== 'none' && o.level !== 'custom') notes.push(`chất lượng ${res.quality}`);
      if (res.colors) notes.push(`${res.colors} màu`);
      if (res.note === 'lossless') notes.push('nén không mất dữ liệu');
      // Nén không có lợi → giữ file gốc (chỉ khi không đổi kích thước/định dạng)
      if (this.mode === 'compress' && !o.resize && !isHeic(it.file) && blob.size >= it.file.size) {
        blob = it.file;
        notes.splice(0, notes.length, 'đã tối ưu sẵn – giữ nguyên');
      }
      if (it.url) URL.revokeObjectURL(it.url);
      it.out = blob;
      it.outType = type;
      it.url = URL.createObjectURL(blob);
      it.width = canvas.width;
      it.height = canvas.height;
      it.note = notes.join(', ');
      it.status = 'done';
    } catch (err) {
      console.error(err);
      it.status = 'error';
      it.error = String(err?.message || err);
    }
    this.render();
  }

  async run() {
    if (this.busy) return;
    const queue = this.items.filter((i) => i.status !== 'working');
    if (!queue.length) return toast('Chưa có ảnh nào');
    const o = this.options();
    if (o.resize && !(o.resize.value > 0)) return toast('Giá trị kích thước không hợp lệ');
    this.busy = true;
    this.render();
    const t0 = performance.now();
    let idx = 0;
    const worker = async () => { while (idx < queue.length) await this.process(queue[idx++], o); };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.busy = false;
    this.render();
    const errors = queue.filter((i) => i.status === 'error').length;
    toast(`Xong ${queue.length - errors}/${queue.length} ảnh trong ${((performance.now() - t0) / 1000).toFixed(1)}s${errors ? ` – ${errors} lỗi` : ''}`);
  }

  async downloadZip() {
    this.assignNames();
    const done = this.items.filter((i) => i.out);
    if (done.length === 1) return download(done[0].out, done[0].outPath.split('/').pop());
    const zip = new JSZip();
    done.forEach((i) => zip.file(i.outPath, i.out));
    toast('Đang tạo ZIP…');
    download(await zip.generateAsync({ type: 'blob' }), `${this.mode === 'convert' ? 'anh-chuyen-doi' : 'anh-nen'}_${stamp()}.zip`);
  }

  async downloadPdf() {
    const done = this.items.filter((i) => i.out);
    const page = convertOptions().pdfPage;
    const { jsPDF } = window.jspdf;
    let pdf = null;
    toast('Đang tạo PDF…');
    for (const it of done) {
      const jpg = it.out.type === 'image/jpeg' ? it.out : await reencodeJpeg(it.out);
      const data = new Uint8Array(await jpg.arrayBuffer());
      const w = it.width * 0.75, h = it.height * 0.75; // px → pt (96 dpi)
      const orient = w > h ? 'l' : 'p';
      if (page === 'fit') {
        if (!pdf) pdf = new jsPDF({ unit: 'pt', format: [w, h], orientation: orient, compress: true });
        else pdf.addPage([w, h], orient);
        pdf.addImage(data, 'JPEG', 0, 0, w, h, undefined, 'NONE');
      } else {
        if (!pdf) pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: orient, compress: true });
        else pdf.addPage('a4', orient);
        const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight(), m = 24;
        const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h);
        pdf.addImage(data, 'JPEG', (pw - w * s) / 2, (ph - h * s) / 2, w * s, h * s, undefined, 'NONE');
      }
    }
    download(pdf.output('blob'), `anh-gop_${stamp()}.pdf`);
  }
}

async function reencodeJpeg(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // PNG trong suốt → nền trắng
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
}

// Đọc cả thư mục khi kéo thả (giữ đường dẫn tương đối)
async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((file) => ({ file, dir: '' }));
  const out = [];
  async function walk(entry, dir) {
    if (entry.isFile) {
      out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), dir });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const sub = dir ? `${dir}/${entry.name}` : entry.name;
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, sub);
      } while (batch.length);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

// ---------- So sánh trước / sau ----------
async function openCompare(it, o) {
  const dlg = $('#compare');
  $('#compare-title').textContent = it.file.name;
  let beforeUrl;
  if (isHeic(it.file)) {
    // Trình duyệt không hiển thị HEIC trực tiếp → giải mã lại ra PNG
    const bmp = await decode(it.file);
    const c = render(bmp, { resize: o.resize });
    bmp.close?.();
    beforeUrl = URL.createObjectURL(await new Promise((r) => c.toBlob(r, 'image/png')));
  } else {
    beforeUrl = URL.createObjectURL(it.file);
  }
  $('#compare-before').src = beforeUrl;
  $('#compare-after').src = it.url;
  setCompare(50);
  dlg.showModal();
  dlg.addEventListener('close', () => URL.revokeObjectURL(beforeUrl), { once: true });
}
function setCompare(v) {
  $('#compare-range').value = v;
  $('#compare-before').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $('.compare-line').style.left = `${v}%`;
}

// ---------- Lưu tuỳ chọn giữa các lần mở ----------
function persist() {
  const load = (k) => { try { return localStorage.getItem('heictool:' + k); } catch { return null; } };
  const save = (k, v) => { try { localStorage.setItem('heictool:' + k, v); } catch { /* bỏ qua */ } };
  for (const el of $$('[data-persist]')) {
    const v = load(el.id);
    if (v !== null) el.type === 'checkbox' ? (el.checked = v === '1') : (el.value = v);
    el.addEventListener('change', () => save(el.id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value));
  }
  for (const name of ['c-format', 'z-level']) {
    const v = load(name);
    const el = v && $(`input[name=${name}][value="${v}"]`);
    if (el) el.checked = true;
    $$(`input[name=${name}]`).forEach((r) => r.addEventListener('change', () => save(name, r.value)));
  }
}

// ---------- Khởi tạo ----------
function syncUi() {
  $('#c-quality-val').textContent = $('#c-quality').value;
  $('#z-quality-val').textContent = $('#z-quality').value;
  $('#c-wm-size-val').textContent = $('#c-wm-size').value;
  $('#c-wm-op-val').textContent = $('#c-wm-op').value;
  const r = $('#c-resize').value;
  $('#c-resize-custom').classList.toggle('hidden', r !== 'custom' && r !== 'percent');
  $('#c-resize-value').placeholder = r === 'percent' ? '%' : 'px';
  const auto = ['smart', 'light', 'strong'].includes($('#c-compress').value);
  // PNG là nén không mất dữ liệu → thanh chất lượng không có tác dụng
  $('#c-quality').disabled = auto || $('input[name=c-format]:checked').value === 'image/png';
  $('#c-compress-hint').classList.toggle('hidden', !auto);
  $('#c-wm').classList.toggle('disabled', !$('#c-wm-on').checked);
  $('#c-rn').classList.toggle('disabled', !$('#c-rn-on').checked);
  $('#z-quality-row').classList.toggle('hidden', $('input[name=z-level]:checked').value !== 'custom');
}

function init() {
  persist();
  const spaces = {};
  for (const el of $$('.workspace')) spaces[el.dataset.mode] = new Workspace(el, el.dataset.mode);

  $$('.tab').forEach((b) => (b.onclick = () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${b.dataset.tab}`));
  }));

  // Đổi tuỳ chọn → cập nhật giao diện + xem trước tên file
  $('#convert-options').addEventListener('input', () => { syncUi(); spaces.convert.render(); });
  $('#compress-options').addEventListener('input', syncUi);
  $('#convert-options').addEventListener('change', () => { syncUi(); spaces.convert.render(); });
  $('#compress-options').addEventListener('change', syncUi);

  $('#c-rn-chips').addEventListener('click', (e) => {
    const tok = e.target.dataset.token;
    if (!tok) return;
    const inp = $('#c-rn-pattern');
    const pos = inp.selectionStart ?? inp.value.length;
    inp.value = inp.value.slice(0, pos) + tok + inp.value.slice(inp.selectionEnd ?? pos);
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    inp.focus();
  });

  $('#compare-range').oninput = (e) => setCompare(+e.target.value);
  $('#compare-close').onclick = () => $('#compare').close();
  syncUi();
}

init();
