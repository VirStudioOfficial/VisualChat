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
            // ===== FIX: hard timeout so a slow/dead key can't stall the whole reply =====
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: currentKey,
                    query: query,
                    search_depth: "basic",
                    max_results: 4
                }),
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId));

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
        // ===== FIX: this ternary previously evaluated backwards due to operator
        // precedence — `stream: true` (a real boolean, exactly what the frontend
        // sends) was being read as `false`, silently forcing every request onto the
        // slow non-streaming path regardless of what the client asked for. This is
        // likely the single biggest cause of slow/hanging replies reported so far —
        // it predates any of the earlier timeout/key fixes. =====
        const wantsStream = req.body?.stream === true || req.body?.stream === 'true';

        const { userName, text, rawText, file, webSearch, history, model } = req.body || {};
        const searchQueryBase = (rawText && String(rawText).trim()) ? String(rawText).trim() : (text || "");

        const rawGeminiKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "";
        // ===== FIX: shuffle key order per-request. Without this, the same key(s)
        // always sit first in the list and eat the timeout budget first on every
        // single request if they happen to be slow/rate-limited, starving keys
        // further down the list that might actually work right now. =====
        const geminiKeys = rawGeminiKeys.split(',').map(k => k.trim()).filter(Boolean)
            .map(k => ({ k, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ k }) => k);

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

        // سرچ کاملاً خودکار شد: دیگه به وضعیت دکمه (webSearch) وابسته نیست،
        // فقط بر اساس محتوای خود پیام تصمیم می‌گیره که جستجو لازمه یا نه.
        const isSearchNeeded = shouldSearchWeb(searchQueryBase);
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

        // ===== CHANGE 6: Improved file detection =====
        // پشتیبانی از چند فایل هم‌زمان: فرانت‌اند می‌تواند `files` (آرایه) یا `file`
        // (یک شیء تکی، برای سازگاری با نسخه‌های قبلی) بفرستد.
        const incomingFiles = Array.isArray(req.body?.files) ? req.body.files : (file ? [file] : []);
        const textFiles = incomingFiles.filter(f => f && f.mode === 'text' && typeof f.content === 'string');
        const binaryFiles = incomingFiles.filter(f => f && f.base64);

        if (textFiles.length > 0 && contents.length > 0) {
            const lastIndex = contents.length - 1;
            if (contents[lastIndex].role === 'user') {
                const textPart = contents[lastIndex].parts.find(p => p.text !== undefined);
                const fileBlocks = textFiles.map(f =>
                    `\n\n[محتوای فایل: ${f.name || 'file'}]\n\`\`\`\n${f.content}\n\`\`\`\n[پایان محتوای فایل: ${f.name || 'file'}]`
                ).join('');
                if (textPart) {
                    textPart.text += fileBlocks;
                } else {
                    contents[lastIndex].parts.push({ text: fileBlocks });
                }
            }
        }

        for (const bf of binaryFiles) {
            const lastIndex = contents.length - 1;
            if (lastIndex < 0 || contents[lastIndex].role !== 'user') break;

            const base64Data = bf.base64.includes(',') ? bf.base64.split(',')[1] : bf.base64;
            let mimeType = bf.type || 'image/jpeg';

            if (bf.name && /\.(mp4|mov|webm|avi|mpeg|wmv|3gpp|flv|mkv)$/i.test(bf.name)) {
                const ext = bf.name.split('.').pop().toLowerCase();
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
                console.log('Video detected:', bf.name, '->', mimeType);
            }

            contents[lastIndex].parts.push({
                inline_data: { mime_type: mimeType, data: base64Data }
            });
        }


        const MODEL_NAME = model || 'gemini-3.5-flash-lite';
        console.log(`Using model: ${MODEL_NAME}`);
        let lastError = null;

        if (MODEL_NAME.includes('imagen') || MODEL_NAME.includes('flash-image')) {
            // ===== FIX: two separate problems surfaced after the switch to
            // Pollinations:
            // 1) Pollinations does automatic fallback routing between image
            //    models when the requested one (flux) is busy/unavailable —
            //    this is a documented feature, not a bug — but the fallback
            //    model that was used (sana) handles non-English prompts very
            //    poorly.
            // 2) Farsi/Persian prompt text was reaching the image model
            //    largely as literal "?" characters (visible in the returned
            //    image's embedded generation metadata), because these image
            //    models are trained overwhelmingly on English captions.
            // Fix: translate the prompt to English first using Gemini's free
            // text tier (gemini-3.5-flash-lite has no cost and is already in
            // use elsewhere in this file), then send the English prompt to
            // Pollinations. This fixes both: an English prompt renders
            // correctly on any fallback model, and encoding issues don't
            // arise since English is plain ASCII. =====
            let translatedPrompt = searchQueryBase || 'an image';
            try {
                const translateKey = geminiKeys[Math.floor(Math.random() * geminiKeys.length)];
                const translateRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': translateKey },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: `Translate the following image description to a concise, vivid English image-generation prompt. Reply with ONLY the translated prompt, no quotes, no extra text:\n\n${searchQueryBase}` }] }]
                    })
                });
                if (translateRes.ok) {
                    const translateData = await translateRes.json();
                    const candidate = translateData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                    if (candidate) translatedPrompt = candidate;
                }
            } catch (translateErr) {
                console.warn('[Imagen] Translation failed, using original prompt:', translateErr?.message || translateErr);
            }
            console.log('[Imagen] Translated prompt:', translatedPrompt);

            const pollinationsHosts = [
                `https://gen.pollinations.ai/image/${encodeURIComponent(translatedPrompt)}`,
                `https://image.pollinations.ai/prompt/${encodeURIComponent(translatedPrompt)}`
            ];

            for (const baseUrl of pollinationsHosts) {
                try {
                    console.log(`[Imagen] Generating image via Pollinations: ${baseUrl.split('/')[2]}`);
                    const seed = Math.floor(Math.random() * 1000000);
                    const pollinationsUrl = `${baseUrl}?width=1920&height=1080&seed=${seed}&model=flux`;

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 45000);
                    const imgRes = await fetch(pollinationsUrl, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    if (!imgRes.ok) {
                        console.warn('[Imagen] Pollinations request failed:', imgRes.status, imgRes.statusText);
                        lastError = { error: { message: `Pollinations returned ${imgRes.status}` } };
                        continue;
                    }

                    const arrayBuffer = await imgRes.arrayBuffer();
                    const base64Img = Buffer.from(arrayBuffer).toString('base64');
                    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
                    const imgMarkdown = `![${searchQueryBase}](data:${contentType};base64,${base64Img})`;

                    if (wantsStream) {
                        // ===== CHANGE 4: flushHeaders at start of streaming =====
                        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                        res.setHeader('Cache-Control', 'no-cache, no-transform');
                        res.setHeader('Connection', 'keep-alive');
                        res.setHeader('X-Accel-Buffering', 'no');
                        if (typeof res.flushHeaders === 'function') res.flushHeaders();

                        res.write(`data: ${JSON.stringify({ text: imgMarkdown })}\n\n`);
                        // ===== CHANGE 5: flush after each write =====
                        if (typeof res.flush === 'function') res.flush();
                        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                        if (typeof res.flush === 'function') res.flush();
                        return res.end();
                    } else {
                        return res.status(200).json({
                            candidates: [{ content: { parts: [{ text: imgMarkdown }] } }]
                        });
                    }
                } catch (err) {
                    console.error('[Imagen] Error calling Pollinations:', err?.message || err);
                    lastError = err;
                }
            }
        }

        let systemText = '';

        // ===== CHANGE 8: antiSelfQA preserved exactly =====
        const antiSelfQA = `\n\nقانون سخت‌گیرانه: جمله‌ی معرفی مدل («من Virtual Bot ... هستم») را فقط و فقط زمانی بنویس که خودِ کاربر همین الان مستقیم پرسیده باشد «مدلت چیه» یا سؤال هم‌معنی. هرگز خودت این سؤال را از زبان خودت مطرح نکن و هرگز بدون این‌که کاربر پرسیده باشد، جمله‌ی معرفی مدل را در وسط یا انتهای یک پاسخ دیگر نیاور، حتی به‌شکل مثال، یادآوری یا توضیح داخلی.`;

        // ===== CHANGE 7: All System Prompts preserved exactly =====
        if (MODEL_NAME === 'gemini-3.5-flash-lite') {

            systemText = `تو Virtual Bot 1.1 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- این یک قانون پاسخ‌دهی است، نه یک جمله برای گفتن یا تکرار خودجوش: فقط وقتی و فقط وقتی کاربر مستقیماً بپرسد «مدلت چیه؟» یا سؤال مشابه، دقیقاً همین را بگو: «من Virtual Bot 1.1 هستم.» هرگز خودت این سؤال را از خودت نپرس و هرگز بدون این‌که کاربر واقعاً پرسیده باشد، این جمله را وسط پاسخ دیگری نیاور.
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
- این یک قانون پاسخ‌دهی است، نه یک جمله برای گفتن یا تکرار خودجوش: فقط وقتی و فقط وقتی کاربر مستقیماً بپرسد «مدلت چیه؟» یا سؤال مشابه، دقیقاً همین را بگو: «من Virtual Bot 1.5 هستم.» هرگز خودت این سؤال را از خودت نپرس و هرگز بدون این‌که کاربر واقعاً پرسیده باشد، این جمله را وسط پاسخ دیگری نیاور.
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

        } else if (MODEL_NAME === 'gemini-3.1-pro-preview') {

            systemText = `تو Virtual Bot 1.3 هستی؛ یک دستیار هوش مصنوعی پیشرفته فارسی.

هویت:
- این یک قانون پاسخ‌دهی است، نه یک جمله برای گفتن یا تکرار خودجوش: فقط وقتی و فقط وقتی کاربر مستقیماً بپرسد «مدلت چیه؟» یا سؤال مشابه، دقیقاً همین را بگو: «من Virtual Bot 1.3 هستم.» هرگز خودت این سؤال را از خودت نپرس و هرگز بدون این‌که کاربر واقعاً پرسیده باشد، این جمله را وسط پاسخ دیگری نیاور.
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

        systemText += antiSelfQA;

        // ===== CHANGE 9: File edit mode preserved =====
        // این بلاک فقط وقتی به systemText اضافه می‌شود که کاربر حداقل یک فایل کد/متنی
        // ضمیمه کرده باشد؛ روی هیچ پیام دیگری تاثیر ندارد و شخصیت/لحن هر مدل دست‌نخورده می‌ماند.
        if (Array.isArray(textFiles) && textFiles.length > 0) {
            const fileNamesList = textFiles.map(f => `«${f.name || 'file'}»`).join('، ');
            systemText += `\n\nحالت ویرایش فایل (بسیار مهم، دقیق رعایت شود):
- کاربر ${textFiles.length > 1 ? `${textFiles.length} فایل کد/متن (${fileNamesList}) ضمیمه کرده` : `یک فایل کد/متن ضمیمه کرده`}؛ محتوای کامل و واقعی هرکدام با برچسب [محتوای فایل: نام‌فایل] در پیام کاربر آمده است. این تنها منبع معتبر کد است.
- هر درخواستی که به‌نوعی خواهان افزودن/تغییر/حذف چیزی در همین فایل‌ها باشد را یک درخواست ویرایش واقعی در نظر بگیر، حتی اگر غیرمستقیم یا با لحن سؤالی/چالشی گفته شده باشد (مثل «می‌تونی X رو اضافه کنی؟»، «نمیشه Y رو عوض کرد؟»، «ببینم چیکار می‌کنی»). در این حالت‌ها باید واقعاً ویرایش را روی فایل انجام دهی، نه این‌که فقط یک نمونه‌کد جدا و توضیحی نشان بدهی.
- ممنوع است متغیر، کلاس، رنگ یا ساختار جدید و ساختگی که در فایل واقعی وجود ندارد اختراع کنی. اول داخل [محتوای فایل] بگرد و ببین ساختار مشابه با چه الگویی نوشته شده، و دقیقاً با همان الگو مورد جدید را اضافه یا تغییر بده.
- به‌جای بازنویسی کل فایل، فقط تکه‌های لازم را ویرایش کن.
- ابتدا کوتاه و خودمانی توضیح بده چه تغییری دادی، کجا، و در کدام فایل.
- در انتهای پاسخ، دقیقاً یک بلاک با برچسب file-edit اضافه کن، شامل آرایه‌ای JSON از تغییرات. اگر بیش از یک فایل ضمیمه بود، هر آبجکت باید کلید "file" را هم داشته باشد تا مشخص شود تغییر مال کدام فایل است:
\`\`\`file-edit
[
  {"file": "نام‌دقیق‌فایل${textFiles.length > 1 ? '' : ' (اختیاری اگر فقط یک فایل هست)'}", "old": "متن دقیق و کامل (کاراکتر به کاراکتر) از همان فایل که باید جایگزین شود", "new": "متن جایگزین، هم‌سبک با بقیه فایل"}
]
\`\`\`
- متن old باید عیناً (کاراکتر به کاراکتر) از همان فایلی که در "file" مشخص کردی کپی شده باشد و باید فقط یک‌بار در آن فایل تکرار شده باشد؛ اگر مطمئن نیستی یکتاست، متن بیشتری از اطراف را هم داخل old بگنجان. اگر old را از حفظ یا حدس بنویسی و دقیقاً تطبیق نداشته باشد، آن تغییر اعمال نمی‌شود.
- اگر چند تغییر جدا از هم لازم است (حتی در فایل‌های مختلف)، چند آبجکت کوچک و مستقل در همان آرایه بگذار.
- این بلاک را فقط در صورتی که کاربر واقعاً چیزی درباره‌ی محتوای همین فایل(ها) پرسیده (نه یک سؤال کلی و بی‌ربط)، تولید نکن.
- خارج از این بلاک، هرگز کد کامل هیچ فایلی را دوباره چاپ نکن.`;
        }

        // ===== CHANGE 2: Fixed fallback order =====
        const modelsToTry = [MODEL_NAME];
        if (MODEL_NAME === 'gemini-3.1-pro-preview') {
            modelsToTry.push('gemini-3.6-flash');
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
            // ===== CHANGE 4: flushHeaders at start of streaming =====
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            // ===== FIX: overall deadline raised so it doesn't cut off a large key
            // pool early. With 12 keys, each allowed up to 8s to fail/succeed, the
            // worst case (several genuinely slow keys before a working one) can
            // exceed a short shared budget and cause the loop to give up before ever
            // reaching keys further down the list. 45s keeps the response snappy for
            // the common case (quota errors return in under a second) while still
            // giving every key in a large pool a real chance. =====
            const overallDeadline = Date.now() + 60000;

            outerLoop:
            for (const currentModel of modelsToTry) {
                for (let k = 0; k < geminiKeys.length; k++) {
                    if (Date.now() > overallDeadline) break outerLoop;
                    const currentKey = geminiKeys[k];
                    try {
                        console.log(`[stream] Trying model: ${currentModel} with Key #${k + 1}`);

                        // ===== FIX: per-attempt timeout raised back to 15s. The earlier 8s
                        // assumed only quota/demand errors happen (which do return almost
                        // instantly), but a real request that's simply slightly slow to
                        // start streaming (common under Google's own "high demand" load) was
                        // getting aborted before it had a real chance to respond, wasting
                        // otherwise-working keys. 15s still leaves room to cycle through a
                        // 12-key pool inside the 45s overall budget below. =====
                        const streamController = new AbortController();
                        const streamTimeoutId = setTimeout(() => streamController.abort(), 15000);
                        let upstream;
                        try {
                            upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:streamGenerateContent?alt=sse`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-goog-api-key': currentKey
                                },
                                body: JSON.stringify({
                                    system_instruction: { parts: [{ text: systemText }] },
                                    contents: contents
                                }),
                                signal: streamController.signal
                            });
                        } finally {
                            clearTimeout(streamTimeoutId);
                        }

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

                            // ===== CHANGE 3: Improved buffer management =====
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
                                        // ===== CHANGE 5: flush after each write =====
                                        if (typeof res.flush === 'function') res.flush();
                                    }
                                } catch (_) { /* ignore partial/malformed lines */ }
                            }
                        }

                        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                        if (typeof res.flush === 'function') res.flush();
                        return res.end();

                    } catch (err) {
                        console.error(`[stream] Error with model ${currentModel} and Key #${k + 1}:`, err?.message || err);
                        lastError = err;
                    }
                }
            }

            res.write(`data: ${JSON.stringify({ error: 'سرور شلوغه یا کلیدهای فعال سهمیه‌شون تموم شده — چند لحظه دیگه دوباره امتحان کن.' })}\n\n`);
            if (typeof res.flush === 'function') res.flush();
            return res.end();
        }

        // ===== FIX: same shared deadline for the non-streaming path =====
        const overallDeadlineNonStream = Date.now() + 60000;

        outerLoopNonStream:
        for (const currentModel of modelsToTry) {
            for (let k = 0; k < geminiKeys.length; k++) {
                if (Date.now() > overallDeadlineNonStream) break outerLoopNonStream;
                const currentKey = geminiKeys[k];
                try {
                    console.log(`Trying model: ${currentModel} with Key #${k + 1}`);

                    // ===== FIX: per-attempt timeout (15s) — gives a real request enough
                    // room to connect even under Google's own high-demand load, while
                    // still moving on if a key is genuinely dead =====
                    const genController = new AbortController();
                    const genTimeoutId = setTimeout(() => genController.abort(), 15000);
                    let response;
                    try {
                        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`, {
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
                            }),
                            signal: genController.signal
                        });
                    } finally {
                        clearTimeout(genTimeoutId);
                    }

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
                message: `سرور شلوغه یا کلیدهای فعال سهمیه‌شون تموم شده — چند لحظه دیگه دوباره امتحان کن.`,
                details: lastError
            }
        });

    } catch (globalError) {
        console.error("Server Error:", globalError);
        return res.status(500).json({ error: { message: 'خطای داخلی سرور', details: globalError.message } });
    }
}
