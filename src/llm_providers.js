// llm_providers.js - Multi-Provider LLM with Failover
const config = require('./config');
const Bottleneck = require('bottleneck');

// Rate limiter
const rps = Math.max(1, config.OPENAI_RPS);
const limiter = new Bottleneck({
    minTime: Math.ceil(1000 / rps),
    maxConcurrent: 1
});

/**
 * Timeout wrapper for promises
 */
function timeoutRace(ms, task) {
    return Promise.race([
        task(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('LOCAL_TIMEOUT')), ms))
    ]);
}

/**
 * Try a function with rate limiting and timeout
 */
async function tryOnce(fn, label) {
    try {
        return await limiter.schedule(() => timeoutRace(12_000, () => fn()));
    } catch (e) {
        console.warn(`fail@${label}:`, e && (e.message || e));
        throw e;
    }
}

/**
 * Call OpenAI API
 */
async function askOpenAI(ai, model, messages, maxTokens) {
    return await ai.chat.completions.create({
        model,
        messages,
        temperature: 0.5,
        max_tokens: Math.min(maxTokens || 500, config.OPENAI_MAX_OUTPUT_TOKENS)
    });
}

/**
 * Call Azure OpenAI API
 */
async function askAzure(messages, maxTokens) {
    const key = config.AZURE_OPENAI_KEY;
    const endpoint = config.AZURE_OPENAI_ENDPOINT;
    const deployment = config.AZURE_OPENAI_DEPLOYMENT;

    if (!key || !endpoint) {
        throw new Error('AZURE_MISSING');
    }

    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-08-01-preview`;
    
    const resp = await timeoutRace(12_000, () => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': key
        },
        body: JSON.stringify({
            messages,
            temperature: 0.5,
            max_tokens: Math.min(maxTokens || 500, config.OPENAI_MAX_OUTPUT_TOKENS)
        })
    }));

    if (!resp.ok) {
        throw new Error(`AZURE_HTTP_${resp.status}`);
    }

    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || '';
    
    return { choices: [{ message: { content: text } }] };
}

/**
 * Call Groq API
 */
async function askGroq(messages, maxTokens) {
    const key = config.GROQ_API_KEY;
    
    if (!key) {
        throw new Error('GROQ_MISSING');
    }

    const url = 'https://api.groq.com/openai/v1/chat/completions';
    
    const resp = await timeoutRace(12_000, () => fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
            model: 'llama-3.1-70b-versatile',
            messages,
            temperature: 0.5,
            max_tokens: Math.min(maxTokens || 500, config.OPENAI_MAX_OUTPUT_TOKENS)
        })
    }));

    if (!resp.ok) {
        throw new Error(`GROQ_HTTP_${resp.status}`);
    }

    const json = await resp.json();
    const text = json?.choices?.[0]?.message?.content?.trim() || '';
    
    return { choices: [{ message: { content: text } }] };
}

/**
 * Ask any LLM with automatic failover
 * Tries: OpenAI (3 models) → Azure → Groq
 */
async function askAnyLLM(ai, messages, maxTokens) {
    const m1 = config.PRIMARY_MODEL;
    const m2 = config.FALLBACK_MODEL_1;
    const m3 = config.FALLBACK_MODEL_2;

    const chain = [
        () => tryOnce(() => askOpenAI(ai, m1, messages, maxTokens), `openai:${m1}`),
        () => tryOnce(() => askOpenAI(ai, m2, messages, maxTokens), `openai:${m2}`),
        () => tryOnce(() => askOpenAI(ai, m3, messages, maxTokens), `openai:${m3}`),
        () => tryOnce(() => askAzure(messages, maxTokens), 'azure'),
        () => tryOnce(() => askGroq(messages, maxTokens), 'groq')
    ];

    for (const step of chain) {
        try {
            const r = await step();
            const text = r?.choices?.[0]?.message?.content?.trim();
            if (text) return text;
        } catch (_) {
            // Try next provider
        }
    }

    throw new Error('ALL_PROVIDERS_FAILED');
}

module.exports = {
    askAnyLLM,
    askOpenAI,
    askAzure,
    askGroq
};
