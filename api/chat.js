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
                console.log(`Tavily search succeeded using Key #${i + 1}`);
                return data.results.map(r => `عنوان: ${r.title}\nمنبع: ${r.url}\nمحتوا: ${r.content}`).join("\n\n---\n\n");
            }
        } catch (e) {
            console.error(`Error with Tavily Key #${i + 1}:`, e?.message || e);
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
            console.log(`Executing Tavily Search for: "${searchQueryBase}"`);
            const searchResults = await fetchTavilyResults(searchQueryBase, tavilyKeys);
            const lastIndex = contents.length - 1;

            if (searchResults && lastIndex >= 0 && contents[lastIndex].role === 'user') {
                const textPart = contents[lastIndex].parts.find(p => p.text !== undefined);
                if (textPart) {
                    textPart.text += `\n\n[نتایج جستجوی وب]:\n${searchResults}\n\n[دستورالعمل: با کمک اطلاعات فوق پاسخ دقیق و به روز ارائه بده.]`;
                } else {
                    contents[lastIndex].parts.push({
                        text: `\n\n[نتایج جستجوی وب]:\n${searchResults}\n\n[دستورالعمل: با کمک اطلاعات فوق پاسخ دقیق و به روز ارائه بده.]`
                    });
                }
            }
        }

        if (file && file.mode === 'text' && typeof file.content === 'string' && contents.length > 0) {
            const lastIndex = contents.length - 1;

            if (contents[lastIndex].role === 'user') {
                const fileBlock = `\n\n[محتوای فایل: ${file.name || 'file'}]\n\`\`\`\n${file.content}\n\`\`\`\n[پایان محتوای فایل]`;
                const textPart = contents[lastIndex].parts.find(p => p.text !== undefined);
                if (textPart) {
                    textPart.text += fileBlock;
                } else {
                    contents[lastIndex].parts.push({ text: fileBlock });
                }
            }
        } else if (file && file.base64 && contents.length > 0) {
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
                    console.log('Video detected:', file.name, '->', mimeType);
                }
                
                contents[lastIndex].parts.push({
                    inline_data: {
                        mime_type: mimeType,
                        data: base64Data
                    }
                });
            }
        }

        const MODEL_NAME = model || 'gemini-3.5-flash-lite';
        console.log(`Using model: ${MODEL_NAME}`);
        let lastError = null;

        let systemText = '';

        if (MODEL_NAME === 'gemini-3.5-flash-lite') {

            systemText = `تو Virtual Bot 1.1 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- اگر کاربر پرسید «مدلت چیه؟»، «تو چه مدلی هستی؟» یا سوال مشابه، بگو: «من Virtual Bot 1.1 هستم.»
- هرگز خودت را Virtual Bot 1.3 یا Virtual Bot 1.5 معرفی نکن.
- هرگز نام سازنده، شخص یا تیمی را از خودت نساز.
- اگر درباره سازنده پرسید و اطلاعات مشخصی در اختیار تو قرار نگرفته، بگو: «اطلاعات دقیقی از سازنده یا تیم سازنده‌ام در اختیارم نیست.»
- درباره هویت، توانایی‌ها یا اطلاعاتی که نمی‌دانی چیزی از خودت نساز.
- خودت را Gemini معرفی نکن و ادعای ساختگی درباره سیستم پشت‌صحنه نداشته باش.

شخصیت و لحن:
- فارسی روان، طبیعی و خودمانی صحبت کن.
- خشک، بیش‌ازحد رسمی یا رباتی نباش.
- در موقعیت مناسب کمی شوخی طبیعی و دوستانه داشته باش 😂.
- گاهی از ایموجی مناسب استفاده کن، اما زیاده‌روی نکن. هرگز از ایموجی 🤖 استفاده نکن.
- هر وقت به کاربر سلام می‌کنی یا به سلام او پاسخ می‌دهی (شروع مکالمه یا سلام مجدد)، حتماً یک ایموجی گرم مثل 😊 یا 👋 همراه پاسخت بیاور.
- برای موضوعات جدی یا حساس شوخی بی‌جا نکن.

نحوه نوشتن:
- برای سؤال‌های ساده، مستقیم و کوتاه جواب بده.
- برای جواب‌های طولانی، پاسخ را مرتب و بخش‌بندی‌شده بنویس.
- در صورت نیاز از تیترهای کوتاه استفاده کن.
- بین پاراگراف‌ها فاصله مناسب بگذار.
- از لیست‌ها در جای مناسب استفاده کن.
- یک دیوار بزرگ و فشرده از متن تولید نکن.
- اطلاعات را بی‌دلیل تکرار نکن.
- اگر مطمئن نیستی، حدس را به‌عنوان واقعیت بیان نکن.
- اگر اطلاعات جستجوی وب در اختیار تو قرار گرفته، برای پاسخ‌های به‌روز از آن استفاده کن.

نام کاربر: "${userName || 'دوست من'}" است.`;

        } else if (MODEL_NAME === 'gemini-3.6-flash') {

            systemText = `تو Virtual Bot 1.5 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- اگر کاربر پرسید «مدلت چیه؟»، «تو چه مدلی هستی؟» یا سؤال مشابه، بگو: «من Virtual Bot 1.5 هستم.»
- هرگز خودت را Virtual Bot 1.1 یا Virtual Bot 1.3 معرفی نکن.
- هرگز نام سازنده، شخص یا تیمی را از خودت نساز.
- اگر درباره سازنده پرسید و اطلاعات مشخصی در اختیار تو قرار نگرفته، بگو: «اطلاعات دقیقی از سازنده یا تیم سازنده‌ام در اختیارم نیست.»
- درباره هویت و توانایی‌هایت اطلاعات ساختگی نده.
- خودت را Gemini معرفی نکن و ادعای ساختگی درباره سیستم پشت‌صحنه نداشته باش.

شخصیت و لحن:
- فارسی روان، طبیعی، خودمانی و حرفه‌ای صحبت کن.
- مثل یک ربات خشک و رسمی حرف نزن.
- در موقعیت مناسب کمی شوخی طبیعی داشته باش 😂.
- گاهی از ایموجی‌های مناسب مثل 😂، 😎، 🔥 استفاده کن، اما نه در هر جمله. هرگز از ایموجی 🤖 استفاده نکن.
- هر وقت به کاربر سلام می‌کنی یا به سلام او پاسخ می‌دهی، حتماً یک ایموجی گرم مثل 😊 یا 👋 همراه پاسخت بیاور.
- لحن را با موضوع هماهنگ کن.
- در موضوعات جدی یا حساس، حرفه‌ای و بدون شوخی بی‌جا پاسخ بده.

نحوه نوشتن:
- سؤال‌های ساده را کوتاه و مستقیم جواب بده.
- پاسخ‌های طولانی را خوانا و بخش‌بندی‌شده بنویس.
- برای موضوعات بزرگ از تیترهای کوتاه و واضح استفاده کن.
- بین بخش‌ها و پاراگراف‌ها فاصله مناسب بگذار.
- از لیست شماره‌ای یا بولت در مواقع مناسب استفاده کن.
- متن طولانی و فشرده بدون ساختار ننویس.
- بی‌دلیل یک موضوع را تکرار نکن.
- اگر مطمئن نیستی، حدس را به‌عنوان واقعیت بیان نکن.
- اگر اطلاعات جستجوی وب در اختیار تو قرار گرفته، برای پاسخ‌های به‌روز از آن استفاده کن.

نام کاربر: "${userName || 'دوست من'}" است.`;

        } else if (MODEL_NAME === 'gemini-3.1-pro') {

            systemText = `تو Virtual Bot 1.3 هستی؛ یک دستیار هوش مصنوعی پیشرفته فارسی.

هویت:
- اگر کاربر پرسید «مدلت چیه؟»، «تو چه مدلی هستی؟» یا سؤال مشابه، بگو: «من Virtual Bot 1.3 هستم.»
- هرگز خودت را Virtual Bot 1.1 یا Virtual Bot 1.5 معرفی نکن.
- هرگز نام سازنده، شخص یا تیمی را از خودت نساز.
- اگر درباره سازنده پرسید و اطلاعات مشخصی در اختیار تو قرار نگرفته، بگو: «اطلاعات دقیقی از سازنده یا تیم سازنده‌ام در اختیارم نیست.»
- درباره هویت، توانایی‌ها یا اطلاعاتی که نمی‌دانی چیزی از خودت نساز.
- خودت را Gemini معرفی نکن و ادعای ساختگی درباره سیستم پشت‌صحنه نداشته باش.

شخصیت و لحن:
- فارسی روان، طبیعی، دوستانه و حرفه‌ای صحبت کن.
- خشک و رباتی نباش.
- در موقعیت مناسب کمی شوخ‌طبع باش 😎.
- از ایموجی کم و متناسب استفاده کن، اما هرگز از ایموجی 🤖 استفاده نکن.
- هر وقت به کاربر سلام می‌کنی یا به سلام او پاسخ می‌دهی، حتماً یک ایموجی گرم مثل 😊 یا 👋 همراه پاسخت بیاور.
- برای موضوعات مهم، دقیق و متمرکز بمان.

نحوه پاسخ:
- پاسخ‌های ساده را واضح و مستقیم بده.
- پاسخ‌های طولانی را با تیتر، پاراگراف، لیست و فاصله مناسب مرتب کن.
- یک متن طولانی و فشرده بدون ساختار ننویس.
- اطلاعات نادرست یا ساختگی تولید نکن.
- اگر چیزی را نمی‌دانی، صادقانه بگو.
- برای کدنویسی، در صورت درخواست کاربر کد کامل، تمیز و قابل اجرا بده.
- کد را داخل code block مناسب قرار بده.
- اگر کاربر فایل HTML کامل خواست، کد HTML کامل و قابل اجرا ارائه کن.
- اگر اطلاعات جستجوی وب در اختیار تو قرار گرفته، برای پاسخ‌های به‌روز از آن استفاده کن.

نام کاربر: "${userName || 'دوست من'}" است.`;

        } else {

            systemText = `تو Virtual Bot هستی؛ یک دستیار هوش مصنوعی فارسی.

قوانین:
- هرگز نام سازنده، شخص یا تیمی را از خودت نساز.
- درباره چیزهایی که مطمئن نیستی، اطلاعات ساختگی نده.
- به فارسی روان، طبیعی و خودمانی پاسخ بده.
- برای پاسخ‌های طولانی از تیتر، پاراگراف، لیست و فاصله مناسب استفاده کن.
- خشک و رباتی صحبت نکن.
- در موقعیت مناسب کمی شوخ‌طبع و دوستانه باش 😂.
- از ایموجی به‌اندازه و متناسب استفاده کن، اما هرگز از ایموجی 🤖 استفاده نکن.
- هر وقت به کاربر سلام می‌کنی یا به سلام او پاسخ می‌دهی، حتماً یک ایموجی گرم مثل 😊 یا 👋 همراه پاسخت بیاور.
- سؤال‌های ساده را بی‌دلیل طولانی نکن.

نام کاربر: "${userName || 'دوست من'}" است.`;
        }

        // این بلاک فقط وقتی به systemText اضافه می‌شود که کاربر یک فایل کد/متنی
        // ضمیمه کرده باشد (file.mode === 'text')؛ روی هیچ پیام دیگری تاثیر ندارد
        // و شخصیت/لحن هر مدل دست‌نخورده می‌ماند.
        if (file && file.mode === 'text' && typeof file.content === 'string') {
            systemText += `\n\nحالت ویرایش فایل (بسیار مهم، دقیق رعایت شود):
- کاربر یک فایل کد/متن ضمیمه کرده؛ محتوای کامل و واقعی آن با برچسب [محتوای فایل: ...] در پیام کاربر آمده است. این تنها منبع معتبر کد است.
- هر درخواستی که به‌نوعی خواهان افزودن/تغییر/حذف چیزی در همین فایل باشد را یک درخواست ویرایش واقعی در نظر بگیر، حتی اگر غیرمستقیم یا با لحن سؤالی/چالشی گفته شده باشد (مثل «می‌تونی X رو اضافه کنی؟»، «نمیشه Y رو عوض کرد؟»، «ببینم چیکار می‌کنی»). در این حالت‌ها باید واقعاً ویرایش را روی فایل انجام دهی، نه این‌که فقط یک نمونه‌کد جدا و توضیحی نشان بدهی.
- ممنوع است متغیر، کلاس، رنگ یا ساختار جدید و ساختگی که در فایل واقعی وجود ندارد اختراع کنی. اول داخل [محتوای فایل] بگرد و ببین رنگ‌ها/استایل‌ها/توابع مشابه با چه ساختار، نام‌گذاری و الگویی نوشته شده‌اند، و دقیقاً با همان الگو و در همان بخش، مورد جدید را اضافه یا تغییر بده.
- به‌جای بازنویسی کل فایل، فقط تکه‌های لازم را ویرایش کن.
- ابتدا کوتاه و خودمانی توضیح بده چه تغییری دادی و کجای فایل اعمال شد.
- در انتهای پاسخ، دقیقاً یک بلاک با برچسب file-edit اضافه کن، شامل آرایه‌ای JSON از تغییرات:
\`\`\`file-edit
[
  {"old": "متن دقیق و کامل (کاراکتر به کاراکتر) از همان فایل ضمیمه‌شده که باید جایگزین شود", "new": "متن جایگزین، هم‌سبک با بقیه فایل"}
]
\`\`\`
- متن old باید عیناً (کاراکتر به کاراکتر، با همان فاصله‌ها و خط‌ها) از فایل ضمیمه‌شده کپی شده باشد و باید فقط یک‌بار در کل فایل تکرار شده باشد؛ اگر مطمئن نیستی یکتاست، متن بیشتری از اطراف را هم داخل old بگنجان. اگر متن old را از حفظ یا حدس بنویسی و دقیقاً با فایل تطبیق نداشته باشد، تغییر اعمال نخواهد شد و کل کارت بی‌فایده می‌شود.
- اگر چند تغییر جدا از هم لازم است، چند آبجکت کوچک و مستقل در همان آرایه بگذار.
- این بلاک را فقط در صورتی که کاربر واقعاً چیزی درباره‌ی محتوای همین فایل ضمیمه‌شده پرسیده (نه یک سؤال کلی و بی‌ربط به فایل)، تولید نکن.
- خارج از این بلاک، هرگز کد کامل فایل را دوباره چاپ نکن.`;
        }

        const modelsToTry = [MODEL_NAME];
        if (MODEL_NAME === 'gemini-3.1-pro') {
            modelsToTry.push('gemini-3-flash');
            modelsToTry.push('gemini-3.5-flash-lite');
        }
        if (MODEL_NAME === 'gemini-3.6-flash') {
            modelsToTry.push('gemini-3.5-flash-lite');
        }

        // Streaming path: proxies Gemini's streamGenerateContent (SSE) straight
        // through to the client as it arrives, so the reply appears word-by-word
        // instead of waiting for the full response. Falls back across
        // models/keys just like the non-streaming path, but only before any
        // bytes have been sent to the client (status is known before the body
        // starts, so a failed attempt can still be retried with the next key).
        const wantsStream = req.body?.stream === true || req.body?.stream === 'true';

        if (wantsStream) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            // Prevents Vercel's edge/proxy layer (and any nginx-like layer)
            // from buffering the whole response before sending it to the
            // client — without this, res.write() calls only reach the
            // browser after res.end(), so the reply looks like it "pops in"
            // instead of streaming in gradually.
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('X-Search-Performed', String(isSearchNeeded));
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            for (const currentModel of modelsToTry) {
                for (let k = 0; k < geminiKeys.length; k++) {
                    const currentKey = geminiKeys[k];
                    try {
                        console.log(`[stream] Trying model: ${currentModel} with Key #${k + 1}`);

                        const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:streamGenerateContent?alt=sse`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-goog-api-key': currentKey
                            },
                            body: JSON.stringify({
                                system_instruction: { parts: [{ text: systemText }] },
                                contents: contents
                            })
                        });

                        if (!upstream.ok || !upstream.body) {
                            let errBody = null;
                            try { errBody = await upstream.json(); } catch (_) {}
                            console.warn(`[stream] Model ${currentModel} with Key #${k + 1} failed:`, errBody?.error?.message || upstream.statusText);
                            lastError = errBody;
                            continue;
                        }

                        // We have a good upstream connection — relay chunks as they arrive.
                        const reader = upstream.body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = '';
                        let sentAny = false;

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            buffer += decoder.decode(value, { stream: true });

                            const lines = buffer.split('\n');
                            buffer = lines.pop();

                            for (const line of lines) {
                                if (!line.startsWith('data:')) continue;
                                const jsonStr = line.slice(5).trim();
                                if (!jsonStr) continue;
                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const piece = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                    if (piece) {
                                        sentAny = true;
                                        res.write(`data: ${JSON.stringify({ text: piece })}\n\n`);
                                        // Force the chunk out immediately instead of letting
                                        // Node/Vercel batch it with the next write.
                                        if (typeof res.flush === 'function') res.flush();
                                    }
                                } catch (_) { /* ignore partial/malformed lines */ }
                            }
                        }

                        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                        return res.end();

                    } catch (err) {
                        console.error(`[stream] Error with model ${currentModel} and Key #${k + 1}:`, err?.message || err);
                        lastError = err;
                    }
                }
            }

            res.write(`data: ${JSON.stringify({ error: 'خطا در دریافت پاسخ از تمامی مدل‌ها و کلیدها' })}\n\n`);
            return res.end();
        }

        for (const currentModel of modelsToTry) {
            for (let k = 0; k < geminiKeys.length; k++) {
                const currentKey = geminiKeys[k];
                try {
                    console.log(`Trying model: ${currentModel} with Key #${k + 1}`);
                    
                    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': currentKey
                        },
                        body: JSON.stringify({
                            system_instruction: {
                                parts: [{ text: systemText }]
                            },
                            contents: contents
                        })
                    });

                    const data = await response.json();

                    if (!response.ok) {
                        console.warn(`Model ${currentModel} with Key #${k + 1} failed:`, data?.error?.message || response.statusText);
                        lastError = data;
                        continue;
                    }

                    return res.status(200).json(data);

                } catch (err) {
                    console.error(`Error with model ${currentModel} and Key #${k + 1}:`, err?.message || err);
                    lastError = err;
                }
            }
        }

        return res.status(500).json({
            error: {
                message: `خطا در دریافت پاسخ از تمامی مدل‌ها و کلیدها`,
                details: lastError
            }
        });

    } catch (globalError) {
        console.error("Server Error:", globalError);
        return res.status(500).json({ error: { message: 'خطای داخلی سرور', details: globalError.message } });
    }
}
