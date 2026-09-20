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
  const t0 = Date.now();
  const rid = Math.random().toString(36).slice(2, 8);
  const tlog = (label, extra = "") => console.log(`[voice ${rid}] +${Date.now() - t0}ms ${label} ${extra}`);

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
  tlog("body parsed");

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
  tlog("audio validated", `b64len=${audio.length}`);

  const sys =
    `${systemInstruction}\n\n` +
    `این یک گفتگوی صوتیِ زنده است: حداکثر ۲ تا ۳ جمله‌ی کوتاه، محاوره‌ای و مستقیم. ` +
    `بدون مقدمه، بدون تکرار سؤال کاربر، بدون «حتماً»/«البته» و فهرست. ` +
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

      // FIX (تأخیر بین جمله‌ها): قبلاً TTS هر جمله بعد از تمام‌شدن جمله‌ی
      // قبلی شروع می‌شد (صف سریالی) و بین هر دو جمله ۱ تا ۲ ثانیه مکث
      // می‌افتاد. حالا همه‌ی جمله‌ها «همزمان» به TTS می‌روند و فقط
      // «فرستادن به اپ» به ترتیب انجام می‌شود؛ تا جمله‌ی ۱ پخش می‌شود،
      // جمله‌ی ۲ و ۳ از قبل آماده‌اند.
      let goodKey = keys[0]; // بعد از موفقیت متن، با کلیدِ سالم جایگزین می‌شود
      const ttsJobs = [];
      let sendChain = Promise.resolve();
      let ttsCallNo = 0;
      const speak = (sentence) => {
        const t = sentence.trim();
        if (!t) return;
        const callNo = ++ttsCallNo;
        const ttsT0 = Date.now();
        tlog(`tts#${callNo}: start`, `chars=${t.length}`);
        const job = tts(keys, goodKey, t, voiceName).then((pcm) => {
          tlog(`tts#${callNo}: done`, `${Date.now() - ttsT0}ms`);
          return pcm;
        }).catch((e) => {
          tlog(`tts#${callNo}: FAILED`, `${Date.now() - ttsT0}ms ${e?.message || e}`);
          send({ type: "error", message: "tts: " + (e?.message || e) });
          return null;
        });
        ttsJobs.push(job);
        sendChain = sendChain.then(async () => {
          const pcm = await job;
          // FIX (متن ۵-۶ ثانیه زودتر از صدا نمایش داده می‌شد): متن هر تکه
          // «داخل همان پیام صدا» می‌رود تا اپ بتواند دقیقاً وقتی پخش آن
          // تکه شروع می‌شود، متنش را هم نشان بدهد. اگر TTS شکست خورد،
          // متن را جداگانه می‌فرستیم تا کاربر لااقل آن را بخواند.
          if (pcm) { tlog(`tts#${callNo}: sending audio to client`); send({ type: "audio", data: pcm, text: t }); }
          else send({ type: "text", text: t });
        });
      };

      try {
        // FIX (تأخیر ~4s تا اولین توکن): thinkingConfig حتی با سطح "low" یه
        // مرحله‌ی پردازش پنهان قبل از شروع استریم به مدل تحمیل می‌کرد که در
        // نتیجه‌ی نهایی دیده نمی‌شد ولی شروع پاسخ رو کند می‌کرد. برای تماس
        // صوتی زنده (جواب‌های کوتاه محاوره‌ای) تفکر پس‌زمینه لازم نیست.
        tlog("text fetch: start");
        const { r, key: usedKey } = await fetchWithKeys(keys, `${API}/${TEXT_MODEL}:streamGenerateContent?alt=sse`, {
          systemInstruction: { parts: [{ text: sys }] },
          contents,
          tools: TOOLS,
        });
        tlog("text fetch: got response headers", `status=${r?.status}`);
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

        // FIX (تأخیر اولین صدا): منتظر «نقطه» نمی‌مانیم. اولین تکه را
        // به‌محض رسیدن به یک مرز طبیعی (ویرگول/نقطه/؟/!) و حداقل ~۱۲
        // حرف می‌فرستیم تا TTS زودتر شروع شود؛ تکه‌های بعدی را کمی
        // بلندتر می‌بریم تا تعداد درخواست‌ها (و مکث بینشان) کم بماند.
        let chunkNo = 0;
        const flushSentences = (final) => {
          if (!userSent) return;
          const start = Math.max(acc.indexOf("]]") + 2, spoken);
          let text = acc.slice(start);
          // FIX (تأخیر اولین صدا): 12 حرف قبلی هم مکث محسوسی قبل از رسیدن
          // اولین TTS اضافه می‌کرد؛ با 6 حرف زودتر می‌فرستیم (جمله‌های خیلی
          // کوتاه فارسی مثل «سلام!» با 6 حرف هم قابل تشخیصن).
          const minLen = chunkNo === 0 ? 6 : 40;
          const re = /[^.!?؟۔،,\n]+[.!?؟۔،,\n]+/g;
          let m, consumed = 0, pieceStart = 0;
          let piece = "";
          while ((m = re.exec(text)) !== null) {
            piece += m[0];
            consumed = re.lastIndex;
            if (piece.trim().length >= minLen) {
              speak(piece);
              chunkNo++;
              piece = "";
              pieceStart = consumed;
            }
          }
          // آنچه هنوز به حد کافی نرسیده برای فلاش بعدی نگه داشته می‌شود
          spoken = start + pieceStart;
          if (final) {
            const rest = text.slice(pieceStart).trim();
            if (rest) speak(rest);
            spoken = acc.length;
          }
        };

        let firstChunkLogged = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!firstChunkLogged) { firstChunkLogged = true; tlog("text stream: first chunk received"); }
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
                    tlog("user_text extracted, sending + starting flushSentences");
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
        await sendChain;
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
  const t0 = Date.now();
  // اول کلیدی که برای متن جواب داد؛ اگر نشد بقیه
  const ordered = [goodKey, ...keys.filter((k) => k !== goodKey)];
  const { r } = await fetchWithKeys(ordered, `${API}/${TTS_MODEL}:generateContent`, {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  });
  console.log(`[voice tts] fetch done after ${Date.now() - t0}ms status=${r?.status}`);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  console.log(`[voice tts] json parsed, total ${Date.now() - t0}ms`);
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
