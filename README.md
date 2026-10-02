# YouTube Check

Công cụ nội bộ (Next.js + Vercel) lấy **video của một kênh YouTube** theo nhiều tiêu chí
rồi **đẩy vào Google Sheet** đúng định dạng. Khóa bằng mật khẩu, chạy thủ công.

## Tính năng

- Nhập link kênh (`/channel/`, `/@handle`, `/user/`, `/c/`).
- **Bộ lọc:** khoảng ngày (N ngày gần nhất **hoặc** from–to), view / like / comment tối thiểu,
  thời lượng min–max, **engagement %** min, **views/ngày** (velocity) min.
- **Ghi Sheet 6 cột gốc** `STT · Tieu de · Thoi luong · Luot xem · Dang luc · Link`; tùy chọn
  thêm cột từ G: Likes, Comments, Engagement %, Views/ngày, Ngày đăng, Category, Channel.
- Tạo tab mới; tab trống tự tạo header; sai định dạng báo lỗi cụ thể (cột nào sai).
- **Pool nhiều YouTube API key** (Settings ⚙️) — chọn key ít dùng nhất còn quota, theo dõi
  quota/ngày theo giờ Pacific.
- **Google OAuth server-side** (refresh token, mã hóa trong Mongo) — đăng nhập một lần, không
  hết hạn 1h, ghi được mọi sheet tài khoản đó sở hữu (không cần share thủ công).

## Cấu hình (Environment variables)

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| `MONGODB_URI` | ✅ | Lưu lockout đăng nhập, pool key, Google refresh token |
| `ADMIN_PASSWORD` | ✅ | Mật khẩu mở khóa |
| `SESSION_SECRET` | nên | Ký cookie + khóa mã hóa token; đổi = logout + gỡ Google |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✅ (để ghi Sheet qua OAuth) | OAuth Web client |
| `YOUTUBE_API_KEY` | tùy | Fallback; nên thêm key qua Settings để pool |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | tùy | Fallback ghi Sheet nếu không dùng OAuth |

### Google OAuth (Sheets)

1. Google Cloud → Credentials → **OAuth client ID → Web application**.
2. **Authorized redirect URIs:**
   - `http://localhost:3000/api/google/callback`
   - `https://<domain-vercel>/api/google/callback`
3. Bật **Google Sheets API**. OAuth consent: thêm scope `.../auth/spreadsheets`; khi còn
   "Testing" thêm email của bạn vào Test users.
4. Đặt `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` → trên web bấm **Kết nối Google**.

### YouTube API key

Mở ⚙️ Settings, dán key `AIza…`. Thêm nhiều key để tăng quota (pool tự xoay theo mức dùng).

## Chạy local

```bash
npm install
# điền .env (đã có sẵn MONGODB_URI + ADMIN_PASSWORD)
npm run dev
```

## Deploy Vercel

Import repo → thêm toàn bộ env ở trên (nhớ thêm redirect URI domain Vercel vào OAuth client) →
deploy. Không cần cron.

## Kiến trúc

```
src/lib/
  auth.ts, loginGuard.ts, mongodb.ts, http.ts   # hạ tầng (từ HealthCheck)
  crypto.ts                                      # AES-256-GCM cho refresh token
  googleOAuth.ts                                 # OAuth code + refresh (từ TubeHook)
  youtube.ts                                     # fetch + filter + quota accounting
  sheets.ts                                      # ghi Sheet, cột G+, validate format
  models/{Settings,LoginAttempt}.ts              # pool key + quota + Google token
src/app/api/
  auth/            google/{start,callback,status,disconnect}
  run/  settings/
```

## Giới hạn

- Vercel Hobby timeout 10s (Pro 60s, đã set `maxDuration=60`). Bộ lọc ngày cho dừng sớm nên
  thường < 10s.
- Quota YouTube mặc định 10.000 unit/key/ngày (reset nửa đêm giờ Pacific).
