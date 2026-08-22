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
                    'هر وقت لازم بود می‌توانی این ابزار را چند بار با query های متفاوت صدا بزنی ' +
                    '(مثلاً اول یک جستجوی کلی، بعد بر اساس نتیجه یک جستجوی دقیق‌تر).',
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
    return 'در حال انجام یک مرحله...';
}

async function executeToolCall(name, args, ctx) {
    if (name === 'web_search') {
        const query = (args && args.query) || '';
        if (!query) return { error: 'query خالی بود.' };

        log.info('agent.tool.web_search', { queryPreview: query.slice(0, 100) });

        const results = await fetchTavilyResults(query, ctx.tavilyKeys);

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

// Runs the model <-> tool loop against Gemini's non-streaming generateContent
// endpoint (function calling requires seeing the full structured response,
// including functionCall parts, before deciding what to do next - this
// can't be driven off the raw text SSE stream). Once the model returns a
// final text-only answer (no more functionCalls), that final answer is
// streamed to the client character-by-chunk to preserve the existing
// "live typing" UX, and every tool call along the way is narrated via
// onStep(label) before it runs.
async function runAgentLoop({ currentModel, currentKey, systemText, contents, tavilyKeys, onStep, signal }) {
    const MAX_TOOL_ROUNDS = 4; // hard safety cap so a confused model can't loop forever
    let workingContents = [...contents];
    let lastUsage = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        // Also abort this round if the caller's own signal (client disconnect
        // / overall deadline) fires.
        const onAbort = () => controller.abort();
        if (signal) signal.addEventListener('abort', onAbort);

        let upstream;
        try {
            upstream = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': currentKey
                    },
                    body: JSON.stringify({
                        system_instruction: { parts: [{ text: systemText }] },
                        contents: workingContents,
                        tools: GEMINI_TOOLS
                    }),
                    signal: controller.signal
                }
            );
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

        const data = await upstream.json();
        const candidate = data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        lastUsage = data?.usageMetadata || lastUsage;

        const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
        const textParts = parts.filter(p => typeof p.text === 'string').map(p => p.text);

        if (functionCalls.length === 0) {
            // Final answer - no more tools requested.
            return {
                finalText: textParts.join(''),
                finishReason: candidate?.finishReason || null,
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

        for (const call of functionCalls) {
            const label = describeToolCall(call.name, call.args);
            if (onStep) {
                try { onStep(label, call.name); } catch (_) {}
            }

            const result = await executeToolCall(call.name, call.args, { tavilyKeys });

            if (result.askUser) {
                // Don't bother calling any further tools this round - surface
                // the question to the user right away.
                earlyAskUser = result.askUser;
            }

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
        | Web Search
        |--------------------------------------------------------------------------
        | FIX: search used to be decided here, up-front, by matching the
        | user's text against a fixed Persian keyword list - which missed
        | anything phrased differently. Search is now a real tool the model
        | itself can call mid-conversation (see runAgentLoop / GEMINI_TOOLS),
        | as many times as it judges necessary, based on actually
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
- ابزار ask_user را فقط برای تغییرات اساسی/غیرقابل‌برگشت یا تصمیم‌هایی با چند راه‌حل متفاوت صدا بزن (مثلاً بازنویسی کامل یک فایل، حذف بخش بزرگ کد). برای کارهای کوچک یا واضح، مستقیم انجام بده و از این ابزار استفاده نکن.
`;

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

                        const agentResult = await runAgentLoop({
                            currentModel,
                            currentKey,
                            systemText,
                            contents,
                            tavilyKeys,
                            signal: abortController.signal,
                            onStep: (label, toolName) => {
                                if (toolName === 'web_search') searchWasPerformed = true;
                                res.write(
                                    `data: ${JSON.stringify({ step: label })}\n\n`
                                );
                                if (typeof res.flush === 'function') res.flush();
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

                        const finalText = agentResult.finalText || '';

                        if (finalText) {
                            res.write(
                                `data: ${JSON.stringify({ text: finalText })}\n\n`
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
                        markKeyResult(currentKey, false);
                        log.error('model.stream_error', {
                            model: currentModel,
                            message: error?.message || String(error),
                            wasTimeout: error?.name === 'AbortError',
                            connectMs: Date.now() - attemptStartedAt
                        });

                        lastError = error?.body || error;
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
                        signal: abortController.signal,
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
                    markKeyResult(currentKey, false);
                    log.error('model.error', {
                        mode: 'non-stream',
                        model: currentModel,
                        message: error?.message || String(error)
                    });

                    lastError = error?.body || error;
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
                                type: 'api_error',
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
                type: 'api_error',
                stage: 'handler',
                detail: globalError?.message || String(globalError)
            }
        });
    }
}

module.exports = handler;
