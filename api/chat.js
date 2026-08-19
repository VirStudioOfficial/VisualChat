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

    // ۱. ساخت آرایه contents از روی history فرستاده شده از فرانت‌اند
    let contents = [];

    if (history && Array.isArray(history) && history.length > 0) {
        contents = history.map(item => ({
            role: item.role === 'user' ? 'user' : 'model',
            parts: [{ text: item.text }]
        }));
    } else {
        // اگر هیستوری نبود، فقط پیام فعلی رو قرار بده
        contents = [{
            role: 'user',
            parts: [{ text: text || "" }]
        }];
    }

    // ۲. اگر فایلی (عکس) در پیام آخر ارسال شده، به آخرین پیام اضافه شو
    if (file && file.base64 && contents.length > 0) {
        const base64Data = file.base64.split(',')[1];
        const lastIndex = contents.length - 1;
        contents[lastIndex].parts.unshift({
            inline_data: {
                mime_type: file.type || 'image/jpeg',
                data: base64Data
            }
        });
    }

    // ۳. ابزار سرچ وب گوگل
    const tools = webSearch ? [{ googleSearch: {} }] : [];

    let lastError = null;

    for (let i = 0; i < apiKeys.length; i++) {
        const currentKey = apiKeys[i];
        
        try {
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': currentKey
                },
                body: JSON.stringify({ 
                    contents: contents, // فرستادن کل تاریخچه
                    tools: tools        // سرچ فعال یا غیرفعال
                })
            });

            const data = await response.json();

            if (!response.ok) {
                console.warn(`⚠️ Key #${i + 1} failed with status ${response.status}. Error:`, JSON.stringify(data));
                lastError = data;
                continue; 
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
