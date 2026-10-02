/**
 * Thị trường để nhắm khi tìm kênh: một NGÔN NGỮ + (tuỳ chọn) một QUỐC GIA.
 *
 * Dùng chung client/server — file này không được import gì chạy riêng server.
 *
 * - `lang` đi vào `relevanceLanguage` của search.list, và là ngôn ngữ Gemini phải
 *   viết truy vấn. Mã theo đúng YouTube (zh-Hant/zh-Hans chứ không phải zh).
 * - `region` đi vào `regionCode`. Cố ý để trống ở các thị trường trải nhiều nước
 *   (Ả Rập, Tây Ban Nha…): ghim một nước là bỏ sót phần còn lại — script tìm kênh
 *   Ả Rập trước đây chạy không regionCode vì đúng lý do này.
 *
 * Lưu ý: regionCode chỉ ưu tiên video XEM ĐƯỢC ở nước đó, không bảo đảm kênh là
 * của nước đó. Ngôn ngữ của truy vấn mới là tín hiệu mạnh.
 */
export interface Market {
  id: string;
  label: string;
  lang: string;
  region: string;
  /** Tên ngôn ngữ nói với Gemini. */
  langName: string;
}

export const MARKETS: Market[] = [
  { id: "en-US", label: "🇺🇸 Anh (Mỹ)", lang: "en", region: "US", langName: "tiếng Anh" },
  { id: "en-GB", label: "🇬🇧 Anh (UK)", lang: "en", region: "GB", langName: "tiếng Anh" },
  { id: "ja", label: "🇯🇵 Nhật", lang: "ja", region: "JP", langName: "tiếng Nhật" },
  { id: "ko", label: "🇰🇷 Hàn", lang: "ko", region: "KR", langName: "tiếng Hàn" },
  { id: "zh-TW", label: "🇹🇼 Trung phồn thể", lang: "zh-Hant", region: "TW", langName: "tiếng Trung phồn thể" },
  { id: "zh-CN", label: "🇨🇳 Trung giản thể", lang: "zh-Hans", region: "", langName: "tiếng Trung giản thể" },
  { id: "th", label: "🇹🇭 Thái", lang: "th", region: "TH", langName: "tiếng Thái" },
  { id: "id", label: "🇮🇩 Indonesia", lang: "id", region: "ID", langName: "tiếng Indonesia" },
  { id: "fil", label: "🇵🇭 Philippines", lang: "en", region: "PH", langName: "tiếng Anh hoặc Tagalog" },
  { id: "hi", label: "🇮🇳 Ấn Độ", lang: "hi", region: "IN", langName: "tiếng Hindi" },
  { id: "es", label: "🌎 Tây Ban Nha", lang: "es", region: "", langName: "tiếng Tây Ban Nha" },
  { id: "pt-BR", label: "🇧🇷 Bồ Đào Nha (Brazil)", lang: "pt", region: "BR", langName: "tiếng Bồ Đào Nha" },
  { id: "fr", label: "🇫🇷 Pháp", lang: "fr", region: "FR", langName: "tiếng Pháp" },
  { id: "de", label: "🇩🇪 Đức", lang: "de", region: "DE", langName: "tiếng Đức" },
  { id: "ru", label: "🇷🇺 Nga", lang: "ru", region: "", langName: "tiếng Nga" },
  { id: "tr", label: "🇹🇷 Thổ Nhĩ Kỳ", lang: "tr", region: "TR", langName: "tiếng Thổ Nhĩ Kỳ" },
  { id: "ar", label: "🌍 Ả Rập", lang: "ar", region: "", langName: "tiếng Ả Rập" },
  { id: "vi", label: "🇻🇳 Việt Nam", lang: "vi", region: "VN", langName: "tiếng Việt" },
];

export const MARKET_BY_ID = new Map(MARKETS.map((m) => [m.id, m]));
