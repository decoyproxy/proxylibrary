import os
import subprocess
import sys

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import ingest
import store

QUERY_PREFIX = os.environ.get("QUERY_PREFIX", "query: ")

app = FastAPI(title="proxylibrary")
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"]
)

# The library folder is served read-only so the frontend can show thumbnails.
if ingest.LIBRARY.is_dir():
    app.mount("/media", StaticFiles(directory=ingest.LIBRARY), name="media")

_collection = None


def library():
    """Cached ChromaDB handle. 503 rather than a stack trace when nothing is indexed."""
    global _collection
    if _collection is None:
        if not ingest.CHROMA.exists():
            raise HTTPException(503, f"no index at {ingest.CHROMA} — run `python ingest.py` first")
        _collection = ingest.collection()
    return _collection


def library_file(node_id):
    """The file behind a node id, proven to be inside the library.

    The endpoint takes an id rather than a path on purpose: handing a shell
    command a caller-supplied path is how you end up opening /etc/passwd or an
    application bundle. The id is looked up in the graph, and the resolved path
    is checked against the resolved library root, so a symlink or a ".." inside
    the library cannot reach out of it either.
    """
    node = next((n for n in store.load()["nodes"] if n["id"] == node_id), None)
    if not node or not node.get("path"):
        raise HTTPException(404, f"no file for node {node_id}")
    root = ingest.LIBRARY.resolve()
    target = (root / node["path"]).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise HTTPException(404, f"{node['path']} is not a file in the library")
    return target


@app.post("/api/v1/open/{node_id}")
def open_file(node_id: str):
    """Hand the file to macOS, which knows better than we do what opens a .ARW.

    Local-only by nature: this opens a window on the machine running the server.
    """
    if sys.platform != "darwin":
        raise HTTPException(501, "opening files is wired to macOS `open`")
    target = library_file(node_id)
    result = subprocess.run(["open", str(target)], capture_output=True, text=True)
    if result.returncode:
        raise HTTPException(500, result.stderr.strip() or "open failed")
    return {"opened": str(target)}


@app.get("/api/v1/nodes")
def nodes():
    return store.load()


def search_images(q, limit):
    """CLIP-space hits. Scores are NOT comparable with the text scores above —
    different model, different space — so they stay in their own list."""
    try:
        collection = ingest.clip_collection()
        if not collection.count():
            return []
        found = collection.query(
            query_embeddings=ingest.embed_image_query(q),
            n_results=min(limit, collection.count()),
            where={"media": "image"},  # the collection also holds document vectors
        )
    except Exception:  # no index, or no CLIP weights on this machine
        return []
    return [
        {"id": nid, "title": meta.get("title", nid), "path": meta.get("path"),
         "score": round(1 - distance, 3)}
        for nid, meta, distance in zip(
            found["ids"][0], found["metadatas"][0], found["distances"][0]
        )
    ]


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
        "images": search_images(q, limit),
        "results": [
            {"id": nid, "title": meta.get("title", nid), "type": meta.get("type"),
             "score": round(1 - distance, 3)}
            for nid, meta, distance in zip(
                found["ids"][0], found["metadatas"][0], found["distances"][0]
            )
        ],
    }
