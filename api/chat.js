// تابع سرچ هوشمند با Tavily یا DuckDuckGo JSON
async function fetchWebResults(query, tavilyKey) {
    // روش اول: استفاده از API قدرتمند Tavily (اگر کلیدش رو توی Vercel بذاری)
    if (tavilyKey) {
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
                return data.results.map(r => `${r.title}: ${r.content}`).join("\n\n");
            }
        } catch (e) {
            console.error("Tavily Error:", e);
        }
    }

    // روش دوم: استفاده از API متنی DuckDuckGo Lite
    try {
        const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`);
        const data = await res.json();
        let textResults = [];
        if (data.AbstractText) textResults.push(data.AbstractText);
        if (data.RelatedTopics && data.RelatedTopics.length > 0) {
            data.RelatedTopics.slice(0, 3).forEach(t => {
                if (t.Text) textResults.push(t.Text);
            });
        }
        if (textResults.length > 0) return textResults.join("\n---\n");
    } catch (err) {
        console.error("DuckDuckGo API Error:", err);
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
    const tavilyKey = process.env.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 || ""; // کلید سرچ اختیاری

    if (apiKeys.length === 0) {
        return res.status(400).json({ error: { message: 'هیچ کلید API یافت نشد!' } });
    }

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

    // انجام سرچ و تزریق اطلاعات به هوش مصنوعی
    if (webSearch && text) {
        const searchResults = await fetchWebResults(text, tavilyKey);
        const lastIndex = contents.length - 1;
        
        if (searchResults) {
            contents[lastIndex].parts[0].text += `\n\n[اطلاعات واقعی و زنده از اینترنت - با استفاده از این داده‌ها به کاربر پاسخ دقیق بده]:\n${searchResults}`;
        } else {
            // اگر سرچ چیزی نیاورد، دستور بده که بر اساس آخرین تخمین یا قیمت‌های عمومی پاسخ دهد
            contents[lastIndex].parts[0].text += `\n\n[توجه: نتایج سرچ زنده در دسترس نیست، اما تا حد امکان پاسخ کاربر را راهنمایی کن و از دادن پاسخ‌های کلیشه‌ای مثل "به اینترنت دسترسی ندارم" خودداری کن].`;
        }
    }

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
