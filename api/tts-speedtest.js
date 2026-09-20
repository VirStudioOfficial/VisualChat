// api/tts-speedtest.js — تست جدا و موقت سرعت TTS، برای تشخیص علت کندی صدای
// تماس زنده. از همان GEMINI_API_KEYS پروژه استفاده می‌کند (چیزی به بیرون
// فرستاده نمی‌شود). بعد از رفع مشکل، این فایل قابل حذف است.
//
// استفاده: مرورگر یا curl را به همین آدرس با GET بزن:
//   https://virtual-chat-seven.vercel.app/api/tts-speedtest

export const config = { runtime: "edge" };

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TTS_MODEL = "gemini-3.1-flash-tts-preview";

async function testTTS(key, text) {
  const t0 = Date.now();
  const r = await fetch(`${API}/${TTS_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Sulafat" } } },
      },
    }),
  });
  const fetchMs = Date.now() - t0;
  const status = r.status;
  let ok = r.ok;
  if (r.ok) await r.json(); // برای احتساب زمان parse هم
  const totalMs = Date.now() - t0;
  return { text, status, ok, fetchMs, totalMs };
}

export default async function handler() {
  const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
    .split(",").map((k) => k.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  if (keys.length === 0) {
    return new Response(JSON.stringify({ error: "no GEMINI_API_KEYS on server" }), { status: 500 });
  }
  const key = keys[0];

  const samples = ["سلام", "سلام! روزت بخیر.", "چطور می‌تونم کمکت کنم؟"];
  const results = [];
  for (const s of samples) {
    try {
      results.push(await testTTS(key, s));
    } catch (e) {
      results.push({ text: s, error: String(e?.message || e) });
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
