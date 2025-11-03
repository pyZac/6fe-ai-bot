# 🤖 6FE AI Coach Bot (Educational Telegram Assistant)

**6FE AI Bot** is a lightweight, production-ready **Telegram assistant** built for the **6 Figure Earner (6FE)** community.  
It combines GPT-powered reasoning with a **local semantic knowledge base** to deliver practical, Arabic-first trading education — safely and automatically.

---

## ⚙️ Overview

- **Stack:** Node.js (Telegraf) + OpenAI GPT-4o + Local KB (Semantic Search)
- **Mode:** Educational-only (no financial advice)
- **Language:** Arabic-first, concise, coach-style tone
- **Hosting:** VPS + PM2 (long polling)
- **DB:** Optional MySQL for subscription checks
- **Memory:** Redis optional (**currently disabled**)
- **Search Engine:** Semantic search using a pre-generated embeddings index (`kb_index.json`, not included here)

---

## 🧠 Core Features

| Feature | Description |
|----------|-------------|
| **Semantic Search** | Uses a vector index (`kb_index.json`) generated offline from cleaned CSV to match conceptually similar questions. |
| **Guaranteed Reply** | Multi-provider failover (OpenAI → Azure → Groq) ensures a response even during API downtime. |
| **Local KB Fallback** | If all providers fail, the bot falls back to simple keyword/fuzzy search over a small demo CSV. |
| **Access Gate (optional)** | Validates user subscription status via MySQL (`telegram_id`, `ExpDate`). |
| **User Profiles** | Tracks level (beginner/pro), risk %, instruments, goals, etc. |
| **Conversation Memory** | Redis-based thread memory supported; **disabled now** (uses in-memory `noopMemory`). |
| **Educational Guardrails** | Always risk-aware, concise, and non-promotional. |

---

## 📁 Folder Structure

```
6fe-ai-bot/
├── ai_bot.js            # Main bot logic (GPT + failover + semantic KB + DB gate)
├── semantic.js          # Semantic search (cosine similarity over embeddings; loads JSON index)
├── thread_memory.js     # Optional Redis memory manager (noop when disabled)
├── check_env.js         # Standalone diagnostic/quick-test script
├── build_embeddings.py  # Offline builder: CSV → embeddings.parquet → JSON index
├── parquet_to_json.py   # Helper: convert .parquet embeddings into .json index
├── chat-filter.ipynb    # Local notebook: builds the FIRST KB from Telegram HTML exports
├── kb_example.csv       # Demo knowledge base (safe, public sample)
├── package.json
├── package-lock.json
├── requirements.txt
└── README.md
```

---

## 🧮 Knowledge Base (KB) — How We Built It

### 1) Extract from Telegram → **`chat-filter.ipynb`**
We used the notebook **`chat-filter.ipynb`** locally to parse **Telegram chat HTML exports** and bootstrap the first KB candidates.  
Key steps implemented in the notebook:

- **HTML parsing** with BeautifulSoup → `parse_messages_simple(html_file)` collects `(date, sender, text, tg_id)`.
- **Arabic normalization & cleaning**:
  - Remove diacritics, unify hamza/taa marbuta, strip URLs/mentions, collapse whitespace (`normalize_ar`, `clean_text`).
- **Question detection & scoring**:
  - Heuristics combining interrogatives (كيف/شو…)، domain words (دعم/مقاومة/ترند…)، punctuation (؟)، and length penalties → `question_score`, `looks_like_question`.
- **Rule/announcement filtering**:
  - Skip group rules / bulk announcements (e.g., “قوانين المجموعة…”) via `is_rules_announcement`.
- **Answer candidate harvesting**:
  - Sliding window after each question (`window_after=5`) with deduplication (global + local) using `difflib.SequenceMatcher` and SHA-1 hashing → `TextDeduper`, `build_candidates_simple`.
- **Output**:
  - Writes a candidates CSV with columns: `tg_msg_id,date,sender,question_text,answer_candidates,q_score`.

This gave us a **clean starting dataset** of Q&A candidates extracted from real chats (without publishing any private content).

### 2) Curate & finalize → **`kb.cleaned.csv`** (private)
We manually reviewed and curated the candidates to produce a structured KB:
```
id, question_ar, cleaned_answer, topic, search_text, synonyms
```
> In this public repo we include **`kb_example.csv`** only (a safe demo sample) instead of the real `kb.cleaned.csv`.

### 3) Build embeddings & index (offline)
- Generate embeddings: **`build_embeddings.py`** → `kb_embeddings.parquet`
- Convert to runtime index: **`parquet_to_json.py`** → **`kb_index.json`**
- **Runtime**: `semantic.js` loads `kb_index.json` and performs **cosine similarity** search.

> Note: `kb_index.json` and the real `kb.cleaned.csv` are **not included** in the public repo for privacy.

---

## 🧠 Memory & Redis

- **Redis is currently disabled** (`noopMemory` in use).
- To enable later:
  1. Set `REDIS_URL` in `.env`
  2. Remove/omit `REDIS_DISABLED=true`
  3. The bot will start storing short-term conversation context automatically.

---

## 💡 Environment Variables (excerpt)

| Variable | Description |
|-----------|-------------|
| `BOT_TOKEN` | Telegram bot token |
| `OPENAI_API_KEY` | OpenAI API key |
| `PRIMARY_MODEL` | GPT model (default: `gpt-4o-mini`) |
| `DB_HOST, DB_USER, DB_PASS, DB_NAME` | MySQL connection |
| `REDIS_URL` | Redis URL (optional) |
| `REDIS_DISABLED` | `true` to disable Redis |
| `DISABLE_DB_GATE` | `1` to disable subscription check |
| `OPENAI_RPS` | Rate limit per second |

---

## 🚀 Running Locally

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Create `.env`**
   ```bash
   BOT_TOKEN=123456:ABCDEF
   OPENAI_API_KEY=sk-xxxx
   PRIMARY_MODEL=gpt-4o-mini
   REDIS_DISABLED=true
   ```

3. **Run the bot**
   ```bash
   node ai_bot.js
   ```
   or via PM2:
   ```bash
   pm2 start ai_bot.js --name 6fe-ai-bot
   ```

---

## 🧭 Notes

- Bot operates in **semantic mode** using a JSON vector index generated offline.  
- **Redis is disabled** — `noopMemory` handles minimal context.  
- **Guaranteed Reply**: even if providers or KB access fail, the bot returns a short educational fallback.  
- This repo demonstrates a **hybrid AI retrieval** pipeline: GPT reasoning + local vector search + optional DB validation.

---

## 🪄 Development Notes (AI-assisted)

This project was built by **Saqer Terkawi (6FE Project)**, with AI assistance (ChatGPT) for structuring, refactoring, and documentation.  
All architecture decisions, integrations, and deployment were implemented and verified manually.

---

## 🧱 License

MIT License — for educational and demonstrative use.
