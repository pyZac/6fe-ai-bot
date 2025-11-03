# parquet_to_json.py
import pandas as pd, json

INP = 'kb_embeddings.parquet'
OUT = 'kb_index.json'

df = pd.read_parquet(INP)

records = []
for _, r in df.iterrows():
    rid = "" if pd.isna(r.get('id')) else str(r.get('id'))
    st  = "" if pd.isna(r.get('search_text')) else str(r.get('search_text'))

    emb = r.get('embedding')
    if emb is None:
        vec = []
    else:
        vec = [float(x) for x in list(emb)]

    records.append({
        'id': rid,                
        'search_text': st,
        'embedding': vec
    })

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(records, f, ensure_ascii=False)

print(f"✅ wrote {len(records)} records to {OUT}")
