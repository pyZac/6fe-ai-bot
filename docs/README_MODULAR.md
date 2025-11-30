# 6FE AI Bot - Modular Architecture

## 📁 New File Structure

```
6fe-ai-bot/
├── ai_bot_modular.js      # Main entry point (NEW - replaces ai_bot.js)
├── config.js              # Configuration & environment variables
├── database.js            # Database operations & schema
├── db_memory.js           # DB-based conversation memory
├── llm_providers.js       # Multi-provider LLM with failover
├── commands.js            # Telegram bot commands
├── prompts.js             # System prompts & templates
├── utils.js               # Utility functions & helpers
├── semantic.js            # Semantic search (existing)
├── thread_memory.js       # Old Redis memory (can be removed)
├── .env                   # Environment variables
├── kb.csv                 # Knowledge base
├── kb_index.json          # Semantic search index
├── package.json           # Dependencies
└── bot_logs.jsonl         # Logs
```

## 📦 File Breakdown

### **ai_bot_modular.js** (Main Entry - 380 lines)
- Boot sequence & initialization
- Photo handler (chart analysis)
- Text handler (main conversation)
- Coordinates all modules
- Clean and readable

### **config.js** (Configuration - 60 lines)
- All environment variables
- Default values
- Validation
- Easy to modify settings

### **database.js** (Database - 180 lines)
- Connection pool management
- Schema initialization
- User profiles (CRUD)
- User memory (key-value store)
- Access gate (subscription check)

### **db_memory.js** (Conversation Memory - 420 lines)
- Replace Redis with DB
- Conversation history
- Auto-summarization
- Context building
- Analytics functions
- Search capabilities

### **llm_providers.js** (LLM Failover - 180 lines)
- OpenAI (3 models)
- Azure OpenAI
- Groq
- Rate limiting
- Timeout handling
- Automatic failover

### **commands.js** (Bot Commands - 280 lines)
- All telegram commands
- /start, /help, /profile
- /beginner, /pro
- /mystats, /search, /clearmemory
- /analytics (admin)

### **prompts.js** (Prompts & Templates - 80 lines)
- System prompt
- Chart analysis prompt
- Mistake classification prompt
- Summarization prompt
- Easy to modify

### **utils.js** (Utilities - 320 lines)
- Cache implementation
- Logging
- Topic inference
- Mistake tracking
- Trade journaling
- Quick templates
- User serialization

## 🎯 Benefits of Modular Structure

### 1. **Maintainability**
- Each file has a single responsibility
- Easy to find and fix bugs
- Clear separation of concerns

### 2. **Readability**
- 944 lines → ~380 lines main file
- Logical organization
- Clear imports and exports
- Better code navigation

### 3. **Testability**
- Each module can be tested independently
- Mock dependencies easily
- Unit tests are simpler

### 4. **Scalability**
- Easy to add new features
- Simple to modify existing ones
- No risk of breaking unrelated code

### 5. **Collaboration**
- Multiple developers can work simultaneously
- Clear boundaries between modules
- Easier code reviews

## 🚀 Migration Path

### Option 1: Fresh Start (Recommended)
```bash
# Backup current setup
cp ai_bot.js ai_bot.js.old
cp -r . ../6fe-ai-bot-backup/

# Upload all new files
# (config.js, database.js, db_memory.js, etc.)

# Rename main file
mv ai_bot_modular.js ai_bot.js

# Update PM2
pm2 restart ai_bot
```

### Option 2: Gradual Migration
```bash
# Keep both versions running
pm2 start ai_bot_modular.js --name ai_bot_v2

# Test the new version
# Once confirmed working:
pm2 delete ai_bot
pm2 restart ai_bot_v2 --name ai_bot
```

## 📝 Configuration Steps

### 1. Update .env file
```bash
# Add admin telegram IDs (comma-separated)
ADMIN_IDS=YOUR_TELEGRAM_ID,ANOTHER_ADMIN_ID

# Remove Redis config (if exists)
# REDIS_URL=...
# REDIS_DISABLED=...

# Keep these:
BOT_TOKEN=your_bot_token
OPENAI_API_KEY=your_key
DB_HOST=localhost
DB_USER=your_user
DB_PASS=your_pass
DB_NAME=your_db
THREAD_MAX_TURNS=12
```

### 2. Update Database
```sql
-- Add metadata column
ALTER TABLE conv_messages 
ADD COLUMN IF NOT EXISTS metadata JSON DEFAULT NULL;
```

### 3. Upload All Files
```bash
# Upload to server in same directory:
- ai_bot_modular.js (rename to ai_bot.js)
- config.js
- database.js
- db_memory.js
- llm_providers.js
- commands.js
- prompts.js
- utils.js
```

### 4. Test
```bash
# Check syntax
node -c ai_bot.js

# Check all modules load
node -e "require('./config'); require('./database'); require('./db_memory'); console.log('✅ All modules OK')"

# Start bot
pm2 restart ai_bot
pm2 logs ai_bot
```

## 🔧 How to Modify

### Adding a New Command
Edit `commands.js`:
```javascript
bot.command('mynewcommand', async (ctx) => {
    // Your logic here
    ctx.reply('Response');
});
```

### Changing System Prompt
Edit `prompts.js`:
```javascript
const SYSTEM_PROMPT = `
Your new prompt here...
`;
```

### Adding New LLM Provider
Edit `llm_providers.js`:
```javascript
async function askNewProvider(messages, maxTokens) {
    // Your implementation
}

// Add to chain in askAnyLLM():
const chain = [
    // ... existing providers
    () => tryOnce(() => askNewProvider(messages, maxTokens), 'newprovider')
];
```

### Adding New Utility Function
Edit `utils.js`:
```javascript
function myNewFunction(param) {
    // Your logic
    return result;
}

module.exports = {
    // ... existing exports
    myNewFunction
};
```

## 📊 Monitoring

### Check Logs
```bash
# PM2 logs
pm2 logs ai_bot

# Bot logs (JSONL format)
tail -f bot_logs.jsonl

# Last 10 logs formatted
tail -10 bot_logs.jsonl | jq .
```

### Database Stats
```sql
-- Message count
SELECT COUNT(*) FROM conv_messages;

-- Active users
SELECT COUNT(DISTINCT telegram_id) FROM conv_messages;

-- Recent activity
SELECT DATE(ts), COUNT(*) 
FROM conv_messages 
GROUP BY DATE(ts) 
ORDER BY DATE(ts) DESC 
LIMIT 7;
```

### Analytics Dashboard
```bash
# In telegram, send to yourself:
/analytics

# Shows:
# - Total users
# - Total messages
# - Active users (7 days)
# - Popular topics
```

## 🐛 Troubleshooting

### Module Not Found
```bash
# Check file exists
ls -la config.js database.js db_memory.js

# Check require paths
grep "require('./" ai_bot.js
```

### Database Connection Error
```bash
# Test connection
mysql -u user -p database -e "SELECT 1;"

# Check .env
cat .env | grep DB_
```

### Memory Not Working
```bash
# Check metadata column exists
mysql -u user -p database -e "SHOW COLUMNS FROM conv_messages LIKE 'metadata';"

# Check functions
node -e "const {createDbMemory} = require('./db_memory'); console.log(typeof createDbMemory);"
```

## 🔄 Updating

### Update Single Module
```bash
# Edit file on server
nano config.js

# Restart bot
pm2 restart ai_bot
```

### Update Multiple Modules
```bash
# Stop bot
pm2 stop ai_bot

# Upload new files
# (via FTP/SCP)

# Restart
pm2 restart ai_bot
pm2 logs ai_bot --lines 50
```

## 📚 Documentation

Each module is self-documented with:
- Function descriptions
- Parameter types
- Return values
- Usage examples (in comments)

Example:
```javascript
/**
 * Get user profile from database
 * @param {string} telegramId - User's telegram ID
 * @returns {object} User profile object
 */
async function getUserProfile(telegramId) {
    // Implementation
}
```

## ✅ Validation Checklist

After migration, verify:
- [ ] Bot starts without errors
- [ ] Commands work (/start, /help, /profile)
- [ ] Questions get answered
- [ ] Conversation memory works
- [ ] /mystats shows data
- [ ] /search finds messages
- [ ] Chart analysis works
- [ ] No errors in logs
- [ ] Database grows normally
- [ ] All modules loaded

## 🎉 Next Steps

1. **Test thoroughly** (20 mins)
2. **Monitor for 24 hours**
3. **Check analytics** (/analytics)
4. **Implement Phase 2** (Fancy formatting)
5. **Add psychological support**
6. **Launch to users**

---

**Questions?** Each module is well-commented and easy to understand. Start with `ai_bot_modular.js` and follow the imports!
