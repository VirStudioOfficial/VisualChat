// تابع تشخیص هوشمند نیاز به سرچ وب
function shouldSearchWeb(userText) {
    if (!userText) return false;

    const cleanText = userText.trim().toLowerCase();
    if (cleanText.length < 3) return false;

    const ignoreList = [
        'سلام', 'سلامم', 'درود', 'چطوری', 'خوبی', 'صبح بخیر', 'عصر بخیر',
        'شب بخیر', 'ممنون', 'مرسی', 'چخبر', 'خداحافظ', 'بای', 'اوکی', 'باشه'
    ];

    const normalized = cleanText.replace(/[!.،,؟?]/g, '').trim();
    const firstWord = normalized.split(' ')[0];
    const wordCount = normalized.split(' ').filter(Boolean).length;

    if (wordCount <= 3 && (ignoreList.includes(normalized) || ignoreList.includes(firstWord))) {
        return false;
    }

    const allowedKeywords = [
        'سرچ', 'جستجو', 'گوگل', 'اینترنت', 'توی وب', 'بررسی کن', 'سرچ کن',
        'قیمت', 'چنده', 'نرخ', 'دلار', 'طلا', 'سکه', 'ارز', 'بیت کوین', 'پلی استیشن',
        'اخبار', 'خبر', 'رویداد', 'نتیجه بازی', 'خرید', 'امشب', 'آخرین', 'جدیدترین'
    ];

    return allowedKeywords.some(kw => normalized.includes(kw));
}

// تابع سرچ Tavily
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
                    max_results: 3
                })
            });

            if (!res.ok) continue;

            const data = await res.json();
            if (data.results && data.results.length > 0) {
                console.log(`✅ Tavily search succeeded using Key #${i + 1}`);
                return data.results.map(r => `عنوان: ${r.title}\nمتن: ${r.content}`).join("\n\n---\n\n");
            }
        } catch (e) {
            console.error(`Error with Tavily Key #${i + 1}:`, e);
        }
    }
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, rawText, file, webSearch, history } = req.body || {};
    const searchQueryBase = (rawText && String(rawText).trim()) ? String(rawText).trim() : text;

    console.log("👉 RAW USER TEXT:", rawText);

    const rawGeminiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const geminiKeys = rawGeminiKeys.split(',').map(k => k.trim()).filter(Boolean);

    const rawTavilyKeys = process.env.TAVILY_API_KEYS || process.env.TAVILY_API_KEY || "";
    const tavilyKeys = rawTavilyKeys.split(',').map(k => k.trim()).filter(Boolean);

    if (geminiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلید Gemini یافت نشد!' } });
    }

    let contents = [];

    // ۱. بازسازی تاریخچه چت (اصلاح منطق تکرار)
    if (history && Array.isArray(history) && history.length > 0) {
        contents = history.map(item => ({
            role: item.role === 'user' ? 'user' : 'model',
            parts: [{ text: String(item.text || "") }]
        }));
    } else {
        contents.push({
            role: 'user',
            parts: [{ text: String(text || searchQueryBase || "") }]
        });
    }

    // ۲. بررسی و تزریق سرچ وب
    const isWebSearchActive = webSearch === true || webSearch === 'true';
    const isSearchNeeded = isWebSearchActive && shouldSearchWeb(searchQueryBase);

    if (isSearchNeeded && searchQueryBase) {
        console.log(`🔍 Executing Tavily Search for: "${searchQueryBase}"`);
        const searchResults = await fetchTavilyResults(searchQueryBase, tavilyKeys);
        const lastIndex = contents.length - 1;

        if (searchResults && lastIndex >= 0 && contents[lastIndex].role === 'user') {
            contents[lastIndex].parts[0].text += `\n\n[نتایج جستجوی زنده وب برای این پرسش]:\n${searchResults}\n\n[دستورالعمل: با استفاده از اطلاعات بالا، پاسخ دقیق و به روز ارائه بده.]`;
        }
    } else {
        console.log(`⏩ SKIPPED SEARCH FOR: "${searchQueryBase}"`);
    }

    // ۳. تزریق فایل/عکس به آخرین پیام
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

    res.setHeader('X-Search-Performed', String(isSearchNeeded));

    const MODEL_NAME = 'gemini-3.5-flash-lite';
    let lastError = null;

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
                lastError = data;
                continue;
            }

            return res.status(200).json(data);

        } catch (err) {
            lastError = err;
        }
    }

    return res.status(500).json({ error: { message: 'خطا در ارتباط با API جمینای', details: lastError } });
}
