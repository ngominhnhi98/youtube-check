/**
 * Gemini client — pool key + tụt model, port từ iz_pipeline (core/keypool.py,
 * core/gemini_models.py, engine/runners/_poolcall.py) sang REST.
 *
 * Khác bản Python ở hai chỗ, cố ý:
 *  - Key lấy từ env GEMINI_KEYS thay vì đọc pool trên Atlas: tool này chạy serverless,
 *    thêm một round-trip DB chỉ để lấy vài chuỗi là không đáng.
 *  - KHÔNG nằm chờ hết cửa sổ RPM (60s). Route Next.js chỉ có 60s tổng, nằm chờ là
 *    chết cả request; ở đây dính RPM thì bỏ key đó sang key kế. 7 key × 15 RPM là
 *    thừa cho một lần sinh từ khoá (1 request).
 *
 * Phân biệt RPM/RPD vẫn giữ vì nó quyết định có nên thử lại key đó trong cùng lần
 * chạy hay không — gộp chung là vứt oan key còn tốt (xem _poolcall.classify).
 */

// Pool lấy từ iz_pipeline (Atlas youtubedb.gemini_keys), tier free. Đọc từ env
// GEMINI_KEYS = "id:key,id:key,..." (id tùy chọn) — không hardcode vì repo public.
function loadKeys(): { id: string; value: string }[] {
  return (process.env.GEMINI_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s, i) => {
      const at = s.indexOf(":");
      return at > 0
        ? { id: s.slice(0, at), value: s.slice(at + 1) }
        : { id: `key-${i + 1}`, value: s };
    });
}

// Thứ tự = ưu tiên chất lượng của iz_pipeline (gemini_models.CATALOG rank 1→8).
// Model nào key không có sẽ trả 404 và ta tự nhảy sang model kế, nên để dư ID an
// toàn hơn thiếu.
const MODELS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
];

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiError extends Error {}

type Kind = "ok" | "rpm" | "rpd" | "denied" | "notfound" | "error";

/** Lỗi Gemini → nhóm xử lý. Phân biệt RPM/RPD là mấu chốt (xem _poolcall.classify). */
function classify(status: number, body: string): Kind {
  const low = body.toLowerCase();
  if (status === 429) {
    // Google ghi rõ loại hạn mức trong message: PerDay/per day → hết lượt NGÀY.
    if (
      low.replace(/\s/g, "").includes("perday") ||
      low.includes("requests per day") ||
      low.includes("daily")
    )
      return "rpd";
    return "rpm"; // mặc định coi là RPM: key vẫn dùng lại được sau ~1 phút
  }
  if (status === 403 || low.includes("permission_denied")) return "denied";
  if (status === 404 || low.includes("not_found") || low.includes("no longer available"))
    return "notfound";
  if (status === 400 && low.includes("api key not valid")) return "denied";
  return "error";
}

interface GenerateBody {
  contents: { parts: { text: string }[] }[];
  generationConfig?: Record<string, unknown>;
  systemInstruction?: { parts: { text: string }[] };
}

/** Con trỏ xoay vòng key giữa các request trong cùng một tiến trình. */
let cursor = 0;

async function callOnce(
  key: string,
  model: string,
  body: GenerateBody,
  timeoutMs: number
): Promise<{ kind: Kind; text?: string; detail?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const raw = await res.text();
    if (!res.ok) return { kind: classify(res.status, raw), detail: raw.slice(0, 300) };

    const json = JSON.parse(raw) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      promptFeedback?: { blockReason?: string };
    };
    const blocked = json.promptFeedback?.blockReason;
    if (blocked) return { kind: "error", detail: `Gemini chặn prompt (${blocked}).` };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) return { kind: "error", detail: "Gemini trả về rỗng." };
    return { kind: "ok", text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: "error", detail: msg.includes("abort") ? "Gemini quá hạn chờ." : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gọi Gemini và ép trả JSON. Đi lần lượt model tốt → kém; trong mỗi model xoay
 * vòng hết các key còn sống mới hạ model.
 */
export async function generateJson<T>(opts: {
  prompt: string;
  system?: string;
  schema: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<T> {
  const body: GenerateBody = {
    contents: [{ parts: [{ text: opts.prompt }] }],
    generationConfig: {
      temperature: 1,
      responseMimeType: "application/json",
      responseSchema: opts.schema,
    },
    ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] }, } : {}),
  };

  const GEMINI_KEYS = loadKeys();
  if (GEMINI_KEYS.length === 0) throw new GeminiError("Chưa cấu hình GEMINI_KEYS.");

  const dead = new Set<string>(); // "<key_id>|<model>" hỏng HẲN với model đó
  let lastDetail = "";

  for (const model of MODELS) {
    let notFound = false;
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
      const k = GEMINI_KEYS[(cursor + i) % GEMINI_KEYS.length];
      if (dead.has(`${k.id}|${model}`)) continue;

      const r = await callOnce(k.value, model, body, opts.timeoutMs ?? 25_000);
      if (r.kind === "ok") {
        cursor = (cursor + i + 1) % GEMINI_KEYS.length; // key kế cho request sau
        try {
          return JSON.parse(r.text!) as T;
        } catch {
          throw new GeminiError("Gemini trả về JSON không hợp lệ.");
        }
      }
      lastDetail = r.detail ?? r.kind;
      if (r.kind === "notfound") {
        // Model không tồn tại với key này → gần như chắc chắn cả pool cũng vậy.
        notFound = true;
        break;
      }
      // rpm/rpd/denied/error: bỏ cặp (key, model) này, thử key kế.
      dead.add(`${k.id}|${model}`);
    }
    if (notFound) continue;
  }

  throw new GeminiError(
    `Không gọi được Gemini (mọi key/model đều lỗi)${lastDetail ? `: ${lastDetail}` : ""}`
  );
}
