# MD Studio – chuyển HEIC & nén ảnh

Web tool chạy **100% trên máy bạn**: ảnh không bị tải lên đâu cả, dùng được **không cần Internet**.

## Cách mở

### Cách 1 – Link web (khuyên dùng)

👉 **https://app.noithatminhduc.com**

Ảnh vẫn được xử lý ngay trên máy bạn, không tải lên server nào. Trong Safari có thể chọn *File → Add to Dock* để mở như một app.

Bật link (chỉ làm 1 lần): repo trên GitHub → **Settings → Pages** → *Source*: **Deploy from a branch** → chọn nhánh chứa code, thư mục **/ (root)** → **Save**. Đợi 1–2 phút là link chạy.
Lưu ý: repo **private** cần gói GitHub Pro mới bật được Pages; nếu không, để repo public (code tool không chứa thông tin cá nhân).

#### Tên miền riêng
File `CNAME` trong repo khai báo tên miền `app.noithatminhduc.com`. Cần thêm ở nơi quản lý DNS của `noithatminhduc.com`:

| Loại | Tên/Host | Giá trị |
|---|---|---|
| CNAME | `app` | `hvquang1012.github.io` |

Sau đó vào **Settings → Pages**: đợi *DNS check successful* rồi tick **Enforce HTTPS**. Nếu dùng Cloudflare, để bản ghi ở chế độ **DNS only** (mây xám). Link cũ `hvquang1012.github.io/heic-jpg` tự chuyển sang tên miền mới.

### Cách 2 – Chạy offline bằng `start.command`

1. Tải repo về (`git clone` hoặc *Code → Download ZIP* rồi giải nén).
2. **Lần đầu**, macOS sẽ chặn file vì không có chữ ký Apple (*"start.command" Not Opened*). Chọn 1 trong các cách:
   - Mở **Terminal**, gõ `bash ` (có dấu cách), kéo file `start.command` vào cửa sổ Terminal rồi nhấn Enter; **hoặc**
   - Gỡ chặn cho cả thư mục: `xattr -dr com.apple.quarantine ~/Downloads/heic-jpg` (sửa đường dẫn cho đúng) rồi double-click lại; **hoặc**
   - Double-click → **Done** → *System Settings → Privacy & Security* → kéo xuống, bấm **Open Anyway**.
3. Từ lần sau chỉ cần double-click **`start.command`** → trình duyệt tự mở `http://localhost:8765`.
4. Dùng xong thì đóng cửa sổ Terminal để tắt.

> Không mở `index.html` trực tiếp (double-click): trình duyệt chặn WebAssembly khi chạy qua `file://`.

Dùng tốt nhất trên **Safari** (đọc HEIC trực tiếp, rất nhanh); Chrome/Firefox dùng libheif (WASM) với màu chính xác.

## Tính năng

### Tab “Chuyển đổi”
| Tính năng | Chi tiết |
|---|---|
| Đầu vào | HEIC, HEIF, JPG, PNG, WEBP – chọn file, chọn **cả thư mục**, hoặc kéo thả |
| Đầu ra | **JPG / PNG / WEBP**, tải từng ảnh, **ZIP** (giữ nguyên cấu trúc thư mục), **PDF gộp** (vừa khít ảnh hoặc A4) |
| Chất lượng | 40–100, hoặc **nén thêm** Thông minh / Nhẹ / Mạnh |
| Kích thước | Giữ nguyên, cạnh dài 2048/1600/1080 px, tuỳ chỉnh px hoặc % (thu nhỏ nhiều bước để giữ nét) |
| Xoay | 90° phải, 180°, 90° trái |
| Watermark | Chữ, 5 vị trí, cỡ chữ theo % chiều rộng, độ đậm |
| Đổi tên hàng loạt | Mẫu `{ten}` `{stt}` `{ngay}` `{ngaychup}` `{rong}x{cao}`, số bắt đầu, số chữ số (001), bỏ dấu tiếng Việt, chữ thường, khoảng trắng → `-`; **xem trước tên mới**; tự thêm `-1`, `-2` nếu trùng |
| Bảo mật | EXIF & vị trí GPS luôn được xoá |
| Tốc độ | Xử lý 3 ảnh song song, nén chạy trong Web Worker (giao diện không bị đơ) |

### Tab “Nén ảnh” (kiểu TinyJPG / TinyPNG)
| Định dạng | Cách nén |
|---|---|
| JPG | **MozJPEG** – nhỏ hơn encoder thường ~20–30% ở cùng chất lượng |
| PNG | **Lượng tử hoá màu** (256/128 màu + dithering, như TinyPNG) + **OxiPNG** |
| WEBP | **libwebp** |
| HEIC | Nén thành JPG |

**Chế độ Thông minh**: thử nhiều mức chất lượng trên vùng giữa ảnh (độ phân giải gốc) và chọn mức thấp nhất vẫn đạt **SSIM ≥ 0.985** so với ảnh gốc → dung lượng nhỏ mà mắt thường không thấy khác. Mức **Nhẹ** (SSIM ≥ 0.993), **Mạnh** (≥ 0.97), **Tuỳ chỉnh** (tự chọn chất lượng).

- Hiện dung lượng trước/sau, % tiết kiệm, mức chất lượng đã chọn.
- Nút **So sánh**: kéo thanh trượt để xem ảnh gốc và ảnh nén cạnh nhau.
- Nếu bản nén không nhỏ hơn thì giữ nguyên file gốc.

Tuỳ chọn được ghi nhớ cho lần mở sau.

## Cấu trúc

```
index.html          giao diện (2 tab)
styles.css          giao diện sáng/tối theo macOS
js/main.js          danh sách ảnh, hàng đợi song song, ZIP, PDF, so sánh
js/pipeline.js      giải mã HEIC → xoay → resize → watermark → mã hoá; pool Web Worker
js/heic.worker.js   giải mã HEIC bằng libheif (WASM)
js/codec.worker.js  MozJPEG / OxiPNG / libwebp / lượng tử hoá, tìm chất lượng theo SSIM
js/ssim.js          tính SSIM
js/rename.js        đổi tên hàng loạt
vendor/             thư viện đóng gói sẵn (chạy offline)
start.command       mở tool trên macOS
```

Thư viện (trong `vendor/`): libheif-js 1.23.2 (LGPL-3.0, giải mã HEIC – bản gốc, không sửa), JSZip 3.10.1 (MIT), jsPDF 2.5.2 (MIT), exifr 7.1.3 (MIT), image-q 4.0.0 (MIT), @jsquash/jpeg 1.6.0, @jsquash/webp 1.5.0, @jsquash/oxipng 2.3.0, wasm-feature-detect 1.9.0 (Apache-2.0).
`vendor/jsquash/*/encode.js|optimise.js` được sửa 1 dòng import `wasm-feature-detect` sang đường dẫn tương đối để chạy trong Worker không cần bundler.

## Hướng phát triển bản Premium (bán)

Khi muốn thương mại hoá như iLoveIMG/convertify4u: thêm server nhỏ + **PayOS** (QR chuyển khoản VN) với 3 gói 30 ngày 49.000đ / 1 năm 299.000đ / trọn đời 599.000đ, cấp license (JWT), bản Free giới hạn 5 ảnh/lượt, 20 ảnh/ngày, không có WEBP/PDF/nén thông minh/watermark/đổi tên, có quảng cáo.
