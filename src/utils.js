// utils.js - Utility Functions and Helpers
const fs = require('fs');
const config = require('./config');
const { getMemory, setMemory } = require('./database');

/**
 * Tiny in-memory cache
 */
class TinyCache {
    constructor({ max = 500, ttl = 10 * 60 * 1000 } = {}) {
        this.store = new Map();
        this.max = max;
        this.ttl = ttl;
    }

    get(k) {
        const it = this.store.get(k);
        if (!it) return undefined;
        if (Date.now() > it.exp) {
            this.store.delete(k);
            return undefined;
        }
        return it.v;
    }

    set(k, v) {
        if (this.store.size >= this.max) {
            const first = this.store.keys().next().value;
            if (first !== undefined) this.store.delete(first);
        }
        this.store.set(k, { v, exp: Date.now() + this.ttl });
    }
}

/**
 * Safe logging to JSONL file
 */
function safeLog(obj) {
    try {
        fs.appendFileSync(
            config.LOG_PATH,
            JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'
        );
    } catch (e) {
        console.warn('safeLog error:', e.message || e);
    }
}

/**
 * Check if user wants simpler explanation
 */
function wantsSimpler(text) {
    const t = (text || '').toLowerCase();
    return /مبتدئ|ابسط|بسيط|ما فهمت|شرح اكثر|وضح اكثر|فهمني/.test(t);
}

/**
 * Infer topic from user text
 */
function inferTopicFrom(text) {
    const t = (text || '').toLowerCase();
    
    if (/شموع|شمعات|candl|hammer|engulf|pin\s*bar/i.test(t)) return 'candles';
    if (/وقف|stop\s*loss|sl/i.test(t)) return 'stoploss';
    if (/ادارة|مخاط|risk/i.test(t)) return 'risk';
    if (/دخول|خروج|entry|exit/i.test(t)) return 'entry_exit';
    if (/اتجاه|trend/i.test(t)) return 'trend';
    if (/دعم|مقاوم|sr|support|resist/i.test(t)) return 'sr';
    if (/ناسداك|nas|us100/i.test(t)) return 'nasdaq';
    if (/ذهب|xau|xauusd|gold/i.test(t)) return 'gold';
    if (/فوركس|eurusd|gbpusd|usd|jpy|aud|cad/i.test(t)) return 'forex';
    
    return 'general';
}

/**
 * Parse mini trade from text
 */
function parseMiniTrade(text) {
    const m = text.match(/(ذهب|gold|xau|xauusd|ناسداك|nas|us100|فوركس|eurusd|gbpusd)/i);
    const tf = text.match(/\b(H\d+|M\d+)\b/i);
    const entry = text.match(/(?:دخول|entry)\s*([0-9\.]+)/i);
    const sl = text.match(/(?:sl|وقف)\s*([0-9\.]+)/i);
    const tp = text.match(/(?:tp|هدف)\s*([0-9\.]+)/i);
    
    return {
        instrument: m?.[1]?.toUpperCase() || null,
        tf: tf?.[1]?.toUpperCase() || null,
        entry: entry?.[1] || null,
        sl: sl?.[1] || null,
        tp: tp?.[1] || null
    };
}

/**
 * Maybe journal a trade if user mentions it
 */
async function maybeJournalTrade(telegramId, text) {
    if (!/سجل\s*صفقه|سجل صفقة|سجل صفقة/i.test(text)) {
        return false;
    }

    const trade = parseMiniTrade(text);
    const key = 'journal:' + new Date().toISOString().slice(0, 10);
    const cur = await getMemory(telegramId, key);
    const arr = cur ? JSON.parse(cur) : [];
    
    arr.push({ ts: Date.now(), ...trade, raw: text });
    await setMemory(telegramId, key, JSON.stringify(arr));
    
    return true;
}

/**
 * Mistake tracking
 */
const MISTAKE_TAGS = [
    'overtrading', 'early_entry', 'late_exit',
    'no_stop', 'move_sl', 'revenge',
    'chasing', 'no_plan'
];

/**
 * Bump mistake counter
 */
async function bumpCounter(telegramId, tag) {
    const today = new Date();
    const ym = today.toISOString().slice(0, 7); // YYYY-MM
    const kMonth = `mistake:${tag}:${ym}`;
    const k7 = `mistake:${tag}:rolling7`;

    // Monthly counter
    const prevMonth = parseInt(await getMemory(telegramId, kMonth) || '0', 10);
    await setMemory(telegramId, kMonth, String(prevMonth + 1));

    // Rolling 7-day counter
    const prev7raw = await getMemory(telegramId, k7);
    const arr = prev7raw ? JSON.parse(prev7raw) : [];
    const d = today.toISOString().slice(0, 10);
    arr.push({ d });

    // Keep only last 7 days
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 7);
    const kept = arr.filter(x => new Date(x.d) >= cutoff);

    await setMemory(telegramId, k7, JSON.stringify(kept));
    
    return kept.length;
}

/**
 * Get rolling 7-day mistake count
 */
async function getRollingCount(telegramId, tag) {
    const raw = await getMemory(telegramId, `mistake:${tag}:rolling7`);
    if (!raw) return 0;

    const arr = JSON.parse(raw);
    const today = new Date();
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 7);

    return arr.filter(x => new Date(x.d) >= cutoff).length;
}

/**
 * Check if text is a news request
 */
function isNewsRequest(t) {
    t = (t || '').toLowerCase();
    return /خبر|اخبار|الأخبار|الاخبار|news|calendar|تقويم|احداث|الأسبوع القادم|الأسبوع المقبل/.test(t);
}

/**
 * Check if text is "getting started" question
 */
function isGettingStarted(t) {
    t = (t || '').toLowerCase();
    return /كيف.*ابدأ|كيف.*بلش|from where.*start|how.*start.*trading|ابدا.*تداول|بلش.*تداول/.test(t);
}

/**
 * Quick news template
 */
function quickWeeklyNewsTemplate() {
    return [
        'ملخص أسبوعي سريع:',
        '',
        '✅ للتجهيز للأسبوع القادم، ركّز على:',
        '• قرارات/تصريحات البنوك المركزية (FOMC/ECB/BoE) والبيانات التضخمية (CPI, PCE).',
        '• بيانات التوظيف (NFP, Jobless Claims) والناتج المحلي (GDP).',
        '• مؤشرات مديري المشتريات (PMI/ISM) والميزان التجاري.',
        '• مخزونات النفط EIA (إن كنت تتداول النفط) ومحاضر الاجتماعات.',
        '',
        '⚠️ نصيحة 6FE:',
        'خفّض الحجم نصف المعتاد قبل الأخبار بـ 15–30 دقيقة وبعدها حتى يستقر الاتجاه، والتزم مخاطرة 1–2%.'
    ].join('\n');
}

/**
 * Quick start trading template
 */
function quickStartTradingTemplate() {
    return [
        '✅ خطة بداية تداول بسيطة خلال 7 أيام:',
        '',
        'اليوم 1–2: تعلّم الأساسيات (أنواع الأوامر، الرافعة، الهامش).',
        'اليوم 3: اختر أداة واحدة فقط (ذهب H1 أو ناسداك M15).',
        'اليوم 4: صمّم قاعدة دخول/خروج + وقف ثابت (مخاطرة 1–2%).',
        'اليوم 5: نفّذ 10 صفقات تجريبية بنفس القاعدة.',
        'اليوم 6: راجع دفتر الصفقات (سبب الربح/الخسارة).',
        'اليوم 7: ثبّت قاعدة واحدة للأسبوع القادم وقلّل الضجيج.',
        '',
        '💡 نصيحة 6FE:',
        'أرباح صغيرة + انضباط كبير = استمرارية طويلة المدى.'
    ].join('\n');
}

/**
 * Per-user request serialization
 */
const userLocks = new Map();

function serializeUser(userId, task) {
    const key = String(userId || 'anon');
    const prev = userLocks.get(key) || Promise.resolve();
    
    const next = prev
        .then(task)
        .catch((e) => {
            console.warn('serializeUser task error:', e && (e.message || e));
        })
        .finally(() => {
            if (userLocks.get(key) === next) {
                userLocks.delete(key);
            }
        });
    
    userLocks.set(key, next);
    return next;
}

module.exports = {
    TinyCache,
    safeLog,
    wantsSimpler,
    inferTopicFrom,
    parseMiniTrade,
    maybeJournalTrade,
    MISTAKE_TAGS,
    bumpCounter,
    getRollingCount,
    isNewsRequest,
    isGettingStarted,
    quickWeeklyNewsTemplate,
    quickStartTradingTemplate,
    serializeUser
};
