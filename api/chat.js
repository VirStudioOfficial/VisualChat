// تابع کمکی برای سرچ رایگان در DuckDuckGo (بدون نیاز به API Key و بدون لیمیت)
async function fetchDuckDuckGoResults(query) {
    try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        });
        const html = await response.text();
        
        // استخراج خلاصه‌ها از ساختار HTML
        const matches = [...html.matchAll(/<a class="result__snippet[^>]*>(.*?)<\/a>/g)];
        const snippets = matches
            .slice(0, 4)
            .map(m => m[1].replace(/<[^>]+>/g, '').trim())
            .filter(Boolean);
            
        return snippets.join("\n---\n");
    } catch (err) {
        console.error("DuckDuckGo Search Error:", err);
        return null;
    }
}

export default async function handler(req, res) {
    // ۱. بررسی متد درخواست
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    // ۲. دریافت ورودی‌ها از فرانت‌اند
    const { text, persona, file, webSearch, history } = req.body || {};

    // ۳. خواندن API Keyها از تنظیمات Vercel
    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);

    if (apiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلید API در تنظیمات Vercel یافت نشد!' } });
    }

    // ۴. ساخت ساختار تاریخچه چت (Contents)
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

    // ۵. انجام سرچ وب مستقل و چسباندن نتایج به پیام کاربر
    if (webSearch && text) {
        const searchResults = await fetchDuckDuckGoResults(text);
        if (searchResults && searchResults.length > 0) {
            const lastIndex = contents.length - 1;
            if (contents[lastIndex].role === 'user') {
                contents[lastIndex].parts[0].text += `\n\n[اطلاعات زنده دریافت شده از سرچ وب]:\n${searchResults}`;
            }
        }
    }

    // ۶. اعمال پرسونا روی پیام کاربر
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

    // ۷. افزودن تصویر در صورت وجود به آخرین پیام
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

    // ۸. مدل دقیق Gemini 3.5 Flash Lite
    const MODEL_NAME = 'gemini-3.5-flash-lite';
    let lastError = null;

    // ۹. چرخش روی کلیدها برای جلوگیری از ارور
    for (let i = 0; i < apiKeys.length; i++) {
        const currentKey = apiKeys[i];
        
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': currentKey
                },
                body: JSON.stringify({ contents: contents })
            });

            const data = await response.json();

            if (!response.ok) {
                console.warn(`⚠️ Key #${i + 1} failed:`, JSON.stringify(data));
                lastError = data;
                continue; // سوئیچ به کلید بعدی
            }

            console.log(`✅ Success with Key #${i + 1}`);
            return res.status(200).json(data);

        } catch (err) {
            console.error(`Error with Key #${i + 1}:`, err);
            lastError = err;
        }
    }

    // ۱۰. بازگرداندن خطا در صورت ناموفق بودن همه کلیدها
    return res.status(500).json({
        error: {
            message: 'ارتباط با API گوگل برقرار نشد.',
            details: lastError
        }
    });
}
