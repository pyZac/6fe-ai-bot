// check_env.js — minimal preflight check
require('dotenv').config();
const fs = require('fs');
const path = require('path');

// 1) required env vars
const required = ['BOT_TOKEN', 'OPENAI_API_KEY'];
const missing = required.filter(k => !process.env[k]);

if (missing.length) {
  console.error('❌ Missing environment variables:', missing.join(', '));
  process.exit(1);
}

// 2) optional: ensure KB demo exists (you can skip if you won't ship a demo KB)
const KB_PATH = path.join(process.cwd(), 'kb.cleaned.csv'); // or use process.env.KB_PATH
if (!fs.existsSync(KB_PATH)) {
  console.warn('⚠️ kb.cleaned.csv not found (demo KB is optional for public repo).');
} else {
  console.log('ℹ️ Found kb.cleaned.csv (demo).');
}

console.log('✅ Env preflight OK.');
