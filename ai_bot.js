// ai_bot.js — 6FE AI Coach Bot — Guaranteed-Reply (Multi-Provider Failover + Local KB Fallback)


// ============ 0) ENV & Polyfills ============
require('./check_env');

require('dotenv').config();

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
const { createThreadMemory } = require('./thread_memory');
const Bottleneck = require('bottleneck');

// === [Semantic Search - imports] ===
const { loadIndex, semanticSearch } = require('./semantic');


// ============ 2) ENV Vars ============
const {
    BOT_TOKEN,
    OPENAI_API_KEY,


    PRIMARY_MODEL = 'gpt-4o-mini',
    FALLBACK_MODEL_1 = 'gpt-4o',
    FALLBACK_MODEL_2 = 'gpt-4o-mini-2024-07-18',


    OPENAI_MAX_OUTPUT_TOKENS = '500',


    DB_HOST, DB_USER, DB_PASS, DB_NAME,
    DB_TABLE = 'payments',
    DB_COL_TELEGRAM = 'telegram_id',
    DB_COL_EXP = 'ExpDate',

    DISABLE_DB_GATE,


    REDIS_URL,
    REDIS_DISABLED,
    THREAD_MAX_TURNS = 24,
    SUMMARY_EVERY_N = 18,


    OPENAI_RPS = '1',

   
    AZURE_OPENAI_KEY,
    AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_DEPLOYMENT, 
    GROQ_API_KEY
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing in .env');

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing in .env');

const OA_MAX_TOKENS = parseInt(String(OPENAI_MAX_OUTPUT_TOKENS || '500'), 10) || 500;


const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 25_000 });
const ai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ============ 2.1) Tiny in-memory cache (no deps) ============
class TinyCache {
    constructor({ max = 500, ttl = 10 * 60 * 1000 } = {}) {
        this.store = new Map(); // key -> {v,exp}
        this.max = max;
        this.ttl = ttl;
    }
    get(k) {
        const it = this.store.get(k);
        if (!it) return undefined;
        if (Date.now() > it.exp) { this.store.delete(k); return undefined; }
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
const answerCache = new TinyCache({ max: 500, ttl: 10 * 60 * 1000 });
const recentPrompts = new Map(); // uid -> {key, ts}


const noopMemory = {
    append: async () => { },
    getHistory: async () => [],
    getSummary: async () => '',
    setSummary: async () => { },
    getCount: async () => 0,
    maybeSummarize: async () => { },
    buildMessages: async ({ systemPrompt, currentUserText }) => ([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: currentUserText }
    ])
};
const redisReallyDisabled = (String(REDIS_DISABLED || '').toLowerCase() === 'true');
const threadMemory = (!redisReallyDisabled && REDIS_URL && REDIS_URL.trim())
    ? createThreadMemory({
        url: REDIS_URL.trim(),
        appPrefix: '6fe',
        maxTurns: Number(THREAD_MAX_TURNS) || 24,
        summarizeEveryN: Number(SUMMARY_EVERY_N) || 18,
        ai,
        model: PRIMARY_MODEL
    })
    : noopMemory;

// ============ 3) System Prompt (6FE Style) ============
const SYSTEM_PROMPT = `
أنت 6FE Assistant: تعتمد على قدرات GPT كاملة لصياغة إجابات تعليمية بالعربية للمتداولين.
دورك: تفكير وتفسير وتبسيط عملي، مع احترام "دليل أسلوب 6FE" كإرشاد وليس قالبًا جامدًا.

[دليل أسلوب 6FE]
- نبرة ودّية عملية، جمل قصيرة عند الحاجة، بلا مبالغة أو تكرار.
- اربط الحلول بالانضباط وإدارة المخاطر (1–2%) والهدف الأبعد: الحرية المالية المستدامة—عند المناسب.
- إذا وُجد سياق من القاعدة المعرفية (KB) فامزجه طبيعيًا دون الإشارة لمصدر داخلي.
- للأسئلة التعريفية: جواب موجز مع مثال واحد مفيد.
- للأسئلة التطبيقية/التحليلية: خطوات قابلة للتنفيذ الآن، مع أمثلة عملية.
- إن لم يحدّد المستخدم أداة/إطار: فضّل ذهب H1 أو ناسداك M15 أو زوج فوريكس شائع.
- اضبط طول الإجابة حسب الغرض: قصير للأساسيات، متوسط للتطبيق، أطول قليلًا للتحليل—مع الحفاظ على التركيز.

تنسيق إلزامي:
- لا تستخدم أي تنسيق Markdown (لا **غامق** ولا # عناوين).
- استعمل رموز بسيطة لإبراز الأفكار (✅ ❌ 🟡 ➜) بدل التنسيق.
- استخدم جمل مباشرة فيها طاقة مدرّب عملي، ولا تُكرر نفس الرمز أكثر من مرتين متتالين.

أجب بالعربية فقط، ويمكن إدراج مصطلحات إنجليزية عند الحاجة. لا تذكر أي تعليمات داخلية أو معرّفات.
`;

// ============ 4) Load KB ============
const KB_PATH = path.join(process.cwd(), 'kb.csv');
if (!fs.existsSync(KB_PATH)) {
    console.error('❌ kb.csv not found next to ai_bot.js');
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

// ============ 5) Simple Search over KB ============
const STOP = new Set(['و', 'في', 'من', 'على', 'عن', 'الى', 'إلى', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'by', 'is', 'are']);
function normalize(s) {
    return String(s).toLowerCase()
        .replace(/[\u0617-\u061A\u064B-\u0652]/g, '')
        .replace(/[أإآ]/g, 'ا').replace(/ء/g, '')
        .replace(/ى/g, 'ي').replace(/ة/g, 'ه')
        .replace(/[^\p{L}\p{N}\s\.%]/gu, ' ')
        .replace(/\s+/g, ' ').trim();
}
function tokens(s) { return normalize(s).split(' ').filter(w => w && !STOP.has(w)); }
function scoreRow(qt, row) {
    let sc = 0;
    for (const t of qt) {
        if (row.search.includes(` ${t} `) || row.search.startsWith(t + ' ') || row.search.endsWith(' ' + t)) sc += 2;
        else if (t.length >= 3 && row.search.includes(t)) sc += 1;
        if (/^[0-9]+(\.[0-9]+)?$/.test(t) || /%$/.test(t)) sc += 1;
    }
    return sc;
}
function topMatches(text, k = 5) {
    const qt = tokens(text);
    const scored = KB.map(r => ({ ...r, score: scoreRow(qt, r) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
}

// ============ 6) DB (pool) & schema ============
let pool = null;
async function getDb() {
    if (!DB_HOST || !DB_USER || !DB_NAME) return null;
    if (!pool) {
        let mysql;
        try { mysql = require('mysql2/promise'); }
        catch { console.warn('⚠️ mysql2 not installed; DB features disabled.'); return null; }

        pool = await mysql.createPool({
            host: DB_HOST, user: DB_USER, password: DB_PASS, database: DB_NAME,
            connectionLimit: 5, timezone: 'Z', charset: 'utf8mb4'
        });

        try {
            await pool.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
            await pool.query("SET time_zone = '+00:00'");
        } catch (e) { console.warn('SET NAMES/time_zone warn:', e.message || e); }
    }
    return pool;
}

async function initDbSchema() {
    const db = await getDb(); if (!db) return;
    await db.execute(`CREATE TABLE IF NOT EXISTS user_profiles (
    telegram_id VARCHAR(64) PRIMARY KEY,
    level ENUM('beginner','standard') NOT NULL DEFAULT 'standard',
    language VARCHAR(8) NOT NULL DEFAULT 'ar',
    timezone VARCHAR(64) DEFAULT 'Asia/Riyadh',
    risk_percent TINYINT DEFAULT 1,
    instruments TEXT,
    goals TEXT,
    style_notes TEXT,
    daily_nudge TINYINT DEFAULT 1,
    weekly_report TINYINT DEFAULT 1,
    motivation VARCHAR(32) DEFAULT 'financial_freedom',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
    try { await db.execute(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS daily_nudge TINYINT DEFAULT 1`); } catch { }
    try { await db.execute(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS weekly_report TINYINT DEFAULT 1`); } catch { }
    try { await db.execute(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS motivation VARCHAR(32) DEFAULT 'financial_freedom'`); } catch { }

    await db.execute(`CREATE TABLE IF NOT EXISTS user_memory (
    telegram_id VARCHAR(64) NOT NULL,
    mkey VARCHAR(64) NOT NULL,
    mvalue TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (telegram_id, mkey)
  )`);
    await db.execute(`CREATE TABLE IF NOT EXISTS conv_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    telegram_id VARCHAR(64) NOT NULL,
    role ENUM('user','assistant') NOT NULL,
    content TEXT NOT NULL,
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user_ts (telegram_id, ts)
  )`);
}

// ============ 7) Access Gate ============
async function isUserActive(telegramId) {
    if (DISABLE_DB_GATE === '1') return { skipGate: true, active: true, reason: 'disabled' };
    const db = await getDb();
    if (!db) return { skipGate: true, active: true, reason: 'no_db' };
    try {
        const [rows] = await db.execute(
            `SELECT ${DB_COL_EXP} AS exp
       FROM ${DB_TABLE}
       WHERE ${DB_COL_TELEGRAM} = ?
       ORDER BY ${DB_COL_EXP} DESC
       LIMIT 1`,
            [String(telegramId)]
        );
        if (!rows.length) return { active: false, reason: 'not_found' };
        const expRaw = rows[0].exp;
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const expDate = new Date(expRaw); expDate.setUTCHours(0, 0, 0, 0);
        if (expDate.toString() === 'Invalid Date') return { active: false, reason: 'invalid_date', raw: { exp: expRaw } };
        const active = expDate >= today;
        return { active, reason: active ? 'ok' : 'expired', raw: { exp: expRaw } };
    } catch (e) {
        console.warn('⚠️ DB error, skipping gate:', e.message || e);
        return { skipGate: true, active: true, reason: 'db_error' };
    }
}

// ============ 8) User Profile & Conversation Memory (DB) ============
async function getUserProfile(telegramId) {
    const db = await getDb();
    if (!db) return { level: 'standard', language: 'ar', timezone: 'Asia/Riyadh', risk_percent: 1, daily_nudge: 1, weekly_report: 1, motivation: 'financial_freedom' };
    const [rows] = await db.execute(`SELECT * FROM user_profiles WHERE telegram_id=? LIMIT 1`, [String(telegramId)]);
    if (!rows.length) return { level: 'standard', language: 'ar', timezone: 'Asia/Riyadh', risk_percent: 1, daily_nudge: 1, weekly_report: 1, motivation: 'financial_freedom' };
    return rows[0];
}
async function upsertUserProfile(telegramId, partial) {
    const db = await getDb(); if (!db) return;
    const current = await getUserProfile(telegramId);
    const merged = { ...current, ...partial };
    await db.execute(`
    INSERT INTO user_profiles (telegram_id, level, language, timezone, risk_percent, instruments, goals, style_notes, daily_nudge, weekly_report, motivation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      level=VALUES(level), language=VALUES(language), timezone=VALUES(timezone),
      risk_percent=VALUES(risk_percent), instruments=VALUES(instruments), goals=VALUES(goals),
      style_notes=VALUES(style_notes), daily_nudge=VALUES(daily_nudge), weekly_report=VALUES(weekly_report), motivation=VALUES(motivation)
  `, [
        String(telegramId),
        merged.level || 'standard',
        merged.language || 'ar',
        merged.timezone || 'Asia/Riyadh',
        merged.risk_percent ?? 1,
        merged.instruments || null,
        merged.goals || null,
        merged.style_notes || null,
        merged.daily_nudge ?? 1,
        merged.weekly_report ?? 1,
        merged.motivation || 'financial_freedom'
    ]);
}
async function recordMessage(telegramId, role, content) {
    const db = await getDb(); if (!db) return;
    const c = String(content || '').slice(0, 4000);
    await db.execute(`INSERT INTO conv_messages (telegram_id, role, content) VALUES (?,?,?)`, [String(telegramId), role, c]);
}
async function getRecentConversation(telegramId, limit = 6) {
    const db = await getDb(); if (!db) return [];
    const [rows] = await db.execute(
        `SELECT role, content FROM conv_messages WHERE telegram_id=? ORDER BY ts DESC LIMIT ?`,
        [String(telegramId), limit]
    );
    return rows.reverse();
}
async function setMemory(telegramId, key, value) {
    const db = await getDb(); if (!db) return;
    await db.execute(`
    INSERT INTO user_memory (telegram_id, mkey, mvalue)
    VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE mvalue=VALUES(mvalue)
  `, [String(telegramId), String(key), String(value)]);
}
async function getMemory(telegramId, key) {
    const db = await getDb(); if (!db) return null;
    const [rows] = await db.execute(
        `SELECT mvalue FROM user_memory WHERE telegram_id=? AND mkey=? LIMIT 1`,
        [String(telegramId), String(key)]
    );
    return rows[0]?.mvalue || null;
}

// ============ 9) Helpers ============
function wantsSimpler(text) {
    const t = (text || '').toLowerCase();
    return /مبتدئ|ابسط|بسيط|ما فهمت|شرح اكثر|وضح اكثر|فهمني/.test(t);
}
function safeLog(obj) {
    try { fs.appendFileSync('./bot_logs.jsonl', JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'); } catch { }
}
function inferTopicFrom(text) {
    const t = (text || '').toLowerCase();
    if (/شموع|شمعات|candl|hammer|engulf|pin\s*bar/i.test(t)) return 'candles';
    if (/وقف|stop\s*loss|sl/i.test(t)) return 'stoploss';
    if (/اداره|مخاط|risk/i.test(t)) return 'risk';
    if (/دخول|خروج|entry|exit/i.test(t)) return 'entry_exit';
    if (/اتجاه|trend/i.test(t)) return 'trend';
    if (/دعم|مقاوم|sr|support|resist/i.test(t)) return 'sr';
    if (/ناسداك|nas|us100/i.test(t)) return 'nasdaq';
    if (/ذهب|xau|xauusd|gold/i.test(t)) return 'gold';
    if (/فوركس|eurusd|gbpusd|usd|jpy|aud|cad/i.test(t)) return 'forex';
    return 'general';
}

// دفتر صفقات مصغّر
function parseMiniTrade(text) {
    const m = text.match(/(ذهب|gold|xau|xauusd|ناسداك|nas|us100|فوركس|eurusd|gbpusd)/i);
    const tf = text.match(/\b(H\d+|M\d+)\b/i);
    const entry = text.match(/(?:دخول|entry)\s*([0-9\.]+)/i);
    const sl = text.match(/(?:sl|وقف)\s*([0-9\.]+)/i);
    const tp = text.match(/(?:tp|هدف)\s*([0-9\.]+)/i);
    return { instrument: m?.[1]?.toUpperCase() || null, tf: tf?.[1]?.toUpperCase() || null, entry: entry?.[1] || null, sl: sl?.[1] || null, tp: tp?.[1] || null };
}
async function maybeJournalTrade(telegramId, text) {
    if (!/سج[ل|ّل]\s*صفقه|سجل صفقة|سجل صفقة/i.test(text)) return false;
    const t = parseMiniTrade(text);
    const key = 'journal:' + new Date().toISOString().slice(0, 10);
    const cur = await getMemory(telegramId, key);
    const arr = cur ? JSON.parse(cur) : [];
    arr.push({ ts: Date.now(), ...t, raw: text });
    await setMemory(telegramId, key, JSON.stringify(arr));
    return true;
}

// Mistake counters
const MISTAKE_TAGS = ['overtrading', 'early_entry', 'late_exit', 'no_stop', 'move_sl', 'revenge', 'chasing', 'no_plan'];
async function bumpCounter(telegramId, tag) {
    const today = new Date();
    const ym = today.toISOString().slice(0, 7);
    const kMonth = `mistake:${tag}:${ym}`;
    const k7 = `mistake:${tag}:rolling7`;
    const prevMonth = parseInt(await getMemory(telegramId, kMonth) || '0', 10);
    const prev7raw = await getMemory(telegramId, k7);
    const arr = prev7raw ? JSON.parse(prev7raw) : [];
    const d = today.toISOString().slice(0, 10);
    arr.push({ d });
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 7);
    const kept = arr.filter(x => new Date(x.d) >= cutoff);
    await setMemory(telegramId, kMonth, String(prevMonth + 1));
    await setMemory(telegramId, k7, JSON.stringify(kept));
    return kept.length;
}
async function getRollingCount(telegramId, tag) {
    const raw = await getMemory(telegramId, `mistake:${tag}:rolling7`);
    if (!raw) return 0;
    const arr = JSON.parse(raw);
    const today = new Date();
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 7);
    return arr.filter(x => new Date(x.d) >= cutoff).length;
}

// ============ 10) Rate limit & timeout helpers ============
const rps = Math.max(1, parseInt(String(OPENAI_RPS || '1'), 10) || 1);
const limiter = new Bottleneck({
    minTime: Math.ceil(1000 / rps),
    maxConcurrent: 1
});

function timeoutRace(ms, task) {
    return Promise.race([
        task(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('LOCAL_TIMEOUT')), ms))
    ]);
}

// ============ 11) Multi-Provider Ask + Failover + Local KB fallback ============
async function askOpenAI(model, messages, maxTokens) {
 
    return await ai.chat.completions.create({
        model,
        messages,
        temperature: 0.5,
        max_tokens: Math.min(maxTokens || 500, OA_MAX_TOKENS)
    });
}

async function askAzure(messages, maxTokens) {
    const key = AZURE_OPENAI_KEY;
    const endpoint = AZURE_OPENAI_ENDPOINT;
    const deployment = AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini';
    if (!key || !endpoint) throw new Error('AZURE_MISSING');
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
    const resp = await timeoutRace(12_000, () => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': key },
        body: JSON.stringify({
            messages,
            temperature: 0.5,
            max_tokens: Math.min(maxTokens || 500, OA_MAX_TOKENS)
        })
    }));
    if (!resp.ok) throw new Error(`AZURE_HTTP_${resp.status}`);
    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || '';
    return { choices: [{ message: { content: text } }] };
}

async function askGroq(messages, maxTokens) {
    const key = GROQ_API_KEY;
    if (!key) throw new Error('GROQ_MISSING');
    const url = 'https://api.groq.com/openai/v1/chat/completions';
    const resp = await timeoutRace(12_000, () => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model: 'llama-3.1-70b-versatile',
            messages,
            temperature: 0.5,
            max_tokens: Math.min(maxTokens || 500, OA_MAX_TOKENS)
        })
    }));
    if (!resp.ok) throw new Error(`GROQ_HTTP_${resp.status}`);
    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || '';
    return { choices: [{ message: { content: text } }] };
}

async function tryOnce(fn, label) {
    try {

        return await limiter.schedule(() => timeoutRace(12_000, () => fn()));
    } catch (e) {
        console.warn(`fail@${label}:`, e && (e.message || e));
        throw e;
    }
}

async function askAnyLLM(messages, maxTokens) {
    const m1 = PRIMARY_MODEL;
    const m2 = FALLBACK_MODEL_1;
    const m3 = FALLBACK_MODEL_2;

    const chain = [
        () => tryOnce(() => askOpenAI(m1, messages, maxTokens), `openai:${m1}`),
        () => tryOnce(() => askOpenAI(m2, messages, maxTokens), `openai:${m2}`),
        () => tryOnce(() => askOpenAI(m3, messages, maxTokens), `openai:${m3}`),
        () => tryOnce(() => askAzure(messages, maxTokens), 'azure'),
        () => tryOnce(() => askGroq(messages, maxTokens), 'groq')
    ];

    for (const step of chain) {
        try {
            const r = await step();
            const text = r?.choices?.[0]?.message?.content?.trim();
            if (text) return text;
        } catch (_) { /* جرّب التالي */ }
    }
    throw new Error('ALL_PROVIDERS_FAILED');
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


async function classifyMistake(userText) {
    const prompt = `
نص المستخدم:
${userText}

اختر وسم خطأ واحد فقط إذا كان النص يلمّح له، أو اكتب none:
[overtrading, early_entry, late_exit, no_stop, move_sl, revenge, chasing, no_plan]
أجب بالوسم فقط.
`.trim();
    try {
        const text = await askAnyLLM([{ role: 'user', content: prompt }], 16);
        const tag = (text || '').trim().toLowerCase();
        return MISTAKE_TAGS.includes(tag) ? tag : 'none';
    } catch {
        return 'none';
    }
}

// ============ 12) Shortcuts (no-AI replies) ============
function isNewsRequest(t) {
    t = (t || '').toLowerCase();
    return /خبر|اخبار|الأخبار|الاخبار|news|calendar|تقويم|احداث|الأسبوع القادم|الأسبوع المقبل/.test(t);
}
function quickWeeklyNewsTemplate() {
    return [
        '✅ للتجهيز للأسبوع القادم، ركّز على:',
        '• قرارات/تصريحات البنوك المركزية (FOMC/ECB/BoE) والبيانات التضخمية (CPI, PCE).',
        '• بيانات التوظيف (NFP, Jobless Claims) والناتج المحلي (GDP).',
        '• مؤشرات مديري المشتريات (PMI/ISM) والميزان التجاري.',
        '• مخزونات النفط EIA (إن كنت تتداول النفط) ومحاضر الاجتماعات.',
        'نصيحة 6FE: خفّض الحجم نصف المعتاد قبل الأخبار بـ 15–30 دقيقة وبعدها حتى يستقر الاتجاه، والتزم مخاطرة 1–2%.'
    ].join('\n');
}
function isGettingStarted(t) {
    t = (t || '').toLowerCase();
    return /كيف.*ابدأ|كيف.*بلش|from where.*start|how.*start.*trading|ابدا.*تداول|بلش.*تداول/.test(t);
}
function quickStartTradingTemplate() {
    return [
        '✅ خطة بداية تداول بسيطة خلال 7 أيام:',
        'اليوم 1–2: تعلّم الأساسيات (أنواع الأوامر، الرافعة، الهامش).',
        'اليوم 3: اختر أداة واحدة فقط (ذهب H1 أو ناسداك M15).',
        'اليوم 4: صمّم قاعدة دخول/خروج + وقف ثابت (مخاطرة 1–2%).',
        'اليوم 5: نفّذ 10 صفقات تجريبية بنفس القاعدة.',
        'اليوم 6: راجع دفتر الصفقات (سبب الربح/الخسارة).',
        'اليوم 7: ثبّت قاعدة واحدة للأسبوع القادم وقلّل الضجيج.',
        'نصيحة 6FE: أرباح صغيرة + انضباط كبير = استمرارية.'
    ].join('\n');
}

// ============ 13) Answer Generation — (Semantic-first) ============
async function generateAnswer(userText, semanticRes, profile) {
    const level = profile?.level || 'standard';


    let ctxBlock = '';
    try {
        const tsRaw = await getMemory(profile?.telegram_id, 'last_ctx_ts');
        const ts = parseInt(tsRaw || '0', 10);
        const recent = ts && (Date.now() - ts) < 60 * 60 * 1000; // آخر ساعة
        if (recent) {
            const sum = await getMemory(profile?.telegram_id, 'last_ctx_summary');
            if (sum) {
                ctxBlock = `سياق من آخر تحليل شارت للمستخدم (استخدمه إذا كان السؤال إحالي مثل "هيك الحالة"): \n${sum}`;
            }
        }
    } catch { }

   
    const bestKB = semanticRes?.best;
    if (semanticRes?.useKB && bestKB?.answer) {
        return `✅ من معرفتنا (score: ${bestKB.score.toFixed(2)}):\n${bestKB.answer}`;
    }


    const topCtx = (semanticRes?.top || []).slice(0, 5).map(t => `• ${t.search_text}`).join('\n');

    const baseMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...(ctxBlock ? [{ role: 'system', content: ctxBlock }] : []),
        ...(topCtx ? [{ role: 'system', content: `سياق داخلي للاسترشاد (اختياري):\n${topCtx}` }] : []),
        { role: 'system', content: `مستوى المستخدم: ${level}, مخاطرة تقريبًا ~${profile?.risk_percent ?? 1}%${profile?.instruments ? `، أدوات: ${profile.instruments}` : ''}` },
        { role: 'user', content: userText }
    ];

    try {
        const text = await askAnyLLM(baseMessages, Math.min(450, OA_MAX_TOKENS));
        return text;
    } catch (e) {
        console.warn('LLM total failure, switching to local KB answer:', e && (e.message || e));

        return localKbAnswer(userText);
    }
}

// ============ 14) Per-user serialization ============
const userLocks = new Map();
function serializeUser(userId, task) {
    const key = String(userId || 'anon');
    const prev = userLocks.get(key) || Promise.resolve();
    const next = prev.then(task).catch((e) => {
        console.warn('serializeUser task error:', e && (e.message || e));
    }).finally(() => {
        if (userLocks.get(key) === next) userLocks.delete(key);
    });
    userLocks.set(key, next);
    return next;
}

// ============ 15) Telegram Commands & Handlers ============
bot.start(ctx => ctx.reply('أهلاً 👋 أنا 6FE Assistant. اسألني أي سؤال تعليمي عن التداول.\nللتبسيط الدائم: /beginner — وللوضع القياسي: /pro'));

bot.command('diag', async (ctx) => {
    try {
        const okKey = !!process.env.OPENAI_API_KEY;
        const okKb = Array.isArray(KB) && KB.length > 0;
        await ctx.reply(`Diag:
- KEY: ${okKey ? 'OK' : 'MISSING'}
- KB rows: ${okKb ? KB.length : 0}
- PRIMARY_MODEL: ${process.env.PRIMARY_MODEL || 'gpt-4o-mini'}
- Node: ${process.version}`);
    } catch { await ctx.reply('Diag error'); }
});

bot.command('whoami', (ctx) => {
    const u = ctx.from || {};
    ctx.reply(`from.id=${u.id}\nusername=@${u.username || '-'}\nname=${u.first_name || ''} ${u.last_name || ''}`.trim());
});

bot.command('gate', async (ctx) => {
    const uid = ctx.from?.id;
    const res = await isUserActive(uid);
    ctx.reply(`Gate:
uid=${uid}
active=${res.active}
reason=${res.reason}
raw=${JSON.stringify(res.raw || {})}`);
});

bot.command('beginner', async (ctx) => {
    await upsertUserProfile(ctx.from.id, { level: 'beginner' });
    ctx.reply('تمام ✔️ رح أبسّط الشرح بالمستوى المبتدئ دائماً.');
});

bot.command('pro', async (ctx) => {
    await upsertUserProfile(ctx.from.id, { level: 'standard' });
    ctx.reply('تمام ✔️ رجّعت الشرح للمستوى القياسي.');
});

bot.command('setrisk', async (ctx) => {
    const m = ctx.message.text || '';
    const n = parseInt(m.replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n >= 1 && n <= 5) {
        await upsertUserProfile(ctx.from.id, { risk_percent: n });
        ctx.reply(`تمام ✔️ رح أعتمد مخاطرة تقريبًا ~${n}% كمرجع.`);
    } else {
        ctx.reply('اكتب: /setrisk 1 أو 2 أو 3 (حد أقصى 5).');
    }
});

bot.command('setinst', async (ctx) => {
    const txt = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
    if (txt) {
        await upsertUserProfile(ctx.from.id, { instruments: txt });
        ctx.reply(`تمام ✔️ سجّلت الأدوات المفضلة: ${txt}`);
    } else {
        ctx.reply('اكتب: /setinst gold,nasdaq,forex (مثال)');
    }
});

bot.command('setgoals', async (ctx) => {
    const txt = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
    if (txt) {
        await upsertUserProfile(ctx.from.id, { goals: txt });
        ctx.reply('تمام ✔️ سجّلت أهدافك.');
    } else {
        ctx.reply('اكتب: /setgoals ثبات, التزام بالخطة, تحسين إدارة المخاطر');
    }
});

bot.command('profile', async (ctx) => {
    const p = await getUserProfile(ctx.from.id);
    ctx.reply([
        'ملفّك:',
        `- المستوى: ${p.level}`,
        `- مخاطرة مرجعية: ~${p.risk_percent}%`,
        `- أدوات: ${p.instruments || '-'}`,
        `- أهداف: ${p.goals || '-'}`,
        `- رسائل يومية: ${p.daily_nudge ? 'مفعلة' : 'مطفأة'}`,
        `- تقرير أسبوعي: ${p.weekly_report ? 'مفعّل' : 'مطفأ'}`
    ].join('\n'));
});

bot.command('remember', async (ctx) => {
    const parts = (ctx.message.text || '').split(' ').slice(1);
    const kv = parts.join(' ').split('=');
    if (kv.length < 2) return ctx.reply('استعمل: /remember المفتاح=القيمة\nمثال: /remember أسلوبي=أحب أمثلة رقمية');
    const key = kv[0].trim(); const value = kv.slice(1).join('=').trim();
    await setMemory(ctx.from.id, key, value);
    ctx.reply(`تمام ✔️ حفظت: ${key} = ${value}`);
});

bot.command('recall', async (ctx) => {
    const key = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
    if (!key) return ctx.reply('استعمل: /recall المفتاح');
    const val = await getMemory(ctx.from.id, key);
    ctx.reply(val ? `المحفوظ: ${key} = ${val}` : `ما في قيمة محفوظة للمفتاح: ${key}`);
});

// استقبال صور الشارت — مع تسلسل لكل مستخدم
bot.on('photo', (ctx) => serializeUser(ctx.from?.id, async () => {
    const uid = ctx.from.id;
    const photos = ctx.message.photo || [];
    const best = photos[photos.length - 1];
    let fileLink = null;
    try { fileLink = await ctx.telegram.getFileLink(best.file_id); }
    catch { return ctx.reply('وصلت الصورة 👌 اكتب لي الإطار الزمني والأداة (مثال: ذهب H1) لحتى أعلّق عمليًا.'); }

    const profile = await getUserProfile(uid);
    profile.telegram_id = uid;

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'system', content: `مستوى المستخدم: ${profile.level}, مخاطرة تقريبًا ~${profile.risk_percent}%` },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'حلّل هذا الشارت بنقاط عملية عند اللزوم، بدون تنسيق غامق.' },
                { type: 'image_url', image_url: { url: String(fileLink) } }
            ]
        }
    ];

    try {
        // محاولة واحدة عبر سلسلة السقوط
        const text = await askAnyLLM(messages, OA_MAX_TOKENS);
        await ctx.reply(text);

        // خزّن سياق آخر تحليل شارت (لاستخدامه لاحقًا إذا سأل المستخدم "هيك الحالة")
        await setMemory(uid, 'last_ctx_summary', text.slice(0, 1200));
        await setMemory(uid, 'last_ctx_ts', String(Date.now()));

        // Thread memory + أرشفة (لا تكسر الرد لو فشلت)
        try {
            await threadMemory.append(uid, 'user', '[صورة شارت]');
            await threadMemory.append(uid, 'assistant', text);
            await threadMemory.maybeSummarize(uid);
        } catch (e) { console.warn('threadMemory warn:', e.message || e); }
        try {
            await recordMessage(uid, 'user', '[صورة شارت]');
            await recordMessage(uid, 'assistant', text);
        } catch (e) { console.warn('recordMessage warn:', e.message || e); }

    } catch (e) {
        console.error('Vision failure total:', e && (e.message || e));
        // جواب محلي بسيط
        await ctx.reply('نصيحة سريعة: حدد الاتجاه على الإطار الأكبر، وانتظر نموذجًا واضحًا مع تأكيد حجم/زخم، ولا تتجاوز مخاطرة 1–2%.');
        return;
    }
}));


bot.on('text', (ctx) => serializeUser(ctx.from?.id, async () => {
    let userText = ctx.message.text || '';
    const uid = ctx.from?.id;

    try {
        // (A) Access Gate
        const gate = await isUserActive(uid);
        if (!gate?.skipGate && !gate.active) {
            const msg = (gate.reason === 'expired')
                ? 'يبدو أنّ اشتراكك غير فعّال حاليًا (منتهي). تواصل مع فريق الدعم للمساعدة.'
                : 'تعذّر التحقّق من اشتراكك. تواصل مع فريق الدعم للمساعدة.';
            await ctx.reply(msg);
            safeLog({ uid, query: userText, access: 'denied', reason: gate.reason });
            return;
        }

        // (B) Profile
        if (wantsSimpler(userText)) await upsertUserProfile(uid, { level: 'beginner' });
        const profile = await getUserProfile(uid);
        profile.telegram_id = uid;


        if (isNewsRequest(userText)) {
            const quick = quickWeeklyNewsTemplate();
            await ctx.reply(quick);
            try { await recordMessage(uid, 'assistant', quick); } catch { }
            return;
        }
        if (isGettingStarted(userText)) {
            const quick = quickStartTradingTemplate();
            await ctx.reply(quick);
            try { await recordMessage(uid, 'assistant', quick); } catch { }
            return;
        }


        let detectedTopic = inferTopicFrom(userText);
        const justExample = /^(\s*عطيني مثال\s*|^\s*اعطني مثال\s*|^\s*مثال\s*)$/i.test(userText);
        if (justExample) {
            const lastTopic = await getMemory(uid, 'last_topic');
            if (lastTopic) {
                detectedTopic = lastTopic;
                userText = `أعطني مثالًا عمليًا على الموضوع السابق: ${lastTopic}`;
            }
        }


        const key = (userText || '').trim().toLowerCase();
        const now = Date.now();
        const last = recentPrompts.get(uid);
        if (last && last.key === key && (now - last.ts) < 8000) {
            return ctx.reply('استلمت سؤالك—شغال عليه 👌');
        }
        recentPrompts.set(uid, { key, ts: now });

        const cached = answerCache.get(key);
        if (cached) {
            await ctx.reply(cached);
            try { await recordMessage(uid, 'assistant', cached); } catch { }
            return;
        }


        await maybeJournalTrade(uid, userText);


        const sres = await semanticSearch(userText, { topK: 5, threshold: 0.35 });


        let prefix = '';
        try {
            const tag = await classifyMistake(userText);
            if (tag !== 'none') {
                const count7 = await bumpCounter(uid, tag);
                if (count7 >= 3) {
                    const map = { overtrading: 'كثرة الصفقات', early_entry: 'دخول مبكّر', late_exit: 'خروج متأخر', no_stop: 'بدون وقف', move_sl: 'تحريك الوقف', revenge: 'انتقام', chasing: 'مطاردة', no_plan: 'بلا خطة' };
                    prefix = `تنبيه 👀: تكرر "${map[tag] || tag}" هذا الأسبوع. جرّب قاعدة واحدة اليوم ثم قيّم نتيجتها.\n\n`;
                }
            }
        } catch (e) {
            console.warn('classifier warn:', e.message || e);
        }


        const answer = await generateAnswer(userText, sres, profile);


        const finalMsg = prefix + answer;
        await ctx.reply(finalMsg);
        answerCache.set(key, finalMsg);


        try {
            await threadMemory.append(uid, 'user', userText);
            await threadMemory.append(uid, 'assistant', finalMsg);
            await threadMemory.maybeSummarize(uid);
        } catch (e) { console.warn('threadMemory warn:', e.message || e); }
        try {
            await recordMessage(uid, 'user', userText);
            await recordMessage(uid, 'assistant', finalMsg);
        } catch (e) { console.warn('recordMessage warn:', e.message || e); }

        await setMemory(uid, 'last_topic', detectedTopic || 'general');


        const topLite = (sres?.top || []).map(t => ({ id: t.id, s: Number(t.score?.toFixed(3) || 0) }));
        safeLog({ uid, query: userText, sem_top: topLite, useKB: !!sres?.useKB, best: sres?.best?.score });

    } catch (e) {
        console.error(e);

        await ctx.reply('جواب سريع: ركّز على قاعدة واحدة اليوم، مخاطرة 1–2%، وانتظر تأكيد واضح قبل الدخول. لو أردت تفصيلًا، أعد صياغة سؤالك بجملة واحدة واضحة.');
        safeLog({ uid, query: (ctx && ctx.message && ctx.message.text) || '', error: String(e) });
    }
}));

// ============ 16) Boot ============


(async () => {
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
        console.log('ℹ️ Webhook deleted (switching to long polling).');
    } catch (e) {
        console.warn('Webhook delete warn:', e.message || e);
    }
})();

console.log('ENV check:',
    'BOT_TOKEN?', !!process.env.BOT_TOKEN,
    'OPENAI_API_KEY?', !!process.env.OPENAI_API_KEY,
    'PRIMARY_MODEL=', process.env.PRIMARY_MODEL || '(default)'
);


// === [Semantic Search - boot] ===

(async () => {
  try {
    await loadIndex();
    console.log('✅ Semantic index loaded');
  } catch (e) {
    console.error('❌ Semantic index failed to load:', e);
  }
})();



bot.launch({ dropPendingUpdates: true });

console.log('✅ 6FE educational bot running — Guaranteed Reply (Failover + Local KB).');


process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


initDbSchema().catch(e => console.warn('Schema init warn:', e.message));
