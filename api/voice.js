// api/voice.js — ویس «نوبتی» روی Vercel (بدون WebSocket، فقط HTTP streaming)
//
// چرا این‌طوری؟ Vercel WebSocket سرور نگه نمی‌داره و Render/Deno/Cloudflare
// از ایران مشکل دارن. این endpoint هر «نوبت» صحبت رو جدا می‌گیره:
//
//   اپ: صدای کاربر (WAV/PCM base64) + تاریخچه  ──POST──▶  /api/voice
//   سرور: ۱) Gemini (ورودی صوتی) → متن پاسخ، استریم
//         ۲) هر جمله‌ی کامل → Gemini TTS → صدای PCM
//   اپ: خط‌به‌خط NDJSON می‌خونه و صدا رو همون لحظه پخش می‌کنه
//
// فرمت پاسخ (NDJSON، هر خط یه JSON):
//   {"type":"user_text","text":"..."}      متن فهمیده‌شده‌ی حرف کاربر
//   {"type":"text","text":"..."}           تکه‌ی متن پاسخ (برای زیرنویس)
//   {"type":"audio","data":"<base64 PCM 24kHz mono 16bit>"}
//   {"type":"tool","name":"end_call"|"change_app_setting","args":{...}}
//   {"type":"done"}
//   {"type":"error","message":"..."}
//
// متغیر محیطی: همان‌ که chat.js می‌خواند: GEMINI_API_KEYS (چند کلید با کاما)
//              یا GEMINI_API_KEY. کلیدها تصادفی چرخانده می‌شوند و اگر یکی
//              401/403/429 یا خطای سرور داد، خودکار سراغ بعدی می‌رود.
// اختیاری:     VOICE_SECRET  (اگه ست شه، اپ باید هدر x-voice-secret بفرسته)

export const config = { runtime: "edge" };

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TEXT_MODEL = "gemini-3.6-flash";
const TTS_MODEL = "gemini-3.1-flash-tts-preview";
const MAX_AUDIO_B64 = 6_000_000; // ~4.5MB خام؛ سقف بدنه‌ی Edge

const TOOLS = [{
  functionDeclarations: [
    {
      name: "end_call",
      description: "اگر کاربر خداحافظی کرد یا خواست تماس تمام شود، برای قطع تماس صدا بزن.",
      parameters: { type: "object", properties: {} },
    },
    {
      name: "change_app_setting",
      description: "تم یا فونت برنامه را فقط وقتی کاربر صریحاً خواست تغییر بده.",
      parameters: {
        type: "object",
        properties: {
          setting: { type: "string", enum: ["theme", "font"] },
          value: { type: "string", description: "theme: light|dark|auto ؛ font: نام فونت" },
        },
        required: ["setting", "value"],
      },
    },
  ],
}];

const enc = new TextEncoder();
const line = (obj) => enc.encode(JSON.stringify(obj) + "\n");

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }

  // FIX (401 UNAUTHENTICATED): سایت کلیدها را «با کاما» در GEMINI_API_KEYS
  // نگه می‌دارد؛ قبلاً کل رشته را یک کلید حساب می‌کردم.
  const keys = shuffle(
    (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "")
      .split(",").map((k) => k.trim().replace(/^["']|["']$/g, "")).filter(Boolean),
  );
  if (keys.length === 0) return json({ error: "no GEMINI_API_KEYS on server" }, 500);

  const secret = process.env.VOICE_SECRET;
  if (secret && req.headers.get("x-voice-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const {
    audio,                       // base64 خام، بدون پیشوند data:
    mimeType = "audio/wav",      // اپ WAV (16k mono) می‌فرسته
    systemInstruction = "",
    history = [],                // [{role:"user"|"model", text}]
    voiceName = "Sulafat",
    lang = "فارسی ایرانی",
    firstTurn = false,
  } = body || {};

  if (!audio || typeof audio !== "string") return json({ error: "audio missing" }, 400);
  if (audio.length > MAX_AUDIO_B64) return json({ error: "audio too long" }, 413);

  const sys =
    `${systemInstruction}\n\n` +
    `این یک گفتگوی صوتیِ زنده است: کوتاه، محاوره‌ای و مستقیم جواب بده. ` +
    `فقط به ${lang} صحبت کن مگر کاربر صراحتاً زبان دیگری بخواهد. ` +
    (firstTurn
      ? `این اولین نوبت تماس است؛ می‌توانی سلام کنی.`
      : `سلام/احوالپرسی مجدد نکن.`) +
    `\nاول دقیقاً حرف کاربر را بین [[U: و ]] بنویس، بعد پاسخت را بنویس. مثال: [[U: سلام حالت چطوره]] سلام، خوبم!`;

  const contents = [
    ...history.slice(-20).map((h) => ({
      role: h.role === "model" ? "model" : "user",
      parts: [{ text: String(h.text || "").slice(0, 2000) }],
    })),
    { role: "user", parts: [{ inlineData: { mimeType, data: audio } }] },
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (o) => { try { controller.enqueue(line(o)); } catch {} };

      // TTS جمله‌ها به‌ترتیب؛ صف سریالی تا ترتیب پخش بهم نخوره
      let goodKey = keys[0]; // بعد از موفقیت متن، با کلیدِ سالم جایگزین می‌شود
      let ttsChain = Promise.resolve();
      const speak = (sentence) => {
        const t = sentence.trim();
        if (!t) return;
        ttsChain = ttsChain.then(async () => {
          try {
            const pcm = await tts(keys, goodKey, t, voiceName);
            if (pcm) send({ type: "audio", data: pcm });
          } catch (e) {
            send({ type: "error", message: "tts: " + (e?.message || e) });
          }
        });
      };

      try {
        const { r, key: usedKey } = await fetchWithKeys(keys, `${API}/${TEXT_MODEL}:streamGenerateContent?alt=sse`, {
          systemInstruction: { parts: [{ text: sys }] },
          contents,
          tools: TOOLS,
          generationConfig: { thinkingConfig: { thinkingLevel: "low" } },
        });
        goodKey = usedKey;
        if (!r.ok || !r.body) {
          const t = await r.text().catch(() => "");
          send({ type: "error", message: `gemini ${r.status}: ${t.slice(0, 300)}` });
          send({ type: "done" });
          controller.close();
          return;
        }

        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let acc = "";          // کل متن تا الان
        let userSent = false;  // [[U: ... ]] استخراج شد؟
        let spoken = 0;        // تا کدوم اندیس متن رو به TTS دادیم

        const flushSentences = (final) => {
          // فقط بعد از تگ کاربر
          let text = acc;
          if (!userSent) return;
          const start = text.indexOf("]]") + 2;
          text = text.slice(Math.max(start, spoken));
          const re = /[^.!?؟۔\n]+[.!?؟۔\n]+/g;
          let m, last = 0;
          while ((m = re.exec(text)) !== null) {
            speak(m[0]);
            send({ type: "text", text: m[0] });
            last = re.lastIndex;
          }
          spoken = Math.max(start, spoken) + last;
          if (final) {
            const rest = text.slice(last).trim();
            if (rest) { speak(rest); send({ type: "text", text: rest }); }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const ln = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!ln.startsWith("data:")) continue;
            let j;
            try { j = JSON.parse(ln.slice(5)); } catch { continue; }
            const parts = j?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) {
              if (p.functionCall) {
                send({ type: "tool", name: p.functionCall.name, args: p.functionCall.args || {} });
              }
              if (typeof p.text === "string" && !p.thought) {
                acc += p.text;
                if (!userSent) {
                  const m = acc.match(/\[\[U:\s*([\s\S]*?)\]\]/);
                  if (m) {
                    userSent = true;
                    send({ type: "user_text", text: m[1].trim() });
                  }
                }
                flushSentences(false);
              }
            }
          }
        }
        // اگه مدل تگ [[U: را نفرستاد، کل متن رو پاسخ حساب می‌کنیم
        if (!userSent) {
          userSent = true;
          acc = "[[U:]]" + acc;
        }
        flushSentences(true);
        await ttsChain;
      } catch (e) {
        send({ type: "error", message: String(e?.message || e) });
      }
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...cors(),
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function tts(keys, goodKey, text, voiceName) {
  // اول کلیدی که برای متن جواب داد؛ اگر نشد بقیه
  const ordered = [goodKey, ...keys.filter((k) => k !== goodKey)];
  const { r } = await fetchWithKeys(ordered, `${API}/${TTS_MODEL}:generateContent`, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
}

// کلیدها را به‌ترتیب امتحان می‌کند؛ روی خطای احراز هویت/سهمیه/سرور می‌رود
// سراغ بعدی. اولین پاسخ «قابل‌قبول» (یا آخرین خطا) برمی‌گردد.
async function fetchWithKeys(keys, url, payload) {
  let last = null;
  for (const key of keys) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
      });
      if (r.ok || ![400, 401, 403, 429, 500, 502, 503, 504].includes(r.status)) return { r, key };
      // 400 فقط وقتی «کلید نامعتبر» است دوباره امتحان شود، نه خطای درخواست
      if (r.status === 400) {
        const t = await r.clone().text().catch(() => "");
        if (!/API key|API_KEY/i.test(t)) return { r, key };
      }
      last = { r, key };
    } catch (e) {
      last = { r: new Response(String(e?.message || e), { status: 502 }), key };
    }
  }
  return last;
}

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-voice-secret",
  };
}
function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...cors(), "content-type": "application/json" },
  });
}
