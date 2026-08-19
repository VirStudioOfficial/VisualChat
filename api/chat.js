// تابع تشخیص هوشمند نیاز به سرچ زنده
function shouldSearchWeb(userText) {
    if (!userText) return false;
    
    // ۱. نرمال‌سازی متن (حذف فاصله‌های اضافی و کوچک کردن کلمات)
    const text = userText.trim().toLowerCase();

    // ۲. فیلتر کلمات کوتاه یا پیام‌های سلام/احوال‌پرسی (قطعاً نباید سرچ شوند)
    const simpleGreetings = [
        'سلام', 'سلامم', 'سلام خوبی', 'درود', 'چطوری', 'خوبی', 
        'صبح بخیر', 'عصر بخیر', 'شب بخیر', 'ممنون', 'مرسی', 
        'سلام مخلصم', 'سلام علیکم', 'چخبر', 'چه خبر', 'باشه', 'اوکی'
    ];

    if (simpleGreetings.includes(text) || text.length < 4) {
        return false;
    }

    // ۳. لیست صریح موضوعاتی که حتماً نیازمند دیتای زنده/سرچ هستند
    const searchTriggers = [
        // درخواست مستقیم
        'سرچ', 'جستجو', 'گوگل', 'اینترنت', 'توی وب', 'بررسی کن', 'سرچ کن',
        // قیمت و بازار
        'قیمت', 'چنده', 'نرخ', 'دلار', 'طلا', 'سکه', 'ارز', 'بیت کوین', 'پلی استیشن',
        // زمان و اخبار
        'امروز', 'اخبار', 'خبر', 'رویداد', 'نتیجه بازی', 'خرید', 'امشب', 'آخرین'
    ];

    // فقط اگر حداقل یکی از کلمات کلیدی بالا در متن کاربر وجود داشت، مجوز سرچ صادر می‌شود
    return searchTriggers.some(trigger => text.includes(trigger));
}

// تابع سرچ چرخشی با کلیدهای Tavily
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

            if (!res.ok) {
                console.warn(`⚠️ Tavily Key #${i + 1} failed with status ${res.status}. Trying next key...`);
                continue;
            }

            const data = await res.json();
            if (data.results && data.results.length > 0) {
                console.log(`✅ Tavily search succeeded using Key #${i + 1}`);
                return data.results.map(r => `عنوان: ${r.title}\nمتن: ${r.content}`).join("\n\n---\n\n");
            }
        } catch (e) {
            console.error(`Error with Tavily Key #${i + 1}:`, e);
        }
    }

    console.error("❌ All Tavily API keys have failed or reached their limits!");
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, persona, file, webSearch, history } = req.body || {};

    const rawGeminiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const geminiKeys = rawGeminiKeys.split(',').map(k => k.trim()).filter(Boolean);

    const rawTavilyKeys = process.env.TAVILY_API_KEYS || process.env.TAVILY_API_KEY || "";
    const tavilyKeys = rawTavilyKeys.split(',').map(k => k.trim()).filter(Boolean);

    if (geminiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلید Gemini در تنظیمات ورسل یافت نشد!' } });
    }

    // ۱. آماده‌سازی تاریخچه چت
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

    // ۲. ارزیابی دقیق شرط سرچ
    // سرچ فقط در صورتی اجرا می‌شود که هم دکمه سرچ روشن باشد هم تابع تشخیص دهد متن نیازمند سرچ است
    const isSearchNeeded = Boolean(webSearch) && shouldSearchWeb(text);

    if (isSearchNeeded && text) {
        console.log(`🔍 Executing Tavily Search for: "${text}"`);
        const searchResults = await fetchTavilyResults(text, tavilyKeys);
        const lastIndex = contents.length - 1;
        
        if (searchResults && contents[lastIndex].role === 'user') {
            contents[lastIndex].parts[0].text += `\n\n[نتایج جستجوی زنده وب برای این پرسش]:\n${searchResults}\n\n[دستورالعمل: با استفاده از اطلاعات بالا، پاسخ دقیق و به روز ارائه بده.]`;
        }
    } else {
        console.log(`⏩ Skipping web search for: "${text}"`);
    }

    // ۳. اعمال پرسونا
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

    // ۴. افزودن تصویر
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

    // ۵. ارسال به مدل Gemini 3.5 Flash Lite
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
