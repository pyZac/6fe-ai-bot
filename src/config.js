// config.js - Configuration and Environment Variables (Updated Paths for /src/ folder)
const path = require('path');

// Load .env from parent directory (root)
require('dotenv').config({ path: path.join(__dirname, '../.env') });

module.exports = {
    // Telegram Bot
    BOT_TOKEN: process.env.BOT_TOKEN,
    HANDLER_TIMEOUT: 90_000,

    // OpenAI Configuration
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PRIMARY_MODEL: process.env.PRIMARY_MODEL || 'gpt-4o-mini',
    FALLBACK_MODEL_1: process.env.FALLBACK_MODEL_1 || 'gpt-4o',
    FALLBACK_MODEL_2: process.env.FALLBACK_MODEL_2 || 'gpt-4o-mini-2024-07-18',
    OPENAI_MAX_OUTPUT_TOKENS: parseInt(process.env.OPENAI_MAX_OUTPUT_TOKENS || '500', 10),

    // Azure OpenAI (Fallback Provider)
    AZURE_OPENAI_KEY: process.env.AZURE_OPENAI_KEY,
    AZURE_OPENAI_ENDPOINT: process.env.AZURE_OPENAI_ENDPOINT,
    AZURE_OPENAI_DEPLOYMENT: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o-mini',

    // Groq (Fallback Provider)
    GROQ_API_KEY: process.env.GROQ_API_KEY,

    // Database Configuration
    DB_HOST: process.env.DB_HOST,
    DB_USER: process.env.DB_USER,
    DB_PASS: process.env.DB_PASS,
    DB_NAME: process.env.DB_NAME,
    DB_TABLE: process.env.DB_TABLE || 'payments',
    DB_COL_TELEGRAM: process.env.DB_COL_TELEGRAM || 'telegram_id',
    DB_COL_EXP: process.env.DB_COL_EXP || 'ExpDate',
    DISABLE_DB_GATE: process.env.DISABLE_DB_GATE,

    // Memory Configuration
    THREAD_MAX_TURNS: parseInt(process.env.THREAD_MAX_TURNS || '12', 10),
    SUMMARY_EVERY_N: parseInt(process.env.SUMMARY_EVERY_N || '20', 10),
    CONTEXT_WINDOW: 6,

    // Rate Limiting
    OPENAI_RPS: parseInt(process.env.OPENAI_RPS || '1', 10),

    // Cache Settings
    CACHE_MAX_ENTRIES: 500,
    CACHE_TTL_MS: 10 * 60 * 1000, // 10 minutes
    SPAM_PREVENTION_MS: 8000, // 8 seconds

    // Paths (relative to /src/ folder)
    KB_PATH: '../data/kb.csv',
    KB_INDEX_PATH: '../data/kb_index.json',
    LOG_PATH: path.join(__dirname, '../bot_logs.jsonl'),

    // Admin Settings
    ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),

    // Validation
    validate() {
        if (!this.BOT_TOKEN) throw new Error('BOT_TOKEN is missing in .env');
        if (!this.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing in .env');
        console.log('✅ Configuration validated');
        console.log(`   Admins: ${this.ADMIN_IDS.length ? this.ADMIN_IDS.join(', ') : 'none configured'}`);
    }
};