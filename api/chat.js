export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const { text } = req.body || {};
    const API_KEY = process.env.GEMINI_API_KEY;

    if (!API_KEY) {
        return res.status(400).json({ 
            error: { message: 'کلید GEMINI_API_KEY در تنظیمات Vercel پیدا نشد! لطفاً متغیر را ست کرده و پروژه را Redeploy کنید.' } 
        });
    }

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: text }] }]
            })
        });

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: { message: 'خطا در ارتباط با سرور گوگل' } });
    }
}
