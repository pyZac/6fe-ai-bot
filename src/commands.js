// commands.js - Telegram Bot Commands
const { getUserProfile, upsertUserProfile, getMemory, setMemory } = require('./database');
const config = require('./config');

/**
 * Register all bot commands
 */
function registerCommands(bot, threadMemory) {
    // Start command
    bot.start((ctx) => {
        ctx.reply(
            'أهلاً 👋 أنا 6FE Assistant. اسألني أي سؤال تعليمي عن التداول.\n\n' +
            'للتبسيط الدائم: /beginner — وللوضع القياسي: /pro\n\n' +
            'للمساعدة: /help'
        );
    });

    // Help command
    bot.command('help', (ctx) => {
        ctx.reply(`🤖 أوامر البوت 6FE

📚 الأساسيات:
/start - بداية التعامل مع البوت
/help - عرض هذه القائمة

⚙️ الإعدادات:
/beginner - وضع المبتدئ (شرح مبسط)
/pro - وضع قياسي (شرح عادي)
/setrisk [1-5] - تحديد نسبة المخاطرة
/setinst [أدوات] - أدواتك المفضلة
/profile - عرض ملفك الشخصي

📊 التحليل:
أرسل صورة شارت - تحليل فني
/mystats - إحصائياتك
/search [كلمة] - بحث في سجل محادثاتك

🗑️ إدارة البيانات:
/clearmemory - مسح سجل المحادثات

💡 نصيحة: اسألني أي سؤال مباشرة بدون أوامر!`);
    });

    // Diagnostic command
    bot.command('diag', async (ctx) => {
        try {
            const okKey = !!config.OPENAI_API_KEY;
            await ctx.reply(`Diag:
- KEY: ${okKey ? 'OK' : 'MISSING'}
- PRIMARY_MODEL: ${config.PRIMARY_MODEL}
- Node: ${process.version}`);
        } catch {
            await ctx.reply('Diag error');
        }
    });

    // Who am I command
    bot.command('whoami', (ctx) => {
        const u = ctx.from || {};
        ctx.reply(
            `from.id=${u.id}\n` +
            `username=@${u.username || '-'}\n` +
            `name=${u.first_name || ''} ${u.last_name || ''}`.trim()
        );
    });

    // Beginner mode
    bot.command('beginner', async (ctx) => {
        await upsertUserProfile(ctx.from.id, { level: 'beginner' });
        ctx.reply('تماماً ✔️ رح أبسّط الشرح بالمستوى المبتدئ دائماً.');
    });

    // Pro mode
    bot.command('pro', async (ctx) => {
        await upsertUserProfile(ctx.from.id, { level: 'standard' });
        ctx.reply('تماماً ✔️ رجّعت الشرح للمستوى القياسي.');
    });

    // Set risk percentage
    bot.command('setrisk', async (ctx) => {
        const m = ctx.message.text || '';
        const n = parseInt(m.replace(/[^0-9]/g, ''), 10);
        
        if (!isNaN(n) && n >= 1 && n <= 5) {
            await upsertUserProfile(ctx.from.id, { risk_percent: n });
            ctx.reply(`تماماً ✔️ رح أعتمد مخاطرة تقريبًا ~${n}% كمرجع.`);
        } else {
            ctx.reply('اكتب: /setrisk 1 أو 2 أو 3 (حد أقصى 5).');
        }
    });

    // Set instruments
    bot.command('setinst', async (ctx) => {
        const txt = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
        
        if (txt) {
            await upsertUserProfile(ctx.from.id, { instruments: txt });
            ctx.reply(`تماماً ✔️ سجّلت الأدوات المفضلة: ${txt}`);
        } else {
            ctx.reply('اكتب: /setinst gold,nasdaq,forex (مثال)');
        }
    });

    // Set goals
    bot.command('setgoals', async (ctx) => {
        const txt = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
        
        if (txt) {
            await upsertUserProfile(ctx.from.id, { goals: txt });
            ctx.reply('تماماً ✔️ سجّلت أهدافك.');
        } else {
            ctx.reply('اكتب: /setgoals ثبات, التزام بالخطة, تحسين إدارة المخاطر');
        }
    });

    // View profile
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

    // Remember command
    bot.command('remember', async (ctx) => {
        const parts = (ctx.message.text || '').split(' ').slice(1);
        const kv = parts.join(' ').split('=');
        
        if (kv.length < 2) {
            return ctx.reply(
                'استعمل: /remember المفتاح=القيمة\n' +
                'مثال: /remember أسلوبي=أحب أمثلة رقمية'
            );
        }
        
        const key = kv[0].trim();
        const value = kv.slice(1).join('=').trim();
        
        await setMemory(ctx.from.id, key, value);
        ctx.reply(`تماماً ✔️ حفظت: ${key} = ${value}`);
    });

    // Recall command
    bot.command('recall', async (ctx) => {
        const key = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
        
        if (!key) {
            return ctx.reply('استعمل: /recall المفتاح');
        }
        
        const val = await getMemory(ctx.from.id, key);
        ctx.reply(val ? `المحفوظ: ${key} = ${val}` : `ما في قيمة محفوظة للمفتاح: ${key}`);
    });

    // User statistics
    bot.command('mystats', async (ctx) => {
        try {
            const uid = ctx.from?.id;
            const stats = await threadMemory.getStats(uid);
            
            if (!stats) {
                return ctx.reply('لا توجد إحصائيات متاحة حالياً');
            }
            
            const days = Math.ceil(
                (Date.now() - new Date(stats.first_interaction)) / (1000 * 60 * 60 * 24)
            );
            const avgPerDay = (stats.total / Math.max(days, 1)).toFixed(1);
            
            ctx.reply(`📊 إحصائياتك مع البوت 6FE

💬 إجمالي الرسائل: ${stats.total}
   • رسائلك: ${stats.user_messages}
   • ردود البوت: ${stats.bot_messages}

📅 مدة التفاعل: ${days} يوم
⚡ معدل يومي: ${avgPerDay} رسالة

🎯 أول تفاعل: ${new Date(stats.first_interaction).toLocaleDateString('ar-SA')}
🕐 آخر تفاعل: ${new Date(stats.last_interaction).toLocaleDateString('ar-SA')}

استمر بالتعلم والتطبيق! 💪`);
        } catch (e) {
            console.error('mystats error:', e);
            ctx.reply('حدث خطأ في جلب الإحصائيات');
        }
    });

    // Clear memory
    bot.command('clearmemory', async (ctx) => {
        try {
            await threadMemory.clearHistory(ctx.from?.id);
            ctx.reply('✅ تم مسح السجل والذاكرة بالكامل.\n\nنبدأ من جديد! اسألني أي سؤال.');
        } catch (e) {
            console.error('clearmemory error:', e);
            ctx.reply('حدث خطأ في مسح الذاكرة');
        }
    });

    // Search history
    bot.command('search', async (ctx) => {
        try {
            const uid = ctx.from?.id;
            const searchTerm = (ctx.message.text || '').split(' ').slice(1).join(' ').trim();
            
            if (!searchTerm) {
                return ctx.reply(
                    'استعمال: /search [كلمة البحث]\n\n' +
                    'مثال: /search وقف الخسارة'
                );
            }
            
            const results = await threadMemory.searchHistory(uid, searchTerm, 5);
            
            if (!results.length) {
                return ctx.reply(`❌ لم أجد أي نتائج عن "${searchTerm}"\n\nجرّب كلمة أخرى`);
            }
            
            const formatted = results.map((r, i) => {
                const date = new Date(r.ts).toLocaleDateString('ar-SA');
                const icon = r.role === 'user' ? '👤' : '🤖';
                const preview = r.content.slice(0, 80) + (r.content.length > 80 ? '...' : '');
                return `${i + 1}. ${icon} ${date}\n   ${preview}`;
            }).join('\n\n');
            
            ctx.reply(`🔍 نتائج البحث عن "${searchTerm}"\n\n${formatted}`);
        } catch (e) {
            console.error('search error:', e);
            ctx.reply('حدث خطأ في البحث');
        }
    });

    // Admin analytics
    bot.command('analytics', async (ctx) => {
        try {
            const adminIds = config.ADMIN_IDS;
            
            if (!adminIds.includes(String(ctx.from?.id))) {
                return ctx.reply('⛔ هذا الأمر للمشرفين فقط');
            }
            
            const analytics = await threadMemory.getGlobalAnalytics();
            
            if (!analytics) {
                return ctx.reply('لا توجد بيانات متاحة');
            }
            
            const topTopics = analytics.popular_topics
                .slice(0, 5)
                .map((t, i) => `${i + 1}. ${t.topic || 'عام'}: ${t.count} مرة`)
                .join('\n');
            
            ctx.reply(`📊 تحليلات البوت الشاملة

👥 إجمالي المستخدمين: ${analytics.total_users}
💬 إجمالي الرسائل: ${analytics.total_messages}
📈 متوسط رسائل/مستخدم: ${analytics.avg_messages_per_user}
🔥 نشطين (آخر 7 أيام): ${analytics.active_users_last_7_days}

📌 أكثر المواضيع طلباً:
${topTopics}

💡 استخدم هذه البيانات لتحسين المحتوى!`);
        } catch (e) {
            console.error('analytics error:', e);
            ctx.reply('حدث خطأ في جلب التحليلات');
        }
    });
}

module.exports = { registerCommands };
