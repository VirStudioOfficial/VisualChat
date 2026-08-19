export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, persona, file, webSearch, history } = req.body || {};

    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلیدی در تنظیمات Vercel یافت نشد!' } });
    }

    // ۱. ساخت تاریخچه پیام‌ها
    let contents = [];

    if (history && Array.isArray(history) && history.length > 0) {
        contents = history.map(item => ({
            role: item.role === 'user' ? 'user' : 'model',
            parts: [{ text: String(item.text || "") }]
        }));
    } else {
        contents = [{
            role: 'user',
            parts: [{ text: String(text || "") }]
        }];
    }

    // ۲. اعمال پرسونا
    if (persona && contents.length > 0) {
        let prefix = "";
        if (persona === 'friendly') prefix = "[پاسخ را صمیمی و دوستانه بده] ";
        if (persona === 'coder') prefix = "[پاسخ را دقیق و با تمرکز بر کدنویسی بده] ";
        if (persona === 'formal') prefix = "[پاسخ را کاملا رسمی بده] ";
        
        const lastIndex = contents.length - 1;
        if (contents[lastIndex].role === 'user' && contents[lastIndex].parts[0]) {
            contents[lastIndex].parts[0].text = prefix + contents[lastIndex].parts[0].text;
        }
    }

    // ۳. افزودن فایل/عکس
    if (file && file.base64 && contents.length > 0) {
        const base64Data = file.base64.includes(',') ? file.base64.split(',')[1] : file.base64;
        const lastIndex = contents.length - 1;
        contents[lastIndex].parts.push({
            inline_data: {
                mime_type: file.type || 'image/jpeg',
                data: base64Data
            }
        });
    }

    // ۴. تعیین مدل و ابزار سرچ
    // اگر سرچ روشن باشد از 2.5-flash استفاده می‌شود تا ارور ندهد
    const selectedModel = webSearch ? 'gemini-2.5-flash' : 'gemini-3.5-flash-lite';

    const requestBody = { contents: contents };

    if (webSearch) {
        requestBody.tools = [{ google_search: {} }]; // فرمت صحیح سرچ وب برای Gemini
    }

    let lastError = null;

    for (let i = 0; i < apiKeys.length; i++) {
        const currentKey = apiKeys[i];
        
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': currentKey
                },
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();

            if (!response.ok) {
                console.warn(`⚠️ Key #${i + 1} failed with status ${response.status}. Error:`, JSON.stringify(data));
                lastError = data;
                continue; 
            }

            console.log(`✅ Successfully responded using Key #${i + 1} with model ${selectedModel}`);
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
