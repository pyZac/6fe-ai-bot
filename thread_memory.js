// thread_memory.js — Per-user conversational memory over Redis with smart summarization (graceful when Redis is down)
const Redis = require('ioredis');

function createThreadMemory({ url, appPrefix = '6fe', maxTurns = 24, summarizeEveryN = 18, ai, model }) {
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    const k = (uid) => ({
        list: `${appPrefix}:chat:${uid}:events`,
        summary: `${appPrefix}:chat:${uid}:summary`,
        counter: `${appPrefix}:chat:${uid}:count`
    });

    async function ensure() {
        try {
            if (r.status !== 'ready' && r.status !== 'connecting') {
                await r.connect();
            }
        } catch (e) {
            throw new Error('REDIS_UNAVAILABLE');
        }
    }

    async function append(uid, role, content) {
        try { await ensure(); } catch { return; }
        const now = Date.now();
        const msg = JSON.stringify({ role, content: String(content || '').slice(0, 4000), ts: now });
        const keys = k(uid);
        try {
            await r.multi()
                .lpush(keys.list, msg)
                .ltrim(keys.list, 0, maxTurns * 2 - 1)
                .incr(keys.counter)
                .exec();
        } catch { /* ignore */ }
    }

    async function getHistory(uid, limit = maxTurns * 2) {
        try { await ensure(); } catch { return []; }
        const keys = k(uid);
        try {
            const arr = await r.lrange(keys.list, 0, limit - 1);
            return arr.reverse().map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
        } catch { return []; }
    }

    async function getSummary(uid) {
        try { await ensure(); } catch { return ''; }
        const keys = k(uid);
        try { return (await r.get(keys.summary)) || ''; } catch { return ''; }
    }

    async function setSummary(uid, text) {
        try { await ensure(); } catch { return; }
        const keys = k(uid);
        try { await r.set(keys.summary, String(text || '')); } catch { /* ignore */ }
    }

    async function getCount(uid) {
        try { await ensure(); } catch { return 0; }
        const keys = k(uid);
        try {
            const v = await r.get(keys.counter);
            return parseInt(v || '0', 10);
        } catch { return 0; }
    }

    async function maybeSummarize(uid) {
        let total;
        try { total = await getCount(uid); } catch { return; }
        if (!total || total % summarizeEveryN !== 0) return;

        const history = await getHistory(uid, maxTurns * 4);
        if (!history.length) return;

        const lines = history.map(h => `${h.role === 'user' ? '👤' : '🤖'} ${h.content}`).join('\n');
        const prompt = `لخّص المحادثة التالية بين المستخدم والمدرّب بحيث نحتفظ بسياق المفاهيم والأسئلة المفتوحة وقرارات التداول السابقة بدون تفاصيل زائدة. أعد ملخّصًا موجزًا بالعربية، نقاط قصيرة فقط:\n\n${lines}`;

        try {
            const resp = await ai.chat.completions.create({
                model,
                temperature: 0.2,
                max_tokens: 350,
                messages: [{ role: 'user', content: prompt }]
            });
            const summary = (resp.choices[0].message.content || '').trim();
            if (summary) await setSummary(uid, summary);
        } catch { /* ignore */ }
    }

    async function buildMessages({ uid, systemPrompt, currentUserText }) {
        const msgs = [{ role: 'system', content: systemPrompt }];
        const summary = await getSummary(uid);
        if (summary) msgs.push({ role: 'system', content: `ملخص سياق سابق للمحادثة:\n${summary}` });
        const hist = await getHistory(uid);
        for (const h of hist) msgs.push({ role: h.role, content: h.content });
        msgs.push({ role: 'user', content: currentUserText });
        return msgs;
    }

    return { append, getHistory, getSummary, setSummary, getCount, maybeSummarize, buildMessages };
}

module.exports = { createThreadMemory };
