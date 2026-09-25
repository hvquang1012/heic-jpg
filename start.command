#!/bin/bash
# Double-click để mở HEIC Tool trên macOS (chạy web server cục bộ, không cần Internet)
cd "$(dirname "$0")"
# Gỡ cờ "tải từ Internet" để macOS không chặn các file của tool về sau
xattr -dr com.apple.quarantine . 2>/dev/null
PORT=8765
URL="http://localhost:$PORT"

if lsof -i :$PORT >/dev/null 2>&1; then
  open "$URL"; exit 0
fi

(sleep 1; open "$URL") &
echo "HEIC Tool đang chạy tại $URL  (đóng cửa sổ này hoặc Ctrl+C để tắt)"
if python3 -c "" >/dev/null 2>&1; then
  exec python3 -m http.server $PORT --bind 127.0.0.1
elif command -v ruby >/dev/null 2>&1; then
  exec ruby -run -e httpd . -p $PORT -b 127.0.0.1
else
  echo "Không tìm thấy python3/ruby. Cài Command Line Tools: xcode-select --install"
  read -r -p "Nhấn Enter để đóng..."
fi
