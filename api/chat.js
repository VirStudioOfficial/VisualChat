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

    // ۱. ساخت و تمیزکاری هیستوری برای رعایت قوانین سخت‌گیرانه گوگل
    let rawContents = [];

    if (history && Array.isArray(history) && history.length > 0) {
        rawContents = history.map(item => ({
            role: item.role === 'user' ? 'user' : 'model',
            text: String(item.text || "").trim()
        })).filter(item => item.text.length > 0); // حذف پیام‌های خالی
    }

    // اگر هیستوری خالی بود یا پیام آخر کاربر نبود، پیام فعلی رو اضافه کن
    if (rawContents.length === 0 || rawContents[rawContents.length - 1].role !== 'user') {
        if (text && text.trim().length > 0) {
            rawContents.push({ role: 'user', text: text.trim() });
        }
    }

    // ادغام پیام‌های متوالی با نقش یکسان (برای جلوگیری از ارور roles must alternate)
    let contents = [];
    for (let item of rawContents) {
        if (contents.length > 0 && contents[contents.length - 1].role === item.role) {
            contents[contents.length - 1].parts[0].text += "\n" + item.text;
        } else {
            contents.push({
                role: item.role,
                parts: [{ text: item.text }]
            });
        }
    }

    // ۲. اعمال پرسونا روی آخرین پیام کاربر
    if (persona && contents.length > 0) {
        let prefix = "";
        if (persona === 'friendly') prefix = "[پاسخ را صمیمی و دوستانه بده] ";
        if (persona === 'coder') prefix = "[پاسخ را دقیق و با تمرکز بر کدنویسی بده] ";
        if (persona === 'formal') prefix = "[پاسخ را کاملا رسمی بده] ";
        
        const lastIndex = contents.length - 1;
        if (contents[lastIndex].role === 'user') {
            contents[lastIndex].parts[0].text = prefix + contents[lastIndex].parts[0].text;
        }
    }

    // ۳. افزودن عکس در صورت وجود به آخرین پیام کاربر
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

    // ۴. ساخت بدنه اصلی درخواست
    const requestBody = { contents: contents };

    if (webSearch) {
        requestBody.tools = [{ googleSearch: {} }];
    }

    // مدل استاندارد و رسمی گوگل (gemini-1.5-flash)
    const MODEL_NAME = 'gemini-1.5-flash';

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
                body: JSON.stringify(requestBody)
            });

            const data = await response.json();

            if (!response.ok) {
                console.warn(`⚠️ Key #${i + 1} failed:`, JSON.stringify(data));
                lastError = data;
                continue; 
            }

            console.log(`✅ Success with Key #${i + 1}`);
            return res.status(200).json(data);

        } catch (err) {
            console.error(`Error with Key #${i + 1}:`, err);
            lastError = err;
        }
    }

    // اگر همه کلیدها خطا دادند، متن دقیق ارور گوگل را برگردان
    return res.status(500).json({
        error: {
            message: 'ارتباط با API گوگل برقرار نشد.',
            google_error: lastError
        }
    });
}
