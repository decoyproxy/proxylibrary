import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import ingest
import store

QUERY_PREFIX = os.environ.get("QUERY_PREFIX", "query: ")

app = FastAPI(title="proxylibrary")
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"]
)

_collection = None


def library():
    """Cached ChromaDB handle. 503 rather than a stack trace when nothing is indexed."""
    global _collection
    if _collection is None:
        if not ingest.CHROMA.exists():
            raise HTTPException(503, f"no index at {ingest.CHROMA} — run `python ingest.py` first")
        _collection = ingest.collection()
    return _collection


@app.get("/api/v1/nodes")
def nodes():
    return store.load()


@app.get("/api/v1/search")
def search(q: str, limit: int = 8):
    """Semantic search over the vectors the last ingest stored. No re-embedding of the corpus."""
    collection = library()
    if not q.strip():
        return {"query": q, "results": []}
    # First call loads the embedding model (a few seconds); later ones reuse it.
    found = collection.query(
        query_embeddings=ingest.embed([q], prefix=QUERY_PREFIX),
        n_results=min(limit, max(collection.count(), 1)),
    )
    return {
        "query": q,
        "results": [
            {"id": nid, "title": meta.get("title", nid), "type": meta.get("type"),
             "score": round(1 - distance, 3)}
            for nid, meta, distance in zip(
                found["ids"][0], found["metadatas"][0], found["distances"][0]
            )
        ],
    }
