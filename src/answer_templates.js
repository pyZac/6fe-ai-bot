// answer_templates.js - Answer formatting templates

function formatDefinitionAnswer({ term, termEn, definition, howItWorks, example, rule, nextStep }) {
    return `💡 ${term}${termEn ? ' ' + termEn : ''}

التعريف:
${definition}

📌 كيف يعمل؟
${howItWorks.map(point => `➜ ${point}`).join('\n')}

💰 مثال عملي:
${example}

⚡️ قاعدة 6FE:
${rule}

🎯 الخطوة التالية:
${nextStep}`;
}

function formatHowToAnswer({ title, steps, example, mistakes, tip }) {
    return `🔧 ${title}

✅ الخطوات العملية:

${steps.map((step, i) => `${i + 1}️⃣ ${step.name}
   ➜ ${step.action}
   ➜ ${step.why}`).join('\n\n')}

💰 مثال تطبيقي:
${example}

⚠️ أخطاء شائعة:
${mistakes.map(m => `❌ ${m}`).join('\n')}

⚡️ نصيحة 6FE:
${tip}`;
}

function formatComparisonAnswer({ title, conceptA, conceptB, recommendation }) {
    return `⚖️ ${title}

🔵 ${conceptA.name}:
${conceptA.features.map(f => `• ${f}`).join('\n')}
- متى تستخدمه: ${conceptA.useCase}

🟢 ${conceptB.name}:
${conceptB.features.map(f => `• ${f}`).join('\n')}
- متى تستخدمه: ${conceptB.useCase}

⚡️ توصية 6FE:
${recommendation}`;
}

function formatAnalysisAnswer({ asset, current, scenarios, rule, warnings }) {
    return `🔍 تحليل ${asset}

📊 الوضع الحالي:
➜ الاتجاه: ${current.trend}
➜ المستوى: ${current.level}
➜ الزخم: ${current.momentum}

📌 السيناريوهات:

${scenarios.map(s => `${s.icon} ${s.name} (احتمال ${s.probability}%):
- شرط التفعيل: ${s.trigger}
- دخول: ${s.entry} | وقف: ${s.sl} | هدف: ${s.tp}`).join('\n\n')}

⚡️ قاعدة 6FE:
${rule}

${warnings ? `⚠️ تحذيرات:\n${warnings.map(w => `• ${w}`).join('\n')}` : ''}`;
}

module.exports = {
    formatDefinitionAnswer,
    formatHowToAnswer,
    formatComparisonAnswer,
    formatAnalysisAnswer
};