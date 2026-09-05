// api/live-token.js
//
// -----------------------------------------------------------------------------
// Ephemeral token issuer for Gemini Live (voice chat)
// -----------------------------------------------------------------------------
// The browser can NOT hold a real Gemini API key (it would be visible to
// anyone via devtools/network tab). Instead, the client calls this endpoint,
// which uses our real GEMINI_API_KEY(S) on the server to ask Google for a
// short-lived "ephemeral token". That token is what gets sent back to the
// browser, and the browser uses it to open a direct WebSocket connection to
// Gemini Live. Even if someone extracts it from the page, it expires in a
// few minutes and only works for a single Live session.
//
// This mirrors the key-rotation approach already used in api/chat.js (try
// keys in order, move on if one fails) but stays intentionally small: no
// history trimming, no tools, no streaming - just "give me a token".
// -----------------------------------------------------------------------------

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-09-2025';

// Token lifetimes: the caller has 1 minute to *open* the WebSocket after
// receiving the token, and once opened, the session can keep sending/
// receiving for up to 30 minutes before needing to reconnect (with session
// resumption, the same token can be used to resume within that window).
const NEW_SESSION_EXPIRE_MINUTES = 1;
const EXPIRE_MINUTES = 30;

function getGeminiKeys() {
    const raw = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}

async function requestEphemeralToken(apiKey) {
    const now = Date.now();
    const expireTime = new Date(now + EXPIRE_MINUTES * 60 * 1000).toISOString();
    const newSessionExpireTime = new Date(now + NEW_SESSION_EXPIRE_MINUTES * 60 * 1000).toISOString();

    const response = await fetch('https://generativelanguage.googleapis.com/v1alpha/auth_tokens', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
            uses: 1,
            expireTime,
            newSessionExpireTime,
            liveConnectConstraints: {
                model: `models/${LIVE_MODEL}`,
                config: {
                    sessionResumption: {},
                    responseModalities: ['AUDIO']
                }
            }
        })
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        const err = new Error(body?.error?.message || `HTTP ${response.status}`);
        err.status = response.status;
        err.body = body;
        throw err;
    }

    if (!body?.name) {
        const err = new Error('Google response missing token name');
        err.body = body;
        throw err;
    }

    return body; // { name, expireTime, newSessionExpireTime }
}

async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const keys = getGeminiKeys();
    if (keys.length === 0) {
        res.status(500).json({ error: 'سرور کلید Gemini ندارد (GEMINI_API_KEY تنظیم نشده).' });
        return;
    }

    let lastError = null;

    // Same spirit as the chat endpoint's key rotation: try each key in turn,
    // move to the next one on failure, so one exhausted/broken key doesn't
    // take down voice chat for everyone.
    for (const key of keys) {
        try {
            const token = await requestEphemeralToken(key);
            res.status(200).json({
                token: token.name,
                model: LIVE_MODEL,
                expireTime: token.expireTime,
                newSessionExpireTime: token.newSessionExpireTime
            });
            return;
        } catch (err) {
            lastError = err;
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: 'warn',
                event: 'live_token_key_failed',
                status: err.status || null,
                message: err.message
            }));
        }
    }

    res.status(502).json({
        error: 'گرفتن توکن موقت از گوگل ناموفق بود. لطفاً دوباره امتحان کن.',
        detail: lastError ? lastError.message : null
    });
}

module.exports = handler;
