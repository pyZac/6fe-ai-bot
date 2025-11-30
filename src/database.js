// database.js - Database Operations and Schema Management
const config = require('./config');

let pool = null;

/**
 * Get or create database connection pool
 */
async function getDb() {
    if (!config.DB_HOST || !config.DB_USER || !config.DB_NAME) {
        console.warn('⚠️ Database credentials missing - DB features disabled');
        return null;
    }

    if (!pool) {
        let mysql;
        try {
            mysql = require('mysql2/promise');
        } catch {
            console.warn('⚠️ mysql2 not installed - DB features disabled');
            return null;
        }

        pool = await mysql.createPool({
            host: config.DB_HOST,
            user: config.DB_USER,
            password: config.DB_PASS,
            database: config.DB_NAME,
            connectionLimit: 5,
            timezone: 'Z',
            charset: 'utf8mb4'
        });

        try {
            await pool.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
            await pool.query("SET time_zone = '+00:00'");
            console.log('✅ Database connected');
        } catch (e) {
            console.warn('SET NAMES/time_zone warn:', e.message || e);
        }
    }

    return pool;
}

/**
 * Initialize database schema
 */
async function initDbSchema() {
    const db = await getDb();
    if (!db) return;

    // User profiles table
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

    // Add columns if missing (safe migrations)
    try { await db.execute(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS daily_nudge TINYINT DEFAULT 1`); } catch { }
    try { await db.execute(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS weekly_report TINYINT DEFAULT 1`); } catch { }
    try { await db.execute(`ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS motivation VARCHAR(32) DEFAULT 'financial_freedom'`); } catch { }

    // User memory table
    await db.execute(`CREATE TABLE IF NOT EXISTS user_memory (
        telegram_id VARCHAR(64) NOT NULL,
        mkey VARCHAR(64) NOT NULL,
        mvalue TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (telegram_id, mkey)
    )`);

    // Conversation messages table with metadata
    await db.execute(`CREATE TABLE IF NOT EXISTS conv_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        telegram_id VARCHAR(64) NOT NULL,
        role ENUM('user','assistant') NOT NULL,
        content TEXT NOT NULL,
        metadata JSON DEFAULT NULL COMMENT 'question_type, semantic_score, etc.',
        ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_user_ts (telegram_id, ts),
        KEY idx_user_role_ts (telegram_id, role, ts)
    )`);

    // Add metadata column if table already exists
    try {
        await db.execute(`ALTER TABLE conv_messages ADD COLUMN IF NOT EXISTS metadata JSON DEFAULT NULL`);
    } catch { }

    console.log('✅ Database schema initialized');
}

/**
 * Check if user subscription is active
 */
async function isUserActive(telegramId) {
    if (config.DISABLE_DB_GATE === '1') {
        return { skipGate: true, active: true, reason: 'disabled' };
    }

    const db = await getDb();
    if (!db) {
        return { skipGate: true, active: true, reason: 'no_db' };
    }

    try {
        const [rows] = await db.execute(
            `SELECT ${config.DB_COL_EXP} AS exp
             FROM ${config.DB_TABLE}
             WHERE ${config.DB_COL_TELEGRAM} = ?
             ORDER BY ${config.DB_COL_EXP} DESC
             LIMIT 1`,
            [String(telegramId)]
        );

        if (!rows.length) {
            return { active: false, reason: 'not_found' };
        }

        const expRaw = rows[0].exp;
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const expDate = new Date(expRaw);
        expDate.setUTCHours(0, 0, 0, 0);

        if (expDate.toString() === 'Invalid Date') {
            return { active: false, reason: 'invalid_date', raw: { exp: expRaw } };
        }

        const active = expDate >= today;
        return { active, reason: active ? 'ok' : 'expired', raw: { exp: expRaw } };
    } catch (e) {
        console.warn('⚠️ DB error, skipping gate:', e.message || e);
        return { skipGate: true, active: true, reason: 'db_error' };
    }
}

/**
 * Get user profile
 */
async function getUserProfile(telegramId) {
    const db = await getDb();
    if (!db) {
        return {
            level: 'standard',
            language: 'ar',
            timezone: 'Asia/Riyadh',
            risk_percent: 1,
            daily_nudge: 1,
            weekly_report: 1,
            motivation: 'financial_freedom'
        };
    }

    const [rows] = await db.execute(
        `SELECT * FROM user_profiles WHERE telegram_id=? LIMIT 1`,
        [String(telegramId)]
    );

    if (!rows.length) {
        return {
            level: 'standard',
            language: 'ar',
            timezone: 'Asia/Riyadh',
            risk_percent: 1,
            daily_nudge: 1,
            weekly_report: 1,
            motivation: 'financial_freedom'
        };
    }

    return rows[0];
}

/**
 * Update or insert user profile
 */
async function upsertUserProfile(telegramId, partial) {
    const db = await getDb();
    if (!db) return;

    const current = await getUserProfile(telegramId);
    const merged = { ...current, ...partial };

    await db.execute(`
        INSERT INTO user_profiles (
            telegram_id, level, language, timezone, risk_percent,
            instruments, goals, style_notes, daily_nudge, weekly_report, motivation
        )
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
            level=VALUES(level),
            language=VALUES(language),
            timezone=VALUES(timezone),
            risk_percent=VALUES(risk_percent),
            instruments=VALUES(instruments),
            goals=VALUES(goals),
            style_notes=VALUES(style_notes),
            daily_nudge=VALUES(daily_nudge),
            weekly_report=VALUES(weekly_report),
            motivation=VALUES(motivation)
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

/**
 * Set user memory key-value pair
 */
async function setMemory(telegramId, key, value) {
    const db = await getDb();
    if (!db) return;

    await db.execute(`
        INSERT INTO user_memory (telegram_id, mkey, mvalue)
        VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE mvalue=VALUES(mvalue)
    `, [String(telegramId), String(key), String(value)]);
}

/**
 * Get user memory value by key
 */
async function getMemory(telegramId, key) {
    const db = await getDb();
    if (!db) return null;

    const [rows] = await db.execute(
        `SELECT mvalue FROM user_memory WHERE telegram_id=? AND mkey=? LIMIT 1`,
        [String(telegramId), String(key)]
    );

    return rows[0]?.mvalue || null;
}

module.exports = {
    getDb,
    initDbSchema,
    isUserActive,
    getUserProfile,
    upsertUserProfile,
    setMemory,
    getMemory
};
