// pages/api/chat.js

/*
|--------------------------------------------------------------------------
| Logger - structured, no secrets ever printed
|--------------------------------------------------------------------------
| Every log line is one JSON object so it's easy to grep/parse in Vercel
| logs. Never pass raw API keys, full file base64, or full user history to
| this — only short, safe summaries.
*/
const log = {
    _base(level, event, meta) {
        try {
            const safeMeta = { ...meta };
            // Extra safety net: strip anything that looks like a key/token by name,
            // in case a caller accidentally spreads a bigger object into meta.
            for (const k of Object.keys(safeMeta)) {
                if (/key|token|secret|authorization/i.test(k)) delete safeMeta[k];
            }
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level,
                event,
                ...safeMeta
            }));
        } catch (_) {
            // Logging must never crash the request.
        }
    },
    info(event, meta) { this._base('info', event, meta); },
    warn(event, meta) { this._base('warn', event, meta); },
    error(event, meta) { this._base('error', event, meta); }
};

/*
|--------------------------------------------------------------------------
| Key Rotation Manager
|--------------------------------------------------------------------------
| Keeps a per-process (best-effort, resets on cold start) failure counter for
| each API key so keys that are erroring a lot get tried last, instead of a
| pure random shuffle every time. This is intentionally in-memory only: it
| does not need a database, and never logs the key itself (only its index).
*/
const __keyFailureCounts = new Map(); // key -> consecutive failure count

function rotateKeysByHealth(keys) {
    // Randomize first (keeps load spread across otherwise-equal keys),
    // then stable-sort healthier keys first.
    const shuffled = keys
        .map(k => ({ k, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ k }) => k);

    return shuffled.sort((a, b) => {
        const fa = __keyFailureCounts.get(a) || 0;
        const fb = __keyFailureCounts.get(b) || 0;
        return fa - fb;
    });
}

function markKeyResult(key, ok) {
    if (ok) {
        __keyFailureCounts.set(key, 0);
    } else {
        __keyFailureCounts.set(key, (__keyFailureCounts.get(key) || 0) + 1);
    }
}

function keyLabel(keys, key) {
    // Never log the actual key - just a stable, non-reversible index label.
    const idx = keys.indexOf(key);
    return `key#${idx + 1}/${keys.length}`;
}

/*
|--------------------------------------------------------------------------
| Context / History size management
|--------------------------------------------------------------------------
| Gemini has a large context window, but sending an ever-growing raw history
| on every turn is wasteful, slow, and can eventually hit request-size or
| token limits. We cap how many recent turns we send verbatim, and fold
| anything older than that into one short summary turn so continuity isn't
| lost. This is a lightweight heuristic summary (not a model call) so it
| never adds latency or extra API cost.
*/
const MAX_HISTORY_TURNS = 24;       // most recent user+model turns kept verbatim
const MAX_HISTORY_CHARS = 60000;    // rough safety cap on total history text size

function summarizeOldTurns(oldTurns) {
    if (!oldTurns.length) return null;
    const topics = oldTurns
        .filter(t => t.role === 'user')
        .map(t => String(t.text || t.content || '').slice(0, 80).trim())
        .filter(Boolean)
        .slice(-8); // last few user topics from the trimmed-off section

    if (!topics.length) return null;

    return (
        `[خلاصه‌ی مکالمه‌ی قبلی - برای صرفه‌جویی در حجم، پیام‌های قدیمی‌تر خلاصه شدند]\n` +
        `موضوعاتی که قبلاً مطرح شده: ` +
        topics.map(t => `«${t}»`).join('، ')
    );
}

function trimHistoryForContext(history) {
    if (!Array.isArray(history) || history.length === 0) return [];

    // Never trim away pinned/persona turns (added by the frontend at index 0-1).
    const personaTurns = history.filter(h => h.__virtualPersona);
    const regularTurns = history.filter(h => !h.__virtualPersona);

    let working = regularTurns;

    if (working.length > MAX_HISTORY_TURNS) {
        const cut = working.length - MAX_HISTORY_TURNS;
        const dropped = working.slice(0, cut);
        working = working.slice(cut);

        const summaryText = summarizeOldTurns(dropped);
        if (summaryText) {
            working = [
                { role: 'user', text: summaryText },
                { role: 'model', text: 'باشه، زمینه‌ی قبلی رو در نظر می‌گیرم.' },
                ...working
            ];
        }
    }

    // Hard character-size safety net, in case a few turns are each very long
    // (e.g. pasted file contents already folded into history by the client).
    let totalChars = working.reduce((sum, t) => sum + String(t.text || t.content || '').length, 0);
    while (totalChars > MAX_HISTORY_CHARS && working.length > 2) {
        const removed = working.shift();
        totalChars -= String(removed.text || removed.content || '').length;
    }

    return [...personaTurns, ...working];
}

function shouldSearchWeb(userText) {
    if (!userText || typeof userText !== 'string') return false;

    const cleanText = userText.trim().toLowerCase();
    if (cleanText.length < 3) return false;

    const ignoreList = [
        'سلام', 'سلامم', 'درود', 'چطوری', 'خوبی', 'صبح بخیر', 'عصر بخیر',
        'شب بخیر', 'ممنون', 'مرسی', 'چخبر', 'خداحافظ', 'بای', 'اوکی', 'باشه'
    ];

    const normalized = cleanText.replace(/[!.،,؟?]/g, '').trim();
    const words = normalized.split(/\s+/).filter(Boolean);
    const firstWord = words[0];

    if (words.length <= 3 && (ignoreList.includes(normalized) || ignoreList.includes(firstWord))) {
        return false;
    }

    const allowedKeywords = [
        'سرچ', 'جستجو', 'گوگل', 'اینترنت', 'توی وب', 'بررسی کن', 'سرچ کن',
        'قیمت', 'چنده', 'نرخ', 'دلار', 'طلا', 'سکه', 'ارز', 'بیت کوین',
        'پلی استیشن', 'اخبار', 'خبر', 'رویداد', 'نتیجه بازی', 'خرید',
        'امشب', 'آخرین', 'جدیدترین', 'امروز'
    ];

    return allowedKeywords.some(kw => normalized.includes(kw));
}


/*
|--------------------------------------------------------------------------
| تشخیص درخواست ساخت تصویر
|--------------------------------------------------------------------------
*/

function shouldGenerateImage(userText) {
    if (!userText || typeof userText !== 'string') return false;

    const text = userText
        .toLowerCase()
        .replace(/[؟?!،,.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text || text.length < 3) return false;

    // تشخیص هوشمندتر با استفاده از Regex برای پوشش فاصله‌ها و جملات مختلف
    const imageRegex = /(عکس|تصویر|ایمیج|لوگو|پوستر|کاور|نقاشی)\s*.*\s*(بساز|درست کن|تولید کن|ایجاد کن|بده|طراحی کن|رندر کن)|(generate|create|make|draw|render)\s+.*\s*(image|picture|photo|logo)/i;

    const simpleKeywords = ['تصویرسازی', 'تصویر سازی', 'یه عکس', 'یک عکس', 'یه تصویر', 'یک تصویر'];

    return imageRegex.test(text) || simpleKeywords.some(kw => text.includes(kw));
}


/*
|--------------------------------------------------------------------------
| تشخیص مدل تصویر
|--------------------------------------------------------------------------
*/

function isImageModel(modelName) {
    if (!modelName || typeof modelName !== 'string') return false;

    const name = modelName.toLowerCase();

    return (
        name.includes('imagen') ||
        name.includes('image') ||
        name.includes('flash-image')
    );
}


/*
|--------------------------------------------------------------------------
| ترجمه پرامپت تصویر به انگلیسی
|--------------------------------------------------------------------------
*/

async function translateImagePrompt(prompt, geminiKeys) {
    if (!prompt || !geminiKeys || geminiKeys.length === 0) {
        return prompt || 'A high quality image';
    }

    const translationPrompt = `
Translate the following Persian image-generation request into a detailed,
natural English prompt suitable for an AI image generator.

Important:
- Preserve every important visual detail.
- Preserve characters, objects, environment, lighting, camera angle and style.
- Do NOT answer the user.
- Do NOT explain anything.
- Do NOT add unwanted objects.
- Return ONLY the English image-generation prompt.

User request:
${prompt}
`;

    for (let i = 0; i < geminiKeys.length; i++) {
        const key = geminiKeys[i];

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            let response;

            try {
                response = await fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': key
                        },
                        body: JSON.stringify({
                            contents: [
                                {
                                    role: 'user',
                                    parts: [
                                        {
                                            text: translationPrompt
                                        }
                                    ]
                                }
                            ]
                        }),
                        signal: controller.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) continue;

            const data = await response.json();

            const translated =
                data?.candidates?.[0]?.content?.parts
                    ?.map(p => p?.text || '')
                    .join('')
                    .trim();

            if (translated) {
                log.info('image.prompt_translated', {});
                return translated;
            }

        } catch (error) {
            log.warn('image.translation_failed', {
                keyIndex: i + 1,
                message: error?.message || String(error)
            });
        }
    }

    log.warn('image.translation_fallback', { reason: 'all keys failed, using original prompt' });
    return prompt;
}


/*
|--------------------------------------------------------------------------
| عنوان‌گذاری هوشمند چت
|--------------------------------------------------------------------------
| Sidebar titles previously came from truncating the user's first message
| to 20 chars — since almost every chat opens with "سلام..."/"سلام..."
| etc, the whole history list ends up reading as identical entries, which
| is a big part of why the UI feels unpolished next to ChatGPT/Claude
| (they generate a real short title from the actual topic). This mirrors
| translateImagePrompt()'s pattern: one small, fast, non-streamed call to
| the lite model, with a strict "return ONLY the title" instruction and a
| safe fallback to the old truncation behavior if every key fails.
*/
async function generateChatTitle(userText, botText, geminiKeys) {
    const fallback = (userText || '').trim().slice(0, 20) + '...';
    if (!userText || !geminiKeys || geminiKeys.length === 0) return fallback;

    const titlePrompt = `
یک عنوان بسیار کوتاه (حداکثر ۴ تا ۶ کلمه، به فارسی) برای این گفتگو بساز که
موضوع اصلی را نشان بدهد — نه یک جمله کامل، فقط یک عنوان مثل تیتر.

قوانین:
- فقط خودِ عنوان را برگردان، بدون گیومه، بدون توضیح، بدون نقطه در انتها.
- از کلمات عمومی مثل «سلام» یا «گفتگو» به‌تنهایی استفاده نکن؛ موضوع واقعی را بگیر.
- اگر پیام کاربر فقط سلام و احوال‌پرسی است و موضوع مشخصی ندارد، عنوانی مثل
  «گفتگوی عمومی» برگردان.

پیام کاربر:
${String(userText).slice(0, 500)}

پاسخ ربات (اگر موجود بود):
${String(botText || '').slice(0, 500)}
`;

    for (let i = 0; i < geminiKeys.length; i++) {
        const key = geminiKeys[i];

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            let response;

            try {
                response = await fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': key
                        },
                        body: JSON.stringify({
                            contents: [
                                {
                                    role: 'user',
                                    parts: [{ text: titlePrompt }]
                                }
                            ]
                        }),
                        signal: controller.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) continue;

            const data = await response.json();

            let title =
                data?.candidates?.[0]?.content?.parts
                    ?.map(p => p?.text || '')
                    .join('')
                    .trim();

            if (title) {
                // Strip stray quotes/markdown the model sometimes adds despite
                // the "no quotes" instruction, and hard-cap length as a safety
                // net so a runaway response can't blow up the sidebar layout.
                title = title.replace(/^["'«»]+|["'«»]+$/g, '').replace(/\.$/, '').trim();
                if (title.length > 40) title = title.slice(0, 40).trim() + '…';
                if (title) {
                    log.info('chat.title_generated', {});
                    return title;
                }
            }

        } catch (error) {
            log.warn('chat.title_generation_failed', {
                keyIndex: i + 1,
                message: error?.message || String(error)
            });
        }
    }

    log.warn('chat.title_generation_fallback', { reason: 'all keys failed, using truncated fallback' });
    return fallback;
}


/*
|--------------------------------------------------------------------------
| تولید تصویر با Pollinations
|--------------------------------------------------------------------------
*/

async function generateImage(prompt) {
    const hosts = [
        `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`,
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
    ];

    let lastError = null;
    let lastErrorType = 'image_error';

    for (const baseUrl of hosts) {
        try {
            const seed = Math.floor(Math.random() * 1000000000);

            const imageUrl =
                `${baseUrl}` +
                `?width=1920` +
                `&height=1080` +
                `&seed=${seed}` +
                `&model=flux` +
                `&format=jpg`;

            log.info('image.request', { host: baseUrl });

            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                60000
            );

            let response;

            try {
                response = await fetch(imageUrl, {
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                lastError = new Error(
                    `Pollinations returned ${response.status}`
                );
                lastErrorType = response.status === 429 ? 'timeout' : 'image_error';

                log.warn('image.host_failed', {
                    status: response.status,
                    statusText: response.statusText
                });

                continue;
            }

            const arrayBuffer = await response.arrayBuffer();

            if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                lastError = new Error('Empty image response');
                lastErrorType = 'image_error';
                continue;
            }

            const buffer = Buffer.from(arrayBuffer);

            let contentType =
                response.headers.get('content-type') ||
                'image/jpeg';

            if (!contentType.startsWith('image/')) {
                contentType = 'image/jpeg';
            }

            const base64 = buffer.toString('base64');

            log.info('image.generated', { bytes: buffer.length, contentType });

            return {
                success: true,
                url: imageUrl,
                base64,
                contentType,
                size: buffer.length
            };

        } catch (error) {
            lastError = error;
            lastErrorType = error?.name === 'AbortError' ? 'timeout' : 'network_error';

            log.error('image.generation_error', { message: error?.message || String(error) });
        }
    }

    const finalError = lastError || new Error('Image generation failed');
    finalError.errorType = lastErrorType;
    throw finalError;
}


/*
|--------------------------------------------------------------------------
| پاسخ تصویر
|--------------------------------------------------------------------------
*/

async function handleImageGeneration({
    prompt,
    geminiKeys,
    wantsStream,
    res
}) {
    log.info('image.request_detected', { promptPreview: String(prompt || '').slice(0, 120) });

    const translatedPrompt = await translateImagePrompt(
        prompt,
        geminiKeys
    );

    log.info('image.prompt_ready', { promptPreview: String(translatedPrompt || '').slice(0, 120) });

    const image = await generateImage(translatedPrompt);

    /*
     * این Markdown برای فرانت‌اندهای فعلی که متن Markdown
     * را رندر می‌کنند بسیار مهم است.
     */
    const markdownImage =
        `![Generated Image](${image.url})`;

    /*
     * اگر فرانت‌اند در آینده image را مستقیم بخواند،
     * این ساختار را هم دارد.
     */

    const imagePayload = {
        type: 'image',
        filename: 'image.jpg',
        url: image.url,
        mimeType: 'image/jpeg',
        base64: image.base64,
        dataUrl: `data:image/jpeg;base64,${image.base64}`,
        prompt: translatedPrompt
    };

    if (wantsStream) {
        res.setHeader(
            'Content-Type',
            'text/event-stream; charset=utf-8'
        );

        res.setHeader(
            'Cache-Control',
            'no-cache, no-transform'
        );

        res.setHeader(
            'Connection',
            'keep-alive'
        );

        res.setHeader(
            'X-Accel-Buffering',
            'no'
        );

        res.setHeader(
            'X-Image-Generated',
            'true'
        );

        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        /*
         * اول اطلاعات ساختاریافته تصویر
         */
        res.write(
            `data: ${JSON.stringify({
                image: imagePayload
            })}\n\n`
        );

        if (typeof res.flush === 'function') {
            res.flush();
        }

        /*
         * سپس Markdown برای سازگاری با UI فعلی
         */
        res.write(
            `data: ${JSON.stringify({
                text: markdownImage
            })}\n\n`
        );

        if (typeof res.flush === 'function') {
            res.flush();
        }

        res.write(
            `data: ${JSON.stringify({
                done: true,
                image: imagePayload
            })}\n\n`
        );

        if (typeof res.flush === 'function') {
            res.flush();
        }

        return res.end();
    }

    return res.status(200).json({
        candidates: [
            {
                content: {
                    parts: [
                        {
                            text: markdownImage
                        }
                    ]
                }
            }
        ],

        /*
         * خروجی اصلی تصویر
         */
        image: imagePayload,

        /*
         * برای راحتی فرانت‌اند
         */
        imageUrl: image.url,
        imageDataUrl: imagePayload.dataUrl,

        type: 'image'
    });
}


/*
|--------------------------------------------------------------------------
| Tavily
|--------------------------------------------------------------------------
*/

async function fetchTavilyResults(query, tavilyKeys) {
    if (!tavilyKeys || tavilyKeys.length === 0) {
        return null;
    }

    for (let i = 0; i < tavilyKeys.length; i++) {
        const currentKey = tavilyKeys[i];

        try {
            const controller = new AbortController();

            const timeoutId = setTimeout(
                () => controller.abort(),
                6000
            );

            let response;

            try {
                response = await fetch(
                    'https://api.tavily.com/search',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            api_key: currentKey,
                            query,
                            search_depth: 'basic',
                            max_results: 4
                        }),
                        signal: controller.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                continue;
            }

            const data = await response.json();

            if (
                data.results &&
                data.results.length > 0
            ) {
                log.info('search.succeeded', { keyIndex: i + 1, resultCount: data.results.length });

                return data.results
                    .map(
                        r =>
                            `عنوان: ${r.title}\n` +
                            `منبع: ${r.url}\n` +
                            `محتوا: ${r.content}`
                    )
                    .join('\n\n---\n\n');
            }

        } catch (error) {
            log.error('search.key_failed', {
                keyIndex: i + 1,
                message: error?.message || String(error)
            });
        }
    }

    return null;
}


/*
|--------------------------------------------------------------------------
| MAIN API HANDLER
|--------------------------------------------------------------------------
*/

// CORS: default to '*' to preserve current behavior for any existing
// deployment, but if the operator sets ALLOWED_ORIGIN in the environment,
// lock requests to that origin instead. This is opt-in so nothing breaks
// for the current setup unless the env var is explicitly added.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Requests bigger than this almost certainly indicate an oversized
// file/base64 payload slipping past frontend checks; reject early instead
// of doing expensive work first.
const MAX_REQUEST_BYTES = 12 * 1024 * 1024; // 12MB

async function handler(req, res) {
    res.setHeader(
        'Access-Control-Allow-Origin',
        ALLOWED_ORIGIN
    );

    res.setHeader(
        'Access-Control-Allow-Methods',
        'POST, OPTIONS'
    );

    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            error: {
                message: 'متد درخواست پشتیبانی نمی‌شود.'
            }
        });
    }

    const requestStartedAt = Date.now();

    try {
        // Basic payload-size guard. req.body is already parsed by the framework
        // by the time we get here in most Next.js/Vercel setups, so we
        // approximate size from the serialized body rather than a raw stream.
        try {
            const approxBytes = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
            if (approxBytes > MAX_REQUEST_BYTES) {
                log.warn('request.too_large', { approxBytes });
                return res.status(413).json({
                    error: {
                        message: 'حجم درخواست خیلی زیاده. لطفاً فایل کوچک‌تری بفرست.',
                        type: 'file_too_large',
                        stage: 'request_validation',
                        detail: `approxBytes=${approxBytes}`
                    }
                });
            }
        } catch (_) {
            // If we can't measure it, don't block the request over this alone.
        }

        const wantsStream =
            req.body?.stream === true ||
            req.body?.stream === 'true';

        const {
            userName,
            text,
            rawText,
            file,
            webSearch,
            history: rawHistory,
            model
        } = req.body || {};

        const history = trimHistoryForContext(rawHistory);

        const searchQueryBase =
            rawText &&
            String(rawText).trim()
                ? String(rawText).trim()
                : (text || '');

        /*
        |--------------------------------------------------------------------------
        | API Keys
        |--------------------------------------------------------------------------
        */

        const rawGeminiKeys =
            process.env.GEMINI_API_KEYS ||
            process.env.GEMINI_API_KEY ||
            '';

        const geminiKeys = rotateKeysByHealth(
            rawGeminiKeys
                .split(',')
                .map(k => k.trim())
                .filter(Boolean)
        );

        /*
        |--------------------------------------------------------------------------
        | Chat title generation (lightweight, non-streamed, separate mode)
        |--------------------------------------------------------------------------
        | Called once per chat right after the first exchange, from the
        | frontend. Kept as an early return in the same handler/file (no new
        | route) so it reuses the same key pool/health-tracking, but it never
        | touches history trimming, file handling, web search, or the main
        | streaming path — just a fast title guess.
        */
        if (req.body?.mode === 'title') {
            const title = await generateChatTitle(
                req.body?.userText,
                req.body?.botText,
                geminiKeys
            );
            return res.status(200).json({ title });
        }

        const rawTavilyKeys =
            process.env.TAVILY_API_KEYS ||
            process.env.TAVILY_API_KEY ||
            '';

        const tavilyKeys =
            rawTavilyKeys
                .split(',')
                .map(k => k.trim())
                .filter(Boolean);

        if (geminiKeys.length === 0) {
            log.error('config.no_gemini_keys', {});
            return res.status(500).json({
                error: {
                    message: 'سرویس هوش مصنوعی موقتاً پیکربندی نشده است. لطفاً بعداً امتحان کن.',
                    type: 'api_error',
                    stage: 'config'
                }
            });
        }

        log.info('request.received', {
            hasFile: !!file || (Array.isArray(req.body?.files) && req.body.files.length > 0),
            webSearch: !!webSearch,
            model: model || 'default',
            historyTurns: history.length,
            stream: wantsStream
        });

        /*
        |--------------------------------------------------------------------------
        | فایل‌ها
        |--------------------------------------------------------------------------
        */

        const incomingFiles =
            Array.isArray(req.body?.files)
                ? req.body.files
                : (file ? [file] : []);

        // Guard: reject any individual text file content that is absurdly large.
        // The frontend already caps this at 300KB, but the backend must not
        // trust the client - a hand-crafted request could skip that check.
        const MAX_TEXT_FILE_CHARS = 300 * 1024;

        const textFiles =
            incomingFiles.filter(
                f =>
                    f &&
                    f.mode === 'text' &&
                    typeof f.content === 'string' &&
                    f.content.length <= MAX_TEXT_FILE_CHARS
            );

        const oversizedTextFiles =
            incomingFiles.filter(
                f =>
                    f &&
                    f.mode === 'text' &&
                    typeof f.content === 'string' &&
                    f.content.length > MAX_TEXT_FILE_CHARS
            );

        if (oversizedTextFiles.length > 0) {
            log.warn('file.rejected_too_large_text', {
                names: oversizedTextFiles.map(f => f.name || 'unknown')
            });
        }

        const binaryFiles =
            incomingFiles.filter(
                f =>
                    f &&
                    f.base64
            );

        /*
        |--------------------------------------------------------------------------
        | History
        |--------------------------------------------------------------------------
        */

        let contents = [];

        if (
            history &&
            Array.isArray(history) &&
            history.length > 0
        ) {
            contents = history.map(item => ({
                role:
                    item.role === 'user'
                        ? 'user'
                        : 'model',

                parts: [
                    {
                        text:
                            String(
                                item.text ||
                                item.content ||
                                ''
                            )
                    }
                ]
            }));
        } else if (searchQueryBase) {
            contents.push({
                role: 'user',
                parts: [
                    {
                        text: searchQueryBase
                    }
                ]
            });
        }

        if (contents.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'متن ورودی خالی است.',
                    type: 'invalid_file',
                    stage: 'request_validation'
                }
            });
        }

        /*
        |--------------------------------------------------------------------------
        | تشخیص تصویر
        |--------------------------------------------------------------------------
        */

        const requestedImageModel =
            isImageModel(model);

        const autoImageRequest =
            shouldGenerateImage(
                searchQueryBase
            );

        /*
         * اگر مدل تصویر انتخاب شده باشد یا متن کاربر
         * درخواست ساخت تصویر باشد، مستقیماً وارد image pipeline شو.
         */
        const isImageRequest =
            requestedImageModel ||
            autoImageRequest;

        log.info('request.classified', {
            model: model || 'default',
            autoImageRequest,
            requestedImageModel,
            isImageRequest
        });

        res.setHeader(
            'X-Image-Request',
            String(isImageRequest)
        );

        /*
        |--------------------------------------------------------------------------
        | اگر درخواست تصویر است، اصلاً آن را به مدل متنی نده
        |--------------------------------------------------------------------------
        */

        if (isImageRequest) {
            try {
                return await handleImageGeneration({
                    prompt: searchQueryBase,
                    geminiKeys,
                    wantsStream,
                    res
                });

            } catch (imageError) {
                log.error('image.final_error', {
                    message: imageError?.message || String(imageError)
                });

                const errorPayload = {
                    message: 'ساخت تصویر انجام نشد. سرویس تصویر موقتاً در دسترس نیست.',
                    type: imageError?.errorType || 'image_error',
                    stage: 'image_generation',
                    detail: imageError?.message || String(imageError)
                };

                if (wantsStream) {
                    res.setHeader(
                        'Content-Type',
                        'text/event-stream; charset=utf-8'
                    );

                    res.write(
                        `data: ${JSON.stringify({
                            error: errorPayload
                        })}\n\n`
                    );

                    res.write(
                        `data: ${JSON.stringify({
                            done: true
                        })}\n\n`
                    );

                    return res.end();
                }

                return res.status(500).json({
                    error: errorPayload
                });
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Web Search
        |--------------------------------------------------------------------------
        */

        const isSearchNeeded =
            shouldSearchWeb(
                searchQueryBase
            );

        res.setHeader(
            'X-Search-Performed',
            String(isSearchNeeded)
        );

        if (
            isSearchNeeded &&
            searchQueryBase
        ) {
            log.info('search.executing', { queryPreview: searchQueryBase.slice(0, 100) });

            const searchResults =
                await fetchTavilyResults(
                    searchQueryBase,
                    tavilyKeys
                );

            const lastIndex =
                contents.length - 1;

            if (
                searchResults &&
                lastIndex >= 0 &&
                contents[lastIndex].role === 'user'
            ) {
                const textPart =
                    contents[lastIndex]
                        .parts
                        .find(
                            p =>
                                p.text !== undefined
                        );

                const webBlock =
                    `\n\n[نتایج جستجوی وب]:\n` +
                    `${searchResults}\n\n` +
                    `[دستورالعمل: با کمک اطلاعات فوق ` +
                    `پاسخ دقیق و به‌روز ارائه بده.]`;

                if (textPart) {
                    textPart.text += webBlock;
                } else {
                    contents[lastIndex]
                        .parts
                        .push({
                            text: webBlock
                        });
                }
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Text Files
        |--------------------------------------------------------------------------
        */

        if (
            textFiles.length > 0 &&
            contents.length > 0
        ) {
            const lastIndex =
                contents.length - 1;

            if (
                contents[lastIndex].role === 'user'
            ) {
                const textPart =
                    contents[lastIndex]
                        .parts
                        .find(
                            p =>
                                p.text !== undefined
                        );

                const fileBlocks =
                    textFiles
                        .map(
                            f =>
                                `\n\n` +
                                `[محتوای فایل: ${f.name || 'file'}]\n` +
                                '```\n' +
                                f.content +
                                '\n```\n' +
                                `[پایان محتوای فایل: ${f.name || 'file'}]`
                        )
                        .join('');

                if (textPart) {
                    textPart.text += fileBlocks;
                } else {
                    contents[lastIndex]
                        .parts
                        .push({
                            text: fileBlocks
                        });
                }
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Binary Files
        |--------------------------------------------------------------------------
        */

        // Backend-side size cap for binary payloads (images/video/PDF), since the
        // frontend's own limits can be bypassed by a direct API call.
        const MAX_BINARY_BASE64_CHARS = 15 * 1024 * 1024; // ~15MB of base64 text

        for (const bf of binaryFiles) {
            const lastIndex =
                contents.length - 1;

            if (
                lastIndex < 0 ||
                contents[lastIndex].role !== 'user'
            ) {
                break;
            }

            if (typeof bf.base64 !== 'string' || bf.base64.length > MAX_BINARY_BASE64_CHARS) {
                log.warn('file.rejected_too_large', { name: bf.name || 'unknown' });
                continue;
            }

            const base64Data =
                bf.base64.includes(',')
                    ? bf.base64.split(',')[1]
                    : bf.base64;

            let mimeType =
                bf.type ||
                'image/jpeg';

            const ext = bf.name ? (bf.name.split('.').pop() || '').toLowerCase() : '';

            if (
                bf.name &&
                /\.(mp4|mov|webm|avi|mpeg|wmv|3gpp|flv|mkv)$/i
                    .test(bf.name)
            ) {
                const videoMimeMap = {
                    'mp4': 'video/mp4',
                    'mov': 'video/quicktime',
                    'webm': 'video/webm',
                    'avi': 'video/x-msvideo',
                    'mpeg': 'video/mpeg',
                    'wmv': 'video/x-ms-wmv',
                    '3gpp': 'video/3gpp',
                    'flv': 'video/x-flv',
                    'mkv': 'video/x-matroska'
                };

                mimeType =
                    videoMimeMap[ext] ||
                    'video/mp4';

                log.info('file.video_detected', { name: bf.name, mimeType });
            } else if (ext === 'pdf' || mimeType === 'application/pdf') {
                // Gemini supports PDF as an inline_data part the same way as
                // images - no special handling needed beyond the correct mime type.
                mimeType = 'application/pdf';
                log.info('file.pdf_detected', { name: bf.name });
            }

            contents[lastIndex]
                .parts
                .push({
                    inline_data: {
                        mime_type: mimeType,
                        data: base64Data
                    }
                });
        }

        /*
        |--------------------------------------------------------------------------
        | Model
        |--------------------------------------------------------------------------
        */

        const MODEL_NAME =
            model ||
            'gemini-3.5-flash-lite';

        log.info('model.selected', { model: MODEL_NAME });

        let systemText = '';

        const antiSelfQA = `
قانون سخت‌گیرانه:
جمله‌ی معرفی مدل («من Virtual Bot ... هستم») را فقط و فقط زمانی بنویس که خودِ کاربر همین الان مستقیم پرسیده باشد «مدلت چیه» یا سؤال هم‌معنی.
هرگز خودت این سؤال را از زبان خودت مطرح نکن.
هرگز بدون اینکه کاربر پرسیده باشد، جمله معرفی مدل را در پاسخ دیگری نیاور.
`;

        /*
        |--------------------------------------------------------------------------
        | System Prompt
        |--------------------------------------------------------------------------
        */

        if (
            MODEL_NAME ===
            'gemini-3.5-flash-lite'
        ) {
            systemText = `
تو Virtual Bot 1.1 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- فقط وقتی کاربر مستقیماً درباره مدل پرسید بگو: «من Virtual Bot 1.1 هستم.»
- هرگز خودت را Virtual Bot 1.3 یا Virtual Bot 1.5 معرفی نکن.
- هرگز نام سازنده یا تیمی را از خودت نساز.
- خودت را Gemini معرفی نکن.
- درباره چیزهایی که نمی‌دانی اطلاعات ساختگی نده.

شخصیت:
- فارسی روان، طبیعی و خودمانی صحبت کن.
- خشک و رباتی نباش.
- در موقعیت مناسب کمی شوخی دوستانه داشته باش 😂.
- از ایموجی مناسب استفاده کن ولی زیاده‌روی نکن.
- هرگز از ایموجی 🤖 استفاده نکن.
- هنگام سلام کردن یا جواب سلام، یک ایموجی گرم مثل 😊 یا 👋 استفاده کن.

نحوه پاسخ:
- سؤال ساده = پاسخ کوتاه و مستقیم.
- پاسخ طولانی = بخش‌بندی‌شده و خوانا.
- اطلاعات را بی‌دلیل تکرار نکن.
- اگر مطمئن نیستی، حدس را واقعیت معرفی نکن.

نام کاربر:
"${userName || 'دوست من'}"
`;

        } else if (
            MODEL_NAME ===
            'gemini-3.6-flash'
        ) {
            systemText = `
تو Virtual Bot 1.5 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- فقط وقتی کاربر مستقیماً درباره مدل پرسید بگو: «من Virtual Bot 1.5 هستم.»
- خودت را Virtual Bot 1.1 یا Virtual Bot 1.3 معرفی نکن.
- خودت را Gemini معرفی نکن.
- اطلاعات ساختگی درباره هویت یا سازنده نده.

شخصیت:
- فارسی طبیعی، خودمانی و حرفه‌ای.
- خشک و رباتی نباش.
- در موقعیت مناسب شوخی طبیعی داشته باش 😂.
- ایموجی را متعادل استفاده کن.
- هرگز 🤖 استفاده نکن.
- هنگام سلام کردن 😊 یا 👋 استفاده کن.

نحوه پاسخ:
- پاسخ ساده کوتاه و مستقیم.
- پاسخ طولانی خوانا و بخش‌بندی‌شده.
- از تکرار بی‌دلیل خودداری کن.

نام کاربر:
"${userName || 'دوست من'}"
`;

        } else if (
            MODEL_NAME ===
            'gemini-3.1-pro-preview'
        ) {
            systemText = `
تو Virtual Bot 1.3 هستی؛ یک دستیار هوش مصنوعی پیشرفته فارسی.

هویت:
- فقط وقتی کاربر مستقیماً درباره مدل پرسید بگو: «من Virtual Bot 1.3 هستم.»
- خودت را Virtual Bot 1.1 یا Virtual Bot 1.5 معرفی نکن.
- خودت را Gemini معرفی نکن.
- نام سازنده را از خودت نساز.

شخصیت:
- فارسی روان، دوستانه و حرفه‌ای.
- خشک و رباتی نباش.
- در موقعیت مناسب شوخ‌طبع باش 😎.
- ایموجی را متناسب استفاده کن.
- هنگام سلام 😊 یا 👋 استفاده کن.

نحوه پاسخ:
- پاسخ ساده واضح و مستقیم.
- پاسخ طولانی مرتب و بخش‌بندی‌شده.
- برای کدنویسی، در صورت درخواست، کد کامل و قابل اجرا بده.
- اطلاعات ساختگی تولید نکن.

نام کاربر:
"${userName || 'دوست من'}"
`;

        } else {
            systemText = `
تو Virtual Bot هستی؛ یک دستیار هوش مصنوعی فارسی.

قوانین:
- نام سازنده یا تیمی را از خودت نساز.
- اطلاعات ساختگی نده.
- فارسی روان و خودمانی صحبت کن.
- خشک و رباتی نباش.
- در موقعیت مناسب شوخی دوستانه داشته باش 😂.
- ایموجی را متعادل استفاده کن.
- هرگز 🤖 استفاده نکن.
- هنگام سلام 😊 یا 👋 استفاده کن.
- سؤال ساده را بی‌دلیل طولانی نکن.

نام کاربر:
"${userName || 'دوست من'}"
`;
        }

        systemText += antiSelfQA;

        /*
        |--------------------------------------------------------------------------
        | File Edit Mode
        |--------------------------------------------------------------------------
        */

        if (textFiles.length > 0) {
            const fileNamesList =
                textFiles
                    .map(
                        f =>
                            `«${f.name || 'file'}»`
                    )
                    .join('، ');

            systemText += `

حالت ویرایش فایل:

- کاربر ${textFiles.length > 1
                    ? `${textFiles.length} فایل کد/متن (${fileNamesList})`
                    : `یک فایل کد/متن`
                } ضمیمه کرده است.

- محتوای فایل منبع معتبر کد است.
- اگر کاربر تغییر کد خواست، واقعاً تغییر را روی فایل اعمال کن.
- ساختارهای موجود را بررسی کن و چیزهای بی‌دلیل اختراع نکن.
- به جای بازنویسی کل فایل، فقط قسمت لازم را تغییر بده.
- در پایان پاسخ دقیقاً یک بلاک file-edit تولید کن.

قوانین حیاتی برای فیلد "old" (در غیر این‌صورت ویرایش رد می‌شود):
- "old" باید کاراکتر به کاراکتر (شامل فاصله‌ها، تورفتگی/indentation، و شکست خط) دقیقاً همان‌طور که در فایل اصلی آمده کپی شود؛ آن را از حافظه بازنویسی نکن.
- "old" را تا حد امکان کوتاه نگه دار: فقط چند خط اطراف تغییر، نه یک بلوک بزرگ. برای یک تغییر کوچک، "old" فقط همان خط(های) مربوطه است، نه کل تابع/بلوک.
- اگر باید چند جای فایل عوض شود، به‌جای یک "old" بزرگ که همه را در بر بگیرد، چند آیتم جدا در همان آرایه بساز (هر کدام "old" کوتاه و مجزا).
- "old" باید در فایل دقیقاً یک‌بار ظاهر شود؛ اگر متنی که می‌خواهی تغییر بدهی در چند جای فایل تکرار شده، خط(های) قبل/بعدش را هم به "old" اضافه کن تا یکتا شود.
- هرگز فاصله‌های اضافه، تب‌های متفاوت، یا خطوط خالی اضافی در "old" یا "new" وارد نکن که در فایل اصلی نیستند.

فرمت:

\`\`\`file-edit
[
  {
    "file": "نام فایل",
    "old": "متن دقیق قدیمی (کوتاه و یکتا)",
    "new": "متن دقیق جدید"
  }
]
\`\`\`

خارج از file-edit کد کامل فایل را دوباره چاپ نکن.
`;
        }

        if (oversizedTextFiles.length > 0) {
            const droppedNames = oversizedTextFiles.map(f => `«${f.name || 'file'}»`).join('، ');
            systemText += `

توجه: فایل(های) ${droppedNames} به‌دلیل حجم زیاد (بیش از حد مجاز) پردازش نشدند و در اختیار تو نیستند. اگر کاربر درباره‌ی این فایل سؤال کرد، صادقانه بگو که فایل به‌خاطر حجم زیاد دریافت نشده و باید نسخه‌ی کوچک‌تری بفرستد.
`;
        }

        /*
        |--------------------------------------------------------------------------
        | Model Fallback
        |--------------------------------------------------------------------------
        */

        const modelsToTry = [MODEL_NAME];

        if (
            MODEL_NAME ===
            'gemini-3.1-pro-preview'
        ) {
            modelsToTry.push(
                'gemini-3.6-flash'
            );

            modelsToTry.push(
                'gemini-3.5-flash-lite'
            );
        }

        if (
            MODEL_NAME ===
            'gemini-3.6-flash'
        ) {
            modelsToTry.push(
                'gemini-3.5-flash-lite'
            );
        }

        /*
        |--------------------------------------------------------------------------
        | STREAM
        |--------------------------------------------------------------------------
        */

        if (wantsStream) {
            res.setHeader(
                'Content-Type',
                'text/event-stream; charset=utf-8'
            );

            res.setHeader(
                'Cache-Control',
                'no-cache, no-transform'
            );

            res.setHeader(
                'Connection',
                'keep-alive'
            );

            res.setHeader(
                'X-Accel-Buffering',
                'no'
            );

            if (
                typeof res.flushHeaders ===
                'function'
            ) {
                res.flushHeaders();
            }

            // FIX: 60s was a hard ceiling on the *whole* streaming attempt
            // (checked only between model/key retries, not during an
            // in-progress stream). For heavy replies — long code files,
            // multi-file edits — Gemini can legitimately take longer than
            // that just to finish one stream, and this file already has no
            // per-chunk timeout, so raising the deadline doesn't reduce
            // safety, it just stops penalizing large-but-healthy streams.
            const overallDeadline =
                Date.now() + 180000;

            let lastError = null;

            outerLoop:
            for (
                const currentModel of modelsToTry
            ) {
                for (
                    let k = 0;
                    k < geminiKeys.length;
                    k++
                ) {
                    if (
                        Date.now() >
                        overallDeadline
                    ) {
                        break outerLoop;
                    }

                    const currentKey =
                        geminiKeys[k];

                    try {
                        log.info('model.attempt', {
                            mode: 'stream',
                            model: currentModel,
                            key: keyLabel(geminiKeys, currentKey)
                        });

                        const controller =
                            new AbortController();

                        const timeoutId =
                            setTimeout(
                                () =>
                                    controller.abort(),
                                15000
                            );

                        let upstream;

                        try {
                            upstream =
                                await fetch(
                                    `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:streamGenerateContent?alt=sse`,
                                    {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type':
                                                'application/json',
                                            'x-goog-api-key':
                                                currentKey
                                        },
                                        body:
                                            JSON.stringify({
                                                system_instruction: {
                                                    parts: [
                                                        {
                                                            text: systemText
                                                        }
                                                    ]
                                                },
                                                contents
                                            }),
                                        signal:
                                            controller.signal
                                    }
                                );
                        } finally {
                            clearTimeout(
                                timeoutId
                            );
                        }

                        if (
                            !upstream.ok ||
                            !upstream.body
                        ) {
                            let errorBody =
                                null;

                            try {
                                errorBody =
                                    await upstream.json();
                            } catch (_) {}

                            lastError =
                                errorBody;

                            markKeyResult(currentKey, false);
                            log.warn('model.failed', {
                                mode: 'stream',
                                model: currentModel,
                                status: upstream.status
                            });

                            continue;
                        }

                        markKeyResult(currentKey, true);

                        const reader =
                            upstream.body.getReader();

                        const decoder =
                            new TextDecoder();

                        let buffer = '';

                        // FIX: previously the only signal sent to the client
                        // was raw text chunks + a bare {done:true} at the
                        // end — Gemini's own finishReason (STOP / MAX_TOKENS
                        // / SAFETY / ...) was read from the SSE payload but
                        // never looked at, so a reply cut short because it
                        // hit the output-token cap looked identical to a
                        // normal, complete reply. That's the "heavy code
                        // silently stops mid-file" symptom. We track the
                        // last seen finishReason and forward it on {done}
                        // so the frontend can offer a real "ادامه بده" action
                        // instead of just showing a truncated answer.
                        let lastFinishReason = null;

                        while (true) {
                            const {
                                done,
                                value
                            } =
                                await reader.read();

                            if (done) break;

                            buffer +=
                                decoder.decode(
                                    value,
                                    {
                                        stream: true
                                    }
                                );

                            const lines =
                                buffer.split('\n');

                            buffer =
                                lines.pop();

                            for (
                                const line of lines
                            ) {
                                if (
                                    !line.startsWith(
                                        'data:'
                                    )
                                ) {
                                    continue;
                                }

                                const jsonStr =
                                    line
                                        .slice(5)
                                        .trim();

                                if (!jsonStr) {
                                    continue;
                                }

                                try {
                                    const parsed =
                                        JSON.parse(
                                            jsonStr
                                        );

                                    const candidate =
                                        parsed
                                            ?.candidates?.[0];

                                    const piece =
                                        candidate
                                            ?.content?.parts?.[0]
                                            ?.text ||
                                        '';

                                    if (
                                        candidate &&
                                        candidate.finishReason
                                    ) {
                                        lastFinishReason =
                                            candidate.finishReason;
                                    }

                                    if (piece) {
                                        res.write(
                                            `data: ${JSON.stringify({
                                                text: piece
                                            })}\n\n`
                                        );

                                        if (
                                            typeof res.flush ===
                                            'function'
                                        ) {
                                            res.flush();
                                        }
                                    }
                                } catch (_) {}
                            }
                        }

                        // truncated=true tells the client the model was cut
                        // off by its own output-token limit (not an error,
                        // not the user pressing Stop) so it can offer to
                        // continue instead of treating the reply as final.
                        const truncated =
                            lastFinishReason === 'MAX_TOKENS';

                        res.write(
                            `data: ${JSON.stringify({
                                done: true,
                                finishReason: lastFinishReason,
                                truncated
                            })}\n\n`
                        );

                        log.info('request.finish_reason', {
                            model: currentModel,
                            finishReason: lastFinishReason || 'unknown'
                        });

                        if (
                            typeof res.flush ===
                            'function'
                        ) {
                            res.flush();
                        }

                        log.info('request.completed', {
                            mode: 'stream',
                            model: currentModel,
                            durationMs: Date.now() - requestStartedAt
                        });

                        return res.end();

                    } catch (error) {
                        markKeyResult(currentKey, false);
                        log.error('model.stream_error', {
                            model: currentModel,
                            message: error?.message || String(error)
                        });

                        lastError = error;
                    }
                }
            }

            res.write(
                `data: ${JSON.stringify({
                    error: {
                        message: 'سرور شلوغه یا کلیدهای فعال سهمیه‌شون تموم شده — چند لحظه دیگه دوباره امتحان کن.',
                        type: 'model_error',
                        stage: 'stream_generation',
                        detail: (lastError && (lastError.message || lastError.error?.message)) || 'all models/keys failed'
                    }
                })}\n\n`
            );

            return res.end();
        }

        /*
        |--------------------------------------------------------------------------
        | NON STREAM
        |--------------------------------------------------------------------------
        */

        const overallDeadline =
            Date.now() + 60000;

        let lastError = null;

        outerLoopNonStream:
        for (
            const currentModel of modelsToTry
        ) {
            for (
                let k = 0;
                k < geminiKeys.length;
                k++
            ) {
                if (
                    Date.now() >
                    overallDeadline
                ) {
                    break outerLoopNonStream;
                }

                const currentKey =
                    geminiKeys[k];

                try {
                    log.info('model.attempt', {
                        mode: 'non-stream',
                        model: currentModel,
                        key: keyLabel(geminiKeys, currentKey)
                    });

                    const controller =
                        new AbortController();

                    const timeoutId =
                        setTimeout(
                            () =>
                                controller.abort(),
                            15000
                        );

                    let response;

                    try {
                        response =
                            await fetch(
                                `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`,
                                {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type':
                                            'application/json',
                                        'x-goog-api-key':
                                            currentKey
                                    },
                                    body:
                                        JSON.stringify({
                                            system_instruction: {
                                                parts: [
                                                    {
                                                        text: systemText
                                                    }
                                                ]
                                            },
                                            contents
                                        }),
                                    signal:
                                        controller.signal
                                }
                            );
                    } finally {
                        clearTimeout(
                            timeoutId
                        );
                    }

                    const data =
                        await response.json();

                    if (!response.ok) {
                        markKeyResult(currentKey, false);
                        log.warn('model.failed', {
                            mode: 'non-stream',
                            model: currentModel,
                            message: data?.error?.message || response.statusText
                        });

                        lastError = data;

                        continue;
                    }

                    markKeyResult(currentKey, true);
                    log.info('request.completed', {
                        mode: 'non-stream',
                        model: currentModel,
                        durationMs: Date.now() - requestStartedAt
                    });

                    return res.status(200).json(data);

                } catch (error) {
                    markKeyResult(currentKey, false);
                    log.error('model.error', {
                        mode: 'non-stream',
                        model: currentModel,
                        message: error?.message || String(error)
                    });

                    lastError = error;
                }
            }
        }

        log.error('request.all_models_failed', {
            lastError: (lastError && (lastError.message || lastError.error?.message)) || 'unknown'
        });

        return res.status(500).json({
            error: {
                message: 'سرور شلوغه یا کلیدهای فعال سهمیه‌شون تموم شده — چند لحظه دیگه دوباره امتحان کن.',
                type: 'model_error',
                stage: 'non_stream_generation',
                detail: (lastError && (lastError.message || lastError.error?.message)) || 'all models/keys failed'
            }
        });

    } catch (globalError) {
        log.error('request.global_error', {
            message: globalError?.message || String(globalError)
        });

        return res.status(500).json({
            error: {
                message: 'خطای داخلی سرور. لطفاً دوباره امتحان کن.',
                type: 'api_error',
                stage: 'handler',
                detail: globalError?.message || String(globalError)
            }
        });
    }
}

module.exports = handler;
