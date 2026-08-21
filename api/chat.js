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
        'قیمت', 'چنده', 'نرخ', 'دلار', 'طلا', 'سکه', 'ارز', 'بیت کوین',
        'پلی استیشن', 'اخبار', 'خبر', 'رویداد', 'نتیجه بازی', 'خرید',
        'امشب', 'آخرین', 'جدیدترین', 'امروز'
    ];

    return allowedKeywords.some(kw => normalized.includes(kw));
}


/*
|--------------------------------------------------------------------------
| تشخیص درخواست ساخت تصویر
|--------------------------------------------------------------------------
*/

function shouldGenerateImage(userText) {
    if (!userText || typeof userText !== 'string') return false;

    const text = userText
        .toLowerCase()
        .replace(/[؟?!،,.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text || text.length < 3) return false;

    const imageKeywords = [
        // فارسی
        'تصویر بساز',
        'تصویر درست کن',
        'تصویر ایجاد کن',
        'عکس بساز',
        'عکس درست کن',
        'عکس ایجاد کن',
        'عکس تولید کن',
        'تصویر تولید کن',
        'تصویرسازی کن',
        'تصویر سازی کن',
        'تصویرسازی',
        'تصویر سازی',
        'ایمیج بساز',
        'ایمیج درست کن',
        'ایمیج تولید کن',
        'عکس بده',
        'تصویر بده',
        'یه عکس',
        'یک عکس',
        'یه تصویر',
        'یک تصویر',
        'برام عکس بساز',
        'برام تصویر بساز',
        'برای من عکس بساز',
        'برای من تصویر بساز',
        'طراحی کن',
        'رندر کن',
        'نقاشی کن',
        'پوستر بساز',
        'تامنیل بساز',
        'thumbnail بساز',
        'کاور بساز',
        'لوگو بساز',

        // انگلیسی
        'generate image',
        'generate an image',
        'create image',
        'create an image',
        'make image',
        'make an image',
        'generate picture',
        'create picture',
        'make picture',
        'image generation',
        'draw an image',
        'draw image',
        'render image',
        'generate a picture',
        'create a picture'
    ];

    return imageKeywords.some(keyword => text.includes(keyword));
}


/*
|--------------------------------------------------------------------------
| تشخیص مدل تصویر
|--------------------------------------------------------------------------
*/

function isImageModel(modelName) {
    if (!modelName || typeof modelName !== 'string') return false;

    const name = modelName.toLowerCase();

    return (
        name.includes('imagen') ||
        name.includes('image') ||
        name.includes('flash-image')
    );
}


/*
|--------------------------------------------------------------------------
| ترجمه پرامپت تصویر به انگلیسی
|--------------------------------------------------------------------------
*/

async function translateImagePrompt(prompt, geminiKeys) {
    if (!prompt || !geminiKeys || geminiKeys.length === 0) {
        return prompt || 'A high quality image';
    }

    const translationPrompt = `
Translate the following Persian image-generation request into a detailed,
natural English prompt suitable for an AI image generator.

Important:
- Preserve every important visual detail.
- Preserve characters, objects, environment, lighting, camera angle and style.
- Do NOT answer the user.
- Do NOT explain anything.
- Do NOT add unwanted objects.
- Return ONLY the English image-generation prompt.

User request:
${prompt}
`;

    for (let i = 0; i < geminiKeys.length; i++) {
        const key = geminiKeys[i];

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            let response;

            try {
                response = await fetch(
                    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': key
                        },
                        body: JSON.stringify({
                            contents: [
                                {
                                    role: 'user',
                                    parts: [
                                        {
                                            text: translationPrompt
                                        }
                                    ]
                                }
                            ]
                        }),
                        signal: controller.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) continue;

            const data = await response.json();

            const translated =
                data?.candidates?.[0]?.content?.parts
                    ?.map(p => p?.text || '')
                    .join('')
                    .trim();

            if (translated) {
                console.log('[Image] Prompt translated successfully.');
                return translated;
            }

        } catch (error) {
            console.warn(
                `[Image] Translation failed with key #${i + 1}:`,
                error?.message || error
            );
        }
    }

    console.warn('[Image] Translation failed. Using original prompt.');
    return prompt;
}


/*
|--------------------------------------------------------------------------
| تولید تصویر با Pollinations
|--------------------------------------------------------------------------
*/

async function generateImage(prompt) {
    const hosts = [
        `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`,
        `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`
    ];

    let lastError = null;

    for (const baseUrl of hosts) {
        try {
            const seed = Math.floor(Math.random() * 1000000000);

            const imageUrl =
                `${baseUrl}` +
                `?width=1920` +
                `&height=1080` +
                `&seed=${seed}` +
                `&model=flux`;

            console.log('[Image] Request:', imageUrl);

            const controller = new AbortController();
            const timeoutId = setTimeout(
                () => controller.abort(),
                60000
            );

            let response;

            try {
                response = await fetch(imageUrl, {
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                lastError = new Error(
                    `Pollinations returned ${response.status}`
                );

                console.warn(
                    '[Image] Failed:',
                    response.status,
                    response.statusText
                );

                continue;
            }

            const arrayBuffer = await response.arrayBuffer();

            if (!arrayBuffer || arrayBuffer.byteLength === 0) {
                lastError = new Error('Empty image response');
                continue;
            }

            const buffer = Buffer.from(arrayBuffer);

            let contentType =
                response.headers.get('content-type') ||
                'image/jpeg';

            if (!contentType.startsWith('image/')) {
                contentType = 'image/jpeg';
            }

            const base64 = buffer.toString('base64');

            console.log(
                `[Image] Generated successfully: ${buffer.length} bytes, ${contentType}`
            );

            return {
                success: true,
                url: imageUrl,
                base64,
                contentType,
                size: buffer.length
            };

        } catch (error) {
            lastError = error;

            console.error(
                '[Image] Generation error:',
                error?.message || error
            );
        }
    }

    throw lastError || new Error('Image generation failed');
}


/*
|--------------------------------------------------------------------------
| پاسخ تصویر
|--------------------------------------------------------------------------
*/

async function handleImageGeneration({
    prompt,
    geminiKeys,
    wantsStream,
    res
}) {
    console.log('[Image] Image request detected.');
    console.log('[Image] Original prompt:', prompt);

    const translatedPrompt = await translateImagePrompt(
        prompt,
        geminiKeys
    );

    console.log('[Image] Final prompt:', translatedPrompt);

    const image = await generateImage(translatedPrompt);

    /*
     * این Markdown برای فرانت‌اندهای فعلی که متن Markdown
     * را رندر می‌کنند بسیار مهم است.
     */
    const markdownImage =
        `![Generated Image](data:${image.contentType};base64,${image.base64})`;

    /*
     * اگر فرانت‌اند در آینده image را مستقیم بخواند،
     * این ساختار را هم دارد.
     */

    const imagePayload = {
        type: 'image',
        url: image.url,
        mimeType: image.contentType,
        base64: image.base64,
        dataUrl: `data:${image.contentType};base64,${image.base64}`,
        prompt: translatedPrompt
    };

    if (wantsStream) {
        res.setHeader(
            'Content-Type',
            'text/event-stream; charset=utf-8'
        );

        res.setHeader(
            'Cache-Control',
            'no-cache, no-transform'
        );

        res.setHeader(
            'Connection',
            'keep-alive'
        );

        res.setHeader(
            'X-Accel-Buffering',
            'no'
        );

        res.setHeader(
            'X-Image-Generated',
            'true'
        );

        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        /*
         * اول اطلاعات ساختاریافته تصویر
         */
        res.write(
            `data: ${JSON.stringify({
                image: imagePayload
            })}\n\n`
        );

        if (typeof res.flush === 'function') {
            res.flush();
        }

        /*
         * سپس Markdown برای سازگاری با UI فعلی
         */
        res.write(
            `data: ${JSON.stringify({
                text: markdownImage
            })}\n\n`
        );

        if (typeof res.flush === 'function') {
            res.flush();
        }

        res.write(
            `data: ${JSON.stringify({
                done: true,
                image: imagePayload
            })}\n\n`
        );

        if (typeof res.flush === 'function') {
            res.flush();
        }

        return res.end();
    }

    return res.status(200).json({
        candidates: [
            {
                content: {
                    parts: [
                        {
                            text: markdownImage
                        }
                    ]
                }
            }
        ],

        /*
         * خروجی اصلی تصویر
         */
        image: imagePayload,

        /*
         * برای راحتی فرانت‌اند
         */
        imageUrl: image.url,
        imageDataUrl: imagePayload.dataUrl,

        type: 'image'
    });
}


/*
|--------------------------------------------------------------------------
| Tavily
|--------------------------------------------------------------------------
*/

async function fetchTavilyResults(query, tavilyKeys) {
    if (!tavilyKeys || tavilyKeys.length === 0) {
        return null;
    }

    for (let i = 0; i < tavilyKeys.length; i++) {
        const currentKey = tavilyKeys[i];

        try {
            const controller = new AbortController();

            const timeoutId = setTimeout(
                () => controller.abort(),
                6000
            );

            let response;

            try {
                response = await fetch(
                    'https://api.tavily.com/search',
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            api_key: currentKey,
                            query,
                            search_depth: 'basic',
                            max_results: 4
                        }),
                        signal: controller.signal
                    }
                );
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                continue;
            }

            const data = await response.json();

            if (
                data.results &&
                data.results.length > 0
            ) {
                console.log(
                    `Tavily search succeeded using Key #${i + 1}`
                );

                return data.results
                    .map(
                        r =>
                            `عنوان: ${r.title}\n` +
                            `منبع: ${r.url}\n` +
                            `محتوا: ${r.content}`
                    )
                    .join('\n\n---\n\n');
            }

        } catch (error) {
            console.error(
                `Error with Tavily Key #${i + 1}:`,
                error?.message || error
            );
        }
    }

    return null;
}


/*
|--------------------------------------------------------------------------
| Web Search Detection
|--------------------------------------------------------------------------
*/

function shouldSearchWeb(userText) {
    if (!userText || typeof userText !== 'string') {
        return false;
    }

    const cleanText = userText.trim().toLowerCase();

    if (cleanText.length < 3) {
        return false;
    }

    const ignoreList = [
        'سلام',
        'سلامم',
        'درود',
        'چطوری',
        'خوبی',
        'صبح بخیر',
        'عصر بخیر',
        'شب بخیر',
        'ممنون',
        'مرسی',
        'چخبر',
        'خداحافظ',
        'بای',
        'اوکی',
        'باشه'
    ];

    const normalized = cleanText
        .replace(/[!.،,؟?]/g, '')
        .trim();

    const words = normalized
        .split(/\s+/)
        .filter(Boolean);

    const firstWord = words[0];

    if (
        words.length <= 3 &&
        (
            ignoreList.includes(normalized) ||
            ignoreList.includes(firstWord)
        )
    ) {
        return false;
    }

    const allowedKeywords = [
        'سرچ',
        'جستجو',
        'گوگل',
        'اینترنت',
        'توی وب',
        'بررسی کن',
        'سرچ کن',
        'قیمت',
        'چنده',
        'نرخ',
        'دلار',
        'طلا',
        'سکه',
        'ارز',
        'بیت کوین',
        'پلی استیشن',
        'اخبار',
        'خبر',
        'رویداد',
        'نتیجه بازی',
        'خرید',
        'امشب',
        'آخرین',
        'جدیدترین',
        'امروز'
    ];

    return allowedKeywords.some(
        kw => normalized.includes(kw)
    );
}


/*
|--------------------------------------------------------------------------
| MAIN API HANDLER
|--------------------------------------------------------------------------
*/

async function handler(req, res) {
    res.setHeader(
        'Access-Control-Allow-Origin',
        '*'
    );

    res.setHeader(
        'Access-Control-Allow-Methods',
        'POST, OPTIONS'
    );

    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            error: {
                message: 'متد درخواست پشتیبانی نمی‌شود.'
            }
        });
    }

    try {
        const wantsStream =
            req.body?.stream === true ||
            req.body?.stream === 'true';

        const {
            userName,
            text,
            rawText,
            file,
            webSearch,
            history,
            model
        } = req.body || {};

        const searchQueryBase =
            rawText &&
            String(rawText).trim()
                ? String(rawText).trim()
                : (text || '');

        /*
        |--------------------------------------------------------------------------
        | API Keys
        |--------------------------------------------------------------------------
        */

        const rawGeminiKeys =
            process.env.GEMINI_API_KEYS ||
            process.env.GEMINI_API_KEY ||
            '';

        const geminiKeys =
            rawGeminiKeys
                .split(',')
                .map(k => k.trim())
                .filter(Boolean)
                .map(k => ({
                    k,
                    sort: Math.random()
                }))
                .sort((a, b) => a.sort - b.sort)
                .map(({ k }) => k);

        const rawTavilyKeys =
            process.env.TAVILY_API_KEYS ||
            process.env.TAVILY_API_KEY ||
            '';

        const tavilyKeys =
            rawTavilyKeys
                .split(',')
                .map(k => k.trim())
                .filter(Boolean);

        if (geminiKeys.length === 0) {
            return res.status(400).json({
                error: {
                    message:
                        'هیچ کلید Gemini API تنظیم نشده است!'
                }
            });
        }

        /*
        |--------------------------------------------------------------------------
        | فایل‌ها
        |--------------------------------------------------------------------------
        */

        const incomingFiles =
            Array.isArray(req.body?.files)
                ? req.body.files
                : (file ? [file] : []);

        const textFiles =
            incomingFiles.filter(
                f =>
                    f &&
                    f.mode === 'text' &&
                    typeof f.content === 'string'
            );

        const binaryFiles =
            incomingFiles.filter(
                f =>
                    f &&
                    f.base64
            );

        /*
        |--------------------------------------------------------------------------
        | History
        |--------------------------------------------------------------------------
        */

        let contents = [];

        if (
            history &&
            Array.isArray(history) &&
            history.length > 0
        ) {
            contents = history.map(item => ({
                role:
                    item.role === 'user'
                        ? 'user'
                        : 'model',

                parts: [
                    {
                        text:
                            String(
                                item.text ||
                                item.content ||
                                ''
                            )
                    }
                ]
            }));
        } else if (searchQueryBase) {
            contents.push({
                role: 'user',
                parts: [
                    {
                        text: searchQueryBase
                    }
                ]
            });
        }

        if (contents.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'متن ورودی خالی است.'
                }
            });
        }

        /*
        |--------------------------------------------------------------------------
        | تشخیص تصویر
        |--------------------------------------------------------------------------
        */

        const requestedImageModel =
            isImageModel(model);

        const autoImageRequest =
            shouldGenerateImage(
                searchQueryBase
            );

        /*
         * اگر مدل تصویر انتخاب شده باشد یا متن کاربر
         * درخواست ساخت تصویر باشد، مستقیماً وارد image pipeline شو.
         */
        const isImageRequest =
            requestedImageModel ||
            autoImageRequest;

        console.log(
            '[Request]',
            {
                model,
                autoImageRequest,
                requestedImageModel,
                isImageRequest
            }
        );

        res.setHeader(
            'X-Image-Request',
            String(isImageRequest)
        );

        /*
        |--------------------------------------------------------------------------
        | اگر درخواست تصویر است، اصلاً آن را به مدل متنی نده
        |--------------------------------------------------------------------------
        */

        if (isImageRequest) {
            try {
                return await handleImageGeneration({
                    prompt: searchQueryBase,
                    geminiKeys,
                    wantsStream,
                    res
                });

            } catch (imageError) {
                console.error(
                    '[Image] Final generation error:',
                    imageError?.message || imageError
                );

                if (wantsStream) {
                    res.setHeader(
                        'Content-Type',
                        'text/event-stream; charset=utf-8'
                    );

                    res.write(
                        `data: ${JSON.stringify({
                            error:
                                'ساخت تصویر انجام نشد. سرویس تصویر موقتاً در دسترس نیست.'
                        })}\n\n`
                    );

                    res.write(
                        `data: ${JSON.stringify({
                            done: true
                        })}\n\n`
                    );

                    return res.end();
                }

                return res.status(500).json({
                    error: {
                        message:
                            'ساخت تصویر انجام نشد. سرویس تصویر موقتاً در دسترس نیست.',
                        details:
                            imageError?.message || String(imageError)
                    }
                });
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Web Search
        |--------------------------------------------------------------------------
        */

        const isSearchNeeded =
            shouldSearchWeb(
                searchQueryBase
            );

        res.setHeader(
            'X-Search-Performed',
            String(isSearchNeeded)
        );

        if (
            isSearchNeeded &&
            searchQueryBase
        ) {
            console.log(
                `Executing Tavily Search for: "${searchQueryBase}"`
            );

            const searchResults =
                await fetchTavilyResults(
                    searchQueryBase,
                    tavilyKeys
                );

            const lastIndex =
                contents.length - 1;

            if (
                searchResults &&
                lastIndex >= 0 &&
                contents[lastIndex].role === 'user'
            ) {
                const textPart =
                    contents[lastIndex]
                        .parts
                        .find(
                            p =>
                                p.text !== undefined
                        );

                const webBlock =
                    `\n\n[نتایج جستجوی وب]:\n` +
                    `${searchResults}\n\n` +
                    `[دستورالعمل: با کمک اطلاعات فوق ` +
                    `پاسخ دقیق و به‌روز ارائه بده.]`;

                if (textPart) {
                    textPart.text += webBlock;
                } else {
                    contents[lastIndex]
                        .parts
                        .push({
                            text: webBlock
                        });
                }
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Text Files
        |--------------------------------------------------------------------------
        */

        if (
            textFiles.length > 0 &&
            contents.length > 0
        ) {
            const lastIndex =
                contents.length - 1;

            if (
                contents[lastIndex].role === 'user'
            ) {
                const textPart =
                    contents[lastIndex]
                        .parts
                        .find(
                            p =>
                                p.text !== undefined
                        );

                const fileBlocks =
                    textFiles
                        .map(
                            f =>
                                `\n\n` +
                                `[محتوای فایل: ${f.name || 'file'}]\n` +
                                '```\n' +
                                f.content +
                                '\n```\n' +
                                `[پایان محتوای فایل: ${f.name || 'file'}]`
                        )
                        .join('');

                if (textPart) {
                    textPart.text += fileBlocks;
                } else {
                    contents[lastIndex]
                        .parts
                        .push({
                            text: fileBlocks
                        });
                }
            }
        }

        /*
        |--------------------------------------------------------------------------
        | Binary Files
        |--------------------------------------------------------------------------
        */

        for (const bf of binaryFiles) {
            const lastIndex =
                contents.length - 1;

            if (
                lastIndex < 0 ||
                contents[lastIndex].role !== 'user'
            ) {
                break;
            }

            const base64Data =
                bf.base64.includes(',')
                    ? bf.base64.split(',')[1]
                    : bf.base64;

            let mimeType =
                bf.type ||
                'image/jpeg';

            if (
                bf.name &&
                /\.(mp4|mov|webm|avi|mpeg|wmv|3gpp|flv|mkv)$/i
                    .test(bf.name)
            ) {
                const ext =
                    bf.name
                        .split('.')
                        .pop()
                        .toLowerCase();

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

                mimeType =
                    mimeMap[ext] ||
                    'video/mp4';

                console.log(
                    'Video detected:',
                    bf.name,
                    '->',
                    mimeType
                );
            }

            contents[lastIndex]
                .parts
                .push({
                    inline_data: {
                        mime_type: mimeType,
                        data: base64Data
                    }
                });
        }

        /*
        |--------------------------------------------------------------------------
        | Model
        |--------------------------------------------------------------------------
        */

        const MODEL_NAME =
            model ||
            'gemini-3.5-flash-lite';

        console.log(
            `Using model: ${MODEL_NAME}`
        );

        let systemText = '';

        const antiSelfQA = `
قانون سخت‌گیرانه:
جمله‌ی معرفی مدل («من Virtual Bot ... هستم») را فقط و فقط زمانی بنویس که خودِ کاربر همین الان مستقیم پرسیده باشد «مدلت چیه» یا سؤال هم‌معنی.
هرگز خودت این سؤال را از زبان خودت مطرح نکن.
هرگز بدون اینکه کاربر پرسیده باشد، جمله معرفی مدل را در پاسخ دیگری نیاور.
`;

        /*
        |--------------------------------------------------------------------------
        | System Prompt
        |--------------------------------------------------------------------------
        */

        if (
            MODEL_NAME ===
            'gemini-3.5-flash-lite'
        ) {
            systemText = `
تو Virtual Bot 1.1 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- فقط وقتی کاربر مستقیماً درباره مدل پرسید بگو: «من Virtual Bot 1.1 هستم.»
- هرگز خودت را Virtual Bot 1.3 یا Virtual Bot 1.5 معرفی نکن.
- هرگز نام سازنده یا تیمی را از خودت نساز.
- خودت را Gemini معرفی نکن.
- درباره چیزهایی که نمی‌دانی اطلاعات ساختگی نده.

شخصیت:
- فارسی روان، طبیعی و خودمانی صحبت کن.
- خشک و رباتی نباش.
- در موقعیت مناسب کمی شوخی دوستانه داشته باش 😂.
- از ایموجی مناسب استفاده کن ولی زیاده‌روی نکن.
- هرگز از ایموجی 🤖 استفاده نکن.
- هنگام سلام کردن یا جواب سلام، یک ایموجی گرم مثل 😊 یا 👋 استفاده کن.

نحوه پاسخ:
- سؤال ساده = پاسخ کوتاه و مستقیم.
- پاسخ طولانی = بخش‌بندی‌شده و خوانا.
- اطلاعات را بی‌دلیل تکرار نکن.
- اگر مطمئن نیستی، حدس را واقعیت معرفی نکن.

نام کاربر:
"${userName || 'دوست من'}"
`;

        } else if (
            MODEL_NAME ===
            'gemini-3.6-flash'
        ) {
            systemText = `
تو Virtual Bot 1.5 هستی؛ یک دستیار هوش مصنوعی فارسی.

هویت:
- فقط وقتی کاربر مستقیماً درباره مدل پرسید بگو: «من Virtual Bot 1.5 هستم.»
- خودت را Virtual Bot 1.1 یا Virtual Bot 1.3 معرفی نکن.
- خودت را Gemini معرفی نکن.
- اطلاعات ساختگی درباره هویت یا سازنده نده.

شخصیت:
- فارسی طبیعی، خودمانی و حرفه‌ای.
- خشک و رباتی نباش.
- در موقعیت مناسب شوخی طبیعی داشته باش 😂.
- ایموجی را متعادل استفاده کن.
- هرگز 🤖 استفاده نکن.
- هنگام سلام کردن 😊 یا 👋 استفاده کن.

نحوه پاسخ:
- پاسخ ساده کوتاه و مستقیم.
- پاسخ طولانی خوانا و بخش‌بندی‌شده.
- از تکرار بی‌دلیل خودداری کن.

نام کاربر:
"${userName || 'دوست من'}"
`;

        } else if (
            MODEL_NAME ===
            'gemini-3.1-pro-preview'
        ) {
            systemText = `
تو Virtual Bot 1.3 هستی؛ یک دستیار هوش مصنوعی پیشرفته فارسی.

هویت:
- فقط وقتی کاربر مستقیماً درباره مدل پرسید بگو: «من Virtual Bot 1.3 هستم.»
- خودت را Virtual Bot 1.1 یا Virtual Bot 1.5 معرفی نکن.
- خودت را Gemini معرفی نکن.
- نام سازنده را از خودت نساز.

شخصیت:
- فارسی روان، دوستانه و حرفه‌ای.
- خشک و رباتی نباش.
- در موقعیت مناسب شوخ‌طبع باش 😎.
- ایموجی را متناسب استفاده کن.
- هنگام سلام 😊 یا 👋 استفاده کن.

نحوه پاسخ:
- پاسخ ساده واضح و مستقیم.
- پاسخ طولانی مرتب و بخش‌بندی‌شده.
- برای کدنویسی، در صورت درخواست، کد کامل و قابل اجرا بده.
- اطلاعات ساختگی تولید نکن.

نام کاربر:
"${userName || 'دوست من'}"
`;

        } else {
            systemText = `
تو Virtual Bot هستی؛ یک دستیار هوش مصنوعی فارسی.

قوانین:
- نام سازنده یا تیمی را از خودت نساز.
- اطلاعات ساختگی نده.
- فارسی روان و خودمانی صحبت کن.
- خشک و رباتی نباش.
- در موقعیت مناسب شوخی دوستانه داشته باش 😂.
- ایموجی را متعادل استفاده کن.
- هرگز 🤖 استفاده نکن.
- هنگام سلام 😊 یا 👋 استفاده کن.
- سؤال ساده را بی‌دلیل طولانی نکن.

نام کاربر:
"${userName || 'دوست من'}"
`;
        }

        systemText += antiSelfQA;

        /*
        |--------------------------------------------------------------------------
        | File Edit Mode
        |--------------------------------------------------------------------------
        */

        if (textFiles.length > 0) {
            const fileNamesList =
                textFiles
                    .map(
                        f =>
                            `«${f.name || 'file'}»`
                    )
                    .join('، ');

            systemText += `

حالت ویرایش فایل:

- کاربر ${textFiles.length > 1
                    ? `${textFiles.length} فایل کد/متن (${fileNamesList})`
                    : `یک فایل کد/متن`
                } ضمیمه کرده است.

- محتوای فایل منبع معتبر کد است.
- اگر کاربر تغییر کد خواست، واقعاً تغییر را روی فایل اعمال کن.
- ساختارهای موجود را بررسی کن و چیزهای بی‌دلیل اختراع نکن.
- به جای بازنویسی کل فایل، فقط قسمت لازم را تغییر بده.
- در پایان پاسخ دقیقاً یک بلاک file-edit تولید کن.

فرمت:

\`\`\`file-edit
[
  {
    "file": "نام فایل",
    "old": "متن دقیق قدیمی",
    "new": "متن دقیق جدید"
  }
]
\`\`\`

خارج از file-edit کد کامل فایل را دوباره چاپ نکن.
`;
        }

        /*
        |--------------------------------------------------------------------------
        | Model Fallback
        |--------------------------------------------------------------------------
        */

        const modelsToTry = [MODEL_NAME];

        if (
            MODEL_NAME ===
            'gemini-3.1-pro-preview'
        ) {
            modelsToTry.push(
                'gemini-3.6-flash'
            );

            modelsToTry.push(
                'gemini-3.5-flash-lite'
            );
        }

        if (
            MODEL_NAME ===
            'gemini-3.6-flash'
        ) {
            modelsToTry.push(
                'gemini-3.5-flash-lite'
            );
        }

        /*
        |--------------------------------------------------------------------------
        | STREAM
        |--------------------------------------------------------------------------
        */

        if (wantsStream) {
            res.setHeader(
                'Content-Type',
                'text/event-stream; charset=utf-8'
            );

            res.setHeader(
                'Cache-Control',
                'no-cache, no-transform'
            );

            res.setHeader(
                'Connection',
                'keep-alive'
            );

            res.setHeader(
                'X-Accel-Buffering',
                'no'
            );

            if (
                typeof res.flushHeaders ===
                'function'
            ) {
                res.flushHeaders();
            }

            const overallDeadline =
                Date.now() + 60000;

            let lastError = null;

            outerLoop:
            for (
                const currentModel of modelsToTry
            ) {
                for (
                    let k = 0;
                    k < geminiKeys.length;
                    k++
                ) {
                    if (
                        Date.now() >
                        overallDeadline
                    ) {
                        break outerLoop;
                    }

                    const currentKey =
                        geminiKeys[k];

                    try {
                        console.log(
                            `[stream] Trying model: ${currentModel} with Key #${k + 1}`
                        );

                        const controller =
                            new AbortController();

                        const timeoutId =
                            setTimeout(
                                () =>
                                    controller.abort(),
                                15000
                            );

                        let upstream;

                        try {
                            upstream =
                                await fetch(
                                    `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:streamGenerateContent?alt=sse`,
                                    {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type':
                                                'application/json',
                                            'x-goog-api-key':
                                                currentKey
                                        },
                                        body:
                                            JSON.stringify({
                                                system_instruction: {
                                                    parts: [
                                                        {
                                                            text: systemText
                                                        }
                                                    ]
                                                },
                                                contents
                                            }),
                                        signal:
                                            controller.signal
                                    }
                                );
                        } finally {
                            clearTimeout(
                                timeoutId
                            );
                        }

                        if (
                            !upstream.ok ||
                            !upstream.body
                        ) {
                            let errorBody =
                                null;

                            try {
                                errorBody =
                                    await upstream.json();
                            } catch (_) {}

                            lastError =
                                errorBody;

                            continue;
                        }

                        const reader =
                            upstream.body.getReader();

                        const decoder =
                            new TextDecoder();

                        let buffer = '';

                        while (true) {
                            const {
                                done,
                                value
                            } =
                                await reader.read();

                            if (done) break;

                            buffer +=
                                decoder.decode(
                                    value,
                                    {
                                        stream: true
                                    }
                                );

                            const lines =
                                buffer.split('\n');

                            buffer =
                                lines.pop();

                            for (
                                const line of lines
                            ) {
                                if (
                                    !line.startsWith(
                                        'data:'
                                    )
                                ) {
                                    continue;
                                }

                                const jsonStr =
                                    line
                                        .slice(5)
                                        .trim();

                                if (!jsonStr) {
                                    continue;
                                }

                                try {
                                    const parsed =
                                        JSON.parse(
                                            jsonStr
                                        );

                                    const piece =
                                        parsed
                                            ?.candidates?.[0]
                                            ?.content?.parts?.[0]
                                            ?.text ||
                                        '';

                                    if (piece) {
                                        res.write(
                                            `data: ${JSON.stringify({
                                                text: piece
                                            })}\n\n`
                                        );

                                        if (
                                            typeof res.flush ===
                                            'function'
                                        ) {
                                            res.flush();
                                        }
                                    }
                                } catch (_) {}
                            }
                        }

                        res.write(
                            `data: ${JSON.stringify({
                                done: true
                            })}\n\n`
                        );

                        if (
                            typeof res.flush ===
                            'function'
                        ) {
                            res.flush();
                        }

                        return res.end();

                    } catch (error) {
                        console.error(
                            `[stream] Error:`,
                            error?.message ||
                            error
                        );

                        lastError = error;
                    }
                }
            }

            res.write(
                `data: ${JSON.stringify({
                    error:
                        'سرور شلوغه یا کلیدهای فعال سهمیه‌شون تموم شده — چند لحظه دیگه دوباره امتحان کن.'
                })}\n\n`
            );

            return res.end();
        }

        /*
        |--------------------------------------------------------------------------
        | NON STREAM
        |--------------------------------------------------------------------------
        */

        const overallDeadline =
            Date.now() + 60000;

        let lastError = null;

        outerLoopNonStream:
        for (
            const currentModel of modelsToTry
        ) {
            for (
                let k = 0;
                k < geminiKeys.length;
                k++
            ) {
                if (
                    Date.now() >
                    overallDeadline
                ) {
                    break outerLoopNonStream;
                }

                const currentKey =
                    geminiKeys[k];

                try {
                    console.log(
                        `Trying model: ${currentModel} with Key #${k + 1}`
                    );

                    const controller =
                        new AbortController();

                    const timeoutId =
                        setTimeout(
                            () =>
                                controller.abort(),
                            15000
                        );

                    let response;

                    try {
                        response =
                            await fetch(
                                `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent`,
                                {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type':
                                            'application/json',
                                        'x-goog-api-key':
                                            currentKey
                                    },
                                    body:
                                        JSON.stringify({
                                            system_instruction: {
                                                parts: [
                                                    {
                                                        text: systemText
                                                    }
                                                ]
                                            },
                                            contents
                                        }),
                                    signal:
                                        controller.signal
                                }
                            );
                    } finally {
                        clearTimeout(
                            timeoutId
                        );
                    }

                    const data =
                        await response.json();

                    if (!response.ok) {
                        console.warn(
                            `Model ${currentModel} failed:`,
                            data?.error?.message ||
                            response.statusText
                        );

                        lastError = data;

                        continue;
                    }

                    return res.status(200).json(data);

                } catch (error) {
                    console.error(
                        `Error with model ${currentModel}:`,
                        error?.message ||
                        error
                    );

                    lastError = error;
                }
            }
        }

        return res.status(500).json({
            error: {
                message:
                    'سرور شلوغه یا کلیدهای فعال سهمیه‌شون تموم شده — چند لحظه دیگه دوباره امتحان کن.',
                details:
                    lastError
            }
        });

    } catch (globalError) {
        console.error(
            'Server Error:',
            globalError
        );

        return res.status(500).json({
            error: {
                message:
                    'خطای داخلی سرور',
                details:
                    globalError.message
            }
        });
    }
}

module.exports = handler;
