// pages/api/chat.js

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
        'قیمت', 'چنده', 'نرخ', 'دلار', 'طلا', 'سکه', 'ارز', 'بیت کوین', 'پلی استیشن',
        'اخبار', 'خبر', 'رویداد', 'نتیجه بازی', 'خرید', 'امشب', 'آخرین', 'جدیدترین', 'امروز'
    ];

    return allowedKeywords.some(kw => normalized.includes(kw));
}

async function fetchTavilyResults(query, tavilyKeys) {
    if (!tavilyKeys || tavilyKeys.length === 0) return null;

    for (let i = 0; i < tavilyKeys.length; i++) {
        const currentKey = tavilyKeys[i];
        try {
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: currentKey,
                    query: query,
                    search_depth: "basic",
                    max_results: 4
                })
            });

            if (!res.ok) continue;

            const data = await res.json();
            if (data.results && data.results.length > 0) {
                console.log(`✅ Tavily search succeeded using Key #${i + 1}`);
                return data.results.map(r => `عنوان: ${r.title}\nمنبع: ${r.url}\nمحتوا: ${r.content}`).join("\n\n---\n\n");
            }
        } catch (e) {
            console.error(`❌ Error with Tavily Key #${i + 1}:`, e?.message || e);
        }
    }
    return null;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'متد درخواست پشتیبانی نمی‌شود.' } });
    }

    try {
        // ===== 🔥 دریافت مدل از درخواست =====
        const { userName, text, rawText, file, webSearch, history, model } = req.body || {};
        const searchQueryBase = (rawText && String(rawText).trim()) ? String(rawText).trim() : (text || "");

        const rawGeminiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
        const geminiKeys = rawGeminiKeys.split(',').map(k => k.trim()).filter(Boolean);

        const rawTavilyKeys = process.env.TAVILY_API_KEYS || process.env.TAVILY_API_KEY || "";
        const tavilyKeys = rawTavilyKeys.split(',').map(k => k.trim()).filter(Boolean);

        if (geminiKeys.length === 0) {
            return res.status(400).json({ error: { message: 'هیچ کلید Gemini API تنظیم نشده است!' } });
        }

        let contents = [];

        if (history && Array.isArray(history) && history.length > 0) {
            contents = history.map(item => ({
                role: item.role === 'user' ? 'user' : 'model',
                parts: [{ text: String(item.text || item.content || "") }]
            }));
        } else if (searchQueryBase) {
            contents.push({
                role: 'user',
                parts: [{ text: searchQueryBase }]
            });
        }

        if (contents.length === 0) {
            return res.status(400).json({ error: { message: 'متن ورودی خالی است.' } });
        }

        const isWebSearchActive = webSearch === true || webSearch === 'true';
        const isSearchNeeded = isWebSearchActive && shouldSearchWeb(searchQueryBase);
        res.setHeader('X-Search-Performed', String(isSearchNeeded));

        if (isSearchNeeded && searchQueryBase) {
            console.log(`🔍 Executing Tavily Search for: "${searchQueryBase}"`);
            const searchResults = await fetchTavilyResults(searchQueryBase, tavilyKeys);
            const lastIndex = contents.length - 1;

            if (searchResults && lastIndex >= 0 && contents[lastIndex].role === 'user') {
                contents[lastIndex].parts[0].text += `\n\n[نتایج زنده جستجوی وب]:\n${searchResults}\n\n[دستورالعمل: با کمک اطلاعات فوق پاسخ دقیق، به روز و روان ارائه بده.]`;
            }
        }

        if (file && file.base64 && contents.length > 0) {
            const base64Data = file.base64.includes(',') ? file.base64.split(',')[1] : file.base64;
            const lastIndex = contents.length - 1;
            
            if (contents[lastIndex].role === 'user') {
                let mimeType = file.type || 'image/jpeg';
                
                if (file.name && /\.(mp4|mov|webm|avi|mpeg|wmv|3gpp|flv|mkv)$/i.test(file.name)) {
                    const ext = file.name.split('.').pop().toLowerCase();
                    const mimeMap = {
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
                    mimeType = mimeMap[ext] || 'video/mp4';
                    console.log('🎬 Video detected:', file.name, '->', mimeType);
                }
                
                contents[lastIndex].parts.push({
                    inline_data: {
                        mime_type: mimeType,
                        data: base64Data
                    }
                });
            }
        }

        // ============================================================
        // 🔥 مدل رو از درخواست میگیریم (اگه نباشه، پیش‌فرض)
        // ============================================================
        const MODEL_NAME = model || 'gemini-3.5-flash-lite';
        console.log(`🤖 Using model: ${MODEL_NAME}`);
        let lastError = null;

        // ===== System Instruction (پویا بر اساس مدل) =====
        let systemText = '';
        if (MODEL_NAME === 'gemini-3.5-flash-lite') {
            systemText = `تو Virtual Bot 1.1 هستی، یک هوش مصنوعی سریع و پاسخگو با مدل Gemini 3.5 Flash-Lite.
نام کاربر: "${userName || 'دوست من'}" است.

⚡ ویژگی‌های تو:
- سریع‌ترین پاسخ‌ها
- مناسب برای مکالمات روزمره
- پاسخ‌های مختصر و مفید

📌 دستورالعمل‌ها:
- پاسخ‌ها را کاملاً به فارسی روان بنویس.
- مختصر و مفید پاسخ بده.
- با لحن دوستانه و صمیمی صحبت کن.`;
        } else if (MODEL_NAME === 'gemini-3.6-flash') {
            systemText = `تو Virtual Bot 1.5 هستی، یک هوش مصنوعی پیشرفته با مدل Gemini 3.6 Flash.
نام کاربر: "${userName || 'دوست من'}" است.

🚀 ویژگی‌های تو:
- جدیدترین و به‌روزترین مدل
- دقت بالا در تحلیل متن و تصویر
- پاسخ‌های ساختاریافته و کامل

📌 دستورالعمل‌ها:
- پاسخ‌ها را کاملاً به فارسی روان و محترمانه بنویس.
- اگر کاربر سوال کد/برنامه‌نویسی پرسید، کد کامل و فرمت‌شده بده.
- در صورت نیاز، از اطلاعات جستجوی وب استفاده کن.`;
        } else if (MODEL_NAME === 'gemini-3.1-pro') {
            systemText = `تو Virtual Bot 1.3 هستی، یک هوش مصنوعی حرفه‌ای با مدل Gemini 3.1 Pro.
نام کاربر: "${userName || 'دوست من'}" است.

🧠 ویژگی‌های تو:
- تخصص در کدنویسی و مسائل فنی
- استدلال عمیق و دقیق
- مناسب برای پروژه‌های پیچیده

📌 دستورالعمل‌ها:
- پاسخ‌ها را کاملاً به فارسی روان بنویس.
- برای سوالات کدنویسی، کد کامل با توضیحات دقیق بده.
- با لحن حرفه‌ای و محترمانه صحبت کن.`;
        } else {
            systemText = `تو Virtual Bot هستی، یک هوش مصنوعی حرفه‌ای.
نام کاربر: "${userName || 'دوست من'}" است.
پاسخ‌های دقیق، ساختاریافته و روان به فارسی بده.`;
        }

        if (contents.length > 0 && contents[0].role === 'user') {
            contents[0].parts[0].text = `${systemText}\n\n${contents[0].parts[0].text}`;
        }

        for (let i = 0; i < geminiKeys.length; i++) {
            const currentKey = geminiKeys[i];
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
                    console.warn(`⚠️ Gemini Key #${i + 1} failed for ${MODEL_NAME}:`, data?.error?.message || response.statusText);
                    lastError = data;
                    continue;
                }

                return res.status(200).json(data);

            } catch (err) {
                console.error(`❌ Request Error on Key #${i + 1}:`, err?.message || err);
                lastError = err;
            }
        }

        return res.status(500).json({
            error: {
                message: `خطا در دریافت پاسخ از تمامی کلیدهای Gemini برای مدل ${MODEL_NAME}`,
                details: lastError
            }
        });

    } catch (globalError) {
        console.error("💥 Server Error:", globalError);
        return res.status(500).json({ error: { message: 'خطای داخلی سرور', details: globalError.message } });
    }
}
