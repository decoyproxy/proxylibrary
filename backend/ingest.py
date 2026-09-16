"""Read a local research folder into data/graph.json.

Layout: LIBRARY_DIR/<Type>/<file>, where Type is one of the five node types
(folder name plural or singular: "Sources" and "Source" both work).

    library/
      Projects/umwelt.md
      Concepts/non-human-perception.md
      Sources/uexkull-book.md

A file's id is its stem. Optional front matter overrides the defaults:

    ---
    title: Non-human perception
    importance: 5
    domain: Philosophy
    date: 2025-08-14
    ---

Edges come from [[wiki-links]] in the body; the edge type is derived from what
the link points AT (-> Project = ASSEMBLE, -> Concept = RESEARCH, else SPARK).

Everything runs locally: the embedding model runs on MPS, ChromaDB is embedded
on disk. No network calls beyond the one-time model download.
"""
import json
import os
import re
from datetime import date as date_cls
from pathlib import Path

import coords

DATA = Path(__file__).parent / "data"
LIBRARY = Path(os.environ.get("LIBRARY_DIR", DATA / "library"))
CHROMA = DATA / "chroma"
# CLAUDE.md specifies nomic-embed-text, but its v1.5 remote code is broken under
# transformers 5.x and pinning transformers back would freeze every contributor's
# env. multilingual-e5 needs no remote code and handles the Korean notes better.
# Override with EMBED_MODEL if you want something else.
MODEL = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-base")
PREFIX = os.environ.get("EMBED_PREFIX", "passage: ")
TEXT_SUFFIXES = {".md", ".txt", ".json"}
TYPES = ("Project", "Concept", "Source", "Fragment", "Asset")
EDGE_BY_TARGET = {"Project": "ASSEMBLE", "Concept": "RESEARCH"}

FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
WIKI_LINK = re.compile(r"\[\[([^\]|]+)")


def node_type(folder_name):
    """'Sources' -> 'Source'. Unknown folders are ignored by the caller."""
    name = folder_name.rstrip("s").capitalize()
    return name if name in TYPES else None


def parse(path):
    """-> (meta dict, body text). Flat `key: value` front matter only."""
    raw = path.read_text(encoding="utf-8", errors="replace") if path.suffix in TEXT_SUFFIXES else ""
    meta, body = {}, raw
    match = FRONT_MATTER.match(raw)
    if match:
        body = raw[match.end():]
        for line in match.group(1).splitlines():
            key, _, value = line.partition(":")
            if value.strip():
                meta[key.strip().lower()] = value.strip()
    return meta, body


def collect():
    """Walk the library into (node dict, text) pairs, ordered for stable ids."""
    found = []
    for folder in sorted(p for p in LIBRARY.iterdir() if p.is_dir()) if LIBRARY.is_dir() else []:
        ntype = node_type(folder.name)
        if not ntype:
            continue
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            meta, body = parse(path)
            try:
                importance = int(meta.get("importance", 3))
            except ValueError:
                importance = 3
            node = {
                "id": path.stem,
                "title": meta.get("title", path.stem.replace("-", " ")),
                "type": ntype,
                "importance": max(1, min(5, importance)),
                "domain": meta.get("domain", "Art"),
                "date": meta.get("date", date_cls.fromtimestamp(path.stat().st_mtime).isoformat()),
                "path": str(path.relative_to(LIBRARY)),
                "links": WIKI_LINK.findall(body),
            }
            found.append((node, f"{node['title']}\n\n{body}".strip() or node["title"]))
    return found


_model = None


def model():
    """Load the embedding model once. The API server reuses it across requests."""
    global _model
    if _model is None:
        import torch
        from sentence_transformers import SentenceTransformer

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        _model = SentenceTransformer(MODEL, device=device)
    return _model


def embed(texts, prefix=PREFIX):
    """Local embeddings on Apple Silicon. Falls back to CPU where MPS is absent."""
    return model().encode(
        [prefix + t for t in texts], normalize_embeddings=True, batch_size=8
    ).tolist()


def collection():
    """The embedded ChromaDB collection written by the last ingest."""
    import chromadb

    return chromadb.PersistentClient(path=str(CHROMA)).get_or_create_collection("library")


def store_vectors(nodes, texts, vectors):
    """Persist to embedded ChromaDB so search can query it without re-embedding."""
    collection().upsert(
        ids=[n["id"] for n in nodes],
        embeddings=vectors,
        documents=texts,
        metadatas=[{k: n[k] for k in ("title", "type", "domain", "importance", "path")}
                   for n in nodes],
    )


def build(found):
    nodes, texts = [n for n, _ in found], [t for _, t in found]
    vectors = embed(texts)
    store_vectors(nodes, texts, vectors)
    semantic = coords.semantic(vectors)

    by_id = {n["id"]: n for n in nodes}
    edges, seen = [], set()
    for node in nodes:
        for target in node.pop("links"):
            target = target.strip()
            if target not in by_id or target == node["id"] or (node["id"], target) in seen:
                continue
            seen.add((node["id"], target))
            edges.append({
                "source": node["id"],
                "target": target,
                "type": EDGE_BY_TARGET.get(by_id[target]["type"], "SPARK"),
            })

    for i, node in enumerate(nodes):
        node["coordinates"] = {
            "semantic": semantic[i],
            "ontological": coords.ontological(i, node["type"], node["domain"], node["importance"]),
            "temporal": coords.temporal(node["date"], node["domain"], node["importance"]),
        }
    return {"nodes": nodes, "edges": edges}


def main():
    found = collect()
    if not found:
        raise SystemExit(
            f"no documents under {LIBRARY}\n"
            "create <Type>/ folders there (Projects, Concepts, Sources, Fragments, Assets),\n"
            "or point LIBRARY_DIR at your own research folder."
        )
    graph = build(found)
    out = DATA / "graph.json"
    out.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({len(graph['nodes'])} nodes, {len(graph['edges'])} edges)")


if __name__ == "__main__":
    main()
