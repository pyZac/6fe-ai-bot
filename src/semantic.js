// semantic.js — تحميل الفهرس وتنفيذ بحث دلالي محلي (Updated Paths for /src/ folder)

// --- Polyfills for Node environment (before loading @xenova/transformers) ---
try {
  // Web Streams (Node 18+ يوفرها؛ بس نضمنها صراحةً)
  const web = require('stream/web');
  if (!globalThis.ReadableStream) globalThis.ReadableStream = web.ReadableStream;
  if (!globalThis.WritableStream) globalThis.WritableStream = web.WritableStream;
  if (!globalThis.TransformStream) globalThis.TransformStream = web.TransformStream;
} catch { /* ignore */ }

try {
  // fetch/Headers/Request/Response (لازمين لتنزيل النماذج من الهَب)
  if (typeof fetch === 'undefined') {
    const nf = require('node-fetch');
    globalThis.fetch = nf;
    const { Headers, Request, Response } = nf;
    if (!globalThis.Headers) globalThis.Headers = Headers;
    if (!globalThis.Request) globalThis.Request = Request;
    if (!globalThis.Response) globalThis.Response = Response;
  }
} catch { /* ignore */ }


const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// Updated paths - files are now in ../data/ relative to /src/
const INDEX_PATH = path.join(__dirname, '../data/kb_index.json');
const KB_CSV_PATH = path.join(__dirname, '../data/kb.csv');

let KB = [];             // [{ id (string), search_text, embedding: Float32Array (normalized) }]
let ANSWERS = new Map(); // id(string) -> answer
let embedder = null;     // سيتم تحميله عبر dynamic import

function l2norm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  const inv = 1 / Math.sqrt(Math.max(s, 1e-12));
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// حمّل embedder عند الحاجة باستخدام dynamic import (متوافق مع CommonJS)
async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers'); // <— المهم
    embedder = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  }
  return embedder;
}

async function loadIndex() {
  // Verify files exist
  if (!fs.existsSync(INDEX_PATH)) {
    console.error('❌ kb_index.json not found at:', INDEX_PATH);
    console.error('Expected location: /data/kb_index.json');
    throw new Error('KB index file missing');
  }
  
  if (!fs.existsSync(KB_CSV_PATH)) {
    console.error('❌ kb.csv not found at:', KB_CSV_PATH);
    console.error('Expected location: /data/kb.csv');
    throw new Error('KB CSV file missing');
  }

  // 1) حمّل الفهرس (ids كنصوص)
  const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  KB = raw.map(r => ({
    id: String(r.id),
    search_text: r.search_text,
    embedding: l2norm(Float32Array.from(r.embedding))
  }));

  console.log(`✅ Loaded ${KB.length} embeddings from ${INDEX_PATH}`);

  // 2) حمّل أجوبة kb.csv واربط id(string) -> answer
  const csv = fs.readFileSync(KB_CSV_PATH, 'utf-8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  for (const row of rows) {
    if (row.id && (row.answer || row.cleaned_answer)) {
      ANSWERS.set(String(row.id), row.answer || row.cleaned_answer);
    }
  }

  console.log(`✅ Mapped ${ANSWERS.size} answers from ${KB_CSV_PATH}`);

  // 3) حضّر النموذج
  await getEmbedder();
  console.log('✅ Embedder model ready');
}

async function embedQuery(text) {
  const e = await getEmbedder();
  const q = 'query: ' + text; // E5 يفضل "query: "
  const out = await e(q, { pooling: 'mean', normalize: true });
  return out.data; // Float32Array (normalized)
}

function searchByVector(qvec, topK = 5) {
  const scores = [];
  for (let i = 0; i < KB.length; i++) {
    const score = cosine(qvec, KB[i].embedding); // كلهم normalized
    scores.push([i, score]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return scores.slice(0, topK).map(([idx, score]) => ({
    id: KB[idx].id,
    score,
    search_text: KB[idx].search_text,
    answer: ANSWERS.get(String(KB[idx].id)) || ''
  }));
}

async function semanticSearch(query, { topK = 5, threshold = 0.35 } = {}) {
  const qvec = await embedQuery(query);
  const top = searchByVector(qvec, topK);
  const best = top[0];
  return { top, best, useKB: !!(best && best.score >= threshold) };
}

module.exports = { loadIndex, semanticSearch };