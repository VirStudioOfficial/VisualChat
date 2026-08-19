// تابع سرچ هوشمند با Tavily
async function fetchTavilyResults(query, tavilyKey) {
    if (!tavilyKey) return null;
    try {
        const res = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: tavilyKey,
                query: query,
                search_depth: "basic",
                max_results: 3
            })
        });
        const data = await res.json();
        if (data.results && data.results.length > 0) {
            return data.results.map(r => `عنوان: ${r.title}\nمتن: ${r.content}`).join("\n\n---\n\n");
        }
    } catch (e) {
        console.error("Tavily Error:", e);
    }
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, persona, file, webSearch, history } = req.body || {};

    const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
    const apiKeys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
    
    // خواندن کلید Tavily مستقیم از Environment Variables یا به عنوان هاردکد در صورت عدم وجود
    const tavilyKey = process.env.TAVILY_API_KEY || "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";

    if (apiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلید API یافت نشد!' } });
    }

    // ۱. ساخت آرایه تاریخچه
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

    // ۲. انجام سرچ زنده با Tavily و تزریق دقیق به پیام کاربر
    if (webSearch && text) {
        const searchResults = await fetchTavilyResults(text, tavilyKey);
        const lastIndex = contents.length - 1;
        
        if (searchResults && contents[lastIndex].role === 'user') {
            // چسباندن نتایج سرچ به انتهای پیام کاربر
            contents[lastIndex].parts[0].text += `\n\n[نتایج جستجوی زنده وب برای این پرسش]:\n${searchResults}\n\n[دستورالعمل: با استفاده از اطلاعات بالا، پاسخ دقیق و به روز ارائه بده.]`;
        }
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

    // ۴. افزودن عکس
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

    const MODEL_NAME = 'gemini-3.5-flash-lite';
    let lastError = null;

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
                lastError = data;
                continue;
            }

            return res.status(200).json(data);

        } catch (err) {
            lastError = err;
        }
    }

    return res.status(500).json({ error: { message: 'خطا در ارتباط با API', details: lastError } });
}
