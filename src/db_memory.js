// db_memory.js — Enhanced DB-based conversation memory (replaces Redis)
// Features:
// - Full conversation logging for analytics
// - Smart context retrieval
// - Automatic summarization
// - Lightweight and reliable

function createDbMemory({ 
    getDb, 
    ai, 
    model = 'gpt-4o-mini',
    maxTurns = 12,           // Keep last 12 turns in active context
    summarizeEveryN = 20,    // Summarize every 20 messages
    contextWindow = 6        // Use last 6 messages for context
}) {

    // ============ Core Functions ============
    
    /**
     * Append a message to conversation history
     * @param {string} uid - User telegram ID
     * @param {string} role - 'user' or 'assistant'
     * @param {string} content - Message content
     * @param {object} metadata - Optional metadata (question_type, semantic_score, etc.)
     */
    async function append(uid, role, content, metadata = {}) {
        const db = await getDb();
        if (!db) return;

        const c = String(content || '').slice(0, 4000);
        
        try {
            // Insert message with metadata
            await db.execute(
                `INSERT INTO conv_messages (telegram_id, role, content, metadata) 
                 VALUES (?, ?, ?, ?)`,
                [String(uid), role, c, JSON.stringify(metadata)]
            );

            // Update message counter
            await db.execute(
                `INSERT INTO user_memory (telegram_id, mkey, mvalue)
                 VALUES (?, 'msg_count', '1')
                 ON DUPLICATE KEY UPDATE mvalue = CAST(mvalue AS UNSIGNED) + 1`,
                [String(uid)]
            );
        } catch (e) {
            console.warn('append message warn:', e.message || e);
        }
    }

    /**
     * Get recent conversation history
     * @param {string} uid - User telegram ID
     * @param {number} limit - Number of messages to retrieve
     * @returns {Array} Array of {role, content, ts, metadata} objects
     */
    async function getHistory(uid, limit = maxTurns) {
        const db = await getDb();
        if (!db) return [];

        try {
            const [rows] = await db.execute(
                `SELECT role, content, ts, metadata 
                 FROM conv_messages 
                 WHERE telegram_id = ? 
                 ORDER BY ts DESC 
                 LIMIT ?`,
                [String(uid), limit]
            );

            return rows.reverse().map(r => ({
                role: r.role,
                content: r.content,
                ts: r.ts,
                metadata: r.metadata ? JSON.parse(r.metadata) : {}
            }));
        } catch (e) {
            console.warn('getHistory warn:', e.message || e);
            return [];
        }
    }

    /**
     * Get conversation summary
     * @param {string} uid - User telegram ID
     * @returns {string} Summary text or empty string
     */
    async function getSummary(uid) {
        const db = await getDb();
        if (!db) return '';

        try {
            const [rows] = await db.execute(
                `SELECT mvalue FROM user_memory 
                 WHERE telegram_id = ? AND mkey = 'conv_summary' 
                 LIMIT 1`,
                [String(uid)]
            );
            return rows[0]?.mvalue || '';
        } catch {
            return '';
        }
    }

    /**
     * Set conversation summary
     * @param {string} uid - User telegram ID
     * @param {string} text - Summary text
     */
    async function setSummary(uid, text) {
        const db = await getDb();
        if (!db) return;

        try {
            await db.execute(
                `INSERT INTO user_memory (telegram_id, mkey, mvalue)
                 VALUES (?, 'conv_summary', ?)
                 ON DUPLICATE KEY UPDATE mvalue = VALUES(mvalue)`,
                [String(uid), String(text || '')]
            );
        } catch (e) {
            console.warn('setSummary warn:', e.message || e);
        }
    }

    /**
     * Get total message count for user
     * @param {string} uid - User telegram ID
     * @returns {number} Total messages sent by user
     */
    async function getCount(uid) {
        const db = await getDb();
        if (!db) return 0;

        try {
            const [rows] = await db.execute(
                `SELECT mvalue FROM user_memory 
                 WHERE telegram_id = ? AND mkey = 'msg_count' 
                 LIMIT 1`,
                [String(uid)]
            );
            return parseInt(rows[0]?.mvalue || '0', 10);
        } catch {
            return 0;
        }
    }

    /**
     * Maybe trigger summarization if threshold reached
     * @param {string} uid - User telegram ID
     */
    async function maybeSummarize(uid) {
        try {
            const total = await getCount(uid);
            
            // Only summarize at intervals
            if (!total || total % summarizeEveryN !== 0) return;

            // Get extended history for summarization
            const history = await getHistory(uid, summarizeEveryN * 2);
            if (!history.length) return;

            // Build conversation text
            const lines = history.map(h => {
                const icon = h.role === 'user' ? '👤' : '🤖';
                return `${icon} ${h.content}`;
            }).join('\n');

            const prompt = `لخّص المحادثة التالية بين المستخدم والمدرّب بحيث نحتفظ بسياق المفاهيم والأسئلة المفتوحة وقرارات التداول السابقة بدون تفاصيل زائدة.

ركّز على:
- المواضيع الرئيسية المطروحة
- الأخطاء المتكررة إن وجدت
- الأدوات المفضلة (ذهب، ناسداك، فوركس)
- الأسئلة المفتوحة التي تحتاج متابعة

أعد ملخّصًا موجزًا بالعربية (3-5 نقاط):

${lines}`;

            const resp = await ai.chat.completions.create({
                model,
                temperature: 0.2,
                max_tokens: 400,
                messages: [{ role: 'user', content: prompt }]
            });

            const summary = (resp.choices[0].message.content || '').trim();
            if (summary) {
                await setSummary(uid, summary);
                console.log(`✅ Summarized conversation for user ${uid}`);
            }
        } catch (e) {
            console.warn('maybeSummarize warn:', e.message || e);
        }
    }

    /**
     * Build complete message array for LLM
     * @param {object} params
     * @param {string} params.uid - User telegram ID
     * @param {string} params.systemPrompt - System prompt
     * @param {string} params.currentUserText - Current user message
     * @param {object} params.profile - User profile object
     * @returns {Array} Array of message objects for LLM
     */
    async function buildMessages({ uid, systemPrompt, currentUserText, profile = {} }) {
        const msgs = [{ role: 'system', content: systemPrompt }];

        // Add conversation summary if exists
        const summary = await getSummary(uid);
        if (summary) {
            msgs.push({ 
                role: 'system', 
                content: `ملخص سياق سابق للمحادثة:\n${summary}` 
            });
        }

        // Add recent conversation history
        const hist = await getHistory(uid, contextWindow);
        for (const h of hist) {
            msgs.push({ role: h.role, content: h.content });
        }

        // Add user profile context if available
        if (profile && Object.keys(profile).length > 0) {
            const contextParts = [];
            if (profile.level) contextParts.push(`المستوى: ${profile.level}`);
            if (profile.risk_percent) contextParts.push(`مخاطرة ~${profile.risk_percent}%`);
            if (profile.instruments) contextParts.push(`الأدوات: ${profile.instruments}`);
            if (profile.goals) contextParts.push(`الأهداف: ${profile.goals}`);
            
            if (contextParts.length > 0) {
                msgs.push({ 
                    role: 'system', 
                    content: `معلومات المستخدم: ${contextParts.join(' • ')}` 
                });
            }
        }

        // Add current user message
        msgs.push({ role: 'user', content: currentUserText });

        return msgs;
    }

    /**
     * Get conversation statistics for analytics
     * @param {string} uid - User telegram ID
     * @returns {object} Statistics object
     */
    async function getStats(uid) {
        const db = await getDb();
        if (!db) return null;

        try {
            // Get total messages
            const [countRows] = await db.execute(
                `SELECT COUNT(*) as total, 
                        SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_msgs,
                        SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) as bot_msgs,
                        MIN(ts) as first_msg,
                        MAX(ts) as last_msg
                 FROM conv_messages 
                 WHERE telegram_id = ?`,
                [String(uid)]
            );

            // Get message frequency (messages per day)
            const [freqRows] = await db.execute(
                `SELECT DATE(ts) as day, COUNT(*) as count
                 FROM conv_messages 
                 WHERE telegram_id = ? AND ts >= DATE_SUB(NOW(), INTERVAL 30 DAY)
                 GROUP BY DATE(ts)
                 ORDER BY day DESC`,
                [String(uid)]
            );

            return {
                total: countRows[0]?.total || 0,
                user_messages: countRows[0]?.user_msgs || 0,
                bot_messages: countRows[0]?.bot_msgs || 0,
                first_interaction: countRows[0]?.first_msg,
                last_interaction: countRows[0]?.last_msg,
                daily_frequency: freqRows
            };
        } catch (e) {
            console.warn('getStats warn:', e.message || e);
            return null;
        }
    }

    /**
     * Search conversation history
     * @param {string} uid - User telegram ID
     * @param {string} searchTerm - Term to search for
     * @param {number} limit - Max results
     * @returns {Array} Matching messages
     */
    async function searchHistory(uid, searchTerm, limit = 10) {
        const db = await getDb();
        if (!db) return [];

        try {
            const [rows] = await db.execute(
                `SELECT role, content, ts 
                 FROM conv_messages 
                 WHERE telegram_id = ? AND content LIKE ?
                 ORDER BY ts DESC 
                 LIMIT ?`,
                [String(uid), `%${searchTerm}%`, limit]
            );

            return rows;
        } catch (e) {
            console.warn('searchHistory warn:', e.message || e);
            return [];
        }
    }

    /**
     * Clear conversation history (for privacy/reset)
     * @param {string} uid - User telegram ID
     */
    async function clearHistory(uid) {
        const db = await getDb();
        if (!db) return;

        try {
            await db.execute(
                `DELETE FROM conv_messages WHERE telegram_id = ?`,
                [String(uid)]
            );
            await db.execute(
                `DELETE FROM user_memory WHERE telegram_id = ? AND mkey IN ('conv_summary', 'msg_count')`,
                [String(uid)]
            );
            console.log(`✅ Cleared history for user ${uid}`);
        } catch (e) {
            console.warn('clearHistory warn:', e.message || e);
        }
    }

    /**
     * Get analytics data for all users
     * @returns {object} Aggregated analytics
     */
    async function getGlobalAnalytics() {
        const db = await getDb();
        if (!db) return null;

        try {
            // Total conversations
            const [totals] = await db.execute(
                `SELECT 
                    COUNT(DISTINCT telegram_id) as total_users,
                    COUNT(*) as total_messages,
                    AVG(msg_per_user.msg_count) as avg_msgs_per_user
                 FROM conv_messages
                 LEFT JOIN (
                     SELECT telegram_id, COUNT(*) as msg_count 
                     FROM conv_messages 
                     GROUP BY telegram_id
                 ) as msg_per_user ON conv_messages.telegram_id = msg_per_user.telegram_id`
            );

            // Active users (last 7 days)
            const [active] = await db.execute(
                `SELECT COUNT(DISTINCT telegram_id) as active_users_7d
                 FROM conv_messages 
                 WHERE ts >= DATE_SUB(NOW(), INTERVAL 7 DAY)`
            );

            // Most common topics (from metadata)
            const [topics] = await db.execute(
                `SELECT 
                    JSON_EXTRACT(metadata, '$.question_type') as topic,
                    COUNT(*) as count
                 FROM conv_messages 
                 WHERE metadata IS NOT NULL AND role = 'user'
                 GROUP BY topic
                 ORDER BY count DESC
                 LIMIT 10`
            );

            return {
                total_users: totals[0]?.total_users || 0,
                total_messages: totals[0]?.total_messages || 0,
                avg_messages_per_user: parseFloat(totals[0]?.avg_msgs_per_user || 0).toFixed(2),
                active_users_last_7_days: active[0]?.active_users_7d || 0,
                popular_topics: topics
            };
        } catch (e) {
            console.warn('getGlobalAnalytics warn:', e.message || e);
            return null;
        }
    }

    // Return public API
    return {
        append,
        getHistory,
        getSummary,
        setSummary,
        getCount,
        maybeSummarize,
        buildMessages,
        getStats,
        searchHistory,
        clearHistory,
        getGlobalAnalytics
    };
}

module.exports = { createDbMemory };
