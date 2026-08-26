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
| Error classification
|--------------------------------------------------------------------------
| Never label every failure as "API error". We keep the provider's raw code
| for diagnostics, but classify it into a small set of actionable categories
| for the UI and for key-rotation decisions.
*/
function classifyGeminiError(error) {
    const status = Number(
        error?.status ??
        error?.error?.code ??
        error?.body?.status ??
        error?.body?.error?.code ??
        0
    ) || null;

    const providerCode =
        error?.error?.status ||
        error?.body?.error?.status ||
        error?.statusText ||
        null;

    const rawMessage = String(
        error?.message ||
        error?.error?.message ||
        error?.body?.message ||
        error?.body?.error?.message ||
        ''
    ).trim();

    const normalized = `${providerCode || ''} ${rawMessage}`.toLowerCase();

    if (error?.type === 'empty_after_tool_call') {
        return {
            category: 'empty_response',
            retryable: false,
            keySpecific: false,
            message: 'مدل بعد از اجرای ابزار پاسخ قابل‌استفاده‌ای برنگرداند. دوباره امتحان کن.',
            status,
            providerCode,
            rawMessage
        };
    }

    if (error?.name === 'AbortError' || /timeout|timed out|deadline exceeded/.test(normalized)) {
        return {
            category: 'timeout',
            retryable: true,
            keySpecific: false,
            message: 'پاسخ سرویس بیش از زمان مجاز طول کشید. دوباره امتحان کن.',
            status,
            providerCode,
            rawMessage
        };
    }

    if (status === 429 || /resource_exhausted|quota|rate.?limit|too many requests/.test(normalized)) {
        const quota = /resource_exhausted|quota/.test(normalized);
        return {
            category: quota ? 'quota_exhausted' : 'rate_limit',
            retryable: true,
            keySpecific: true,
            message: quota
                ? 'سهمیه مصرف این کلید/پروژه برای این درخواست در دسترس نیست. کلید بعدی بررسی می‌شود.'
                : 'سرعت درخواست به حد مجاز رسیده است. کلید بعدی بررسی می‌شود.',
            status: status || 429,
            providerCode,
            rawMessage
        };
    }

    if (status === 401 || /api key|invalid.*key|unauthenticated|authentication/.test(normalized)) {
        return {
            category: 'invalid_api_key',
            retryable: true,
            keySpecific: true,
            message: 'این کلید API معتبر نیست یا احراز هویت آن رد شده است. کلید بعدی بررسی می‌شود.',
            status: status || 401,
            providerCode,
            rawMessage
        };
    }

    if (status === 403 || /permission|forbidden|access denied|not authorized/.test(normalized)) {
        return {
            category: 'permission_denied',
            retryable: true,
            keySpecific: true,
            message: 'دسترسی این کلید به سرویس یا مدل رد شده است. کلید بعدی بررسی می‌شود.',
            status: status || 403,
            providerCode,
            rawMessage
        };
    }

    if (status === 404 || /model.*not found|not_found|unknown model/.test(normalized)) {
        return {
            category: 'model_not_found',
            retryable: true,
            keySpecific: false,
            message: 'مدل در سرویس پیدا نشد یا در دسترس این مسیر نیست.',
            status: status || 404,
            providerCode,
            rawMessage
        };
    }

    if (status === 400 || /invalid argument|invalid request|bad request|malformed/.test(normalized)) {
        return {
            category: 'invalid_request',
            retryable: false,
            keySpecific: false,
            message: 'درخواست ارسالی نامعتبر بود. احتمالاً یکی از ورودی‌ها یا تنظیمات درخواست مشکل دارد.',
            status: status || 400,
            providerCode,
            rawMessage
        };
    }

    if (status === 413 || /too large|payload.*large|request.*size|token limit|context length/.test(normalized)) {
        return {
            category: 'request_too_large',
            retryable: false,
            keySpecific: false,
            message: 'حجم درخواست یا فایل‌ها بیش از حد مجاز است.',
            status: status || 413,
            providerCode,
            rawMessage
        };
    }

    if (status >= 500 && status <= 599 || /service unavailable|internal server error|bad gateway|temporarily unavailable/.test(normalized)) {
        return {
            category: 'provider_unavailable',
            retryable: true,
            keySpecific: false,
            message: 'سرویس هوش مصنوعی موقتاً در دسترس نیست. دوباره امتحان می‌کنیم.',
            status,
            providerCode,
            rawMessage
        };
    }

    if (error instanceof TypeError || /fetch failed|network|socket|econn|enotfound|connection/.test(normalized)) {
        return {
            category: 'network_error',
            retryable: true,
            keySpecific: false,
            message: 'ارتباط Virtual Bot با سرویس هوش مصنوعی قطع شد. اتصال را بررسی کن و دوباره امتحان کن.',
            status,
            providerCode,
            rawMessage
        };
    }

    return {
        category: 'unknown_error',
        retryable: true,
        keySpecific: false,
        message: 'یک خطای ناشناخته هنگام پردازش درخواست رخ داد.',
        status,
        providerCode,
        rawMessage
    };
}

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

/*
|--------------------------------------------------------------------------
| Google API usage telemetry (observed locally, never fabricated)
|--------------------------------------------------------------------------
| Google does not expose the project's live RPM/TPM/RPD quota through the
| Gemini API key itself. We therefore expose ONLY requests this backend
| actually sent with each configured key, plus real 429/error observations.
| The rolling window is process-local (serverless instances can reset).
*/
const __googleUsage = new Map();

/*
 * Persistent usage storage (Vercel KV / Upstash Redis integration).
 *
 * Required environment variables on Vercel:
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *
 * If they are not configured, we keep the old in-memory fallback so local
 * development still works. The UI is told whether the data is persistent.
 * No API key value is ever stored; only its stable 1-based index is used.
 */
const USAGE_KV_PREFIX = 'virtual-bot:google-usage:v2';
const USAGE_WINDOW_MS = 60_000;
const USAGE_TTL_SECONDS = 180;

function hasUsageKV() {
    return Boolean((process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) || process.env.REDIS_URL);
}

let __redisClientPromise = null;
async function getRedisClient() {
    if (!process.env.REDIS_URL) return null;
    if (!__redisClientPromise) {
        __redisClientPromise = import('redis').then(async ({ createClient }) => {
            const client = createClient({ url: process.env.REDIS_URL });
            client.on('error', (err) => log.warn('usage.redis_error', { message: err?.message || String(err) }));
            await client.connect();
            return client;
        }).catch((err) => { __redisClientPromise = null; throw err; });
    }
    return __redisClientPromise;
}

async function usageKvCommand(command, args = []) {
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1800);
        try {
            const response = await fetch(process.env.KV_REST_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.KV_REST_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify([command, ...args]),
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`KV ${command} returned ${response.status}`);
            const data = await response.json();
            return data?.result ?? null;
        } finally { clearTimeout(timeoutId); }
    }
    const client = await getRedisClient();
    if (!client) return null;
    switch (command) {
        case 'ZADD': return client.zAdd(args[0], [{ score: Number(args[1]), value: String(args[2]) }]);
        case 'EXPIRE': return client.expire(args[0], Number(args[1]));
        case 'HINCRBY': return client.hIncrBy(args[0], args[1], Number(args[2]));
        case 'HSET': {
            const values = {};
            for (let i = 1; i < args.length; i += 2) values[args[i]] = String(args[i + 1] ?? '');
            return client.hSet(args[0], values);
        }
        case 'ZREMRANGEBYSCORE': return client.zRemRangeByScore(args[0], args[1], args[2]);
        case 'ZCOUNT': return client.zCount(args[0], args[1], args[2]);
        case 'ZRANGE': {
            const withScores = args[3] === 'WITHSCORES';
            const rows = withScores ? await client.zRangeWithScores(args[0], Number(args[1]), Number(args[2])) : await client.zRange(args[0], Number(args[1]), Number(args[2]));
            return withScores ? rows.flatMap(r => [r.value, String(r.score)]) : rows;
        }
        case 'HGETALL': return client.hGetAll(args[0]);
        default: throw new Error(`Unsupported Redis command: ${command}`);
    }
}

function recordGoogleAttemptMemory(key, status) {
    const now = Date.now();
    let row = __googleUsage.get(key);
    if (!row) {
        row = { timestamps: [], total: 0, success: 0, errors: 0, lastStatus: null, lastAt: null };
        __googleUsage.set(key, row);
    }
    row.timestamps.push(now);
    row.total += 1;
    row.lastStatus = Number.isFinite(status) ? status : null;
    row.lastAt = now;
    if (status >= 200 && status < 300) row.success += 1;
    else row.errors += 1;
    const cutoff = now - USAGE_WINDOW_MS;
    row.timestamps = row.timestamps.filter(t => t >= cutoff);
}

/*
 * Record the request in both the local fallback and persistent storage.
 * The KV write is deliberately fire-and-forget so telemetry cannot add a
 * network round-trip to Gemini response latency. The write happens while
 * the current Vercel request is still active.
 */
function recordGoogleAttempt(key, status, keyIndex) {
    recordGoogleAttemptMemory(key, status);

    if (!hasUsageKV()) return;

    const now = Date.now();
    const id = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const zsetKey = `${USAGE_KV_PREFIX}:key:${keyIndex}`;
    const metaKey = `${USAGE_KV_PREFIX}:meta:${keyIndex}`;
    const score = String(now);

    Promise.all([
        usageKvCommand('ZADD', [zsetKey, score, id]),
        usageKvCommand('EXPIRE', [zsetKey, String(USAGE_TTL_SECONDS)]),
        usageKvCommand('HINCRBY', [metaKey, 'totalObserved', '1']),
        usageKvCommand('HINCRBY', [metaKey, status >= 200 && status < 300 ? 'successfulObserved' : 'errorsObserved', '1']),
        usageKvCommand('HSET', [metaKey, 'lastStatus', String(Number.isFinite(status) ? status : ''), 'lastAt', new Date(now).toISOString()]),
        usageKvCommand('EXPIRE', [metaKey, String(90 * 24 * 60 * 60)])
    ]).catch(error => {
        log.warn('usage.storage_write_failed', { message: error?.message || String(error) });
    });
}

function pruneGoogleUsage() {
    const cutoff = Date.now() - USAGE_WINDOW_MS;
    for (const row of __googleUsage.values()) row.timestamps = row.timestamps.filter(t => t >= cutoff);
}

async function getPersistentGoogleUsage(index) {
    const now = Date.now();
    const cutoff = String(now - USAGE_WINDOW_MS);
    const zsetKey = `${USAGE_KV_PREFIX}:key:${index}`;
    const metaKey = `${USAGE_KV_PREFIX}:meta:${index}`;

    await usageKvCommand('ZREMRANGEBYSCORE', [zsetKey, '-inf', cutoff]);
    const [count, oldest, meta] = await Promise.all([
        usageKvCommand('ZCOUNT', [zsetKey, cutoff, '+inf']),
        usageKvCommand('ZRANGE', [zsetKey, '0', '0', 'WITHSCORES']),
        usageKvCommand('HGETALL', [metaKey])
    ]);

    let oldestAt = null;
    if (Array.isArray(oldest) && oldest.length >= 2) {
        const score = Number(oldest[1]);
        if (Number.isFinite(score)) oldestAt = score;
    }

    const metaObj = meta && typeof meta === 'object' ? meta : {};
    return {
        requestsLast60s: Number(count) || 0,
        totalObserved: Number(metaObj.totalObserved) || 0,
        successfulObserved: Number(metaObj.successfulObserved) || 0,
        errorsObserved: Number(metaObj.errorsObserved) || 0,
        lastStatus: metaObj.lastStatus === '' || metaObj.lastStatus == null ? null : Number(metaObj.lastStatus),
        lastAt: metaObj.lastAt || null,
        secondsUntilOldestExpires: oldestAt ? Math.max(0, Math.ceil((oldestAt + USAGE_WINDOW_MS - now) / 1000)) : 0
    };
}

async function getGoogleUsageSnapshot(keys) {
    if (hasUsageKV()) {
        try {
            const persistent = await Promise.all(keys.map((_, index) => getPersistentGoogleUsage(index + 1)));
            return keys.map((_, index) => ({
                label: `Key ${String(index + 1).padStart(2, '0')}`,
                ...persistent[index]
            }));
        } catch (error) {
            log.warn('usage.storage_read_failed', { message: error?.message || String(error) });
        }
    }

    pruneGoogleUsage();
    const now = Date.now();
    return keys.map((key, index) => {
        const row = __googleUsage.get(key) || { timestamps: [], total: 0, success: 0, errors: 0, lastStatus: null, lastAt: null };
        return {
            label: `Key ${String(index + 1).padStart(2, '0')}`,
            requestsLast60s: row.timestamps.length,
            totalObserved: row.total,
            successfulObserved: row.success,
            errorsObserved: row.errors,
            lastStatus: row.lastStatus,
            lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
            secondsUntilOldestExpires: row.timestamps.length ? Math.max(0, Math.ceil((row.timestamps[0] + USAGE_WINDOW_MS - now) / 1000)) : 0
        };
    });
}
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
const MAX_HISTORY_TURNS = 60;       // most recent user+model turns kept verbatim (~30 user messages, since each user turn has a matching model turn)
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

// FIX: replaced by real function-calling web search (see runAgentLoop /
// GEMINI_TOOLS below). The old version decided whether to search using a
// fixed Persian keyword list, so anything phrased differently (or in
// English, or just not on the list) silently never triggered a search even
// when it clearly needed one. The model itself now decides, per-turn and
// based on actual understanding of the question, whether to call the
// web_search tool — including calling it more than once if the first
// result isn't enough. Kept as a no-op stub (unused) instead of deleting
// outright, in case any other code path still references it.
function shouldSearchWeb() {
    return false;
}

// Fast client/request-side hint used only to protect the first streamed
// chunks when the user explicitly asks for live/searchable information.
// This does NOT decide whether Gemini should search; Gemini still makes that
// decision with the real web_search tool. It only prevents a friendly
// preamble such as "سلام ..." from leaking before that tool call.
function looksLikeWebSearchIntent(text) {
    const s = String(text || '').toLowerCase();
    if (!s.trim()) return false;
    return /(?:سرچ|جستجو|گوگل|وب|اینترنت|قیمت(?:\s|‌)*(?:الان|امروز|فعلی|جدید|لحظه)|الان چنده|چنده|چقدر(?:ه|ه؟)|چقدره|قیمتش|قیمتش چنده|هزینه|هزینش|آخرین|امروز|امشب|اخبار|خبرهای|آب[\u200c ]?وهوا|هوا(?:ی|\s)|نرخ|ارز|دلار|یورو|طلا|سهام|موجودی|قیمت فعلی|current|latest|today|right now|now|search|google|look up|news|weather|price|stock|exchange rate|availability)/i.test(s);
}



/*
|--------------------------------------------------------------------------
| Tavily
|--------------------------------------------------------------------------
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
| Tavily
|--------------------------------------------------------------------------
*/

async function fetchTavilyResults(query, tavilyKeys, searchCache) {
    if (!tavilyKeys || tavilyKeys.length === 0) {
        return null;
    }

    // FIX (root cause of "many different searches for one message"): the
    // outer handler retries the whole runAgentLoop from scratch on the next
    // Gemini key/model whenever an attempt fails AFTER it already did a
    // web_search but BEFORE it produced a final answer (timeout, upstream
    // error, empty response, etc). Each retry used to re-run
    // fetchTavilyResults from zero, burning a fresh Tavily search per retry
    // even though it's the same user question. searchCache is a small
    // Map created once per incoming HTTP request (see main handler) and
    // passed all the way down here, so a retry that searches the same
    // (normalized) query reuses the first attempt's result instead of
    // hitting Tavily again.
    const cacheKey = query.trim().toLowerCase();
    if (searchCache && searchCache.has(cacheKey)) {
        log.info('search.cache_hit', { queryPreview: query.slice(0, 100) });
        return searchCache.get(cacheKey);
    }

    for (let i = 0; i < tavilyKeys.length; i++) {
        const currentKey = tavilyKeys[i];

        try {
            const controller = new AbortController();

            const timeoutId = setTimeout(
                () => controller.abort(),
                4500
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
                            max_results: 2
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

                const formatted = data.results
                    .map(
                        r =>
                            `عنوان: ${r.title}\n` +
                            `منبع: ${r.url}\n` +
                            `محتوا: ${String(r.content || '').slice(0, 1800)}`
                    )
                    .join('\n\n---\n\n');

                if (searchCache) searchCache.set(cacheKey, formatted);
                return formatted;
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
| Agentic Tool Calling
|--------------------------------------------------------------------------
| Instead of a fixed Persian keyword list deciding up-front whether to
| search the web, the model itself is given a real "web_search" tool (via
| Gemini's function calling) and decides per-turn whether/how many times
| to call it, based on actually understanding the question. It can also
| call "ask_user" when it judges a change the user asked for to be
| significant enough to confirm first (e.g. "rewrite this whole file" /
| "delete this data") instead of just doing it.
|
| Each tool call is narrated to the client as a lightweight {step: ...}
| SSE event *before* the tool result comes back, so a slow web search
| doesn't look like a silent hang - the user sees "دارم توی وب سرچ می‌کنم…"
| immediately, the same way a person narrates what they're doing.
*/

const GEMINI_TOOLS = [
    {
        function_declarations: [
            {
                name: 'web_search',
                description:
                    'جستجوی واقعی و زنده در وب برای اطلاعات به‌روز، قیمت، اخبار، رویدادها یا هر ' +
                    'چیزی که ممکن است بعد از زمان آموزش مدل تغییر کرده باشد یا مدل به آن مطمئن نیست. ' +
                    'برای اکثر سؤال‌ها (حتی سؤال‌های ساده‌ی «قیمت الان چنده») یک‌بار صدا زدن این ابزار ' +
                    'با یک query خوب کافی است و باید با همان نتایج جواب نهایی داده شود. صدا زدن دوباره ' +
                    'فقط در موارد نادر و واقعی مجاز است: وقتی نتیجه‌ی جستجوی اول کاملاً بی‌ربط/ناقص بود، ' +
                    'یا سؤال چند بخش کاملاً جدا از هم دارد که هرکدام موضوع متفاوتی است. هرگز برای «دقیق‌تر ' +
                    'کردن» یک جستجوی قبلاً موفق دوباره سرچ نزن.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'عبارت جستجو - کوتاه، دقیق و مرتبط با چیزی که لازم داری بدانی.'
                        },
                        reason: {
                            type: 'string',
                            description: 'یک جمله‌ی کوتاه فارسی که به کاربر نشان داده می‌شود و توضیح می‌دهد چرا داری این را سرچ می‌کنی (مثلاً "دارم آخرین قیمت طلا رو بررسی می‌کنم").'
                        }
                    },
                    required: ['query', 'reason']
                }
            },
            {
                // FEATURE (persistent file memory): the client keeps a
                // permanent per-chat archive of every text/code file ever
                // sent (in IndexedDB, well past the single "current message"
                // lifetime of codeFilesMemory). The archive's file NAMES are
                // listed for the model every turn (cheap - just strings),
                // but the actual CONTENT only gets pulled into context if
                // the model calls this tool, i.e. only when the user is
                // actually referring back to that file's content, not just
                // mentioning its name in passing. This keeps large/long
                // chats cheap by default while still letting the model
                // "remember" old files when it genuinely needs them.
                name: 'get_archived_file',
                description:
                    'محتوای یکی از فایل‌های قبلاً ارسال‌شده در همین گفتگو را برمی‌گرداند. این ابزار را ' +
                    'فقط زمانی صدا بزن که کاربر واقعاً به محتوای یک فایل قبلی نیاز دارد یا به آن ارجاع ' +
                    'می‌دهد (مثلاً «همون فایلی که قبلاً فرستادم رو ویرایش کن» یا «توی اون فایل دنبال X ' +
                    'بگرد») - نه صرفاً وقتی اسم فایل یک‌بار در گفتگو ذکر شده. اسم فایل‌های موجود در آرشیو ' +
                    'این گفتگو در پرامپت سیستم به تو داده شده است.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'نام دقیق فایلی که محتوایش لازم است (باید دقیقاً با یکی از نام‌های آرشیو مطابقت داشته باشد).'
                        }
                    },
                    required: ['name']
                }
            },
            {
                name: 'ask_user',
                description:
                    'وقتی درخواست کاربر شامل یک تغییر اساسی/غیرقابل‌برگشت است (مثلاً بازنویسی کامل ' +
                    'یک فایل، حذف بخش بزرگی از کد یا داده، یا تصمیمی که چند راه‌حل معقول و متفاوت دارد)، ' +
                    'قبل از انجام کار این ابزار را صدا بزن و از کاربر تأیید یا انتخاب بخواه. برای سؤالات ' +
                    'ساده یا کارهای کم‌ریسک از این ابزار استفاده نکن - فقط برای تصمیم‌های واقعاً مهم.',
                parameters: {
                    type: 'object',
                    properties: {
                        question: {
                            type: 'string',
                            description: 'سؤال دقیق و کوتاه که از کاربر باید پرسیده شود.'
                        }
                    },
                    required: ['question']
                }
            }
        ]
    }
];

// Human-readable Persian step labels the client shows while a tool runs.
// Falls back to a generic label if the model didn't provide its own
// "reason" text (only web_search asks for one).
function describeToolCall(name, args) {
    if (name === 'web_search') {
        return (args && args.reason) || `دارم درباره‌ی «${(args && args.query) || ''}» توی وب سرچ می‌کنم...`;
    }
    if (name === 'ask_user') {
        return 'قبل از ادامه، یه سؤال دارم...';
    }
    if (name === 'get_archived_file') {
        return `دارم فایل «${(args && args.name) || ''}» رو از آرشیو این گفتگو می‌خونم...`;
    }
    return 'در حال انجام یک مرحله...';
}

async function executeToolCall(name, args, ctx) {
    if (name === 'get_archived_file') {
        const fileName = (args && args.name) || '';
        const archive = (ctx && Array.isArray(ctx.archivedFiles)) ? ctx.archivedFiles : [];
        const found = archive.find(f => f && f.name === fileName);
        if (!found) {
            return { error: `فایلی با نام «${fileName}» در آرشیو این گفتگو پیدا نشد.` };
        }

        // FIX (token/quota exhaustion): a single archived file (e.g. a full
        // index.html) can be tens of thousands of tokens. Handing back the
        // ENTIRE file every time it's referenced - especially since it then
        // rides along in workingContents for every subsequent tool round in
        // the same turn - was spiking single-request token usage well above
        // a normal message and burning through per-minute token quota fast,
        // even across just 1-2 user messages. Cap what's returned so a huge
        // file can still be searched/discussed without blowing the budget;
        // the model is told the file was truncated so it doesn't silently
        // assume it saw everything.
        const MAX_ARCHIVED_FILE_CHARS = 40000; // ~ safely under one round's comfortable budget
        let content = found.content || '';
        let truncated = false;
        if (content.length > MAX_ARCHIVED_FILE_CHARS) {
            content = content.slice(0, MAX_ARCHIVED_FILE_CHARS);
            truncated = true;
        }

        log.info('agent.tool.get_archived_file', {
            name: fileName,
            contentLen: (found.content || '').length,
            truncated
        });

        return {
            name: found.name,
            content,
            ...(truncated ? {
                note: 'این فایل خیلی بزرگ بود و فقط بخش ابتدایی آن (۴۰ هزار کاراکتر اول) بازگردانده شد. اگر بخش دیگری لازم است، به کاربر بگو که فایل کامل در دسترس نیست و باید بخش خاصی از آن را دوباره بفرستد.'
            } : {})
        };
    }

    if (name === 'web_search') {
        const query = (args && args.query) || '';
        if (!query) return { error: 'query خالی بود.' };

        log.info('agent.tool.web_search', { queryPreview: query.slice(0, 100) });

        const results = await fetchTavilyResults(query, ctx.tavilyKeys, ctx.searchCache);

        if (!results) {
            return { result: 'نتیجه‌ای برای این جستجو پیدا نشد.' };
        }
        return { result: results };
    }

    if (name === 'ask_user') {
        // There's no synchronous "wait for the user" channel in a single
        // HTTP request/response cycle, so ask_user ends the agent loop
        // early: the question is streamed to the client as the final
        // reply (clearly marked), and the user's next message continues
        // the conversation normally via existing history.
        return { askUser: (args && args.question) || 'می‌خوای همین‌طور ادامه بدم؟' };
    }

    return { error: `ابزار ناشناخته: ${name}` };
}

// Runs the model <-> tool loop. Each round now calls Gemini's real
// streamGenerateContent endpoint (Server-Sent-Events of JSON chunks) instead
// of generateContent, and forwards text chunks to the client live via
// onChunk() AS THEY ARRIVE from Google - not batched into one write at the
// end. functionCall parts can still show up in a streamed response (Gemini
// sends them as a complete part inside one of the chunks, same shape as the
// non-streaming response), so tool-calling keeps working exactly as before;
// we just no longer throw away real token-by-token streaming to get it.
// Every tool call along the way is still narrated via onStep(label) before
// it runs, same as before.
async function runAgentLoop({ currentModel, currentKey, systemText, contents, tavilyKeys, archivedFiles, onStep, onChunk, signal, disableTools, hasVideoAttachment, searchCache, searchState, searchIntent }) {
    const MAX_TOOL_ROUNDS = 2; // one round to search (if needed) + one round to answer using the results; this is a hard cap, not a target
    let workingContents = [...contents];
    // If the outer handler is retrying Gemini after a search already happened,
    // keep the first search result available to the replacement model without
    // exposing web_search (or any other tool) again. This preserves key/model
    // fallback while enforcing one logical search for the whole HTTP request.
    if (searchState?.used && searchState?.result?.result) {
        systemText = `${systemText}\n\n[نتیجه جستجوی وب که قبلاً در همین درخواست انجام شده است — از جستجوی مجدد خودداری کن]:\n${searchState.result.result}`;
    }
    let lastUsage = null;
    // Question-scoped search lock: after one web_search, no tool is exposed
    // for the remainder of this request, including Gemini key/model retries.
    // Request-scoped search lock. This object is shared across Gemini key/model
    // retries, so a retry can NEVER start a second logical web_search for the
    // same incoming user question.
    const scopedSearchState = searchState || { used: false, result: null };


    // FIX (root cause of "video reads extremely slowly / times out"):
    // Gemini has to ingest and effectively transcode/sample the whole video
    // (extracting frames at ~1fps) before it can emit the first output
    // token, which routinely takes well past 60s for anything more than a
    // few seconds of footage - even after client-side compression. The old
    // fixed 60s per-round timeout aborted these requests before Gemini ever
    // got a chance to respond, which is exactly the "پاسخ بیش از حد طول
    // کشید" error being seen. Video attachments now get a longer per-round
    // budget; everything else (text/image/PDF-only turns, which really do
    // answer fast) keeps the original tight 60s so a genuinely stuck
    // request still fails fast instead of hanging the connection.
    //
    // FIX (persistent-file-memory follow-up): a round that comes right
    // after a get_archived_file tool response has up to ~40,000 extra
    // characters of dense code/HTML freshly added to context - genuinely
    // more for Gemini to read and reason about than a normal turn, and it
    // can legitimately take longer than the standard 60s to produce a real
    // answer. The old fixed timeout aborted that round via AbortError,
    // which the outer per-attempt catch treated exactly like a real key
    // failure (markKeyResult(..., false)) and moved to the NEXT key -
    // repeating the same slow "read this same big file from scratch" work
    // on every single one of the 12 keys in a row, burning through all of
    // them on what was never actually a quota problem, and only then
    // surfacing the generic "quota exhausted" message. Rounds that follow a
    // get_archived_file call now get the same longer budget as video.
    const roundNeedsMoreTime = (round) =>
        hasVideoAttachment ||
        (round > 0 && lastToolCallWasArchiveRead);
    let lastToolCallWasArchiveRead = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const ROUND_TIMEOUT_MS = roundNeedsMoreTime(round) ? 170000 : 60000;
        lastToolCallWasArchiveRead = false; // consumed for this round; re-armed below only if this round's own tool call is an archive read
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ROUND_TIMEOUT_MS);
        // Also abort this round if the caller's own signal (client disconnect
        // / overall deadline) fires.
        const onAbort = () => controller.abort();
        if (signal) signal.addEventListener('abort', onAbort);

        let upstream;
        try {
            upstream = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:streamGenerateContent?alt=sse`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': currentKey
                    },
                    body: JSON.stringify({
                        system_instruction: { parts: [{ text: systemText }] },
                        contents: workingContents,
                        // See hasVideoAttachment / disableTools comment above
                        // runAgentLoop's call sites: omitted entirely (not
                        // just emptied) when a video is attached, since some
                        // Gemini versions treat an empty tools array
                        // differently from no tools key at all.
                        ...((disableTools || scopedSearchState.used) ? {} : { tools: GEMINI_TOOLS })
                    }),
                    signal: controller.signal
                }
            );
            recordGoogleAttempt(currentKey, upstream.status, geminiKeys.indexOf(currentKey) + 1);
        } finally {
            clearTimeout(timeoutId);
            if (signal) signal.removeEventListener('abort', onAbort);
        }

        if (!upstream.ok) {
            let errorBody = null;
            try { errorBody = await upstream.json(); } catch (_) {}
            const err = new Error('agent_upstream_failed');
            err.status = upstream.status;
            err.body = errorBody;
            throw err;
        }

        // Read the upstream SSE stream chunk-by-chunk.
        //
        // IMPORTANT latency fix: the previous implementation buffered the
        // ENTIRE first round whenever tools were enabled. That meant even a
        // normal answer which never used a tool had to finish upstream before
        // the user saw its first token. We now stream tool-enabled text as it
        // arrives, while the system prompt explicitly requires Gemini to emit
        // a functionCall before any narration when it decides to use a tool.
        // This keeps normal answers truly live without re-introducing the old
        // "I'm going to search..." preamble in the common tool-call path.
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let accumulatedParts = [];
        let finishReason = null;
        // Only hold obvious greeting/preamble text on turns that look like a
        // search request. Normal answers remain fully live. If Gemini follows
        // its tool-calling instruction and emits a functionCall next, the
        // buffered preamble is discarded; if it turns out not to need a tool,
        // the buffer is released as soon as substantive text arrives.
        let pendingToolPreamble = '';
        let sawFunctionCall = false;

        const emitStreamText = (text) => {
            if (!onChunk || !text) return;
            try { onChunk(text); } catch (_) {}
        };

        const handleStreamText = (text) => {
            if (!searchIntent || disableTools || scopedSearchState.used || sawFunctionCall) {
                emitStreamText(text);
                return;
            }

            // This is an explicit/current-info search turn. Keep the entire
            // pre-tool stream off the wire until Gemini either emits the
            // functionCall (then the buffer is discarded) or finishes without
            // a tool (then the buffer is flushed below). This is intentionally
            // scoped ONLY to likely search requests, so ordinary chat keeps the
            // zero-buffer live streaming path.
            pendingToolPreamble += text;
        };

        const handleEventPayload = (jsonStr) => {
            let evt;
            try { evt = JSON.parse(jsonStr); } catch (_) { return; }
            const candidate = evt?.candidates?.[0];
            if (!candidate) return;
            if (evt.usageMetadata) lastUsage = evt.usageMetadata;
            if (candidate.finishReason) finishReason = candidate.finishReason;

            const parts = candidate?.content?.parts || [];
            const eventHasFunctionCall = parts.some(part => !!part?.functionCall);
            if (eventHasFunctionCall) {
                sawFunctionCall = true;
                // Anything held so far was pre-tool narration. Do NOT flush it.
                pendingToolPreamble = '';
            }

            for (const part of parts) {
                if (typeof part.text === 'string') {
                    accumulatedParts.push({ text: part.text });
                    // If this event also contains the tool call, its text is
                    // not a valid user-facing preamble. Otherwise use the
                    // selective guard above: normal turns stream immediately,
                    // search-intent turns suppress only obvious preambles.
                    if (!eventHasFunctionCall) {
                        handleStreamText(part.text);
                    }
                } else if (part.functionCall) {
                    accumulatedParts.push({ functionCall: part.functionCall });
                }
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith('data:')) continue;
                    const jsonStr = line.slice(5).trim();
                    if (!jsonStr) continue;
                    handleEventPayload(jsonStr);
                }
            }
            if (sseBuffer.trim().startsWith('data:')) {
                handleEventPayload(sseBuffer.trim().slice(5).trim());
            }
        } catch (streamErr) {
            if (streamErr?.name === 'AbortError') throw streamErr;
            const err = new Error('agent_stream_read_failed');
            err.body = { message: streamErr?.message || String(streamErr) };
            throw err;
        }

        const parts = accumulatedParts;
        const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
        const textParts = parts.filter(p => typeof p.text === 'string').map(p => p.text);

        if (functionCalls.length === 0) {
            // No tool call arrived after all. Release any selectively held
            // preamble so the final answer is not lost.
            if (pendingToolPreamble) {
                emitStreamText(pendingToolPreamble);
                pendingToolPreamble = '';
            }
            // Final answer. Text is already streamed live above. There is
            // normally nothing left to flush here; keep a fallback for any
            // unusual provider event that was not emitted incrementally.
            if (onChunk && textParts.length && !disableTools && !scopedSearchState.used) {
                // The normal path has already emitted these chunks. Do not
                // emit them again; this branch intentionally remains empty.
            }
            //
            // BUGFIX (silent empty reply after a tool call): if Gemini's
            // very next turn after a functionResponse (e.g. get_archived_file
            // handing back a large file's content) comes back with NO text
            // parts and a finishReason other than a normal stop (MAX_TOKENS,
            // SAFETY, RECITATION, OTHER...), this used to be returned as a
            // seemingly-successful empty finalText - the client then shows
            // the tool's "step" label for a moment, gets zero text chunks,
            // and finally falls into its generic retry-error path. That's
            // exactly the "پیام یه لحظه میاد بعد غیب میشه" symptom. Detect
            // that specific case and surface a real, explained error instead
            // of a silent empty success.
            const normalStop = !finishReason || finishReason === 'STOP';
            if (!normalStop && textParts.length === 0 && round > 0) {
                log.warn('agent.empty_after_tool_call', { finishReason, round });
                const err = new Error('agent_empty_after_tool_call');
                err.status = 502;
                err.body = {
                    message: 'مدل بعد از خوندن فایل آرشیوشده جواب خالی برگردوند. لطفاً دوباره امتحان کن.',
                    type: 'empty_after_tool_call',
                    finishReason
                };
                throw err;
            }
            return {
                finalText: textParts.join(''),
                finishReason: finishReason,
                usage: lastUsage,
                askUser: null
            };
        }

        // Echo the model's own turn (including its functionCall parts) back
        // into the conversation, then append one functionResponse per call,
        // exactly as Gemini's function-calling protocol expects.
        workingContents.push({
            role: 'model',
            parts: parts
        });

        const responseParts = [];
        let earlyAskUser = null;

        // FIX (root cause of "searches many sites for one simple question"):
        // Gemini's function-calling can return SEVERAL functionCall parts in
        // a single model turn (parallel calling) - e.g. 3-4 different
        // web_search calls with slightly reworded queries, all at once. That
        // happened entirely within ONE round, so MAX_TOOL_ROUNDS never even
        // saw it as more than one step. The runtime therefore enforces both
        // one search per round and, more importantly, one search per question.
        let webSearchesThisRound = 0;
        const MAX_WEB_SEARCHES_PER_ROUND = 1;
        let searchTriggeredThisRound = false;

        for (const call of functionCalls) {
            const label = describeToolCall(call.name, call.args);

            if (call.name === 'web_search') {
                webSearchesThisRound++;
                if (webSearchesThisRound > MAX_WEB_SEARCHES_PER_ROUND || scopedSearchState.used) {
                    responseParts.push({
                        functionResponse: {
                            name: call.name,
                            response: { error: 'جستجو برای این سؤال قبلاً انجام شده؛ با همان نتیجه پاسخ بده و جستجوی دیگری انجام نده.' }
                        }
                    });
                    continue;
                }
                searchTriggeredThisRound = true;
            } else if (searchTriggeredThisRound || scopedSearchState.used) {
                responseParts.push({
                    functionResponse: {
                        name: call.name,
                        response: { error: 'بعد از web_search ابزارها برای این سؤال غیرفعال شده‌اند؛ با نتیجهٔ جستجو پاسخ بده.' }
                    }
                });
                continue;
            }

            if (onStep) {
                try { onStep(label, call.name); } catch (_) {}
            }

            // Lock BEFORE executing the request. This matters if the model
            // emits multiple web_search calls in the same turn or if the
            // surrounding request later retries on another Gemini key.
            // The first logical search owns the question for the rest of the
            // request; all later model rounds receive no tools at all.
            if (call.name === 'web_search') {
                scopedSearchState.used = true;
            }

            const result = await executeToolCall(call.name, call.args, { tavilyKeys, archivedFiles, searchCache });

            if (call.name === 'web_search') scopedSearchState.result = result;
            if (call.name === 'get_archived_file') lastToolCallWasArchiveRead = true;

            if (result.askUser) earlyAskUser = result.askUser;

            responseParts.push({
                functionResponse: {
                    name: call.name,
                    response: result
                }
            });
        }

        if (earlyAskUser) {
            return {
                finalText: earlyAskUser,
                finishReason: 'ASK_USER',
                usage: lastUsage,
                askUser: earlyAskUser
            };
        }

        workingContents.push({
            role: 'user',
            parts: responseParts
        });
        // loop continues: send the tool result(s) back to the model for round 2+
    }

    // Safety net: too many tool rounds without a final answer.
    return {
        finalText: 'متأسفم، در پردازش این درخواست به مشکل خوردم (تعداد مراحل زیاد شد). می‌تونی دوباره یا واضح‌تر بپرسی؟',
        finishReason: 'TOOL_LOOP_LIMIT',
        usage: lastUsage,
        askUser: null
    };
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
// FIX: this was set to 12MB while the binary-file-specific check further
// down (MAX_BINARY_BASE64_CHARS) allows up to 15MB of base64 for a single
// file. Since a request also includes JSON overhead (history, headers,
// other fields) on top of the file's base64, a video sitting anywhere near
// that 15MB per-file limit was being rejected HERE FIRST with a generic
// "file too large" error, before ever reaching the video-specific logic -
// even though it was technically within the documented per-file limit.
// Raised so the outer guard only ever catches requests the inner check
// wouldn't already accept, with headroom for JSON overhead.
const MAX_REQUEST_BYTES = 20 * 1024 * 1024; // 20MB

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

    const usageGeminiKeys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
        .split(',').map(k => k.trim()).filter(Boolean);

    if (req.method === 'GET' && String(req.query?.mode || '') === 'usage') {
        return res.status(200).json({
            source: 'virtual-bot-observed-backend-requests',
            quota: { rpm: null, tpm: null, rpd: null, note: 'Google live quota is not exposed by the Gemini API key. These are only real requests observed by this backend instance.' },
            instanceScoped: !hasUsageKV(),
            storage: hasUsageKV() ? 'vercel-kv' : 'memory-fallback',
            generatedAt: new Date().toISOString(),
            keys: await getGoogleUsageSnapshot(usageGeminiKeys)
        });
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
            model,
            // FEATURE (persistent file memory): archivedFileNames is cheap
            // (just strings) and always present so the system prompt can
            // tell the model what's available; archivedFiles carries the
            // actual content but is only ever read inside executeToolCall
            // (get_archived_file), never injected into the prompt directly -
            // that's what keeps this free unless the model actually asks.
            // The client only ever sends its 3 most-recently-sent files here
            // (see recentArchivedFiles() in index.html) - older files stay
            // in the client's IndexedDB but are simply not part of this
            // request at all, which is what actually bounds per-request
            // token cost as a chat's file history grows over time.
            archivedFileNames: rawArchivedFileNames,
            archivedFiles: rawArchivedFiles
        } = req.body || {};

        const archivedFileNames = Array.isArray(rawArchivedFileNames) ? rawArchivedFileNames.filter(n => typeof n === 'string') : [];
        const archivedFiles = Array.isArray(rawArchivedFiles)
            ? rawArchivedFiles.filter(f => f && typeof f.name === 'string' && typeof f.content === 'string')
            : [];

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

        // FIX: shared across every key/model retry attempt for THIS one
        // incoming request only (never persisted, never shared across
        // requests) - see fetchTavilyResults comment for why this exists.
        const searchCache = new Map();
        // Hard request-scoped guard: survives Gemini model/key retries.
        // Once one logical web_search starts, no later retry is allowed to
        // expose tools or issue another web_search for this question.
        const searchState = { used: false, result: null };

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
                    type: 'configuration_error',
                    stage: 'config',
                    category: 'missing_api_keys'
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
        | Web Search
        |--------------------------------------------------------------------------
        | FIX: search used to be decided here, up-front, by matching the
        | user's text against a fixed Persian keyword list - which missed
        | anything phrased differently. Search is now a real tool the model
        | itself can call mid-conversation (see runAgentLoop / GEMINI_TOOLS),
        | at most once per incoming question, based on actually
        | understanding the question rather than string matching. Nothing
        | needs to happen here anymore; X-Search-Performed is still reported
        | for observability, based on whether the agent loop ends up
        | actually calling the tool (set later, once we know).
        */

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
        // NOTE: kept in sync with MAX_BACKEND_BASE64_CHARS in the frontend's
        // processIncomingFile() video branch (index.html) - the client
        // checks against this same number BEFORE showing "ویدیو آماده", so
        // a compressed video that passes client-side never gets silently
        // 413'd here. If this number changes, update both places.
        const MAX_BINARY_BASE64_CHARS = 15 * 1024 * 1024; // ~15MB of base64 text

        // FIX (root cause of "video attachments hang forever, no reply"):
        // Gemini's streamGenerateContent endpoint does not reliably support
        // function-calling `tools` in the same request as an inline video
        // part - on several model versions the request either gets stuck
        // with no chunks ever arriving, or errors in a way that looked to
        // the user like an endless "typing..." indicator, because nothing
        // ever reached finishReason to end the SSE stream. This affected
        // ALL videos, including small ones sent uncompressed, since the
        // trigger is "a video is attached", not file size. We now detect
        // that up front and skip attaching `tools` for this request - the
        // model still fully understands/describes the video, it just can't
        // ALSO call web_search/ask_user in that same turn (extremely rare
        // to need both at once, and a working reply matters far more).
        let hasVideoAttachment = false;

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

                hasVideoAttachment = true;
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

        // FIX: مدل هیچ‌وقت تاریخ واقعی امروز رو نمی‌دونه — فقط از دیتای
        // آموزشیش (که قدیمیه) حدس می‌زنه، برای همین وقتی می‌پرسی "امروز
        // چندمه" جواب اشتباه می‌ده. این‌جا تاریخ واقعی سرور (شمسی + میلادی
        // + ساعت، به وقت تهران) رو مستقیم بهش می‌گیم تا همیشه درست باشه.
        const now = new Date();
        const jalaliDate = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
            timeZone: 'Asia/Tehran',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }).format(now);
        const gregorianDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Tehran',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(now);
        const tehranTime = new Intl.DateTimeFormat('fa-IR', {
            timeZone: 'Asia/Tehran',
            hour: '2-digit',
            minute: '2-digit'
        }).format(now);
        const dateContext = `
اطلاعات زمان واقعی (این تاریخ همیشه درست است، حتی اگر با دانش قبلی‌ات فرق دارد؛ همیشه همین را ملاک بده):
امروز: ${jalaliDate} (میلادی: ${gregorianDate})
ساعت فعلی به وقت تهران: ${tehranTime}
`;

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
        systemText += dateContext;
        systemText += `
ابزارها:
- ابزار web_search را هر وقت واقعاً به اطلاعات به‌روز/زنده نیاز داری صدا بزن (قیمت، اخبار، رویدادها، چیزی که ممکن است بعد از آموزشت تغییر کرده باشد). برای سؤالات عمومی/ثابت (تعریف، مفهوم، تاریخ گذشته) نیازی به سرچ نیست.
- برای یک سؤال ساده، فقط یک‌بار سرچ کن و با همان نتایج جواب بده. دوباره سرچ کردن (با کوئری متفاوت یا حتی مشابه) فقط وقتی مجاز است که نتیجه‌ی سرچ اول واقعاً ناکافی/نامرتبط بود یا سؤال چند بخش جدا از هم دارد که هرکدام نیاز به سرچ مجزا دارند. سرچ‌های تکراری روی همان موضوع را انجام نده.
- اگر تصمیم گرفتی هر ابزار را صدا بزنی، مخصوصاً web_search، قبل از Function Call هیچ متن توضیحی، مقدمه یا جمله‌ای تولید نکن؛ Function Call باید اولین خروجی مدل در آن نوبت باشد. بعد از دریافت نتیجه‌ی ابزار، پاسخ نهایی را به‌صورت عادی و streaming تولید کن.
- ابزار ask_user را فقط برای تغییرات اساسی/غیرقابل‌برگشت یا تصمیم‌هایی با چند راه‌حل متفاوت صدا بزن (مثلاً بازنویسی کامل یک فایل، حذف بخش بزرگ کد). برای کارهای کوچک یا واضح، مستقیم انجام بده و از این ابزار استفاده نکن.
`;

        // FEATURE (persistent file memory): tell the model which files exist
        // in this chat's permanent archive (names only - the content is
        // fetched on-demand via get_archived_file, see GEMINI_TOOLS above).
        // If the archive is empty, say nothing extra so the prompt doesn't
        // grow for chats that never used this.
        if (archivedFileNames.length > 0) {
            systemText += `
فایل‌های آرشیوشده در این گفتگو (فقط نام - محتوا با ابزار get_archived_file قابل دریافت است):
${archivedFileNames.map(n => `- ${n}`).join('\n')}

فقط وقتی کاربر واقعاً به محتوای یکی از این فایل‌ها نیاز دارد یا ارجاع می‌دهد (نه صرفاً وقتی اسمش را می‌بینی)، ابزار get_archived_file را با نام دقیق فایل صدا بزن.
`;
        }

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
- وقتی بیش از یک فایل ضمیمه است، فیلد "file" برای هر آیتم اجباری است؛ نام فایل را دقیقاً از فهرست فایل‌های ضمیمه کپی کن.
- اگر تغییر مربوط به چند فایل است، برای هر فایل آیتم جداگانه با "file" بساز.

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
            // FIX (real streaming on Vercel): setHeader()+flushHeaders() was
            // relying on Node's default behavior, but Vercel's Node.js
            // Serverless Function runtime only switches a response into true
            // chunked/streaming mode once writeHead() is called explicitly
            // with the headers passed directly to it - without that exact
            // call, Vercel's platform layer can buffer the whole response
            // and flush it all at once when the function returns, no matter
            // how many times res.write()/res.flush() are called afterward.
            // This was the actual root cause of "the whole reply lands at
            // once with a delay" even though the SSE writes themselves were
            // already correct.
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

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
            // FIX (false "all 12 keys exhausted" after just 1-2 tries): this
            // used to be a flat 180s no matter how many keys/models exist to
            // try. A single slow attempt (e.g. a round that needs
            // get_archived_file - up to ~120s across two Gemini rounds) could
            // eat almost the whole budget, so the loop would then bail out
            // via the deadline check after only 1-2 attempts and surface
            // that one attempt's error as if it applied to every key. Scale
            // the deadline with how many keys actually exist so a real fleet
            // of keys gets a real chance to be tried, while a fast failure
            // (quota/429, which fails immediately at the upstream.ok check,
            // not after a timeout) barely uses any of that budget anyway.
            const overallDeadline =
                Date.now() + Math.min(600000, Math.max(180000, geminiKeys.length * 20000));

            let lastError = null;
            let attemptsTried = 0; // diagnostic: how many model/key combos actually got a real try

            outerLoop:
            for (
                const currentModel of modelsToTry
            ) {
                // FIX: try keys in health order (fewest recent consecutive
                // failures first) instead of always starting from index 0.
                // Previously `rotateKeysByHealth` was defined but never
                // called here, so a bad/rate-limited key at index 0 would
                // eat a full 6s timeout on *every single request* before
                // falling through to a healthy key — this was the other
                // big contributor to multi-second delays on non-lite
                // models (which, unlike flash-lite, have >1 key attempt
                // in the common case). Sorting first means a key that
                // just failed drops to the back of the line for this
                // request and subsequent ones, until it recovers.
                const orderedKeys =
                    rotateKeysByHealth(geminiKeys);

                for (
                    let k = 0;
                    k < orderedKeys.length;
                    k++
                ) {
                    if (
                        Date.now() >
                        overallDeadline
                    ) {
                        break outerLoop;
                    }

                    const currentKey =
                        orderedKeys[k];

                    attemptsTried++;

                    // Declared OUTSIDE the try so it's always defined by the
                    // time the catch block below runs — this was previously
                    // declared inside try{}, which is normally fine (same
                    // block scope as its catch), but a stale/partial deploy
                    // once left a version where the two were out of sync and
                    // threw "attemptStartedAt is not defined" here, which
                    // then hit the mid-stream error path instead of just
                    // logging the connect time. Hoisting it removes that
                    // class of bug entirely, regardless of deploy state.
                    let attemptStartedAt = Date.now();

                    try {
                        attemptStartedAt = Date.now();

                        log.info('model.attempt', {
                            mode: 'stream',
                            model: currentModel,
                            key: keyLabel(geminiKeys, currentKey)
                        });

                        const abortController = new AbortController();

                        // FIX: previously this whole section made one raw
                        // streamGenerateContent call and piped SSE chunks
                        // straight through - no room for the model to ever
                        // call a tool mid-answer. runAgentLoop drives a
                        // proper function-calling loop instead: the model
                        // can call web_search / ask_user as many times as it
                        // judges necessary, each call is narrated to the
                        // client immediately via a {step} event (so a slow
                        // search doesn't look like a silent hang), and only
                        // once the model returns a final text-only answer do
                        // we send it to the client. This trades raw
                        // token-by-token streaming of the final answer for
                        // real tool use - the reply still appears to the
                        // user as one flush (not the old incremental
                        // typing), but with live "در حال انجام..." steps
                        // along the way to fill that gap.
                        let searchWasPerformed = false;
                        const requestSearchIntent = looksLikeWebSearchIntent(searchQueryBase || text);

                        // FIX (heavy code UX): code blocks now stream live,
                        // chunk-by-chunk, exactly like normal prose - no more
                        // buffering the whole fenced block and flushing it in
                        // one piece, and no more fake "در حال نوشتن کد..."
                        // step event standing in for it (that event used to
                        // fire on ANY ``` fence, including ones that weren't
                        // real code, which made it misleading). We still keep
                        // a tiny carry buffer so a ``` marker split across two
                        // raw chunks isn't sent as two separate backticks -
                        // that's purely a transport-safety detail and has no
                        // effect on what the user sees typed out.
                        const codeStreamGate = (() => {
                            let carry = ''; // holds a partial ``` at chunk boundary

                            const emitText = (t) => {
                                if (!t) return;
                                res.write(`data: ${JSON.stringify({ text: t })}\n\n`);
                                if (typeof res.flush === 'function') res.flush();
                            };

                            return function feed(rawChunk) {
                                let chunk = carry + rawChunk;
                                carry = '';

                                // If the chunk ends mid-fence-marker (e.g. "``"),
                                // hold the tail back until the next chunk so we
                                // don't split a ``` marker across two SSE events.
                                const tailBackticks = chunk.match(/`{1,2}$/);
                                if (tailBackticks && !chunk.endsWith('```')) {
                                    carry = tailBackticks[0];
                                    chunk = chunk.slice(0, -carry.length);
                                }

                                emitText(chunk);
                            };
                        })();

                        const agentResult = await runAgentLoop({
                            currentModel,
                            currentKey,
                            systemText,
                            contents,
                            tavilyKeys,
                            archivedFiles,
                            searchCache,
                            searchState,
                            searchIntent: requestSearchIntent,
                            signal: abortController.signal,
                            disableTools: hasVideoAttachment,
                            hasVideoAttachment,
                            onStep: (label, toolName) => {
                                if (toolName === 'web_search') searchWasPerformed = true;
                                res.write(
                                    `data: ${JSON.stringify({ step: label })}\n\n`
                                );
                                if (typeof res.flush === 'function') res.flush();
                            },
                            onChunk: (textChunk) => {
                                codeStreamGate(textChunk);
                            }
                        });

                        markKeyResult(currentKey, true);
                        log.info('model.connected', {
                            mode: 'stream',
                            model: currentModel,
                            connectMs: Date.now() - attemptStartedAt
                        });

                        try {
                            res.setHeader('X-Search-Performed', String(searchWasPerformed));
                        } catch (_) {
                            // Headers may already be flushed by the time we know this;
                            // harmless to skip, X-Search-Performed is observability-only.
                        }

                        // NOTE: a normal final answer's text has already been
                        // sent to the client incrementally via onChunk above,
                        // so it must NOT be written again here (that would
                        // duplicate the reply). The one exception is the
                        // ask_user path: that text comes from the tool result
                        // itself, never passed through onChunk, so it still
                        // needs to be sent once here.
                        if (agentResult.askUser && agentResult.finalText) {
                            res.write(
                                `data: ${JSON.stringify({ text: agentResult.finalText })}\n\n`
                            );
                            if (typeof res.flush === 'function') res.flush();
                        }

                        // truncated=true tells the client the model was cut
                        // off by its own output-token limit (not an error,
                        // not the user pressing Stop) so it can offer to
                        // continue instead of treating the reply as final.
                        const truncated =
                            agentResult.finishReason === 'MAX_TOKENS';

                        res.write(
                            `data: ${JSON.stringify({
                                done: true,
                                finishReason: agentResult.finishReason,
                                truncated,
                                askUser: !!agentResult.askUser
                            })}\n\n`
                        );

                        log.info('request.finish_reason', {
                            model: currentModel,
                            finishReason: agentResult.finishReason || 'unknown'
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
                        const classified = classifyGeminiError(error?.body || error);
                        if (classified.keySpecific) markKeyResult(currentKey, false);
                        log.error('model.stream_error', {
                            model: currentModel,
                            category: classified.category,
                            status: classified.status,
                            providerCode: classified.providerCode,
                            message: classified.rawMessage || error?.message || String(error),
                            wasTimeout: classified.category === 'timeout',
                            keySpecific: classified.keySpecific,
                            connectMs: Date.now() - attemptStartedAt
                        });

                        lastError = {
                            ...(error?.body && typeof error.body === 'object' ? error.body : {}),
                            _classification: classified
                        };

                        // BUGFIX (silent empty reply after a tool call): this
                        // specific error means the model itself returned an
                        // empty/blocked reply right after reading an
                        // archived file - it's not a key/quota problem, so
                        // retrying with another key or model will almost
                        // certainly reproduce the exact same empty result.
                        // Stop immediately and tell the user what actually
                        // happened instead of silently burning through every
                        // remaining key/model and only then showing the
                        // generic "server busy" message.
                        if (error?.body?.type === 'empty_after_tool_call') {
                            break outerLoop;
                        }
                    }
                }
            }

            // Surface Gemini's own reason (status + message), not just our
            // generic Persian fallback, so it's possible to tell apart a
            // real daily quota exhaustion (RESOURCE_EXHAUSTED) from a
            // per-minute rate limit (429 without RESOURCE_EXHAUSTED, often
            // hit faster when web_search is on since each turn costs 2+
            // Gemini calls instead of 1) from anything else (auth,
            // permission, model-not-found, etc). Both live only in the
            // "detail" field the client already renders behind "جزئیات
            // بیشتر", so no UI changes are needed to see them.
            const classification = lastError?._classification || classifyGeminiError(lastError);
            const geminiStatusCode = classification.status;
            const geminiReasonMessage = classification.rawMessage || 'unknown';

            log.error('request.all_models_failed', {
                mode: 'stream',
                category: classification.category,
                attemptsTried,
                totalPossible: modelsToTry.length * geminiKeys.length,
                geminiStatusCode,
                lastError: geminiReasonMessage
            });

            res.write(
                `data: ${JSON.stringify({
                    error: {
                        message: classification.message,
                        type: classification.category,
                        category: classification.category,
                        retryable: classification.retryable,
                        stage: 'stream_generation',
                        detail:
                            `Gemini${geminiStatusCode ? ' [' + geminiStatusCode + ']' : ''}${classification.providerCode ? ' [' + classification.providerCode + ']' : ''}: ${geminiReasonMessage}` +
                            ` (attempts: ${attemptsTried}/${modelsToTry.length * geminiKeys.length})`
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

        // FIX: this deadline was left at the old 60s value while the
        // streaming path above was already raised to 180s. A video
        // attachment routed through the non-stream path (or a slow non-video
        // reply that needed a second model/key retry) could get cut off here
        // well before Gemini finished, producing the exact "پاسخ بیش از حد
        // طول کشید" timeout being reported. Matching it to the same 180s
        // (and further via hasVideoAttachment inside runAgentLoop's own
        // per-round timeout) keeps both code paths consistent.
        // FIX (false "all keys exhausted" after just 1-2 tries): same
        // reasoning as the streaming path above - scale with key count.
        const overallDeadline =
            Date.now() + Math.min(600000, Math.max(180000, geminiKeys.length * 20000));

        let lastError = null;
        let attemptsTried = 0;

        outerLoopNonStream:
        for (
            const currentModel of modelsToTry
        ) {
            // Same health-ordering fix as the streaming loop above.
            const orderedKeysNonStream =
                rotateKeysByHealth(geminiKeys);

            for (
                let k = 0;
                k < orderedKeysNonStream.length;
                k++
            ) {
                if (
                    Date.now() >
                    overallDeadline
                ) {
                    break outerLoopNonStream;
                }

                const currentKey =
                    orderedKeysNonStream[k];

                attemptsTried++;

                try {
                    log.info('model.attempt', {
                        mode: 'non-stream',
                        model: currentModel,
                        key: keyLabel(geminiKeys, currentKey)
                    });

                    const abortController = new AbortController();

                    // Same tool-calling loop as the streaming path (see
                    // comment there) - non-stream mode just doesn't narrate
                    // intermediate steps, since there's no open connection
                    // to push them over.
                    const agentResult = await runAgentLoop({
                        currentModel,
                        currentKey,
                        systemText,
                        contents,
                        tavilyKeys,
                        archivedFiles,
                        searchCache,
                        searchState,
                        signal: abortController.signal,
                        disableTools: hasVideoAttachment,
                        hasVideoAttachment,
                        onStep: null
                    });

                    markKeyResult(currentKey, true);
                    log.info('request.completed', {
                        mode: 'non-stream',
                        model: currentModel,
                        durationMs: Date.now() - requestStartedAt
                    });

                    // Shaped like Gemini's native generateContent response so
                    // any existing non-stream caller keeps working unchanged,
                    // even though the answer may have gone through one or
                    // more tool calls internally.
                    return res.status(200).json({
                        candidates: [
                            {
                                content: {
                                    role: 'model',
                                    parts: [{ text: agentResult.finalText || '' }]
                                },
                                finishReason: agentResult.finishReason || 'STOP'
                            }
                        ],
                        usageMetadata: agentResult.usage || undefined
                    });

                } catch (error) {
                    const classified = classifyGeminiError(error?.body || error);
                    if (classified.keySpecific) markKeyResult(currentKey, false);
                    log.error('model.error', {
                        mode: 'non-stream',
                        model: currentModel,
                        category: classified.category,
                        status: classified.status,
                        providerCode: classified.providerCode,
                        message: classified.rawMessage || error?.message || String(error),
                        keySpecific: classified.keySpecific
                    });

                    lastError = {
                        ...(error?.body && typeof error.body === 'object' ? error.body : {}),
                        _classification: classified
                    };

                    // See identical comment in the streaming path above.
                    if (error?.body?.type === 'empty_after_tool_call') {
                        break outerLoopNonStream;
                    }
                }
            }
        }

        const classification = lastError?._classification || classifyGeminiError(lastError);
        log.error('request.all_models_failed', {
            mode: 'non-stream',
            category: classification.category,
            attemptsTried,
            totalPossible: modelsToTry.length * geminiKeys.length,
            status: classification.status,
            lastError: classification.rawMessage || 'unknown'
        });

        return res.status(classification.category === 'empty_response' ? 502 : (classification.status && classification.status >= 400 && classification.status < 600 ? classification.status : 500)).json({
            error: {
                message: classification.message,
                type: classification.category,
                category: classification.category,
                retryable: classification.retryable,
                stage: 'non_stream_generation',
                detail:
                    `Gemini${classification.status ? ' [' + classification.status + ']' : ''}${classification.providerCode ? ' [' + classification.providerCode + ']' : ''}: ${classification.rawMessage || 'unknown'}` +
                    ` (attempts: ${attemptsTried}/${modelsToTry.length * geminiKeys.length})`
            }
        });

    } catch (globalError) {
        log.error('request.global_error', {
            message: globalError?.message || String(globalError)
        });

        // FIX (ERR_HTTP_HEADERS_SENT): this catch wraps the WHOLE handler,
        // including the streaming path below, which already calls
        // res.write()/res.setHeader() as soon as it starts sending SSE
        // chunks. If something throws AFTER that point (e.g. a late error
        // while reading the upstream stream), execution falls through to
        // here — and calling res.status(...).json(...) on a response whose
        // headers are already sent crashes with ERR_HTTP_HEADERS_SENT,
        // which is exactly what killed the reply instead of just failing
        // gracefully. We now check res.headersSent first: if the response
        // was never started, send the normal JSON error as before; if it
        // was already streaming, we can't send a fresh JSON body anymore,
        // so emit one last SSE error event (if the stream is still open)
        // and end the response instead of trying to set headers again.
        if (res.headersSent) {
            try {
                if (!res.writableEnded) {
                    res.write(
                        `data: ${JSON.stringify({
                            error: {
                                message: 'خطای داخلی سرور در میانه‌ی پاسخ. لطفاً دوباره امتحان کن.',
                                type: 'internal_error',
                                category: 'handler_mid_stream',
                                stage: 'handler_mid_stream',
                                detail: globalError?.message || String(globalError)
                            }
                        })}\n\n`
                    );
                    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                }
            } catch (_) {
                // Stream may already be broken/closed — nothing more we can do.
            }
            if (!res.writableEnded) {
                try { res.end(); } catch (_) {}
            }
            return;
        }

        return res.status(500).json({
            error: {
                message: 'خطای داخلی سرور. لطفاً دوباره امتحان کن.',
                type: 'internal_error',
                category: 'handler',
                stage: 'handler',
                detail: globalError?.message || String(globalError)
            }
        });
    }
}

module.exports = handler;
