export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text, persona, file } = req.body || {};

    // لیست کلیدهای API جدیدت
    const apiKeys = [
        "AQ.Ab8RN6L0p1VIuvpBg5uQShaaXRYNM3EtyBqvuTEpl9j-tsFpdA",
        "AQ.Ab8RN6IMVYdAJKGRtH17J2Q4LNzVdml2SNKE96e3U1IBkX0vvA",
        process.env.GEMINI_API_KEY // کلید قبلی در Vercel (در صورت وجود)
    ].filter(Boolean);

    // آماده‌سازی بدنه درخواست
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

    // چرخیدن روی کلیدها در صورت دریافت ارور ۴۲۹
    for (let i = 0; i < apiKeys.length; i++) {
        const currentKey = apiKeys[i].trim();
        
        try {
            // استفاده از مدل بهینه Flash برای سرعت بیشتر و مصرف توکن کمتر
            const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': currentKey
                },
                body: JSON.stringify({ contents: [{ parts: parts }] })
            });

            const data = await response.json();

            // اگر این کلید لیمیت شد، بلافاصله کلید بعدی امتحان میشه
            if (response.status === 429) {
                console.warn(`Key index ${i} hit limit. Switched to next key.`);
                lastError = data;
                continue; 
            }

            if (!response.ok) {
                return res.status(response.status).json(data);
            }

            // پاسخ موفقیت‌آمیز
            return res.status(200).json(data);

        } catch (err) {
            lastError = err;
        }
    }

    // اگر تمام کلیدها لیمیت بودند
    return res.status(429).json({
        error: {
            message: 'تمامی کلیدهای API فعال در حال حاضر محدود شده‌اند. لطفا ۴۵ ثانیه دیگر تلاش کنید.'
        }
    });
}
