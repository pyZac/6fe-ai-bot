// ai_bot.js — 6FE AI Coach Bot — Modular Architecture (Step 2: Enhanced Formatting)

// ============ 0) Polyfills for Node ============
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fetch = require('node-fetch');
globalThis.fetch = fetch;
const { Headers, Request, Response } = fetch;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;

const FormData = require('form-data');
globalThis.FormData = FormData;

// ============ 1) Imports ============
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const { parse } = require('csv-parse/sync');

// Our modules (all in same /src/ folder)
const config = require('./config');
const database = require('./database');
const { createDbMemory } = require('./db_memory');
const { loadIndex, semanticSearch } = require('./semantic');
const { askAnyLLM } = require('./llm_providers');
const { registerCommands } = require('./commands');
const {
    SYSTEM_PROMPT,
    detectQuestionType,
    getMistakeClassificationPrompt
} = require('./prompts');
const {
    TinyCache,
    safeLog,
    wantsSimpler,
    inferTopicFrom,
    maybeJournalTrade,
    MISTAKE_TAGS,
    bumpCounter,
    isNewsRequest,
    isGettingStarted,
    quickWeeklyNewsTemplate,
    quickStartTradingTemplate,
    serializeUser
} = require('./utils');

// ============ 2) Validate Configuration ============
config.validate();

// ============ 3) Initialize Clients ============
const bot = new Telegraf(config.BOT_TOKEN, {
    handlerTimeout: config.HANDLER_TIMEOUT
});

const ai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// ============ 4) Caching & State ============
const answerCache = new TinyCache({
    max: config.CACHE_MAX_ENTRIES,
    ttl: config.CACHE_TTL_MS
});

const recentPrompts = new Map(); // uid -> {key, ts}

// ============ 5) DB-Based Memory (replaces Redis) ============
const threadMemory = createDbMemory({
    getDb: database.getDb,
    ai,
    model: config.PRIMARY_MODEL,
    maxTurns: config.THREAD_MAX_TURNS,
    summarizeEveryN: config.SUMMARY_EVERY_N,
    contextWindow: config.CONTEXT_WINDOW
});

console.log('✅ DB-based conversation memory enabled');

// ============ 6) Load Knowledge Base ============
const KB_PATH = path.join(__dirname, config.KB_PATH);

if (!fs.existsSync(KB_PATH)) {
    console.error('❌ kb.csv not found at:', KB_PATH);
    console.error('Expected location: /data/kb.csv');
    process.exit(1);
}

const csv = fs.readFileSync(KB_PATH, 'utf8');
const rows = parse(csv, { columns: true, skip_empty_lines: true });

const KB = rows.map(r => ({
    id: String(r.id ?? '').trim(),
    q: (r.question_ar ?? '').trim(),
    a: (r.cleaned_answer ?? '').trim(),
    topic: (r.topic ?? '').trim(),
    search: ((r.search_text ?? '') + ' ' + (r.topic ?? '')).toLowerCase()
})).filter(r => r.id && (r.q || r.a));

console.log(`✅ Loaded ${KB.length} KB entries from ${KB_PATH}`);

// ============ 7) Simple KB Search (Fallback) ============
const STOP = new Set(['و', 'في', 'من', 'على', 'عن', 'الى', 'إلى', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'by', 'is', 'are']);

function normalize(s) {
    return String(s).toLowerCase()
        .replace(/[\u0617-\u061A\u064B-\u0652]/g, '')
        .replace(/[أإآ]/g, 'ا').replace(/ء/g, '')
        .replace(/ى/g, 'ي').replace(/ة/g, 'ه')
        .replace(/[^\p{L}\p{N}\s\.%]/gu, ' ')
        .replace(/\s+/g, ' ').trim();
}

function tokens(s) {
    return normalize(s).split(' ').filter(w => w && !STOP.has(w));
}

function scoreRow(qt, row) {
    let sc = 0;
    for (const t of qt) {
        if (row.search.includes(` ${t} `) || row.search.startsWith(t + ' ') || row.search.endsWith(' ' + t)) {
            sc += 2;
        } else if (t.length >= 3 && row.search.includes(t)) {
            sc += 1;
        }
        if (/^[0-9]+(\.[0-9]+)?$/.test(t) || /%$/.test(t)) {
            sc += 1;
        }
    }
    return sc;
}

function topMatches(text, k = 5) {
    const qt = tokens(text);
    const scored = KB.map(r => ({ ...r, score: scoreRow(qt, r) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

function localKbAnswer(userText) {
    const matches = topMatches(userText, 3).filter(m => m && (m.a || m.q));

    if (!matches.length) {
        return 'جواب مختصر: التزم قاعدة مخاطرة 1–2% وحدّد أداة واحدة وإطار واحد، وانتظر تأكيد واضح للدخول. إن لم تحصل على تفاصيل كافية، أعد صياغة سؤالك بنقطة واحدة واضحة.';
    }

    const parts = matches.map(m => `➜ ${m.a || m.q}`).join('\n');

    return [
        'ملخّص عملي من قاعدة معرفتنا:',
        parts,
        'نصيحة 6FE: طبّق قاعدة واحدة اليوم وقيّم النتيجة بنهاية الجلسة.'
    ].join('\n');
}

// ============ 8) Mistake Classification ============
async function classifyMistake(userText) {
    const prompt = getMistakeClassificationPrompt(userText);

    try {
        const text = await askAnyLLM(ai, [{ role: 'user', content: prompt }], 16);
        const tag = (text || '').trim().toLowerCase();
        return MISTAKE_TAGS.includes(tag) ? tag : 'none';
    } catch {
        return 'none';
    }
}

// ============ 9) Answer Generation (UPDATED for Step 2) ============
async function generateAnswer(userText, semanticRes, profile) {
    const level = profile?.level || 'standard';

    // *** NEW: Detect question type for structured formatting ***
    const questionType = detectQuestionType(userText);

    // Try reading last chart context (optional)
    let ctxBlock = '';
    try {
        const tsRaw = await database.getMemory(profile?.telegram_id, 'last_ctx_ts');
        const ts = parseInt(tsRaw || '0', 10);
        const recent = ts && (Date.now() - ts) < 60 * 60 * 1000; // Last hour

        if (recent) {
            const sum = await database.getMemory(profile?.telegram_id, 'last_ctx_summary');
            if (sum) {
                ctxBlock = `سياق من آخر تحليل شارت للمستخدم (استخدمه إذا كان السؤال إحالي مثل "هيك الحالة"): \n${sum}`;
            }
        }
    } catch { }

    // Prepare KB context from semantic search results
    // ALWAYS use LLM - never return KB directly
    // Semantic search provides context for LLM to generate customized answer

    const topMatches = (semanticRes?.top || []).filter(m => m.score > 0.5).slice(0, 3);

    let kbContext = '';
    if (topMatches.length > 0) {
        kbContext = 'معلومات ذات صلة من قاعدة المعرفة:\n\n';
        topMatches.forEach((match, idx) => {
            if (match.answer) {
                kbContext += `${idx + 1}. ${match.answer}\n\n`;
            }
        });
        kbContext += 'استخدم المعلومات أعلاه لصياغة إجابة مخصصة وشاملة للسؤال.\n';
    }

    // *** NEW: Question type hint for structured formatting ***
    const questionTypeHints = {
        'definition': 'استخدم بنية "💡 التعريف" من دليل الأسلوب',
        'howto': 'استخدم بنية "🔧 الخطوات العملية" من دليل الأسلوب',
        'comparison': 'استخدم بنية "⚖️ المقارنة" من دليل الأسلوب',
        'analysis': 'استخدم بنية "🔍 تحليل" من دليل الأسلوب',
        'troubleshooting': 'استخدم بنية "🔧 حل مشكلة" من دليل الأسلوب',
        'general': 'استخدم البنية المناسبة من دليل الأسلوب'
    };

    const typeHint = questionTypeHints[questionType] || questionTypeHints['general'];

    const baseMessages = [
        // *** UPDATED: Use SYSTEM_PROMPT ***
        { role: 'system', content: SYSTEM_PROMPT },

        // *** NEW: Add question type hint ***
        { role: 'system', content: `نوع السؤال: ${questionType}\n${typeHint}` },

        ...(ctxBlock ? [{ role: 'system', content: ctxBlock }] : []),
        ...(kbContext ? [{ role: 'system', content: kbContext }] : []),
        {
            role: 'system',
            content: `مستوى المستخدم: ${level}, مخاطرة تقريبًا ~${profile?.risk_percent ?? 1}%${profile?.instruments ? `، أدوات: ${profile.instruments}` : ''}`
        },
        { role: 'user', content: userText }
    ];

    try {
        const text = await askAnyLLM(ai, baseMessages, Math.min(450, config.OPENAI_MAX_OUTPUT_TOKENS));
        return text;
    } catch (e) {
        console.warn('LLM total failure, switching to local KB answer:', e && (e.message || e));
        // Final fallback - use simple keyword search to guarantee a reply
        return localKbAnswer(userText);
    }
}

// ============ 10) Register Commands ============
registerCommands(bot, threadMemory);

// ============ 11) Photo Handler (Chart Analysis) ============
bot.on('photo', (ctx) => serializeUser(ctx.from?.id, async () => {
    const uid = ctx.from.id;
    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];

    let fileLink = null;
    try {
        fileLink = await ctx.telegram.getFileLink(best.file_id);
    } catch {
        return ctx.reply('وصلت الصورة 👌 اكتب لي الإطار الزمني والأداة (مثال: ذهب H1) لحتى أعلّق عمليًا.');
    }

    const profile = await database.getUserProfile(uid);
    profile.telegram_id = uid;

    // *** NEW: Show typing + loading message ***
    await ctx.sendChatAction('typing');
    const loadingMsg = await ctx.reply('📊 بحلل الشارت...');

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
            role: 'system',
            content: `مستوى المستخدم: ${profile.level}, مخاطرة تقريبًا ~${profile.risk_percent}%`
        },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'حلّل هذا الشارت بنقاط عملية عند اللزوم، بدون تنسيق غامق.' },
                { type: 'image_url', image_url: { url: String(fileLink) } }
            ]
        }
    ];

    try {
        // Single attempt through failover chain
        const text = await askAnyLLM(ai, messages, config.OPENAI_MAX_OUTPUT_TOKENS);
        
        // *** Delete loading message ***
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        } catch (e) {
            console.warn('Could not delete loading message:', e.message);
        }
        
        await ctx.reply(text);

        // Store last chart analysis context (for follow-up questions like "هيك الحالة")
        await database.setMemory(uid, 'last_ctx_summary', text.slice(0, 1200));
        await database.setMemory(uid, 'last_ctx_ts', String(Date.now()));

        // Thread memory + DB archiving (won't break reply if fails)
        try {
            await threadMemory.append(uid, 'user', '[صورة شارت]', {
                content_type: 'image',
                question_type: 'chart_analysis',
                timestamp: Date.now()
            });

            await threadMemory.append(uid, 'assistant', text, {
                content_type: 'chart_analysis',
                answer_length: text.length,
                has_entry_exit: /دخول|خروج|entry|exit/i.test(text),
                has_risk: /مخاطر|وقف|stop/i.test(text),
                timestamp: Date.now()
            });

            await threadMemory.maybeSummarize(uid);
        } catch (e) {
            console.warn('threadMemory warn:', e.message || e);
        }
    } catch (e) {
        console.error('Vision failure total:', e && (e.message || e));
        
        // *** Delete loading message on error too ***
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        } catch { }
        
        // Simple local fallback
        await ctx.reply('نصيحة سريعة: حدد الاتجاه على الإطار الأكبر، وانتظر نموذجًا واضحًا مع تأكيد حجم/زخم، ولا تتجاوز مخاطرة 1–2%.');
        return;
    }
}));

// ============ 12) Text Handler (Main Conversation) ============
bot.on('text', (ctx) => serializeUser(ctx.from?.id, async () => {
    let userText = ctx.message.text || '';
    const uid = ctx.from?.id;

    // *** NEW: Create a processing timeout ***
    const processingTimeout = setTimeout(async () => {
        try {
            await ctx.reply('⏳ السؤال أخذ وقت أطول من المتوقع، بجهّز إجابة مبسطة...');
        } catch (e) {
            console.warn('Timeout message failed:', e.message);
        }
    }, 20_000); // Alert after 20 seconds

    try {
        // (A) Access Gate
        const gate = await database.isUserActive(uid);

        if (!gate?.skipGate && !gate.active) {
            clearTimeout(processingTimeout);
            const msg = (gate.reason === 'expired')
                ? 'يبدو أنّ اشتراكك غير فعّال حالياً (منتهي). تواصل مع فريق الدعم للمساعدة.'
                : 'تعذّر التحقّق من اشتراكك. تواصل مع فريق الدعم للمساعدة.';

            await ctx.reply(msg);
            safeLog({ uid, query: userText, access: 'denied', reason: gate.reason });
            return;
        }

        // (B) Profile
        if (wantsSimpler(userText)) {
            await database.upsertUserProfile(uid, { level: 'beginner' });
        }

        const profile = await database.getUserProfile(uid);
        profile.telegram_id = uid;

        // (B0) Fast shortcuts (no AI needed)
        if (isNewsRequest(userText)) {
            clearTimeout(processingTimeout);
            const quick = quickWeeklyNewsTemplate();
            await ctx.reply(quick);
            return;
        }

        if (isGettingStarted(userText)) {
            clearTimeout(processingTimeout);
            const quick = quickStartTradingTemplate();
            await ctx.reply(quick);
            return;
        }

        // (B1) Topic continuity (light)
        let detectedTopic = inferTopicFrom(userText);
        const justExample = /^(\s*عطيني مثال\s*|^\s*اعطني مثال\s*|^\s*مثال\s*)$/i.test(userText);

        if (justExample) {
            const lastTopic = await database.getMemory(uid, 'last_topic');
            if (lastTopic) {
                detectedTopic = lastTopic;
                userText = `أعطني مثالاً عمليًا على الموضوع السابق: ${lastTopic}`;
            }
        }

        // (B2) Spam/duplicate prevention + caching
        const key = (userText || '').trim().toLowerCase();
        const now = Date.now();
        const last = recentPrompts.get(uid);

        if (last && last.key === key && (now - last.ts) < config.SPAM_PREVENTION_MS) {
            clearTimeout(processingTimeout);
            return ctx.reply('استلمت سؤالك—شغال عليه 👌');
        }

        recentPrompts.set(uid, { key, ts: now });

        const cached = answerCache.get(key);
        if (cached) {
            clearTimeout(processingTimeout);
            await ctx.reply(cached);
            return;
        }

        // *** Show typing indicator + loading message ***
        await ctx.sendChatAction('typing');

        const loadingMessages = [
            '🔍 بحلل سؤالك...',
            '⚙️ بجهّز الإجابة...',
            '💭 بفكّر في أفضل طريقة لشرحها...',
            '📊 بدوّر في قاعدة المعرفة...',
            '🎯 بصيغ إجابة عملية...'
        ];

        const randomLoading = loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
        const loadingMsg = await ctx.reply(randomLoading);

        // (C0) Mini trade journal (optional)
        await maybeJournalTrade(uid, userText);

        // (C1) Semantic Retrieval first
        const sres = await semanticSearch(userText, { topK: 5, threshold: 0.5 });

        // Keep typing indicator alive during processing
        const typingInterval = setInterval(() => {
            ctx.sendChatAction('typing').catch(() => clearInterval(typingInterval));
        }, 4000);

        // (C2) Mistake alert (optional, lightweight)
        let prefix = '';
        try {
            const questionWords = /^(ما|كيف|لماذا|متى|أين|من|هل|شو|ايش|وين|ليش|كم|شلون|وش|ازاي|ممكن)\s/i;
            const hasQuestionMark = /\?|؟/.test(userText);
            const isQuestion = questionWords.test(userText.trim()) || hasQuestionMark;

            if (!isQuestion) {
                const tag = await classifyMistake(userText);
                if (tag !== 'none') {
                    const count7 = await bumpCounter(uid, tag);
                    if (count7 >= 3) {
                        const map = {
                            overtrading: 'كثرة الصفقات',
                            early_entry: 'دخول مبكّر',
                            late_exit: 'خروج متأخر',
                            no_stop: 'بدون وقف',
                            move_sl: 'تحريك الوقف',
                            revenge: 'انتقام',
                            chasing: 'مطاردة',
                            no_plan: 'بلا خطة'
                        };
                        prefix = `تنبيه 👀: تكرر "${map[tag] || tag}" هذا الأسبوع. جرّب قاعدة واحدة اليوم ثم قيّم نتيجتها.\n\n`;
                    }
                }
            }
        } catch (e) {
            console.warn('classifier warn:', e.message || e);
        }

        // (C3) Generate answer with timeout protection
        let answer;
        try {
            answer = await Promise.race([
                generateAnswer(userText, sres, profile),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('GENERATION_TIMEOUT')), 60_000)
                )
            ]);
        } catch (e) {
            if (e.message === 'GENERATION_TIMEOUT') {
                console.warn('Generation timeout, using local KB fallback');
                answer = localKbAnswer(userText);
            } else {
                throw e;
            }
        }

        // *** Clear timeouts and intervals ***
        clearTimeout(processingTimeout);
        clearInterval(typingInterval);

        // *** Delete loading message ***
        try {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        } catch (e) {
            console.warn('Could not delete loading message:', e.message);
        }

        // (C4) Send
        const finalMsg = prefix + answer;
        await ctx.reply(finalMsg);
        answerCache.set(key, finalMsg);

        // (D) Thread memory + DB archiving (won't break reply if fails)
        try {
            await threadMemory.append(uid, 'user', userText, {
                question_type: detectedTopic || 'general',
                length: userText.length,
                has_numbers: /\d/.test(userText),
                timestamp: Date.now()
            });

            await threadMemory.append(uid, 'assistant', finalMsg, {
                semantic_score: sres?.best?.score || 0,
                used_kb: !!sres?.useKB,
                used_llm: !sres?.useKB,
                answer_length: finalMsg.length,
                has_warning: prefix.includes('تنبيه'),
                timestamp: Date.now()
            });

            await threadMemory.maybeSummarize(uid);
        } catch (e) {
            console.warn('threadMemory warn:', e.message || e);
        }

        await database.setMemory(uid, 'last_topic', detectedTopic || 'general');

        // Log semantic results
        const topLite = (sres?.top || []).map(t => ({
            id: t.id,
            s: Number(t.score?.toFixed(3) || 0)
        }));

        safeLog({
            uid,
            query: userText,
            sem_top: topLite,
            useKB: !!sres?.useKB,
            best: sres?.best?.score
        });

    } catch (e) {
        clearTimeout(processingTimeout);
        console.error(e);
        // Even on exception, send a guaranteed reply
        await ctx.reply(
            'جواب سريع: ركّز على قاعدة واحدة اليوم، مخاطرة 1–2%، وانتظر تأكيد واضح قبل الدخول. ' +
            'لو أردت تفصيلاً، أعد صياغة سؤالك بجملة واحدة واضحة.'
        );
        safeLog({
            uid,
            query: (ctx && ctx.message && ctx.message.text) || '',
            error: String(e)
        });
    }
}));

// ============ 13) Boot Sequence ============
(async () => {
    try {
        // Initialize database schema
        await database.initDbSchema();

        // Load semantic search index
        await loadIndex();
        console.log('✅ Semantic index loaded');

        // Delete any old webhook before switching to long polling
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('ℹ️ Webhook deleted (switching to long polling)');

        // Launch bot
        bot.launch({ dropPendingUpdates: true });
        console.log('✅ 6FE educational bot running — Step 2: Enhanced Formatting Active');

    } catch (e) {
        console.error('❌ Boot error:', e);
        process.exit(1);
    }
})();

// ============ 14) Graceful Shutdown ============
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));