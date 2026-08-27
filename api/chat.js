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
        // NOTE: Google's free-tier generate_content quota (RPM/RPD) is scoped
        // PER API KEY / PER PROJECT, not shared across unrelated projects.
        // When each key comes from its own separate Google account/project
        // (as is the case here), one key hitting "free_tier ... quota
        // exceeded" says nothing about the other keys' quota - so this must
        // stay keySpecific + retryable so the outer loop rotates to the next
        // key instead of aborting the whole request.
        const freeTierPerKeyQuota =
            /generate_content_[^\s]*free_tier[^\s]*requests/.test(normalized) ||
            (/free.?tier/.test(normalized) && /quota|exceeded|resource_exhausted/.test(normalized)) ||
            /daily.?quota|quota.?exceeded|exceeded your current quota/.test(normalized);

        const retryAfterMatch = normalized.match(/retry in\s+([0-9]+(?:\.[0-9]+)?)s/);
        const retryAfterSeconds = retryAfterMatch ? Number(retryAfterMatch[1]) : null;

        if (freeTierPerKeyQuota) {
            return {
                category: 'quota_exhausted',
                retryable: true,
                keySpecific: true,
                message: 'سهمیه Free Tier این کلید تمام شده؛ کلید بعدی بررسی می‌شود.',
                status: status || 429,
                providerCode,
                rawMessage,
                retryAfterSeconds
            };
        }

        return {
            category: 'rate_limit',
            retryable: true,
            keySpecific: true,
            message: 'این کلید به محدودیت سرعت درخواست رسیده است؛ کلید بعدی بررسی می‌شود.',
            status: status || 429,
            providerCode,
            rawMessage,
            retryAfterSeconds
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
async function recordGoogleAttempt(key, status, keyIndex) {
    // Always update the in-process counter synchronously. This is the source
    // used immediately if persistent telemetry is unavailable.
    recordGoogleAttemptMemory(key, status);

    if (!hasUsageKV()) return;

    // IMPORTANT: do NOT fire-and-forget the persistent write. On Vercel/serverless
    // the function can finish or be suspended before an un-awaited Promise has
    // flushed, which made the dashboard show `0 requests` even though Gemini had
    // already returned a real 429. The request must be counted before we move on.
    const now = Date.now();
    const id = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    const zsetKey = `${USAGE_KV_PREFIX}:key:${keyIndex}`;
    const metaKey = `${USAGE_KV_PREFIX}:meta:${keyIndex}`;
    const score = String(now);

    try {
        await Promise.all([
            usageKvCommand('ZADD', [zsetKey, score, id]),
            usageKvCommand('EXPIRE', [zsetKey, String(USAGE_TTL_SECONDS)]),
            usageKvCommand('HINCRBY', [metaKey, 'totalObserved', '1']),
            usageKvCommand('HINCRBY', [metaKey, status >= 200 && status < 300 ? 'successfulObserved' : 'errorsObserved', '1']),
            usageKvCommand('HSET', [metaKey, 'lastStatus', String(Number.isFinite(status) ? status : ''), 'lastAt', new Date(now).toISOString()]),
            usageKvCommand('EXPIRE', [metaKey, String(90 * 24 * 60 * 60)])
        ]);
    } catch (error) {
        log.warn('usage.storage_write_failed', { message: error?.message || String(error) });
    }
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
        const keyIndex = i + 1;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);
            let response;
            try {
                response = await fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: titlePrompt }] }] }),
                        signal: controller.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }

            // Title generation is a real Gemini request too, so it must appear
            // in the same usage dashboard as the main chat requests.
            await recordGoogleAttempt(key, response.status, keyIndex);

            if (!response.ok) {
                let body = null;
                try { body = await response.json(); } catch (_) {}
                const classified = classifyGeminiError({ status: response.status, body });
                if (!classified.retryable) break;
                continue;
            }

            const data = await response.json();
            let title = data?.candidates?.[0]?.content?.parts?.map(p => p?.text || '').join('').trim();
            if (title) {
                title = title.replace(/^["'«»]+|["'«»]+$/g, '').replace(/\.$/, '').trim();
                if (title.length > 40) title = title.slice(0, 40).trim() + '…';
                log.info('chat.title_generated', {});
                return title;
            }
        } catch (error) {
            const classified = classifyGeminiError(error);
            log.warn('chat.title_generation_failed', {
                keyIndex,
                category: classified.category,
                status: classified.status
            });
            if (!classified.retryable) break;
        }
    }

    log.warn('chat.title_generation_fallback', { reason: 'title unavailable' });
    return fallback;
}

/*
|--------------------------------------------------------------------------
| Tavily
|--------------------------------------------------------------------------
*/

async function fetchTavilyResults(query, tavilyKeys, searchCache) {
    if (!tavilyKeys || tavilyKeys.length === 0) {
        return {
            ok: false,
            code: 'search_not_configured',
            message: 'سرویس جستجو پیکربندی نشده است.'
        };
    }

    // One logical web_search = at most ONE Tavily HTTP request.
    // The previous implementation looped over every Tavily key after a
    // failure. That looked like one search in the UI, but could actually
    // generate many provider requests for the same user question.
    const cacheKey = String(query).trim().toLowerCase();

    if (searchCache && searchCache.has(cacheKey)) {
        log.info('search.cache_hit', { queryPreview: String(query).slice(0, 100) });
        return searchCache.get(cacheKey);
    }

    // Spread requests across healthy keys, but never retry another key inside
    // this logical search. A different incoming request can select another
    // key, so a fleet of keys is still useful without violating the one-search
    // limit.
    const orderedTavilyKeys = rotateKeysByHealth(tavilyKeys);
    const currentKey = orderedTavilyKeys[0];
    const keyIndex = tavilyKeys.indexOf(currentKey) + 1;

    const fail = (code, message, status = null, retryable = false) => {
        const failure = {
            ok: false,
            code,
            status,
            retryable,
            message
        };
        if (searchCache) searchCache.set(cacheKey, failure);
        return failure;
    };

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

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
            let body = null;
            try { body = await response.json(); } catch (_) {}

            const status = response.status;
            const providerMessage =
                body?.detail ||
                body?.message ||
                body?.error ||
                `HTTP ${status}`;

            markKeyResult(currentKey, false);

            if (status === 401 || status === 403) {
                return fail(
                    'search_invalid_key',
                    'کلید سرویس جستجو معتبر نیست یا دسترسی آن رد شده است.',
                    status,
                    false
                );
            }

            if (status === 429) {
                return fail(
                    'search_rate_limit',
                    'سرویس جستجو به محدودیت درخواست رسیده است. این جستجو فقط یک‌بار تلاش شد تا درخواست‌های اضافی ایجاد نشود.',
                    status,
                    true
                );
            }

            if (status >= 500) {
                return fail(
                    'search_provider_error',
                    'خود سرویس جستجو موقتاً با خطای سرور مواجه شد.',
                    status,
                    true
                );
            }

            return fail(
                'search_http_error',
                `سرویس جستجو درخواست را رد کرد (${status}).`,
                status,
                false
            );
        }

        const data = await response.json();

        if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
            markKeyResult(currentKey, true);
            return fail(
                'search_no_results',
                'جستجو انجام شد اما نتیجه‌ای برای این عبارت پیدا نشد.',
                200,
                false
            );
        }

        markKeyResult(currentKey, true);

        const formatted = data.results
            .map(
                r =>
                    `عنوان: ${r.title || 'بدون عنوان'}\n` +
                    `منبع: ${r.url || 'نامشخص'}\n` +
                    `محتوا: ${String(r.content || '').slice(0, 1800)}`
            )
            .join('\n\n---\n\n');

        const success = {
            ok: true,
            code: 'search_success',
            status: 200,
            result: formatted
        };

        if (searchCache) searchCache.set(cacheKey, success);

        log.info('search.succeeded', {
            keyIndex,
            resultCount: data.results.length
        });

        return success;

    } catch (error) {
        markKeyResult(currentKey, false);

        if (error?.name === 'AbortError') {
            return fail(
                'search_timeout',
                'جستجوی وب در زمان تعیین‌شده پاسخ نداد.',
                408,
                true
            );
        }

        log.error('search.request_failed', {
            keyIndex,
            message: error?.message || String(error)
        });

        return fail(
            'search_network_error',
            'ارتباط با سرویس جستجوی وب برقرار نشد.',
            null,
            true
        );
    }
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


/*
|--------------------------------------------------------------------------
| File Structure Intelligence
|--------------------------------------------------------------------------
| This is intentionally lightweight and dependency-free. It does not try to
| compile or execute user code; it extracts a stable structural map that the
| model can use before producing file-edit operations. The same tool is used
| for every text/code file type we can reasonably inspect.
*/
function looksLikeFileEditIntent(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    return /(?:ویرایش|ادیت|تغییر بده|تغییرش بده|اضافه کن|اضافه‌|حذف کن|پاک کن|اصلاح کن|درست کن|پیاده کن|پیاده‌|بروزرسانی کن|آپدیت کن|به‌روز کن|جایگزین کن|بازنویسی کن|اضافه کردن|حذف کردن|تغییر دادن|اصلاح کردن|modify|edit|update|delete|remove|add|insert|replace|rewrite|refactor)/i.test(t);
}

/*
|--------------------------------------------------------------------------
| Versioned output filename
|--------------------------------------------------------------------------
| اگه اسم فایل به عدد ختم بشه (index58 -> index59) عدد یکی زیاد می‌شه.
| اگه نه، برچسب _edited اضافه می‌شه (chat.js -> chat_edited.js)، و اگه از
| قبل _edited داشت شماره‌دار می‌شه (_edited -> _edited2 -> _edited3 ...).
| این جلوی اون مشکل "اسم خروجی با اسم ورودی یکیه و معلوم نیست کدوم ویرایش‌شده"
| رو می‌گیره.
*/
function nextEditedFileName(originalName) {
    const name = String(originalName || '').trim();
    if (!name) return 'edited_file';

    const dotIndex = name.lastIndexOf('.');
    const hasExt = dotIndex > 0 && dotIndex < name.length - 1;
    const base = hasExt ? name.slice(0, dotIndex) : name;
    const ext = hasExt ? name.slice(dotIndex) : '';

    const trailingNumberMatch = base.match(/^(.*?)(\d+)$/);
    if (trailingNumberMatch) {
        const prefix = trailingNumberMatch[1];
        const num = trailingNumberMatch[2];
        const nextNum = String(Number(num) + 1).padStart(num.length, '0');
        return `${prefix}${nextNum}${ext}`;
    }

    const editedMatch = base.match(/^(.*)_edited(\d*)$/);
    if (editedMatch) {
        const prefix = editedMatch[1];
        const currentNum = editedMatch[2] ? Number(editedMatch[2]) : 1;
        return `${prefix}_edited${currentNum + 1}${ext}`;
    }

    return `${base}_edited${ext}`;
}

/*
|--------------------------------------------------------------------------
| Transactional patch engine
|--------------------------------------------------------------------------
| apply_patch tool اینو صدا می‌زنه. هر patch باید دقیقاً یک‌بار در فایل
| پیدا بشه؛ اگه نشد یا مبهم بود، یه گزارش دقیق (نزدیک‌ترین context) برمی‌گرده
| که مدل با اون old رو اصلاح کنه و دوباره صدا بزنه - هیچ حدس/fuzzy-match ی
| در کار نیست.
*/
/*
|==========================================================================
| BLOCK-BASED FILE EDITING (rewrite - replaces inspect_file/get_file_chunk/
| apply_patch entirely for text files)
|==========================================================================
|
| چرا این بازنویسی لازم بود:
| معماری قبلی (inspect_file + get_file_chunk با startLine/endLine دلخواه +
| apply_patch با old/new متنی یا خط‌محور) سه دسته باگ جدا تولید می‌کرد که هر
| بار یکی رفع می‌شد و بعدی سر بر می‌آورد:
|   ۱) overlap جزئی بین دو خواندن (نه subset دقیق، نه کاملاً قبل از قبلی)
|      هیچ‌جا تشخیص داده نمی‌شد -> مدل بخشی را دوباره می‌خواند.
|   ۲) state پیشرفت (کدام خط‌ها خوانده/ویرایش شده) داخل runAgentLoop تعریف
|      می‌شد -> با هر retry (کلید/مدل بعدی روی همان درخواست HTTP) از صفر
|      ساخته می‌شد و مدل کاملاً فراموش می‌کرد کجا بوده.
|   ۳) apply_patch با تطبیق متنی (old/new) در فایل‌های بزرگ شکننده بود: اگر
|      مدل حتی یک کاراکتر (فاصله/کوتیشن) را از حافظه بازسازی می‌کرد، کل
|      patch رد می‌شد.
|
| راه‌حل: به‌جای محدوده‌ی خط دلخواه، فایل به بلوک‌های شماره‌دار و
| ثابت (توسط کد، نه مدل) تقسیم می‌شود. مدل فقط با شماره‌ی بلوک کار می‌کند -
| نه محاسبه‌ی خط، نه تطبیق متنی. state پیشرفت (کدام بلوک خوانده/ویرایش شده،
| آیا verify نهایی بعد از آخرین ویرایش انجام و پاس شده) در یک آبجکت واحد
| (BlockFileState) نگه داشته می‌شود که خودِ caller (سطح HTTP request، نه
| runAgentLoop) می‌سازد و بین همه‌ی retryهای همان درخواست مشترک است - دقیقاً
| مثل sharedRequestState برای inspect/chunk قبلی، اما این بار state واحد و
| کامل شامل خودِ محتوای فایل هم هست، نه پخش در چند Set/Map جدا.
|
| قوانین کلیدی:
|   - بلوک‌بندی قطعی و تکرارپذیر است: همان فایل همیشه همان بلوک‌ها را می‌دهد.
|   - write_block کل یک بلوک را با محتوای جدید جایگزین می‌کند (نه diff) -
|     مقاوم در برابر خطای کوچک متنی، چون کل بلوک بازنویسی می‌شود نه بخشی از آن.
|   - بعد از هر write_block، پرچم "verified" ریست می‌شود؛ مدل تا verify_file
|     را دوباره صدا نزند و پاس نشود، اجازه‌ی جواب نهایی (بدون ابزار) را
|     نمی‌گیرد - این را runAgentLoop در پایان هر round اجرا می‌کند، نه یک
|     قانون صرفاً در system prompt که قابل نادیده گرفتن باشد.
|
|==========================================================================
*/

const FILE_BLOCK_TARGET_LINES = 250; // اندازه‌ی هدف هر بلوک - نه سقف سخت، نزدیک‌ترین مرز منطقی (خط خالی/section) به این عدد انتخاب می‌شود

// یک فایل را به بلوک‌های ثابت تقسیم می‌کند. مرز هر بلوک تا حد امکان روی یک
// خط خالی یا مرز section (از analyzeFileStructure) قرار می‌گیرد تا وسط یک
// تابع/تگ قطع نشود؛ اما این فقط برای خوانایی preview است - چون write_block
// همیشه کل بلوک را عوض می‌کند نه یک semantic unit را، قطع شدن وسط تابع هیچ
// مشکل صحتی ایجاد نمی‌کند.
function computeFileBlocks(content, fileName) {
    const lines = String(content || '').split(/\r?\n/);
    const totalLines = lines.length;
    const blocks = [];

    if (totalLines === 0) {
        return [{ number: 1, startLine: 1, endLine: 0, preview: '(فایل خالی است)' }];
    }

    let analysis = null;
    try {
        analysis = analyzeFileStructure(content, fileName, '');
    } catch (_) {
        analysis = null;
    }
    const preferredBoundaries = new Set();
    if (analysis) {
        [...(analysis.sections || []), ...(analysis.functions || []), ...(analysis.classes || [])]
            .forEach(item => { if (item && Number.isFinite(item.line)) preferredBoundaries.add(item.line); });
    }

    let cursor = 1;
    let blockNumber = 1;
    while (cursor <= totalLines) {
        const idealEnd = Math.min(totalLines, cursor + FILE_BLOCK_TARGET_LINES - 1);
        let end = idealEnd;

        if (idealEnd < totalLines) {
            const searchWindow = 40;
            let bestEnd = null;
            for (let candidate = idealEnd; candidate > Math.max(cursor, idealEnd - searchWindow); candidate--) {
                const lineText = lines[candidate - 1];
                const nextLineIsBoundary = preferredBoundaries.has(candidate + 1);
                const thisLineBlank = lineText !== undefined && lineText.trim() === '';
                if (nextLineIsBoundary || thisLineBlank) {
                    bestEnd = candidate;
                    break;
                }
            }
            end = bestEnd || idealEnd;
        }

        const previewLines = lines.slice(cursor - 1, Math.min(end, cursor - 1 + 3));
        blocks.push({
            number: blockNumber,
            startLine: cursor,
            endLine: end,
            preview: previewLines.join('\n').slice(0, 200)
        });
        blockNumber++;
        cursor = end + 1;
    }

    return blocks;
}

// یک BlockFileState برای یک فایل می‌سازد. باید توسط caller (سطح HTTP
// request) ساخته شود و بین همه‌ی retryهای همان درخواست به runAgentLoop
// پاس داده شود - دقیقاً مثل sharedRequestState.
function createBlockFileState(file) {
    const lines = String(file.content || '').split(/\r?\n/);
    return {
        name: file.name,
        lines,
        blocks: computeFileBlocks(file.content || '', file.name),
        readBlocks: new Set(),
        editedBlocks: new Set(),
        verified: false,
        editedName: null
    };
}

// بلوک‌بندی را بعد از تغییر طول فایل دوباره محاسبه می‌کند. چون write_block
// می‌تواند طول بلوک نوشته‌شده را عوض کند، شماره‌ی بلوک‌های بعدی باید با
// خطوط جدید همخوانی داشته باشد. بازسازی از صفر ارزان و بدون edge-case است.
function recomputeBlocksAfterEdit(state) {
    const content = state.lines.join('\n');
    state.blocks = computeFileBlocks(content, state.name);
}

function formatBlockMapForModel(state) {
    const totalLines = state.lines.length;
    return {
        file: state.name,
        totalLines,
        totalBlocks: state.blocks.length,
        readBlocks: [...state.readBlocks].sort((a, b) => a - b),
        editedBlocks: [...state.editedBlocks].sort((a, b) => a - b),
        verified: state.verified,
        blocks: state.blocks.map(b => ({
            number: b.number,
            startLine: b.startLine,
            endLine: b.endLine,
            lineCount: b.endLine - b.startLine + 1,
            preview: b.preview,
            alreadyRead: state.readBlocks.has(b.number),
            alreadyEdited: state.editedBlocks.has(b.number)
        }))
    };
}

function tryApplyPatch(content, oldStr, newStr) {
    const firstIndex = content.indexOf(oldStr);
    const lastIndex = content.lastIndexOf(oldStr);

    if (firstIndex === -1) {
        return { success: false, reason: 'not_found' };
    }
    if (firstIndex !== lastIndex) {
        return { success: false, reason: 'ambiguous' };
    }
    return {
        success: true,
        content: content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length)
    };
}

function buildPatchFailureReport(content, oldStr, reasonText) {
    const oldLines = String(oldStr || '').split('\n');
    const firstLine = oldLines[0].trim();
    const contentLines = content.split('\n');

    const candidates = [];
    contentLines.forEach((line, idx) => {
        if (firstLine && line.includes(firstLine.slice(0, Math.min(20, firstLine.length)))) {
            const start = Math.max(0, idx - 3);
            const end = Math.min(contentLines.length, idx + 4);
            candidates.push({
                lineNumber: idx + 1,
                context: contentLines.slice(start, end).join('\n')
            });
        }
    });

    return {
        reason: reasonText,
        candidatesFound: candidates.length,
        candidates: candidates.slice(0, 5),
        hint: 'old را دقیقاً از یکی از این context ها کپی کن (کاراکتر به کاراکتر، شامل فاصله‌گذاری) تا یکتا شود، سپس دوباره apply_patch را صدا بزن.'
    };
}

function analyzeFileStructure(content, fileName = 'file', query = '') {
    const text = String(content || '');
    const lowerName = String(fileName || '').toLowerCase();
    const language = /\.(html?|htm)$/.test(lowerName) ? 'html'
        : /\.(css|scss|less)$/.test(lowerName) ? 'css'
        : /\.(py)$/.test(lowerName) ? 'python'
        : /\.(json)$/.test(lowerName) ? 'json'
        : /\.(ts|tsx)$/.test(lowerName) ? 'typescript'
        : /\.(jsx)$/.test(lowerName) ? 'javascript-react'
        : 'javascript';

    const lines = text.split(/\r?\n/);
    const out = {
        file: fileName,
        language,
        lineCount: lines.length,
        charCount: text.length,
        sections: [],
        functions: [],
        classes: [],
        variables: [],
        imports: [],
        eventHandlers: [],
        htmlElements: [],
        cssRules: [],
        queryMatches: []
    };

    const add = (arr, item) => { if (item && arr.length < 120) arr.push(item); };
    const lineOf = index => text.slice(0, index).split(/\r?\n/).length;

    // Section comments are especially valuable in this project because the
    // existing code uses named section separators extensively.
    const sectionRe = /(?:\/\/|\/\*+|<!--)\s*={2,}\s*([^\n=*-]+?)\s*={2,}|(?:\/\/|\/\*+|<!--)\s*([^\n]+?)\s*(?:\*\/|-->)?$/gm;
    let m;
    while ((m = sectionRe.exec(text)) && out.sections.length < 80) {
        const title = String(m[1] || m[2] || '').trim();
        if (title && !/^[-=]+$/.test(title) && title.length < 120) {
            add(out.sections, { name: title, line: lineOf(m.index) });
        }
    }

    if (language === 'html') {
        const tagRe = /<([a-z][\w:-]*)(?:\s+[^>]*?)?>/gi;
        const seen = new Map();
        while ((m = tagRe.exec(text)) && out.htmlElements.length < 120) {
            const tag = m[1].toLowerCase();
            const key = tag;
            const count = (seen.get(key) || 0) + 1;
            seen.set(key, count);
            if (['html','head','body','script','style','main','section','header','footer','nav','form','button','input','textarea','div'].includes(tag) || count <= 2) {
                const attrs = m[0];
                const id = (attrs.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
                const cls = (attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
                add(out.htmlElements, { tag, id, className: cls, line: lineOf(m.index) });
            }
        }
        const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
        while ((m = scriptRe.exec(text)) && out.sections.length < 120) {
            add(out.sections, { name: 'script', line: lineOf(m.index) });
        }
    } else if (language === 'css') {
        const cssRe = /([^{}]+)\{/g;
        while ((m = cssRe.exec(text)) && out.cssRules.length < 120) {
            const selector = m[1].trim().replace(/\s+/g, ' ');
            if (selector && selector.length < 180) add(out.cssRules, { selector, line: lineOf(m.index) });
        }
    } else if (language === 'python') {
        const importRe = /^\s*(?:from\s+([^\s]+)\s+)?import\s+(.+)$/gm;
        while ((m = importRe.exec(text)) && out.imports.length < 100) add(out.imports, { name: (m[1] ? `from ${m[1]} ` : '') + m[2].trim(), line: lineOf(m.index) });
        const fnRe = /^\s*(?:async\s+)?def\s+([A-Za-z_$][\w$]*)\s*\(/gm;
        while ((m = fnRe.exec(text)) && out.functions.length < 120) add(out.functions, { name: m[1], line: lineOf(m.index) });
        const clsRe = /^\s*class\s+([A-Za-z_$][\w$]*)/gm;
        while ((m = clsRe.exec(text)) && out.classes.length < 80) add(out.classes, { name: m[1], line: lineOf(m.index) });
    } else {
        const importRe = /(?:^|\n)\s*(?:import\s+[^;\n]+|const\s+[^;=]+\s*=\s*require\s*\([^\n]+\)|import\s*\([^\n]+\))/g;
        while ((m = importRe.exec(text)) && out.imports.length < 100) add(out.imports, { text: m[0].trim(), line: lineOf(m.index) });
        const fnRe = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
        while ((m = fnRe.exec(text)) && out.functions.length < 160) add(out.functions, { name: m[1] || m[2], line: lineOf(m.index) });
        const clsRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
        while ((m = clsRe.exec(text)) && out.classes.length < 80) add(out.classes, { name: m[1], line: lineOf(m.index) });
        const varRe = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
        while ((m = varRe.exec(text)) && out.variables.length < 160) add(out.variables, { name: m[1], line: lineOf(m.index) });
        const eventRe = /(?:addEventListener\s*\(\s*["']([^"']+)["']|\.on(?:click|change|submit|input|load)\s*=)/g;
        while ((m = eventRe.exec(text)) && out.eventHandlers.length < 100) add(out.eventHandlers, { event: m[1] || 'property-handler', line: lineOf(m.index) });
    }

    if (query) {
        const q = String(query).trim();
        if (q) {
            const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
            lines.forEach((line, i) => {
                const ll = line.toLowerCase();
                if (terms.some(t => ll.includes(t)) && out.queryMatches.length < 40) {
                    add(out.queryMatches, { line: i + 1, text: line.trim().slice(0, 220) });
                }
            });
        }
    }

    return out;
}

function formatFileStructureForModel(analysis) {
    const pick = (arr, key = 'name') => arr.slice(0, 60).map(x => key === 'text' ? x.text : `${x[key] || ''}${x.line ? ` (خط ${x.line})` : ''}`).filter(Boolean);
    return {
        file: analysis.file,
        language: analysis.language,
        lines: analysis.lineCount,
        sections: pick(analysis.sections),
        functions: pick(analysis.functions),
        classes: pick(analysis.classes),
        variables: pick(analysis.variables),
        imports: pick(analysis.imports, analysis.imports.some(x => x.name) ? 'name' : 'text'),
        eventHandlers: analysis.eventHandlers.slice(0, 60),
        htmlElements: analysis.htmlElements.slice(0, 80),
        cssRules: pick(analysis.cssRules, 'selector'),
        queryMatches: analysis.queryMatches.slice(0, 40)
    };
}


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
            },
            {
                // نقشه‌ی بلوک‌های فایل (شماره، محدوده‌ی خط، پیش‌نمایش، وضعیت
                // خوانده/ویرایش‌شده) همیشه در system prompt به مدل داده
                // می‌شود - نیازی به یک ابزار جدا برای "دیدن ساختار" نیست.
                // این ابزار فقط محتوای واقعی یک بلوک مشخص را برمی‌گرداند.
                name: 'read_block',
                description:
                    'محتوای واقعی یک بلوک مشخص از فایل را برمی‌گرداند (نه کل فایل). نقشه‌ی بلوک‌ها ' +
                    '(شماره هر بلوک، محدوده‌ی خط، پیش‌نمایش) از قبل در system prompt به تو داده شده - ' +
                    'فقط شماره‌ی بلوکی که واقعاً برای پاسخ/ویرایش لازم داری را اینجا بده. حدس زدن ' +
                    'محدوده‌ی خط لازم نیست و اصلاً پشتیبانی نمی‌شود - فقط شماره‌ی بلوک.',
                parameters: {
                    type: 'object',
                    properties: {
                        file: {
                            type: 'string',
                            description: 'نام دقیق فایل هدف (همانی که در نقشه‌ی بلوک‌ها آمده).'
                        },
                        block: {
                            type: 'number',
                            description: 'شماره‌ی بلوکی که می‌خواهی محتوایش را ببینی (از نقشه‌ی بلوک‌ها).'
                        }
                    },
                    required: ['file', 'block']
                }
            },
            {
                // جایگزین apply_patch: به‌جای تطبیق متنی شکننده (old/new) یا
                // محدوده‌ی خط دلخواه، کل یک بلوک با شماره‌ی مشخص با محتوای
                // جدید جایگزین می‌شود. قبل از پذیرفتن، فایل کامل (با این
                // بلوک جایگزین‌شده) از validatePatchedContent رد می‌شود تا
                // یک بلوک بد کل فایل را خراب نکند.
                name: 'write_block',
                description:
                    'محتوای یک بلوک مشخص را کامل با متن جدید جایگزین می‌کند. قبل از این ابزار حتماً ' +
                    'همان بلوک را یک‌بار با read_block خوانده باش تا محتوای واقعی اطراف تغییر را بدانی. ' +
                    'کل بلوک (نه فقط خط تغییریافته) را با newContent بده - هر خطی از بلوک قدیم که باید ' +
                    'بماند را هم دوباره در newContent بنویس، چون کل بلوک عوض می‌شود. بعد از این ابزار، ' +
                    'قبل از پاسخ نهایی حتماً verify_file را صدا بزن.',
                parameters: {
                    type: 'object',
                    properties: {
                        file: {
                            type: 'string',
                            description: 'نام دقیق فایل هدف.'
                        },
                        block: {
                            type: 'number',
                            description: 'شماره‌ی بلوکی که باید کامل جایگزین شود.'
                        },
                        newContent: {
                            type: 'string',
                            description: 'محتوای کامل جدید این بلوک (شامل خطوطی که تغییر نکرده‌اند اما باید بمانند).'
                        }
                    },
                    required: ['file', 'block', 'newContent']
                }
            },
            {
                // بررسی نهایی اجباری: فایل کامل (با تمام بلوک‌های ویرایش‌شده)
                // را دوباره می‌سازد و از همان چک ساختاری validatePatchedContent
                // (بالانس تگ/براکت، سنتکس JS) رد می‌کند. runAgentLoop مدل را
                // مجبور می‌کند این را بعد از آخرین write_block صدا بزند و
                // پاس کند، قبل از این‌که جواب نهایی (بدون tool call) پذیرفته
                // شود.
                name: 'verify_file',
                description:
                    'فایل کامل را (با تمام ویرایش‌های اعمال‌شده تا این لحظه) از نظر ساختاری/سنتکسی ' +
                    'بررسی می‌کند. باید حتماً بعد از آخرین write_block و قبل از تحویل نهایی صدا زده ' +
                    'شود. اگر مشکل پیدا کند، بلوک(های) مشکل‌دار را با read_block دوباره بخوان و با ' +
                    'write_block اصلاح کن، سپس دوباره verify_file را صدا بزن.',
                parameters: {
                    type: 'object',
                    properties: {
                        file: {
                            type: 'string',
                            description: 'نام دقیق فایلی که باید نهایی‌سازی و بررسی شود.'
                        }
                    },
                    required: ['file']
                }
            }
        ]
    }
];

// FIX (unnecessary web_search slowing down file-edit requests): when the
// user is editing an attached file, there is normally no reason for the
// model to reach for web_search - it just adds an extra round-trip (and
// extra token/quota usage) to a flow that is already the most
// quota-sensitive one in this file. Exclude web_search specifically (not
// the file-editing tools) whenever fileEditIntent is true, while still
// leaving it available for normal chat.
const GEMINI_TOOLS_NO_SEARCH = [
    {
        function_declarations:
            GEMINI_TOOLS[0].function_declarations.filter(
                fn => fn.name !== 'web_search'
            )
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
    if (name === 'read_block') {
        return `در حال خواندن بخش ${(args && args.block) || '?'} از فایل «${(args && args.file) || ''}»...`;
    }
    if (name === 'write_block') {
        return `در حال اعمال تغییرات روی بخش ${(args && args.block) || '?'} از فایل «${(args && args.file) || ''}»...`;
    }
    if (name === 'verify_file') {
        return `در حال بررسی نهایی فایل «${(args && args.file) || ''}»...`;
    }
    if (name === 'get_archived_file') {
        return `دارم فایل «${(args && args.name) || ''}» رو از آرشیو این گفتگو می‌خونم...`;
    }
    return 'در حال انجام یک مرحله...';
}

function getFileLanguageFromName(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (/\.(html?|htm)$/.test(lower)) return 'html';
    if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return 'javascript';
    return 'other';
}

// FIX (structural safety net for the new line-anchored patch mode): a
// line-anchored replacement never string-matches, so it CAN produce a
// broken file (unbalanced tag/brace, cut mid-token) if startLine/endLine
// were off by a line. This is a fast, dependency-free check - no model
// round, no API call - run synchronously right after building the
// candidate content and BEFORE it's accepted, so a broken patch is
// rejected the same way a failed string-match patch always was.
function validatePatchedContent(content, fileName) {
    const language = getFileLanguageFromName(fileName);
    if (language === 'javascript') {
        try {
            new Function(content);
            return { valid: true };
        } catch (error) {
            return { valid: false, reason: `سنتکس جاوااسکریپت بعد از این تغییر نامعتبر می‌شود: ${error?.message || error}` };
        }
    }
    if (language === 'html') {
        // Balance-check void-aware tag nesting rather than full DOM
        // parsing - enough to catch the common breakage (an unclosed or
        // mismatched tag from a bad line range) without a heavy parser.
        const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
        // FIX (validator too tolerant to actually catch broken HTML):
        // the previous version popped ANY unclosed tags nested deeper
        // than the matching one on every closing tag - e.g.
        // "<div><span></div>" was accepted as valid because the </div>
        // popped both "span" and "div" off the stack, treating the
        // missing </span> as if it had implicitly closed. That defeats
        // the whole point of this check for the block-based editor,
        // which has no other safety net once apply_patch's string-match
        // mode is gone. Real HTML DOES have a small set of elements that
        // are genuinely allowed to auto-close when a sibling/parent
        // starts or closes (li, td, tr, option, p, ...) - only THOSE are
        // still popped implicitly. Anything else left on the stack when
        // its ancestor closes is now a real error, matching what a real
        // browser's parser would actually do.
        const implicitlyClosableTags = new Set(['li','td','th','tr','option','p','dt','dd']);
        const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
        const stack = [];
        let m;
        while ((m = tagRe.exec(content))) {
            const tag = m[1].toLowerCase();
            const isClosing = m[0][1] === '/';
            const isSelfClosing = m[2] === '/' || voidTags.has(tag);
            if (isClosing) {
                const idx = stack.lastIndexOf(tag);
                if (idx === -1) {
                    return { valid: false, reason: `تگ بسته‌ی «</${tag}>» بدون تگ باز متناظر پیدا شد - احتمالاً محدوده‌ی خط اشتباه بوده.` };
                }
                // Anything between idx and the top of the stack must be
                // implicitly-closable, or this is a real unclosed tag.
                const skipped = stack.slice(idx + 1);
                const realGap = skipped.find(t => !implicitlyClosableTags.has(t));
                if (realGap) {
                    return { valid: false, reason: `تگ «<${realGap}>» قبل از «</${tag}>» بسته نشده - احتمالاً محدوده‌ی خط اشتباه بوده.` };
                }
                stack.length = idx;
            } else if (!isSelfClosing) {
                stack.push(tag);
            }
        }
        const remaining = stack.filter(t => !implicitlyClosableTags.has(t));
        if (remaining.length > 0) {
            return { valid: false, reason: `تگ(های) باز بدون بسته شدن باقی مانده: ${[...new Set(remaining)].slice(0, 5).join(', ')} - احتمالاً محدوده‌ی خط اشتباه بوده.` };
        }
        return { valid: true };
    }
    return { valid: true }; // unknown/other file types: no structural check available, accept as-is
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
        const MAX_ARCHIVED_FILE_CHARS = 70000; // raised from 40000 alongside MAX_TOOL_ROUNDS increase - edit flows need to see enough of a heavy file to build a matching patch
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

        // FIX (retry-on-archived-file produced no real edit): fileEditIntent
        // pre-analysis (analyzeFileStructure) previously only ran for files
        // attached directly in the current message (textFiles), never for
        // files pulled back from the archive. That meant an edit request
        // that resolved to an archived file (e.g. after Retry) got no
        // structural map at all, and the file-edit round had to build one
        // from scratch on top of already needing to construct + verify the
        // patch - routinely running out of round budget and silently
        // producing nothing. Give archive reads the same structural report.
        let structureNote = '';
        try {
            const analysis = analyzeFileStructure(content, found.name || fileName, '');
            structureNote = `\n\n[تحلیل ساختار این فایل آرشیوشده - قبل از تولید file-edit از آن استفاده کن]\n${formatFileStructureForModel(analysis)}\n`;
        } catch (error) {
            log.warn('file.structure.archived_preanalysis_failed', {
                message: error?.message || String(error)
            });
        }

        return {
            name: found.name,
            content,
            ...(truncated ? {
                note: 'این فایل خیلی بزرگ بود و فقط بخش ابتدایی آن (۷۰ هزار کاراکتر اول) بازگردانده شد. اگر بخش دیگری لازم است، به کاربر بگو که فایل کامل در دسترس نیست و باید بخش خاصی از آن را دوباره بفرستد.'
            } : {}),
            ...(structureNote ? { structure: structureNote } : {})
        };
    }

    if (name === 'read_block') {
        const fileName = String((args && args.file) || '').trim();
        const blockNumber = Number(args && args.block);
        const files = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : [];
        const found = files.find(f => f && (f.name === fileName || String(f.name || '').split('/').pop() === fileName.split('/').pop()));
        if (!found) {
            return { error: `فایل «${fileName}» در فایل‌های فعلی این درخواست پیدا نشد.` };
        }
        const state = ctx && ctx.blockStates && ctx.blockStates.get(found.name || fileName);
        if (!state) {
            return { error: `وضعیت بلوک‌بندی برای «${fileName}» پیدا نشد - این نباید رخ دهد.` };
        }
        if (!Number.isFinite(blockNumber)) {
            return { error: 'شماره‌ی بلوک نامعتبر است.' };
        }
        const block = state.blocks.find(b => b.number === blockNumber);
        if (!block) {
            return { error: `بلوک شماره ${blockNumber} وجود ندارد. فایل ${state.blocks.length} بلوک دارد (۱ تا ${state.blocks.length}).` };
        }
        const content = state.lines.slice(block.startLine - 1, block.endLine).join('\n');
        state.readBlocks.add(blockNumber);
        log.info('agent.tool.read_block', {
            name: state.name,
            block: blockNumber,
            startLine: block.startLine,
            endLine: block.endLine
        });
        return {
            file: state.name,
            block: blockNumber,
            startLine: block.startLine,
            endLine: block.endLine,
            content
        };
    }

    if (name === 'write_block') {
        const fileName = String((args && args.file) || '').trim();
        const blockNumber = Number(args && args.block);
        const newContent = String((args && args.newContent) ?? '');
        const files = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : [];
        const found = files.find(f => f && (f.name === fileName || String(f.name || '').split('/').pop() === fileName.split('/').pop()));
        if (!found) {
            return { success: false, error: `فایل «${fileName}» در فایل‌های فعلی این درخواست پیدا نشد.` };
        }
        const state = ctx && ctx.blockStates && ctx.blockStates.get(found.name || fileName);
        if (!state) {
            return { success: false, error: `وضعیت بلوک‌بندی برای «${fileName}» پیدا نشد - این نباید رخ دهد.` };
        }
        if (!Number.isFinite(blockNumber)) {
            return { success: false, error: 'شماره‌ی بلوک نامعتبر است.' };
        }
        const block = state.blocks.find(b => b.number === blockNumber);
        if (!block) {
            return { success: false, error: `بلوک شماره ${blockNumber} وجود ندارد. فایل ${state.blocks.length} بلوک دارد (۱ تا ${state.blocks.length}). اگر نقشه‌ی بلوک‌ها عوض شده (بعد از یک ویرایش قبلی)، از نقشه‌ی جدید در system prompt استفاده کن.` };
        }

        // Build the candidate full-file content with this block's lines
        // replaced, WITHOUT mutating state yet - validate first.
        const newBlockLines = newContent.split(/\r?\n/);
        const candidateLines = [
            ...state.lines.slice(0, block.startLine - 1),
            ...newBlockLines,
            ...state.lines.slice(block.endLine)
        ];
        const candidateContent = candidateLines.join('\n');

        const validation = validatePatchedContent(candidateContent, state.name);
        if (!validation.valid) {
            log.warn('agent.tool.write_block.rejected_invalid', {
                name: state.name,
                block: blockNumber,
                reason: validation.reason
            });
            return {
                success: false,
                error: `این تغییر رد شد چون فایل را نامعتبر می‌کند: ${validation.reason} بلوک را دوباره با read_block بررسی کن و newContent را اصلاح کن.`
            };
        }

        // Accept: commit the new lines, recompute the block map (line
        // numbers shift if the new block has a different length than the
        // old one), and mark this file as needing verify_file again before
        // it can be handed back as final.
        state.lines = candidateLines;
        state.editedBlocks.add(blockNumber);
        state.verified = false;
        recomputeBlocksAfterEdit(state);

        found.content = state.lines.join('\n');
        found._patched = true;
        found._editedName = found._editedName || nextEditedFileName(found.name || fileName);
        state.editedName = found._editedName;

        log.info('agent.tool.write_block.success', {
            name: state.name,
            editedName: found._editedName,
            block: blockNumber,
            newBlockCount: state.blocks.length
        });

        return {
            success: true,
            file: state.name,
            block: blockNumber,
            editedName: found._editedName,
            newTotalBlocks: state.blocks.length,
            note: 'بلوک با موفقیت بازنویسی شد. شماره‌ی بلوک‌های بعدی ممکن است عوض شده باشد - نقشه‌ی بلوک‌های به‌روز در پیام بعدی داده می‌شود. قبل از پاسخ نهایی حتماً verify_file را صدا بزن.'
        };
    }

    if (name === 'verify_file') {
        const fileName = String((args && args.file) || '').trim();
        const files = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : [];
        const found = files.find(f => f && (f.name === fileName || String(f.name || '').split('/').pop() === fileName.split('/').pop()));
        if (!found) {
            return { valid: false, error: `فایل «${fileName}» در فایل‌های فعلی این درخواست پیدا نشد.` };
        }
        const state = ctx && ctx.blockStates && ctx.blockStates.get(found.name || fileName);
        if (!state) {
            return { valid: false, error: `وضعیت بلوک‌بندی برای «${fileName}» پیدا نشد - این نباید رخ دهد.` };
        }

        const finalContent = state.lines.join('\n');
        const validation = validatePatchedContent(finalContent, state.name);
        state.verified = validation.valid;

        log.info('agent.tool.verify_file', {
            name: state.name,
            valid: validation.valid,
            reason: validation.valid ? null : validation.reason,
            editedBlockCount: state.editedBlocks.size
        });

        if (!validation.valid) {
            return {
                valid: false,
                error: `فایل نهایی مشکل ساختاری دارد: ${validation.reason} بلوک(های) مربوطه را با read_block بررسی و با write_block اصلاح کن، سپس دوباره verify_file را صدا بزن. تا این verify پاس نشود، نمی‌توانی پاسخ نهایی بدهی.`
            };
        }
        return {
            valid: true,
            file: state.name,
            editedName: found._editedName || state.name,
            editedBlockCount: state.editedBlocks.size,
            note: 'فایل بررسی شد و مشکل ساختاری ندارد. حالا می‌توانی پاسخ نهایی بدهی.'
        };
    }


    if (name === 'web_search') {
        const query = (args && args.query) || '';
        if (!query) return { error: 'query خالی بود.' };

        log.info('agent.tool.web_search', { queryPreview: query.slice(0, 100) });

        const search = await fetchTavilyResults(
            query,
            ctx.tavilyKeys,
            ctx.searchCache
        );

        if (!search?.ok) {
            return {
                result:
                    `[جستجوی وب ناموفق بود | ${search?.code || 'search_error'}] ` +
                    `${search?.message || 'سرویس جستجو نتوانست نتیجه‌ای برگرداند.'}`,
                searchError: {
                    code: search?.code || 'search_error',
                    status: search?.status ?? null,
                    retryable: !!search?.retryable
                }
            };
        }

        return {
            result: search.result,
            searchError: null
        };
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
async function runAgentLoop({ currentModel, currentKey, keyIndex, systemText, contents, tavilyKeys, archivedFiles, textFiles, onStep, onChunk, signal, disableTools, hasVideoAttachment, searchCache, searchState, searchIntent, fileEditIntent, sharedRequestState }) {
    // FIX (فایل‌های ۵۰۰۰+ خطی): با MAX_CHUNK_REQUEST_LINES=900، یک فایل
    // ۵۰۰۰ خطی حداقل به ۶-۷ بار get_file_chunk نیاز دارد اگر مدل مجبور
    // شود همه‌ی فایل را پیمایش کند، به‌علاوه‌ی inspect_file و apply_patch و
    // پاسخ نهایی. سقف قبلی (۷) عملاً همان لحظه که مدل به دومین/سومین
    // get_file_chunk می‌رسید تمام می‌شد. بالا بردنش برای این پروفایل کاری
    // ضروری است - نه یک "مقدار امن دلخواه"، بلکه حداقل فضای واقعی لازم.
    const MAX_TOOL_ROUNDS = 16;
    // FIX (روند/tool call های چندمرحله‌ای که وسط کار throw می‌کردند از صفر
    // شروع می‌شدند): قبلاً اینجا `[...contents]` یک کپی محلی می‌ساخت. تمام
    // push های بعدی (نتیجه جستجو، نتیجه tool call، پاسخ مدل) فقط روی همین
    // کپی اعمال می‌شدند. اگر throw وسط یکی از round ها اتفاق می‌افتاد (مثلاً
    // خطای موقتی شبکه در round 5 از 10)، caller با catch شدن throw، همان
    // `contents` اصلی و دست‌نخورده را برای attempt بعدی دوباره می‌فرستاد -
    // یعنی همه‌ی پیشرفت آن ۵ round دور ریخته می‌شد.
    // با mutate کردن مستقیم روی خودِ آرایه‌ی `contents` (که در جاوااسکریپت
    // by-reference پاس داده می‌شود)، هر push روی همان آرایه‌ای اعمال می‌شود
    // که caller (خط‌های runAgentLoop call site) نگه داشته. پس با throw شدن،
    // caller همان contents را - حالا شامل تمام round های موفقِ قبل از خطا -
    // به عنوان ورودی attempt بعدی پاس می‌دهد و ادامه از همان‌جا شروع می‌شود،
    // نه از صفر.
    let workingContents = contents;
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

    // BLOCK MAP SETUP: build (or reuse, if this is a retry of the same
    // HTTP request) one BlockFileState per text file, and inject the
    // block map into the system prompt. blockStates lives on
    // sharedRequestState (same object caller uses for the old
    // inspectedFilesThisRequest/chunkReadsPerFile, now repurposed) so a
    // key/model retry within the same request reuses the exact same
    // block boundaries and read/edit progress instead of rebuilding from
    // the original file content.
    const blockStates = sharedRequestState?.blockStates || new Map();
    if (fileEditIntent && Array.isArray(textFiles) && textFiles.length > 0) {
        try {
            if (onStep) onStep('در حال بررسی ساختار فایل...', 'read_block');
            const blockMaps = textFiles.map((f) => {
                const key = f.name || 'file';
                let state = blockStates.get(key);
                if (!state) {
                    state = createBlockFileState(f);
                    blockStates.set(key, state);
                }
                return formatBlockMapForModel(state);
            });
            systemText += `\n\n[نقشه‌ی بلوک‌های فایل - این نقشه از محتوای واقعی فعلی فایل ساخته شده است]\n${JSON.stringify(blockMaps, null, 2)}\n\n` +
                'قوانین ویرایش فایل:\n' +
                '۱. برای دیدن محتوای واقعی یک بلوک، read_block را با شماره‌ی همان بلوک صدا بزن - هرگز حدس نزن.\n' +
                '۲. برای تغییر، write_block را با شماره‌ی بلوک و کل محتوای جدید آن بلوک صدا بزن (خطوطی که تغییر نکرده‌اند را هم دوباره در newContent بنویس).\n' +
                '۳. بعد از یک یا چند write_block موفق، قبل از پاسخ نهایی حتماً verify_file را صدا بزن و مطمئن شو valid:true برگردانده - در غیر این صورت اجازه‌ی پاسخ نهایی را نداری.\n' +
                '۴. بعد از هر write_block موفق، شماره‌ی بلوک‌های فایل ممکن است تغییر کند (چون طول بلوک عوض شده) - همیشه از "newTotalBlocks" در نتیجه‌ی write_block یا نقشه‌ی جدید استفاده کن، نه شماره‌های قدیمی.\n' +
                '۵. اگر بخشی از فایل که نیاز به تغییر ندارد، نیازی به read_block/write_block هم ندارد - فقط بلوک(های) مرتبط با درخواست کاربر را دست بزن.\n' +
                '۶. اگر "alreadyRead" یک بلوک true است، یعنی محتوای آن را قبلاً در همین درخواست خوانده‌ای (حتی اگر این یک retry باشد) - آن را دوباره با read_block نخوان؛ از محتوایی که قبلاً دیدی استفاده کن. فقط بلوکی را دوباره بخوان که بعد از خواندنش با write_block تغییر کرده باشد (چون شماره‌بندی ممکن است عوض شده باشد).\n';
            log.info('file.blocks.mapped', {
                files: blockMaps.length,
                names: blockMaps.map(x => x.file),
                totalBlocks: blockMaps.map(x => x.totalBlocks)
            });
        } catch (error) {
            log.warn('file.blocks.mapping_failed', {
                message: error?.message || String(error)
            });
            // Do not fail the whole chat because a best-effort block map
            // could not be produced. The model still has the original file.
        }
    }


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
    // FIX (large-file chunk-edit flow, رفع واقعی برای فایل‌های ۵۰۰۰+ خط):
    // منطق قبلی فقط به روندِ "بعد از" یک get_file_chunk/get_archived_file
    // مهلت بیشتر می‌داد - یعنی خودِ روندی که برای اولین بار یک chunk بزرگ
    // را می‌خواند و پردازش می‌کند (یا روند inspect_file روی یک فایل چند
    // هزار خطی) همچنان با مهلت استاندارد ۶۰ ثانیه اجرا می‌شد و دقیقاً
    // همین‌جا (خط ۱۱۰۰ تا ۱۸۹۰ که کاربر تست کرد) timeout می‌خورد. برای
    // فایل‌های بزرگ، تقریباً هر round این جریان به همان اندازه سنگین است -
    // پس به‌جای حدس زدن "کدام round سنگین‌تره"، وقتی fileEditIntent فعال
    // است، همه‌ی round ها مهلت بلند می‌گیرند.
    const roundNeedsMoreTime = (round) =>
        hasVideoAttachment ||
        fileEditIntent ||
        (round > 0 && (lastToolCallWasArchiveRead || lastToolCallWasChunkRead));
    let lastToolCallWasArchiveRead = false;
    let lastToolCallWasChunkRead = false;

    // DIAGNOSTICS (ردِ کامل اجرای عامل): برای هر round، یک رکورد ساختاریافته
    // نگه می‌داریم - نه فقط یک پیام خطای کلی در انتها. این آرایه همیشه (چه
    // در موفقیت چه در خطا) برگردانده می‌شود تا بشود دقیقاً دید هر round
    // چقدر طول کشید، کدام ابزار با چه آرگومانی صدا زده شد، هر ابزار چند بار
    // تکرار شد، چند apply_patch موفق شد، و در نهایت با چه finishReason و
    // چند کاراکتر متن متوقف شد.
    const roundTrace = [];
    const toolCallTally = {}; // name -> شمارنده‌ی کل در این درخواست
    const agentLoopStartedAt = Date.now();

    // NOTE (block-based rewrite): inspectedFilesThisRequest and
    // chunkReadsPerFile (repeat-guards for the old inspect_file/
    // get_file_chunk tools) were removed - those tools no longer exist.
    // Their job (persisting file-editing progress across key/model
    // retries within one HTTP request) is now done by blockStates, read
    // from sharedRequestState at the top of this function.

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const ROUND_TIMEOUT_MS = roundNeedsMoreTime(round) ? 170000 : 60000;
        lastToolCallWasArchiveRead = false; // consumed for this round; re-armed below only if this round's own tool call is an archive read
        lastToolCallWasChunkRead = false; // consumed for this round; re-armed below only if this round's own tool call is a chunk read
        const roundStartedAt = Date.now();
        const roundEntry = {
            round: round + 1,
            toolCalls: [],       // [{ name, argsSummary, resultSummary }]
            finishReason: null,
            textChars: 0,
            durationMs: null,
            timedOut: false
        };
        roundTrace.push(roundEntry);
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
                        ...((disableTools || scopedSearchState.used) ? {} : { tools: fileEditIntent ? GEMINI_TOOLS_NO_SEARCH : GEMINI_TOOLS })
                    }),
                    signal: controller.signal
                }
            );
            await recordGoogleAttempt(currentKey, upstream.status, keyIndex);
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
                    // FIX (root cause of "Function call is missing a
                    // thought_signature"): in the generateContent API,
                    // Gemini can attach `thoughtSignature` metadata to ANY
                    // part - not only functionCall parts, a text part right
                    // before a functionCall can carry it too. This must be
                    // preserved and resent unmodified on every later turn
                    // (stateless multi-turn requirement per Google's docs),
                    // so it is copied through here rather than dropped.
                    const textPart = { text: part.text };
                    if (part.thoughtSignature) textPart.thoughtSignature = part.thoughtSignature;
                    accumulatedParts.push(textPart);
                    // If this event also contains the tool call, its text is
                    // not a valid user-facing preamble. Otherwise use the
                    // selective guard above: normal turns stream immediately,
                    // search-intent turns suppress only obvious preambles.
                    if (!eventHasFunctionCall) {
                        handleStreamText(part.text);
                    }
                } else if (part.functionCall) {
                    // FIX (root cause of "Function call is missing a
                    // thought_signature in functionCall parts"): previously
                    // only `{ functionCall: part.functionCall }` was kept,
                    // silently dropping any `thoughtSignature` Gemini
                    // attached to this same part. That stripped part was
                    // then resent as the model's turn on the NEXT round
                    // (e.g. right after get_archived_file), and Gemini
                    // rejects a functionCall that is missing its required
                    // signature with a 400 INVALID_ARGUMENT. Now the
                    // signature is copied through untouched, exactly as
                    // received, so the resent turn is byte-for-byte valid.
                    const fcPart = { functionCall: part.functionCall };
                    if (part.thoughtSignature) fcPart.thoughtSignature = part.thoughtSignature;
                    accumulatedParts.push(fcPart);
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
            roundEntry.durationMs = Date.now() - roundStartedAt;
            if (streamErr?.name === 'AbortError') {
                roundEntry.timedOut = true;
                roundEntry.finishReason = 'CLIENT_TIMEOUT';
                const err = new Error('agent_stream_read_failed');
                err.body = { message: 'timeout', roundTrace };
                err.roundTrace = roundTrace;
                streamErr.roundTrace = roundTrace;
                throw streamErr;
            }
            roundEntry.finishReason = 'STREAM_READ_ERROR';
            const err = new Error('agent_stream_read_failed');
            err.body = { message: streamErr?.message || String(streamErr), roundTrace };
            err.roundTrace = roundTrace;
            throw err;
        }

        const parts = accumulatedParts;
        const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
        const textParts = parts.filter(p => typeof p.text === 'string').map(p => p.text);

        // DIAGNOSTICS: ثبت وضعیت پایانی این round، صرف‌نظر از این‌که در
        // نهایت پاسخ نهایی باشد یا برود سراغ round بعدی برای اجرای ابزار.
        roundEntry.durationMs = Date.now() - roundStartedAt;
        roundEntry.finishReason = finishReason || 'NONE';
        roundEntry.textChars = textParts.reduce((sum, t) => sum + (t ? t.length : 0), 0);
        roundEntry.functionCallCount = functionCalls.length;
        roundEntry.usage = lastUsage ? {
            promptTokens: lastUsage.promptTokenCount ?? null,
            candidateTokens: lastUsage.candidatesTokenCount ?? null,
            totalTokens: lastUsage.totalTokenCount ?? null
        } : null;

        // ENFORCEMENT (must verify before final answer): if any file has
        // edited blocks but was not (re-)verified since the last
        // write_block (state.verified === false), the model is not
        // allowed to end the turn here even though it returned zero
        // function calls this round. Instead of returning, force one more
        // round by injecting a synthetic functionCall for verify_file - a
        // real tool round, not just a text nudge, so the actual
        // validatePatchedContent check runs and the model gets a real
        // valid/invalid result to react to (it might still be wrong about
        // "I'm done" even if verify_file itself passes, but at minimum the
        // structural check always runs before delivery).
        if (functionCalls.length === 0 && blockStates && blockStates.size > 0) {
            const unverified = [...blockStates.values()].find(s => s.editedBlocks.size > 0 && !s.verified);
            if (unverified) {
                log.info('agent.verify_gate.forced', {
                    file: unverified.name,
                    editedBlockCount: unverified.editedBlocks.size,
                    round
                });
                functionCalls.push({ name: 'verify_file', args: { file: unverified.name } });
                // Keep any text the model produced this round (e.g. "الان
                // فایل رو نهایی می‌کنم") - it will be followed by the
                // verify_file round's own text, both streamed normally.
            }
        }

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
            // BUGFIX (silent empty reply after a tool call, "پاسخی دریافت
            // نشد"): the check below used to require finishReason to be
            // something abnormal (MAX_TOKENS, SAFETY, ...) before treating
            // an empty reply as an error. But Gemini can also finish with a
            // perfectly normal STOP right after a tool call (e.g. right
            // after apply_patch succeeds) while producing zero text - no
            // final answer, no file-edit block, nothing. That used to be
            // returned as a "successful" empty finalText, which the client
            // then shows as a blank bubble and falls back to its own
            // generic "پاسخی دریافت نشد" message with no real error to
            // retry against. Treat ANY empty reply after at least one tool
            // round (round > 0) as the same real, explained error,
            // regardless of finishReason, so the outer key/model retry
            // loop actually kicks in instead of silently succeeding with
            // nothing.
            const normalStop = !finishReason || finishReason === 'STOP';
            if (textParts.length === 0 && round > 0) {
                log.warn('agent.empty_after_tool_call', {
                    finishReason,
                    round,
                    normalStop,
                    toolCallTally,
                    roundTrace
                });
                const err = new Error('agent_empty_after_tool_call');
                err.status = 502;
                // FEATURE (Continue button): if apply_patch already
                // succeeded one or more times before the model went silent,
                // found.content on the matching textFiles entry was mutated
                // in-place to the partially-edited version (see
                // apply_patch's "found.content = ..." above). Surface that
                // partial progress here so the client can offer a "Continue"
                // action that resumes editing from the already-patched
                // content instead of starting the whole edit over from the
                // original file.
                const partialFiles = (Array.isArray(textFiles) ? textFiles : [])
                    .filter(f => f && f._patched)
                    .map(f => ({
                        name: f.name,
                        editedName: f._editedName || f.name,
                        content: f.content || ''
                    }));
                // DIAGNOSTICS: خلاصه‌ی قابل‌فهم برای انسان (فارسی) که مستقیم
                // در "جزئیات بیشتر" کاربر نشان داده می‌شود - نه فقط دیتای خام
                // برای لاگ سرور. summarizeAgentTrace هر دو را می‌سازد.
                const traceSummary = summarizeAgentTrace(roundTrace, toolCallTally, {
                    stoppedReason: 'silent_after_tool',
                    round
                });
                err.body = {
                    message: 'مدل بعد از استفاده از ابزار جواب خالی برگردوند. لطفاً دوباره امتحان کن.',
                    type: 'empty_after_tool_call',
                    finishReason,
                    diagnostics: traceSummary,
                    ...(partialFiles.length ? { partialFiles, canContinue: true } : {})
                };
                throw err;
            }
            // FEATURE (Continue button, MAX_TOKENS case): same idea as the
            // empty_after_tool_call case above, but here the model DID
            // produce text and finished with MAX_TOKENS (cut off by its own
            // output limit) instead of going silent. Any apply_patch calls
            // that already succeeded before the cutoff are still reflected
            // in-place on the matching textFiles entry, so surface them the
            // same way.
            const partialFilesOnCutoff = finishReason === 'MAX_TOKENS'
                ? (Array.isArray(textFiles) ? textFiles : [])
                    .filter(f => f && f._patched)
                    .map(f => ({
                        name: f.name,
                        editedName: f._editedName || f.name,
                        content: f.content || ''
                    }))
                : [];
            // FIX (verified edit never reached the client): write_block
            // mirrors its patched content onto the matching textFiles entry
            // (found.content/_patched/_editedName - see write_block above),
            // and partialFilesOnCutoff already reads exactly that on the
            // MAX_TOKENS path. But on a CLEAN success (normal STOP, the
            // common case after verify_file passes), no equivalent existed -
            // the block-editing system prompt tells the model not to print
            // a file-edit JSON block itself, so there was no other path left
            // for the real patched content to ever reach the client on a
            // normal, fully-verified success. The edit was correct and
            // verified server-side but the user could never see or download
            // it. Send it here under editedFiles whenever any file was
            // patched, regardless of finishReason.
            const editedFiles = (Array.isArray(textFiles) ? textFiles : [])
                .filter(f => f && f._patched)
                .map(f => ({
                    name: f.name,
                    editedName: f._editedName || f.name,
                    content: f.content || ''
                }));

            return {
                finalText: textParts.join(''),
                finishReason: finishReason,
                usage: lastUsage,
                askUser: null,
                ...(partialFilesOnCutoff.length ? { partialFiles: partialFilesOnCutoff } : {}),
                ...(editedFiles.length ? { editedFiles } : {})
            };
        }

        // Search is intentionally handled differently from the other tools.
        // After web_search we disable tools for the rest of this question.
        // Sending Gemini's functionCall + functionResponse pair into a second
        // request with the `tools` field removed can make some Gemini models
        // reject the follow-up as HTTP 400. Instead, convert the successful
        // search result into ordinary user context for round 2. This preserves
        // the one-search rule while keeping get_archived_file/ask_user on the
        // normal function-calling protocol.
        const webSearchCall = functionCalls.find(call => call.name === 'web_search');
        if (webSearchCall) {
            let searchResult = null;
            let earlySearchAskUser = null;

            if (onStep) {
                try { onStep(describeToolCall(webSearchCall.name, webSearchCall.args), webSearchCall.name); } catch (_) {}
            }

            scopedSearchState.used = true;
            const result = await executeToolCall(webSearchCall.name, webSearchCall.args, { tavilyKeys, archivedFiles, textFiles, searchCache, blockStates });
            scopedSearchState.result = result;
            searchResult = result;
            if (result.askUser) earlySearchAskUser = result.askUser;

            if (earlySearchAskUser) {
                return {
                    finalText: earlySearchAskUser,
                    finishReason: 'ASK_USER',
                    usage: lastUsage,
                    askUser: earlySearchAskUser
                };
            }

            const resultText = searchResult?.result || searchResult?.message || 'نتیجه‌ای از جستجو دریافت نشد.';
            workingContents.push({
                role: 'user',
                parts: [{
                    text: `[نتیجه جستجوی وب — جستجو برای این سؤال تمام شده و دیگر هیچ ابزاری استفاده نکن]:\n${resultText}`
                }]
            });

            // If Gemini emitted parallel calls in the same streamed turn, none
            // of the additional calls are executed. One logical search owns
            // the question, and the next round is tools-free.
            continue;
        }

        // For non-search tools keep the native Gemini function-calling
        // protocol intact (this is required by get_archived_file / ask_user).
        workingContents.push({
            role: 'model',
            parts: parts
        });

        const responseParts = [];
        let earlyAskUser = null;

        // FIX (root cause of "بررسی ساختار فایل" چندبار تکرار می‌شود و
        // Rate limit همه‌ی کلیدها را می‌ترکاند): با هر بار inspect_file،
        // computeLogicalChunks کل نقشه‌ی chunk را از صفر و با مرزهای
        // متفاوت می‌سازد (چون هیچ حالتی بین صداها نگه داشته نمی‌شود).
        // هیچ‌جای system prompt هم مدل را از صدا زدن دوباره‌ی inspect_file
        // منع نمی‌کرد، پس وقتی مدل روی یک فایل بزرگ گیج می‌شد، راه‌حلش
        // "از اول نگاه کن" بود - دقیقاً همان رفتار "می‌ره ۲۰۰، بعد ۱۰۰۰،
        // بعد برمی‌گرده ۱۰۰" که باعث شد هر ۱۲ کلید با 429 تمام شوند.
        // این حالت را به‌ازای هر فایل، در طول کل درخواست (نه فقط یک
        // round)، یک‌بار محدود می‌کنیم؛ صداهای بعدی بدون تماس با Gemini
        // رد می‌شوند و مدل به get_file_chunk (که فقط می‌خواند، چیزی را
        // دوباره نمی‌سازد) هدایت می‌شود.
        // (inspectedFilesThisRequest و chunkReadsPerFile بیرون حلقه‌ی round
        // تعریف شده‌اند تا بین round ها پاک نشوند.)

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

            // NOTE (block-based rewrite): the old inspect_file/get_file_chunk
            // repeat-guards (inspectedFilesThisRequest, chunkReadsPerFile,
            // backward-jump detection, MAX_CHUNK_READS_PER_FILE) lived here.
            // They no longer apply - those two tools were removed from
            // GEMINI_TOOLS entirely, replaced by read_block/write_block/
            // verify_file, which use fixed block numbers instead of
            // freeform line ranges. See the executeToolCall handlers for
            // read_block/write_block/verify_file and the block-map
            // injection near the top of runAgentLoop for the new approach.

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

            const toolCallStartedAt = Date.now();
            const result = await executeToolCall(call.name, call.args, { tavilyKeys, archivedFiles, textFiles, searchCache, blockStates });
            const toolCallDurationMs = Date.now() - toolCallStartedAt;

            if (call.name === 'web_search') scopedSearchState.result = result;
            if (call.name === 'get_archived_file') lastToolCallWasArchiveRead = true;

            // DIAGNOSTICS: هر صدا زدن ابزار را با آرگومان‌های کلیدی (نه کل
            // محتوا - فقط اسم فایل/بازه‌ی خط/طول query، برای این‌که ردِ
            // خطا خودش حجیم نشود) و خلاصه‌ای از نتیجه ثبت می‌کنیم. تعداد کل
            // هر ابزار در toolCallTally جمع می‌شود تا تکرار غیرعادی (مثلاً
            // inspect_file چندبار پشت‌سرهم) فوراً قابل مشاهده باشد.
            toolCallTally[call.name] = (toolCallTally[call.name] || 0) + 1;
            roundEntry.toolCalls.push({
                name: call.name,
                file: (call.args && (call.args.file || call.args.name)) || null,
                lineRange: (call.args && call.args.startLine != null)
                    ? `${call.args.startLine}-${call.args.endLine ?? '?'}`
                    : null,
                durationMs: toolCallDurationMs,
                ok: !(result && result.error),
                error: (result && result.error) || null,
                patched: !!(result && result.success && (call.name === 'write_block')),
                callIndexForThisTool: toolCallTally[call.name]
            });

            if (result.askUser) earlyAskUser = result.askUser;

            // FINAL AGENT CONTINUATION GUARD:
// After reading a block, explicitly tell the model that context is
// already loaded. This prevents restarting file inspection from zero.
let responseForModel = result;
if (call.name === 'read_block' && result && !result.error) {
    responseForModel = {
        ...result,
        agentInstruction:
            'Block content loaded successfully. Continue from this context - do not re-read the same block again unless you are about to write_block it.'
    };
}

responseParts.push({
                functionResponse: {
                    name: call.name,
                    response: responseForModel
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
    // DIAGNOSTICS: این یکی از دو حالتی است که قبلاً هیچ اطلاعی از "چرا"
    // به کاربر نمی‌رسید - فقط همین پیام ثابت. حالا diagnostics هم برمی‌گردد
    // تا در "جزئیات بیشتر" معلوم باشد کدام ابزار چندبار تکرار شده بود.
    const loopLimitTrace = summarizeAgentTrace(roundTrace, toolCallTally, {
        stoppedReason: 'round_limit',
        round: MAX_TOOL_ROUNDS
    });
    log.warn('agent.tool_loop_limit_hit', { toolCallTally, roundTrace });
    return {
        finalText: 'متأسفم، در پردازش این درخواست به مشکل خوردم (تعداد مراحل زیاد شد). می‌تونی دوباره یا واضح‌تر بپرسی؟',
        finishReason: 'TOOL_LOOP_LIMIT',
        usage: lastUsage,
        askUser: null,
        diagnostics: loopLimitTrace
    };
}

// DIAGNOSTICS: از یک roundTrace خام یک خلاصه‌ی دوبخشی می‌سازد:
//  - humanSummary: چند خط فارسی ساده، همان چیزی که کاربر توی "جزئیات
//    بیشتر" می‌بیند (بدون اصطلاح فنی زیاد)
//  - raw: خودِ roundTrace + toolCallTally، برای لاگ سرور و دیباگ عمیق‌تر
// این تابع هیچ تصمیمی نمی‌گیرد و چیزی را silent نمی‌کند؛ فقط چیزی که در
// طول اجرا واقعاً اتفاق افتاده را به فارسیِ قابل‌خواندن ترجمه می‌کند.
function summarizeAgentTrace(roundTrace, toolCallTally, meta) {
    const totalRounds = roundTrace.length;
    const totalDurationMs = roundTrace.reduce((sum, r) => sum + (r.durationMs || 0), 0);
    const repeatedTools = Object.entries(toolCallTally || {}).filter(([, count]) => count > 1);
    const patchedFiles = [];
    for (const r of roundTrace) {
        for (const tc of r.toolCalls) {
            if (tc.patched && tc.file && !patchedFiles.includes(tc.file)) patchedFiles.push(tc.file);
        }
    }
    const lastRound = roundTrace[roundTrace.length - 1] || null;

    const lines = [];
    lines.push(`تعداد مراحل طی‌شده: ${totalRounds} از سقف مجاز`);
    lines.push(`زمان کل صرف‌شده: ${(totalDurationMs / 1000).toFixed(1)} ثانیه`);
    if (repeatedTools.length) {
        lines.push('ابزارهایی که بیش از یک‌بار صدا زده شدند: ' +
            repeatedTools.map(([name, count]) => `${name} (${count} بار)`).join('، '));
    }
    if (patchedFiles.length) {
        lines.push(`قبل از توقف، این فایل‌ها با موفقیت پچ خورده بودند: ${patchedFiles.join('، ')}`);
    } else {
        lines.push('قبل از توقف، هیچ بلوکی با موفقیت بازنویسی نشده بود.');
    }
    if (lastRound) {
        lines.push(`آخرین مرحله (round ${lastRound.round}): finishReason=${lastRound.finishReason || 'نامشخص'}, متن تولیدشده=${lastRound.textChars} کاراکتر`);
    }
    if (meta?.stoppedReason === 'round_limit') {
        lines.push('نتیجه: به سقف تعداد مراحل رسید بدون رسیدن به پاسخ نهایی یا اعمال کامل تغییرات.');
    } else if (meta?.stoppedReason === 'silent_after_tool') {
        lines.push('نتیجه: بعد از صدا زدن یک ابزار، مدل هیچ متنی برنگرداند (سکوت).');
    }

    return {
        humanSummary: lines.join('\n'),
        raw: {
            totalRounds,
            totalDurationMs,
            toolCallTally,
            patchedFiles,
            rounds: roundTrace
        }
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

        // FIX (block-editing system silently never activated): fileEditIntent
        // was gated on looksLikeFileEditIntent(text), a fixed Persian/English
        // keyword regex. Any phrasing outside that list (or a message that
        // just references "the file I gave you" without a listed verb) made
        // this silently false even with a real attachment - the whole
        // block-map/read_block/write_block/verify_file system then never
        // activated, the "don't call get_archived_file when a file is
        // attached" instruction never got injected either, and the request
        // fell through to old, unreliable prose/archive behavior with no
        // warning to the user or the model. A file being attached at all is
        // a sufficient and much more robust signal: building the block map
        // costs nothing when the user isn't actually asking for an edit
        // (the model just never calls read_block/write_block), so there's no
        // downside to always doing it whenever textFiles is non-empty.
        const fileEditIntent = textFiles.length > 0;

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

        // FIX (root cause of "Requests ending with a model turn are not
        // supported" / INVALID_ARGUMENT 400): Gemini rejects any request
        // whose `contents` array does not end on a `user` turn. This can
        // happen whenever the client's `history` already ends on a `model`
        // turn - e.g. the current user message failed to get appended to
        // history before being sent, or a duplicate/out-of-order request
        // race left the last turn as the bot's previous reply. Rather than
        // trying to special-case every way the frontend could produce that
        // shape, guarantee it here: if the last turn isn't `user`, use the
        // actual incoming message text (searchQueryBase) as a new trailing
        // user turn. If there's no incoming text either, fall back to
        // dropping trailing model turns until a user turn is exposed.
        if (contents.length > 0 && contents[contents.length - 1].role !== 'user') {
            if (searchQueryBase && searchQueryBase.trim()) {
                contents.push({
                    role: 'user',
                    parts: [{ text: searchQueryBase.trim() }]
                });
            } else {
                while (
                    contents.length > 0 &&
                    contents[contents.length - 1].role !== 'user'
                ) {
                    contents.pop();
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
            }
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

                // FIX (token/quota exhaustion on large file edits): when the
                // user is editing a large file, injecting the FULL content
                // here means it then rides along unchanged in every single
                // tool round (workingContents is cumulative - see
                // runAgentLoop), multiplying token usage by MAX_TOOL_ROUNDS
                // and burning through per-minute quota on every key in a
                // row for what is really just one oversized request. This
                // mirrors the cap that get_archived_file already had.
                // inspect_file/get_file_chunk read directly from
                // ctx.textFiles (untouched, full content) - not from this
                // injected block - so skipping/trimming the injected copy
                // here does not remove the model's ability to read the
                // file; it just stops the redundant full copy from being
                // resent on every round.
                const LARGE_FILE_LINE_THRESHOLD = 400; // same threshold inspect_file already uses to decide "large"

                const fileBlocks =
                    textFiles
                        .map(
                            f => {
                                const content = f.content || '';
                                const lineCount = content.split(/\r?\n/).length;
                                const isLargeEdit = fileEditIntent && lineCount > LARGE_FILE_LINE_THRESHOLD;

                                if (isLargeEdit) {
                                    return `\n\n` +
                                        `[فایل ضمیمه: ${f.name || 'file'} - ${lineCount} خط]\n` +
                                        `این فایل بزرگ است؛ محتوای کامل آن اینجا داده نشده تا حجم درخواست پایین بماند. ` +
                                        `برای دیدن ساختار و بخش‌های آن، ابزار inspect_file را با نام دقیق فایل صدا بزن؛ سپس برای هر بخش هدف، get_file_chunk را صدا بزن.`;
                                }

                                return `\n\n` +
                                    `[محتوای فایل: ${f.name || 'file'}]\n` +
                                    '```\n' +
                                    content +
                                    '\n```\n' +
                                    `[پایان محتوای فایل: ${f.name || 'file'}]`;
                            }
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
مهم: اگر کاربر در همین پیام یک فایل را مستقیماً ضمیمه کرده (چه پیام اول باشد چه Retry)، همیشه از همان نسخه‌ی ضمیمه‌شده (که در بخش فایل‌های فعلی در دسترس توست) استفاده کن، حتی اگر فایلی هم‌نام در آرشیو موجود باشد. get_archived_file را در این حالت صدا نزن؛ این ابزار فقط برای فایل‌هایی است که کاربر به آن‌ها ارجاع می‌دهد بدون این‌که دوباره ضمیمه کرده باشد.
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

حالت ویرایش فایل (بلوک‌محور):

- کاربر ${textFiles.length > 1
                    ? `${textFiles.length} فایل کد/متن (${fileNamesList})`
                    : `یک فایل کد/متن`
                } ضمیمه کرده است.

- محتوای فایل منبع معتبر کد است.
- اگر کاربر تغییر کد خواست، واقعاً تغییر را روی فایل اعمال کن.
- ساختارهای موجود را بررسی کن و چیزهای بی‌دلیل اختراع نکن.
- به جای بازنویسی کل فایل، فقط بلوک(های) لازم را تغییر بده.

نقشه‌ی بلوک‌های فایل از قبل در پیام سیستم (بخش [نقشه‌ی بلوک‌های فایل]) به تو داده شده - هر بلوک یک شماره، محدوده‌ی خط، و پیش‌نمایش دارد.

روند اجباری ویرایش (هر مرحله قبل از بعدی):
۱. از روی نقشه‌ی بلوک‌ها، شماره‌ی بلوک(های) مرتبط با درخواست کاربر را پیدا کن - حدس نزن، از preview هر بلوک در نقشه کمک بگیر.
۲. read_block را با شماره‌ی همان بلوک صدا بزن تا محتوای واقعی و کامل آن را ببینی.
۳. write_block را با شماره‌ی همان بلوک و newContent (محتوای کامل جدید بلوک، شامل خطوطی که تغییر نکرده‌اند اما باید بمانند) صدا بزن.
   - اگر success:true برگشت، تغییر اعمال شد. توجه کن که "newTotalBlocks" ممکن است فرق کند - اگر بلوک دیگری هم باید تغییر کند، از نقشه‌ی به‌روز (در نتیجه‌ی بعدی یا پیام سیستم) استفاده کن، نه شماره‌ی قدیمی.
   - اگر success:false برگشت، بر اساس خطای برگشتی (مثلاً مشکل ساختاری) بلوک را با read_block دوباره ببین و newContent را اصلاح کن.
۴. اگر چند بلوک باید تغییر کنند، آن‌ها را یکی‌یکی (read_block -> write_block برای هرکدام) پردازش کن.
۵. بعد از تمام write_block های لازم، حتماً verify_file را صدا بزن. اگر valid:false برگشت، بلوک(های) مشکل‌دار را اصلاح و دوباره verify_file را صدا بزن - تا valid:true نگیری اجازه‌ی پاسخ نهایی را نداری.
۶. بعد از verify_file موفق (valid:true)، به کاربر بگو چه تغییری دادی؛ نیازی به چاپ کد کامل فایل یا هیچ بلاک JSON خاصی در پاسخ نیست - فایل نهایی از روی بلوک‌های ویرایش‌شده به کاربر تحویل داده می‌شود.

خارج از این روند، کد کامل فایل را دوباره چاپ نکن.
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
            // FIX 3 (block-based rewrite): shared across every key/model
            // retry attempt for THIS one incoming HTTP request, so a
            // mid-loop attempt failure (retryable rate-limit/timeout ->
            // next key/model) does not reset block read/edit/verify
            // progress back to zero. blockStates: fileName -> BlockFileState
            // (see createBlockFileState). See the matching comment inside
            // runAgentLoop for the full explanation.
            const sharedRequestState = {
                blockStates: new Map()
            };
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
                            let seenTail = ''; // small rolling window to detect the ```file-edit fence across chunk boundaries
                            let fileEditStepSent = false;

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

                                // FEATURE (file-edit progress narration): the
                                // model only emits the ```file-edit fence once
                                // it has finished "deciding" the diff and is
                                // about to print the actual old/new JSON -
                                // narrate that moment specifically (not any
                                // ``` fence in general, which was already
                                // tried and reverted above for being
                                // misleading on non-code fences).
                                if (!fileEditStepSent && textFiles.length > 0) {
                                    seenTail = (seenTail + chunk).slice(-32);
                                    if (seenTail.includes('```file-edit')) {
                                        fileEditStepSent = true;
                                        res.write(`data: ${JSON.stringify({ step: 'در حال اعمال تغییرات روی فایل...' })}\n\n`);
                                        if (typeof res.flush === 'function') res.flush();
                                    }
                                }

                                emitText(chunk);
                            };
                        })();

                        const agentResult = await runAgentLoop({
                            currentModel,
                            currentKey,
                            keyIndex: geminiKeys.indexOf(currentKey) + 1,
                            systemText,
                            contents,
                            tavilyKeys,
                            archivedFiles,
                            textFiles,
                            searchCache,
                            searchState,
                            searchIntent: requestSearchIntent,
                            fileEditIntent,
                            sharedRequestState,
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

                        // DIAGNOSTICS: وقتی حلقه به سقف MAX_TOOL_ROUNDS
                        // می‌رسد (finishReason === 'TOOL_LOOP_LIMIT')، این
                        // مسیر throw نمی‌کند - یک finalText عمومی برمی‌گرداند
                        // و به همین شکل به کاربر می‌رسد، بدون توضیح واقعی.
                        // agentResult.diagnostics را همینجا هم به لاگ سرور و
                        // هم (تحت "جزئیات بیشتر" مشابه مسیر خطا) به کلاینت
                        // می‌فرستیم تا این حالت هم دیگر کورکورانه نباشد.
                        if (agentResult.diagnostics) {
                            log.warn('agent.tool_loop_limit_surfaced', {
                                model: currentModel,
                                summary: agentResult.diagnostics.humanSummary
                            });
                        }

                        res.write(
                            `data: ${JSON.stringify({
                                done: true,
                                finishReason: agentResult.finishReason,
                                truncated,
                                askUser: !!agentResult.askUser,
                                ...(agentResult.finishReason === 'TOOL_LOOP_LIMIT' && agentResult.diagnostics
                                    ? { diagnostics: agentResult.diagnostics }
                                    : {}),
                                ...(truncated && agentResult.partialFiles?.length
                                    ? { partialFiles: agentResult.partialFiles, canContinue: true }
                                    : {}),
                                ...(agentResult.editedFiles?.length
                                    ? { editedFiles: agentResult.editedFiles }
                                    : {})
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

                        // Daily/free-tier/project quota exhaustion is a shared
                        // limit. Rotating keys or models cannot fix it, so stop
                        // the retry loop immediately and surface the real reason.
                        if (!classified.retryable) {
                            break outerLoop;
                        }

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

            // At this point every model/key combo has already been tried and
            // failed, so a per-key "try the next key" message would be
            // misleading here - there is no next key left. If the final
            // failure was a per-key quota/rate-limit hit, say plainly that
            // it was ALL keys, not just the last one tried.
            const allKeysExhaustedMessage =
                (classification.category === 'quota_exhausted' || classification.category === 'rate_limit') && classification.keySpecific
                    ? `همهٔ ${geminiKeys.length} کلید تنظیم‌شده در سهمیه/محدودیت نرخ گیر کردند؛ لطفاً کمی بعد دوباره تلاش کن.`
                    : classification.message;

            // DIAGNOSTICS: اگر خطا از نوع "سکوت بعد از ابزار" یا "سقف
            // مراحل" بود، lastError.diagnostics.humanSummary را داریم (چون
            // runAgentLoop آن را در err.body گذاشته و لاین بالا کل err.body
            // را روی lastError پخش می‌کند). آن را به detail اضافه می‌کنیم
            // تا بدون هیچ تغییر فرانت‌اندی، زیر "جزئیات بیشتر" دیده شود.
            const diagnosticsSummary = lastError?.diagnostics?.humanSummary || null;
            const detailText =
                `Gemini${geminiStatusCode ? ' [' + geminiStatusCode + ']' : ''}${classification.providerCode ? ' [' + classification.providerCode + ']' : ''}: ${geminiReasonMessage}` +
                ` (actual attempts: ${attemptsTried})` +
                (diagnosticsSummary ? `\n\n--- ردِ اجرای مدل ---\n${diagnosticsSummary}` : '');

            res.write(
                `data: ${JSON.stringify({
                    error: {
                        message: allKeysExhaustedMessage,
                        type: classification.category,
                        category: classification.category,
                        retryable: classification.retryable,
                        retryAfterSeconds: classification.retryAfterSeconds ?? null,
                        stage: 'stream_generation',
                        detail: detailText,
                        ...(lastError?.diagnostics ? { diagnostics: lastError.diagnostics } : {}),
                        ...(Array.isArray(lastError?.partialFiles) && lastError.partialFiles.length
                            ? { partialFiles: lastError.partialFiles, canContinue: true }
                            : {})
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
        // FIX 3 (block-based rewrite): see the matching comment in the
        // other attempt loop above and inside runAgentLoop — keeps block
        // read/edit/verify progress alive across retryable key/model
        // retries within this one HTTP request.
        const sharedRequestState = {
            blockStates: new Map()
        };
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
                        keyIndex: geminiKeys.indexOf(currentKey) + 1,
                        systemText,
                        contents,
                        tavilyKeys,
                        archivedFiles,
                        searchCache,
                        searchState,
                        fileEditIntent,
                        sharedRequestState,
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
                        usageMetadata: agentResult.usage || undefined,
                        // DIAGNOSTICS: فقط وقتی finishReason غیرعادی است
                        // (سقف مراحل و مشابه آن) پر می‌شود؛ روی پاسخ‌های
                        // معمولی چیزی اضافه نمی‌کند.
                        ...(agentResult.diagnostics ? { diagnostics: agentResult.diagnostics } : {})
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

                    // Same rule as streaming: a shared/daily quota cannot be
                    // repaired by trying another configured API key.
                    if (!classified.retryable) {
                        break outerLoopNonStream;
                    }

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

        // See the streaming path above for why this needs an "all keys"
        // message instead of the raw per-key message once every key/model
        // combo has already been tried and failed.
        const allKeysExhaustedMessageNonStream =
            (classification.category === 'quota_exhausted' || classification.category === 'rate_limit') && classification.keySpecific
                ? `همهٔ ${geminiKeys.length} کلید تنظیم‌شده در سهمیه/محدودیت نرخ گیر کردند؛ لطفاً کمی بعد دوباره تلاش کن.`
                : classification.message;

        // DIAGNOSTICS: همان الگوی مسیر streaming - اگر runAgentLoop یک
        // diagnostics روی err.body گذاشته بود (empty_after_tool_call یا
        // tool_loop_limit)، اینجا هم به detail و هم به فیلد جدا اضافه‌اش کن.
        const diagnosticsSummaryNonStream = lastError?.diagnostics?.humanSummary || null;
        const detailTextNonStream =
            `Gemini${classification.status ? ' [' + classification.status + ']' : ''}${classification.providerCode ? ' [' + classification.providerCode + ']' : ''}: ${classification.rawMessage || 'unknown'}` +
            ` (actual attempts: ${attemptsTried})` +
            (diagnosticsSummaryNonStream ? `\n\n--- ردِ اجرای مدل ---\n${diagnosticsSummaryNonStream}` : '');

        return res.status(classification.category === 'empty_response' ? 502 : (classification.status && classification.status >= 400 && classification.status < 600 ? classification.status : 500)).json({
            error: {
                message: allKeysExhaustedMessageNonStream,
                type: classification.category,
                category: classification.category,
                retryable: classification.retryable,
                retryAfterSeconds: classification.retryAfterSeconds ?? null,
                stage: 'non_stream_generation',
                detail: detailTextNonStream,
                ...(lastError?.diagnostics ? { diagnostics: lastError.diagnostics } : {})
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
