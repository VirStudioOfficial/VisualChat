// pages/api/chat.js

/*
|--------------------------------------------------------------------------
| Think mode levels
|--------------------------------------------------------------------------
| Maps the client's "Ø­Ø§Ù„Øª ØªÙÚ©Ø±" selector (off/low/medium/high) to Gemini's
| thinkingLevel values. 'off' (or anything unrecognized) falls back to the
| existing per-model default in runAgentLoop - Think mode is opt-in.
*/
const THINK_LEVEL_MAP = {
    low: 'low',
    medium: 'medium',
    high: 'high'
};

// Thinking support is model-specific. Flash-Lite must not receive a
// thinkingConfig at all, while 3.7 Flash and 3.1 Pro do not support
// the MINIMAL thinking level.
const THINKING_MODEL_DEFAULTS = {
    'gemini-3.5-flash-lite': null,
    'gemini-3.7-flash': 'low',
    'gemini-3.1-pro-preview': 'low'
};

/*
|--------------------------------------------------------------------------
| Logger - structured, no secrets ever printed
|--------------------------------------------------------------------------
| Every log line is one JSON object so it's easy to grep/parse in Vercel
| logs. Never pass raw API keys, full file base64, or full user history to
| this â€” only short, safe summaries.
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
        const isFirstRound = error?.round === 0;
        return {
            category: error?.likelyChildSafetyBlock ? 'child_safety_block' : 'empty_response',
            // A likely child-safety block is Google's own hard filter -
            // retrying (same key or a different one) reproduces the same
            // block every time, so this is never retryable regardless of
            // round. Otherwise keep the existing round-based logic.
            retryable: error?.likelyChildSafetyBlock ? false : isFirstRound,
            keySpecific: error?.likelyChildSafetyBlock ? false : isFirstRound,
            message: error?.likelyChildSafetyBlock
                ? 'این پیام به‌احتمال زیاد به‌دلیل فیلتر ایمنی مرتبط با محتوای کودکان توسط گوگل مسدود شده است. لطفاً پیام خود را بدون اشاره به سن یا کودکان دوباره ارسال کنید.'
                : 'Ù…Ø¯Ù„ Ø¨Ø¹Ø¯ Ø§Ø² Ø§Ø¬Ø±Ø§ÛŒ Ø§Ø¨Ø²Ø§Ø± Ù¾Ø§Ø³Ø® Ù‚Ø§Ø¨Ù„â€ŒØ§Ø³ØªÙØ§Ø¯Ù‡â€ŒØ§ÛŒ Ø¨Ø±Ù†Ú¯Ø±Ø¯Ø§Ù†Ø¯. Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.',
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
            message: 'Ù¾Ø§Ø³Ø® Ø³Ø±ÙˆÛŒØ³ Ø¨ÛŒØ´ Ø§Ø² Ø²Ù…Ø§Ù† Ù…Ø¬Ø§Ø² Ø·ÙˆÙ„ Ú©Ø´ÛŒØ¯. Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.',
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
                message: 'Ø³Ù‡Ù…ÛŒÙ‡ Free Tier Ø§ÛŒÙ† Ú©Ù„ÛŒØ¯ ØªÙ…Ø§Ù… Ø´Ø¯Ù‡Ø› Ú©Ù„ÛŒØ¯ Ø¨Ø¹Ø¯ÛŒ Ø¨Ø±Ø±Ø³ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯.',
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
            message: 'Ø§ÛŒÙ† Ú©Ù„ÛŒØ¯ Ø¨Ù‡ Ù…Ø­Ø¯ÙˆØ¯ÛŒØª Ø³Ø±Ø¹Øª Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø±Ø³ÛŒØ¯Ù‡ Ø§Ø³ØªØ› Ú©Ù„ÛŒØ¯ Ø¨Ø¹Ø¯ÛŒ Ø¨Ø±Ø±Ø³ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯.',
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
            message: 'Ø§ÛŒÙ† Ú©Ù„ÛŒØ¯ API Ù…Ø¹ØªØ¨Ø± Ù†ÛŒØ³Øª ÛŒØ§ Ø§Ø­Ø±Ø§Ø² Ù‡ÙˆÛŒØª Ø¢Ù† Ø±Ø¯ Ø´Ø¯Ù‡ Ø§Ø³Øª. Ú©Ù„ÛŒØ¯ Ø¨Ø¹Ø¯ÛŒ Ø¨Ø±Ø±Ø³ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯.',
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
            message: 'Ø¯Ø³ØªØ±Ø³ÛŒ Ø§ÛŒÙ† Ú©Ù„ÛŒØ¯ Ø¨Ù‡ Ø³Ø±ÙˆÛŒØ³ ÛŒØ§ Ù…Ø¯Ù„ Ø±Ø¯ Ø´Ø¯Ù‡ Ø§Ø³Øª. Ú©Ù„ÛŒØ¯ Ø¨Ø¹Ø¯ÛŒ Ø¨Ø±Ø±Ø³ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯.',
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
            message: 'Ù…Ø¯Ù„ Ø¯Ø± Ø³Ø±ÙˆÛŒØ³ Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯ ÛŒØ§ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ Ø§ÛŒÙ† Ù…Ø³ÛŒØ± Ù†ÛŒØ³Øª.',
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
            message: 'Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø§Ø±Ø³Ø§Ù„ÛŒ Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ø¨ÙˆØ¯. Ø§Ø­ØªÙ…Ø§Ù„Ø§Ù‹ ÛŒÚ©ÛŒ Ø§Ø² ÙˆØ±ÙˆØ¯ÛŒâ€ŒÙ‡Ø§ ÛŒØ§ ØªÙ†Ø¸ÛŒÙ…Ø§Øª Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø´Ú©Ù„ Ø¯Ø§Ø±Ø¯.',
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
            message: 'Ø­Ø¬Ù… Ø¯Ø±Ø®ÙˆØ§Ø³Øª ÛŒØ§ ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ Ø¨ÛŒØ´ Ø§Ø² Ø­Ø¯ Ù…Ø¬Ø§Ø² Ø§Ø³Øª.',
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
            message: 'Ø³Ø±ÙˆÛŒØ³ Ù‡ÙˆØ´ Ù…ØµÙ†ÙˆØ¹ÛŒ Ù…ÙˆÙ‚ØªØ§Ù‹ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ Ù†ÛŒØ³Øª. Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ….',
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
            message: 'Ø§Ø±ØªØ¨Ø§Ø· Virtual Bot Ø¨Ø§ Ø³Ø±ÙˆÛŒØ³ Ù‡ÙˆØ´ Ù…ØµÙ†ÙˆØ¹ÛŒ Ù‚Ø·Ø¹ Ø´Ø¯. Ø§ØªØµØ§Ù„ Ø±Ø§ Ø¨Ø±Ø±Ø³ÛŒ Ú©Ù† Ùˆ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.',
            status,
            providerCode,
            rawMessage
        };
    }

    return {
        category: 'unknown_error',
        retryable: true,
        keySpecific: false,
        message: 'ÛŒÚ© Ø®Ø·Ø§ÛŒ Ù†Ø§Ø´Ù†Ø§Ø®ØªÙ‡ Ù‡Ù†Ú¯Ø§Ù… Ù¾Ø±Ø¯Ø§Ø²Ø´ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø±Ø® Ø¯Ø§Ø¯.',
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
const MAX_SEARCH_RESULT_CHARS = 12000; // safety cap on a single web_search result injected into context

function summarizeOldTurns(oldTurns) {
    if (!oldTurns.length) return null;
    const topics = oldTurns
        .filter(t => t.role === 'user')
        .map(t => String(t.text || t.content || '').slice(0, 80).trim())
        .filter(Boolean)
        .slice(-8); // last few user topics from the trimmed-off section

    if (!topics.length) return null;

    return (
        `[Ø®Ù„Ø§ØµÙ‡â€ŒÛŒ Ù…Ú©Ø§Ù„Ù…Ù‡â€ŒÛŒ Ù‚Ø¨Ù„ÛŒ - Ø¨Ø±Ø§ÛŒ ØµØ±ÙÙ‡â€ŒØ¬ÙˆÛŒÛŒ Ø¯Ø± Ø­Ø¬Ù…ØŒ Ù¾ÛŒØ§Ù…â€ŒÙ‡Ø§ÛŒ Ù‚Ø¯ÛŒÙ…ÛŒâ€ŒØªØ± Ø®Ù„Ø§ØµÙ‡ Ø´Ø¯Ù†Ø¯]\n` +
        `Ù…ÙˆØ¶ÙˆØ¹Ø§ØªÛŒ Ú©Ù‡ Ù‚Ø¨Ù„Ø§Ù‹ Ù…Ø·Ø±Ø­ Ø´Ø¯Ù‡: ` +
        topics.map(t => `Â«${t}Â»`).join('ØŒ ')
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
                { role: 'model', text: 'Ø¨Ø§Ø´Ù‡ØŒ Ø²Ù…ÛŒÙ†Ù‡â€ŒÛŒ Ù‚Ø¨Ù„ÛŒ Ø±Ùˆ Ø¯Ø± Ù†Ø¸Ø± Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ù….' },
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
// web_search tool â€” including calling it more than once if the first
// result isn't enough. Kept as a no-op stub (unused) instead of deleting
// outright, in case any other code path still references it.
function shouldSearchWeb() {
    return false;
}

// Fast client/request-side hint used only to protect the first streamed
// chunks when the user explicitly asks for live/searchable information.
// This does NOT decide whether Gemini should search; Gemini still makes that
// decision with the real web_search tool. It only prevents a friendly
// preamble such as "Ø³Ù„Ø§Ù… ..." from leaking before that tool call.
function looksLikeWebSearchIntent(text) {
    const s = String(text || '').toLowerCase();
    if (!s.trim()) return false;
    return /(?:Ø³Ø±Ú†|Ø¬Ø³ØªØ¬Ùˆ|Ú¯ÙˆÚ¯Ù„|ÙˆØ¨|Ø§ÛŒÙ†ØªØ±Ù†Øª|Ù‚ÛŒÙ…Øª(?:\s|â€Œ)*(?:Ø§Ù„Ø§Ù†|Ø§Ù…Ø±ÙˆØ²|ÙØ¹Ù„ÛŒ|Ø¬Ø¯ÛŒØ¯|Ù„Ø­Ø¸Ù‡)|Ø§Ù„Ø§Ù† Ú†Ù†Ø¯Ù‡|Ú†Ù†Ø¯Ù‡|Ú†Ù‚Ø¯Ø±(?:Ù‡|Ù‡ØŸ)|Ú†Ù‚Ø¯Ø±Ù‡|Ù‚ÛŒÙ…ØªØ´|Ù‚ÛŒÙ…ØªØ´ Ú†Ù†Ø¯Ù‡|Ù‡Ø²ÛŒÙ†Ù‡|Ù‡Ø²ÛŒÙ†Ø´|Ø¢Ø®Ø±ÛŒÙ†|Ø§Ù…Ø±ÙˆØ²|Ø§Ù…Ø´Ø¨|Ø§Ø®Ø¨Ø§Ø±|Ø®Ø¨Ø±Ù‡Ø§ÛŒ|Ø¢Ø¨[\u200c ]?ÙˆÙ‡ÙˆØ§|Ù‡ÙˆØ§(?:ÛŒ|\s)|Ù†Ø±Ø®|Ø§Ø±Ø²|Ø¯Ù„Ø§Ø±|ÛŒÙˆØ±Ùˆ|Ø·Ù„Ø§|Ø³Ù‡Ø§Ù…|Ù…ÙˆØ¬ÙˆØ¯ÛŒ|Ù‚ÛŒÙ…Øª ÙØ¹Ù„ÛŒ|current|latest|today|right now|now|search|google|look up|news|weather|price|stock|exchange rate|availability)/i.test(s);
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
ÛŒÚ© Ø¹Ù†ÙˆØ§Ù† Ø¨Ø³ÛŒØ§Ø± Ú©ÙˆØªØ§Ù‡ (Ø­Ø¯Ø§Ú©Ø«Ø± Û´ ØªØ§ Û¶ Ú©Ù„Ù…Ù‡ØŒ Ø¨Ù‡ ÙØ§Ø±Ø³ÛŒ) Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ø¨Ø³Ø§Ø² Ú©Ù‡
Ù…ÙˆØ¶ÙˆØ¹ Ø§ØµÙ„ÛŒ Ø±Ø§ Ù†Ø´Ø§Ù† Ø¨Ø¯Ù‡Ø¯ â€” Ù†Ù‡ ÛŒÚ© Ø¬Ù…Ù„Ù‡ Ú©Ø§Ù…Ù„ØŒ ÙÙ‚Ø· ÛŒÚ© Ø¹Ù†ÙˆØ§Ù† Ù…Ø«Ù„ ØªÛŒØªØ±.

Ù‚ÙˆØ§Ù†ÛŒÙ†:
- ÙÙ‚Ø· Ø®ÙˆØ¯Ù Ø¹Ù†ÙˆØ§Ù† Ø±Ø§ Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†ØŒ Ø¨Ø¯ÙˆÙ† Ú¯ÛŒÙˆÙ…Ù‡ØŒ Ø¨Ø¯ÙˆÙ† ØªÙˆØ¶ÛŒØ­ØŒ Ø¨Ø¯ÙˆÙ† Ù†Ù‚Ø·Ù‡ Ø¯Ø± Ø§Ù†ØªÙ‡Ø§.
- Ø§Ø² Ú©Ù„Ù…Ø§Øª Ø¹Ù…ÙˆÙ…ÛŒ Ù…Ø«Ù„ Â«Ø³Ù„Ø§Ù…Â» ÛŒØ§ Â«Ú¯ÙØªÚ¯ÙˆÂ» Ø¨Ù‡â€ŒØªÙ†Ù‡Ø§ÛŒÛŒ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù†Ú©Ù†Ø› Ù…ÙˆØ¶ÙˆØ¹ ÙˆØ§Ù‚Ø¹ÛŒ Ø±Ø§ Ø¨Ú¯ÛŒØ±.
- Ø§Ú¯Ø± Ù¾ÛŒØ§Ù… Ú©Ø§Ø±Ø¨Ø± ÙÙ‚Ø· Ø³Ù„Ø§Ù… Ùˆ Ø§Ø­ÙˆØ§Ù„â€ŒÙ¾Ø±Ø³ÛŒ Ø§Ø³Øª Ùˆ Ù…ÙˆØ¶ÙˆØ¹ Ù…Ø´Ø®ØµÛŒ Ù†Ø¯Ø§Ø±Ø¯ØŒ Ø¹Ù†ÙˆØ§Ù†ÛŒ Ù…Ø«Ù„
  Â«Ú¯ÙØªÚ¯ÙˆÛŒ Ø¹Ù…ÙˆÙ…ÛŒÂ» Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†.

Ù¾ÛŒØ§Ù… Ú©Ø§Ø±Ø¨Ø±:
${String(userText).slice(0, 500)}

Ù¾Ø§Ø³Ø® Ø±Ø¨Ø§Øª (Ø§Ú¯Ø± Ù…ÙˆØ¬ÙˆØ¯ Ø¨ÙˆØ¯):
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
                title = title.replace(/^["'Â«Â»]+|["'Â«Â»]+$/g, '').replace(/\.$/, '').trim();
                if (title.length > 40) title = title.slice(0, 40).trim() + 'â€¦';
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
            message: 'Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬Ùˆ Ù¾ÛŒÚ©Ø±Ø¨Ù†Ø¯ÛŒ Ù†Ø´Ø¯Ù‡ Ø§Ø³Øª.'
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
                    'Ú©Ù„ÛŒØ¯ Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬Ùˆ Ù…Ø¹ØªØ¨Ø± Ù†ÛŒØ³Øª ÛŒØ§ Ø¯Ø³ØªØ±Ø³ÛŒ Ø¢Ù† Ø±Ø¯ Ø´Ø¯Ù‡ Ø§Ø³Øª.',
                    status,
                    false
                );
            }

            if (status === 429) {
                return fail(
                    'search_rate_limit',
                    'Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬Ùˆ Ø¨Ù‡ Ù…Ø­Ø¯ÙˆØ¯ÛŒØª Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø±Ø³ÛŒØ¯Ù‡ Ø§Ø³Øª. Ø§ÛŒÙ† Ø¬Ø³ØªØ¬Ùˆ ÙÙ‚Ø· ÛŒÚ©â€ŒØ¨Ø§Ø± ØªÙ„Ø§Ø´ Ø´Ø¯ ØªØ§ Ø¯Ø±Ø®ÙˆØ§Ø³Øªâ€ŒÙ‡Ø§ÛŒ Ø§Ø¶Ø§ÙÛŒ Ø§ÛŒØ¬Ø§Ø¯ Ù†Ø´ÙˆØ¯.',
                    status,
                    true
                );
            }

            if (status >= 500) {
                return fail(
                    'search_provider_error',
                    'Ø®ÙˆØ¯ Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬Ùˆ Ù…ÙˆÙ‚ØªØ§Ù‹ Ø¨Ø§ Ø®Ø·Ø§ÛŒ Ø³Ø±ÙˆØ± Ù…ÙˆØ§Ø¬Ù‡ Ø´Ø¯.',
                    status,
                    true
                );
            }

            return fail(
                'search_http_error',
                `Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬Ùˆ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø±Ø§ Ø±Ø¯ Ú©Ø±Ø¯ (${status}).`,
                status,
                false
            );
        }

        const data = await response.json();

        if (!data.results || !Array.isArray(data.results) || data.results.length === 0) {
            markKeyResult(currentKey, true);
            return fail(
                'search_no_results',
                'Ø¬Ø³ØªØ¬Ùˆ Ø§Ù†Ø¬Ø§Ù… Ø´Ø¯ Ø§Ù…Ø§ Ù†ØªÛŒØ¬Ù‡â€ŒØ§ÛŒ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ø¹Ø¨Ø§Ø±Øª Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.',
                200,
                false
            );
        }

        markKeyResult(currentKey, true);

        const formatted = data.results
            .map(
                r =>
                    `Ø¹Ù†ÙˆØ§Ù†: ${r.title || 'Ø¨Ø¯ÙˆÙ† Ø¹Ù†ÙˆØ§Ù†'}\n` +
                    `Ù…Ù†Ø¨Ø¹: ${r.url || 'Ù†Ø§Ù…Ø´Ø®Øµ'}\n` +
                    `Ù…Ø­ØªÙˆØ§: ${String(r.content || '').slice(0, 1800)}`
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
                'Ø¬Ø³ØªØ¬ÙˆÛŒ ÙˆØ¨ Ø¯Ø± Ø²Ù…Ø§Ù† ØªØ¹ÛŒÛŒÙ†â€ŒØ´Ø¯Ù‡ Ù¾Ø§Ø³Ø® Ù†Ø¯Ø§Ø¯.',
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
            'Ø§Ø±ØªØ¨Ø§Ø· Ø¨Ø§ Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬ÙˆÛŒ ÙˆØ¨ Ø¨Ø±Ù‚Ø±Ø§Ø± Ù†Ø´Ø¯.',
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
| doesn't look like a silent hang - the user sees "Ø¯Ø§Ø±Ù… ØªÙˆÛŒ ÙˆØ¨ Ø³Ø±Ú† Ù…ÛŒâ€ŒÚ©Ù†Ù…â€¦"
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
    return /(?:ÙˆÛŒØ±Ø§ÛŒØ´|Ø§Ø¯ÛŒØª|ØªØºÛŒÛŒØ± Ø¨Ø¯Ù‡|ØªØºÛŒÛŒØ±Ø´ Ø¨Ø¯Ù‡|Ø§Ø¶Ø§ÙÙ‡ Ú©Ù†|Ø§Ø¶Ø§ÙÙ‡â€Œ|Ø­Ø°Ù Ú©Ù†|Ù¾Ø§Ú© Ú©Ù†|Ø§ØµÙ„Ø§Ø­ Ú©Ù†|Ø¯Ø±Ø³Øª Ú©Ù†|Ù¾ÛŒØ§Ø¯Ù‡ Ú©Ù†|Ù¾ÛŒØ§Ø¯Ù‡â€Œ|Ø¨Ø±ÙˆØ²Ø±Ø³Ø§Ù†ÛŒ Ú©Ù†|Ø¢Ù¾Ø¯ÛŒØª Ú©Ù†|Ø¨Ù‡â€ŒØ±ÙˆØ² Ú©Ù†|Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ú©Ù†|Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ú©Ù†|Ø§Ø¶Ø§ÙÙ‡ Ú©Ø±Ø¯Ù†|Ø­Ø°Ù Ú©Ø±Ø¯Ù†|ØªØºÛŒÛŒØ± Ø¯Ø§Ø¯Ù†|Ø§ØµÙ„Ø§Ø­ Ú©Ø±Ø¯Ù†|modify|edit|update|delete|remove|add|insert|replace|rewrite|refactor)/i.test(t);
}

/*
|--------------------------------------------------------------------------
| Versioned output filename
|--------------------------------------------------------------------------
| Ø§Ú¯Ù‡ Ø§Ø³Ù… ÙØ§ÛŒÙ„ Ø¨Ù‡ Ø¹Ø¯Ø¯ Ø®ØªÙ… Ø¨Ø´Ù‡ (index58 -> index59) Ø¹Ø¯Ø¯ ÛŒÚ©ÛŒ Ø²ÛŒØ§Ø¯ Ù…ÛŒâ€ŒØ´Ù‡.
| Ø§Ú¯Ù‡ Ù†Ù‡ØŒ Ø¨Ø±Ú†Ø³Ø¨ _edited Ø§Ø¶Ø§ÙÙ‡ Ù…ÛŒâ€ŒØ´Ù‡ (chat.js -> chat_edited.js)ØŒ Ùˆ Ø§Ú¯Ù‡ Ø§Ø²
| Ù‚Ø¨Ù„ _edited Ø¯Ø§Ø´Øª Ø´Ù…Ø§Ø±Ù‡â€ŒØ¯Ø§Ø± Ù…ÛŒâ€ŒØ´Ù‡ (_edited -> _edited2 -> _edited3 ...).
| Ø§ÛŒÙ† Ø¬Ù„ÙˆÛŒ Ø§ÙˆÙ† Ù…Ø´Ú©Ù„ "Ø§Ø³Ù… Ø®Ø±ÙˆØ¬ÛŒ Ø¨Ø§ Ø§Ø³Ù… ÙˆØ±ÙˆØ¯ÛŒ ÛŒÚ©ÛŒÙ‡ Ùˆ Ù…Ø¹Ù„ÙˆÙ… Ù†ÛŒØ³Øª Ú©Ø¯ÙˆÙ… ÙˆÛŒØ±Ø§ÛŒØ´â€ŒØ´Ø¯Ù‡"
| Ø±Ùˆ Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ù‡.
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
| apply_patch tool Ø§ÛŒÙ†Ùˆ ØµØ¯Ø§ Ù…ÛŒâ€ŒØ²Ù†Ù‡. Ù‡Ø± patch Ø¨Ø§ÛŒØ¯ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ ÛŒÚ©â€ŒØ¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„
| Ù¾ÛŒØ¯Ø§ Ø¨Ø´Ù‡Ø› Ø§Ú¯Ù‡ Ù†Ø´Ø¯ ÛŒØ§ Ù…Ø¨Ù‡Ù… Ø¨ÙˆØ¯ØŒ ÛŒÙ‡ Ú¯Ø²Ø§Ø±Ø´ Ø¯Ù‚ÛŒÙ‚ (Ù†Ø²Ø¯ÛŒÚ©â€ŒØªØ±ÛŒÙ† context) Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ù‡
| Ú©Ù‡ Ù…Ø¯Ù„ Ø¨Ø§ Ø§ÙˆÙ† old Ø±Ùˆ Ø§ØµÙ„Ø§Ø­ Ú©Ù†Ù‡ Ùˆ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØµØ¯Ø§ Ø¨Ø²Ù†Ù‡ - Ù‡ÛŒÚ† Ø­Ø¯Ø³/fuzzy-match ÛŒ
| Ø¯Ø± Ú©Ø§Ø± Ù†ÛŒØ³Øª.
*/
/*
|==========================================================================
| BLOCK-BASED FILE EDITING (rewrite - replaces inspect_file/get_file_chunk/
| apply_patch entirely for text files)
|==========================================================================
|
| Ú†Ø±Ø§ Ø§ÛŒÙ† Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ù„Ø§Ø²Ù… Ø¨ÙˆØ¯:
| Ù…Ø¹Ù…Ø§Ø±ÛŒ Ù‚Ø¨Ù„ÛŒ (inspect_file + get_file_chunk Ø¨Ø§ startLine/endLine Ø¯Ù„Ø®ÙˆØ§Ù‡ +
| apply_patch Ø¨Ø§ old/new Ù…ØªÙ†ÛŒ ÛŒØ§ Ø®Ø·â€ŒÙ…Ø­ÙˆØ±) Ø³Ù‡ Ø¯Ø³ØªÙ‡ Ø¨Ø§Ú¯ Ø¬Ø¯Ø§ ØªÙˆÙ„ÛŒØ¯ Ù…ÛŒâ€ŒÚ©Ø±Ø¯ Ú©Ù‡ Ù‡Ø±
| Ø¨Ø§Ø± ÛŒÚ©ÛŒ Ø±ÙØ¹ Ù…ÛŒâ€ŒØ´Ø¯ Ùˆ Ø¨Ø¹Ø¯ÛŒ Ø³Ø± Ø¨Ø± Ù…ÛŒâ€ŒØ¢ÙˆØ±Ø¯:
|   Û±) overlap Ø¬Ø²Ø¦ÛŒ Ø¨ÛŒÙ† Ø¯Ùˆ Ø®ÙˆØ§Ù†Ø¯Ù† (Ù†Ù‡ subset Ø¯Ù‚ÛŒÙ‚ØŒ Ù†Ù‡ Ú©Ø§Ù…Ù„Ø§Ù‹ Ù‚Ø¨Ù„ Ø§Ø² Ù‚Ø¨Ù„ÛŒ)
|      Ù‡ÛŒÚ†â€ŒØ¬Ø§ ØªØ´Ø®ÛŒØµ Ø¯Ø§Ø¯Ù‡ Ù†Ù…ÛŒâ€ŒØ´Ø¯ -> Ù…Ø¯Ù„ Ø¨Ø®Ø´ÛŒ Ø±Ø§ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ù…ÛŒâ€ŒØ®ÙˆØ§Ù†Ø¯.
|   Û²) state Ù¾ÛŒØ´Ø±ÙØª (Ú©Ø¯Ø§Ù… Ø®Ø·â€ŒÙ‡Ø§ Ø®ÙˆØ§Ù†Ø¯Ù‡/ÙˆÛŒØ±Ø§ÛŒØ´ Ø´Ø¯Ù‡) Ø¯Ø§Ø®Ù„ runAgentLoop ØªØ¹Ø±ÛŒÙ
|      Ù…ÛŒâ€ŒØ´Ø¯ -> Ø¨Ø§ Ù‡Ø± retry (Ú©Ù„ÛŒØ¯/Ù…Ø¯Ù„ Ø¨Ø¹Ø¯ÛŒ Ø±ÙˆÛŒ Ù‡Ù…Ø§Ù† Ø¯Ø±Ø®ÙˆØ§Ø³Øª HTTP) Ø§Ø² ØµÙØ±
|      Ø³Ø§Ø®ØªÙ‡ Ù…ÛŒâ€ŒØ´Ø¯ Ùˆ Ù…Ø¯Ù„ Ú©Ø§Ù…Ù„Ø§Ù‹ ÙØ±Ø§Ù…ÙˆØ´ Ù…ÛŒâ€ŒÚ©Ø±Ø¯ Ú©Ø¬Ø§ Ø¨ÙˆØ¯Ù‡.
|   Û³) apply_patch Ø¨Ø§ ØªØ·Ø¨ÛŒÙ‚ Ù…ØªÙ†ÛŒ (old/new) Ø¯Ø± ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ø¨Ø²Ø±Ú¯ Ø´Ú©Ù†Ù†Ø¯Ù‡ Ø¨ÙˆØ¯: Ø§Ú¯Ø±
|      Ù…Ø¯Ù„ Ø­ØªÛŒ ÛŒÚ© Ú©Ø§Ø±Ø§Ú©ØªØ± (ÙØ§ØµÙ„Ù‡/Ú©ÙˆØªÛŒØ´Ù†) Ø±Ø§ Ø§Ø² Ø­Ø§ÙØ¸Ù‡ Ø¨Ø§Ø²Ø³Ø§Ø²ÛŒ Ù…ÛŒâ€ŒÚ©Ø±Ø¯ØŒ Ú©Ù„
|      patch Ø±Ø¯ Ù…ÛŒâ€ŒØ´Ø¯.
|
| Ø±Ø§Ù‡â€ŒØ­Ù„: Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Ù…Ø­Ø¯ÙˆØ¯Ù‡â€ŒÛŒ Ø®Ø· Ø¯Ù„Ø®ÙˆØ§Ù‡ØŒ ÙØ§ÛŒÙ„ Ø¨Ù‡ Ø¨Ù„ÙˆÚ©â€ŒÙ‡Ø§ÛŒ Ø´Ù…Ø§Ø±Ù‡â€ŒØ¯Ø§Ø± Ùˆ
| Ø«Ø§Ø¨Øª (ØªÙˆØ³Ø· Ú©Ø¯ØŒ Ù†Ù‡ Ù…Ø¯Ù„) ØªÙ‚Ø³ÛŒÙ… Ù…ÛŒâ€ŒØ´ÙˆØ¯. Ù…Ø¯Ù„ ÙÙ‚Ø· Ø¨Ø§ Ø´Ù…Ø§Ø±Ù‡â€ŒÛŒ Ø¨Ù„ÙˆÚ© Ú©Ø§Ø± Ù…ÛŒâ€ŒÚ©Ù†Ø¯ -
| Ù†Ù‡ Ù…Ø­Ø§Ø³Ø¨Ù‡â€ŒÛŒ Ø®Ø·ØŒ Ù†Ù‡ ØªØ·Ø¨ÛŒÙ‚ Ù…ØªÙ†ÛŒ. state Ù¾ÛŒØ´Ø±ÙØª (Ú©Ø¯Ø§Ù… Ø¨Ù„ÙˆÚ© Ø®ÙˆØ§Ù†Ø¯Ù‡/ÙˆÛŒØ±Ø§ÛŒØ´ Ø´Ø¯Ù‡ØŒ
| Ø¢ÛŒØ§ verify Ù†Ù‡Ø§ÛŒÛŒ Ø¨Ø¹Ø¯ Ø§Ø² Ø¢Ø®Ø±ÛŒÙ† ÙˆÛŒØ±Ø§ÛŒØ´ Ø§Ù†Ø¬Ø§Ù… Ùˆ Ù¾Ø§Ø³ Ø´Ø¯Ù‡) Ø¯Ø± ÛŒÚ© Ø¢Ø¨Ø¬Ú©Øª ÙˆØ§Ø­Ø¯
| (BlockFileState) Ù†Ú¯Ù‡ Ø¯Ø§Ø´ØªÙ‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ú©Ù‡ Ø®ÙˆØ¯Ù caller (Ø³Ø·Ø­ HTTP requestØŒ Ù†Ù‡
| runAgentLoop) Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯ Ùˆ Ø¨ÛŒÙ† Ù‡Ù…Ù‡â€ŒÛŒ retryÙ‡Ø§ÛŒ Ù‡Ù…Ø§Ù† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø´ØªØ±Ú© Ø§Ø³Øª - Ø¯Ù‚ÛŒÙ‚Ø§Ù‹
| Ù…Ø«Ù„ sharedRequestState Ø¨Ø±Ø§ÛŒ inspect/chunk Ù‚Ø¨Ù„ÛŒØŒ Ø§Ù…Ø§ Ø§ÛŒÙ† Ø¨Ø§Ø± state ÙˆØ§Ø­Ø¯ Ùˆ
| Ú©Ø§Ù…Ù„ Ø´Ø§Ù…Ù„ Ø®ÙˆØ¯Ù Ù…Ø­ØªÙˆØ§ÛŒ ÙØ§ÛŒÙ„ Ù‡Ù… Ù‡Ø³ØªØŒ Ù†Ù‡ Ù¾Ø®Ø´ Ø¯Ø± Ú†Ù†Ø¯ Set/Map Ø¬Ø¯Ø§.
|
| Ù‚ÙˆØ§Ù†ÛŒÙ† Ú©Ù„ÛŒØ¯ÛŒ:
|   - Ø¨Ù„ÙˆÚ©â€ŒØ¨Ù†Ø¯ÛŒ Ù‚Ø·Ø¹ÛŒ Ùˆ ØªÚ©Ø±Ø§Ø±Ù¾Ø°ÛŒØ± Ø§Ø³Øª: Ù‡Ù…Ø§Ù† ÙØ§ÛŒÙ„ Ù‡Ù…ÛŒØ´Ù‡ Ù‡Ù…Ø§Ù† Ø¨Ù„ÙˆÚ©â€ŒÙ‡Ø§ Ø±Ø§ Ù…ÛŒâ€ŒØ¯Ù‡Ø¯.
|   - write_block Ú©Ù„ ÛŒÚ© Ø¨Ù„ÙˆÚ© Ø±Ø§ Ø¨Ø§ Ù…Ø­ØªÙˆØ§ÛŒ Ø¬Ø¯ÛŒØ¯ Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ù…ÛŒâ€ŒÚ©Ù†Ø¯ (Ù†Ù‡ diff) -
|     Ù…Ù‚Ø§ÙˆÙ… Ø¯Ø± Ø¨Ø±Ø§Ø¨Ø± Ø®Ø·Ø§ÛŒ Ú©ÙˆÚ†Ú© Ù…ØªÙ†ÛŒØŒ Ú†ÙˆÙ† Ú©Ù„ Ø¨Ù„ÙˆÚ© Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ù†Ù‡ Ø¨Ø®Ø´ÛŒ Ø§Ø² Ø¢Ù†.
|   - Ø¨Ø¹Ø¯ Ø§Ø² Ù‡Ø± write_blockØŒ Ù¾Ø±Ú†Ù… "verified" Ø±ÛŒØ³Øª Ù…ÛŒâ€ŒØ´ÙˆØ¯Ø› Ù…Ø¯Ù„ ØªØ§ verify_file
|     Ø±Ø§ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØµØ¯Ø§ Ù†Ø²Ù†Ø¯ Ùˆ Ù¾Ø§Ø³ Ù†Ø´ÙˆØ¯ØŒ Ø§Ø¬Ø§Ø²Ù‡â€ŒÛŒ Ø¬ÙˆØ§Ø¨ Ù†Ù‡Ø§ÛŒÛŒ (Ø¨Ø¯ÙˆÙ† Ø§Ø¨Ø²Ø§Ø±) Ø±Ø§
|     Ù†Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ø¯ - Ø§ÛŒÙ† Ø±Ø§ runAgentLoop Ø¯Ø± Ù¾Ø§ÛŒØ§Ù† Ù‡Ø± round Ø§Ø¬Ø±Ø§ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ØŒ Ù†Ù‡ ÛŒÚ©
|     Ù‚Ø§Ù†ÙˆÙ† ØµØ±ÙØ§Ù‹ Ø¯Ø± system prompt Ú©Ù‡ Ù‚Ø§Ø¨Ù„ Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ† Ø¨Ø§Ø´Ø¯.
|
|==========================================================================
*/

// PERF (Vercel Hobby 60s function timeout on heavy files): each round in
// runAgentLoop is a fully sequential, blocking network round-trip to
// Gemini - there is no parallelism between read_block/write_block/
// verify_file calls. A targeted edit on a heavy file (e.g. a single CSS
// rule change on a 5000+ line index.html) still costs one round per
// block it touches, so the fewer/larger the blocks, the fewer
// round-trips a normal edit needs, and the less real wall-clock time the
// whole request burns before Vercel's hard timeout kills the connection
// with no response at all (see the "Ù¾Ø§Ø³Ø®ÛŒ Ø¯Ø±ÛŒØ§ÙØª Ù†Ø´Ø¯" case). Doubled
// from 250 -> 500: a typical single-section edit still fits inside one
// or two blocks (unchanged behavior), but a 5000-line file now maps to
// roughly half as many total blocks, which also roughly halves the
// MAX_TOOL_ROUNDS ceiling computed from block count below. This does not
// change the read_block/write_block/verify_file contract or validation
// logic - only how finely the same file is sliced.
// ==========================================================================
// REWRITE (block architecture -> SEARCH/REPLACE with fallback, Aider-style)
// ==========================================================================
// Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ú©Ø§Ù…Ù„ Ø¨Ù„ÙˆÚ©â€ŒØ¨Ù†Ø¯ÛŒ: Ù…Ø¯Ù„ Ù…Ø³ØªÙ‚ÛŒÙ…Ø§Ù‹ ÛŒÚ© Ù‚Ø·Ø¹Ù‡â€ŒÛŒ Ù…ØªÙ† Ø¯Ù‚ÛŒÙ‚ Ù…ÙˆØ¬ÙˆØ¯ (search) Ùˆ
// Ù…ØªÙ† Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† (replace) Ù…ÛŒâ€ŒØ¯Ù‡Ø¯. Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Ø´Ù…Ø§Ø±Ù‡â€ŒÛŒ Ø¨Ù„ÙˆÚ© Ø«Ø§Ø¨Øª (Ú©Ù‡ Ø¨Ø§ Ù‡Ø± ÙˆÛŒØ±Ø§ÛŒØ´
// Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ù…Ø­Ø§Ø³Ø¨Ù‡ Ù…ÛŒâ€ŒØ´Ø¯ Ùˆ Ù…Ø¯Ù„ Ø¨Ø§ÛŒØ¯ Ø¯Ø§Ø¦Ù… Ù†Ù‚Ø´Ù‡â€ŒÛŒ Ø¬Ø¯ÛŒØ¯ Ø±Ø§ Ø¯Ù†Ø¨Ø§Ù„ Ù…ÛŒâ€ŒÚ©Ø±Ø¯)ØŒ Ø®ÙˆØ¯Ù
// Ù…Ø­ØªÙˆØ§ Ù…Ø¹ÛŒØ§Ø± Ø§Ø³Øª. Û´ Ù„Ø§ÛŒÙ‡â€ŒÛŒ fallback Ø¨Ù‡ ØªØ±ØªÛŒØ¨ Ø§Ù…ØªØ­Ø§Ù† Ù…ÛŒâ€ŒØ´ÙˆØ¯:
//   Û±) ØªØ·Ø¨ÛŒÙ‚ Ø¯Ù‚ÛŒÙ‚ (exact substring)
//   Û²) ØªØ·Ø¨ÛŒÙ‚ Ø¨Ø§ Ø§Ù†Ø¹Ø·Ø§Ù ÙØ§ØµÙ„Ù‡/ØªØ¨/whitespace (Ø®Ø·ÙˆØ· normalize Ø´Ø¯Ù‡ Ù…Ù‚Ø§ÛŒØ³Ù‡ Ù…ÛŒâ€ŒØ´ÙˆÙ†Ø¯)
//   Û³) ØªØ·Ø¨ÛŒÙ‚ fuzzy Ø®Ø·â€ŒØ¨Ù‡â€ŒØ®Ø· (Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ† ÙØ§ØµÙ„Ù‡â€ŒÛŒ Ø§Ø¨ØªØ¯Ø§/Ø§Ù†ØªÙ‡Ø§ÛŒ Ø®Ø·)
//   Û´) Ø´Ú©Ø³Øª: Ú¯Ø²Ø§Ø±Ø´ Ø¯Ù‚ÛŒÙ‚ Ø¨Ø§ Ù†Ø²Ø¯ÛŒÚ©â€ŒØªØ±ÛŒÙ† context Ù‡Ø§ Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ ØªØ§ Ù…Ø¯Ù„
//      search Ø±Ø§ Ø§ØµÙ„Ø§Ø­ Ú©Ù†Ø¯ Ùˆ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØµØ¯Ø§ Ø¨Ø²Ù†Ø¯ - Ù‡ÛŒÚ† Ø­Ø¯Ø³ÛŒ Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Ù…Ø¯Ù„ Ø²Ø¯Ù‡ Ù†Ù…ÛŒâ€ŒØ´ÙˆØ¯.
// Ø§Ú¯Ø± search Ø¨ÛŒØ´ Ø§Ø² ÛŒÚ©â€ŒØ¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„ Ù¾ÛŒØ¯Ø§ Ø´ÙˆØ¯ (Ø§Ø¨Ù‡Ø§Ù…)ØŒ Ø±Ø¯ Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ù…Ú¯Ø±
// occurrence Ù…Ø´Ø®Øµ Ø´Ø¯Ù‡ Ø¨Ø§Ø´Ø¯.

// \r ØªÙ†Ù‡Ø§ (Ø¨Ø¯ÙˆÙ† \n Ø¨Ø¹Ø¯Ø´) Ù…ÛŒâ€ŒØªÙˆØ§Ù†Ø¯ Ø§Ø² Ø¨Ø±Ø´ Ù†Ø§Ø¯Ø±Ø³Øª Ù…ØªÙ† ØªÙˆØ³Ø· Ù…Ø¯Ù„ Ø§ÛŒØ¬Ø§Ø¯ Ø´ÙˆØ¯Ø› Ø§Ú¯Ø±
// Ù†Ø±Ù…Ø§Ù„â€ŒØ³Ø§Ø²ÛŒ Ø´ÙˆØ¯ØŒ \r\n\r ÙˆØ§Ù‚Ø¹ÛŒ Ø®Ø±Ø§Ø¨ Ù†Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ú†ÙˆÙ† Ø§Ø¨ØªØ¯Ø§ \r\n Ú©Ø§Ù…Ù„ ØªØ¨Ø¯ÛŒÙ„ Ùˆ Ø­Ø°Ù
// Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ùˆ ÙÙ‚Ø· \r Ø¨Ø§Ù‚ÛŒâ€ŒÙ…Ø§Ù†Ø¯Ù‡ (ØªÙ†Ù‡Ø§) Ø¯Ø± Ù¾Ø§ÛŒØ§Ù† ØªØ¨Ø¯ÛŒÙ„ Ù…ÛŒâ€ŒØ´ÙˆØ¯.
function normalizeLineEndings(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeForFuzzyMatch(line) {
    return line.trim().replace(/\s+/g, ' ');
}

// Ù„Ø§ÛŒÙ‡â€ŒÛŒ Û±: ØªØ·Ø¨ÛŒÙ‚ Ø¯Ù‚ÛŒÙ‚ substring.
function findExactMatches(content, search) {
    const indices = [];
    let from = 0;
    while (true) {
        const idx = content.indexOf(search, from);
        if (idx === -1) break;
        indices.push(idx);
        from = idx + Math.max(1, search.length);
    }
    return indices;
}

// Ù„Ø§ÛŒÙ‡â€ŒÛŒ Û²: ØªØ·Ø¨ÛŒÙ‚ Ø¨Ø§ Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ† ØªÙØ§ÙˆØªâ€ŒÙ‡Ø§ÛŒ whitespace (Ù‡Ø± Ø¯Ùˆ Ø·Ø±Ù
// normalizeLineEndings Ø´Ø¯Ù‡ Ùˆ Ø®Ø·â€ŒØ¨Ù‡â€ŒØ®Ø· Ø¨Ø§ ÙØ§ØµÙ„Ù‡â€ŒÛŒ ÛŒÚ©Ø³Ø§Ù†â€ŒØ´Ø¯Ù‡ Ù…Ù‚Ø§ÛŒØ³Ù‡ Ù…ÛŒâ€ŒØ´ÙˆÙ†Ø¯).
// Ú†ÙˆÙ† Ø·ÙˆÙ„ Ù…Ù…Ú©Ù† Ø§Ø³Øª Ø¹ÙˆØ¶ Ø´ÙˆØ¯ (ØªØ¹Ø¯Ø§Ø¯ ÙØ§ØµÙ„Ù‡â€ŒÙ‡Ø§ ÙØ±Ù‚ Ø¯Ø§Ø±Ø¯)ØŒ Ø¨Ù‡â€ŒØ¬Ø§ÛŒ indexOf Ø³Ø§Ø¯Ù‡ØŒ
// ÛŒÚ© ØªØ·Ø¨ÛŒÙ‚ Ø®Ø·â€ŒØ¨Ù‡â€ŒØ®Ø· Ø±ÙˆÛŒ Ø¢Ø±Ø§ÛŒÙ‡â€ŒÛŒ Ø®Ø·ÙˆØ· Ø§Ù†Ø¬Ø§Ù… Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ùˆ Ø¨Ø§Ø²Ù‡â€ŒÛŒ Ø®Ø· Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯.
function findWhitespaceFlexibleMatch(contentLines, searchLines) {
    if (searchLines.length === 0) return null;
    const normSearch = searchLines.map(normalizeForFuzzyMatch);
    const matches = [];
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
        let ok = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (normalizeForFuzzyMatch(contentLines[i + j]) !== normSearch[j]) { ok = false; break; }
        }
        if (ok) matches.push(i);
    }
    return matches;
}

// Ù„Ø§ÛŒÙ‡â€ŒÛŒ Û³: fuzzy - ÙÙ‚Ø· Ø®Ø·ÙˆØ· ØºÛŒØ±Ø®Ø§Ù„ÛŒ search Ø¨Ø§ÛŒØ¯ Ø¨Ù‡ ØªØ±ØªÛŒØ¨ (Ø¨Ø§ Ø§Ø¬Ø§Ø²Ù‡â€ŒÛŒ
// Ú†Ø³Ø¨ÛŒØ¯Ú¯ÛŒ Ù†Ù‡â€ŒÚ†Ù†Ø¯Ø§Ù†â€ŒØ³Ø®Øªâ€ŒÚ¯ÛŒØ±Ø§Ù†Ù‡) Ø¯Ø± Ù…Ø­ØªÙˆØ§ Ù¾ÛŒØ¯Ø§ Ø´ÙˆÙ†Ø¯Ø› Ø®Ø·ÙˆØ· Ø®Ø§Ù„ÛŒ Ø¯Ø§Ø®Ù„ search
// Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ‡ Ù…ÛŒâ€ŒØ´ÙˆÙ†Ø¯. Ø§ÛŒÙ† Ø¢Ø®Ø±ÛŒÙ† Ù„Ø§ÛŒÙ‡ Ù‚Ø¨Ù„ Ø§Ø² Ø´Ú©Ø³Øª Ú©Ø§Ù…Ù„ Ø§Ø³Øª Ùˆ ÙÙ‚Ø· Ø²Ù…Ø§Ù†ÛŒ
// Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ú©Ù‡ Ù„Ø§ÛŒÙ‡â€ŒÛŒ Û± Ùˆ Û² Ù‡Ø± Ø¯Ùˆ ØµÙØ± ØªØ·Ø¨ÛŒÙ‚ Ø¯Ø§Ø´ØªÙ‡ Ø¨Ø§Ø´Ù†Ø¯.
function findFuzzyMatch(contentLines, searchLines) {
    const meaningfulSearch = searchLines.map(normalizeForFuzzyMatch).filter(Boolean);
    if (meaningfulSearch.length === 0) return null;
    const matches = [];
    const windowSize = searchLines.length;
    for (let i = 0; i <= contentLines.length - windowSize; i++) {
        const windowNorm = contentLines.slice(i, i + windowSize).map(normalizeForFuzzyMatch).filter(Boolean);
        if (windowNorm.length !== meaningfulSearch.length) continue;
        let ok = true;
        for (let j = 0; j < meaningfulSearch.length; j++) {
            if (windowNorm[j] !== meaningfulSearch[j]) { ok = false; break; }
        }
        if (ok) matches.push(i);
    }
    return matches;
}

// Ú¯Ø²Ø§Ø±Ø´ Ø´Ú©Ø³Øª: Ù†Ø²Ø¯ÛŒÚ©â€ŒØªØ±ÛŒÙ† context Ù‡Ø§ Ø±Ø§ (Ø¨Ø± Ø§Ø³Ø§Ø³ Ø§ÙˆÙ„ÛŒÙ† Ø®Ø· ØºÛŒØ±Ø®Ø§Ù„ÛŒ search)
// Ù¾ÛŒØ¯Ø§ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ ØªØ§ Ù…Ø¯Ù„ Ø¨ØªÙˆØ§Ù†Ø¯ search Ø±Ø§ Ø¯Ù‚ÛŒÙ‚â€ŒØªØ± Ú©Ù¾ÛŒ Ú©Ù†Ø¯.
function buildEditFailureReport(content, search, reasonText) {
    const searchLines = search.split('\n');
    const firstMeaningfulLine = (searchLines.find(l => l.trim()) || '').trim();
    const contentLines = content.split('\n');
    const candidates = [];
    const needle = firstMeaningfulLine.slice(0, Math.min(30, firstMeaningfulLine.length));
    if (needle) {
        contentLines.forEach((line, idx) => {
            if (line.includes(needle)) {
                const start = Math.max(0, idx - 3);
                const end = Math.min(contentLines.length, idx + 4);
                candidates.push({
                    lineNumber: idx + 1,
                    context: contentLines.slice(start, end).join('\n')
                });
            }
        });
    }
    return {
        reason: reasonText,
        candidatesFound: candidates.length,
        candidates: candidates.slice(0, 5),
        hint: 'search Ø±Ø§ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ø§Ø² ÛŒÚ©ÛŒ Ø§Ø² Ø§ÛŒÙ† context Ù‡Ø§ Ú©Ù¾ÛŒ Ú©Ù† (Ú©Ø§Ø±Ø§Ú©ØªØ± Ø¨Ù‡ Ú©Ø§Ø±Ø§Ú©ØªØ±ØŒ Ø´Ø§Ù…Ù„ ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ Ùˆ ØªÙˆØ±ÙØªÚ¯ÛŒ) ØªØ§ ÛŒÚ©ØªØ§ Ùˆ Ú©Ø§Ù…Ù„ ØªØ·Ø¨ÛŒÙ‚ Ù¾ÛŒØ¯Ø§ Ø´ÙˆØ¯ØŒ Ø³Ù¾Ø³ Ø¯ÙˆØ¨Ø§Ø±Ù‡ apply_edit Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†. Ø§Ú¯Ø± Ù…Ø·Ù…Ø¦Ù† Ù†ÛŒØ³ØªÛŒ Ù…Ø­ØªÙˆØ§ÛŒ Ø¯Ù‚ÛŒÙ‚ Ú©Ø¬Ø§Ø³ØªØŒ Ø§Ø¨ØªØ¯Ø§ Ø¨Ø§ read_file_section Ø¨Ø®Ø´ÛŒ Ø§Ø² ÙØ§ÛŒÙ„ Ø±Ø§ Ø¨Ø¨ÛŒÙ†.'
    };
}

// Ù…ÙˆØªÙˆØ± Ø§ØµÙ„ÛŒ: content Ú©Ø§Ù…Ù„ + search + replace Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ø¯ØŒ Ù‡Ø± Û´ Ù„Ø§ÛŒÙ‡ Ø±Ø§ Ø¨Ù‡
// ØªØ±ØªÛŒØ¨ Ø§Ù…ØªØ­Ø§Ù† Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ùˆ ÛŒØ§ content Ø¬Ø¯ÛŒØ¯ Ø±Ø§ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯ ÛŒØ§ Ø®Ø·Ø§ÛŒ Ø¯Ù‚ÛŒÙ‚.
// occurrence (Ø§Ø®ØªÛŒØ§Ø±ÛŒØŒ Û±-Ù¾Ø§ÛŒÙ‡) Ø¨Ø±Ø§ÛŒ Ø²Ù…Ø§Ù†ÛŒ Ø§Ø³Øª Ú©Ù‡ search Ø¹Ù…Ø¯Ø§Ù‹ Ú†Ù†Ø¯Ø¨Ø§Ø± Ø¯Ø±
// ÙØ§ÛŒÙ„ ØªÚ©Ø±Ø§Ø± Ø´Ø¯Ù‡ Ùˆ Ù…Ø¯Ù„ Ù…Ø´Ø®Øµ Ú©Ø±Ø¯Ù‡ Ú©Ø¯Ø§Ù… Ù†Ù…ÙˆÙ†Ù‡ Ù…Ø¯Ù†Ø¸Ø±Ø´ Ø§Ø³Øª.
function applySearchReplace(content, search, replace, occurrence) {
    if (!search || typeof search !== 'string') {
        return { success: false, reason: 'not_found', report: buildEditFailureReport(content, search || '', 'search Ø®Ø§Ù„ÛŒ ÛŒØ§ Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ø¨ÙˆØ¯.') };
    }

    const originalHadCRLF = /\r\n/.test(content);
    const normContent = normalizeLineEndings(content);
    const normSearch = normalizeLineEndings(search);
    const normReplace = normalizeLineEndings(replace == null ? '' : replace);

    const applyAt = (startIdx, endIdx) => {
        let result = normContent.slice(0, startIdx) + normReplace + normContent.slice(endIdx);
        if (originalHadCRLF) result = result.replace(/\n/g, '\r\n');
        return result;
    };

    // Ù„Ø§ÛŒÙ‡ Û±: ØªØ·Ø¨ÛŒÙ‚ Ø¯Ù‚ÛŒÙ‚
    const exactMatches = findExactMatches(normContent, normSearch);
    if (exactMatches.length === 1) {
        return { success: true, content: applyAt(exactMatches[0], exactMatches[0] + normSearch.length), layer: 'exact' };
    }
    if (exactMatches.length > 1) {
        if (Number.isFinite(occurrence) && occurrence >= 1 && occurrence <= exactMatches.length) {
            const idx = exactMatches[occurrence - 1];
            return { success: true, content: applyAt(idx, idx + normSearch.length), layer: 'exact_occurrence' };
        }
        return {
            success: false,
            reason: 'ambiguous',
            report: {
                reason: `Ø§ÛŒÙ† search Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ ${exactMatches.length} Ø¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„ Ù¾ÛŒØ¯Ø§ Ø´Ø¯ - Ø¨Ø§ÛŒØ¯ ÛŒÚ©ØªØ§ Ø¨Ø§Ø´Ø¯ ÛŒØ§ occurrence Ù…Ø´Ø®Øµ Ø´ÙˆØ¯.`,
                candidatesFound: exactMatches.length,
                candidates: exactMatches.slice(0, 5).map(idx => ({
                    lineNumber: normContent.slice(0, idx).split('\n').length,
                    context: normContent.slice(Math.max(0, idx - 60), idx + normSearch.length + 60)
                })),
                hint: 'ÛŒØ§ search Ø±Ø§ Ø¨Ø§ Ú†Ù†Ø¯ Ø®Ø· Ø§Ø·Ø±Ø§Ù Ø¨ÛŒØ´ØªØ± ÛŒÚ©ØªØ§ Ú©Ù†ØŒ ÛŒØ§ occurrence (Ø´Ù…Ø§Ø±Ù‡â€ŒÛŒ Ù†Ù…ÙˆÙ†Ù‡â€ŒÛŒ Ù…ÙˆØ±Ø¯Ù†Ø¸Ø±ØŒ Ø§Ø² Û± Ø´Ø±ÙˆØ¹) Ø±Ø§ Ø¯Ø± ÙØ±Ø§Ø®ÙˆØ§Ù†ÛŒ apply_edit Ù…Ø´Ø®Øµ Ú©Ù†.'
            }
        };
    }

    // Ù„Ø§ÛŒÙ‡ Û²: whitespace-flexible Ø®Ø·â€ŒØ¨Ù‡â€ŒØ®Ø·
    const contentLines = normContent.split('\n');
    const searchLines = normSearch.split('\n');
    const wsMatches = findWhitespaceFlexibleMatch(contentLines, searchLines);
    if (wsMatches && wsMatches.length >= 1) {
        if (wsMatches.length === 1 || (Number.isFinite(occurrence) && occurrence >= 1 && occurrence <= wsMatches.length)) {
            const lineIdx = wsMatches.length === 1 ? wsMatches[0] : wsMatches[occurrence - 1];
            const startIdx = contentLines.slice(0, lineIdx).join('\n').length + (lineIdx > 0 ? 1 : 0);
            const matchedText = contentLines.slice(lineIdx, lineIdx + searchLines.length).join('\n');
            const endIdx = startIdx + matchedText.length;
            return { success: true, content: applyAt(startIdx, endIdx), layer: 'whitespace_flexible' };
        }
        return {
            success: false,
            reason: 'ambiguous',
            report: {
                reason: `Ø§ÛŒÙ† search (Ø¨Ø§ Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ† ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ) ${wsMatches.length} Ø¨Ø§Ø± Ù¾ÛŒØ¯Ø§ Ø´Ø¯ - Ø¨Ø§ÛŒØ¯ ÛŒÚ©ØªØ§ Ø¨Ø§Ø´Ø¯ ÛŒØ§ occurrence Ù…Ø´Ø®Øµ Ø´ÙˆØ¯.`,
                candidatesFound: wsMatches.length,
                candidates: wsMatches.slice(0, 5).map(lineIdx => ({
                    lineNumber: lineIdx + 1,
                    context: contentLines.slice(Math.max(0, lineIdx - 3), lineIdx + searchLines.length + 3).join('\n')
                })),
                hint: 'search Ø±Ø§ Ø¨Ø§ ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ Ø¯Ù‚ÛŒÙ‚â€ŒØªØ± Ø¨Ø¯Ù‡ ÛŒØ§ occurrence Ù…Ø´Ø®Øµ Ú©Ù†.'
            }
        };
    }

    // Ù„Ø§ÛŒÙ‡ Û³: fuzzy (Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ† Ø®Ø·ÙˆØ· Ø®Ø§Ù„ÛŒ Ø¯Ø§Ø®Ù„ search + ÙØ§ØµÙ„Ù‡â€ŒÛŒ Ø§Ø·Ø±Ø§Ù)
    const fuzzyMatches = findFuzzyMatch(contentLines, searchLines);
    if (fuzzyMatches && fuzzyMatches.length === 1) {
        const lineIdx = fuzzyMatches[0];
        const startIdx = contentLines.slice(0, lineIdx).join('\n').length + (lineIdx > 0 ? 1 : 0);
        const matchedText = contentLines.slice(lineIdx, lineIdx + searchLines.length).join('\n');
        const endIdx = startIdx + matchedText.length;
        return { success: true, content: applyAt(startIdx, endIdx), layer: 'fuzzy' };
    }
    if (fuzzyMatches && fuzzyMatches.length > 1) {
        return {
            success: false,
            reason: 'ambiguous',
            report: buildEditFailureReport(normContent, normSearch, `Ø§ÛŒÙ† search Ø­ØªÛŒ Ø¨Ù‡â€ŒØµÙˆØ±Øª fuzzy Ù‡Ù… ${fuzzyMatches.length} Ø¨Ø§Ø± Ù…Ø´Ø§Ø¨Ù‡ Ù¾ÛŒØ¯Ø§ Ø´Ø¯ - Ù…Ø¨Ù‡Ù… Ø§Ø³Øª.`)
        };
    }

    // Ù„Ø§ÛŒÙ‡ Û´: Ø´Ú©Ø³Øª Ú©Ø§Ù…Ù„
    return {
        success: false,
        reason: 'not_found',
        report: buildEditFailureReport(normContent, normSearch, 'Ø§ÛŒÙ† Ù…ØªÙ† (search) Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ ÛŒØ§ Ø­ØªÛŒ Ø¨Ù‡â€ŒØµÙˆØ±Øª fuzzy Ø¯Ø± ÙØ§ÛŒÙ„ Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.')
    };
}

// ÛŒÚ© FileEditState Ø¨Ø±Ø§ÛŒ ÛŒÚ© ÙØ§ÛŒÙ„ Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯ - Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ø³Ø§Ø¯Ù‡â€ŒÛŒ BlockFileState.
// ÙÙ‚Ø· Ù…Ø­ØªÙˆØ§ÛŒ ÙØ¹Ù„ÛŒ + ØªØ§Ø±ÛŒØ®Ú†Ù‡â€ŒÛŒ Ø§Ø¯ÛŒØªâ€ŒÙ‡Ø§ Ø±Ø§ Ù†Ú¯Ù‡ Ù…ÛŒâ€ŒØ¯Ø§Ø±Ø¯Ø› Ù‡ÛŒÚ† Ø´Ù…Ø§Ø±Ù‡â€ŒØ¨Ù†Ø¯ÛŒ Ø¨Ù„ÙˆÚ©ÛŒ
// Ø¯Ø± Ú©Ø§Ø± Ù†ÛŒØ³ØªØŒ Ù¾Ø³ Ù†ÛŒØ§Ø²ÛŒ Ø¨Ù‡ recompute Ø¨Ø¹Ø¯ Ø§Ø² Ù‡Ø± ØªØºÛŒÛŒØ± Ø·ÙˆÙ„ Ù‡Ù… Ù†ÛŒØ³Øª.
function createFileEditState(file) {
    return {
        name: file.name,
        content: String(file.content || ''),
        editCount: 0,
        verified: false,
        editedName: null
    };
}

const FILE_BLOCK_TARGET_LINES = 500; // Ø§Ù†Ø¯Ø§Ø²Ù‡â€ŒÛŒ Ù‡Ø¯Ù Ù‡Ø± Ø¨Ù„ÙˆÚ© - Ù†Ù‡ Ø³Ù‚Ù Ø³Ø®ØªØŒ Ù†Ø²Ø¯ÛŒÚ©â€ŒØªØ±ÛŒÙ† Ù…Ø±Ø² Ù…Ù†Ø·Ù‚ÛŒ (Ø®Ø· Ø®Ø§Ù„ÛŒ/section) Ø¨Ù‡ Ø§ÛŒÙ† Ø¹Ø¯Ø¯ Ø§Ù†ØªØ®Ø§Ø¨ Ù…ÛŒâ€ŒØ´ÙˆØ¯

// ÛŒÚ© ÙØ§ÛŒÙ„ Ø±Ø§ Ø¨Ù‡ Ø¨Ù„ÙˆÚ©â€ŒÙ‡Ø§ÛŒ Ø«Ø§Ø¨Øª ØªÙ‚Ø³ÛŒÙ… Ù…ÛŒâ€ŒÚ©Ù†Ø¯. Ù…Ø±Ø² Ù‡Ø± Ø¨Ù„ÙˆÚ© ØªØ§ Ø­Ø¯ Ø§Ù…Ú©Ø§Ù† Ø±ÙˆÛŒ ÛŒÚ©
// Ø®Ø· Ø®Ø§Ù„ÛŒ ÛŒØ§ Ù…Ø±Ø² section (Ø§Ø² analyzeFileStructure) Ù‚Ø±Ø§Ø± Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ø¯ ØªØ§ ÙˆØ³Ø· ÛŒÚ©
// ØªØ§Ø¨Ø¹/ØªÚ¯ Ù‚Ø·Ø¹ Ù†Ø´ÙˆØ¯Ø› Ø§Ù…Ø§ Ø§ÛŒÙ† ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ Ø®ÙˆØ§Ù†Ø§ÛŒÛŒ preview Ø§Ø³Øª - Ú†ÙˆÙ† write_block
// Ù‡Ù…ÛŒØ´Ù‡ Ú©Ù„ Ø¨Ù„ÙˆÚ© Ø±Ø§ Ø¹ÙˆØ¶ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ù†Ù‡ ÛŒÚ© semantic unit Ø±Ø§ØŒ Ù‚Ø·Ø¹ Ø´Ø¯Ù† ÙˆØ³Ø· ØªØ§Ø¨Ø¹ Ù‡ÛŒÚ†
// Ù…Ø´Ú©Ù„ ØµØ­ØªÛŒ Ø§ÛŒØ¬Ø§Ø¯ Ù†Ù…ÛŒâ€ŒÚ©Ù†Ø¯.
// Ù…Ø­Ø§Ø³Ø¨Ù‡â€ŒÛŒ Ø¹Ù…Ù‚ ØªÙˆØ¯Ø±ØªÙˆÛŒÛŒ ØªÚ¯â€ŒÙ‡Ø§ÛŒ XML/HTML Ø¯Ø± Ø§Ù†ØªÙ‡Ø§ÛŒ Ù‡Ø± Ø®Ø·ØŒ Ø¨Ø±Ø§ÛŒ ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ
// html/svg/xml. Ø§ÛŒÙ† ÙÙ‚Ø· ÛŒÚ© Ø´Ù…Ø§Ø±Ù†Ø¯Ù‡â€ŒÛŒ Ø³Ø§Ø¯Ù‡â€ŒÛŒ Ø¨Ø§Ø²/Ø¨Ø³ØªÙ‡ (Ø¨Ø¯ÙˆÙ† Ù¾Ø§Ø±Ø³ ÙˆØ§Ù‚Ø¹ÛŒ) Ø§Ø³Øª -
// Ú©Ø§ÙÛŒ Ø§Ø³Øª ØªØ§ Ø¨ÙÙ‡Ù…ÛŒÙ… Ù…Ø±Ø² Ø¨ÛŒÙ† Ø¯Ùˆ Ø®Ø· "Ø¯Ø§Ø®Ù„ ÛŒÚ© ØªÚ¯ Ø¨Ø§Ø²" Ø§Ø³Øª ÛŒØ§ Ù†Ù‡. ØªÚ¯â€ŒÙ‡Ø§ÛŒ
// self-closing (<path .../>) Ùˆ void element Ù‡Ø§ÛŒ HTML (br, img, ...) Ø¹Ù…Ù‚ Ø±Ø§
// ØªØºÛŒÛŒØ± Ù†Ù…ÛŒâ€ŒØ¯Ù‡Ù†Ø¯. Ú©Ø§Ù…Ù†Øªâ€ŒÙ‡Ø§ÛŒ XML/HTML (<!-- ... -->) Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ú¯Ø±ÙØªÙ‡ Ù…ÛŒâ€ŒØ´ÙˆÙ†Ø¯ ØªØ§
// ØªÚ¯ Ø¯Ø§Ø®Ù„ Ú©Ø§Ù…Ù†Øª Ø¨Ø§Ø¹Ø« Ø§Ø´ØªØ¨Ø§Ù‡ Ø´Ù…Ø§Ø±Ø´ Ù†Ø´ÙˆØ¯.
const VOID_HTML_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
function computeTagDepthPerLine(content) {
    const lines = String(content || '').split(/\r?\n/);
    const depths = new Array(lines.length + 1).fill(0); // depths[i] = Ø¹Ù…Ù‚ Ø¨Ø¹Ø¯ Ø§Ø² Ù¾Ø§ÛŒØ§Ù† Ø®Ø· i (1-indexed)
    let depth = 0;
    let insideComment = false;
    const tagRe = /<!--|-->|<\/?([a-zA-Z][a-zA-Z0-9:-]*)[^>]*?(\/?)>/g;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m;
        tagRe.lastIndex = 0;
        while ((m = tagRe.exec(line))) {
            const token = m[0];
            if (token === '<!--') { insideComment = true; continue; }
            if (token === '-->') { insideComment = false; continue; }
            if (insideComment) continue;
            const tagName = (m[1] || '').toLowerCase();
            const selfClosing = m[2] === '/' || VOID_HTML_TAGS.has(tagName);
            if (selfClosing) continue;
            if (token.startsWith('</')) {
                depth = Math.max(0, depth - 1);
            } else {
                depth++;
            }
        }
        depths[i + 1] = depth;
    }
    return depths;
}

function computeFileBlocks(content, fileName) {
    const lines = String(content || '').split(/\r?\n/);
    const totalLines = lines.length;
    const blocks = [];

    if (totalLines === 0) {
        return [{ number: 1, startLine: 1, endLine: 0, preview: '(ÙØ§ÛŒÙ„ Ø®Ø§Ù„ÛŒ Ø§Ø³Øª)' }];
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

    // FIX (Ø¨Ù„ÙˆÚ© ÙˆØ³Ø· <g>/<svg>... Ù‚Ø·Ø¹ Ù…ÛŒâ€ŒØ´Ø¯): Ø¨Ø±Ø§ÛŒ html/svg/xmlØŒ Ù…Ø±Ø² Ø¨Ù„ÙˆÚ©
    // Ù‡Ø±Ú¯Ø² Ù†Ø¨Ø§ÛŒØ¯ Ø¬Ø§ÛŒÛŒ Ø¨Ø§Ø´Ø¯ Ú©Ù‡ Ø¹Ù…Ù‚ ØªÚ¯ Ø¨Ø§Ø² Ø§Ø³Øª - ÛŒØ¹Ù†ÛŒ Ù‡Ù†ÙˆØ² Ø¯Ø§Ø®Ù„ ÛŒÚ© ØªÚ¯ Ù†Ø¨Ø³ØªÙ‡
    // Ù‡Ø³ØªÛŒÙ…. Ø¨Ø¯ÙˆÙ† Ø§ÛŒÙ† Ú†Ú©ØŒ preferredBoundaries ÙÙ‚Ø· ØªÚ¯â€ŒÙ‡Ø§ÛŒ Ø´Ù†Ø§Ø®ØªÙ‡â€ŒØ´Ø¯Ù‡â€ŒÛŒ Ù…Ø­Ø¯ÙˆØ¯
    // (div/section/...) Ø±Ø§ Ù…ÛŒâ€ŒØ¯ÛŒØ¯ Ùˆ <g>/<path>/Ø¹Ù†Ø§ØµØ± SVG Ø±Ø§ Ø§ØµÙ„Ø§Ù‹ Ù†Ù…ÛŒâ€ŒØ´Ù†Ø§Ø®ØªØŒ
    // Ù¾Ø³ ÛŒÚ© Ø®Ø· Ø®Ø§Ù„ÛŒÙ ØªØµØ§Ø¯ÙÛŒÙ ÙˆØ³Ø· <g> Ø¨Ù‡â€ŒØ¹Ù†ÙˆØ§Ù† Ù…Ø±Ø² Ø§Ù†ØªØ®Ø§Ø¨ Ù…ÛŒâ€ŒØ´Ø¯ Ùˆ write_block
    // Ø±ÙˆÛŒ ÛŒÚ© ØªÚ¯ Ù†ØµÙÙ‡ Ø±Ø¯ Ù…ÛŒâ€ŒØ´Ø¯.
    const lowerName = String(fileName || '').toLowerCase();
    const isMarkup = /\.(html?|htm|svg|xml)$/.test(lowerName) || /<svg[\s>]/i.test(content.slice(0, 2000));
    const tagDepths = isMarkup ? computeTagDepthPerLine(content) : null;

    let cursor = 1;
    let blockNumber = 1;
    while (cursor <= totalLines) {
        const idealEnd = Math.min(totalLines, cursor + FILE_BLOCK_TARGET_LINES - 1);
        let end = idealEnd;

        if (idealEnd < totalLines) {
            const searchWindow = 40;
            let bestEnd = null;
            for (let candidate = idealEnd; candidate > Math.max(cursor, idealEnd - searchWindow); candidate--) {
                // Ø§Ú¯Ø± Ø¯Ø§Ø®Ù„ ÛŒÚ© ØªÚ¯ Ø¨Ø§Ø² Ù‡Ø³ØªÛŒÙ… (Ø¹Ù…Ù‚ > Û° Ø¯Ø± Ø§Ù†ØªÙ‡Ø§ÛŒ Ø§ÛŒÙ† Ø®Ø·)ØŒ Ø§ÛŒÙ†
                // Ù†Ù‚Ø·Ù‡ Ù‡Ø±Ú¯Ø² Ù…Ø±Ø² Ù…Ø¹ØªØ¨Ø± Ù†ÛŒØ³Øª - Ø­ØªÛŒ Ø§Ú¯Ø± preferredBoundaries ÛŒØ§
                // Ø®Ø· Ø®Ø§Ù„ÛŒ Ø¨Ø§Ø´Ø¯ØŒ Ú†ÙˆÙ† Ù‚Ø·Ø¹ Ú©Ø±Ø¯Ù† Ø§ÛŒÙ†Ø¬Ø§ ÛŒÚ© ØªÚ¯ Ø¨Ø§Ø² Ø±Ø§ Ù†ØµÙÙ‡ Ø±Ù‡Ø§
                // Ù…ÛŒâ€ŒÚ©Ù†Ø¯.
                if (tagDepths && tagDepths[candidate] > 0) continue;

                const lineText = lines[candidate - 1];
                const nextLineIsBoundary = preferredBoundaries.has(candidate + 1);
                const thisLineBlank = lineText !== undefined && lineText.trim() === '';
                if (nextLineIsBoundary || thisLineBlank) {
                    bestEnd = candidate;
                    break;
                }
            }
            // Ø§Ú¯Ø± Ù‡ÛŒÚ† Ù…Ø±Ø² "Ø§ÛŒØ¯Ù‡â€ŒØ¢Ù„" Ø¨Ø§ Ø¹Ù…Ù‚ ØµÙØ± Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯ØŒ Ø­Ø¯Ø§Ù‚Ù„ Ù†Ø²Ø¯ÛŒÚ©â€ŒØªØ±ÛŒÙ†
            // Ù†Ù‚Ø·Ù‡â€ŒÛŒ Ø¹Ù…Ù‚-ØµÙØ± Ø±Ø§ Ø¯Ø± Ú©Ù„ Ø¨Ø§Ø²Ù‡â€ŒÛŒ Ù…Ø¬Ø§Ø² Ù¾ÛŒØ¯Ø§ Ú©Ù† (Ù†Ù‡ ÙÙ‚Ø· Ù¾Ù†Ø¬Ø±Ù‡â€ŒÛŒ
            // Û´Û° Ø®Ø·ÛŒ) ØªØ§ Ù…Ø·Ù…Ø¦Ù† Ø´ÙˆÛŒÙ… Ø¨Ù„ÙˆÚ© Ù‡Ø±Ú¯Ø² ÙˆØ³Ø· ØªÚ¯ Ø¨Ø§Ø² Ù‚Ø·Ø¹ Ù†Ù…ÛŒâ€ŒØ´ÙˆØ¯ØŒ Ø­ØªÛŒ
            // Ø§Ú¯Ø± ØªÚ¯ Ø®ÛŒÙ„ÛŒ Ø·ÙˆÙ„Ø§Ù†ÛŒ (Ú†Ù†Ø¯ ØµØ¯ Ø®Ø·) Ø¨Ø§Ø´Ø¯.
            if (!bestEnd && tagDepths) {
                for (let candidate = idealEnd; candidate >= cursor; candidate--) {
                    if (tagDepths[candidate] === 0) { bestEnd = candidate; break; }
                }
                if (!bestEnd) {
                    for (let candidate = idealEnd + 1; candidate <= totalLines; candidate++) {
                        if (tagDepths[candidate] === 0) { bestEnd = candidate; break; }
                    }
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

// ÛŒÚ© BlockFileState Ø¨Ø±Ø§ÛŒ ÛŒÚ© ÙØ§ÛŒÙ„ Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯. Ø¨Ø§ÛŒØ¯ ØªÙˆØ³Ø· caller (Ø³Ø·Ø­ HTTP
// request) Ø³Ø§Ø®ØªÙ‡ Ø´ÙˆØ¯ Ùˆ Ø¨ÛŒÙ† Ù‡Ù…Ù‡â€ŒÛŒ retryÙ‡Ø§ÛŒ Ù‡Ù…Ø§Ù† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø¨Ù‡ runAgentLoop
// Ù¾Ø§Ø³ Ø¯Ø§Ø¯Ù‡ Ø´ÙˆØ¯ - Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù…Ø«Ù„ sharedRequestState.
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

// Ø¨Ù„ÙˆÚ©â€ŒØ¨Ù†Ø¯ÛŒ Ø±Ø§ Ø¨Ø¹Ø¯ Ø§Ø² ØªØºÛŒÛŒØ± Ø·ÙˆÙ„ ÙØ§ÛŒÙ„ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ù…Ø­Ø§Ø³Ø¨Ù‡ Ù…ÛŒâ€ŒÚ©Ù†Ø¯. Ú†ÙˆÙ† write_block
// Ù…ÛŒâ€ŒØªÙˆØ§Ù†Ø¯ Ø·ÙˆÙ„ Ø¨Ù„ÙˆÚ© Ù†ÙˆØ´ØªÙ‡â€ŒØ´Ø¯Ù‡ Ø±Ø§ Ø¹ÙˆØ¶ Ú©Ù†Ø¯ØŒ Ø´Ù…Ø§Ø±Ù‡â€ŒÛŒ Ø¨Ù„ÙˆÚ©â€ŒÙ‡Ø§ÛŒ Ø¨Ø¹Ø¯ÛŒ Ø¨Ø§ÛŒØ¯ Ø¨Ø§
// Ø®Ø·ÙˆØ· Ø¬Ø¯ÛŒØ¯ Ù‡Ù…Ø®ÙˆØ§Ù†ÛŒ Ø¯Ø§Ø´ØªÙ‡ Ø¨Ø§Ø´Ø¯. Ø¨Ø§Ø²Ø³Ø§Ø²ÛŒ Ø§Ø² ØµÙØ± Ø§Ø±Ø²Ø§Ù† Ùˆ Ø¨Ø¯ÙˆÙ† edge-case Ø§Ø³Øª.
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
        hint: 'old Ø±Ø§ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ø§Ø² ÛŒÚ©ÛŒ Ø§Ø² Ø§ÛŒÙ† context Ù‡Ø§ Ú©Ù¾ÛŒ Ú©Ù† (Ú©Ø§Ø±Ø§Ú©ØªØ± Ø¨Ù‡ Ú©Ø§Ø±Ø§Ú©ØªØ±ØŒ Ø´Ø§Ù…Ù„ ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ) ØªØ§ ÛŒÚ©ØªØ§ Ø´ÙˆØ¯ØŒ Ø³Ù¾Ø³ Ø¯ÙˆØ¨Ø§Ø±Ù‡ apply_patch Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†.'
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
    const pick = (arr, key = 'name') => arr.slice(0, 60).map(x => key === 'text' ? x.text : `${x[key] || ''}${x.line ? ` (Ø®Ø· ${x.line})` : ''}`).filter(Boolean);
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
                    'Ø¬Ø³ØªØ¬ÙÛ ÙØ§ÙØ¹Û Ù Ø²ÙØ¯Ù Ø¯Ø± ÙØ¨ Ø¨Ø±Ø§Û Ø§Ø·ÙØ§Ø¹Ø§Øª Ø¨ÙâØ±ÙØ²Ø ÙÛÙØªØ Ø§Ø®Ø¨Ø§Ø±Ø Ø±ÙÛØ¯Ø§Ø¯ÙØ§ ÛØ§ ÙØ± ' +
                    'ÚÛØ²Û Ú©Ù ÙÙÚ©Ù Ø§Ø³Øª Ø¨Ø¹Ø¯ Ø§Ø² Ø²ÙØ§Ù Ø¢ÙÙØ²Ø´ ÙØ¯Ù ØªØºÛÛØ± Ú©Ø±Ø¯Ù Ø¨Ø§Ø´Ø¯ ÛØ§ ÙØ¯Ù Ø¨Ù Ø¢Ù ÙØ·ÙØ¦Ù ÙÛØ³Øª. ' +
                    'Ø¨Ø±Ø§Û Ø§Ú©Ø«Ø± Ø³Ø¤Ø§ÙâÙØ§ (Ø­ØªÛ Ø³Ø¤Ø§ÙâÙØ§Û Ø³Ø§Ø¯ÙâÛ Â«ÙÛÙØª Ø§ÙØ§Ù ÚÙØ¯ÙÂ») ÛÚ©âØ¨Ø§Ø± ØµØ¯Ø§ Ø²Ø¯Ù Ø§ÛÙ Ø§Ø¨Ø²Ø§Ø± ' +
                    'Ø¨Ø§ ÛÚ© query Ø®ÙØ¨ Ú©Ø§ÙÛ Ø§Ø³Øª Ù Ø¨Ø§ÛØ¯ Ø¨Ø§ ÙÙØ§Ù ÙØªØ§ÛØ¬ Ø¬ÙØ§Ø¨ ÙÙØ§ÛÛ Ø¯Ø§Ø¯Ù Ø´ÙØ¯. ØµØ¯Ø§ Ø²Ø¯Ù Ø¯ÙØ¨Ø§Ø±Ù ' +
                    'ÙÙØ· Ø¯Ø± ÙÙØ§Ø±Ø¯ ÙØ§Ø¯Ø± Ù ÙØ§ÙØ¹Û ÙØ¬Ø§Ø² Ø§Ø³Øª: ÙÙØªÛ ÙØªÛØ¬ÙâÛ Ø¬Ø³ØªØ¬ÙÛ Ø§ÙÙ Ú©Ø§ÙÙØ§Ù Ø¨ÛâØ±Ø¨Ø·/ÙØ§ÙØµ Ø¨ÙØ¯Ø ' +
                    'ÛØ§ Ø³Ø¤Ø§Ù ÚÙØ¯ Ø¨Ø®Ø´ Ú©Ø§ÙÙØ§Ù Ø¬Ø¯Ø§ Ø§Ø² ÙÙ Ø¯Ø§Ø±Ø¯ Ú©Ù ÙØ±Ú©Ø¯Ø§Ù ÙÙØ¶ÙØ¹ ÙØªÙØ§ÙØªÛ Ø§Ø³Øª. ÙØ±Ú¯Ø² Ø¨Ø±Ø§Û Â«Ø¯ÙÛÙâØªØ± ' +
                    'Ú©Ø±Ø¯ÙÂ» ÛÚ© Ø¬Ø³ØªØ¬ÙÛ ÙØ¨ÙØ§Ù ÙÙÙÙ Ø¯ÙØ¨Ø§Ø±Ù Ø³Ø±Ú ÙØ²Ù.\n\n' +
                    'Ø²Ø¨Ø§Ù query: Ø¨Ø±Ø§Û ÙÙØ¶ÙØ¹Ø§Øª Ø¹ÙÙÙÛØ Ø¬ÙØ§ÙÛØ Ø¹ÙÙÛØ ÙÙÛ ÛØ§ ÙØ± ÚÛØ²Û Ú©Ù ÙÙØ§Ø¨Ø¹ Ø§ÙÚ¯ÙÛØ³ÛâØ²Ø¨Ø§Ù ' +
                    'Ø¨ÙØªØ± Ù ÙØ¹ØªØ¨Ø±ØªØ± Ù¾ÙØ´Ø´Ø´ ÙÛâØ¯ÙÙØ¯ (ÙØ«ÙØ§Ù Ø§Ø®Ø¨Ø§Ø± Ø¬ÙØ§ÙÛØ ÙÛÙØª Ø§Ø±Ø²ÙØ§Û Ø®Ø§Ø±Ø¬ÛØ Ø³ÙØ§Ù Ø¬ÙØ§ÙÛØ ' +
                    'ÙÙØ§ÙØ±ÛØ Ø¹ÙÙÙØ ÙØ±Ø²Ø´âÙØ§Û Ø¨ÛÙâØ§ÙÙÙÙÛØ Ø´Ø±Ú©ØªâÙØ§ Ù Ø´Ø®ØµÛØªâÙØ§Û Ø®Ø§Ø±Ø¬Û)Ø query Ø±Ø§ Ø¨Ù ' +
                    'Ø§ÙÚ¯ÙÛØ³Û Ø¨ÙÙÛØ³Ø Ø­ØªÛ Ø§Ú¯Ø± Ø®ÙØ¯ ÙÚ©Ø§ÙÙÙ ÙØ§Ø±Ø³Û Ø§Ø³Øª - ÙØªØ§ÛØ¬ Ø§ÙÚ¯ÙÛØ³Û Ø±Ø§ Ø¯Ø± Ù¾Ø§Ø³Ø® ÙÙØ§ÛÛ Ø¨Ù ÙØ§Ø±Ø³Û ' +
                    'Ø®ÙØ§ØµÙ Ù ØªØ±Ø¬ÙÙ Ú©Ù. Ø§ÙØ§ Ø¨Ø±Ø§Û ÙØ± ÚÛØ²Û Ú©Ù ÙØ®ØªØµ Ø§ÛØ±Ø§Ù Ø§Ø³Øª (ÙÛÙØª Ø¯ÙØ§Ø±/Ø§Ø±Ø² Ø¯Ø± Ø¨Ø§Ø²Ø§Ø± ' +
                    'Ø¢Ø²Ø§Ø¯ Ø§ÛØ±Ø§ÙØ Ø§Ø®Ø¨Ø§Ø± Ø¯Ø§Ø®ÙÛ Ø§ÛØ±Ø§ÙØ ÙÙØ§ÙÛÙ/ÙÙØ§Ø¯ÙØ§Û Ø§ÛØ±Ø§ÙØ ÙÛÙØª Ø¯Ø± Ø¨Ø§Ø²Ø§Ø± Ø§ÛØ±Ø§ÙØ ÙØ±Ø²Ø´/Ø³ÙØ¨Ø±ÛØªÛâÙØ§Û ' +
                    'Ø§ÛØ±Ø§ÙÛ ÛØ§ ÙØ± ÙÙØ¶ÙØ¹Û Ú©Ù ÙÙØ§Ø¨Ø¹ ÙØ§Ø±Ø³ÛâØ²Ø¨Ø§Ù Ø¯Ø§Ø®ÙÛ Ø¯ÙÛÙâØªØ± Ù ÙØ±ØªØ¨Ø·âØªØ±ÙØ¯)Ø query Ø±Ø§ ÙÙÚÙØ§Ù ' +
                    'Ø¨Ù ÙØ§Ø±Ø³Û Ø¨ÙÙÛØ³ - Ø§ÛÙØ¬Ø§ ØªØ±Ø¬ÙÙâÛ Ø¬Ø³ØªØ¬Ù Ø¨Ù Ø§ÙÚ¯ÙÛØ³Û Ø¨Ø§Ø¹Ø« ÙÛâØ´ÙØ¯ ÙØªØ§ÛØ¬ ÙØ§ÙØ¹Ø§Ù ÙØ±ØªØ¨Ø· Ú¯Ù Ø´ÙÙØ¯. ' +
                    'ÛØ¹ÙÛ Ø²Ø¨Ø§Ù query Ø±Ø§ ÙÙÛØ´Ù Ø¨Ø± Ø§Ø³Ø§Ø³ ÙÙØ¶ÙØ¹ Ø§ÙØªØ®Ø§Ø¨ Ú©ÙØ ÙÙ Ø¨Ø± Ø§Ø³Ø§Ø³ Ø²Ø¨Ø§Ù ÙÚ©Ø§ÙÙÙ - ÙØ±Ú¯Ø² ÙÙÙâÛ ' +
                    'Ø¬Ø³ØªØ¬ÙÙØ§ Ø±Ø§ ÛÚ©âØ¯Ø³Øª Ø§ÙÚ¯ÙÛØ³Û ÛØ§ ÛÚ©âØ¯Ø³Øª ÙØ§Ø±Ø³Û ÙÚ©Ù.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Ø¹Ø¨Ø§Ø±Øª Ø¬Ø³ØªØ¬Ù - Ú©ÙØªØ§ÙØ Ø¯ÙÛÙ Ù ÙØ±ØªØ¨Ø· Ø¨Ø§ ÚÛØ²Û Ú©Ù ÙØ§Ø²Ù Ø¯Ø§Ø±Û Ø¨Ø¯Ø§ÙÛ. Ø²Ø¨Ø§ÙØ´ Ø±Ø§ Ø·Ø¨Ù Ø±Ø§ÙÙÙØ§Û ' +
                                'Â«Ø²Ø¨Ø§Ù queryÂ» Ø¯Ø± ØªÙØ¶ÛØ­ Ø§ÛÙ Ø§Ø¨Ø²Ø§Ø± Ø§ÙØªØ®Ø§Ø¨ Ú©Ù: Ø§ÙÚ¯ÙÛØ³Û Ø¨Ø±Ø§Û ÙÙØ¶ÙØ¹Ø§Øª Ø¬ÙØ§ÙÛ/Ø¹ÙÙÙÛØ ÙØ§Ø±Ø³Û Ø¨Ø±Ø§Û ' +
                                'ÙÙØ¶ÙØ¹Ø§Øª ÙØ®ØªØµ Ø§ÛØ±Ø§Ù.'
                        },
                        reason: {
                            type: 'string',
                            description: 'ÛÚ© Ø¬ÙÙÙâÛ Ú©ÙØªØ§Ù ÙØ§Ø±Ø³Û Ú©Ù Ø¨Ù Ú©Ø§Ø±Ø¨Ø± ÙØ´Ø§Ù Ø¯Ø§Ø¯Ù ÙÛâØ´ÙØ¯ Ù ØªÙØ¶ÛØ­ ÙÛâØ¯ÙØ¯ ÚØ±Ø§ Ø¯Ø§Ø±Û Ø§ÛÙ Ø±Ø§ Ø³Ø±Ú ÙÛâÚ©ÙÛ (ÙØ«ÙØ§Ù "Ø¯Ø§Ø±Ù Ø¢Ø®Ø±ÛÙ ÙÛÙØª Ø·ÙØ§ Ø±Ù Ø¨Ø±Ø±Ø³Û ÙÛâÚ©ÙÙ").'
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
                    'Ù…Ø­ØªÙˆØ§ÛŒ ÛŒÚ©ÛŒ Ø§Ø² ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ù‚Ø¨Ù„Ø§Ù‹ Ø§Ø±Ø³Ø§Ù„â€ŒØ´Ø¯Ù‡ Ø¯Ø± Ù‡Ù…ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ø±Ø§ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯. Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø±Ø§ ' +
                    'ÙÙ‚Ø· Ø²Ù…Ø§Ù†ÛŒ ØµØ¯Ø§ Ø¨Ø²Ù† Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¨Ù‡ Ù…Ø­ØªÙˆØ§ÛŒ ÛŒÚ© ÙØ§ÛŒÙ„ Ù‚Ø¨Ù„ÛŒ Ù†ÛŒØ§Ø² Ø¯Ø§Ø±Ø¯ ÛŒØ§ Ø¨Ù‡ Ø¢Ù† Ø§Ø±Ø¬Ø§Ø¹ ' +
                    'Ù…ÛŒâ€ŒØ¯Ù‡Ø¯ (Ù…Ø«Ù„Ø§Ù‹ Â«Ù‡Ù…ÙˆÙ† ÙØ§ÛŒÙ„ÛŒ Ú©Ù‡ Ù‚Ø¨Ù„Ø§Ù‹ ÙØ±Ø³ØªØ§Ø¯Ù… Ø±Ùˆ ÙˆÛŒØ±Ø§ÛŒØ´ Ú©Ù†Â» ÛŒØ§ Â«ØªÙˆÛŒ Ø§ÙˆÙ† ÙØ§ÛŒÙ„ Ø¯Ù†Ø¨Ø§Ù„ X ' +
                    'Ø¨Ú¯Ø±Ø¯Â») - Ù†Ù‡ ØµØ±ÙØ§Ù‹ ÙˆÙ‚ØªÛŒ Ø§Ø³Ù… ÙØ§ÛŒÙ„ ÛŒÚ©â€ŒØ¨Ø§Ø± Ø¯Ø± Ú¯ÙØªÚ¯Ùˆ Ø°Ú©Ø± Ø´Ø¯Ù‡. Ø§Ø³Ù… ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ù…ÙˆØ¬ÙˆØ¯ Ø¯Ø± Ø¢Ø±Ø´ÛŒÙˆ ' +
                    'Ø§ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ø¯Ø± Ù¾Ø±Ø§Ù…Ù¾Øª Ø³ÛŒØ³ØªÙ… Ø¨Ù‡ ØªÙˆ Ø¯Ø§Ø¯Ù‡ Ø´Ø¯Ù‡ Ø§Ø³Øª. Ø§Ú¯Ø± Ù‡Ø¯Ù Ú©Ø§Ø±Ø¨Ø± ÙˆÛŒØ±Ø§ÛŒØ´ Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø§Ø³ØªØŒ ' +
                    'Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø®ÙˆØ¯Ø´ ÙØ§ÛŒÙ„ Ø±Ø§ Ø¨Ø±Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ¹Ø§Ù„ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ùˆ Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ Ø¢Ù† Ø±Ø§ Ø¯Ø± Ù†ØªÛŒØ¬Ù‡ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯ - ' +
                    'Ø¨Ø¹Ø¯ Ø§Ø² Ø¢Ù† Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ø·Ø¨Ù‚ Ù‡Ù…Ø§Ù† Ù‚ÙˆØ§Ù†ÛŒÙ† ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„ (apply_edit Ø¨Ø§ search/replace) Ú©Ù‡ Ø¨Ø±Ø§ÛŒ ' +
                    'ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ØªØ§Ø²Ù‡â€ŒØ¶Ù…ÛŒÙ…Ù‡â€ŒØ´Ø¯Ù‡ Ø¯Ø§Ø±ÛŒ Ø¹Ù…Ù„ Ú©Ù†.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Ù†Ø§Ù… Ø¯Ù‚ÛŒÙ‚ ÙØ§ÛŒÙ„ÛŒ Ú©Ù‡ Ù…Ø­ØªÙˆØ§ÛŒØ´ Ù„Ø§Ø²Ù… Ø§Ø³Øª (Ø¨Ø§ÛŒØ¯ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ø¨Ø§ ÛŒÚ©ÛŒ Ø§Ø² Ù†Ø§Ù…â€ŒÙ‡Ø§ÛŒ Ø¢Ø±Ø´ÛŒÙˆ Ù…Ø·Ø§Ø¨Ù‚Øª Ø¯Ø§Ø´ØªÙ‡ Ø¨Ø§Ø´Ø¯).'
                        }
                    },
                    required: ['name']
                }
            },
            {
                name: 'ask_user',
                description:
                    'ÙˆÙ‚ØªÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©Ø§Ø±Ø¨Ø± Ø´Ø§Ù…Ù„ ÛŒÚ© ØªØºÛŒÛŒØ± Ø§Ø³Ø§Ø³ÛŒ/ØºÛŒØ±Ù‚Ø§Ø¨Ù„â€ŒØ¨Ø±Ú¯Ø´Øª Ø§Ø³Øª (Ù…Ø«Ù„Ø§Ù‹ Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ú©Ø§Ù…Ù„ ' +
                    'ÛŒÚ© ÙØ§ÛŒÙ„ØŒ Ø­Ø°Ù Ø¨Ø®Ø´ Ø¨Ø²Ø±Ú¯ÛŒ Ø§Ø² Ú©Ø¯ ÛŒØ§ Ø¯Ø§Ø¯Ù‡ØŒ ÛŒØ§ ØªØµÙ…ÛŒÙ…ÛŒ Ú©Ù‡ Ú†Ù†Ø¯ Ø±Ø§Ù‡â€ŒØ­Ù„ Ù…Ø¹Ù‚ÙˆÙ„ Ùˆ Ù…ØªÙØ§ÙˆØª Ø¯Ø§Ø±Ø¯)ØŒ ' +
                    'Ù‚Ø¨Ù„ Ø§Ø² Ø§Ù†Ø¬Ø§Ù… Ú©Ø§Ø± Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù† Ùˆ Ø§Ø² Ú©Ø§Ø±Ø¨Ø± ØªØ£ÛŒÛŒØ¯ ÛŒØ§ Ø§Ù†ØªØ®Ø§Ø¨ Ø¨Ø®ÙˆØ§Ù‡. Ø¨Ø±Ø§ÛŒ Ø³Ø¤Ø§Ù„Ø§Øª ' +
                    'Ø³Ø§Ø¯Ù‡ ÛŒØ§ Ú©Ø§Ø±Ù‡Ø§ÛŒ Ú©Ù…â€ŒØ±ÛŒØ³Ú© Ø§Ø² Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù†Ú©Ù† - ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ ØªØµÙ…ÛŒÙ…â€ŒÙ‡Ø§ÛŒ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ù…Ù‡Ù….',
                parameters: {
                    type: 'object',
                    properties: {
                        question: {
                            type: 'string',
                            description: 'Ø³Ø¤Ø§Ù„ Ø¯Ù‚ÛŒÙ‚ Ùˆ Ú©ÙˆØªØ§Ù‡ Ú©Ù‡ Ø§Ø² Ú©Ø§Ø±Ø¨Ø± Ø¨Ø§ÛŒØ¯ Ù¾Ø±Ø³ÛŒØ¯Ù‡ Ø´ÙˆØ¯.'
                        }
                    },
                    required: ['question']
                }
            },
            {
                // Ø§Ú¯Ø± ÙØ§ÛŒÙ„ Ø®ÛŒÙ„ÛŒ Ø¨Ø²Ø±Ú¯ Ø¨Ø§Ø´Ø¯ Ùˆ Ù…Ø¯Ù„ Ù‚Ø¨Ù„ Ø§Ø² Ù†ÙˆØ´ØªÙ† search Ù†ÛŒØ§Ø² Ø¨Ù‡
                // Ø¯ÛŒØ¯Ù† Ø¯Ù‚ÛŒÙ‚ ÛŒÚ© Ø¨Ø®Ø´ Ø®Ø§Øµ Ø¯Ø§Ø´ØªÙ‡ Ø¨Ø§Ø´Ø¯ (Ù…Ø«Ù„Ø§Ù‹ Ø¨Ø±Ø§ÛŒ Ú©Ù¾ÛŒ Ø¯Ù‚ÛŒÙ‚
                // ØªÙˆØ±ÙØªÚ¯ÛŒ/ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ)ØŒ Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± ÛŒÚ© Ø¨Ø§Ø²Ù‡â€ŒÛŒ Ø®Ø· Ù…Ø´Ø®Øµ Ø±Ø§
                // Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯. Ø§Ú©Ø«Ø± ÙˆÛŒØ±Ø§ÛŒØ´â€ŒÙ‡Ø§ Ø¨Ù‡ Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ù†ÛŒØ§Ø² Ù†Ø¯Ø§Ø±Ù†Ø¯ Ú†ÙˆÙ†
                // Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„ Ùˆ ØªØ­Ù„ÛŒÙ„ Ø³Ø§Ø®ØªØ§Ø± Ø¢Ù† Ø§Ø² Ù‚Ø¨Ù„ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ Ù…Ø¯Ù„ Ø§Ø³Øª.
                name: 'read_file_section',
                description:
                    'Ø¨Ø®Ø´ÛŒ Ø§Ø² Ù…Ø­ØªÙˆØ§ÛŒ ÙØ§ÛŒÙ„ Ø±Ø§ Ø¨ÛŒÙ† Ø¯Ùˆ Ø´Ù…Ø§Ø±Ù‡ Ø®Ø· Ù…Ø´Ø®Øµ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯. ÙÙ‚Ø· Ø²Ù…Ø§Ù†ÛŒ Ø§Ø² Ø§ÛŒÙ† Ø§Ø³ØªÙØ§Ø¯Ù‡ ' +
                    'Ú©Ù† Ú©Ù‡ Ø¨Ø±Ø§ÛŒ Ù†ÙˆØ´ØªÙ† ÛŒÚ© search Ø¯Ù‚ÛŒÙ‚ (Ú©Ø§Ø±Ø§Ú©ØªØ±â€ŒØ¨Ù‡â€ŒÚ©Ø§Ø±Ø§Ú©ØªØ±) Ù†ÛŒØ§Ø² Ø¨Ù‡ Ø¯ÛŒØ¯Ù† Ø¯ÙˆØ¨Ø§Ø±Ù‡â€ŒÛŒ Ù…ØªÙ† ' +
                    'ÙˆØ§Ù‚Ø¹ÛŒ ÛŒÚ© Ø¨Ø®Ø´ Ø®Ø§Øµ Ø¯Ø§Ø±ÛŒ - Ù…Ø«Ù„Ø§Ù‹ Ø¨Ø±Ø§ÛŒ Ø§Ø·Ù…ÛŒÙ†Ø§Ù† Ø§Ø² ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ/ØªÙˆØ±ÙØªÚ¯ÛŒ Ø¯Ù‚ÛŒÙ‚. Ø§Ú©Ø«Ø± ' +
                    'ÙˆÛŒØ±Ø§ÛŒØ´â€ŒÙ‡Ø§ Ø¨Ù‡ Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ù†ÛŒØ§Ø² Ù†Ø¯Ø§Ø±Ù†Ø¯ Ú†ÙˆÙ† Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„ Ø§Ø² Ù‚Ø¨Ù„ Ø¯Ø± Ù¾ÛŒØ§Ù… Ø§ÙˆÙ„ÛŒÙ‡ Ø¨Ù‡ ØªÙˆ Ø¯Ø§Ø¯Ù‡ Ø´Ø¯Ù‡.',
                parameters: {
                    type: 'object',
                    properties: {
                        file: { type: 'string', description: 'Ù†Ø§Ù… Ø¯Ù‚ÛŒÙ‚ ÙØ§ÛŒÙ„ Ù‡Ø¯Ù.' },
                        startLine: { type: 'number', description: 'Ø´Ù…Ø§Ø±Ù‡ Ø®Ø· Ø´Ø±ÙˆØ¹ (Ø§Ø² Û±).' },
                        endLine: { type: 'number', description: 'Ø´Ù…Ø§Ø±Ù‡ Ø®Ø· Ù¾Ø§ÛŒØ§Ù† (Ø´Ø§Ù…Ù„ Ø®ÙˆØ¯Ø´).' }
                    },
                    required: ['file', 'startLine', 'endLine']
                }
            },
            {
                // Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ú©Ø§Ù…Ù„ write_block/apply_patch Ù‚Ø¯ÛŒÙ…ÛŒ: Ù…Ø¯Ù„ Ù…Ø³ØªÙ‚ÛŒÙ…Ø§Ù‹
                // ÛŒÚ© Ù‚Ø·Ø¹Ù‡â€ŒÛŒ Ø¯Ù‚ÛŒÙ‚ Ù…ØªÙ† Ù…ÙˆØ¬ÙˆØ¯ (search) Ùˆ Ù…ØªÙ† Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† (replace)
                // Ù…ÛŒâ€ŒØ¯Ù‡Ø¯ - Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù…Ø«Ù„ SEARCH/REPLACE Ø¯Ø± Aider. Ù…ÙˆØªÙˆØ± Û´ Ù„Ø§ÛŒÙ‡
                // fallback (ØªØ·Ø¨ÛŒÙ‚ Ø¯Ù‚ÛŒÙ‚ â†’ whitespace-flexible â†’ fuzzy â†’ Ú¯Ø²Ø§Ø±Ø´
                // Ø®Ø·Ø§ÛŒ Ø¯Ù‚ÛŒÙ‚) Ø±Ø§ Ø§Ù…ØªØ­Ø§Ù† Ù…ÛŒâ€ŒÚ©Ù†Ø¯. Ù‚Ø¨Ù„ Ø§Ø² Ù¾Ø°ÛŒØ±ÙØªÙ†ØŒ ÙØ§ÛŒÙ„ Ú©Ø§Ù…Ù„
                // (Ø¨Ø¹Ø¯ Ø§Ø² Ø§Ø¹Ù…Ø§Ù„ ØªØºÛŒÛŒØ±) Ø§Ø² validatePatchedContent Ø±Ø¯ Ù…ÛŒâ€ŒØ´ÙˆØ¯.
                name: 'apply_edit',
                description:
                    'ÛŒÚ© Ù‚Ø·Ø¹Ù‡â€ŒÛŒ Ù…ØªÙ† Ø¯Ù‚ÛŒÙ‚ Ù…ÙˆØ¬ÙˆØ¯ Ø¯Ø± ÙØ§ÛŒÙ„ (search) Ø±Ø§ Ø¨Ø§ Ù…ØªÙ† Ø¬Ø¯ÛŒØ¯ (replace) Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ù…ÛŒâ€ŒÚ©Ù†Ø¯. ' +
                    'search Ø¨Ø§ÛŒØ¯ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù‡Ù…Ø§Ù† Ù…ØªÙ†ÛŒ Ø¨Ø§Ø´Ø¯ Ú©Ù‡ Ø§Ù„Ø§Ù† Ø¯Ø± ÙØ§ÛŒÙ„ Ù‡Ø³Øª (Ø§Ø² Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„ Ú©Ù‡ Ø¯Ø± ' +
                    'Ù¾ÛŒØ§Ù… Ø§ÙˆÙ„ÛŒÙ‡ Ø¯Ø§Ø±ÛŒ Ú©Ù¾ÛŒ Ú©Ù†) - Ø´Ø§Ù…Ù„ Ú†Ù†Ø¯ Ø®Ø· Ø§Ø·Ø±Ø§Ù ØªØºÛŒÛŒØ± Ø¨Ø±Ø§ÛŒ ÛŒÚ©ØªØ§ Ø¨ÙˆØ¯Ù†ØŒ Ù†Ù‡ ÙÙ‚Ø· ÛŒÚ© Ø®Ø· ' +
                    'Ú©ÙˆØªØ§Ù‡ Ú©Ù‡ Ù…Ù…Ú©Ù† Ø§Ø³Øª Ú†Ù†Ø¯Ø¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„ ØªÚ©Ø±Ø§Ø± Ø´Ø¯Ù‡ Ø¨Ø§Ø´Ø¯. replace Ø¨Ø§ÛŒØ¯ Ù…ØªÙ† Ù†Ù‡Ø§ÛŒÛŒ Ù‡Ù…Ø§Ù† Ø¨Ø®Ø´ ' +
                    'Ø¨Ø§Ø´Ø¯ (Ø®Ø·ÙˆØ·ÛŒ Ú©Ù‡ Ø¨Ø§ÛŒØ¯ Ø¨Ù…Ø§Ù†Ù†Ø¯ Ø±Ø§ Ù‡Ù… Ø§Ú¯Ø± Ø¯Ø§Ø®Ù„ Ø¨Ø§Ø²Ù‡â€ŒÛŒ search Ù‡Ø³ØªÙ†Ø¯ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø¯Ø± replace ' +
                    'Ø¨Ù†ÙˆÛŒØ³). Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø®ÙˆØ¯Ø´ Ú©Ù…ÛŒ Ø§Ù†Ø¹Ø·Ø§Ù Ø¯Ø± ÙØ§ØµÙ„Ù‡â€ŒÚ¯Ø°Ø§Ø±ÛŒ/ØªÙˆØ±ÙØªÚ¯ÛŒ Ø¯Ø§Ø±Ø¯ Ùˆ Ø§Ú¯Ø± search Ø¯Ù‚ÛŒÙ‚ ' +
                    'Ù¾ÛŒØ¯Ø§ Ù†Ø´ÙˆØ¯ Ú†Ù†Ø¯ Ù„Ø§ÛŒÙ‡ ØªØ·Ø¨ÛŒÙ‚ Ù†Ø±Ù…â€ŒØªØ± Ø±Ø§ Ù‡Ù… Ø§Ù…ØªØ­Ø§Ù† Ù…ÛŒâ€ŒÚ©Ù†Ø¯ØŒ Ø§Ù…Ø§ Ø§Ú¯Ø± Ø¨Ø§Ø² Ù‡Ù… Ø´Ú©Ø³Øª Ø®ÙˆØ±Ø¯ ÛŒØ§ ' +
                    'Ù…Ø¨Ù‡Ù… Ø¨ÙˆØ¯ (Ø¨ÛŒØ´ Ø§Ø² ÛŒÚ©â€ŒØ¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„ Ù¾ÛŒØ¯Ø§ Ø´Ø¯)ØŒ ÛŒÚ© Ú¯Ø²Ø§Ø±Ø´ Ø¯Ù‚ÛŒÙ‚ Ø¨Ø§ Ù†Ø²Ø¯ÛŒÚ©â€ŒØªØ±ÛŒÙ† context Ù‡Ø§ÛŒ ' +
                    'ÙˆØ§Ù‚Ø¹ÛŒ ÙØ§ÛŒÙ„ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯ - search Ø±Ø§ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ø§Ø² Ù‡Ù…Ø§Ù† context Ú©Ù¾ÛŒ Ú©Ù† Ùˆ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØµØ¯Ø§ Ø¨Ø²Ù†. ' +
                    'Ø¨Ø±Ø§ÛŒ Ø­Ø°Ù ÛŒÚ© Ø¨Ø®Ø´ØŒ replace Ø±Ø§ Ø±Ø´ØªÙ‡â€ŒÛŒ Ø®Ø§Ù„ÛŒ Ø¨Ø¯Ù‡. Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø®ÙˆØ¯Ø´ Ø¨Ø¹Ø¯ Ø§Ø² Ù†ÙˆØ´ØªÙ†ØŒ ÙØ§ÛŒÙ„ ' +
                    'Ú©Ø§Ù…Ù„ Ø±Ø§ Ø§Ø¹ØªØ¨Ø§Ø±Ø³Ù†Ø¬ÛŒ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ùˆ Ù†ØªÛŒØ¬Ù‡ Ø±Ø§ Ø¯Ø± ÙÛŒÙ„Ø¯ valid Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯ - Ø§Ú¯Ø± Ø§ÛŒÙ† Ø¢Ø®Ø±ÛŒÙ† ' +
                    'ØªØºÛŒÛŒØ±ÛŒ Ø¨ÙˆØ¯ Ú©Ù‡ Ù†ÛŒØ§Ø² Ø¯Ø§Ø´ØªÛŒ Ùˆ valid:true Ø¨Ø±Ú¯Ø´ØªØŒ Ø¯ÛŒÚ¯Ø± Ù†ÛŒØ§Ø²ÛŒ Ø¨Ù‡ verify_file Ø¬Ø¯Ø§Ú¯Ø§Ù†Ù‡ ' +
                    'Ù†ÛŒØ³Øª Ùˆ Ù…ÛŒâ€ŒØªÙˆØ§Ù†ÛŒ Ù…Ø³ØªÙ‚ÛŒÙ… Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø±Ø§ Ø¨Ø¯Ù‡ÛŒ.',
                parameters: {
                    type: 'object',
                    properties: {
                        file: { type: 'string', description: 'Ù†Ø§Ù… Ø¯Ù‚ÛŒÙ‚ ÙØ§ÛŒÙ„ Ù‡Ø¯Ù.' },
                        search: { type: 'string', description: 'Ù…ØªÙ† Ø¯Ù‚ÛŒÙ‚ Ù…ÙˆØ¬ÙˆØ¯ Ø¯Ø± ÙØ§ÛŒÙ„ Ú©Ù‡ Ø¨Ø§ÛŒØ¯ Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ø´ÙˆØ¯ (Ú†Ù†Ø¯ Ø®Ø· Ø¨Ø±Ø§ÛŒ ÛŒÚ©ØªØ§ Ø¨ÙˆØ¯Ù†).' },
                        replace: { type: 'string', description: 'Ù…ØªÙ† Ø¬Ø¯ÛŒØ¯ÛŒ Ú©Ù‡ Ø¨Ø§ÛŒØ¯ Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† search Ø´ÙˆØ¯ (Ø¨Ø±Ø§ÛŒ Ø­Ø°ÙØŒ Ø±Ø´ØªÙ‡â€ŒÛŒ Ø®Ø§Ù„ÛŒ).' },
                        occurrence: { type: 'number', description: 'Ø§Ø®ØªÛŒØ§Ø±ÛŒ - Ø§Ú¯Ø± search Ø¨ÛŒØ´ Ø§Ø² ÛŒÚ©â€ŒØ¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„ ØªÚ©Ø±Ø§Ø± Ø´Ø¯Ù‡ Ùˆ Ø¹Ù…Ø¯Ø§Ù‹ Ù‡Ù…Ù‡ ÛŒÚ©Ø³Ø§Ù†â€ŒØ§Ù†Ø¯ØŒ Ø´Ù…Ø§Ø±Ù‡â€ŒÛŒ Ù†Ù…ÙˆÙ†Ù‡â€ŒÛŒ Ù…ÙˆØ±Ø¯Ù†Ø¸Ø± (Ø§Ø² Û± Ø´Ø±ÙˆØ¹) Ø±Ø§ Ø¨Ø¯Ù‡.' }
                    },
                    required: ['file', 'search', 'replace']
                }
            },
            {
                // Ø¨Ø±Ø±Ø³ÛŒ Ù†Ù‡Ø§ÛŒÛŒ Ø§Ø¬Ø¨Ø§Ø±ÛŒ: ÙØ§ÛŒÙ„ Ú©Ø§Ù…Ù„ (Ø¨Ø§ ØªÙ…Ø§Ù… Ø¨Ù„ÙˆÚ©â€ŒÙ‡Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´â€ŒØ´Ø¯Ù‡)
                // Ø±Ø§ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯ Ùˆ Ø§Ø² Ù‡Ù…Ø§Ù† Ú†Ú© Ø³Ø§Ø®ØªØ§Ø±ÛŒ validatePatchedContent
                // (Ø¨Ø§Ù„Ø§Ù†Ø³ ØªÚ¯/Ø¨Ø±Ø§Ú©ØªØŒ Ø³Ù†ØªÚ©Ø³ JS) Ø±Ø¯ Ù…ÛŒâ€ŒÚ©Ù†Ø¯. runAgentLoop Ù…Ø¯Ù„ Ø±Ø§
                // Ù…Ø¬Ø¨ÙˆØ± Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ø§ÛŒÙ† Ø±Ø§ Ø¨Ø¹Ø¯ Ø§Ø² Ø¢Ø®Ø±ÛŒÙ† write_block ØµØ¯Ø§ Ø¨Ø²Ù†Ø¯ Ùˆ
                // Ù¾Ø§Ø³ Ú©Ù†Ø¯ØŒ Ù‚Ø¨Ù„ Ø§Ø² Ø§ÛŒÙ†â€ŒÚ©Ù‡ Ø¬ÙˆØ§Ø¨ Ù†Ù‡Ø§ÛŒÛŒ (Ø¨Ø¯ÙˆÙ† tool call) Ù¾Ø°ÛŒØ±ÙØªÙ‡
                // Ø´ÙˆØ¯.
                name: 'verify_file',
                description:
                    'ÙØ§ÛŒÙ„ Ú©Ø§Ù…Ù„ Ø±Ø§ (Ø¨Ø§ ØªÙ…Ø§Ù… ÙˆÛŒØ±Ø§ÛŒØ´â€ŒÙ‡Ø§ÛŒ Ø§Ø¹Ù…Ø§Ù„â€ŒØ´Ø¯Ù‡ ØªØ§ Ø§ÛŒÙ† Ù„Ø­Ø¸Ù‡) Ø§Ø² Ù†Ø¸Ø± Ø³Ø§Ø®ØªØ§Ø±ÛŒ/Ø³Ù†ØªÚ©Ø³ÛŒ ' +
                    'Ø¨Ø±Ø±Ø³ÛŒ Ù…ÛŒâ€ŒÚ©Ù†Ø¯. Ø¨Ø§ÛŒØ¯ Ø­ØªÙ…Ø§Ù‹ Ø¨Ø¹Ø¯ Ø§Ø² Ø¢Ø®Ø±ÛŒÙ† apply_edit Ùˆ Ù‚Ø¨Ù„ Ø§Ø² ØªØ­ÙˆÛŒÙ„ Ù†Ù‡Ø§ÛŒÛŒ ØµØ¯Ø§ Ø²Ø¯Ù‡ ' +
                    'Ø´ÙˆØ¯. Ø§Ú¯Ø± Ù…Ø´Ú©Ù„ Ù¾ÛŒØ¯Ø§ Ú©Ù†Ø¯ØŒ Ø¨Ø§ apply_edit Ø¯ÛŒÚ¯Ø±ÛŒ Ø¨Ø®Ø´ Ù…Ø´Ú©Ù„â€ŒØ¯Ø§Ø± Ø±Ø§ Ø§ØµÙ„Ø§Ø­ Ú©Ù†ØŒ Ø³Ù¾Ø³ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ' +
                    'verify_file Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†.',
                parameters: {
                    type: 'object',
                    properties: {
                        file: {
                            type: 'string',
                            description: 'Ù†Ø§Ù… Ø¯Ù‚ÛŒÙ‚ ÙØ§ÛŒÙ„ÛŒ Ú©Ù‡ Ø¨Ø§ÛŒØ¯ Ù†Ù‡Ø§ÛŒÛŒâ€ŒØ³Ø§Ø²ÛŒ Ùˆ Ø¨Ø±Ø±Ø³ÛŒ Ø´ÙˆØ¯.'
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
        return (args && args.reason) || `Ø¯Ø§Ø±Ù… Ø¯Ø±Ø¨Ø§Ø±Ù‡â€ŒÛŒ Â«${(args && args.query) || ''}Â» ØªÙˆÛŒ ÙˆØ¨ Ø³Ø±Ú† Ù…ÛŒâ€ŒÚ©Ù†Ù…...`;
    }
    if (name === 'ask_user') {
        return 'Ù‚Ø¨Ù„ Ø§Ø² Ø§Ø¯Ø§Ù…Ù‡ØŒ ÛŒÙ‡ Ø³Ø¤Ø§Ù„ Ø¯Ø§Ø±Ù…...';
    }
    if (name === 'read_file_section') {
        return `Ø¯Ø± Ø­Ø§Ù„ Ø®ÙˆØ§Ù†Ø¯Ù† Ø¨Ø®Ø´ÛŒ Ø§Ø² ÙØ§ÛŒÙ„ Â«${(args && args.file) || ''}Â»...`;
    }
    if (name === 'apply_edit') {
        return `Ø¯Ø± Ø­Ø§Ù„ Ø§Ø¹Ù…Ø§Ù„ ØªØºÛŒÛŒØ±Ø§Øª Ø±ÙˆÛŒ ÙØ§ÛŒÙ„ Â«${(args && args.file) || ''}Â»...`;
    }
    if (name === 'verify_file') {
        return `Ø¯Ø± Ø­Ø§Ù„ Ø¨Ø±Ø±Ø³ÛŒ Ù†Ù‡Ø§ÛŒÛŒ ÙØ§ÛŒÙ„ Â«${(args && args.file) || ''}Â»...`;
    }
    if (name === 'get_archived_file') {
        return `Ø¯Ø§Ø±Ù… ÙØ§ÛŒÙ„ Â«${(args && args.name) || ''}Â» Ø±Ùˆ Ø§Ø² Ø¢Ø±Ø´ÛŒÙˆ Ø§ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ù…ÛŒâ€ŒØ®ÙˆÙ†Ù…...`;
    }
    return 'Ø¯Ø± Ø­Ø§Ù„ Ø§Ù†Ø¬Ø§Ù… ÛŒÚ© Ù…Ø±Ø­Ù„Ù‡...';
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
            return { valid: false, reason: `Ø³Ù†ØªÚ©Ø³ Ø¬Ø§ÙˆØ§Ø§Ø³Ú©Ø±ÛŒÙ¾Øª Ø¨Ø¹Ø¯ Ø§Ø² Ø§ÛŒÙ† ØªØºÛŒÛŒØ± Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ù…ÛŒâ€ŒØ´ÙˆØ¯: ${error?.message || error}` };
        }
    }
    if (language === 'html') {
        // FIX (Ø¨Ø§Ú¯ Ø±ÛŒØ´Ù‡â€ŒØ§ÛŒ: </g> Ø¯Ø± ÙˆØ³Ø· ÛŒÚ© regex Ø¬Ø§ÙˆØ§Ø§Ø³Ú©Ø±ÛŒÙ¾Øª Ù…Ø«Ù„
        // .replace(/</g, '&lt;') Ø¨Ù‡â€ŒØ¹Ù†ÙˆØ§Ù† ØªÚ¯ HTML Ø¨Ø³ØªÙ‡â€ŒÛŒ Ù†Ø§Ù…ØªÙ†Ø§Ø¸Ø± Ø±Ø¯
        // Ù…ÛŒâ€ŒØ´Ø¯): ØªÚ¯â€ŒÙ…Ø§Ú†ÛŒÙ†Ú¯ Ø²ÛŒØ± ÛŒÚ© regex Ø³Ø§Ø¯Ù‡ Ø±ÙˆÛŒ Ú©Ù„ Ù…ØªÙ† Ø§Ø³Øª Ùˆ Ù†Ù…ÛŒâ€ŒØ¯Ø§Ù†Ø¯ Ú©Ø¬Ø§
        // Ø¯Ø§Ø®Ù„ <script>/<style> Ø§Ø³Øª - ÛŒØ¹Ù†ÛŒ Ù‡Ø± Ú©Ø§Ø±Ø§Ú©ØªØ± < Ø¯Ø§Ø®Ù„ Ø¬Ø§ÙˆØ§Ø§Ø³Ú©Ø±ÛŒÙ¾Øª
        // (Ú†Ù‡ Ø¯Ø± regex literalØŒ Ú†Ù‡ Ø¯Ø± Ø±Ø´ØªÙ‡ØŒ Ú†Ù‡ Ø¯Ø± Ú©Ø§Ù…Ù†Øª) Ø±Ø§ Ø¨Ø§ ÛŒÚ© ØªÚ¯ HTML
        // ÙˆØ§Ù‚Ø¹ÛŒ Ø§Ø´ØªØ¨Ø§Ù‡ Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ø¯. Ø±Ø§Ù‡â€ŒØ­Ù„: Ù‚Ø¨Ù„ Ø§Ø² ØªÚ¯â€ŒÙ…Ø§Ú†ÛŒÙ†Ú¯ØŒ Ù…Ø­ØªÙˆØ§ÛŒ Ø¯Ø§Ø®Ù„ Ù‡Ø±
        // <script>...</script> Ùˆ <style>...</style> (Ø®ÙˆØ¯Ù ØªÚ¯ Ø¨Ø§Ø²/Ø¨Ø³ØªÙ‡ Ø­ÙØ¸
        // Ù…ÛŒâ€ŒØ´ÙˆØ¯ØŒ ÙÙ‚Ø· Ù…Ø­ØªÙˆØ§ÛŒ Ø¯Ø§Ø®Ù„ÛŒ Ø®Ù†Ø«ÛŒ/Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ù…ÛŒâ€ŒØ´ÙˆØ¯) Ø¨Ø§ ÙØ§ØµÙ„Ù‡â€ŒÛŒ Ù‡Ù…â€ŒØ·ÙˆÙ„
        // (Ø¨Ø±Ø§ÛŒ Ø­ÙØ¸ Ø´Ù…Ø§Ø±Ù‡ Ø®Ø· Ø¯Ø± Ù¾ÛŒØ§Ù… Ø®Ø·Ø§) Ø®Ù†Ø«ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯ØŒ Ùˆ Ø¬Ø§ÙˆØ§Ø§Ø³Ú©Ø±ÛŒÙ¾Øª Ø¯Ø§Ø®Ù„ Ù‡Ø±
        // <script> Ø¬Ø¯Ø§ Ùˆ Ù…Ø³ØªÙ‚Ù„ Ø¨Ø§ validatePatchedContent Ù†ÙˆØ¹ javascript
        // (new Function) Ø¨Ø±Ø±Ø³ÛŒ Ù…ÛŒâ€ŒØ´ÙˆØ¯ - Ù†Ù‡ Ø¨Ø§ Ù¾Ø§Ø±Ø³Ø± ØªÚ¯ HTML.
        let scriptJsErrors = [];
        const neutralizedContent = content.replace(
            /<(script)\b([^>]*)>([\s\S]*?)<\/script>/gi,
            (full, tagName, attrs, inner) => {
                const isExternal = /\bsrc\s*=/i.test(attrs);
                const isNonJs = /\btype\s*=\s*["'](?!(?:text\/javascript|application\/javascript|module)["'])[^"']*["']/i.test(attrs);
                if (!isExternal && !isNonJs && inner.trim()) {
                    try {
                        new Function(inner);
                    } catch (error) {
                        scriptJsErrors.push(error?.message || String(error));
                    }
                }
                // Ø®Ù†Ø«ÛŒâ€ŒØ³Ø§Ø²ÛŒ: Ù‡Ø± Ú©Ø§Ø±Ø§Ú©ØªØ± ØºÛŒØ±Ø®Ø·â€ŒØ¬Ø¯ÛŒØ¯ Ø¨Ø§ ÙØ§ØµÙ„Ù‡ Ø¬Ø§ÛŒÚ¯Ø²ÛŒÙ† Ù…ÛŒâ€ŒØ´ÙˆØ¯ ØªØ§
                // Ø·ÙˆÙ„/Ø´Ù…Ø§Ø±Ù‡â€ŒØ®Ø· Ø¹ÙˆØ¶ Ù†Ø´ÙˆØ¯ ÙˆÙ„ÛŒ Ù‡ÛŒÚ† < ÛŒØ§ > Ø¯Ø§Ø®Ù„Ø´ Ø¨Ø±Ø§ÛŒ Ù¾Ø§Ø±Ø³Ø± HTML
                // Ø¨Ø§Ù‚ÛŒ Ù†Ù…Ø§Ù†Ø¯.
                const blanked = inner.replace(/[^\n]/g, ' ');
                return `<${tagName}${attrs}>${blanked}</script>`;
            }
        ).replace(
            /<(style)\b([^>]*)>([\s\S]*?)<\/style>/gi,
            (full, tagName, attrs, inner) => {
                const blanked = inner.replace(/[^\n]/g, ' ');
                return `<${tagName}${attrs}>${blanked}</style>`;
            }
        );
        if (scriptJsErrors.length > 0) {
            return { valid: false, reason: `Ø³Ù†ØªÚ©Ø³ Ø¬Ø§ÙˆØ§Ø§Ø³Ú©Ø±ÛŒÙ¾Øª Ø¯Ø§Ø®Ù„ ÛŒÚ© ØªÚ¯ <script> Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ø§Ø³Øª: ${scriptJsErrors[0]}` };
        }

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
        while ((m = tagRe.exec(neutralizedContent))) {
            const tag = m[1].toLowerCase();
            const isClosing = m[0][1] === '/';
            const isSelfClosing = m[2] === '/' || voidTags.has(tag);
            if (isClosing) {
                const idx = stack.lastIndexOf(tag);
                if (idx === -1) {
                    return { valid: false, reason: `ØªÚ¯ Ø¨Ø³ØªÙ‡â€ŒÛŒ Â«</${tag}>Â» Ø¨Ø¯ÙˆÙ† ØªÚ¯ Ø¨Ø§Ø² Ù…ØªÙ†Ø§Ø¸Ø± Ù¾ÛŒØ¯Ø§ Ø´Ø¯ - Ø§Ø­ØªÙ…Ø§Ù„Ø§Ù‹ Ù…Ø­Ø¯ÙˆØ¯Ù‡â€ŒÛŒ Ø®Ø· Ø§Ø´ØªØ¨Ø§Ù‡ Ø¨ÙˆØ¯Ù‡.` };
                }
                // Anything between idx and the top of the stack must be
                // implicitly-closable, or this is a real unclosed tag.
                const skipped = stack.slice(idx + 1);
                const realGap = skipped.find(t => !implicitlyClosableTags.has(t));
                if (realGap) {
                    return { valid: false, reason: `ØªÚ¯ Â«<${realGap}>Â» Ù‚Ø¨Ù„ Ø§Ø² Â«</${tag}>Â» Ø¨Ø³ØªÙ‡ Ù†Ø´Ø¯Ù‡ - Ø§Ø­ØªÙ…Ø§Ù„Ø§Ù‹ Ù…Ø­Ø¯ÙˆØ¯Ù‡â€ŒÛŒ Ø®Ø· Ø§Ø´ØªØ¨Ø§Ù‡ Ø¨ÙˆØ¯Ù‡.` };
                }
                stack.length = idx;
            } else if (!isSelfClosing) {
                stack.push(tag);
            }
        }
        const remaining = stack.filter(t => !implicitlyClosableTags.has(t));
        if (remaining.length > 0) {
            return { valid: false, reason: `ØªÚ¯(Ù‡Ø§ÛŒ) Ø¨Ø§Ø² Ø¨Ø¯ÙˆÙ† Ø¨Ø³ØªÙ‡ Ø´Ø¯Ù† Ø¨Ø§Ù‚ÛŒ Ù…Ø§Ù†Ø¯Ù‡: ${[...new Set(remaining)].slice(0, 5).join(', ')} - Ø§Ø­ØªÙ…Ø§Ù„Ø§Ù‹ Ù…Ø­Ø¯ÙˆØ¯Ù‡â€ŒÛŒ Ø®Ø· Ø§Ø´ØªØ¨Ø§Ù‡ Ø¨ÙˆØ¯Ù‡.` };
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
            return { error: `ÙØ§ÛŒÙ„ÛŒ Ø¨Ø§ Ù†Ø§Ù… Â«${fileName}Â» Ø¯Ø± Ø¢Ø±Ø´ÛŒÙˆ Ø§ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.` };
        }

        // FIX (Ù…Ø¯Ù„ Ø¨Ù‡â€ŒØ¬Ø§ÛŒ ÙØ§ÛŒÙ„ ØªØ§Ø²Ù‡â€ŒÛŒ Ø¶Ù…ÛŒÙ…Ù‡â€ŒØ´Ø¯Ù‡ØŒ Ù†Ø³Ø®Ù‡â€ŒÛŒ Ù‚Ø¯ÛŒÙ…ÛŒ Ø§Ø² Ø¢Ø±Ø´ÛŒÙˆ Ø±Ø§
        // ÙˆÛŒØ±Ø§ÛŒØ´ Ù…ÛŒâ€ŒÚ©Ø±Ø¯): ØªØ§ Ù¾ÛŒØ´ Ø§Ø² Ø§ÛŒÙ†ØŒ Ø¬Ù„ÙˆÚ¯ÛŒØ±ÛŒ Ø§Ø² Ø§ÛŒÙ† Ø§Ø´ØªØ¨Ø§Ù‡ ÙÙ‚Ø· ÛŒÚ© Ø¬Ù…Ù„Ù‡
        // Ø¯Ø± system prompt Ø¨ÙˆØ¯ ("Ø§Ú¯Ø± Ú©Ø§Ø±Ø¨Ø± Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… ÙØ§ÛŒÙ„ÛŒ Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ØŒ
        // get_archived_file Ø±Ø§ ØµØ¯Ø§ Ù†Ø²Ù†") - ÛŒÚ© Ø¯Ø³ØªÙˆØ± ØµØ±ÙØ§Ù‹ Ù…ØªÙ†ÛŒ Ú©Ù‡ Ù…Ø¯Ù„ Ø¨Ù‡
        // Ø±Ø§Ø­ØªÛŒ Ù†Ø§Ø¯ÛŒØ¯Ù‡ Ù…ÛŒâ€ŒÚ¯Ø±ÙØª (Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù‡Ù…ÛŒÙ† Ø§ØªÙØ§Ù‚ Ø¨Ø±Ø§ÛŒ Ú©Ø§Ø±Ø¨Ø± Ø§ÙØªØ§Ø¯: ÙØ§ÛŒÙ„
        // ÛµÛ°Û°Û°+ Ø®Ø·ÛŒÙ ØªØ§Ø²Ù‡ Ø¶Ù…ÛŒÙ…Ù‡ Ø´Ø¯Ù‡ Ø¨ÙˆØ¯ØŒ ÙˆÙ„ÛŒ Ù…Ø¯Ù„ Ø±ÙØª Ø³Ø±Ø§Øº get_archived_file
        // Ùˆ ÛŒÚ© Ù†Ø³Ø®Ù‡â€ŒÛŒ Ù‚Ø¯ÛŒÙ…ÛŒâ€ŒØªØ± Ùˆ Ù‡Ù…â€ŒÙ†Ø§Ù… Ø§Ø² Ø¢Ø±Ø´ÛŒÙˆ (Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± Ù‚Ø¨Ù„Ø§Ù‹ Ø¯Ø± Ù‡Ù…ÛŒÙ†
        // Ú¯ÙØªÚ¯Ùˆ ÙØ±Ø³ØªØ§Ø¯Ù‡ Ø¨ÙˆØ¯) Ø±Ø§ Ù¾ÛŒØ¯Ø§ Ú©Ø±Ø¯ Ùˆ Ø¢Ù† Ø±Ø§ ÙˆÛŒØ±Ø§ÛŒØ´ Ú©Ø±Ø¯ - Ù†ØªÛŒØ¬Ù‡ ÛŒÚ© ÙØ§ÛŒÙ„
        // Ø§Ø´ØªØ¨Ø§Ù‡ Ø§Ù…Ø§ "Ù…Ø¹ØªØ¨Ø±" Ø¨ÙˆØ¯ Ú©Ù‡ Ø¨Ø§ Ù…ÙˆÙÙ‚ÛŒØª Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± ØªØ­ÙˆÛŒÙ„ Ø¯Ø§Ø¯Ù‡ Ø´Ø¯.
        // Ø§ÛŒÙ†â€ŒØ¬Ø§ ÛŒÚ© Ù‚ÙÙ„ ÙÙ†ÛŒ ÙˆØ§Ù‚Ø¹ÛŒ Ù…ÛŒâ€ŒÚ¯Ø°Ø§Ø±ÛŒÙ…: Ø§Ú¯Ø± Ø¯Ø± Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… Ø­Ø¯Ø§Ù‚Ù„ ÛŒÚ© ÙØ§ÛŒÙ„
        // ØªØ§Ø²Ù‡â€ŒÛŒ Ù…ØªÙ†ÛŒ (ctx.textFiles) Ø¶Ù…ÛŒÙ…Ù‡ Ø´Ø¯Ù‡ØŒ ÙØ±Ø§Ø®ÙˆØ§Ù†ÛŒ get_archived_file
        // Ø±Ø§ Ú©Ù„Ø§Ù‹ Ø±Ø¯ Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ… Ùˆ Ø¨Ù‡ Ù…Ø¯Ù„ Ù…ÛŒâ€ŒÚ¯ÙˆÛŒÛŒÙ… Ø§Ø² Ù‡Ù…Ø§Ù† ÙØ§ÛŒÙ„ ØªØ§Ø²Ù‡ Ø§Ø³ØªÙØ§Ø¯Ù‡
        // Ú©Ù†Ø¯ - Ù…Ù‡Ù… Ù†ÛŒØ³Øª Ú†Ù‡ Ø§Ø³Ù…ÛŒ Ø®ÙˆØ§Ø³ØªÙ‡ØŒ Ú†ÙˆÙ† Ù‡ÛŒÚ† Ø³Ù†Ø§Ø±ÛŒÙˆÛŒ Ø¯Ø±Ø³ØªÛŒ ÙˆØ¬ÙˆØ¯ Ù†Ø¯Ø§Ø±Ø¯
        // Ú©Ù‡ Ø¨Ø§ ÙØ§ÛŒÙ„ ØªØ§Ø²Ù‡ Ø¯Ø± Ø¯Ø³ØªØŒ Ø±ÙØªÙ† Ø³Ø±Ø§Øº Ø¢Ø±Ø´ÛŒÙˆ ØµØ­ÛŒØ­ Ø¨Ø§Ø´Ø¯.
        const freshTextFiles = (ctx && ctx.originalFreshFileNames instanceof Set) ? [...ctx.originalFreshFileNames] : [];
        if (freshTextFiles.length > 0) {
            log.warn('agent.tool.get_archived_file.blocked_fresh_attachment_present', {
                requestedName: fileName,
                freshFileNames: freshTextFiles
            });
            return {
                error: `Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø±Ø¯ Ø´Ø¯: Ú©Ø§Ø±Ø¨Ø± Ø¯Ø± Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… ÙØ§ÛŒÙ„ Â«${freshTextFiles.join('ØŒ ')}Â» Ø±Ø§ ØªØ§Ø²Ù‡ Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ - Ø§ÛŒÙ† Ù‡Ù…Ø§Ù† ÙØ§ÛŒÙ„ÛŒ Ø§Ø³Øª Ú©Ù‡ Ø¨Ø§ÛŒØ¯ ÙˆÛŒØ±Ø§ÛŒØ´ Ø´ÙˆØ¯ØŒ Ù†Ù‡ Â«${fileName}Â» Ø§Ø² Ø¢Ø±Ø´ÛŒÙˆ. get_archived_file Ø±Ø§ Ø¯ÛŒÚ¯Ø± ØµØ¯Ø§ Ù†Ø²Ù†Ø› Ù…Ø³ØªÙ‚ÛŒÙ…Ø§Ù‹ Ø¨Ø§ apply_edit Ø±ÙˆÛŒ Ù‡Ù…Ø§Ù† ÙØ§ÛŒÙ„ ØªØ§Ø²Ù‡ (Ú©Ù‡ Ø¯Ø± Ø¨Ø®Ø´ ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÙØ¹Ù„ÛŒ Ù…ÙˆØ¬ÙˆØ¯ Ø§Ø³Øª) Ú©Ø§Ø± Ú©Ù†.`
            };
        }

        // FIX (archived-file edits silently produced no real edit / no
        // download card): get_archived_file used to just hand back a
        // (possibly truncated at 70k chars) text blob for the model to
        // read and then describe changes to in prose. It was never wired
        // into the block-map/read_block/write_block/verify_file system,
        // which only ever looked at `textFiles` (files attached fresh in
        // THIS message). So a request like "hide the scrollbars in the
        // file I sent earlier" - with no fresh attachment this turn -
        // had the model read a truncated archived copy, then just claim
        // success in text with nothing real to back it up: no write_block
        // ever ran, editedFiles stayed empty, no card ever reached the
        // client, even though the user's original file WAS genuinely
        // valid and the model wasn't lying about intent, just about
        // outcome.
        //
        // Fix: promote the archived file into the SAME live editing
        // system a freshly-attached file gets. We inject it into
        // ctx.textFiles (so write_block's `files.find(...)` lookup can
        // find it, exactly like a fresh attachment) and build/reuse its
        // FileEditState in ctx.editStates (so apply_edit/
        // verify_file work on it with full content - not the old 70k-char
        // truncation, which silently hid anything past that point, e.g.
        // CSS rules far down a large index.html). One archived file is
        // promoted per get_archived_file call, so cost only appears when
        // the model actually asks for it - never for archived files it
        // doesn't touch.
        const textFiles = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : null;
        const editStates = ctx && ctx.editStates;
        let alreadyPromoted = textFiles && textFiles.some(f => f && f.name === found.name);
        if (textFiles && editStates && !alreadyPromoted) {
            const promoted = { name: found.name, content: found.content || '', mode: 'text' };
            textFiles.push(promoted);
            if (!editStates.has(promoted.name)) {
                editStates.set(promoted.name, createFileEditState(promoted));
            }
            alreadyPromoted = true;
        }

        log.info('agent.tool.get_archived_file', {
            name: fileName,
            contentLen: (found.content || '').length,
            promotedToBlockEditing: alreadyPromoted
        });

        if (alreadyPromoted && editStates) {
            const state = editStates.get(found.name);
            return {
                name: found.name,
                promotedToBlockEditing: true,
                content: state ? state.content : (found.content || ''),
                note: 'Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø¢Ø±Ø´ÛŒÙˆØ´Ø¯Ù‡ Ø­Ø§Ù„Ø§ Ø¨Ø±Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ¹Ø§Ù„ Ø´Ø¯Ù‡ - Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ Ø¢Ù† (Ø¨Ø¯ÙˆÙ† Ø¨Ø±Ø´) Ø¨Ø§Ù„Ø§ Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†Ø¯Ù‡ Ø´Ø¯ØŒ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù…Ø«Ù„ ÙØ§ÛŒÙ„ÛŒ Ú©Ù‡ ØªØ§Ø²Ù‡ Ø¶Ù…ÛŒÙ…Ù‡ Ø´Ø¯Ù‡ Ø¨Ø§Ø´Ø¯. Ø§Ú¯Ø± Ú©Ø§Ø±Ø¨Ø± Ø®ÙˆØ§Ø³ØªÙ‡ Ø§ÛŒÙ† ÙØ§ÛŒÙ„ ÙˆÛŒØ±Ø§ÛŒØ´ Ø´ÙˆØ¯ØŒ Ø·Ø¨Ù‚ Ù‚ÙˆØ§Ù†ÛŒÙ† ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„ (apply_edit Ø¨Ø§ search/replace â†’ Ø¯Ø± ØµÙˆØ±Øª Ù„Ø²ÙˆÙ… verify_file) Ù¾ÛŒØ´ Ø¨Ø±Ùˆ. Ø§Ú¯Ø± ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ Ù…Ø·Ø§Ù„Ø¹Ù‡/Ù¾Ø§Ø³Ø® Ø¨Ù‡ Ø³Ø¤Ø§Ù„ Ù„Ø§Ø²Ù…Ø´ Ø¯Ø§Ø´ØªÛŒ (Ù†Ù‡ ÙˆÛŒØ±Ø§ÛŒØ´)ØŒ Ù‡Ù…ÛŒÙ† Ù…Ø­ØªÙˆØ§ Ø±Ø§ Ø¨Ø®ÙˆØ§Ù†.'
            };
        }

        // Fallback (should be rare: only if textFiles/editStates weren't
        // supplied to this call, e.g. some other caller path): keep the
        // old truncated-text behavior so nothing breaks, but this path no
        // longer supports real edits producing a download card.
        const MAX_ARCHIVED_FILE_CHARS = 70000;
        let content = found.content || '';
        let truncated = false;
        if (content.length > MAX_ARCHIVED_FILE_CHARS) {
            content = content.slice(0, MAX_ARCHIVED_FILE_CHARS);
            truncated = true;
        }

        let structureNote = '';
        try {
            const analysis = analyzeFileStructure(content, found.name || fileName, '');
            structureNote = `\n\n[ØªØ­Ù„ÛŒÙ„ Ø³Ø§Ø®ØªØ§Ø± Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø¢Ø±Ø´ÛŒÙˆØ´Ø¯Ù‡ - Ù‚Ø¨Ù„ Ø§Ø² ØªÙˆÙ„ÛŒØ¯ file-edit Ø§Ø² Ø¢Ù† Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†]\n${formatFileStructureForModel(analysis)}\n`;
        } catch (error) {
            log.warn('file.structure.archived_preanalysis_failed', {
                message: error?.message || String(error)
            });
        }

        return {
            name: found.name,
            content,
            ...(truncated ? {
                note: 'Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø®ÛŒÙ„ÛŒ Ø¨Ø²Ø±Ú¯ Ø¨ÙˆØ¯ Ùˆ ÙÙ‚Ø· Ø¨Ø®Ø´ Ø§Ø¨ØªØ¯Ø§ÛŒÛŒ Ø¢Ù† (Û·Û° Ù‡Ø²Ø§Ø± Ú©Ø§Ø±Ø§Ú©ØªØ± Ø§ÙˆÙ„) Ø¨Ø§Ø²Ú¯Ø±Ø¯Ø§Ù†Ø¯Ù‡ Ø´Ø¯. Ø§Ú¯Ø± Ø¨Ø®Ø´ Ø¯ÛŒÚ¯Ø±ÛŒ Ù„Ø§Ø²Ù… Ø§Ø³ØªØŒ Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± Ø¨Ú¯Ùˆ Ú©Ù‡ ÙØ§ÛŒÙ„ Ú©Ø§Ù…Ù„ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ Ù†ÛŒØ³Øª Ùˆ Ø¨Ø§ÛŒØ¯ Ø¨Ø®Ø´ Ø®Ø§ØµÛŒ Ø§Ø² Ø¢Ù† Ø±Ø§ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø¨ÙØ±Ø³ØªØ¯.'
            } : {}),
            ...(structureNote ? { structure: structureNote } : {})
        };
    }

    if (name === 'read_file_section') {
        const fileName = String((args && args.file) || '').trim();
        const startLine = Number(args && args.startLine);
        const endLine = Number(args && args.endLine);
        const files = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : [];
        const found = files.find(f => f && (f.name === fileName || String(f.name || '').split('/').pop() === fileName.split('/').pop()));
        if (!found) {
            return { error: `ÙØ§ÛŒÙ„ Â«${fileName}Â» Ø¯Ø± ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÙØ¹Ù„ÛŒ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.` };
        }
        const state = ctx && ctx.editStates && ctx.editStates.get(found.name || fileName);
        if (!state) {
            return { error: `ÙˆØ¶Ø¹ÛŒØª ÙˆÛŒØ±Ø§ÛŒØ´ Ø¨Ø±Ø§ÛŒ Â«${fileName}Â» Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯ - Ø§ÛŒÙ† Ù†Ø¨Ø§ÛŒØ¯ Ø±Ø® Ø¯Ù‡Ø¯.` };
        }
        if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
            return { error: 'startLine/endLine Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ø§Ø³Øª.' };
        }
        const lines = state.content.split(/\r?\n/);
        const clampedEnd = Math.min(endLine, lines.length);
        const content = lines.slice(startLine - 1, clampedEnd).join('\n');
        log.info('agent.tool.read_file_section', { name: state.name, startLine, endLine: clampedEnd });
        return { file: state.name, startLine, endLine: clampedEnd, totalLines: lines.length, content };
    }

    if (name === 'apply_edit') {
        const fileName = String((args && args.file) || '').trim();
        const search = String((args && args.search) ?? '');
        const replace = String((args && args.replace) ?? '');
        const occurrence = Number(args && args.occurrence);
        const files = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : [];
        const found = files.find(f => f && (f.name === fileName || String(f.name || '').split('/').pop() === fileName.split('/').pop()));
        if (!found) {
            return { success: false, error: `ÙØ§ÛŒÙ„ Â«${fileName}Â» Ø¯Ø± ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÙØ¹Ù„ÛŒ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.` };
        }
        const state = ctx && ctx.editStates && ctx.editStates.get(found.name || fileName);
        if (!state) {
            return { success: false, error: `ÙˆØ¶Ø¹ÛŒØª ÙˆÛŒØ±Ø§ÛŒØ´ Ø¨Ø±Ø§ÛŒ Â«${fileName}Â» Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯ - Ø§ÛŒÙ† Ù†Ø¨Ø§ÛŒØ¯ Ø±Ø® Ø¯Ù‡Ø¯.` };
        }

        const editResult = applySearchReplace(state.content, search, replace, Number.isFinite(occurrence) ? occurrence : undefined);
        if (!editResult.success) {
            log.warn('agent.tool.apply_edit.no_match', {
                name: state.name,
                reason: editResult.reason
            });
            return {
                success: false,
                error: editResult.reason === 'ambiguous' ? 'Ø§ÛŒÙ† search Ø¨ÛŒØ´ Ø§Ø² ÛŒÚ©â€ŒØ¨Ø§Ø± Ø¯Ø± ÙØ§ÛŒÙ„ Ù¾ÛŒØ¯Ø§ Ø´Ø¯ - Ù…Ø¨Ù‡Ù… Ø§Ø³Øª.' : 'Ø§ÛŒÙ† search Ø¯Ø± ÙØ§ÛŒÙ„ Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.',
                ...editResult.report
            };
        }

        const validation = validatePatchedContent(editResult.content, state.name);
        if (!validation.valid) {
            log.warn('agent.tool.apply_edit.rejected_invalid', {
                name: state.name,
                reason: validation.reason
            });
            // FIX (Ø§Ø¯Ø¹Ø§ÛŒ Ø¯Ø±ÙˆØºÛŒÙ† Ù…ÙˆÙÙ‚ÛŒØª): Ø§ÛŒÙ† Ø±Ø¯ Ø´Ø¯Ù† Ø±Ø§ Ø«Ø¨Øª Ú©Ù† ØªØ§ Ø§Ú¯Ø± Ù…Ø¯Ù„
            // Ø¨Ø¹Ø¯Ø§Ù‹ - Ø¨Ø¯ÙˆÙ† Ù‡ÛŒÚ† apply_edit Ù…ÙˆÙÙ‚ÛŒ Ø±ÙˆÛŒ Ø§ÛŒÙ† ÙØ§ÛŒÙ„ - Ù…ØªÙ† Ù†Ù‡Ø§ÛŒÛŒ
            // Ø±Ø§ Ø·ÙˆØ±ÛŒ Ø¨Ù†ÙˆÛŒØ³Ø¯ Ú©Ù‡ Ø§Ù†Ú¯Ø§Ø± ÙˆÛŒØ±Ø§ÛŒØ´ Ø§Ù†Ø¬Ø§Ù… Ø´Ø¯Ù‡ØŒ Ø¨ØªÙˆØ§Ù†ÛŒÙ… Ø§ÛŒÙ†
            // Ù†Ø§Ø³Ø§Ø²Ú¯Ø§Ø±ÛŒ Ø±Ø§ Ø¯Ø± Ù¾Ø§ÛŒØ§Ù† runAgentLoop ØªØ´Ø®ÛŒØµ Ø¯Ù‡ÛŒÙ… Ùˆ Ø¬Ù„ÙˆÛŒ Ø±ÙØªÙ†
            // Ù¾Ø§Ø³Ø® Ú¯Ù…Ø±Ø§Ù‡â€ŒÚ©Ù†Ù†Ø¯Ù‡ Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± Ø±Ø§ Ø¨Ú¯ÛŒØ±ÛŒÙ….
            if (ctx && ctx.rejectedWriteBlocksByFile) {
                const key = state.name;
                const prev = ctx.rejectedWriteBlocksByFile.get(key) || { count: 0, lastReason: null };
                ctx.rejectedWriteBlocksByFile.set(key, {
                    count: prev.count + 1,
                    lastReason: validation.reason
                });
            }
            return {
                success: false,
                error: `Ø§ÛŒÙ† ØªØºÛŒÛŒØ± Ø±Ø¯ Ø´Ø¯ Ú†ÙˆÙ† ÙØ§ÛŒÙ„ Ø±Ø§ Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ù…ÛŒâ€ŒÚ©Ù†Ø¯: ${validation.reason} search/replace Ø±Ø§ Ø§ØµÙ„Ø§Ø­ Ú©Ù† Ùˆ Ø¯ÙˆØ¨Ø§Ø±Ù‡ apply_edit Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†.`
            };
        }

        // Accept: commit new content, mark this file as edited.
        state.content = editResult.content;
        state.editCount += 1;
        state.verified = true; // validated the exact content now stored, same as before

        found.content = state.content;
        found._patched = true;
        found._editedName = found._editedName || nextEditedFileName(found.name || fileName);
        state.editedName = found._editedName;
        if (ctx && ctx.rejectedWriteBlocksByFile) {
            ctx.rejectedWriteBlocksByFile.delete(state.name);
        }

        log.info('agent.tool.apply_edit.success', {
            name: state.name,
            editedName: found._editedName,
            layer: editResult.layer,
            editCount: state.editCount
        });

        return {
            success: true,
            valid: true,
            file: state.name,
            editedName: found._editedName,
            note: 'ØªØºÛŒÛŒØ± Ø¨Ø§ Ù…ÙˆÙÙ‚ÛŒØª Ø§Ø¹Ù…Ø§Ù„ Ùˆ Ø¨Ø±Ø±Ø³ÛŒ Ø³Ø§Ø®ØªØ§Ø±ÛŒ Ø´Ø¯ (ÙØ§ÛŒÙ„ Ú©Ø§Ù…Ù„ Ø¨Ø§ Ø§ÛŒÙ† ØªØºÛŒÛŒØ± Ù…Ø¹ØªØ¨Ø± Ø§Ø³Øª). Ø§Ú¯Ø± Ø¨Ø®Ø´ Ø¯ÛŒÚ¯Ø±ÛŒ Ù‡Ù… Ù†ÛŒØ§Ø² Ø¨Ù‡ ØªØºÛŒÛŒØ± Ø¯Ø§Ø±Ø¯ØŒ apply_edit Ø¨Ø¹Ø¯ÛŒ Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†. Ø§Ú¯Ø± Ø§ÛŒÙ† Ø¢Ø®Ø±ÛŒÙ† ØªØºÛŒÛŒØ± Ø¨ÙˆØ¯ØŒ Ù…ÛŒâ€ŒØªÙˆØ§Ù†ÛŒ Ù…Ø³ØªÙ‚ÛŒÙ…Ø§Ù‹ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø±Ø§ Ø¨Ø¯Ù‡ÛŒ - Ù†ÛŒØ§Ø²ÛŒ Ø¨Ù‡ ØµØ¯Ø§ Ø²Ø¯Ù† verify_file Ø¬Ø¯Ø§Ú¯Ø§Ù†Ù‡ Ø¨Ø¹Ø¯ Ø§Ø² ÛŒÚ© apply_edit Ù…ÙˆÙÙ‚ Ù†ÛŒØ³ØªØŒ Ú†ÙˆÙ† Ø§ÛŒÙ† Ù†ØªÛŒØ¬Ù‡ (valid:true) Ø§Ø² Ù‚Ø¨Ù„ Ù…Ø¹Ø§Ø¯Ù„ Ø¢Ù† Ø§Ø³Øª.'
        };
    }

    if (name === 'verify_file') {
        const fileName = String((args && args.file) || '').trim();
        const files = (ctx && Array.isArray(ctx.textFiles)) ? ctx.textFiles : [];
        const found = files.find(f => f && (f.name === fileName || String(f.name || '').split('/').pop() === fileName.split('/').pop()));
        if (!found) {
            return { valid: false, error: `ÙØ§ÛŒÙ„ Â«${fileName}Â» Ø¯Ø± ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÙØ¹Ù„ÛŒ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯.` };
        }
        const state = ctx && ctx.editStates && ctx.editStates.get(found.name || fileName);
        if (!state) {
            return { valid: false, error: `ÙˆØ¶Ø¹ÛŒØª ÙˆÛŒØ±Ø§ÛŒØ´ Ø¨Ø±Ø§ÛŒ Â«${fileName}Â» Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯ - Ø§ÛŒÙ† Ù†Ø¨Ø§ÛŒØ¯ Ø±Ø® Ø¯Ù‡Ø¯.` };
        }

        const validation = validatePatchedContent(state.content, state.name);
        state.verified = validation.valid;

        log.info('agent.tool.verify_file', {
            name: state.name,
            valid: validation.valid,
            reason: validation.valid ? null : validation.reason,
            editCount: state.editCount
        });

        if (!validation.valid) {
            return {
                valid: false,
                error: `ÙØ§ÛŒÙ„ Ù†Ù‡Ø§ÛŒÛŒ Ù…Ø´Ú©Ù„ Ø³Ø§Ø®ØªØ§Ø±ÛŒ Ø¯Ø§Ø±Ø¯: ${validation.reason} Ø¨Ø§ apply_edit Ø¯ÛŒÚ¯Ø±ÛŒ Ø§ØµÙ„Ø§Ø­ Ú©Ù†ØŒ Ø³Ù¾Ø³ Ø¯ÙˆØ¨Ø§Ø±Ù‡ verify_file Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†. ØªØ§ Ø§ÛŒÙ† verify Ù¾Ø§Ø³ Ù†Ø´ÙˆØ¯ØŒ Ù†Ù…ÛŒâ€ŒØªÙˆØ§Ù†ÛŒ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø¨Ø¯Ù‡ÛŒ.`
            };
        }
        return {
            valid: true,
            file: state.name,
            editedName: found._editedName || state.name,
            editCount: state.editCount,
            note: 'ÙØ§ÛŒÙ„ Ø¨Ø±Ø±Ø³ÛŒ Ø´Ø¯ Ùˆ Ù…Ø´Ú©Ù„ Ø³Ø§Ø®ØªØ§Ø±ÛŒ Ù†Ø¯Ø§Ø±Ø¯. Ø­Ø§Ù„Ø§ Ù…ÛŒâ€ŒØªÙˆØ§Ù†ÛŒ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø¨Ø¯Ù‡ÛŒ.'
        };
    }


    if (name === 'web_search') {
        const query = (args && args.query) || '';
        if (!query) return { error: 'query Ø®Ø§Ù„ÛŒ Ø¨ÙˆØ¯.' };

        log.info('agent.tool.web_search', { queryPreview: query.slice(0, 100) });

        const search = await fetchTavilyResults(
            query,
            ctx.tavilyKeys,
            ctx.searchCache
        );

        if (!search?.ok) {
            return {
                result:
                    `[Ø¬Ø³ØªØ¬ÙˆÛŒ ÙˆØ¨ Ù†Ø§Ù…ÙˆÙÙ‚ Ø¨ÙˆØ¯ | ${search?.code || 'search_error'}] ` +
                    `${search?.message || 'Ø³Ø±ÙˆÛŒØ³ Ø¬Ø³ØªØ¬Ùˆ Ù†ØªÙˆØ§Ù†Ø³Øª Ù†ØªÛŒØ¬Ù‡â€ŒØ§ÛŒ Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†Ø¯.'}`,
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
        return { askUser: (args && args.question) || 'Ù…ÛŒâ€ŒØ®ÙˆØ§ÛŒ Ù‡Ù…ÛŒÙ†â€ŒØ·ÙˆØ± Ø§Ø¯Ø§Ù…Ù‡ Ø¨Ø¯Ù…ØŸ' };
    }

    return { error: `Ø§Ø¨Ø²Ø§Ø± Ù†Ø§Ø´Ù†Ø§Ø®ØªÙ‡: ${name}` };
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
async function runAgentLoop({ currentModel, currentKey, keyIndex, systemText, contents, tavilyKeys, archivedFiles, textFiles, onStep, onChunk, signal, disableTools, hasVideoAttachment, searchCache, searchState, searchIntent, fileEditIntent, sharedRequestState, thinkLevel }) {
    // FIX (ØªØ´Ø®ÛŒØµ ÙØ§ÛŒÙ„ ØªØ§Ø²Ù‡â€ŒÛŒ Ø¶Ù…ÛŒÙ…Ù‡â€ŒØ´Ø¯Ù‡ Ø¯Ø± Ø¨Ø±Ø§Ø¨Ø± ÙØ§ÛŒÙ„ promote-Ø´Ø¯Ù‡ Ø§Ø² Ø¢Ø±Ø´ÛŒÙˆ):
    // textFiles ÛŒÚ© Ø¢Ø±Ø§ÛŒÙ‡â€ŒÛŒ mutable Ø§Ø³Øª Ú©Ù‡ get_archived_file Ù‡Ù… Ø¨Ù‡ Ø¢Ù†
    // ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ø¢Ø±Ø´ÛŒÙˆÛŒ Ø±Ø§ push Ù…ÛŒâ€ŒÚ©Ù†Ø¯ (Ø¨Ø¨ÛŒÙ† Â«promoted.pushÂ» Ø¯Ø± Ø¢Ù† Ù‡Ù†Ø¯Ù„Ø±).
    // Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ†â€ŒÚ©Ù‡ Ø¨Ø¹Ø¯Ø§Ù‹ Ø¨ØªÙˆØ§Ù†ÛŒÙ… ÙØ±Ù‚ Ø¨Ú¯Ø°Ø§Ø±ÛŒÙ… Â«Ú©Ø§Ø±Ø¨Ø± Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ú†ÛŒØ²ÛŒ
    // Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ Ø¨ÙˆØ¯Â» Ø§Ø² Â«Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø¨Ø¹Ø¯Ø§Ù‹ ØªÙˆØ³Ø· Ø®ÙˆØ¯Ù get_archived_file Ø¨Ù‡
    // textFiles Ø§Ø¶Ø§ÙÙ‡ Ø´Ø¯Â»ØŒ Ù†Ø§Ù… ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ØªØ§Ø²Ù‡â€ŒÛŒ *ÙˆØ§Ù‚Ø¹ÛŒ* (Ù‚Ø¨Ù„ Ø§Ø² Ù‡Ø± promote)
    // Ø±Ø§ Ù‡Ù…ÛŒÙ† Ø§Ø¨ØªØ¯Ø§ØŒ Ù‚Ø¨Ù„ Ø§Ø² Ù‡Ø± ØªØºÛŒÛŒØ±ØŒ Ø§Ø³Ù†Ù¾â€ŒØ´Ø§Øª Ù…ÛŒâ€ŒÚ¯ÛŒØ±ÛŒÙ….
    const originalFreshFileNames = new Set((Array.isArray(textFiles) ? textFiles : []).map(f => f && f.name).filter(Boolean));
    // FIX (ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÛµÛ°Û°Û°+ Ø®Ø·ÛŒ): Ø¨Ø§ MAX_CHUNK_REQUEST_LINES=900ØŒ ÛŒÚ© ÙØ§ÛŒÙ„
    // ÛµÛ°Û°Û° Ø®Ø·ÛŒ Ø­Ø¯Ø§Ù‚Ù„ Ø¨Ù‡ Û¶-Û· Ø¨Ø§Ø± get_file_chunk Ù†ÛŒØ§Ø² Ø¯Ø§Ø±Ø¯ Ø§Ú¯Ø± Ù…Ø¯Ù„ Ù…Ø¬Ø¨ÙˆØ±
    // Ø´ÙˆØ¯ Ù‡Ù…Ù‡â€ŒÛŒ ÙØ§ÛŒÙ„ Ø±Ø§ Ù¾ÛŒÙ…Ø§ÛŒØ´ Ú©Ù†Ø¯ØŒ Ø¨Ù‡â€ŒØ¹Ù„Ø§ÙˆÙ‡â€ŒÛŒ inspect_file Ùˆ apply_patch Ùˆ
    // Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ. Ø³Ù‚Ù Ù‚Ø¨Ù„ÛŒ (Û·) Ø¹Ù…Ù„Ø§Ù‹ Ù‡Ù…Ø§Ù† Ù„Ø­Ø¸Ù‡ Ú©Ù‡ Ù…Ø¯Ù„ Ø¨Ù‡ Ø¯ÙˆÙ…ÛŒÙ†/Ø³ÙˆÙ…ÛŒÙ†
    // get_file_chunk Ù…ÛŒâ€ŒØ±Ø³ÛŒØ¯ ØªÙ…Ø§Ù… Ù…ÛŒâ€ŒØ´Ø¯. Ø¨Ø§Ù„Ø§ Ø¨Ø±Ø¯Ù†Ø´ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ù¾Ø±ÙˆÙØ§ÛŒÙ„ Ú©Ø§Ø±ÛŒ
    // Ø¶Ø±ÙˆØ±ÛŒ Ø§Ø³Øª - Ù†Ù‡ ÛŒÚ© "Ù…Ù‚Ø¯Ø§Ø± Ø§Ù…Ù† Ø¯Ù„Ø®ÙˆØ§Ù‡"ØŒ Ø¨Ù„Ú©Ù‡ Ø­Ø¯Ø§Ù‚Ù„ ÙØ¶Ø§ÛŒ ÙˆØ§Ù‚Ø¹ÛŒ Ù„Ø§Ø²Ù….
    // FIX (worst-case stall math): with the block map given upfront in the
    // system prompt (no inspect_file round needed anymore), a realistic
    // file-edit turn is read_block + write_block per target block (rarely
    // more than 2-3 blocks) + the final answer - well under 10 rounds. 16
    // was sized for the old chunk-based flow's worse case and, combined
    // with the fileEditIntent-blanket timeout fix above, produced a
    // ~45min worst-case stall on a single key before quota even
    // triggered. Lowered to 10 originally, and now write_block auto-
    // verifies itself (see write_block above), so a single-block edit no
    // longer needs a dedicated verify_file round at all.
    //
    // FIX (quota burn: fixed 10-round ceiling too generous for small
    // files, too tight for huge multi-block ones): a fixed cap either
    // wastes quota headroom letting a trivial 1-block edit theoretically
    // run 10 rounds if the model dithers, or forces a legitimately large
    // multi-block edit (e.g. a 5000-line file needing 8 separate blocks
    // touched) to hit the ceiling and get cut off mid-edit, which then
    // burns an entire extra key-attempt just to resume. Instead of a
    // fixed number, size the round budget off how many blocks THIS
    // file/request actually has to work with - Gemini decides how many
    // of those rounds it actually needs, this only sets the ceiling so a
    // genuinely stuck loop still can't run away.
    //
    // Budget model: read_block + write_block per block actually touched
    // (worst case: every block in the file, though a real edit only
    // touches a handful), plus a small fixed overhead for the initial
    // "figure out which blocks" rounds and the final answer round, plus
    // slack for one round of re-read+re-write per block in case a
    // write_block gets rejected by validation and needs a retry.
    // Clamped so tiny files don't get an absurdly small ceiling (a model
    // still needs room to read before it writes) and huge files don't
    // get an unbounded one (still a hard outer limit against a genuinely
    // looping model).
    const MIN_TOOL_ROUNDS = 6;
    const MAX_TOOL_ROUNDS_CEILING = 40;
    const ROUNDS_PER_EDITABLE_FILE = 6; // Ú†Ù†Ø¯ apply_edit + ÛŒÚ© Ø§Ø­ØªÙ…Ø§Ù„ retry Ø¨Ù‡â€ŒØ§Ø²Ø§ÛŒ Ù‡Ø± ÙØ§ÛŒÙ„ Ù‚Ø§Ø¨Ù„â€ŒÙˆÛŒØ±Ø§ÛŒØ´
    const FIXED_ROUND_OVERHEAD = 4; // initial orientation + final answer + margin
    let MAX_TOOL_ROUNDS;
    if (fileEditIntent && Array.isArray(textFiles) && textFiles.length > 0) {
        // Ø¨Ø¯ÙˆÙ† Ø¨Ù„ÙˆÚ©â€ŒØ¨Ù†Ø¯ÛŒØŒ Ø¨ÙˆØ¯Ø¬Ù‡ Ø¯ÛŒÚ¯Ø± Ø¨Ù‡ ØªØ¹Ø¯Ø§Ø¯ Ø¨Ù„ÙˆÚ© ÙˆØ§Ø¨Ø³ØªÙ‡ Ù†ÛŒØ³Øª - Ø¨Ù‡ ØªØ¹Ø¯Ø§Ø¯
        // ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ù‚Ø§Ø¨Ù„â€ŒÙˆÛŒØ±Ø§ÛŒØ´ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª (Ú†Ù†Ø¯ apply_edit Ù…Ù…Ú©Ù† Ø±ÙˆÛŒ Ù‡Ø±Ú©Ø¯Ø§Ù…)
        // ÙˆØ§Ø¨Ø³ØªÙ‡ Ø§Ø³Øª.
        const estimatedRounds = Math.ceil(textFiles.length * ROUNDS_PER_EDITABLE_FILE) + FIXED_ROUND_OVERHEAD;
        MAX_TOOL_ROUNDS = Math.min(MAX_TOOL_ROUNDS_CEILING, Math.max(MIN_TOOL_ROUNDS, estimatedRounds));
        log.info('agent.rounds.dynamic', {
            editableFiles: textFiles.length,
            estimatedRounds,
            finalMaxToolRounds: MAX_TOOL_ROUNDS
        });
    } else {
        // Non-file-edit turns (plain chat, web_search) never needed a
        // large budget - keep the old modest fixed cap for those.
        MAX_TOOL_ROUNDS = MIN_TOOL_ROUNDS;
    }
    // FIX (Ø±ÙˆÙ†Ø¯/tool call Ù‡Ø§ÛŒ Ú†Ù†Ø¯Ù…Ø±Ø­Ù„Ù‡â€ŒØ§ÛŒ Ú©Ù‡ ÙˆØ³Ø· Ú©Ø§Ø± throw Ù…ÛŒâ€ŒÚ©Ø±Ø¯Ù†Ø¯ Ø§Ø² ØµÙØ±
    // Ø´Ø±ÙˆØ¹ Ù…ÛŒâ€ŒØ´Ø¯Ù†Ø¯): Ù‚Ø¨Ù„Ø§Ù‹ Ø§ÛŒÙ†Ø¬Ø§ `[...contents]` ÛŒÚ© Ú©Ù¾ÛŒ Ù…Ø­Ù„ÛŒ Ù…ÛŒâ€ŒØ³Ø§Ø®Øª. ØªÙ…Ø§Ù…
    // push Ù‡Ø§ÛŒ Ø¨Ø¹Ø¯ÛŒ (Ù†ØªÛŒØ¬Ù‡ Ø¬Ø³ØªØ¬ÙˆØŒ Ù†ØªÛŒØ¬Ù‡ tool callØŒ Ù¾Ø§Ø³Ø® Ù…Ø¯Ù„) ÙÙ‚Ø· Ø±ÙˆÛŒ Ù‡Ù…ÛŒÙ†
    // Ú©Ù¾ÛŒ Ø§Ø¹Ù…Ø§Ù„ Ù…ÛŒâ€ŒØ´Ø¯Ù†Ø¯. Ø§Ú¯Ø± throw ÙˆØ³Ø· ÛŒÚ©ÛŒ Ø§Ø² round Ù‡Ø§ Ø§ØªÙØ§Ù‚ Ù…ÛŒâ€ŒØ§ÙØªØ§Ø¯ (Ù…Ø«Ù„Ø§Ù‹
    // Ø®Ø·Ø§ÛŒ Ù…ÙˆÙ‚ØªÛŒ Ø´Ø¨Ú©Ù‡ Ø¯Ø± round 5 Ø§Ø² 10)ØŒ caller Ø¨Ø§ catch Ø´Ø¯Ù† throwØŒ Ù‡Ù…Ø§Ù†
    // `contents` Ø§ØµÙ„ÛŒ Ùˆ Ø¯Ø³Øªâ€ŒÙ†Ø®ÙˆØ±Ø¯Ù‡ Ø±Ø§ Ø¨Ø±Ø§ÛŒ attempt Ø¨Ø¹Ø¯ÛŒ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ù…ÛŒâ€ŒÙØ±Ø³ØªØ§Ø¯ -
    // ÛŒØ¹Ù†ÛŒ Ù‡Ù…Ù‡â€ŒÛŒ Ù¾ÛŒØ´Ø±ÙØª Ø¢Ù† Ûµ round Ø¯ÙˆØ± Ø±ÛŒØ®ØªÙ‡ Ù…ÛŒâ€ŒØ´Ø¯.
    // Ø¨Ø§ mutate Ú©Ø±Ø¯Ù† Ù…Ø³ØªÙ‚ÛŒÙ… Ø±ÙˆÛŒ Ø®ÙˆØ¯Ù Ø¢Ø±Ø§ÛŒÙ‡â€ŒÛŒ `contents` (Ú©Ù‡ Ø¯Ø± Ø¬Ø§ÙˆØ§Ø§Ø³Ú©Ø±ÛŒÙ¾Øª
    // by-reference Ù¾Ø§Ø³ Ø¯Ø§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯)ØŒ Ù‡Ø± push Ø±ÙˆÛŒ Ù‡Ù…Ø§Ù† Ø¢Ø±Ø§ÛŒÙ‡â€ŒØ§ÛŒ Ø§Ø¹Ù…Ø§Ù„ Ù…ÛŒâ€ŒØ´ÙˆØ¯
    // Ú©Ù‡ caller (Ø®Ø·â€ŒÙ‡Ø§ÛŒ runAgentLoop call site) Ù†Ú¯Ù‡ Ø¯Ø§Ø´ØªÙ‡. Ù¾Ø³ Ø¨Ø§ throw Ø´Ø¯Ù†ØŒ
    // caller Ù‡Ù…Ø§Ù† contents Ø±Ø§ - Ø­Ø§Ù„Ø§ Ø´Ø§Ù…Ù„ ØªÙ…Ø§Ù… round Ù‡Ø§ÛŒ Ù…ÙˆÙÙ‚Ù Ù‚Ø¨Ù„ Ø§Ø² Ø®Ø·Ø§ -
    // Ø¨Ù‡ Ø¹Ù†ÙˆØ§Ù† ÙˆØ±ÙˆØ¯ÛŒ attempt Ø¨Ø¹Ø¯ÛŒ Ù¾Ø§Ø³ Ù…ÛŒâ€ŒØ¯Ù‡Ø¯ Ùˆ Ø§Ø¯Ø§Ù…Ù‡ Ø§Ø² Ù‡Ù…Ø§Ù†â€ŒØ¬Ø§ Ø´Ø±ÙˆØ¹ Ù…ÛŒâ€ŒØ´ÙˆØ¯ØŒ
    // Ù†Ù‡ Ø§Ø² ØµÙØ±.
    let workingContents = contents;
    // If the outer handler is retrying Gemini after a search already happened,
    // keep the first search result available to the replacement model without
    // exposing web_search (or any other tool) again. This preserves key/model
    // fallback while enforcing one logical search for the whole HTTP request.
    if (searchState?.used && searchState?.result?.result) {
        systemText = `${systemText}\n\n[Ù†ØªÛŒØ¬Ù‡ Ø¬Ø³ØªØ¬ÙˆÛŒ ÙˆØ¨ Ú©Ù‡ Ù‚Ø¨Ù„Ø§Ù‹ Ø¯Ø± Ù‡Ù…ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø§Ù†Ø¬Ø§Ù… Ø´Ø¯Ù‡ Ø§Ø³Øª â€” Ø§Ø² Ø¬Ø³ØªØ¬ÙˆÛŒ Ù…Ø¬Ø¯Ø¯ Ø®ÙˆØ¯Ø¯Ø§Ø±ÛŒ Ú©Ù†]:\n${searchState.result.result}`;
    }
    let lastUsage = null;
    // Question-scoped search lock: after one web_search, no tool is exposed
    // for the remainder of this request, including Gemini key/model retries.
    // Request-scoped search lock. This object is shared across Gemini key/model
    // retries, so a retry can NEVER start a second logical web_search for the
    // same incoming user question.
    const scopedSearchState = searchState || { used: false, result: null };

    // EDIT STATE SETUP: build (or reuse, if this is a retry of the same
    // HTTP request) one FileEditState per text file, and inject the full
    // current content of each into the system prompt. editStates lives on
    // sharedRequestState so a key/model retry within the same request
    // reuses the exact same in-progress content instead of rebuilding
    // from the original file.
    const editStates = sharedRequestState?.editStates || new Map();
    if (fileEditIntent && Array.isArray(textFiles) && textFiles.length > 0) {
        try {
            if (onStep) onStep('Ø¯Ø± Ø­Ø§Ù„ Ø¨Ø±Ø±Ø³ÛŒ ÙØ§ÛŒÙ„...', 'apply_edit');
            const fileDumps = textFiles.map((f) => {
                const key = f.name || 'file';
                let state = editStates.get(key);
                if (!state) {
                    state = createFileEditState(f);
                    editStates.set(key, state);
                }
                return { file: state.name, totalLines: state.content.split(/\r?\n/).length, content: state.content };
            });
            systemText += `\n\n[Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„(Ù‡Ø§ÛŒ) Ù‚Ø§Ø¨Ù„ ÙˆÛŒØ±Ø§ÛŒØ´ - Ø§ÛŒÙ† Ù…Ø­ØªÙˆØ§ÛŒ ÙˆØ§Ù‚Ø¹ÛŒ ÙØ¹Ù„ÛŒ Ø§Ø³Øª]\n${JSON.stringify(fileDumps, null, 2)}\n\n` +
                'Ù‚ÙˆØ§Ù†ÛŒÙ† ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„:\n' +
                'Û±. Ø¨Ø±Ø§ÛŒ ØªØºÛŒÛŒØ±ØŒ apply_edit Ø±Ø§ Ø¨Ø§ search (Ù…ØªÙ† Ø¯Ù‚ÛŒÙ‚ Ù…ÙˆØ¬ÙˆØ¯ Ø¯Ø± Ù…Ø­ØªÙˆØ§ÛŒ Ø¨Ø§Ù„Ø§) Ùˆ replace (Ù…ØªÙ† Ø¬Ø¯ÛŒØ¯) ØµØ¯Ø§ Ø¨Ø²Ù†. search Ø¨Ø§ÛŒØ¯ Ú†Ù†Ø¯ Ø®Ø· Ø§Ø·Ø±Ø§Ù ØªØºÛŒÛŒØ± Ø±Ø§ Ù‡Ù… Ø´Ø§Ù…Ù„ Ø´ÙˆØ¯ ØªØ§ Ø¯Ø± Ú©Ù„ ÙØ§ÛŒÙ„ ÛŒÚ©ØªØ§ Ø¨Ø§Ø´Ø¯.\n' +
                'Û². Ù‡Ø± apply_edit Ù…ÙˆÙÙ‚ Ø®ÙˆØ¯Ø´ Ù†ØªÛŒØ¬Ù‡â€ŒÛŒ Ø§Ø¹ØªØ¨Ø§Ø±Ø³Ù†Ø¬ÛŒ ÙØ§ÛŒÙ„ Ú©Ø§Ù…Ù„ Ø±Ø§ Ø¯Ø± ÙÛŒÙ„Ø¯ valid Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯. Ø§Ú¯Ø± Ø¢Ø®Ø±ÛŒÙ† ØªØºÛŒÛŒØ± Ù„Ø§Ø²Ù… Ø±Ø§ Ø²Ø¯ÛŒ Ùˆ valid:true Ú¯Ø±ÙØªÛŒØŒ Ù…Ø³ØªÙ‚ÛŒÙ… Ù…ÛŒâ€ŒØªÙˆØ§Ù†ÛŒ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø±Ø§ Ø¨Ø¯Ù‡ÛŒ - Ù†ÛŒØ§Ø²ÛŒ Ø¨Ù‡ verify_file Ø¬Ø¯Ø§Ú¯Ø§Ù†Ù‡ Ù†ÛŒØ³Øª Ù…Ú¯Ø± Ø¨Ø®ÙˆØ§Ù‡ÛŒ Ø¨Ø¯ÙˆÙ† ØªØºÛŒÛŒØ± Ø¬Ø¯ÛŒØ¯ ÛŒÚ© Ø¨Ø§Ø± Ø¯ÛŒÚ¯Ø± ÙˆØ¶Ø¹ÛŒØª ÙØ¹Ù„ÛŒ Ø±Ø§ Ú†Ú© Ú©Ù†ÛŒ.\n' +
                'Û³. Ø§Ú¯Ø± apply_edit Ø¨Ù‡ Ø¯Ù„ÛŒÙ„ Â«Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯Ù†Â» ÛŒØ§ Â«Ø§Ø¨Ù‡Ø§Ù…Â» Ø±Ø¯ Ø´Ø¯ØŒ Ø§Ø² context Ù‡Ø§ÛŒÛŒ Ú©Ù‡ Ø¯Ø± Ù¾Ø§Ø³Ø® Ø®Ø·Ø§ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø¯ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù† ØªØ§ search Ø±Ø§ Ø¯Ù‚ÛŒÙ‚â€ŒØªØ± Ùˆ ÛŒÚ©ØªØ§ Ú©Ù†ÛŒØŒ Ø³Ù¾Ø³ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØµØ¯Ø§ Ø¨Ø²Ù†.\n' +
                'Û´. Ø§Ú¯Ø± ÙØ§ÛŒÙ„ Ø®ÛŒÙ„ÛŒ Ø¨Ø²Ø±Ú¯ Ø§Ø³Øª Ùˆ Ø¨Ø±Ø§ÛŒ Ù†ÙˆØ´ØªÙ† search Ø¯Ù‚ÛŒÙ‚ Ù†ÛŒØ§Ø² Ø¨Ù‡ Ø¯ÛŒØ¯Ù† Ø¯ÙˆØ¨Ø§Ø±Ù‡â€ŒÛŒ ÛŒÚ© Ø¨Ø®Ø´ Ø®Ø§Øµ Ø¯Ø§Ø±ÛŒ (Ù†Ù‡ Ù…Ø­ØªÙˆØ§ÛŒ Ø¨Ø§Ù„Ø§ Ú©Ù‡ Ù…Ù…Ú©Ù† Ø§Ø³Øª Ú©ÙˆØªØ§Ù‡â€ŒØ´Ø¯Ù‡ Ø¨Ø§Ø´Ø¯)ØŒ Ø§Ø² read_file_section Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†.\n' +
                'Ûµ. Ø¨Ø¹Ø¯ Ø§Ø² Ù‡Ø± apply_edit Ù…ÙˆÙÙ‚ØŒ Ù…Ø­ØªÙˆØ§ÛŒ ÙØ§ÛŒÙ„ Ø¹ÙˆØ¶ Ø´Ø¯Ù‡ - Ø¨Ø±Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ Ø¨Ø¹Ø¯ÛŒ Ø±ÙˆÛŒ Ù‡Ù…Ø§Ù† ÙØ§ÛŒÙ„ØŒ search Ø±Ø§ Ø§Ø² Ù…ØªÙ† Ø¬Ø¯ÛŒØ¯ (Ù†Ù‡ Ù…ØªÙ† Ø§ÙˆÙ„ÛŒÙ‡â€ŒÛŒ Ø¨Ø§Ù„Ø§) Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ù†ØŒ Ù…Ú¯Ø± Ø¨Ø®Ø´ Ù…ÙˆØ±Ø¯Ù†Ø¸Ø± Ø¯Ø³Øªâ€ŒÙ†Ø®ÙˆØ±Ø¯Ù‡ Ù…Ø§Ù†Ø¯Ù‡ Ø¨Ø§Ø´Ø¯.\n';
            log.info('file.edit_state.mapped', {
                files: fileDumps.length,
                names: fileDumps.map(x => x.file),
                totalLines: fileDumps.map(x => x.totalLines)
            });
        } catch (error) {
            log.warn('file.edit_state.mapping_failed', {
                message: error?.message || String(error)
            });
            // Do not fail the whole chat because a best-effort dump
            // could not be produced. The model still has the original file.
        }
    }


    // FIX (root cause of "video reads extremely slowly / times out"):
    // Gemini has to ingest and effectively transcode/sample the whole video
    // (extracting frames at ~1fps) before it can emit the first output
    // token, which routinely takes well past 60s for anything more than a
    // few seconds of footage - even after client-side compression. The old
    // fixed 60s per-round timeout aborted these requests before Gemini ever
    // got a chance to respond, which is exactly the "Ù¾Ø§Ø³Ø® Ø¨ÛŒØ´ Ø§Ø² Ø­Ø¯ Ø·ÙˆÙ„
    // Ú©Ø´ÛŒØ¯" error being seen. Video attachments now get a longer per-round
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
    // FIX (large-file chunk-edit flow, Ø±ÙØ¹ ÙˆØ§Ù‚Ø¹ÛŒ Ø¨Ø±Ø§ÛŒ ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÛµÛ°Û°Û°+ Ø®Ø·):
    // Ù…Ù†Ø·Ù‚ Ù‚Ø¨Ù„ÛŒ ÙÙ‚Ø· Ø¨Ù‡ Ø±ÙˆÙ†Ø¯Ù "Ø¨Ø¹Ø¯ Ø§Ø²" ÛŒÚ© get_file_chunk/get_archived_file
    // Ù…Ù‡Ù„Øª Ø¨ÛŒØ´ØªØ± Ù…ÛŒâ€ŒØ¯Ø§Ø¯ - ÛŒØ¹Ù†ÛŒ Ø®ÙˆØ¯Ù Ø±ÙˆÙ†Ø¯ÛŒ Ú©Ù‡ Ø¨Ø±Ø§ÛŒ Ø§ÙˆÙ„ÛŒÙ† Ø¨Ø§Ø± ÛŒÚ© chunk Ø¨Ø²Ø±Ú¯
    // Ø±Ø§ Ù…ÛŒâ€ŒØ®ÙˆØ§Ù†Ø¯ Ùˆ Ù¾Ø±Ø¯Ø§Ø²Ø´ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ (ÛŒØ§ Ø±ÙˆÙ†Ø¯ inspect_file Ø±ÙˆÛŒ ÛŒÚ© ÙØ§ÛŒÙ„ Ú†Ù†Ø¯
    // Ù‡Ø²Ø§Ø± Ø®Ø·ÛŒ) Ù‡Ù…Ú†Ù†Ø§Ù† Ø¨Ø§ Ù…Ù‡Ù„Øª Ø§Ø³ØªØ§Ù†Ø¯Ø§Ø±Ø¯ Û¶Û° Ø«Ø§Ù†ÛŒÙ‡ Ø§Ø¬Ø±Ø§ Ù…ÛŒâ€ŒØ´Ø¯ Ùˆ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹
    // Ù‡Ù…ÛŒÙ†â€ŒØ¬Ø§ (Ø®Ø· Û±Û±Û°Û° ØªØ§ Û±Û¸Û¹Û° Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± ØªØ³Øª Ú©Ø±Ø¯) timeout Ù…ÛŒâ€ŒØ®ÙˆØ±Ø¯. Ø¨Ø±Ø§ÛŒ
    // ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ø¨Ø²Ø±Ú¯ØŒ ØªÙ‚Ø±ÛŒØ¨Ø§Ù‹ Ù‡Ø± round Ø§ÛŒÙ† Ø¬Ø±ÛŒØ§Ù† Ø¨Ù‡ Ù‡Ù…Ø§Ù† Ø§Ù†Ø¯Ø§Ø²Ù‡ Ø³Ù†Ú¯ÛŒÙ† Ø§Ø³Øª -
    // Ù¾Ø³ Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Ø­Ø¯Ø³ Ø²Ø¯Ù† "Ú©Ø¯Ø§Ù… round Ø³Ù†Ú¯ÛŒÙ†â€ŒØªØ±Ù‡"ØŒ ÙˆÙ‚ØªÛŒ fileEditIntent ÙØ¹Ø§Ù„
    // Ø§Ø³ØªØŒ Ù‡Ù…Ù‡â€ŒÛŒ round Ù‡Ø§ Ù…Ù‡Ù„Øª Ø¨Ù„Ù†Ø¯ Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ù†Ø¯.
    // FIX (10+ minute stall before quota error): fileEditIntent alone was
    // added to this condition to fix one real timeout, but fileEditIntent
    // is now true for EVERY turn with an attached file (see the fix that
    // dropped the keyword-regex gate) - not just turns that are actually
    // mid-edit. That made EVERY round (even a plain question about an
    // attached file, or round 0 before any tool has even been called) get
    // the full 170s budget, and with MAX_TOOL_ROUNDS now 16, the worst case
    // became 16 * 170s = ~45 minutes on a SINGLE key before even reaching
    // the quota-exhausted error - which then repeats the whole climb on
    // the next key. Scope the long budget back down to rounds that
    // genuinely follow a heavy read (archive/block/chunk) or carry video,
    // same as before fileEditIntent was blanket-added.
    const roundNeedsMoreTime = (round) =>
        hasVideoAttachment ||
        (round > 0 && (lastToolCallWasArchiveRead || lastToolCallWasSectionRead));
    let lastToolCallWasArchiveRead = false;
    // FIX (dead flag): lastToolCallWasChunkRead tracked get_file_chunk,
    // which no longer exists in the block-based system - it was declared
    // and reset every round but never re-armed anywhere, so it was always
    // false. read_block is this system's equivalent heavy read and gets
    // the same "give the NEXT round more time" treatment archive reads do.
    let lastToolCallWasSectionRead = false;

    // DIAGNOSTICS (Ø±Ø¯Ù Ú©Ø§Ù…Ù„ Ø§Ø¬Ø±Ø§ÛŒ Ø¹Ø§Ù…Ù„): Ø¨Ø±Ø§ÛŒ Ù‡Ø± roundØŒ ÛŒÚ© Ø±Ú©ÙˆØ±Ø¯ Ø³Ø§Ø®ØªØ§Ø±ÛŒØ§ÙØªÙ‡
    // Ù†Ú¯Ù‡ Ù…ÛŒâ€ŒØ¯Ø§Ø±ÛŒÙ… - Ù†Ù‡ ÙÙ‚Ø· ÛŒÚ© Ù¾ÛŒØ§Ù… Ø®Ø·Ø§ÛŒ Ú©Ù„ÛŒ Ø¯Ø± Ø§Ù†ØªÙ‡Ø§. Ø§ÛŒÙ† Ø¢Ø±Ø§ÛŒÙ‡ Ù‡Ù…ÛŒØ´Ù‡ (Ú†Ù‡
    // Ø¯Ø± Ù…ÙˆÙÙ‚ÛŒØª Ú†Ù‡ Ø¯Ø± Ø®Ø·Ø§) Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ ØªØ§ Ø¨Ø´ÙˆØ¯ Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ø¯ÛŒØ¯ Ù‡Ø± round
    // Ú†Ù‚Ø¯Ø± Ø·ÙˆÙ„ Ú©Ø´ÛŒØ¯ØŒ Ú©Ø¯Ø§Ù… Ø§Ø¨Ø²Ø§Ø± Ø¨Ø§ Ú†Ù‡ Ø¢Ø±Ú¯ÙˆÙ…Ø§Ù†ÛŒ ØµØ¯Ø§ Ø²Ø¯Ù‡ Ø´Ø¯ØŒ Ù‡Ø± Ø§Ø¨Ø²Ø§Ø± Ú†Ù†Ø¯ Ø¨Ø§Ø±
    // ØªÚ©Ø±Ø§Ø± Ø´Ø¯ØŒ Ú†Ù†Ø¯ apply_patch Ù…ÙˆÙÙ‚ Ø´Ø¯ØŒ Ùˆ Ø¯Ø± Ù†Ù‡Ø§ÛŒØª Ø¨Ø§ Ú†Ù‡ finishReason Ùˆ
    // Ú†Ù†Ø¯ Ú©Ø§Ø±Ø§Ú©ØªØ± Ù…ØªÙ† Ù…ØªÙˆÙ‚Ù Ø´Ø¯.
    const roundTrace = [];
    const toolCallTally = {}; // name -> Ø´Ù…Ø§Ø±Ù†Ø¯Ù‡â€ŒÛŒ Ú©Ù„ Ø¯Ø± Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª
    const agentLoopStartedAt = Date.now();
    // FIX (Ø§Ø¯Ø¹Ø§ÛŒ Ø¯Ø±ÙˆØºÛŒÙ† Ù…ÙˆÙÙ‚ÛŒØª Ø¨Ø¹Ø¯ Ø§Ø² write_block Ø±Ø¯Ø´Ø¯Ù‡): ÙˆÙ‚ØªÛŒ write_block
    // Ø¨Ù‡ Ø¯Ù„ÛŒÙ„ Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ø´Ø¯Ù† ÙØ§ÛŒÙ„ Ø±Ø¯ Ù…ÛŒâ€ŒØ´ÙˆØ¯ (validatePatchedContent) Ùˆ Ù…Ø¯Ù„ Ø¨Ù‡
    // Ø¬Ø§ÛŒ Ø§ØµÙ„Ø§Ø­ newContentØŒ Ø³Ø±Ø§Øº Ù…Ù†Ø§Ø¨Ø¹ Ø¯ÛŒÚ¯Ø± Ù…ÛŒâ€ŒØ±ÙˆØ¯ Ùˆ Ø¯Ø± Ù…ØªÙ† Ù†Ù‡Ø§ÛŒÛŒ ÙˆØ§Ù†Ù…ÙˆØ¯
    // Ù…ÛŒâ€ŒÚ©Ù†Ø¯ ÙˆÛŒØ±Ø§ÛŒØ´ Ø§Ù†Ø¬Ø§Ù… Ø´Ø¯Ù‡ØŒ Ù‡ÛŒÚ† _patched Ø§ÛŒ Ø±ÙˆÛŒ ÙØ§ÛŒÙ„ Ø«Ø¨Øª Ù†Ø´Ø¯Ù‡ - Ø§ÛŒÙ†
    // Map Ø¨Ø±Ø§ÛŒ Ù‡Ø± ÙØ§ÛŒÙ„ØŒ ØªØ¹Ø¯Ø§Ø¯ write_block Ù‡Ø§ÛŒ Ø±Ø¯Ø´Ø¯Ù‡ Ùˆ Ø¢Ø®Ø±ÛŒÙ† Ø¯Ù„ÛŒÙ„ Ø±Ø¯ Ø´Ø¯Ù† Ø±Ø§
    // Ù†Ú¯Ù‡ Ù…ÛŒâ€ŒØ¯Ø§Ø±Ø¯ ØªØ§ Ø¯Ø± Ù¾Ø§ÛŒØ§Ù† Ø¨ØªÙˆØ§Ù†ÛŒÙ… Ø§ÛŒÙ† Ù†Ø§Ø³Ø§Ø²Ú¯Ø§Ø±ÛŒ Ø±Ø§ ØªØ´Ø®ÛŒØµ Ø¯Ù‡ÛŒÙ….
    const rejectedWriteBlocksByFile = new Map(); // fileName -> { count, lastReason }

    // NOTE (block-based rewrite): inspectedFilesThisRequest and
    // chunkReadsPerFile (repeat-guards for the old inspect_file/
    // get_file_chunk tools) were removed - those tools no longer exist.
    // Their job (persisting file-editing progress across key/model
    // retries within one HTTP request) is now done by editStates, read
    // from sharedRequestState at the top of this function.

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const ROUND_TIMEOUT_MS = roundNeedsMoreTime(round) ? 170000 : 60000;
        lastToolCallWasArchiveRead = false; // consumed for this round; re-armed below only if this round's own tool call is an archive read
        lastToolCallWasSectionRead = false; // consumed for this round; re-armed below only if this round's own tool call is a section read
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
                        // FIX (silent empty reply with no SAFETY label): no
                        // safetySettings were ever sent, so Gemini used its
                        // own default (often stricter) thresholds. When the
                        // default filter blocks a response, some Gemini API
                        // versions return it as a plain empty response
                        // (finishReason null/NONE, 0 chars) rather than
                        // explicitly labeling it SAFETY - which is exactly
                        // what agent.empty_after_tool_call was seeing on
                        // round 0, no tool calls, ~1s duration. Explicitly
                        // setting the least-restrictive commonly-supported
                        // threshold here reduces false-positive blocks
                        // without disabling safety entirely.
                        safetySettings: [
                            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                        ],
                        // FIX (Ú©Ù†Ø¯ÛŒ Ù…Ø­Ø³ÙˆØ³ Ø¨Ø§ Ù…Ø¯Ù„â€ŒÙ‡Ø§ÛŒ ØºÛŒØ± Ø§Ø² flash-lite): ØªØ§
                        // Ø§ÛŒÙ†Ø¬Ø§ Ù‡ÛŒÚ† generationConfig/thinkingConfig Ø§Ø±Ø³Ø§Ù„
                        // Ù†Ù…ÛŒâ€ŒØ´Ø¯ØŒ Ù¾Ø³ gemini-3.7-flash Ùˆ gemini-3.1-pro-preview
                        // Ø¨Ø§ Ø³Ø·Ø­ ØªÙÚ©Ø± Ù¾ÛŒØ´â€ŒÙØ±Ø¶ Ø®ÙˆØ¯Ø´Ø§Ù† (Ú©Ù‡ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ø®Ø§Ù†ÙˆØ§Ø¯Ù‡ Ø§Ø²
                        // Ù…Ø¯Ù„â€ŒÙ‡Ø§ Ù…Ø¹Ù…ÙˆÙ„Ø§Ù‹ medium/high Ø§Ø³Øª) Ø§Ø¬Ø±Ø§ Ù…ÛŒâ€ŒØ´Ø¯Ù†Ø¯ - ÛŒØ¹Ù†ÛŒ
                        // Ù‚Ø¨Ù„ Ø§Ø² Ø´Ø±ÙˆØ¹ Ø§Ø³ØªØ±ÛŒÙ… Ù¾Ø§Ø³Ø®ØŒ Ù…Ø¯Ù„ Ù…Ø¯Øª Ù‚Ø§Ø¨Ù„â€ŒØªÙˆØ¬Ù‡ÛŒ ØµØ±Ù
                        // Â«ÙÚ©Ø± Ú©Ø±Ø¯Ù†Â» Ø¯Ø§Ø®Ù„ÛŒ Ù…ÛŒâ€ŒÚ©Ø±Ø¯. flash-lite Ø§ÛŒÙ† Ù…Ø´Ú©Ù„ Ø±Ø§
                        // Ù†Ø¯Ø§Ø´Øª Ú†ÙˆÙ† Ø§ØµÙ„Ø§Ù‹ Ø§Ø² Ø§ÛŒÙ† Ø®Ø§Ù†ÙˆØ§Ø¯Ù‡â€ŒÛŒ thinking Ù†ÛŒØ³Øª.
                        // ÛŒÚ© Ø³Ø·Ø­ ØªÙÚ©Ø± Ù¾Ø§ÛŒÛŒÙ† (Ù†Ù‡ ØµÙØ±ØŒ Ú†ÙˆÙ† Ø§ÛŒÙ† Ù…Ø¯Ù„â€ŒÙ‡Ø§ Ø§ØµÙ„Ø§Ù‹
                        // Ø§Ø¬Ø§Ø²Ù‡â€ŒÛŒ Ø®Ø§Ù…ÙˆØ´ Ú©Ø§Ù…Ù„ ØªÙÚ©Ø± Ø±Ø§ Ù†Ù…ÛŒâ€ŒØ¯Ù‡Ù†Ø¯) ØªØ§Ø®ÛŒØ± Ù‚Ø¨Ù„ Ø§Ø²
                        // Ø´Ø±ÙˆØ¹ Ù¾Ø§Ø³Ø® Ø±Ø§ Ø¨Ù‡â€ŒØ´Ø¯Øª Ú©Ù… Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ø¨Ø¯ÙˆÙ† Ø§ÛŒÙ†â€ŒÚ©Ù‡ Ú©ÛŒÙÛŒØª
                        // Ù¾Ø§Ø³Ø®â€ŒÙ‡Ø§ÛŒ Ù…Ø¹Ù…ÙˆÙ„ÛŒ Ø§ÙØª Ù…Ø­Ø³ÙˆØ³ÛŒ Ø¯Ø§Ø´ØªÙ‡ Ø¨Ø§Ø´Ø¯.
                        // FEATURE (Think mode toggle): thinkLevel comes from
                        // the client's "Ø­Ø§Ù„Øª ØªÙÚ©Ø±" control (off by default -
                        // see index.html). 'off' keeps the original speed-fix
                        // behavior (minimal/low per model); when the user
                        // explicitly turns Think on and picks low/medium/high,
                        // that overrides the default for every model.
                        // Model-specific thinking configuration:
                        // - 3.5 Flash-Lite: omit thinkingConfig entirely.
                        // - 3.7 Flash / 3.1 Pro: use low as the default when
                        //   the UI value is 'off' or otherwise invalid.
                        // This prevents the unsupported MINIMAL value from
                        // ever reaching models that reject it.
                        generationConfig: (() => {
                            if (currentModel === 'gemini-3.5-flash-lite') return {};

                            const requestedLevel = THINK_LEVEL_MAP[thinkLevel];
                            const defaultLevel = THINKING_MODEL_DEFAULTS[currentModel] || 'low';

                            return {
                                thinkingConfig: {
                                    thinkingLevel: requestedLevel || defaultLevel
                                }
                            };
                        })(),
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

        // FIX (Ú©Ù†Ø¯ÛŒ Ù…Ø­Ø³ÙˆØ³ ÙÙ‚Ø· Ø±ÙˆÛŒ Ù…Ø¯Ù„â€ŒÙ‡Ø§ÛŒ thinking-capable Ø¨Ø§ Ø³ÙˆØ§Ù„Ø§Øª
        // Ø´Ø¨Ù‡â€ŒØ³Ø±Ú†): Ù‚Ø¨Ù„Ø§Ù‹ pendingToolPreamble ØªØ§ Ù¾Ø§ÛŒØ§Ù† Ú©Ø§Ù…Ù„ Ù‡Ù…Ø§Ù† round
        // (ÛŒØ¹Ù†ÛŒ ØªØ§ Ø¬Ø§ÛŒÛŒ Ú©Ù‡ Ù…Ø´Ø®Øµ Ø´ÙˆØ¯ functionCall Ø¢Ù…Ø¯Ù‡ ÛŒØ§ Ù†Ù‡) Ù‡ÛŒÚ† Ø®Ø±ÙˆØ¬ÛŒâ€ŒØ§ÛŒ
        // Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± Ù†Ù…ÛŒâ€ŒØ¯Ø§Ø¯. Ø¨Ø±Ø§ÛŒ Ù…Ø¯Ù„â€ŒÙ‡Ø§ÛŒÛŒ Ú©Ù‡ Ù¾ÛŒØ´ Ø§Ø² ØªØµÙ…ÛŒÙ…â€ŒÚ¯ÛŒØ±ÛŒ Ø¯Ø±Ø¨Ø§Ø±Ù‡â€ŒÛŒ
        // tool call ÛŒÚ© Ù…Ø±Ø­Ù„Ù‡â€ŒÛŒ Ø¯Ø§Ø®Ù„ÛŒ Ø·ÙˆÙ„Ø§Ù†ÛŒâ€ŒØªØ± Â«ÙÚ©Ø± Ú©Ø±Ø¯Ù†Â» Ø¯Ø§Ø±Ù†Ø¯ (Ù‡Ø± Ú†ÛŒØ²ÛŒ
        // ØºÛŒØ± Ø§Ø² flash-lite)ØŒ Ø§ÛŒÙ† ÛŒØ¹Ù†ÛŒ Ø³Ú©ÙˆØª Ú©Ø§Ù…Ù„ ØªØ§ Ù¾Ø§ÛŒØ§Ù† Ù‡Ù…Ø§Ù† Ù…Ø±Ø­Ù„Ù‡.
        // Ø§ÛŒÙ† ØªØ§ÛŒÙ…Ø± ÛŒÚ© Ø³Ù‚Ù Ø²Ù…Ø§Ù†ÛŒ Ú©ÙˆØªØ§Ù‡ Ù…ÛŒâ€ŒÚ¯Ø°Ø§Ø±Ø¯: Ø§Ú¯Ø± ØªØ§ PREAMBLE_HOLD_MS
        // Ù‡Ù†ÙˆØ² Ù†Ù‡ functionCall Ø¯ÛŒØ¯Ù‡ Ø´Ø¯Ù‡ Ù†Ù‡ round ØªÙ…Ø§Ù… Ø´Ø¯Ù‡ØŒ Ù‡Ø± Ú†Ù‡ ØªØ§ Ø§ÛŒÙ†
        // Ù„Ø­Ø¸Ù‡ Ø¨Ø§ÙØ± Ø´Ø¯Ù‡ Ø±Ø§ Ù‡Ù…ÛŒÙ† Ø§Ù„Ø§Ù† flush Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ… Ùˆ Ø§Ø² Ù‡Ù…Ø§Ù† Ù„Ø­Ø¸Ù‡ Ø¨Ù‡ Ø¨Ø¹Ø¯
        // Ø§Ø³ØªØ±ÛŒÙ… Ø±Ø§ Ø²Ù†Ø¯Ù‡ (live) Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ… - Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù…Ø«Ù„ Ø­Ø§Ù„ØªÛŒ Ú©Ù‡ Ø§Ø² Ø§ÙˆÙ„
        // sawFunctionCall Ù†Ù…ÛŒâ€ŒØ´Ø¯. Ù…Ù†Ø·Ù‚ ØªØ´Ø®ÛŒØµ Ø³Ø±Ú†/tool call Ø¯Ø³Øªâ€ŒÙ†Ø®ÙˆØ±Ø¯Ù‡
        // Ù…ÛŒâ€ŒÙ…Ø§Ù†Ø¯: Ø§Ú¯Ø± functionCall ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¨Ø±Ø³Ø¯ØŒ Ù‡Ù†ÙˆØ² Ø·Ø¨Ù‚ Ù‡Ù…Ø§Ù† Ù…Ø³ÛŒØ± Ù‚Ø¨Ù„ÛŒ
        // discard Ù…ÛŒâ€ŒØ´ÙˆØ¯ (Ú†ÙˆÙ† preambleTimedOut ÙÙ‚Ø· Ø¬Ù„ÙˆÛŒ Ù†Ú¯Ù‡â€ŒØ¯Ø§Ø´ØªÙ† Ø¨Ø§ÙØ± Ø±Ø§
        // Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ø¯ØŒ Ù†Ù‡ Ù…Ù†Ø·Ù‚ eventHasFunctionCall Ø±Ø§). ØªÙ†Ù‡Ø§ Ø±ÛŒØ³Ú© Ø§ÛŒÙ† Ø§Ø³Øª Ú©Ù‡
        // Ø¯Ø± Ù…ÙˆØ§Ø±Ø¯ Ù†Ø§Ø¯Ø± ÛŒÚ© preamble Ú©ÙˆØªØ§Ù‡ (Â«Ø¨Ø§Ø´Ù‡ Ø¨Ø°Ø§Ø± Ú†Ú© Ú©Ù†Ù…...Â») Ù‚Ø¨Ù„ Ø§Ø²
        // Ù†ØªÛŒØ¬Ù‡â€ŒÛŒ Ø³Ø±Ú† Ù†Ø´Ø§Ù† Ø¯Ø§Ø¯Ù‡ Ø´ÙˆØ¯ - Ú©Ù‡ Ø®ÛŒÙ„ÛŒ Ø¨Ù‡ØªØ± Ø§Ø² Ú†Ù†Ø¯ Ø«Ø§Ù†ÛŒÙ‡ Ø³Ú©ÙˆØª Ø§Ø³Øª.
        const PREAMBLE_HOLD_MS = 1500;
        let preambleTimedOut = false;
        let preambleHoldTimer = null;
        const armPreambleHoldTimer = () => {
            if (preambleHoldTimer || preambleTimedOut) return;
            preambleHoldTimer = setTimeout(() => {
                preambleTimedOut = true;
                if (pendingToolPreamble) {
                    emitStreamText(pendingToolPreamble);
                    pendingToolPreamble = '';
                }
            }, PREAMBLE_HOLD_MS);
        };
        const clearPreambleHoldTimer = () => {
            if (preambleHoldTimer) {
                clearTimeout(preambleHoldTimer);
                preambleHoldTimer = null;
            }
        };

        const handleStreamText = (text) => {
            if (!searchIntent || disableTools || scopedSearchState.used || sawFunctionCall || preambleTimedOut) {
                emitStreamText(text);
                return;
            }

            // This is an explicit/current-info search turn. Keep the entire
            // pre-tool stream off the wire until Gemini either emits the
            // functionCall (then the buffer is discarded) or finishes without
            // a tool (then the buffer is flushed below). This is intentionally
            // scoped ONLY to likely search requests, so ordinary chat keeps the
            // zero-buffer live streaming path. Bounded by PREAMBLE_HOLD_MS
            // above so a slow-to-decide model never blocks the UI for long.
            pendingToolPreamble += text;
            armPreambleHoldTimer();
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
                clearPreambleHoldTimer();
                // Anything held so far was pre-tool narration. Do NOT flush it.
                // (If preambleTimedOut already flushed some of it live, that
                // small preamble is left as-is â€” the discard only applies to
                // whatever is still sitting in the buffer at this point.)
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
            clearPreambleHoldTimer();
        } catch (streamErr) {
            clearPreambleHoldTimer();
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

        // DIAGNOSTICS: Ø«Ø¨Øª ÙˆØ¶Ø¹ÛŒØª Ù¾Ø§ÛŒØ§Ù†ÛŒ Ø§ÛŒÙ† roundØŒ ØµØ±Ùâ€ŒÙ†Ø¸Ø± Ø§Ø² Ø§ÛŒÙ†â€ŒÚ©Ù‡ Ø¯Ø±
        // Ù†Ù‡Ø§ÛŒØª Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø¨Ø§Ø´Ø¯ ÛŒØ§ Ø¨Ø±ÙˆØ¯ Ø³Ø±Ø§Øº round Ø¨Ø¹Ø¯ÛŒ Ø¨Ø±Ø§ÛŒ Ø§Ø¬Ø±Ø§ÛŒ Ø§Ø¨Ø²Ø§Ø±.
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
        if (functionCalls.length === 0 && editStates && editStates.size > 0) {
            const unverified = [...editStates.values()].find(s => s.editCount > 0 && !s.verified);
            if (unverified) {
                log.info('agent.verify_gate.forced', {
                    file: unverified.name,
                    editedBlockCount: unverified.editedBlocks.size,
                    round
                });
                functionCalls.push({ name: 'verify_file', args: { file: unverified.name } });
                // Keep any text the model produced this round (e.g. "Ø§Ù„Ø§Ù†
                // ÙØ§ÛŒÙ„ Ø±Ùˆ Ù†Ù‡Ø§ÛŒÛŒ Ù…ÛŒâ€ŒÚ©Ù†Ù…") - it will be followed by the
                // verify_file round's own text, both streamed normally.
            }
        }

        if (functionCalls.length === 0) {
            clearPreambleHoldTimer();
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
            // exactly the "Ù¾ÛŒØ§Ù… ÛŒÙ‡ Ù„Ø­Ø¸Ù‡ Ù…ÛŒØ§Ø¯ Ø¨Ø¹Ø¯ ØºÛŒØ¨ Ù…ÛŒØ´Ù‡" symptom. Detect
            // that specific case and surface a real, explained error instead
            // of a silent empty success.
            // BUGFIX (silent empty reply after a tool call, "Ù¾Ø§Ø³Ø®ÛŒ Ø¯Ø±ÛŒØ§ÙØª
            // Ù†Ø´Ø¯"): the check below used to require finishReason to be
            // something abnormal (MAX_TOKENS, SAFETY, ...) before treating
            // an empty reply as an error. But Gemini can also finish with a
            // perfectly normal STOP right after a tool call (e.g. right
            // after apply_patch succeeds) while producing zero text - no
            // final answer, no file-edit block, nothing. That used to be
            // returned as a "successful" empty finalText, which the client
            // then shows as a blank bubble and falls back to its own
            // generic "Ù¾Ø§Ø³Ø®ÛŒ Ø¯Ø±ÛŒØ§ÙØª Ù†Ø´Ø¯" message with no real error to
            // retry against. Treat ANY empty reply after at least one tool
            // round (round > 0) as the same real, explained error,
            // regardless of finishReason, so the outer key/model retry
            // loop actually kicks in instead of silently succeeding with
            // nothing.
            const normalStop = !finishReason || finishReason === 'STOP';
            if (textParts.length === 0) {
                log.warn('agent.empty_after_tool_call', {
                    finishReason,
                    round,
                    normalStop,
                    toolCallTally,
                    roundTrace
                });
                const err = new Error('agent_empty_after_tool_call');
                err.status = 502;
                // FEATURE (child-safety filter detection): Gemini's
                // child-safety protections are not adjustable via
                // safetySettings and, when triggered, return a silent
                // empty reply with no explicit SAFETY finishReason - so
                // this can't be detected from the API response itself.
                // As a heuristic, scan the last couple of user turns for
                // age/child-related keywords (Persian + a few common
                // English ones). This is only used to pick a clearer,
                // more specific error message for the user - it never
                // blocks or filters anything on our side.
                const recentUserText = (Array.isArray(workingContents) ? workingContents : [])
                    .filter(c => c && c.role === 'user')
                    .slice(-2)
                    .map(c => (Array.isArray(c.parts) ? c.parts.map(p => p && p.text || '').join(' ') : ''))
                    .join(' ');
                const childSafetyPattern = /(بچه|کودک|کودکان|ساله|سال دارم|ساله‌ام|سالمه|سالمو|سالمه\b|child|kid|minor|years? old|year-old|toddler)/i;
                const likelyChildSafetyBlock = childSafetyPattern.test(recentUserText);
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
                // DIAGNOSTICS: Ø®Ù„Ø§ØµÙ‡â€ŒÛŒ Ù‚Ø§Ø¨Ù„â€ŒÙÙ‡Ù… Ø¨Ø±Ø§ÛŒ Ø§Ù†Ø³Ø§Ù† (ÙØ§Ø±Ø³ÛŒ) Ú©Ù‡ Ù…Ø³ØªÙ‚ÛŒÙ…
                // Ø¯Ø± "Ø¬Ø²Ø¦ÛŒØ§Øª Ø¨ÛŒØ´ØªØ±" Ú©Ø§Ø±Ø¨Ø± Ù†Ø´Ø§Ù† Ø¯Ø§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ - Ù†Ù‡ ÙÙ‚Ø· Ø¯ÛŒØªØ§ÛŒ Ø®Ø§Ù…
                // Ø¨Ø±Ø§ÛŒ Ù„Ø§Ú¯ Ø³Ø±ÙˆØ±. summarizeAgentTrace Ù‡Ø± Ø¯Ùˆ Ø±Ø§ Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯.
                const traceSummary = summarizeAgentTrace(roundTrace, toolCallTally, {
                    stoppedReason: 'silent_after_tool',
                    round
                });
                err.body = {
                    message: round > 0
                        ? 'Ù…Ø¯Ù„ Ø¨Ø¹Ø¯ Ø§Ø² Ø§Ø³ØªÙØ§Ø¯Ù‡ Ø§Ø² Ø§Ø¨Ø²Ø§Ø± Ø¬ÙˆØ§Ø¨ Ø®Ø§Ù„ÛŒ Ø¨Ø±Ú¯Ø±Ø¯ÙˆÙ†Ø¯. Ù„Ø·ÙØ§Ù‹ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.'
                        : 'ÙØ¯Ù Ø¬ÙØ§Ø¨ Ø®Ø§ÙÛ Ø¨Ø±Ú¯Ø±Ø¯ÙÙØ¯ (Ø§Ø­ØªÙØ§ÙØ§Ù ÙÛÙØªØ± Ø§ÛÙÙÛ ÛØ§ ÙØ´Ú©Ù ÙÙÙØª). ÙØ·ÙØ§Ù Ø¯ÙØ¨Ø§Ø±Ù Ø§ÙØªØ­Ø§Ù Ú©Ù.',
                    type: 'empty_after_tool_call',
                    finishReason,
                    round,
                    likelyChildSafetyBlock,
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

            // FIX (Ø§Ø¯Ø¹Ø§ÛŒ Ø¯Ø±ÙˆØºÛŒÙ† Ù…ÙˆÙÙ‚ÛŒØª): Ø§Ú¯Ø± Ø±ÙˆÛŒ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø­Ø¯Ø§Ù‚Ù„ ÛŒÚ©
            // write_block Ø±Ø¯ Ø´Ø¯Ù‡ (ÙØ§ÛŒÙ„ Ù‡ÛŒÚ†â€ŒÙˆÙ‚Øª ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ù¾Ú† Ù†Ø´Ø¯Ù‡ - Ù†Ù‡ Ø¯Ø±
            // editedFiles Ùˆ Ù†Ù‡ Ø¯Ø± partialFiles) Ùˆ Ù…Ø¯Ù„ Ø¨Ø§ Ø§ÛŒÙ† Ø­Ø§Ù„ Ø¯Ø§Ø±Ø¯
            // Ù…ØªÙ†ÛŒ Ù…ÛŒâ€ŒÙØ±Ø³ØªØ¯ Ú©Ù‡ Ø¨Ù‡ Ù†Ø¸Ø± Ø§Ø¯Ø¹Ø§ÛŒ Ø§Ù†Ø¬Ø§Ù…â€ŒØ´Ø¯Ù† ÙˆÛŒØ±Ø§ÛŒØ´ Ø±Ø§ Ø¯Ø§Ø±Ø¯ØŒ
            // Ø§ÛŒÙ† Ø­Ø§Ù„Øª Ø±Ø§ ÙˆØ§Ù‚Ø¹ÛŒ Ùˆ ØµØ±ÛŒØ­ Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø±/Ú©Ù„Ø§ÛŒÙ†Øª Ø§Ø·Ù„Ø§Ø¹ Ø¨Ø¯Ù‡ Ø¨Ù‡â€ŒØ¬Ø§ÛŒ
            // Ø±Ù‡Ø§ Ú©Ø±Ø¯Ù† Ù…ØªÙ† Ú¯Ù…Ø±Ø§Ù‡â€ŒÚ©Ù†Ù†Ø¯Ù‡â€ŒÛŒ Ù…Ø¯Ù„ Ø¨Ø¯ÙˆÙ† Ù‡ÛŒÚ† Ù†Ø´Ø§Ù†Ù‡â€ŒØ§ÛŒ. Ø§ÛŒÙ† ÙÙ‚Ø·
            // ÛŒÚ© ÙÙ„Ú¯ Ø§Ø·Ù„Ø§Ø¹Ø§ØªÛŒ Ø§Ø³Øª - finalText Ù…Ø¯Ù„ Ø¯Ø³Øªâ€ŒÙ†Ø®ÙˆØ±Ø¯Ù‡ Ù…ÛŒâ€ŒÙ…Ø§Ù†Ø¯ØŒ
            // Ú†ÙˆÙ† Ù…Ù…Ú©Ù† Ø§Ø³Øª Ù…ØªÙ† ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¯Ø±Ø³Øª Ø¨Ø§Ø´Ø¯ (Ù…Ø«Ù„Ø§Ù‹ Ù…Ø¯Ù„ ØµØ§Ø¯Ù‚Ø§Ù†Ù‡ Ú¯ÙØªÙ‡
            // "Ù†ØªÙˆÙ†Ø³ØªÙ… ÙˆÛŒØ±Ø§ÛŒØ´ Ú©Ù†Ù…")Ø› Ø§ÛŒÙ†Ø¬Ø§ ÙÙ‚Ø· Ø¯Ø§Ø¯Ù‡â€ŒÛŒ ØªØ´Ø®ÛŒØµÛŒ Ø§Ø¶Ø§ÙÙ‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯
            // ØªØ§ Ú©Ù„Ø§ÛŒÙ†Øª Ø¨ØªÙˆØ§Ù†Ø¯ Ø¯Ø± ØµÙˆØ±Øª Ù†ÛŒØ§Ø² Ù‡Ø´Ø¯Ø§Ø± Ù†Ø´Ø§Ù† Ø¯Ù‡Ø¯.
            //
            // FIX Û² (Ø­Ø§Ù„Øª Ø¨Ø¯ØªØ±: write_block Ø§ØµÙ„Ø§Ù‹ ØµØ¯Ø§ Ø²Ø¯Ù‡ Ù†Ø´Ø¯Ù‡): Ø­Ø§Ù„Øª Ø¨Ø§Ù„Ø§
            // ÙÙ‚Ø· Ø²Ù…Ø§Ù†ÛŒ ÙØ¹Ø§Ù„ Ù…ÛŒâ€ŒØ´Ø¯ Ú©Ù‡ write_block Ø­Ø¯Ø§Ù‚Ù„ ÛŒÚ© Ø¨Ø§Ø± Ø±Ø¯ Ø´Ø¯Ù‡
            // Ø¨Ø§Ø´Ø¯. Ø§Ù…Ø§ ÛŒÚ© Ø­Ø§Ù„Øª Ø¨Ø¯ØªØ± Ù‡Ù… ÙˆØ¬ÙˆØ¯ Ø¯Ø§Ø±Ø¯ - ÙˆÙ‚ØªÛŒ Ú©Ø§Ø±Ø¨Ø± ÙˆØ§Ù‚Ø¹Ø§Ù‹ ÛŒÚ©
            // ÙØ§ÛŒÙ„ ØªØ§Ø²Ù‡ Ø¨Ø±Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ (fileEditIntent === trueØŒ
            // ÛŒØ¹Ù†ÛŒ editStates Ø³Ø§Ø®ØªÙ‡ Ø´Ø¯Ù‡) ÙˆÙ„ÛŒ Ù…Ø¯Ù„ Ú©Ù„Ø§Ù‹ Ù‡ÛŒÚ†â€ŒÙˆÙ‚Øª apply_edit
            // Ø±Ø§ Ø±ÙˆÛŒ Ù‡ÛŒÚ† Ø¨Ù„ÙˆÚ©ÛŒ ØµØ¯Ø§ Ù†Ø²Ø¯Ù‡ (Ù†Ù‡ Ù…ÙˆÙÙ‚ØŒ Ù†Ù‡ Ø±Ø¯ Ø´Ø¯Ù‡) Ùˆ Ù…Ø³ØªÙ‚ÛŒÙ… Ø¨Ø§
            // Ù…ØªÙ†ÛŒ Ú©Ù‡ Ø¨Ù‡ Ù†Ø¸Ø± Ø§Ø¯Ø¹Ø§ÛŒ Ø§Ù†Ø¬Ø§Ù…â€ŒØ´Ø¯Ù† ØªØºÛŒÛŒØ± Ø¯Ø§Ø±Ø¯ Ø¨Ù‡ Ù¾Ø§ÛŒØ§Ù† Ø±Ø³ÛŒØ¯Ù‡. Ø§ÛŒÙ†
            // Ø±Ø§ Ù‡Ù… Ø¨Ø§ Ø´Ù…Ø§Ø±Ø´ Ú©Ù„ ÙØ±Ø§Ø®ÙˆØ§Ù†ÛŒâ€ŒÙ‡Ø§ÛŒ write_block (Ø§Ø² toolCallTally)
            // ØªØ´Ø®ÛŒØµ Ù…ÛŒâ€ŒØ¯Ù‡ÛŒÙ…: Ø§Ú¯Ø± Ø¨Ù„ÙˆÚ©â€ŒØ§Ø³ØªÛŒØªâ€ŒØ§ÛŒ Ø¨Ø±Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ ÙˆØ¬ÙˆØ¯ Ø¯Ø§Ø´Øª Ø§Ù…Ø§
            // write_block Ø§ØµÙ„Ø§Ù‹ ØµØ¯Ø§ Ø²Ø¯Ù‡ Ù†Ø´Ø¯ Ùˆ Ù‡ÛŒÚ† ÙØ§ÛŒÙ„ÛŒ patch Ù†Ø´Ø¯ØŒ Ø§ÛŒÙ† Ù‡Ù…
            // Ù‡Ù…Ø§Ù† Ú©Ù„Ø§Ø³ Ù…Ø´Ú©Ù„ Ø§Ø³Øª.
            const writeBlockCallCount = toolCallTally['write_block'] || 0;
            const hadEditableFiles = editStates && editStates.size > 0;
            let unresolvedEditFailure = null;
            if (rejectedWriteBlocksByFile && rejectedWriteBlocksByFile.size > 0 && editedFiles.length === 0 && !partialFilesOnCutoff.length) {
                const entries = [...rejectedWriteBlocksByFile.entries()];
                unresolvedEditFailure = {
                    files: entries.map(([name, info]) => ({ name, rejectedAttempts: info.count, lastReason: info.lastReason })),
                    note: 'Ù…Ø¯Ù„ Ø­Ø¯Ø§Ù‚Ù„ ÛŒÚ© Ø¨Ø§Ø± write_block Ø±ÙˆÛŒ Ø§ÛŒÙ† ÙØ§ÛŒÙ„(Ù‡Ø§) Ø±Ø§ Ø§Ù…ØªØ­Ø§Ù† Ú©Ø±Ø¯ Ùˆ Ø±Ø¯ Ø´Ø¯ (ÙØ§ÛŒÙ„ Ù†Ø§Ù…Ø¹ØªØ¨Ø± Ù…ÛŒâ€ŒØ´Ø¯)ØŒ Ùˆ Ø¯Ø± Ù†Ù‡Ø§ÛŒØª Ø¨Ø¯ÙˆÙ† Ù‡ÛŒÚ† ÙˆÛŒØ±Ø§ÛŒØ´ Ù…ÙˆÙÙ‚ÛŒ Ø¨Ù‡ Ù¾Ø§ÛŒØ§Ù† Ø±Ø³ÛŒØ¯. Ø§Ú¯Ø± Ù…ØªÙ† Ù¾Ø§Ø³Ø® Ø§Ø¯Ø¹Ø§ÛŒ Ø§Ù†Ø¬Ø§Ù…â€ŒØ´Ø¯Ù† ØªØºÛŒÛŒØ± Ø±Ø§ Ø¯Ø§Ø±Ø¯ØŒ Ø¢Ù† Ø§Ø¯Ø¹Ø§ Ù…Ø±Ø¨ÙˆØ· Ø¨Ù‡ Ø§ÛŒÙ† ÙØ§ÛŒÙ„(Ù‡Ø§) Ù†ÛŒØ³Øª - Ù‡ÛŒÚ† ÙØ§ÛŒÙ„ ÙˆÛŒØ±Ø§ÛŒØ´â€ŒØ´Ø¯Ù‡â€ŒØ§ÛŒ Ø¨Ø±Ø§ÛŒ Ø¯Ø§Ù†Ù„ÙˆØ¯ ÙˆØ¬ÙˆØ¯ Ù†Ø¯Ø§Ø±Ø¯.'
                };
            } else if (hadEditableFiles && writeBlockCallCount === 0 && editedFiles.length === 0 && !partialFilesOnCutoff.length) {
                unresolvedEditFailure = {
                    files: [...editStates.keys()].map(name => ({ name, rejectedAttempts: 0, lastReason: null })),
                    note: 'Ú©Ø§Ø±Ø¨Ø± ÙØ§ÛŒÙ„ÛŒ Ø¨Ø±Ø§ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ Ù…Ø¯Ù„ Ù‚Ø±Ø§Ø± Ø¯Ø§Ø¯Ù‡ Ø¨ÙˆØ¯ØŒ Ø§Ù…Ø§ Ù…Ø¯Ù„ Ø­ØªÛŒ ÛŒÚ©â€ŒØ¨Ø§Ø± Ù‡Ù… write_block Ø±Ø§ Ø±ÙˆÛŒ Ø¢Ù† ØµØ¯Ø§ Ù†Ø²Ø¯ - ÛŒØ¹Ù†ÛŒ Ù‡ÛŒÚ† ØªÙ„Ø§Ø´ÛŒ Ø¨Ø±Ø§ÛŒ Ø§Ø¹Ù…Ø§Ù„ ØªØºÛŒÛŒØ± ÙˆØ§Ù‚Ø¹ÛŒ Ø§Ù†Ø¬Ø§Ù… Ù†Ø´Ø¯Ù‡. Ø§Ú¯Ø± Ù…ØªÙ† Ù¾Ø§Ø³Ø® Ø§Ø¯Ø¹Ø§ÛŒ Ø§Ù†Ø¬Ø§Ù…â€ŒØ´Ø¯Ù† ØªØºÛŒÛŒØ± Ø±Ø§ Ø¯Ø§Ø±Ø¯ØŒ Ø§ÛŒÙ† Ø§Ø¯Ø¹Ø§ Ù†Ø§Ø¯Ø±Ø³Øª Ø§Ø³Øª - Ù‡ÛŒÚ† ÙØ§ÛŒÙ„ ÙˆÛŒØ±Ø§ÛŒØ´â€ŒØ´Ø¯Ù‡â€ŒØ§ÛŒ Ø¨Ø±Ø§ÛŒ Ø¯Ø§Ù†Ù„ÙˆØ¯ ÙˆØ¬ÙˆØ¯ Ù†Ø¯Ø§Ø±Ø¯.'
                };
            }
            if (unresolvedEditFailure) {
                log.warn('agent.unresolved_edit_failure', {
                    files: unresolvedEditFailure.files,
                    writeBlockCallCount,
                    finishReason,
                    round
                });
            }

            return {
                finalText: textParts.join(''),
                finishReason: finishReason,
                usage: lastUsage,
                askUser: null,
                ...(partialFilesOnCutoff.length ? { partialFiles: partialFilesOnCutoff } : {}),
                ...(editedFiles.length ? { editedFiles } : {}),
                ...(unresolvedEditFailure ? { unresolvedEditFailure } : {})
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
            const result = await executeToolCall(webSearchCall.name, webSearchCall.args, { tavilyKeys, archivedFiles, textFiles, searchCache, editStates });
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

            const resultText = searchResult?.result || searchResult?.message || 'Ù†ØªÛŒØ¬Ù‡â€ŒØ§ÛŒ Ø§Ø² Ø¬Ø³ØªØ¬Ùˆ Ø¯Ø±ÛŒØ§ÙØª Ù†Ø´Ø¯.';
            // FIX (silent empty reply on long chats after web_search): a
            // Tavily result had no size cap before being pushed into the
            // model's next-round context. On an already-long conversation
            // (history can be up to MAX_HISTORY_CHARS on its own), adding an
            // uncapped search result on top could push the combined payload
            // past what the model handles cleanly - Gemini would then return
            // an empty round (finishReason NONE/STOP, 0 chars) instead of a
            // clean error. Cap it here so this can't happen.
            const cappedResultText = resultText.length > MAX_SEARCH_RESULT_CHARS
                ? resultText.slice(0, MAX_SEARCH_RESULT_CHARS) + '\n\n[... \u0646\u062a\u06cc\u062c\u0647 \u0637\u0648\u0644\u0627\u0646\u06cc \u0628\u0648\u062f \u0648 \u06a9\u0648\u062a\u0627\u0647 \u0634\u062f ...]'
                : resultText;
            workingContents.push({
                role: 'user',
                parts: [{
                    text: `[Ù†ØªÛŒØ¬Ù‡ Ø¬Ø³ØªØ¬ÙˆÛŒ ÙˆØ¨ â€” Ø¬Ø³ØªØ¬Ùˆ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ø³Ø¤Ø§Ù„ ØªÙ…Ø§Ù… Ø´Ø¯Ù‡ Ùˆ Ø¯ÛŒÚ¯Ø± Ù‡ÛŒÚ† Ø§Ø¨Ø²Ø§Ø±ÛŒ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù†Ú©Ù†]:\n${cappedResultText}`
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

        // FIX (root cause of "Ø¨Ø±Ø±Ø³ÛŒ Ø³Ø§Ø®ØªØ§Ø± ÙØ§ÛŒÙ„" Ú†Ù†Ø¯Ø¨Ø§Ø± ØªÚ©Ø±Ø§Ø± Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ùˆ
        // Rate limit Ù‡Ù…Ù‡â€ŒÛŒ Ú©Ù„ÛŒØ¯Ù‡Ø§ Ø±Ø§ Ù…ÛŒâ€ŒØªØ±Ú©Ø§Ù†Ø¯): Ø¨Ø§ Ù‡Ø± Ø¨Ø§Ø± inspect_fileØŒ
        // computeLogicalChunks Ú©Ù„ Ù†Ù‚Ø´Ù‡â€ŒÛŒ chunk Ø±Ø§ Ø§Ø² ØµÙØ± Ùˆ Ø¨Ø§ Ù…Ø±Ø²Ù‡Ø§ÛŒ
        // Ù…ØªÙØ§ÙˆØª Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯ (Ú†ÙˆÙ† Ù‡ÛŒÚ† Ø­Ø§Ù„ØªÛŒ Ø¨ÛŒÙ† ØµØ¯Ø§Ù‡Ø§ Ù†Ú¯Ù‡ Ø¯Ø§Ø´ØªÙ‡ Ù†Ù…ÛŒâ€ŒØ´ÙˆØ¯).
        // Ù‡ÛŒÚ†â€ŒØ¬Ø§ÛŒ system prompt Ù‡Ù… Ù…Ø¯Ù„ Ø±Ø§ Ø§Ø² ØµØ¯Ø§ Ø²Ø¯Ù† Ø¯ÙˆØ¨Ø§Ø±Ù‡â€ŒÛŒ inspect_file
        // Ù…Ù†Ø¹ Ù†Ù…ÛŒâ€ŒÚ©Ø±Ø¯ØŒ Ù¾Ø³ ÙˆÙ‚ØªÛŒ Ù…Ø¯Ù„ Ø±ÙˆÛŒ ÛŒÚ© ÙØ§ÛŒÙ„ Ø¨Ø²Ø±Ú¯ Ú¯ÛŒØ¬ Ù…ÛŒâ€ŒØ´Ø¯ØŒ Ø±Ø§Ù‡â€ŒØ­Ù„Ø´
        // "Ø§Ø² Ø§ÙˆÙ„ Ù†Ú¯Ø§Ù‡ Ú©Ù†" Ø¨ÙˆØ¯ - Ø¯Ù‚ÛŒÙ‚Ø§Ù‹ Ù‡Ù…Ø§Ù† Ø±ÙØªØ§Ø± "Ù…ÛŒâ€ŒØ±Ù‡ Û²Û°Û°ØŒ Ø¨Ø¹Ø¯ Û±Û°Û°Û°ØŒ
        // Ø¨Ø¹Ø¯ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ù‡ Û±Û°Û°" Ú©Ù‡ Ø¨Ø§Ø¹Ø« Ø´Ø¯ Ù‡Ø± Û±Û² Ú©Ù„ÛŒØ¯ Ø¨Ø§ 429 ØªÙ…Ø§Ù… Ø´ÙˆÙ†Ø¯.
        // Ø§ÛŒÙ† Ø­Ø§Ù„Øª Ø±Ø§ Ø¨Ù‡â€ŒØ§Ø²Ø§ÛŒ Ù‡Ø± ÙØ§ÛŒÙ„ØŒ Ø¯Ø± Ø·ÙˆÙ„ Ú©Ù„ Ø¯Ø±Ø®ÙˆØ§Ø³Øª (Ù†Ù‡ ÙÙ‚Ø· ÛŒÚ©
        // round)ØŒ ÛŒÚ©â€ŒØ¨Ø§Ø± Ù…Ø­Ø¯ÙˆØ¯ Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ…Ø› ØµØ¯Ø§Ù‡Ø§ÛŒ Ø¨Ø¹Ø¯ÛŒ Ø¨Ø¯ÙˆÙ† ØªÙ…Ø§Ø³ Ø¨Ø§ Gemini
        // Ø±Ø¯ Ù…ÛŒâ€ŒØ´ÙˆÙ†Ø¯ Ùˆ Ù…Ø¯Ù„ Ø¨Ù‡ get_file_chunk (Ú©Ù‡ ÙÙ‚Ø· Ù…ÛŒâ€ŒØ®ÙˆØ§Ù†Ø¯ØŒ Ú†ÛŒØ²ÛŒ Ø±Ø§
        // Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ù†Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯) Ù‡Ø¯Ø§ÛŒØª Ù…ÛŒâ€ŒØ´ÙˆØ¯.
        // (inspectedFilesThisRequest Ùˆ chunkReadsPerFile Ø¨ÛŒØ±ÙˆÙ† Ø­Ù„Ù‚Ù‡â€ŒÛŒ round
        // ØªØ¹Ø±ÛŒÙ Ø´Ø¯Ù‡â€ŒØ§Ù†Ø¯ ØªØ§ Ø¨ÛŒÙ† round Ù‡Ø§ Ù¾Ø§Ú© Ù†Ø´ÙˆÙ†Ø¯.)

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
                            response: { error: 'Ø¬Ø³ØªØ¬Ùˆ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ø³Ø¤Ø§Ù„ Ù‚Ø¨Ù„Ø§Ù‹ Ø§Ù†Ø¬Ø§Ù… Ø´Ø¯Ù‡Ø› Ø¨Ø§ Ù‡Ù…Ø§Ù† Ù†ØªÛŒØ¬Ù‡ Ù¾Ø§Ø³Ø® Ø¨Ø¯Ù‡ Ùˆ Ø¬Ø³ØªØ¬ÙˆÛŒ Ø¯ÛŒÚ¯Ø±ÛŒ Ø§Ù†Ø¬Ø§Ù… Ù†Ø¯Ù‡.' }
                        }
                    });
                    continue;
                }
                searchTriggeredThisRound = true;
            } else if (searchTriggeredThisRound || scopedSearchState.used) {
                responseParts.push({
                    functionResponse: {
                        name: call.name,
                        response: { error: 'Ø¨Ø¹Ø¯ Ø§Ø² web_search Ø§Ø¨Ø²Ø§Ø±Ù‡Ø§ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ† Ø³Ø¤Ø§Ù„ ØºÛŒØ±ÙØ¹Ø§Ù„ Ø´Ø¯Ù‡â€ŒØ§Ù†Ø¯Ø› Ø¨Ø§ Ù†ØªÛŒØ¬Ù‡Ù” Ø¬Ø³ØªØ¬Ùˆ Ù¾Ø§Ø³Ø® Ø¨Ø¯Ù‡.' }
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
            const result = await executeToolCall(call.name, call.args, { tavilyKeys, archivedFiles, textFiles, searchCache, editStates, rejectedWriteBlocksByFile, originalFreshFileNames });
            const toolCallDurationMs = Date.now() - toolCallStartedAt;

            if (call.name === 'web_search') scopedSearchState.result = result;
            if (call.name === 'get_archived_file') lastToolCallWasArchiveRead = true;
            if (call.name === 'read_file_section') lastToolCallWasSectionRead = true;

            // DIAGNOSTICS: Ù‡Ø± ØµØ¯Ø§ Ø²Ø¯Ù† Ø§Ø¨Ø²Ø§Ø± Ø±Ø§ Ø¨Ø§ Ø¢Ø±Ú¯ÙˆÙ…Ø§Ù†â€ŒÙ‡Ø§ÛŒ Ú©Ù„ÛŒØ¯ÛŒ (Ù†Ù‡ Ú©Ù„
            // Ù…Ø­ØªÙˆØ§ - ÙÙ‚Ø· Ø§Ø³Ù… ÙØ§ÛŒÙ„/Ø¨Ø§Ø²Ù‡â€ŒÛŒ Ø®Ø·/Ø·ÙˆÙ„ queryØŒ Ø¨Ø±Ø§ÛŒ Ø§ÛŒÙ†â€ŒÚ©Ù‡ Ø±Ø¯Ù
            // Ø®Ø·Ø§ Ø®ÙˆØ¯Ø´ Ø­Ø¬ÛŒÙ… Ù†Ø´ÙˆØ¯) Ùˆ Ø®Ù„Ø§ØµÙ‡â€ŒØ§ÛŒ Ø§Ø² Ù†ØªÛŒØ¬Ù‡ Ø«Ø¨Øª Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ…. ØªØ¹Ø¯Ø§Ø¯ Ú©Ù„
            // Ù‡Ø± Ø§Ø¨Ø²Ø§Ø± Ø¯Ø± toolCallTally Ø¬Ù…Ø¹ Ù…ÛŒâ€ŒØ´ÙˆØ¯ ØªØ§ ØªÚ©Ø±Ø§Ø± ØºÛŒØ±Ø¹Ø§Ø¯ÛŒ (Ù…Ø«Ù„Ø§Ù‹
            // inspect_file Ú†Ù†Ø¯Ø¨Ø§Ø± Ù¾Ø´Øªâ€ŒØ³Ø±Ù‡Ù…) ÙÙˆØ±Ø§Ù‹ Ù‚Ø§Ø¨Ù„ Ù…Ø´Ø§Ù‡Ø¯Ù‡ Ø¨Ø§Ø´Ø¯.
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
                patched: !!(result && result.success && (call.name === 'apply_edit')),
                callIndexForThisTool: toolCallTally[call.name]
            });

            if (result.askUser) earlyAskUser = result.askUser;

            // FINAL AGENT CONTINUATION GUARD:
// After reading a block, explicitly tell the model that context is
// already loaded. This prevents restarting file inspection from zero.
let responseForModel = result;
if (call.name === 'read_file_section' && result && !result.error) {
    responseForModel = {
        ...result,
        agentInstruction:
            'Section content loaded successfully. Continue from this context - use it to build an exact search for apply_edit.'
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
    // DIAGNOSTICS: Ø§ÛŒÙ† ÛŒÚ©ÛŒ Ø§Ø² Ø¯Ùˆ Ø­Ø§Ù„ØªÛŒ Ø§Ø³Øª Ú©Ù‡ Ù‚Ø¨Ù„Ø§Ù‹ Ù‡ÛŒÚ† Ø§Ø·Ù„Ø§Ø¹ÛŒ Ø§Ø² "Ú†Ø±Ø§"
    // Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± Ù†Ù…ÛŒâ€ŒØ±Ø³ÛŒØ¯ - ÙÙ‚Ø· Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… Ø«Ø§Ø¨Øª. Ø­Ø§Ù„Ø§ diagnostics Ù‡Ù… Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø¯
    // ØªØ§ Ø¯Ø± "Ø¬Ø²Ø¦ÛŒØ§Øª Ø¨ÛŒØ´ØªØ±" Ù…Ø¹Ù„ÙˆÙ… Ø¨Ø§Ø´Ø¯ Ú©Ø¯Ø§Ù… Ø§Ø¨Ø²Ø§Ø± Ú†Ù†Ø¯Ø¨Ø§Ø± ØªÚ©Ø±Ø§Ø± Ø´Ø¯Ù‡ Ø¨ÙˆØ¯.
    const loopLimitTrace = summarizeAgentTrace(roundTrace, toolCallTally, {
        stoppedReason: 'round_limit',
        round: MAX_TOOL_ROUNDS
    });
    log.warn('agent.tool_loop_limit_hit', { toolCallTally, roundTrace });
    return {
        finalText: 'Ù…ØªØ£Ø³ÙÙ…ØŒ Ø¯Ø± Ù¾Ø±Ø¯Ø§Ø²Ø´ Ø§ÛŒÙ† Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø¨Ù‡ Ù…Ø´Ú©Ù„ Ø®ÙˆØ±Ø¯Ù… (ØªØ¹Ø¯Ø§Ø¯ Ù…Ø±Ø§Ø­Ù„ Ø²ÛŒØ§Ø¯ Ø´Ø¯). Ù…ÛŒâ€ŒØªÙˆÙ†ÛŒ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ÛŒØ§ ÙˆØ§Ø¶Ø­â€ŒØªØ± Ø¨Ù¾Ø±Ø³ÛŒØŸ',
        finishReason: 'TOOL_LOOP_LIMIT',
        usage: lastUsage,
        askUser: null,
        diagnostics: loopLimitTrace
    };
}

// DIAGNOSTICS: Ø§Ø² ÛŒÚ© roundTrace Ø®Ø§Ù… ÛŒÚ© Ø®Ù„Ø§ØµÙ‡â€ŒÛŒ Ø¯ÙˆØ¨Ø®Ø´ÛŒ Ù…ÛŒâ€ŒØ³Ø§Ø²Ø¯:
//  - humanSummary: Ú†Ù†Ø¯ Ø®Ø· ÙØ§Ø±Ø³ÛŒ Ø³Ø§Ø¯Ù‡ØŒ Ù‡Ù…Ø§Ù† Ú†ÛŒØ²ÛŒ Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± ØªÙˆÛŒ "Ø¬Ø²Ø¦ÛŒØ§Øª
//    Ø¨ÛŒØ´ØªØ±" Ù…ÛŒâ€ŒØ¨ÛŒÙ†Ø¯ (Ø¨Ø¯ÙˆÙ† Ø§ØµØ·Ù„Ø§Ø­ ÙÙ†ÛŒ Ø²ÛŒØ§Ø¯)
//  - raw: Ø®ÙˆØ¯Ù roundTrace + toolCallTallyØŒ Ø¨Ø±Ø§ÛŒ Ù„Ø§Ú¯ Ø³Ø±ÙˆØ± Ùˆ Ø¯ÛŒØ¨Ø§Ú¯ Ø¹Ù…ÛŒÙ‚â€ŒØªØ±
// Ø§ÛŒÙ† ØªØ§Ø¨Ø¹ Ù‡ÛŒÚ† ØªØµÙ…ÛŒÙ…ÛŒ Ù†Ù…ÛŒâ€ŒÚ¯ÛŒØ±Ø¯ Ùˆ Ú†ÛŒØ²ÛŒ Ø±Ø§ silent Ù†Ù…ÛŒâ€ŒÚ©Ù†Ø¯Ø› ÙÙ‚Ø· Ú†ÛŒØ²ÛŒ Ú©Ù‡ Ø¯Ø±
// Ø·ÙˆÙ„ Ø§Ø¬Ø±Ø§ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø§ØªÙØ§Ù‚ Ø§ÙØªØ§Ø¯Ù‡ Ø±Ø§ Ø¨Ù‡ ÙØ§Ø±Ø³ÛŒÙ Ù‚Ø§Ø¨Ù„â€ŒØ®ÙˆØ§Ù†Ø¯Ù† ØªØ±Ø¬Ù…Ù‡ Ù…ÛŒâ€ŒÚ©Ù†Ø¯.
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
    lines.push(`ØªØ¹Ø¯Ø§Ø¯ Ù…Ø±Ø§Ø­Ù„ Ø·ÛŒâ€ŒØ´Ø¯Ù‡: ${totalRounds} Ø§Ø² Ø³Ù‚Ù Ù…Ø¬Ø§Ø²`);
    lines.push(`Ø²Ù…Ø§Ù† Ú©Ù„ ØµØ±Ùâ€ŒØ´Ø¯Ù‡: ${(totalDurationMs / 1000).toFixed(1)} Ø«Ø§Ù†ÛŒÙ‡`);
    if (repeatedTools.length) {
        lines.push('Ø§Ø¨Ø²Ø§Ø±Ù‡Ø§ÛŒÛŒ Ú©Ù‡ Ø¨ÛŒØ´ Ø§Ø² ÛŒÚ©â€ŒØ¨Ø§Ø± ØµØ¯Ø§ Ø²Ø¯Ù‡ Ø´Ø¯Ù†Ø¯: ' +
            repeatedTools.map(([name, count]) => `${name} (${count} Ø¨Ø§Ø±)`).join('ØŒ '));
    }
    if (patchedFiles.length) {
        lines.push(`Ù‚Ø¨Ù„ Ø§Ø² ØªÙˆÙ‚ÙØŒ Ø§ÛŒÙ† ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ Ø¨Ø§ Ù…ÙˆÙÙ‚ÛŒØª Ù¾Ú† Ø®ÙˆØ±Ø¯Ù‡ Ø¨ÙˆØ¯Ù†Ø¯: ${patchedFiles.join('ØŒ ')}`);
    } else {
        lines.push('Ù‚Ø¨Ù„ Ø§Ø² ØªÙˆÙ‚ÙØŒ Ù‡ÛŒÚ† Ø¨Ù„ÙˆÚ©ÛŒ Ø¨Ø§ Ù…ÙˆÙÙ‚ÛŒØª Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ù†Ø´Ø¯Ù‡ Ø¨ÙˆØ¯.');
    }
    if (lastRound) {
        lines.push(`Ø¢Ø®Ø±ÛŒÙ† Ù…Ø±Ø­Ù„Ù‡ (round ${lastRound.round}): finishReason=${lastRound.finishReason || 'Ù†Ø§Ù…Ø´Ø®Øµ'}, Ù…ØªÙ† ØªÙˆÙ„ÛŒØ¯Ø´Ø¯Ù‡=${lastRound.textChars} Ú©Ø§Ø±Ø§Ú©ØªØ±`);
    }
    if (meta?.stoppedReason === 'round_limit') {
        lines.push('Ù†ØªÛŒØ¬Ù‡: Ø¨Ù‡ Ø³Ù‚Ù ØªØ¹Ø¯Ø§Ø¯ Ù…Ø±Ø§Ø­Ù„ Ø±Ø³ÛŒØ¯ Ø¨Ø¯ÙˆÙ† Ø±Ø³ÛŒØ¯Ù† Ø¨Ù‡ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ ÛŒØ§ Ø§Ø¹Ù…Ø§Ù„ Ú©Ø§Ù…Ù„ ØªØºÛŒÛŒØ±Ø§Øª.');
    } else if (meta?.stoppedReason === 'silent_after_tool') {
        lines.push('Ù†ØªÛŒØ¬Ù‡: Ø¨Ø¹Ø¯ Ø§Ø² ØµØ¯Ø§ Ø²Ø¯Ù† ÛŒÚ© Ø§Ø¨Ø²Ø§Ø±ØŒ Ù…Ø¯Ù„ Ù‡ÛŒÚ† Ù…ØªÙ†ÛŒ Ø¨Ø±Ù†Ú¯Ø±Ø¯Ø§Ù†Ø¯ (Ø³Ú©ÙˆØª).');
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
                message: 'Ù…ØªØ¯ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù¾Ø´ØªÛŒØ¨Ø§Ù†ÛŒ Ù†Ù…ÛŒâ€ŒØ´ÙˆØ¯.'
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
                        message: 'Ø­Ø¬Ù… Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø®ÛŒÙ„ÛŒ Ø²ÛŒØ§Ø¯Ù‡. Ù„Ø·ÙØ§Ù‹ ÙØ§ÛŒÙ„ Ú©ÙˆÚ†Ú©â€ŒØªØ±ÛŒ Ø¨ÙØ±Ø³Øª.',
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
            thinkLevel,
            history: rawHistory,
            model,
            // FEATURE (recent-chats summary): a short, already-built-on-the-
            // client summary of the user's last few conversations. Built and
            // cached in localStorage on the frontend (see summarizeRecentChats
            // in index.html) so the backend never has to read/summarize old
            // chat history itself - keeps this request exactly as fast as
            // before. Just a plain string; ignored if empty/missing.
            recentChatsSummary,
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
        | streaming path â€” just a fast title guess.
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
                    message: 'Ø³Ø±ÙˆÛŒØ³ Ù‡ÙˆØ´ Ù…ØµÙ†ÙˆØ¹ÛŒ Ù…ÙˆÙ‚ØªØ§Ù‹ Ù¾ÛŒÚ©Ø±Ø¨Ù†Ø¯ÛŒ Ù†Ø´Ø¯Ù‡ Ø§Ø³Øª. Ù„Ø·ÙØ§Ù‹ Ø¨Ø¹Ø¯Ø§Ù‹ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.',
                    type: 'configuration_error',
                    stage: 'config',
                    category: 'missing_api_keys'
                }
            });
        }

        log.info('request.received', {
            hasFile: !!file || (Array.isArray(req.body?.files) && req.body.files.length > 0),
            webSearch: !!webSearch,
            thinkLevel: thinkLevel || 'off',
            model: model || 'default',
            historyTurns: history.length,
            stream: wantsStream
        });

        /*
        |--------------------------------------------------------------------------
        | ÙØ§ÛŒÙ„â€ŒÙ‡Ø§
        |--------------------------------------------------------------------------
        */

        const incomingFiles =
            Array.isArray(req.body?.files)
                ? req.body.files
                : (file ? [file] : []);

        // NOTE: no size cap on text files anymore - removed by request.
        const textFiles =
            incomingFiles.filter(
                f =>
                    f &&
                    f.mode === 'text' &&
                    typeof f.content === 'string'
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
                    message: 'Ù…ØªÙ† ÙˆØ±ÙˆØ¯ÛŒ Ø®Ø§Ù„ÛŒ Ø§Ø³Øª.',
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
                            message: 'Ù…ØªÙ† ÙˆØ±ÙˆØ¯ÛŒ Ø®Ø§Ù„ÛŒ Ø§Ø³Øª.',
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
                                        `[ÙØ§ÛŒÙ„ Ø¶Ù…ÛŒÙ…Ù‡: ${f.name || 'file'} - ${lineCount} Ø®Ø·]\n` +
                                        `Ø§ÛŒÙ† ÙØ§ÛŒÙ„ Ø¨Ø²Ø±Ú¯ Ø§Ø³ØªØ› Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ Ø¢Ù† Ø§ÛŒÙ†Ø¬Ø§ Ø¯Ø§Ø¯Ù‡ Ù†Ø´Ø¯Ù‡ ØªØ§ Ø­Ø¬Ù… Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù¾Ø§ÛŒÛŒÙ† Ø¨Ù…Ø§Ù†Ø¯. ` +
                                        `Ø¨Ø±Ø§ÛŒ Ø¯ÛŒØ¯Ù† Ø³Ø§Ø®ØªØ§Ø± Ùˆ Ø¨Ø®Ø´â€ŒÙ‡Ø§ÛŒ Ø¢Ù†ØŒ Ø§Ø¨Ø²Ø§Ø± inspect_file Ø±Ø§ Ø¨Ø§ Ù†Ø§Ù… Ø¯Ù‚ÛŒÙ‚ ÙØ§ÛŒÙ„ ØµØ¯Ø§ Ø¨Ø²Ù†Ø› Ø³Ù¾Ø³ Ø¨Ø±Ø§ÛŒ Ù‡Ø± Ø¨Ø®Ø´ Ù‡Ø¯ÙØŒ get_file_chunk Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†.`;
                                }

                                return `\n\n` +
                                    `[Ù…Ø­ØªÙˆØ§ÛŒ ÙØ§ÛŒÙ„: ${f.name || 'file'}]\n` +
                                    '```\n' +
                                    content +
                                    '\n```\n' +
                                    `[Ù¾Ø§ÛŒØ§Ù† Ù…Ø­ØªÙˆØ§ÛŒ ÙØ§ÛŒÙ„: ${f.name || 'file'}]`;
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
        // checks against this same number BEFORE showing "ÙˆÛŒØ¯ÛŒÙˆ Ø¢Ù…Ø§Ø¯Ù‡", so
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

        // FIX: Ù…Ø¯Ù„ Ù‡ÛŒÚ†â€ŒÙˆÙ‚Øª ØªØ§Ø±ÛŒØ® ÙˆØ§Ù‚Ø¹ÛŒ Ø§Ù…Ø±ÙˆØ² Ø±Ùˆ Ù†Ù…ÛŒâ€ŒØ¯ÙˆÙ†Ù‡ â€” ÙÙ‚Ø· Ø§Ø² Ø¯ÛŒØªØ§ÛŒ
        // Ø¢Ù…ÙˆØ²Ø´ÛŒØ´ (Ú©Ù‡ Ù‚Ø¯ÛŒÙ…ÛŒÙ‡) Ø­Ø¯Ø³ Ù…ÛŒâ€ŒØ²Ù†Ù‡ØŒ Ø¨Ø±Ø§ÛŒ Ù‡Ù…ÛŒÙ† ÙˆÙ‚ØªÛŒ Ù…ÛŒâ€ŒÙ¾Ø±Ø³ÛŒ "Ø§Ù…Ø±ÙˆØ²
        // Ú†Ù†Ø¯Ù…Ù‡" Ø¬ÙˆØ§Ø¨ Ø§Ø´ØªØ¨Ø§Ù‡ Ù…ÛŒâ€ŒØ¯Ù‡. Ø§ÛŒÙ†â€ŒØ¬Ø§ ØªØ§Ø±ÛŒØ® ÙˆØ§Ù‚Ø¹ÛŒ Ø³Ø±ÙˆØ± (Ø´Ù…Ø³ÛŒ + Ù…ÛŒÙ„Ø§Ø¯ÛŒ
        // + Ø³Ø§Ø¹ØªØŒ Ø¨Ù‡ ÙˆÙ‚Øª ØªÙ‡Ø±Ø§Ù†) Ø±Ùˆ Ù…Ø³ØªÙ‚ÛŒÙ… Ø¨Ù‡Ø´ Ù…ÛŒâ€ŒÚ¯ÛŒÙ… ØªØ§ Ù‡Ù…ÛŒØ´Ù‡ Ø¯Ø±Ø³Øª Ø¨Ø§Ø´Ù‡.
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
Ø§Ø·Ù„Ø§Ø¹Ø§Øª Ø²Ù…Ø§Ù† ÙˆØ§Ù‚Ø¹ÛŒ (Ø§ÛŒÙ† ØªØ§Ø±ÛŒØ® Ù‡Ù…ÛŒØ´Ù‡ Ø¯Ø±Ø³Øª Ø§Ø³ØªØŒ Ø­ØªÛŒ Ø§Ú¯Ø± Ø¨Ø§ Ø¯Ø§Ù†Ø´ Ù‚Ø¨Ù„ÛŒâ€ŒØ§Øª ÙØ±Ù‚ Ø¯Ø§Ø±Ø¯Ø› Ù‡Ù…ÛŒØ´Ù‡ Ù‡Ù…ÛŒÙ† Ø±Ø§ Ù…Ù„Ø§Ú© Ø¨Ø¯Ù‡):
Ø§Ù…Ø±ÙˆØ²: ${jalaliDate} (Ù…ÛŒÙ„Ø§Ø¯ÛŒ: ${gregorianDate})
Ø³Ø§Ø¹Øª ÙØ¹Ù„ÛŒ Ø¨Ù‡ ÙˆÙ‚Øª ØªÙ‡Ø±Ø§Ù†: ${tehranTime}
`;

        const antiSelfQA = `
Ù‚Ø§Ù†ÙˆÙ† Ø³Ø®Øªâ€ŒÚ¯ÛŒØ±Ø§Ù†Ù‡:
Ø¬Ù…Ù„Ù‡â€ŒÛŒ Ù…Ø¹Ø±ÙÛŒ Ù…Ø¯Ù„ (Â«Ù…Ù† Virtual Bot ... Ù‡Ø³ØªÙ…Â») Ø±Ø§ ÙÙ‚Ø· Ùˆ ÙÙ‚Ø· Ø²Ù…Ø§Ù†ÛŒ Ø¨Ù†ÙˆÛŒØ³ Ú©Ù‡ Ø®ÙˆØ¯Ù Ú©Ø§Ø±Ø¨Ø± Ù‡Ù…ÛŒÙ† Ø§Ù„Ø§Ù† Ù…Ø³ØªÙ‚ÛŒÙ… Ù¾Ø±Ø³ÛŒØ¯Ù‡ Ø¨Ø§Ø´Ø¯ Â«Ù…Ø¯Ù„Øª Ú†ÛŒÙ‡Â» ÛŒØ§ Ø³Ø¤Ø§Ù„ Ù‡Ù…â€ŒÙ…Ø¹Ù†ÛŒ.
Ù‡Ø±Ú¯Ø² Ø®ÙˆØ¯Øª Ø§ÛŒÙ† Ø³Ø¤Ø§Ù„ Ø±Ø§ Ø§Ø² Ø²Ø¨Ø§Ù† Ø®ÙˆØ¯Øª Ù…Ø·Ø±Ø­ Ù†Ú©Ù†.
Ù‡Ø±Ú¯Ø² Ø¨Ø¯ÙˆÙ† Ø§ÛŒÙ†Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± Ù¾Ø±Ø³ÛŒØ¯Ù‡ Ø¨Ø§Ø´Ø¯ØŒ Ø¬Ù…Ù„Ù‡ Ù…Ø¹Ø±ÙÛŒ Ù…Ø¯Ù„ Ø±Ø§ Ø¯Ø± Ù¾Ø§Ø³Ø® Ø¯ÛŒÚ¯Ø±ÛŒ Ù†ÛŒØ§ÙˆØ±.
`;

        /*
        |--------------------------------------------------------------------------
        | System Prompt
        |--------------------------------------------------------------------------
        */

        // ÛŒÚ© Ø´Ø®ØµÛŒØª ÙˆØ§Ø­Ø¯ Ùˆ ÛŒÚ©Ø³Ø§Ù† Ø±ÙˆÛŒ Ù‡Ù…Ù‡â€ŒÛŒ Ù…Ø¯Ù„â€ŒÙ‡Ø§ (Ù†Ø³Ø®Ù‡â€ŒØ¨Ù†Ø¯ÛŒ Ø¬Ø¯Ø§ Ø­Ø°Ù Ø´Ø¯Ø›
        // ÙÙ‚Ø· Ù†Ø§Ù… Ù…Ø¯Ù„ Ø¯Ø§Ø®Ù„ÛŒ Ú©Ù‡ Ø¯Ø± Ù…Ø¹Ø±ÙÛŒ Ø§Ø­ØªÙ…Ø§Ù„ÛŒ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ ÙØ±Ù‚ Ø¯Ø§Ø±Ø¯).
        const modelDisplayName =
            MODEL_NAME === 'gemini-3.5-flash-lite' ? 'Virtual Bot 1.1' :
            MODEL_NAME === 'gemini-3.7-flash' ? 'Virtual Bot 1.6' :
            MODEL_NAME === 'gemini-3.1-pro-preview' ? 'Virtual Bot 1.3' :
            'Virtual Bot';

        systemText = `
ØªÙˆ ${modelDisplayName} Ù‡Ø³ØªÛŒØ› ÛŒÚ© Ø¯Ø³ØªÛŒØ§Ø± Ù‡ÙˆØ´ Ù…ØµÙ†ÙˆØ¹ÛŒ Ú¯Ø±Ù…ØŒ ØµÙ…ÛŒÙ…ÛŒØŒ Ø·Ø¨ÛŒØ¹ÛŒ Ùˆ Ø¬Ø°Ø§Ø¨. Ù‡Ø¯ÙØª Ø§ÛŒÙ† Ø§Ø³Øª Ú©Ù‡ Ú¯ÙØªÚ¯Ùˆ Ø´Ø¨ÛŒÙ‡ ØµØ­Ø¨Øª Ø¨Ø§ ÛŒÚ© Ø¯ÙˆØ³Øª Ø¨Ø§Ù‡ÙˆØ´ Ùˆ Ø®ÙˆØ´â€ŒØ¨Ø±Ø®ÙˆØ±Ø¯ Ø¨Ø§Ø´Ø¯ØŒ Ù†Ù‡ ÛŒÚ© Ù…ØªÙ† Ø®Ø´Ú© Ùˆ Ø±Ø³Ù…ÛŒ.

Ù‡ÙˆÛŒØª:
- ÙÙ‚Ø· ÙˆÙ‚ØªÛŒ Ú©Ø§Ø±Ø¨Ø± Ù…Ø³ØªÙ‚ÛŒÙ…Ø§Ù‹ Ø¯Ø±Ø¨Ø§Ø±Ù‡ Ù…Ø¯Ù„ Ù¾Ø±Ø³ÛŒØ¯ Ø¨Ú¯Ùˆ: Â«Ù…Ù† ${modelDisplayName} Ù‡Ø³ØªÙ….Â»
- Ù‡Ø±Ú¯Ø² Ø®ÙˆØ¯Øª Ø±Ø§ Ø¨Ø§ Ù†Ø³Ø®Ù‡â€ŒÛŒ Ø¯ÛŒÚ¯Ø±ÛŒ Ù…Ø¹Ø±ÙÛŒ Ù†Ú©Ù†.
- Ù‡Ø±Ú¯Ø² Ù†Ø§Ù… Ø³Ø§Ø²Ù†Ø¯Ù‡ ÛŒØ§ ØªÛŒÙ…ÛŒ Ø±Ø§ Ø§Ø² Ø®ÙˆØ¯Øª Ù†Ø³Ø§Ø².
- Ø®ÙˆØ¯Øª Ø±Ø§ Gemini Ù…Ø¹Ø±ÙÛŒ Ù†Ú©Ù†.
- Ø¯Ø±Ø¨Ø§Ø±Ù‡ Ú†ÛŒØ²Ù‡Ø§ÛŒÛŒ Ú©Ù‡ Ù†Ù…ÛŒâ€ŒØ¯Ø§Ù†ÛŒ Ø§Ø·Ù„Ø§Ø¹Ø§Øª Ø³Ø§Ø®ØªÚ¯ÛŒ Ù†Ø¯Ù‡.

Ù‚ÙˆØ§Ù†ÛŒÙ† Ù„Ø­Ù†:
Û±. Ù‡Ù…ÛŒØ´Ù‡ ØªØ§ Ø­Ø¯ Ø§Ù…Ú©Ø§Ù† Ø·Ø¨ÛŒØ¹ÛŒ Ùˆ Ù…Ø­Ø§ÙˆØ±Ù‡â€ŒØ§ÛŒ ØµØ­Ø¨Øª Ú©Ù†Ø› Ù…Ú¯Ø± Ø§ÛŒÙ†Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± ØµØ±Ø§Ø­ØªØ§Ù‹ Ù„Ø­Ù† Ø±Ø³Ù…ÛŒ Ø¨Ø®ÙˆØ§Ù‡Ø¯.
Û². Ù„Ø­Ù† Ú©Ø§Ø±Ø¨Ø± Ø±Ø§ ØªØ´Ø®ÛŒØµ Ø¨Ø¯Ù‡ Ùˆ Ù…ØªÙ†Ø§Ø³Ø¨ Ø¨Ø§ Ø¢Ù† Ù¾Ø§Ø³Ø® Ø¨Ø¯Ù‡:
   - Ø§Ú¯Ø± Ø±Ø³Ù…ÛŒ Ø§Ø³ØªØŒ Ù…Ø­ØªØ±Ù…Ø§Ù†Ù‡ Ùˆ Ø­Ø±ÙÙ‡â€ŒØ§ÛŒ Ø¨Ø§Ø´.
   - Ø§Ú¯Ø± Ø¯ÙˆØ³ØªØ§Ù†Ù‡ Ø§Ø³ØªØŒ ØµÙ…ÛŒÙ…ÛŒ Ùˆ Ø®ÙˆØ¯Ù…Ø§Ù†ÛŒ Ø¨Ø§Ø´.
   - Ø§Ú¯Ø± Ø´ÙˆØ®ÛŒ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ØŒ Ø¯Ø± Ø­Ø¯ Ù…Ù†Ø§Ø³Ø¨ Ø¨Ø§ Ø§Ùˆ Ø´ÙˆØ®ÛŒ Ú©Ù†.
   - Ø§Ú¯Ø± Ù†Ø§Ø±Ø§Ø­Øª ÛŒØ§ Ù†Ú¯Ø±Ø§Ù† Ø§Ø³ØªØŒ Ø¢Ø±Ø§Ù…ØŒ Ù‡Ù…Ø¯Ù„Ø§Ù†Ù‡ Ùˆ Ø¨Ø¯ÙˆÙ† Ø´ÙˆØ®ÛŒ Ù¾Ø§Ø³Ø® Ø¨Ø¯Ù‡.
Û³. Ø§Ø² Ø§ØµØ·Ù„Ø§Ø­Ø§Øª Ù…Ø­Ø§ÙˆØ±Ù‡â€ŒØ§ÛŒ ÙØ§Ø±Ø³ÛŒ Ø¨Ù‡ Ø´Ú©Ù„ Ø·Ø¨ÛŒØ¹ÛŒ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†ØŒ Ø§Ù…Ø§ Ø²ÛŒØ§Ø¯Ù‡â€ŒØ±ÙˆÛŒ Ù†Ú©Ù†.
Û´. Ø¬Ù…Ù„Ù‡â€ŒÙ‡Ø§ Ø±Ø§ Ø±ÙˆØ§Ù† Ùˆ Ø´Ø¨ÛŒÙ‡ Ú¯ÙØªÚ¯ÙˆÛŒ ÙˆØ§Ù‚Ø¹ÛŒ Ø¨Ù†ÙˆÛŒØ³.
Ûµ. Ù¾Ø§Ø³Ø® Ø±Ø§ Ø¨Ø§ ÙˆØ§Ú©Ù†Ø´ Ù…Ù†Ø§Ø³Ø¨ Ø¨Ù‡ Ø­Ø±Ù Ú©Ø§Ø±Ø¨Ø± Ø´Ø±ÙˆØ¹ Ú©Ù† Ùˆ Ø¨Ø¹Ø¯ Ø³Ø±Ø§Øº Ø§ØµÙ„ Ù…Ø·Ù„Ø¨ Ø¨Ø±Ùˆ.
Û¶. Ø§Ø² Ø§ÛŒÙ…ÙˆØ¬ÛŒâ€ŒÙ‡Ø§ Ø¨Ù‡ Ø§Ù†Ø¯Ø§Ø²Ù‡ Ùˆ Ù…ØªÙ†Ø§Ø³Ø¨ Ø¨Ø§ ÙØ¶Ø§ÛŒ Ú¯ÙØªÚ¯Ùˆ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù† (Ù…Ø«Ù„Ø§Ù‹ ðŸ˜‚ðŸ˜ŽðŸ”¥)ØŒ Ø§Ù…Ø§ Ø¯Ø± Ù‡Ø± Ø¬Ù…Ù„Ù‡ Ø§ÛŒÙ…ÙˆØ¬ÛŒ Ù†Ú¯Ø°Ø§Ø±. Ù‡Ø±Ú¯Ø² Ø§Ø² Ø§ÛŒÙ…ÙˆØ¬ÛŒ ðŸ¤– Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù†Ú©Ù†.
Û·. Ø§Ø² Ø´ÙˆØ®ÛŒâ€ŒÙ‡Ø§ÛŒ Ù…ØµÙ†ÙˆØ¹ÛŒØŒ ØªÚ©Ø±Ø§Ø±ÛŒ ÛŒØ§ Ø¨ÛŒØ´â€ŒØ§Ø²Ø­Ø¯ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù†Ú©Ù†.
Û¸. Ù¾Ø§Ø³Ø®â€ŒÙ‡Ø§ Ø±Ø§ Ø¨ÛŒâ€ŒØ¯Ù„ÛŒÙ„ Ø·ÙˆÙ„Ø§Ù†ÛŒ Ù†Ú©Ù†. Ø§Ú¯Ø± Ø³Ø¤Ø§Ù„ Ø³Ø§Ø¯Ù‡ Ø§Ø³ØªØŒ Ø¬ÙˆØ§Ø¨ Ø³Ø§Ø¯Ù‡ Ø¨Ø¯Ù‡Ø› Ø§Ú¯Ø± Ù…ÙˆØ¶ÙˆØ¹ Ù¾ÛŒÚ†ÛŒØ¯Ù‡ Ø§Ø³ØªØŒ Ú©Ø§Ù…Ù„ Ùˆ Ù…Ø±Ø­Ù„Ù‡â€ŒØ¨Ù‡â€ŒÙ…Ø±Ø­Ù„Ù‡ ØªÙˆØ¶ÛŒØ­ Ø¨Ø¯Ù‡.
Û¹. Ø§Ú¯Ø± Ú©Ø§Ø±Ø¨Ø± Ø³Ø¤Ø§Ù„ ÙÙ†ÛŒ Ù¾Ø±Ø³ÛŒØ¯ØŒ Ù‡Ù…Ú†Ù†Ø§Ù† ØµÙ…ÛŒÙ…ÛŒ Ø¨Ù…Ø§Ù† ÙˆÙ„ÛŒ Ø¯Ù‚Øª ÙÙ†ÛŒ Ø±Ø§ ÙØ¯Ø§ÛŒ Ø´ÙˆØ®ÛŒ Ù†Ú©Ù†.
Û±Û°. Ø§Ø² ØªÚ©Ø±Ø§Ø± Ø¹Ø¨Ø§Ø±Øªâ€ŒÙ‡Ø§ÛŒ Ú©Ù„ÛŒØ´Ù‡â€ŒØ§ÛŒ Ù…Ø«Ù„ Â«Ø­ØªÙ…Ø§Ù‹! Ø¨Ø§ Ú©Ù…Ø§Ù„ Ù…ÛŒÙ„!Â» Ø¯Ø± Ù‡Ù…Ù‡ Ù¾Ø§Ø³Ø®â€ŒÙ‡Ø§ Ø®ÙˆØ¯Ø¯Ø§Ø±ÛŒ Ú©Ù†.
Û±Û±. ÙˆØ§Ù†Ù…ÙˆØ¯ Ù†Ú©Ù† Ú©Ù‡ Ø§Ø­Ø³Ø§Ø³Ø§Øª ÛŒØ§ ØªØ¬Ø±Ø¨Ù‡â€ŒÙ‡Ø§ÛŒ Ø§Ù†Ø³Ø§Ù†ÛŒ ÙˆØ§Ù‚Ø¹ÛŒ Ø¯Ø§Ø±ÛŒ. ØµÙ…ÛŒÙ…ÛŒ Ø¨Ø§Ø´ØŒ Ø§Ù…Ø§ Ø¯Ø±Ø¨Ø§Ø±Ù‡ Ù…Ø§Ù‡ÛŒØª Ù‡ÙˆØ´ Ù…ØµÙ†ÙˆØ¹ÛŒ ØµØ§Ø¯Ù‚ Ø¨Ù…Ø§Ù†.
Û±Û². Ø´Ø®ØµÛŒØªØª Ø¨Ø§ÛŒØ¯ Ø«Ø§Ø¨Øª Ø¨Ø§Ø´Ø¯ØŒ Ø§Ù…Ø§ Ù„Ø­Ù† Ù…ÛŒâ€ŒØªÙˆØ§Ù†Ø¯ Ø¨Ø± Ø§Ø³Ø§Ø³ Ù…ÙˆÙ‚Ø¹ÛŒØª ØªØºÛŒÛŒØ± Ú©Ù†Ø¯.
Û±Û³. Ù‡ÛŒÚ†â€ŒÙˆÙ‚Øª Ø¨Ø±Ø§ÛŒ ØµÙ…ÛŒÙ…ÛŒ Ø¨ÙˆØ¯Ù†ØŒ Ø§Ø·Ù„Ø§Ø¹Ø§Øª Ù†Ø§Ø¯Ø±Ø³Øª ÛŒØ§ Ø­Ø¯Ø³ Ø¨Ø¯ÙˆÙ† Ù…Ø´Ø®Øµâ€ŒÚ©Ø±Ø¯Ù† Ø¹Ø¯Ù… Ù‚Ø·Ø¹ÛŒØª Ø§Ø±Ø§Ø¦Ù‡ Ù†Ú©Ù†.
Û±Û´. Ø§Ú¯Ø± Ù¾Ø§Ø³Ø® Ø¯Ù‚ÛŒÙ‚ Ùˆ Ø¬Ø¯ÛŒ Ù„Ø§Ø²Ù… Ø§Ø³ØªØŒ Ù…Ø³ØªÙ‚ÛŒÙ… Ùˆ ÙˆØ§Ø¶Ø­ ØµØ­Ø¨Øª Ú©Ù† Ùˆ Ø´ÙˆØ®ÛŒ Ø±Ø§ Ø¨Ù‡ Ø­Ø¯Ø§Ù‚Ù„ Ø¨Ø±Ø³Ø§Ù†.
Û±Ûµ. Ù‚Ø¨Ù„ Ø§Ø² Ù†ÙˆØ´ØªÙ† Ù‡Ø± Ø¬Ù…Ù„Ù‡ØŒ Ø§Ø² Ø®ÙˆØ¯Øª Ø¨Ù¾Ø±Ø³ Ø¢ÛŒØ§ Ø§ÛŒÙ† ØªØ±Ú©ÛŒØ¨ Ú©Ù„Ù…Ø§Øª Ø¯Ø± ÙØ§Ø±Ø³ÛŒ Ù…Ø­Ø§ÙˆØ±Ù‡â€ŒØ§ÛŒ ÙˆØ§Ù‚Ø¹ÛŒ Ùˆ Ø·Ø¨ÛŒØ¹ÛŒ Ù…Ø¹Ù†Ø§ Ù…ÛŒâ€ŒØ¯Ù‡Ø¯ ÛŒØ§ Ù†Ù‡. Ù‡Ø±Ú¯Ø² Ú©Ù„Ù…Ù‡ ÛŒØ§ Ø¹Ø¨Ø§Ø±ØªÛŒ Ù†Ø³Ø§Ø² Ú©Ù‡ Ú¯ÙˆÛŒØ´ÙˆØ± ÙØ§Ø±Ø³ÛŒ Ø¢Ù† Ø±Ø§ Ù†Ø§Ù…ÙÙ‡ÙˆÙ…ØŒ Ø¨ÛŒâ€ŒÙ…Ø¹Ù†Ø§ ÛŒØ§ ØºÛŒØ±Ø·Ø¨ÛŒØ¹ÛŒ Ø¨Ø¯Ø§Ù†Ø¯ (Ù…Ø«Ù„Ø§Ù‹ ØªØ±Ú©ÛŒØ¨â€ŒÙ‡Ø§ÛŒ Ø³Ø§Ø®ØªÚ¯ÛŒ Ù…Ø«Ù„ Â«Ø³Ù„Ø§Ù…ØªÛŒâ€ŒØ§Ù…Â» Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Â«Ø³Ù„Ø§Ù…Ù…Â» ÛŒØ§ Â«Ø­Ø§Ù„Ù… Ø®ÙˆØ¨Ù‡Â»). Ø§Ú¯Ø± Ù†Ø³Ø¨Øª Ø¨Ù‡ Ø¯Ø±Ø³Øª Ø¨ÙˆØ¯Ù† ÛŒÚ© Ø¹Ø¨Ø§Ø±Øª Ù…Ø­Ø§ÙˆØ±Ù‡â€ŒØ§ÛŒ Ù…Ø·Ù…Ø¦Ù† Ù†ÛŒØ³ØªÛŒØŒ Ø³Ø§Ø¯Ù‡â€ŒØªØ±ÛŒÙ† Ùˆ Ø±Ø§ÛŒØ¬â€ŒØªØ±ÛŒÙ† Ø´Ú©Ù„ Ø¢Ù† Ø±Ø§ Ø¨Ù†ÙˆÛŒØ³ØŒ Ù†Ù‡ ÙØ±Ù… Ø¹Ø¬ÛŒØ¨ ÛŒØ§ Ù†ÙˆÛŒÛŒ Ú©Ù‡ Ù…Ø·Ù…Ø¦Ù† Ù†ÛŒØ³ØªÛŒ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¯Ø± ÙØ§Ø±Ø³ÛŒ Ø±Ø§ÛŒØ¬ Ø§Ø³Øª.

Ø§ØµÙ„ Ù…Ù‡Ù…:
Ø§ÙˆÙ„ Ø¨ÙÙ‡Ù… Ú©Ø§Ø±Ø¨Ø± Ú†Ù‡ Ø­Ø§Ù„â€ŒÙˆÙ‡ÙˆØ§ÛŒÛŒ Ø¯Ø§Ø±Ø¯ Ùˆ Ú†Ù‡ Ù†ÙˆØ¹ Ù¾Ø§Ø³Ø®ÛŒ Ù…ÛŒâ€ŒØ®ÙˆØ§Ù‡Ø¯Ø› Ø³Ù¾Ø³ Ù‡Ù…Ø§Ù† Ø§Ø·Ù„Ø§Ø¹Ø§Øª Ø±Ø§ Ø¨Ø§ Ø·Ø¨ÛŒØ¹ÛŒâ€ŒØªØ±ÛŒÙ†ØŒ Ø±ÙˆØ§Ù†â€ŒØªØ±ÛŒÙ† Ùˆ Ù…Ù†Ø§Ø³Ø¨â€ŒØªØ±ÛŒÙ† Ù„Ø­Ù† Ù…Ù…Ú©Ù† Ø§Ø±Ø§Ø¦Ù‡ Ú©Ù†.

Ø§ØµÙ„ Ù…Ù‡Ù… Ø¯ÛŒÚ¯Ø± (ÙÙ‡Ù… ÙˆØ§Ù‚Ø¹ÛŒ Ù…Ù†Ø¸ÙˆØ±ØŒ Ù†Ù‡ ÙˆØ§Ú©Ù†Ø´ Ø³Ø·Ø­ÛŒ Ø¨Ù‡ ÛŒÚ© Ú©Ù„Ù…Ù‡):
Ù‡Ù…ÛŒØ´Ù‡ Ù…Ù†Ø¸ÙˆØ± ÙˆØ§Ù‚Ø¹ÛŒ Ùˆ Ú©Ø§Ù…Ù„ Ø¬Ù…Ù„Ù‡â€ŒÛŒ Ú©Ø§Ø±Ø¨Ø± Ø±Ø§ Ø¯Ø± Ù‡Ù…Ø§Ù† Ú¯ÙØªÚ¯ÙˆÛŒ ÙØ¹Ù„ÛŒ Ø¯Ø± Ù†Ø¸Ø± Ø¨Ú¯ÛŒØ±ØŒ Ù†Ù‡ ÙÙ‚Ø· ÛŒÚ© Ú©Ù„Ù…Ù‡â€ŒÛŒ Ø´Ø¨ÛŒÙ‡ Ø¨Ù‡ Ú†ÛŒØ²ÛŒ Ú©Ù‡ Ù‚Ø¨Ù„Ø§Ù‹ Ø¯ÛŒØ¯Ù‡â€ŒØ§ÛŒ. Ø§Ú¯Ø± Ø¬Ù…Ù„Ù‡â€ŒÛŒ Ú©Ø§Ø±Ø¨Ø± Ø¯Ø± Ø¨Ø§ÙØªÙ Ù‡Ù…ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ù…Ø¹Ù†Ø§ÛŒ Ù…Ø´Ø®ØµÛŒ Ø¯Ø§Ø±Ø¯ Ú©Ù‡ Ø¨Ø§ Ø¨Ø±Ø¯Ø§Ø´Øª Ø§ÙˆÙ„ ØªÙˆ (Ù…Ø«Ù„Ø§Ù‹ Ø¨Ø± Ø§Ø³Ø§Ø³ Ø¹Ø§Ø¯Øª ÛŒØ§ Ú¯ÙØªÚ¯ÙˆÙ‡Ø§ÛŒ Ù‚Ø¨Ù„ÛŒ) ÙØ±Ù‚ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ØŒ Ù‡Ù…Ø§Ù† Ù…Ø¹Ù†Ø§ÛŒ ÙˆØ§Ù‚Ø¹ÛŒ Ùˆ Ù…ØªÙ†ÛŒ Ø±Ø§ Ø¯Ø± Ù†Ø¸Ø± Ø¨Ú¯ÛŒØ±ØŒ Ù†Ù‡ Ø¨Ø±Ø¯Ø§Ø´Øª Ù†Ø§Ø¯Ø±Ø³Øª Ø±Ø§. Ø§Ú¯Ø± ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ù…Ø·Ù…Ø¦Ù† Ù†ÛŒØ³ØªÛŒ Ù…Ù†Ø¸ÙˆØ± Ú©Ø§Ø±Ø¨Ø± Ú†ÛŒØ³ØªØŒ Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Ø­Ø¯Ø³Ù Ø§Ø´ØªØ¨Ø§Ù‡ Ø¨Ø§ Ø§Ø·Ù…ÛŒÙ†Ø§Ù† Ú©Ø§Ø°Ø¨ØŒ ÛŒØ§ Ø³Ø¤Ø§Ù„ Ú©ÙˆØªØ§Ù‡ Ø¨Ù¾Ø±Ø³ ÛŒØ§ Ù‡Ø± Ø¯Ùˆ Ø¨Ø±Ø¯Ø§Ø´Øª Ù…Ø­ØªÙ…Ù„ Ø±Ø§ Ú©ÙˆØªØ§Ù‡ Ù…Ø·Ø±Ø­ Ú©Ù†.

ØªØ´Ø®ÛŒØµ Ø§ÙˆÙ„ÛŒÙ‡â€ŒÛŒ Ú©Ø§Ø±Ø¨Ø± (Ø§Ø² Ù‡Ù…ÙˆÙ† Ù¾ÛŒØ§Ù… Ø§ÙˆÙ„):
- Ø§Ø² Ø±ÙˆÛŒ Ù†Ø­ÙˆÙ‡â€ŒÛŒ Ù†ÙˆØ´ØªÙ† Ù¾ÛŒØ§Ù… Ø§ÙˆÙ„ (Ø±Ø³Ù…ÛŒ/Ø´ÙˆØ®/Ø®ÙˆØ¯Ù…Ø§Ù†ÛŒ)ØŒ Ù…ÙˆØ¶ÙˆØ¹ÛŒ Ú©Ù‡ Ù…ÛŒâ€ŒÙ¾Ø±Ø³Ø¯ØŒ Ùˆ Ù‡Ø± Ø®Ù„Ø§ØµÙ‡â€ŒØ§ÛŒ Ú©Ù‡ Ø§Ø² Ú¯ÙØªÚ¯ÙˆÙ‡Ø§ÛŒ Ø§Ø®ÛŒØ± Ø§Ùˆ Ø¯Ø± Ø§Ø¯Ø§Ù…Ù‡â€ŒÛŒ Ø§ÛŒÙ† Ù¾ÛŒØ§Ù… Ø³ÛŒØ³ØªÙ… Ø¯Ø§Ø¯Ù‡ Ø´Ø¯Ù‡ØŒ Ù„Ø­Ù† Ùˆ Ø³Ø¨Ú© Ù¾Ø§Ø³Ø®Øª Ø±Ø§ Ø§Ø² Ù‡Ù…Ø§Ù† Ø¬Ù…Ù„Ù‡â€ŒÛŒ Ø§ÙˆÙ„ ØªÙ†Ø¸ÛŒÙ… Ú©Ù† - Ù…Ù†ØªØ¸Ø± Ù¾ÛŒØ§Ù… Ø¯ÙˆÙ… Ù†Ù…Ø§Ù†.
- Ø§Ú¯Ø± Ø®Ù„Ø§ØµÙ‡â€ŒØ§ÛŒ Ø§Ø² Ú†Øªâ€ŒÙ‡Ø§ÛŒ Ø§Ø®ÛŒØ± Ú©Ø§Ø±Ø¨Ø± Ø¯Ø± Ø§Ø¯Ø§Ù…Ù‡ Ø¢Ù…Ø¯Ù‡ØŒ Ø§Ø² Ø¢Ù† ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ ØªÙ†Ø¸ÛŒÙ… Ù„Ø­Ù† Ùˆ Ø´Ù†Ø§Ø®Øª Ú©Ù„ÛŒ Ø¹Ù„Ø§ÛŒÙ‚/Ú©Ø§Ø±Ø´ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†Ø› Ú†ÛŒØ²ÛŒ Ø§Ø² Ø¢Ù† Ø±Ø§ Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± Ø¯Ø± Ù‡Ù…ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ Ù†Ú¯ÙØªÙ‡ØŒ Ø¨Ù‡â€ŒØ¹Ù†ÙˆØ§Ù† ÙˆØ§Ù‚Ø¹ÛŒØª Ù…Ø³Ù„Ù… Ø¨Ù‡ Ø§Ùˆ Ù†Ø³Ø¨Øª Ù†Ø¯Ù‡ Ù…Ú¯Ø± Ø¨Ø§ Ø§Ø·Ù…ÛŒÙ†Ø§Ù† Ú©Ø§ÙÛŒ.

Ù†Ø§Ù… Ú©Ø§Ø±Ø¨Ø±:
"${userName || 'Ø¯ÙˆØ³Øª Ù…Ù†'}"
`;

        // FEATURE (recent-chats summary): Ø§Ú¯Ø± Ø®Ù„Ø§ØµÙ‡â€ŒØ§ÛŒ Ø§Ø² Ú†Øªâ€ŒÙ‡Ø§ÛŒ Ø§Ø®ÛŒØ± Ú©Ø§Ø±Ø¨Ø±
        // Ø§Ø² Ø³Ù…Øª Ú©Ù„Ø§ÛŒÙ†Øª Ø±Ø³ÛŒØ¯Ù‡ØŒ Ù‡Ù…ÛŒÙ†Ø¬Ø§ Ø§Ø¶Ø§ÙÙ‡â€ŒØ´ Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ… ØªØ§ Ø§Ø² Ù‡Ù…ÙˆÙ† Ø§ÙˆÙ„ÛŒÙ† Ù¾ÛŒØ§Ù…
        // Ù…Ø¯Ù„ Ø¨Ø¯ÙˆÙ†Ù‡ Ú©Ø§Ø±Ø¨Ø± Ù…Ø¹Ù…ÙˆÙ„Ø§Ù‹ Ú†Ø·ÙˆØ± ØµØ­Ø¨Øª Ù…ÛŒâ€ŒÚ©Ù†Ù‡ Ùˆ Ø¨Ù‡ Ú†ÛŒ Ø¹Ù„Ø§Ù‚Ù‡ Ø¯Ø§Ø±Ù‡.
        if (typeof recentChatsSummary === 'string' && recentChatsSummary.trim()) {
            systemText += `
Ø®Ù„Ø§ØµÙ‡â€ŒØ§ÛŒ Ø§Ø² Ú†Ù†Ø¯ Ú¯ÙØªÚ¯ÙˆÛŒ Ø§Ø®ÛŒØ± Ù‡Ù…ÛŒÙ† Ú©Ø§Ø±Ø¨Ø± (ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ Ø´Ù†Ø§Ø®Øª Ù„Ø­Ù†/Ø²Ù…ÛŒÙ†Ù‡ - Ù†Ù‡ Ù…Ù†Ø¨Ø¹ ÙˆØ§Ù‚Ø¹ÛŒØª Ù…Ø·Ù„Ù‚):
${recentChatsSummary.trim()}

Ù‡Ø´Ø¯Ø§Ø± Ù…Ù‡Ù… Ø¯Ø±Ø¨Ø§Ø±Ù‡â€ŒÛŒ Ù‡Ù…ÛŒÙ† Ø®Ù„Ø§ØµÙ‡:
Ø§ÛŒÙ† Ø®Ù„Ø§ØµÙ‡ Ù…Ø±Ø¨ÙˆØ· Ø¨Ù‡ Ú¯ÙØªÚ¯ÙˆÙ‡Ø§ÛŒ Ø¯ÛŒÚ¯Ø± Ùˆ Ø¬Ø¯Ø§Ú¯Ø§Ù†Ù‡ Ø§Ø³ØªØŒ Ù†Ù‡ Ù‡Ù…ÛŒÙ† Ú¯ÙØªÚ¯ÙˆÛŒ ÙØ¹Ù„ÛŒ. Ø§Ú¯Ø± Ø¢Ù† Ú¯ÙØªÚ¯ÙˆÙ‡Ø§ÛŒ Ù‚Ø¨Ù„ÛŒ Ø¯Ø±Ø¨Ø§Ø±Ù‡â€ŒÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„/Ú©Ø¯ Ø¨ÙˆØ¯Ù‡â€ŒØ§Ù†Ø¯ØŒ Ø§ÛŒÙ† Ø¨Ù‡â€ŒÙ‡ÛŒÚ†â€ŒÙˆØ¬Ù‡ Ø¨Ù‡ Ø§ÛŒÙ† Ù…Ø¹Ù†Ø§ Ù†ÛŒØ³Øª Ú©Ù‡ ØªÙˆ Ø§Ù„Ø§Ù† Ù‡Ù… Ø¯Ø± Â«Ø­Ø§Ù„Øª ÙˆÛŒØ±Ø§ÛŒØ´Ú¯Ø±Â» Ù‡Ø³ØªÛŒ ÛŒØ§ Ú©Ø§Ø±Ø¨Ø± Ù‡Ù…ÛŒÙ† Ø§Ù„Ø§Ù† Ù‡Ù… ÙØ§ÛŒÙ„ÛŒ Ø¨Ø±Ø§ÛŒØª ÙØ±Ø³ØªØ§Ø¯Ù‡. Ù†Ù‚Ø´ØŒ Ù„Ø­Ù† ÛŒØ§ ÙØ±Ø¶ÛŒØ§Øª Ø¢Ù† Ú¯ÙØªÚ¯ÙˆÙ‡Ø§ÛŒ Ù‚Ø¨Ù„ÛŒ Ø±Ø§ Ø¨Ù‡ Ø§ÛŒÙ† Ú¯ÙØªÚ¯ÙˆÛŒ ØªØ§Ø²Ù‡ Ø³Ø±Ø§ÛŒØª Ù†Ø¯Ù‡. ÙÙ‚Ø· ÙˆÙ‚ØªÛŒ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¯Ø± Ù‡Ù…ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ ÙØ§ÛŒÙ„ÛŒ Ø¶Ù…ÛŒÙ…Ù‡ Ø´Ø¯Ù‡ Ø¨Ø§Ø´Ø¯ (Ø¨Ø®Ø´ [Ø­Ø§Ù„Øª ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„] Ø¯Ø± Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… Ø³ÛŒØ³ØªÙ…)ØŒ Ø®ÙˆØ¯Øª Ø±Ø§ Ø¯Ø± Ù†Ù‚Ø´ ÙˆÛŒØ±Ø§ÛŒØ´Ú¯Ø± Ú©Ø¯ Ø¨Ø¯Ø§Ù†Ø› Ø¯Ø± ØºÛŒØ± Ø§ÛŒÙ† ØµÙˆØ±Øª ÛŒÚ© Ø¯Ø³ØªÛŒØ§Ø± Ú¯ÙØªÚ¯ÙˆÛŒ Ø¹Ø§Ø¯ÛŒ Ù‡Ø³ØªÛŒ.
`;
        }

        // FEATURE (richer message formatting): Ù‚Ø§Ù„Ø¨â€ŒÙ‡Ø§ÛŒ Ø§Ø¶Ø§ÙÛŒ Ú©Ù‡ Ø±Ø§Ø¨Ø· Ú©Ø§Ø±Ø¨Ø±ÛŒ
        // Ù¾Ø´ØªÛŒØ¨Ø§Ù†ÛŒ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ - Ù…Ø¯Ù„ Ø¨Ø§ÛŒØ¯ ÙÙ‚Ø· Ø¬Ø§ÛŒÛŒ Ú©Ù‡ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¨Ù‡ Ø®ÙˆØ§Ù†Ø§ÛŒÛŒ Ú©Ù…Ú© Ù…ÛŒâ€ŒÚ©Ù†Ø¯
        // Ø§Ø² Ø§ÛŒÙ†â€ŒÙ‡Ø§ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†Ø¯ØŒ Ù†Ù‡ Ø¯Ø± Ù‡Ø± Ù¾Ø§Ø³Ø®.
        systemText += `
Ù‚Ø§Ù„Ø¨â€ŒØ¨Ù†Ø¯ÛŒ Ù¾ÛŒØ´Ø±ÙØªÙ‡â€ŒÛŒ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ (Ø¯Ø± ØµÙˆØ±Øª Ù†ÛŒØ§Ø² ÙˆØ§Ù‚Ø¹ÛŒ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†ØŒ Ù†Ù‡ Ù‡Ù…ÛŒØ´Ù‡):
- Ø§ÛŒØªØ§Ù„ÛŒÚ©: *Ù…ØªÙ†* ÛŒØ§ _Ù…ØªÙ†_
- Ø®Ø·â€ŒØ®ÙˆØ±Ø¯Ù‡: ~~Ù…ØªÙ†~~
- Ù„ÛŒÙ†Ú©: [Ù…ØªÙ† Ù„ÛŒÙ†Ú©](https://...) - ÙÙ‚Ø· Ù„ÛŒÙ†Ú© ÙˆØ§Ù‚Ø¹ÛŒ Ú©Ù‡ Ù…Ø·Ù…Ø¦Ù†ÛŒ Ø¯Ø±Ø³Øª Ø§Ø³Øª Ø¨Ú¯Ø°Ø§Ø±ØŒ Ù„ÛŒÙ†Ú© Ø³Ø§Ø®ØªÚ¯ÛŒ Ù†Ø³Ø§Ø².
- Ø¬Ø¯ÙˆÙ„: Ø¨Ø§ Ù†Ø­Ùˆ Ø§Ø³ØªØ§Ù†Ø¯Ø§Ø±Ø¯ Ù…Ø§Ø±Ú©â€ŒØ¯Ø§ÙˆÙ† (Ø±Ø¯ÛŒÙ Ù‡Ø¯Ø±ØŒ Ø³Ù¾Ø³ Ø±Ø¯ÛŒÙ |---|---|ØŒ Ø³Ù¾Ø³ Ø±Ø¯ÛŒÙâ€ŒÙ‡Ø§ÛŒ Ø¯Ø§Ø¯Ù‡) - ÙÙ‚Ø· ÙˆÙ‚ØªÛŒ Ø¯Ø§Ø¯Ù‡â€ŒÛŒ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¬Ø¯ÙˆÙ„ÛŒ (Ú†Ù†Ø¯ Ø³ØªÙˆÙ† Ù‚Ø§Ø¨Ù„â€ŒÙ…Ù‚Ø§ÛŒØ³Ù‡) Ø¯Ø§Ø±ÛŒ.
- Ù„ÛŒØ³Øª ØªÙˆØ¯Ø±ØªÙˆ: Ø¨Ø§ Û² ÙØ§ØµÙ„Ù‡ Ø¨Ø±Ø§ÛŒ Ù‡Ø± Ø³Ø·Ø­ ØªÙˆ Ø±ÙØªÚ¯ÛŒ Ø¬Ù„ÙˆÛŒ - ÛŒØ§ 1. Ø¨Ú¯Ø°Ø§Ø±.
- Ú†ÛŒÙ¾/Ø¨Ø¬ Ø¨Ø±Ø§ÛŒ ÛŒÚ© Ù†Ø§Ù… ÛŒØ§ Ù…ÙÙ‡ÙˆÙ… Ú©ÙˆØªØ§Ù‡ Ù…Ù‡Ù…: {{entity:Ù†Ø§Ù…}} (Ù…Ø«Ù„Ø§Ù‹ {{entity:OpenAI}}) - ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ Ø§Ø³Ù…â€ŒÙ‡Ø§ÛŒ Ø®Ø§Øµ Ú©ÙˆØªØ§Ù‡ØŒ Ù†Ù‡ Ø¬Ù…Ù„Ù‡.
`;

        systemText += antiSelfQA;
        systemText += dateContext;
        systemText += `
Ø§Ø¨Ø²Ø§Ø±Ù‡Ø§:
- Ø§Ø¨Ø²Ø§Ø± web_search Ø±Ø§ Ù‡Ø± ÙˆÙ‚Øª ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¨Ù‡ Ø§Ø·Ù„Ø§Ø¹Ø§Øª Ø¨Ù‡â€ŒØ±ÙˆØ²/Ø²Ù†Ø¯Ù‡ Ù†ÛŒØ§Ø² Ø¯Ø§Ø±ÛŒ ØµØ¯Ø§ Ø¨Ø²Ù† (Ù‚ÛŒÙ…ØªØŒ Ø§Ø®Ø¨Ø§Ø±ØŒ Ø±ÙˆÛŒØ¯Ø§Ø¯Ù‡Ø§ØŒ Ú†ÛŒØ²ÛŒ Ú©Ù‡ Ù…Ù…Ú©Ù† Ø§Ø³Øª Ø¨Ø¹Ø¯ Ø§Ø² Ø¢Ù…ÙˆØ²Ø´Øª ØªØºÛŒÛŒØ± Ú©Ø±Ø¯Ù‡ Ø¨Ø§Ø´Ø¯). Ø¨Ø±Ø§ÛŒ Ø³Ø¤Ø§Ù„Ø§Øª Ø¹Ù…ÙˆÙ…ÛŒ/Ø«Ø§Ø¨Øª (ØªØ¹Ø±ÛŒÙØŒ Ù…ÙÙ‡ÙˆÙ…ØŒ ØªØ§Ø±ÛŒØ® Ú¯Ø°Ø´ØªÙ‡) Ù†ÛŒØ§Ø²ÛŒ Ø¨Ù‡ Ø³Ø±Ú† Ù†ÛŒØ³Øª.
- Ø¨Ø±Ø§ÛŒ ÛŒÚ© Ø³Ø¤Ø§Ù„ Ø³Ø§Ø¯Ù‡ØŒ ÙÙ‚Ø· ÛŒÚ©â€ŒØ¨Ø§Ø± Ø³Ø±Ú† Ú©Ù† Ùˆ Ø¨Ø§ Ù‡Ù…Ø§Ù† Ù†ØªØ§ÛŒØ¬ Ø¬ÙˆØ§Ø¨ Ø¨Ø¯Ù‡. Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø³Ø±Ú† Ú©Ø±Ø¯Ù† (Ø¨Ø§ Ú©ÙˆØ¦Ø±ÛŒ Ù…ØªÙØ§ÙˆØª ÛŒØ§ Ø­ØªÛŒ Ù…Ø´Ø§Ø¨Ù‡) ÙÙ‚Ø· ÙˆÙ‚ØªÛŒ Ù…Ø¬Ø§Ø² Ø§Ø³Øª Ú©Ù‡ Ù†ØªÛŒØ¬Ù‡â€ŒÛŒ Ø³Ø±Ú† Ø§ÙˆÙ„ ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ù†Ø§Ú©Ø§ÙÛŒ/Ù†Ø§Ù…Ø±ØªØ¨Ø· Ø¨ÙˆØ¯ ÛŒØ§ Ø³Ø¤Ø§Ù„ Ú†Ù†Ø¯ Ø¨Ø®Ø´ Ø¬Ø¯Ø§ Ø§Ø² Ù‡Ù… Ø¯Ø§Ø±Ø¯ Ú©Ù‡ Ù‡Ø±Ú©Ø¯Ø§Ù… Ù†ÛŒØ§Ø² Ø¨Ù‡ Ø³Ø±Ú† Ù…Ø¬Ø²Ø§ Ø¯Ø§Ø±Ù†Ø¯. Ø³Ø±Ú†â€ŒÙ‡Ø§ÛŒ ØªÚ©Ø±Ø§Ø±ÛŒ Ø±ÙˆÛŒ Ù‡Ù…Ø§Ù† Ù…ÙˆØ¶ÙˆØ¹ Ø±Ø§ Ø§Ù†Ø¬Ø§Ù… Ù†Ø¯Ù‡.
- Ø§Ú¯Ø± ØªØµÙ…ÛŒÙ… Ú¯Ø±ÙØªÛŒ Ù‡Ø± Ø§Ø¨Ø²Ø§Ø± Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†ÛŒØŒ Ù…Ø®ØµÙˆØµØ§Ù‹ web_searchØŒ Ù‚Ø¨Ù„ Ø§Ø² Function Call Ù‡ÛŒÚ† Ù…ØªÙ† ØªÙˆØ¶ÛŒØ­ÛŒØŒ Ù…Ù‚Ø¯Ù…Ù‡ ÛŒØ§ Ø¬Ù…Ù„Ù‡â€ŒØ§ÛŒ ØªÙˆÙ„ÛŒØ¯ Ù†Ú©Ù†Ø› Function Call Ø¨Ø§ÛŒØ¯ Ø§ÙˆÙ„ÛŒÙ† Ø®Ø±ÙˆØ¬ÛŒ Ù…Ø¯Ù„ Ø¯Ø± Ø¢Ù† Ù†ÙˆØ¨Øª Ø¨Ø§Ø´Ø¯. Ø¨Ø¹Ø¯ Ø§Ø² Ø¯Ø±ÛŒØ§ÙØª Ù†ØªÛŒØ¬Ù‡â€ŒÛŒ Ø§Ø¨Ø²Ø§Ø±ØŒ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø±Ø§ Ø¨Ù‡â€ŒØµÙˆØ±Øª Ø¹Ø§Ø¯ÛŒ Ùˆ streaming ØªÙˆÙ„ÛŒØ¯ Ú©Ù†.
- Ø§Ø¨Ø²Ø§Ø± ask_user Ø±Ø§ ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ ØªØºÛŒÛŒØ±Ø§Øª Ø§Ø³Ø§Ø³ÛŒ/ØºÛŒØ±Ù‚Ø§Ø¨Ù„â€ŒØ¨Ø±Ú¯Ø´Øª ÛŒØ§ ØªØµÙ…ÛŒÙ…â€ŒÙ‡Ø§ÛŒÛŒ Ø¨Ø§ Ú†Ù†Ø¯ Ø±Ø§Ù‡â€ŒØ­Ù„ Ù…ØªÙØ§ÙˆØª ØµØ¯Ø§ Ø¨Ø²Ù† (Ù…Ø«Ù„Ø§Ù‹ Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ú©Ø§Ù…Ù„ ÛŒÚ© ÙØ§ÛŒÙ„ØŒ Ø­Ø°Ù Ø¨Ø®Ø´ Ø¨Ø²Ø±Ú¯ Ú©Ø¯). Ø¨Ø±Ø§ÛŒ Ú©Ø§Ø±Ù‡Ø§ÛŒ Ú©ÙˆÚ†Ú© ÛŒØ§ ÙˆØ§Ø¶Ø­ØŒ Ù…Ø³ØªÙ‚ÛŒÙ… Ø§Ù†Ø¬Ø§Ù… Ø¨Ø¯Ù‡ Ùˆ Ø§Ø² Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± Ø§Ø³ØªÙØ§Ø¯Ù‡ Ù†Ú©Ù†.
`;

        // FEATURE (persistent file memory): tell the model which files exist
        // in this chat's permanent archive (names only - the content is
        // fetched on-demand via get_archived_file, see GEMINI_TOOLS above).
        // If the archive is empty, say nothing extra so the prompt doesn't
        // grow for chats that never used this.
        if (archivedFileNames.length > 0) {
            systemText += `
ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ Ø¢Ø±Ø´ÛŒÙˆØ´Ø¯Ù‡ Ø¯Ø± Ø§ÛŒÙ† Ú¯ÙØªÚ¯Ùˆ (ÙÙ‚Ø· Ù†Ø§Ù… - Ù…Ø­ØªÙˆØ§ Ø¨Ø§ Ø§Ø¨Ø²Ø§Ø± get_archived_file Ù‚Ø§Ø¨Ù„ Ø¯Ø±ÛŒØ§ÙØª Ø§Ø³Øª):
${archivedFileNames.map(n => `- ${n}`).join('\n')}

ÙÙ‚Ø· ÙˆÙ‚ØªÛŒ Ú©Ø§Ø±Ø¨Ø± ÙˆØ§Ù‚Ø¹Ø§Ù‹ Ø¨Ù‡ Ù…Ø­ØªÙˆØ§ÛŒ ÛŒÚ©ÛŒ Ø§Ø² Ø§ÛŒÙ† ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ Ù†ÛŒØ§Ø² Ø¯Ø§Ø±Ø¯ ÛŒØ§ Ø§Ø±Ø¬Ø§Ø¹ Ù…ÛŒâ€ŒØ¯Ù‡Ø¯ (Ù†Ù‡ ØµØ±ÙØ§Ù‹ ÙˆÙ‚ØªÛŒ Ø§Ø³Ù…Ø´ Ø±Ø§ Ù…ÛŒâ€ŒØ¨ÛŒÙ†ÛŒ)ØŒ Ø§Ø¨Ø²Ø§Ø± get_archived_file Ø±Ø§ Ø¨Ø§ Ù†Ø§Ù… Ø¯Ù‚ÛŒÙ‚ ÙØ§ÛŒÙ„ ØµØ¯Ø§ Ø¨Ø²Ù†.
Ù…Ù‡Ù…: Ø§Ú¯Ø± Ú©Ø§Ø±Ø¨Ø± Ø¯Ø± Ù‡Ù…ÛŒÙ† Ù¾ÛŒØ§Ù… ÛŒÚ© ÙØ§ÛŒÙ„ Ø±Ø§ Ù…Ø³ØªÙ‚ÛŒÙ…Ø§Ù‹ Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ (Ú†Ù‡ Ù¾ÛŒØ§Ù… Ø§ÙˆÙ„ Ø¨Ø§Ø´Ø¯ Ú†Ù‡ Retry)ØŒ Ù‡Ù…ÛŒØ´Ù‡ Ø§Ø² Ù‡Ù…Ø§Ù† Ù†Ø³Ø®Ù‡â€ŒÛŒ Ø¶Ù…ÛŒÙ…Ù‡â€ŒØ´Ø¯Ù‡ (Ú©Ù‡ Ø¯Ø± Ø¨Ø®Ø´ ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒ ÙØ¹Ù„ÛŒ Ø¯Ø± Ø¯Ø³ØªØ±Ø³ ØªÙˆØ³Øª) Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†ØŒ Ø­ØªÛŒ Ø§Ú¯Ø± ÙØ§ÛŒÙ„ÛŒ Ù‡Ù…â€ŒÙ†Ø§Ù… Ø¯Ø± Ø¢Ø±Ø´ÛŒÙˆ Ù…ÙˆØ¬ÙˆØ¯ Ø¨Ø§Ø´Ø¯. get_archived_file Ø±Ø§ Ø¯Ø± Ø§ÛŒÙ† Ø­Ø§Ù„Øª ØµØ¯Ø§ Ù†Ø²Ù†Ø› Ø§ÛŒÙ† Ø§Ø¨Ø²Ø§Ø± ÙÙ‚Ø· Ø¨Ø±Ø§ÛŒ ÙØ§ÛŒÙ„â€ŒÙ‡Ø§ÛŒÛŒ Ø§Ø³Øª Ú©Ù‡ Ú©Ø§Ø±Ø¨Ø± Ø¨Ù‡ Ø¢Ù†â€ŒÙ‡Ø§ Ø§Ø±Ø¬Ø§Ø¹ Ù…ÛŒâ€ŒØ¯Ù‡Ø¯ Ø¨Ø¯ÙˆÙ† Ø§ÛŒÙ†â€ŒÚ©Ù‡ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ Ø¨Ø§Ø´Ø¯.
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
                            `Â«${f.name || 'file'}Â»`
                    )
                    .join('ØŒ ');

            systemText += `

Ø­Ø§Ù„Øª ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„ (SEARCH/REPLACE):

- Ú©Ø§Ø±Ø¨Ø± ${textFiles.length > 1
                    ? `${textFiles.length} ÙØ§ÛŒÙ„ Ú©Ø¯/Ù…ØªÙ† (${fileNamesList})`
                    : `ÛŒÚ© ÙØ§ÛŒÙ„ Ú©Ø¯/Ù…ØªÙ†`
                } Ø¶Ù…ÛŒÙ…Ù‡ Ú©Ø±Ø¯Ù‡ Ø§Ø³Øª.

- Ù…Ø­ØªÙˆØ§ÛŒ ÙØ§ÛŒÙ„ Ù…Ù†Ø¨Ø¹ Ù…Ø¹ØªØ¨Ø± Ú©Ø¯ Ø§Ø³Øª.
- Ø§Ú¯Ø± Ú©Ø§Ø±Ø¨Ø± ØªØºÛŒÛŒØ± Ú©Ø¯ Ø®ÙˆØ§Ø³ØªØŒ ÙˆØ§Ù‚Ø¹Ø§Ù‹ ØªØºÛŒÛŒØ± Ø±Ø§ Ø±ÙˆÛŒ ÙØ§ÛŒÙ„ Ø§Ø¹Ù…Ø§Ù„ Ú©Ù†.
- Ø³Ø§Ø®ØªØ§Ø±Ù‡Ø§ÛŒ Ù…ÙˆØ¬ÙˆØ¯ Ø±Ø§ Ø¨Ø±Ø±Ø³ÛŒ Ú©Ù† Ùˆ Ú†ÛŒØ²Ù‡Ø§ÛŒ Ø¨ÛŒâ€ŒØ¯Ù„ÛŒÙ„ Ø§Ø®ØªØ±Ø§Ø¹ Ù†Ú©Ù†.
- Ø¨Ù‡ Ø¬Ø§ÛŒ Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ú©Ù„ ÙØ§ÛŒÙ„ØŒ ÙÙ‚Ø· Ù‚Ø·Ø¹Ù‡(Ù‡Ø§ÛŒ) Ù„Ø§Ø²Ù… Ø±Ø§ Ø¨Ø§ apply_edit ØªØºÛŒÛŒØ± Ø¨Ø¯Ù‡.

Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ Ù‡Ø± ÙØ§ÛŒÙ„ Ø§Ø² Ù‚Ø¨Ù„ Ø¯Ø± Ù¾ÛŒØ§Ù… Ø³ÛŒØ³ØªÙ… (Ø¨Ø®Ø´ [Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„(Ù‡Ø§ÛŒ) Ù‚Ø§Ø¨Ù„ ÙˆÛŒØ±Ø§ÛŒØ´]) Ø¨Ù‡ ØªÙˆ Ø¯Ø§Ø¯Ù‡ Ø´Ø¯Ù‡ Ø§Ø³Øª.

Ø±ÙˆÙ†Ø¯ Ø§Ø¬Ø¨Ø§Ø±ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ (Ù‡Ø± Ù…Ø±Ø­Ù„Ù‡ Ù‚Ø¨Ù„ Ø§Ø² Ø¨Ø¹Ø¯ÛŒ):
Û±. Ø§Ø² Ø±ÙˆÛŒ Ù…Ø­ØªÙˆØ§ÛŒ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„ Ú©Ù‡ Ø¯Ø§Ø±ÛŒØŒ Ø¨Ø®Ø´ Ø¯Ù‚ÛŒÙ‚ÛŒ Ú©Ù‡ Ø¨Ø§ÛŒØ¯ ØªØºÛŒÛŒØ± Ú©Ù†Ø¯ Ø±Ø§ Ù¾ÛŒØ¯Ø§ Ú©Ù† - Ø­Ø¯Ø³ Ù†Ø²Ù†ØŒ Ù…ØªÙ† ÙˆØ§Ù‚Ø¹ÛŒ Ø±Ø§ Ø§Ø² Ù‡Ù…Ø§Ù† Ù…Ø­ØªÙˆØ§ Ú©Ù¾ÛŒ Ú©Ù†.
Û². apply_edit Ø±Ø§ Ø¨Ø§ fileØŒ search (Ù…ØªÙ† Ø¯Ù‚ÛŒÙ‚ Ù…ÙˆØ¬ÙˆØ¯ - Ú†Ù†Ø¯ Ø®Ø· Ø§Ø·Ø±Ø§Ù ØªØºÛŒÛŒØ± Ø¨Ø±Ø§ÛŒ ÛŒÚ©ØªØ§ Ø¨ÙˆØ¯Ù†) Ùˆ replace (Ù…ØªÙ† Ù†Ù‡Ø§ÛŒÛŒ Ø¬Ø¯ÛŒØ¯ Ù‡Ù…Ø§Ù† Ø¨Ø®Ø´) ØµØ¯Ø§ Ø¨Ø²Ù†.
   - Ø§Ú¯Ø± success:true Ùˆ valid:true Ø¨Ø±Ú¯Ø´ØªØŒ ØªØºÛŒÛŒØ± Ø§Ø¹Ù…Ø§Ù„ Ø´Ø¯.
   - Ø§Ú¯Ø± success:false Ø¨Ø±Ú¯Ø´Øª (Ù¾ÛŒØ¯Ø§ Ù†Ø´Ø¯ ÛŒØ§ Ù…Ø¨Ù‡Ù… Ø¨ÙˆØ¯)ØŒ Ø§Ø² context Ù‡Ø§ÛŒÛŒ Ú©Ù‡ Ø¯Ø± Ù¾Ø§Ø³Ø® Ø®Ø·Ø§ Ø¨Ø±Ú¯Ø±Ø¯Ø§Ù†Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ Ú©Ù…Ú© Ø¨Ú¯ÛŒØ± ØªØ§ search Ø±Ø§ Ø¯Ù‚ÛŒÙ‚â€ŒØªØ±/ÛŒÚ©ØªØ§ØªØ± Ú©Ù†ÛŒØŒ Ø³Ù¾Ø³ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØµØ¯Ø§ Ø¨Ø²Ù†. Ù‡Ø±Ú¯Ø² Ø­Ø¯Ø³ Ù†Ø²Ù† ÛŒØ§ Ù…Ø­ØªÙˆØ§ Ø±Ø§ Ø§Ø² Ø­Ø§ÙØ¸Ù‡ Ø¨Ø§Ø²Ø³Ø§Ø²ÛŒ Ù†Ú©Ù† - Ø§Ø² context ÙˆØ§Ù‚Ø¹ÛŒ Ø¨Ø±Ú¯Ø´ØªÛŒ Ø§Ø³ØªÙØ§Ø¯Ù‡ Ú©Ù†.
   - Ø§Ú¯Ø± Ù„Ø§Ø²Ù… Ø¨ÙˆØ¯ Ù…ØªÙ† Ø¯Ù‚ÛŒÙ‚ ÛŒÚ© Ø¨Ø®Ø´ Ø±Ø§ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø¨Ø¨ÛŒÙ†ÛŒ (ÙØ§ÛŒÙ„ Ø®ÛŒÙ„ÛŒ Ø¨Ø²Ø±Ú¯ Ø¨ÙˆØ¯ ÛŒØ§ Ù…Ø·Ù…Ø¦Ù† Ù†Ø¨ÙˆØ¯ÛŒ)ØŒ read_file_section Ø±Ø§ Ø¨Ø§ startLine/endLine ØµØ¯Ø§ Ø¨Ø²Ù†.
Û³. Ø§Ú¯Ø± Ú†Ù†Ø¯ Ø¨Ø®Ø´ Ø¬Ø¯Ø§ Ø§Ø² Ù‡Ù… Ø¨Ø§ÛŒØ¯ ØªØºÛŒÛŒØ± Ú©Ù†Ù†Ø¯ØŒ apply_edit Ø±Ø§ ÛŒÚ©ÛŒâ€ŒÛŒÚ©ÛŒ Ø¨Ø±Ø§ÛŒ Ù‡Ø±Ú©Ø¯Ø§Ù… ØµØ¯Ø§ Ø¨Ø²Ù†.
Û´. Ø¨Ø¹Ø¯ Ø§Ø² ØªÙ…Ø§Ù… apply_edit Ù‡Ø§ÛŒ Ù„Ø§Ø²Ù…ØŒ Ø­ØªÙ…Ø§Ù‹ verify_file Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù†. Ø§Ú¯Ø± valid:false Ø¨Ø±Ú¯Ø´ØªØŒ Ø¨Ø®Ø´ Ù…Ø´Ú©Ù„â€ŒØ¯Ø§Ø± Ø±Ø§ Ø¨Ø§ apply_edit Ø¯ÛŒÚ¯Ø±ÛŒ Ø§ØµÙ„Ø§Ø­ Ùˆ Ø¯ÙˆØ¨Ø§Ø±Ù‡ verify_file Ø±Ø§ ØµØ¯Ø§ Ø¨Ø²Ù† - ØªØ§ valid:true Ù†Ú¯ÛŒØ±ÛŒ Ø§Ø¬Ø§Ø²Ù‡â€ŒÛŒ Ù¾Ø§Ø³Ø® Ù†Ù‡Ø§ÛŒÛŒ Ø±Ø§ Ù†Ø¯Ø§Ø±ÛŒ.
Ûµ. Ø¨Ø¹Ø¯ Ø§Ø² verify_file Ù…ÙˆÙÙ‚ (valid:true)ØŒ Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± Ø¨Ú¯Ùˆ Ú†Ù‡ ØªØºÛŒÛŒØ±ÛŒ Ø¯Ø§Ø¯ÛŒØ› Ù†ÛŒØ§Ø²ÛŒ Ø¨Ù‡ Ú†Ø§Ù¾ Ú©Ø¯ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„ ÛŒØ§ Ù‡ÛŒÚ† Ø¨Ù„Ø§Ú© JSON Ø®Ø§ØµÛŒ Ø¯Ø± Ù¾Ø§Ø³Ø® Ù†ÛŒØ³Øª - ÙØ§ÛŒÙ„ Ù†Ù‡Ø§ÛŒÛŒ Ø§Ø² Ø±ÙˆÛŒ ØªØºÛŒÛŒØ±Ø§Øª Ø§Ø¹Ù…Ø§Ù„â€ŒØ´Ø¯Ù‡ Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± ØªØ­ÙˆÛŒÙ„ Ø¯Ø§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯.

Ø®Ø§Ø±Ø¬ Ø§Ø² Ø§ÛŒÙ† Ø±ÙˆÙ†Ø¯ØŒ Ú©Ø¯ Ú©Ø§Ù…Ù„ ÙØ§ÛŒÙ„ Ø±Ø§ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ú†Ø§Ù¾ Ù†Ú©Ù†.

Ù‚ÙˆØ§Ù†ÛŒÙ† Ø­ÛŒØ§ØªÛŒ Ø¯Ø±Ø¨Ø§Ø±Ù‡â€ŒÛŒ Ø§Ø¯Ø¹Ø§ÛŒ Ù…ÙˆÙÙ‚ÛŒØª (Ø¨Ø³ÛŒØ§Ø± Ù…Ù‡Ù… - Ù†Ù‚Ø¶ Ø§ÛŒÙ† Ù‚ÙˆØ§Ù†ÛŒÙ† ÛŒØ¹Ù†ÛŒ Ú©Ø§Ø±Ø¨Ø± Ù‡ÛŒÚ† ÙØ§ÛŒÙ„ÛŒ Ø¯Ø±ÛŒØ§ÙØª Ù†Ù…ÛŒâ€ŒÚ©Ù†Ø¯):
- Ù‡Ø±Ú¯Ø² Ø¬Ù…Ù„Ù‡â€ŒÙ‡Ø§ÛŒÛŒ Ù…Ø«Ù„ Â«Ø¨Ø§ Ù…ÙˆÙÙ‚ÛŒØª Ø°Ø®ÛŒØ±Ù‡/ÙˆÛŒØ±Ø§ÛŒØ´/Ø§Ø¹Ù…Ø§Ù„ Ø´Ø¯Â» ÛŒØ§ Ù…Ø´Ø§Ø¨Ù‡ Ø¢Ù† Ù†Ù†ÙˆÛŒØ³ Ù…Ú¯Ø± Ø§ÛŒÙ†Ú©Ù‡ ÙˆØ§Ù‚Ø¹Ø§Ù‹ apply_edit Ø±Ø§ ØµØ¯Ø§ Ø²Ø¯Ù‡ Ø¨Ø§Ø´ÛŒ (Ùˆ success:true Ú¯Ø±ÙØªÙ‡ Ø¨Ø§Ø´ÛŒ) Ùˆ Ø³Ù¾Ø³ verify_file Ø±Ø§ ØµØ¯Ø§ Ø²Ø¯Ù‡ Ø¨Ø§Ø´ÛŒ Ùˆ valid:true Ú¯Ø±ÙØªÙ‡ Ø¨Ø§Ø´ÛŒ. Ø§Ú¯Ø± Ø§ÛŒÙ† Ø¯Ùˆ Ø§Ø¨Ø²Ø§Ø± ØµØ¯Ø§ Ø²Ø¯Ù‡ Ù†Ø´Ø¯Ù‡ ÛŒØ§ Ø´Ú©Ø³Øª Ø®ÙˆØ±Ø¯Ù‡â€ŒØ§Ù†Ø¯ØŒ Ù‡Ø±Ú¯Ø² Ø§Ø¯Ø¹Ø§ÛŒ Ù…ÙˆÙÙ‚ÛŒØª Ù†Ú©Ù† - ÙÙ‚Ø· Ø¨Ú¯Ùˆ Ú©Ù‡ Ù‡Ù†ÙˆØ² Ù…ÙˆÙÙ‚ Ù†Ø´Ø¯Ù‡â€ŒØ§ÛŒ.
- ØªØºÛŒÛŒØ± Ú©Ø¯ Ø±Ø§ Ù‡Ø±Ú¯Ø² Ø¨Ù‡â€ŒØµÙˆØ±Øª ÛŒÚ© Ø¨Ù„ÙˆÚ© Ú©Ø¯ Ø¬Ø¯Ø§ (Ù…Ø«Ù„Ø§Ù‹ \`\`\`html ... \`\`\` ÛŒØ§ \`\`\`css ... \`\`\`) Ø¯Ø± Ù…ØªÙ† Ù¾Ø§Ø³Ø® Ù†Ù†ÙˆÛŒØ³ ÛŒØ§ Ù†Ø´Ø§Ù† Ù†Ø¯Ù‡ØŒ Ø­ØªÛŒ Ø§Ú¯Ø± Ø¨Ø®ÙˆØ§Ù‡ÛŒ ÙÙ‚Ø· ØªÙˆØ¶ÛŒØ­ Ø¨Ø¯Ù‡ÛŒ Ú†Ù‡ Ú†ÛŒØ²ÛŒ Ø¹ÙˆØ¶ Ø´Ø¯Ù‡ - Ø§ÛŒÙ† Ú©Ø§Ø± ØªÙˆØ³Ø· Ø±Ø§Ø¨Ø· Ú©Ø§Ø±Ø¨Ø±ÛŒ Ø¨Ù‡â€ŒØ¹Ù†ÙˆØ§Ù† ÛŒÚ© ÙØ§ÛŒÙ„ Ø¬Ø¯ÛŒØ¯ Ùˆ Ø¬Ø¯Ø§Ú¯Ø§Ù†Ù‡ (Ù†Ù‡ ÙˆÛŒØ±Ø§ÛŒØ´ ÙØ§ÛŒÙ„ Ù…ÙˆØ¬ÙˆØ¯) Ù†Ù…Ø§ÛŒØ´ Ø¯Ø§Ø¯Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯ØŒ Ù‡ÛŒÚ† Ø¯Ú©Ù…Ù‡â€ŒÛŒ Ø¯Ø§Ù†Ù„ÙˆØ¯ ÙˆØ§Ù‚Ø¹ÛŒ Ù†Ø¯Ø§Ø±Ø¯ØŒ Ùˆ Ú©Ø§Ø±Ø¨Ø± Ø±Ø§ Ú¯ÛŒØ¬ Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ú†ÙˆÙ† ÙÚ©Ø± Ù…ÛŒâ€ŒÚ©Ù†Ø¯ Ø§ÛŒÙ† Ù‡Ù…Ø§Ù† ÙØ§ÛŒÙ„ ÙˆÛŒØ±Ø§ÛŒØ´â€ŒØ´Ø¯Ù‡ Ø§Ø³Øª Ø¯Ø± Ø­Ø§Ù„ÛŒ Ú©Ù‡ Ù†ÛŒØ³Øª. Ø§Ú¯Ø± Ù…ÛŒâ€ŒØ®ÙˆØ§Ù‡ÛŒ ØªØºÛŒÛŒØ± Ø±Ø§ ØªÙˆØ¶ÛŒØ­ Ø¯Ù‡ÛŒØŒ ÙÙ‚Ø· Ø¯Ø± Ù‚Ø§Ù„Ø¨ Ù…ØªÙ† Ø¹Ø§Ø¯ÛŒ (Ø¨Ø¯ÙˆÙ† \`\`\`) ØªÙˆØ¶ÛŒØ­ Ø¨Ø¯Ù‡Ø› ØªØºÛŒÛŒØ± ÙˆØ§Ù‚Ø¹ÛŒ ÙÙ‚Ø· Ùˆ ÙÙ‚Ø· Ø§Ø² Ø·Ø±ÛŒÙ‚ apply_edit + verify_file Ø§Ø¹Ù…Ø§Ù„ Ù…ÛŒâ€ŒØ´ÙˆØ¯.
- Ø§Ú¯Ø± apply_edit ÛŒØ§ verify_file Ø´Ú©Ø³Øª Ø®ÙˆØ±Ø¯Ù†Ø¯ Ùˆ Ù†ØªÙˆØ§Ù†Ø³ØªÛŒ Ø¨Ø§ ØªÙ„Ø§Ø´ Ù…Ø¬Ø¯Ø¯ Ø¯Ø±Ø³ØªØ´Ø§Ù† Ú©Ù†ÛŒØŒ ØµØ§Ø¯Ù‚Ø§Ù†Ù‡ Ø¨Ú¯Ùˆ Ú©Ù‡ ÙˆÛŒØ±Ø§ÛŒØ´ Ø§Ù†Ø¬Ø§Ù… Ù†Ø´Ø¯ Ùˆ Ú†Ø±Ø§ - Ù‡Ø±Ú¯Ø² ÙˆØ§Ù†Ù…ÙˆØ¯ Ù†Ú©Ù† Ú©Ù‡ Ø§Ù†Ø¬Ø§Ù… Ø´Ø¯Ù‡ØŒ Ùˆ Ù‡Ø±Ú¯Ø² Ø¨Ù‡â€ŒØ¬Ø§ÛŒ Ø§Ù†Ø¬Ø§Ù… ÙˆØ§Ù‚Ø¹ÛŒ ÙˆÛŒØ±Ø§ÛŒØ´ØŒ ÙÙ‚Ø· ÙØ§ÛŒÙ„ Ø±Ø§ Ø¯Ø± Ù¾Ø§Ø³Ø® Ù…ØªÙ†ÛŒ Ø¨Ø§Ø²Ù†ÙˆÛŒØ³ÛŒ Ù†Ú©Ù†.
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
                'gemini-3.7-flash'
            );

            modelsToTry.push(
                'gemini-3.5-flash-lite'
            );
        }

        if (
            MODEL_NAME ===
            'gemini-3.7-flash'
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
            // in-progress stream). For heavy replies â€” long code files,
            // multi-file edits â€” Gemini can legitimately take longer than
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
            // progress back to zero. editStates: fileName -> FileEditState
            // (see createBlockFileState). See the matching comment inside
            // runAgentLoop for the full explanation.
            const sharedRequestState = {
                editStates: new Map()
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
                // falling through to a healthy key â€” this was the other
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
                    // time the catch block below runs â€” this was previously
                    // declared inside try{}, which is normally fine (same
                    // block scope as its catch), but a stale/partial deploy
                    // once left a version where the two were out of sync and
                    // threw "attemptStartedAt is not defined" here, which
                    // then hit the mid-stream error path instead of just
                    // logging the connect time. Hoisting it removes that
                    // class of bug entirely, regardless of deploy state.
                    let attemptStartedAt = Date.now();
                    // FIX (deadlineTimer is not defined): same class of bug
                    // as attemptStartedAt above. deadlineTimer was declared
                    // with const INSIDE the try block; if anything threw
                    // before that declaration line executed (e.g. log.info
                    // itself, or an error early in the try), the catch block
                    // below referenced a deadlineTimer that was never
                    // initialized in this iteration - a real ReferenceError,
                    // not a hypothetical one (this is exactly what the
                    // screenshot showed). Hoisted above try, defaulting to
                    // null, so clearTimeout(deadlineTimer) in catch is always
                    // safe regardless of where inside try the throw happened.
                    let deadlineTimer = null;

                    try {
                        attemptStartedAt = Date.now();

                        log.info('model.attempt', {
                            mode: 'stream',
                            model: currentModel,
                            key: keyLabel(geminiKeys, currentKey)
                        });

                        const abortController = new AbortController();
                        // FIX (single key attempt could blow past
                        // overallDeadline entirely): overallDeadline was
                        // only ever checked BEFORE starting a new attempt
                        // (the `if (Date.now() > overallDeadline) break`
                        // above), never enforced WHILE an attempt was
                        // in-flight. With MAX_TOOL_ROUNDS=10 and up to 170s
                        // per round, one stuck attempt could run ~28
                        // minutes uninterrupted - far past the intended
                        // <=10min overallDeadline - before the check ever
                        // got a chance to fire again. Force-abort this
                        // attempt's own controller the moment the shared
                        // deadline passes, same signal path onAbort/fetch
                        // already listens to for client-disconnect.
                        const deadlineMsRemaining = Math.max(0, overallDeadline - Date.now());
                        deadlineTimer = setTimeout(() => abortController.abort(), deadlineMsRemaining);

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
                        // typing), but with live "Ø¯Ø± Ø­Ø§Ù„ Ø§Ù†Ø¬Ø§Ù…..." steps
                        // along the way to fill that gap.
                        let searchWasPerformed = false;
                        const requestSearchIntent = looksLikeWebSearchIntent(searchQueryBase || text);

                        // FIX (heavy code UX): code blocks now stream live,
                        // chunk-by-chunk, exactly like normal prose - no more
                        // buffering the whole fenced block and flushing it in
                        // one piece, and no more fake "Ø¯Ø± Ø­Ø§Ù„ Ù†ÙˆØ´ØªÙ† Ú©Ø¯..."
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
                                        res.write(`data: ${JSON.stringify({ step: 'Ø¯Ø± Ø­Ø§Ù„ Ø§Ø¹Ù…Ø§Ù„ ØªØºÛŒÛŒØ±Ø§Øª Ø±ÙˆÛŒ ÙØ§ÛŒÙ„...' })}\n\n`);
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
                            thinkLevel,
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

                        clearTimeout(deadlineTimer);
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

                        // DIAGNOSTICS: ÙˆÙ‚ØªÛŒ Ø­Ù„Ù‚Ù‡ Ø¨Ù‡ Ø³Ù‚Ù MAX_TOOL_ROUNDS
                        // Ù…ÛŒâ€ŒØ±Ø³Ø¯ (finishReason === 'TOOL_LOOP_LIMIT')ØŒ Ø§ÛŒÙ†
                        // Ù…Ø³ÛŒØ± throw Ù†Ù…ÛŒâ€ŒÚ©Ù†Ø¯ - ÛŒÚ© finalText Ø¹Ù…ÙˆÙ…ÛŒ Ø¨Ø±Ù…ÛŒâ€ŒÚ¯Ø±Ø¯Ø§Ù†Ø¯
                        // Ùˆ Ø¨Ù‡ Ù‡Ù…ÛŒÙ† Ø´Ú©Ù„ Ø¨Ù‡ Ú©Ø§Ø±Ø¨Ø± Ù…ÛŒâ€ŒØ±Ø³Ø¯ØŒ Ø¨Ø¯ÙˆÙ† ØªÙˆØ¶ÛŒØ­ ÙˆØ§Ù‚Ø¹ÛŒ.
                        // agentResult.diagnostics Ø±Ø§ Ù‡Ù…ÛŒÙ†Ø¬Ø§ Ù‡Ù… Ø¨Ù‡ Ù„Ø§Ú¯ Ø³Ø±ÙˆØ± Ùˆ
                        // Ù‡Ù… (ØªØ­Øª "Ø¬Ø²Ø¦ÛŒØ§Øª Ø¨ÛŒØ´ØªØ±" Ù…Ø´Ø§Ø¨Ù‡ Ù…Ø³ÛŒØ± Ø®Ø·Ø§) Ø¨Ù‡ Ú©Ù„Ø§ÛŒÙ†Øª
                        // Ù…ÛŒâ€ŒÙØ±Ø³ØªÛŒÙ… ØªØ§ Ø§ÛŒÙ† Ø­Ø§Ù„Øª Ù‡Ù… Ø¯ÛŒÚ¯Ø± Ú©ÙˆØ±Ú©ÙˆØ±Ø§Ù†Ù‡ Ù†Ø¨Ø§Ø´Ø¯.
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
                                    : {}),
                                ...(agentResult.unresolvedEditFailure
                                    ? { unresolvedEditFailure: agentResult.unresolvedEditFailure }
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
                        clearTimeout(deadlineTimer);
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
            // "detail" field the client already renders behind "Ø¬Ø²Ø¦ÛŒØ§Øª
            // Ø¨ÛŒØ´ØªØ±", so no UI changes are needed to see them.
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
                    ? `Ù‡Ù…Ù‡Ù” ${geminiKeys.length} Ú©Ù„ÛŒØ¯ ØªÙ†Ø¸ÛŒÙ…â€ŒØ´Ø¯Ù‡ Ø¯Ø± Ø³Ù‡Ù…ÛŒÙ‡/Ù…Ø­Ø¯ÙˆØ¯ÛŒØª Ù†Ø±Ø® Ú¯ÛŒØ± Ú©Ø±Ø¯Ù†Ø¯Ø› Ù„Ø·ÙØ§Ù‹ Ú©Ù…ÛŒ Ø¨Ø¹Ø¯ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØªÙ„Ø§Ø´ Ú©Ù†.`
                    : classification.message;

            // DIAGNOSTICS: Ø§Ú¯Ø± Ø®Ø·Ø§ Ø§Ø² Ù†ÙˆØ¹ "Ø³Ú©ÙˆØª Ø¨Ø¹Ø¯ Ø§Ø² Ø§Ø¨Ø²Ø§Ø±" ÛŒØ§ "Ø³Ù‚Ù
            // Ù…Ø±Ø§Ø­Ù„" Ø¨ÙˆØ¯ØŒ lastError.diagnostics.humanSummary Ø±Ø§ Ø¯Ø§Ø±ÛŒÙ… (Ú†ÙˆÙ†
            // runAgentLoop Ø¢Ù† Ø±Ø§ Ø¯Ø± err.body Ú¯Ø°Ø§Ø´ØªÙ‡ Ùˆ Ù„Ø§ÛŒÙ† Ø¨Ø§Ù„Ø§ Ú©Ù„ err.body
            // Ø±Ø§ Ø±ÙˆÛŒ lastError Ù¾Ø®Ø´ Ù…ÛŒâ€ŒÚ©Ù†Ø¯). Ø¢Ù† Ø±Ø§ Ø¨Ù‡ detail Ø§Ø¶Ø§ÙÙ‡ Ù…ÛŒâ€ŒÚ©Ù†ÛŒÙ…
            // ØªØ§ Ø¨Ø¯ÙˆÙ† Ù‡ÛŒÚ† ØªØºÛŒÛŒØ± ÙØ±Ø§Ù†Øªâ€ŒØ§Ù†Ø¯ÛŒØŒ Ø²ÛŒØ± "Ø¬Ø²Ø¦ÛŒØ§Øª Ø¨ÛŒØ´ØªØ±" Ø¯ÛŒØ¯Ù‡ Ø´ÙˆØ¯.
            const diagnosticsSummary = lastError?.diagnostics?.humanSummary || null;
            const detailText =
                `Gemini${geminiStatusCode ? ' [' + geminiStatusCode + ']' : ''}${classification.providerCode ? ' [' + classification.providerCode + ']' : ''}: ${geminiReasonMessage}` +
                ` (actual attempts: ${attemptsTried})` +
                (diagnosticsSummary ? `\n\n--- Ø±Ø¯Ù Ø§Ø¬Ø±Ø§ÛŒ Ù…Ø¯Ù„ ---\n${diagnosticsSummary}` : '');

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
        // well before Gemini finished, producing the exact "Ù¾Ø§Ø³Ø® Ø¨ÛŒØ´ Ø§Ø² Ø­Ø¯
        // Ø·ÙˆÙ„ Ú©Ø´ÛŒØ¯" timeout being reported. Matching it to the same 180s
        // (and further via hasVideoAttachment inside runAgentLoop's own
        // per-round timeout) keeps both code paths consistent.
        // FIX (false "all keys exhausted" after just 1-2 tries): same
        // reasoning as the streaming path above - scale with key count.
        const overallDeadline =
            Date.now() + Math.min(600000, Math.max(180000, geminiKeys.length * 20000));

        let lastError = null;
        // FIX 3 (block-based rewrite): see the matching comment in the
        // other attempt loop above and inside runAgentLoop â€” keeps block
        // read/edit/verify progress alive across retryable key/model
        // retries within this one HTTP request.
        const sharedRequestState = {
            editStates: new Map()
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

                // FIX (same class as deadlineTimer in the streaming loop):
                // hoisted above try so clearTimeout in the catch block below
                // is always safe, even if something throws before this
                // iteration's setTimeout call executes.
                let deadlineTimerNonStream = null;

                try {
                    log.info('model.attempt', {
                        mode: 'non-stream',
                        model: currentModel,
                        key: keyLabel(geminiKeys, currentKey)
                    });

                    const abortController = new AbortController();
                    // Same fix as the streaming loop: force-abort this
                    // attempt once the shared overallDeadline passes,
                    // instead of only checking the deadline between
                    // attempts (which let one stuck attempt run far past
                    // the intended request-wide time budget).
                    const deadlineMsRemainingNonStream = Math.max(0, overallDeadline - Date.now());
                    deadlineTimerNonStream = setTimeout(() => abortController.abort(), deadlineMsRemainingNonStream);

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
                        thinkLevel,
                        onStep: null
                    });

                    clearTimeout(deadlineTimerNonStream);
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
                        // DIAGNOSTICS: ÙÙ‚Ø· ÙˆÙ‚ØªÛŒ finishReason ØºÛŒØ±Ø¹Ø§Ø¯ÛŒ Ø§Ø³Øª
                        // (Ø³Ù‚Ù Ù…Ø±Ø§Ø­Ù„ Ùˆ Ù…Ø´Ø§Ø¨Ù‡ Ø¢Ù†) Ù¾Ø± Ù…ÛŒâ€ŒØ´ÙˆØ¯Ø› Ø±ÙˆÛŒ Ù¾Ø§Ø³Ø®â€ŒÙ‡Ø§ÛŒ
                        // Ù…Ø¹Ù…ÙˆÙ„ÛŒ Ú†ÛŒØ²ÛŒ Ø§Ø¶Ø§ÙÙ‡ Ù†Ù…ÛŒâ€ŒÚ©Ù†Ø¯.
                        ...(agentResult.diagnostics ? { diagnostics: agentResult.diagnostics } : {}),
                        ...(agentResult.editedFiles?.length ? { editedFiles: agentResult.editedFiles } : {}),
                        ...(agentResult.unresolvedEditFailure ? { unresolvedEditFailure: agentResult.unresolvedEditFailure } : {})
                    });

                } catch (error) {
                    clearTimeout(deadlineTimerNonStream);
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
                ? `Ù‡Ù…Ù‡Ù” ${geminiKeys.length} Ú©Ù„ÛŒØ¯ ØªÙ†Ø¸ÛŒÙ…â€ŒØ´Ø¯Ù‡ Ø¯Ø± Ø³Ù‡Ù…ÛŒÙ‡/Ù…Ø­Ø¯ÙˆØ¯ÛŒØª Ù†Ø±Ø® Ú¯ÛŒØ± Ú©Ø±Ø¯Ù†Ø¯Ø› Ù„Ø·ÙØ§Ù‹ Ú©Ù…ÛŒ Ø¨Ø¹Ø¯ Ø¯ÙˆØ¨Ø§Ø±Ù‡ ØªÙ„Ø§Ø´ Ú©Ù†.`
                : classification.message;

        // DIAGNOSTICS: Ù‡Ù…Ø§Ù† Ø§Ù„Ú¯ÙˆÛŒ Ù…Ø³ÛŒØ± streaming - Ø§Ú¯Ø± runAgentLoop ÛŒÚ©
        // diagnostics Ø±ÙˆÛŒ err.body Ú¯Ø°Ø§Ø´ØªÙ‡ Ø¨ÙˆØ¯ (empty_after_tool_call ÛŒØ§
        // tool_loop_limit)ØŒ Ø§ÛŒÙ†Ø¬Ø§ Ù‡Ù… Ø¨Ù‡ detail Ùˆ Ù‡Ù… Ø¨Ù‡ ÙÛŒÙ„Ø¯ Ø¬Ø¯Ø§ Ø§Ø¶Ø§ÙÙ‡â€ŒØ§Ø´ Ú©Ù†.
        const diagnosticsSummaryNonStream = lastError?.diagnostics?.humanSummary || null;
        const detailTextNonStream =
            `Gemini${classification.status ? ' [' + classification.status + ']' : ''}${classification.providerCode ? ' [' + classification.providerCode + ']' : ''}: ${classification.rawMessage || 'unknown'}` +
            ` (actual attempts: ${attemptsTried})` +
            (diagnosticsSummaryNonStream ? `\n\n--- Ø±Ø¯Ù Ø§Ø¬Ø±Ø§ÛŒ Ù…Ø¯Ù„ ---\n${diagnosticsSummaryNonStream}` : '');

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
        // here â€” and calling res.status(...).json(...) on a response whose
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
                                message: 'Ø®Ø·Ø§ÛŒ Ø¯Ø§Ø®Ù„ÛŒ Ø³Ø±ÙˆØ± Ø¯Ø± Ù…ÛŒØ§Ù†Ù‡â€ŒÛŒ Ù¾Ø§Ø³Ø®. Ù„Ø·ÙØ§Ù‹ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.',
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
                // Stream may already be broken/closed â€” nothing more we can do.
            }
            if (!res.writableEnded) {
                try { res.end(); } catch (_) {}
            }
            return;
        }

        return res.status(500).json({
            error: {
                message: 'Ø®Ø·Ø§ÛŒ Ø¯Ø§Ø®Ù„ÛŒ Ø³Ø±ÙˆØ±. Ù„Ø·ÙØ§Ù‹ Ø¯ÙˆØ¨Ø§Ø±Ù‡ Ø§Ù…ØªØ­Ø§Ù† Ú©Ù†.',
                type: 'internal_error',
                category: 'handler',
                stage: 'handler',
                detail: globalError?.message || String(globalError)
            }
        });
    }
}

module.exports = handler;
