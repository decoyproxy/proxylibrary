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

PDFs are read with PyMuPDF and embedded like any other text.

Galaxy positions come from a joint space: every node gets a text-model vector
AND a CLIP vector (images through CLIP's image encoder, documents through its
text encoder), the two are normalised, weighted by CLIP_MIX and concatenated,
and UMAP runs on that. So photographs cluster with the photographs they look
like and with the writing whose imagery matches them, while text-to-text
distances still come from the text model, which reads long documents far better
than CLIP's 77-token encoder. Search keeps the raw CLIP vectors in their own
collection, since scores from two spaces cannot be compared.

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
PDF_SUFFIXES = {".pdf"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
PDF_PAGES = int(os.environ.get("PDF_PAGES", 20))  # enough to characterise a paper
PDF_CHARS = 20000
CLIP_MIX = float(os.environ.get("CLIP_MIX", 0.4))  # CLIP's share of the joint space
CLIP_TEXT_CHARS = 300  # CLIP's text encoder truncates at 77 tokens anyway
CLIP_MODEL = os.environ.get("CLIP_MODEL", "ViT-B-32")
CLIP_WEIGHTS = os.environ.get("CLIP_WEIGHTS", "laion2b_s34b_b79k")
TYPES = ("Project", "Concept", "Source", "Fragment", "Asset")
EDGE_BY_TARGET = {"Project": "ASSEMBLE", "Concept": "RESEARCH"}

FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
WIKI_LINK = re.compile(r"\[\[([^\]|]+)")


def node_type(folder_name):
    """'Sources' -> 'Source'. Unknown folders are ignored by the caller."""
    name = folder_name.rstrip("s").capitalize()
    return name if name in TYPES else None


def read_pdf(path):
    """First PDF_PAGES pages of text. Scanned PDFs yield nothing — that needs OCR."""
    import pymupdf

    with pymupdf.open(path) as doc:
        pages = [page.get_text() for page in list(doc)[:PDF_PAGES]]
    return "\n".join(pages)[:PDF_CHARS]


def media_kind(path):
    suffix = path.suffix.lower()
    if suffix in IMAGE_SUFFIXES:
        return "image"
    if suffix in PDF_SUFFIXES:
        return "pdf"
    return "text" if suffix in TEXT_SUFFIXES else None


def parse(path):
    """-> (meta dict, body text). Flat `key: value` front matter only."""
    kind = media_kind(path)
    if kind == "pdf":
        return {}, read_pdf(path)
    raw = path.read_text(encoding="utf-8", errors="replace") if kind == "text" else ""
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
            if not path.is_file() or path.name.startswith(".") or not media_kind(path):
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
                "media": media_kind(path),
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


# Both collections hold normalised vectors, so cosine distance makes a search
# score of `1 - distance` mean what it looks like. Chroma's default is L2, and
# the space is fixed when a collection is created — delete data/chroma to change it.
COSINE = {"hnsw:space": "cosine"}


def collection():
    """The embedded ChromaDB collection written by the last ingest."""
    import chromadb

    return chromadb.PersistentClient(path=str(CHROMA)).get_or_create_collection(
        "library", metadata=COSINE
    )


def store_vectors(nodes, texts, vectors):
    """Persist to embedded ChromaDB so search can query it without re-embedding."""
    collection().upsert(
        ids=[n["id"] for n in nodes],
        embeddings=vectors,
        documents=texts,
        metadatas=[{k: n[k] for k in ("title", "type", "domain", "importance", "path")}
                   for n in nodes],
    )


_clip = None


def clip():
    """OpenCLIP model, preprocessing transform and tokenizer, loaded once."""
    global _clip
    if _clip is None:
        import open_clip
        import torch

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        model, _, preprocess = open_clip.create_model_and_transforms(
            CLIP_MODEL, pretrained=CLIP_WEIGHTS, device=device
        )
        model.eval()
        _clip = (model, preprocess, open_clip.get_tokenizer(CLIP_MODEL), device)
    return _clip


def clip_collection():
    """Image vectors live apart from the text ones — different vector space."""
    import chromadb

    return chromadb.PersistentClient(path=str(CHROMA)).get_or_create_collection(
        "images", metadata=COSINE
    )


def embed_images(paths):
    from PIL import Image
    import torch

    model, preprocess, _, device = clip()
    batch = torch.stack([preprocess(Image.open(p).convert("RGB")) for p in paths]).to(device)
    with torch.no_grad():
        vectors = model.encode_image(batch)
        vectors /= vectors.norm(dim=-1, keepdim=True)
    return vectors.cpu().tolist()


def embed_clip_texts(texts):
    """Documents entering CLIP space, so images and writing share coordinates."""
    import torch

    model, _, tokenizer, device = clip()
    tokens = tokenizer([t[:CLIP_TEXT_CHARS] for t in texts]).to(device)
    with torch.no_grad():
        vectors = model.encode_text(tokens)
        vectors /= vectors.norm(dim=-1, keepdim=True)
    return vectors.cpu().tolist()


def clip_vectors(nodes, texts):
    """One CLIP vector per node: the picture itself for images, the words for the rest.

    CLIP's two modalities sit in separate cones — any image is closer to any
    other image (~0.9) than to the text describing it (~0.2), which would make
    the pictures one island in the galaxy no matter what they show. Centring
    each modality on its own mean removes that offset, so an image's distance to
    a document reflects what they have in common rather than which encoder
    produced it.
    """
    import numpy as np

    vectors = np.asarray(embed_clip_texts(texts), dtype="float32")
    is_image = np.array([n.get("media") == "image" for n in nodes])
    if is_image.any():
        vectors[is_image] = embed_images(
            [LIBRARY / n["path"] for n, image in zip(nodes, is_image) if image]
        )
        for group in (is_image, ~is_image):
            if group.any():
                vectors[group] -= vectors[group].mean(axis=0)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)
    return vectors.tolist()


def embed_image_query(text):
    """Encode a text query into CLIP space so it can be matched against images."""
    import torch

    model, _, tokenizer, device = clip()
    with torch.no_grad():
        vector = model.encode_text(tokenizer([text]).to(device))
        vector /= vector.norm(dim=-1, keepdim=True)
    return vector.cpu().tolist()


def store_images(nodes):
    """Index every image node in CLIP space. Returns how many were stored."""
    images = [n for n in nodes if n.get("media") == "image"]
    if not images:
        return 0
    paths = [LIBRARY / n["path"] for n in images]
    clip_collection().upsert(
        ids=[n["id"] for n in images],
        embeddings=embed_images(paths),
        metadatas=[{"title": n["title"], "type": n["type"], "path": n["path"]} for n in images],
    )
    return len(images)


def build(found):
    nodes, texts = [n for n, _ in found], [t for _, t in found]
    vectors = embed(texts)
    store_vectors(nodes, texts, vectors)
    indexed_images = store_images(nodes)
    if indexed_images:
        print(f"indexed {indexed_images} images in CLIP space", flush=True)
    semantic = coords.semantic(coords.join(vectors, clip_vectors(nodes, texts), CLIP_MIX))

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
    print(f"wrote {out} ({len(graph['nodes'])} nodes, {len(graph['edges'])} edges)", flush=True)


if __name__ == "__main__":
    main()
