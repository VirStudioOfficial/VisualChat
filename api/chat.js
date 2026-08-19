export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, persona, file } = req.body || {};

    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلیدی در تنظیمات Vercel یافت نشد!' } });
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
            // ست شده روی gemini-3.5-flash-lite همراه با هدر x-goog-api-key برای کلیدهای AQ
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': currentKey
                },
                body: JSON.stringify({ contents: [{ parts: parts }] })
            });

            const data = await response.json();

            if (!response.ok) {
                console.warn(`⚠️ Key #${i + 1} failed with status ${response.status}. Error:`, JSON.stringify(data));
                lastError = data;
                continue; // سوئیچ به کلید بعدی در صورت ارور
            }

            console.log(`✅ Successfully responded using Key #${i + 1}`);
            return res.status(200).json(data);

        } catch (err) {
            console.error(`Error with Key #${i + 1}:`, err);
            lastError = err;
        }
    }

    return res.status(500).json({
        error: {
            message: 'ارتباط با API گوگل برقرار نشد.',
            details: lastError
        }
    });
}
