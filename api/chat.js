export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, persona, file } = req.body || {};

    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلید API در تنظیمات Vercel پیدا نشد!' } });
    }

    const parts = [];
    if (file && file.base64) {
        const base64Data = file.base64.split(',')[1];
        parts.push({
            inline_data: {
                mime_type: file.type || 'image/jpeg',
                data: base64Data
            }
        });
    }

    let promptText = text || "";
    if (persona === 'friendly') promptText = "[پاسخ را صمیمی و دوستانه بده] " + promptText;
    if (persona === 'coder') promptText = "[پاسخ را دقیق و با تمرکز بر کدنویسی بده] " + promptText;
    if (persona === 'formal') promptText = "[پاسخ را کاملا رسمی بده] " + promptText;

    if (promptText) parts.push({ text: promptText });

    let lastError = null;

    for (let i = 0; i < apiKeys.length; i++) {
        const currentKey = apiKeys[i];
        
        try {
            // تنظیم دقیق روی مدل 3.5 Flash-Lite برای کمترین مصرف توکن و بالاترین سرعت
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${currentKey}`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ contents: [{ parts: parts }] })
            });

            const data = await response.json();

            if (response.status === 429) {
                lastError = data;
                continue; 
            }

            if (!response.ok) {
                lastError = data;
                continue;
            }

            return res.status(200).json(data);

        } catch (err) {
            lastError = err;
        }
    }

    return res.status(500).json({
        error: {
            message: 'خطا در برقراری ارتباط با API. لطفاً تنظیمات کلیدها را بررسی کنید.',
            details: lastError
        }
    });
}
