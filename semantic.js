

// --- Polyfills for Node environment (before loading @xenova/transformers) ---
try {

  const web = require('stream/web');
  if (!globalThis.ReadableStream) globalThis.ReadableStream = web.ReadableStream;
  if (!globalThis.WritableStream) globalThis.WritableStream = web.WritableStream;
  if (!globalThis.TransformStream) globalThis.TransformStream = web.TransformStream;
} catch { /* ignore */ }

try {

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

const INDEX_PATH = path.join(__dirname, 'kb_index.json');
const KB_CSV_PATH = path.join(__dirname, 'kb.csv');

let KB = [];             
let ANSWERS = new Map(); 
let embedder = null;     

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


async function getEmbedder() {
  if (!embedder) {
    const { pipeline } = await import('@xenova/transformers'); // <— المهم
    embedder = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  }
  return embedder;
}

async function loadIndex() {

  const raw = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
  KB = raw.map(r => ({
    id: String(r.id),
    search_text: r.search_text,
    embedding: l2norm(Float32Array.from(r.embedding))
  }));


  const csv = fs.readFileSync(KB_CSV_PATH, 'utf-8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true });
  for (const row of rows) {
    if (row.id && row.answer) {
      ANSWERS.set(String(row.id), row.answer);
    }
  }


  await getEmbedder();
}

async function embedQuery(text) {
  const e = await getEmbedder();
  const q = 'query: ' + text; 
  const out = await e(q, { pooling: 'mean', normalize: true });
  return out.data; 
}

function searchByVector(qvec, topK = 5) {
  const scores = [];
  for (let i = 0; i < KB.length; i++) {
    const score = cosine(qvec, KB[i].embedding); 
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
