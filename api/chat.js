export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text } = req.body || {};
    const API_KEY = process.env.GEMINI_API_KEY;

    if (!API_KEY) {
        return res.status(400).json({ 
            error: { message: 'کلید GEMINI_API_KEY در Vercel پیدا نشد!' } 
        });
    }

    try {
        // ارسال کلید جدید AQ در هدر اختصاصی گوگل به جای انتهای لینک
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': API_KEY.trim()
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: text }] }]
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json(data);
        }

        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: { message: 'خطا در ارتباط با سرور گوگل' } });
    }
}
