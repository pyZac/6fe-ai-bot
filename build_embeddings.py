#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build embeddings for kb.cleaned.csv and save to kb_embeddings.parquet

Usage:
  1) python -m venv .venv && source .venv/bin/activate  # (Linux/Mac)
     # or: .venv\Scripts\activate  (Windows)
  2) pip install -r requirements.txt
  3) export OPENAI_API_KEY=sk-...   # (or set in your shell/profile)
  4) python build_embeddings.py --input kb.cleaned.csv --out kb_embeddings.parquet --model text-embedding-3-small --batch 128
"""

import argparse
import json
import os
import sys
from typing import List

import pandas as pd
from tqdm import tqdm
from tenacity import retry, wait_exponential, stop_after_attempt

try:
    from openai import OpenAI
except Exception as e:
    print("❌ Missing openai package or incompatible version. Make sure to 'pip install -r requirements.txt'")
    raise

DEFAULT_MODEL = "text-embedding-3-small"

def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="kb.cleaned.csv", help="Input CSV file (expects columns: id, search_text)")
    ap.add_argument("--out", default="kb_embeddings.parquet", help="Output Parquet file")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="OpenAI embedding model")
    ap.add_argument("--batch", type=int, default=128, help="Batch size for API calls")
    return ap.parse_args()

def ensure_cols(df: pd.DataFrame):
    for c in ["id", "search_text"]:
        if c not in df.columns:
            raise RuntimeError(f"Input CSV must contain column '{c}'")
    # coerce to string for safety
    df["search_text"] = df["search_text"].astype(str).fillna("")
    return df

@retry(wait=wait_exponential(multiplier=1, min=1, max=20), stop=stop_after_attempt(6))
def embed_batch(client: "OpenAI", model: str, texts: List[str]) -> List[List[float]]:
    # OpenAI python SDK v1.x
    res = client.embeddings.create(model=model, input=texts)
    # Ensure ordering preserved
    out = [d.embedding for d in res.data]
    return out

def main():
    args = parse_args()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("❌ Please set OPENAI_API_KEY environment variable.")
        sys.exit(1)
    client = OpenAI(api_key=api_key)
    df = pd.read_csv(args.input)
    df = ensure_cols(df)

    texts = df["search_text"].tolist()
    embeddings: List[List[float]] = []

    print(f"➡️ Building embeddings for {len(texts)} rows using model '{args.model}' (batch={args.batch})")
    for i in tqdm(range(0, len(texts), args.batch), desc="Embedding"):
        batch = texts[i:i+args.batch]
        vecs = embed_batch(client, args.model, batch)
        embeddings.extend(vecs)

    if len(embeddings) != len(texts):
        raise RuntimeError("Embedding count mismatch; aborting.")

    # Save result as parquet with a native list-of-floats column
    out_df = pd.DataFrame({
        "id": df["id"],
        "search_text": df["search_text"],
        "embedding": embeddings,   # list-of-floats; pyarrow preserves this as a list type
    })

    out_df.to_parquet(args.out, index=False)
    print(f"✅ Saved embeddings to: {args.out}")
    # Quick sanity check
    dims = len(embeddings[0]) if embeddings else 0
    print(f"🔎 Vector dimension: {dims}")

if __name__ == "__main__":
    main()
