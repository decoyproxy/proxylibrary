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
import sys
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
# Re-project the whole galaxy once this share of it has changed since the last
# full layout; below that, changed nodes are placed among their neighbours and
# everything else stays put.
REFIT_RATIO = float(os.environ.get("REFIT_RATIO", 0.2))
CLIP_TEXT_CHARS = 300  # CLIP's text encoder truncates at 77 tokens anyway
# Multilingual CLIP: the English-only ViT-B-32 ranked night frames first for
# "숲 사진". This one costs ~1.7GB and a slower encode, and reads the Korean
# notes the library is actually written in.
CLIP_MODEL = os.environ.get("CLIP_MODEL", "xlm-roberta-base-ViT-B-32")
CLIP_WEIGHTS = os.environ.get("CLIP_WEIGHTS", "laion5b_s13b_b90k")
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


def fingerprint(path):
    """Changes whenever the file's bytes could have. Cheap: one stat call."""
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


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
                "fingerprint": fingerprint(path),
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


def metadata(node, fingerprints, model):
    fields = ("title", "type", "domain", "importance", "path", "media")
    return {**{k: node[k] for k in fields},
            "fingerprint": fingerprints[node["id"]], "model": model}


def reusable(store, ids, fingerprints, model):
    """Vectors from the last ingest whose file has not been touched since.

    The fingerprint rides along in the vector's own metadata, so there is no
    second cache file to fall out of step with the index. The model name rides
    along too: swapping EMBED_MODEL or CLIP_MODEL invalidates every vector
    without changing a single file, and silently mixing two embedding spaces
    would scramble the galaxy with no visible error.
    """
    if not ids:
        return {}
    stored = store.get(ids=ids, include=["embeddings", "metadatas"])
    embeddings = stored["embeddings"]
    if embeddings is None or not len(embeddings):
        return {}
    return {
        nid: list(vector)
        for nid, meta, vector in zip(stored["ids"], stored["metadatas"], embeddings)
        if meta.get("fingerprint") == fingerprints.get(nid) and meta.get("model") == model
    }


def drop_deleted(store, ids):
    """Forget vectors whose file is gone, so searches stop returning them."""
    stale = [nid for nid in store.get(include=[])["ids"] if nid not in ids]
    if stale:
        store.delete(ids=stale)
    return stale


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
    """CLIP vectors for every node — a different space from the text ones, so a
    separate collection. Stored raw (uncentred), because a search query is a raw
    CLIP vector too; the centring that fixes the modality gap is a layout step.
    Image search filters this collection on media."""
    import chromadb

    return chromadb.PersistentClient(path=str(CHROMA)).get_or_create_collection(
        "clip", metadata=COSINE
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


def raw_clip(nodes, texts, wanted):
    """Raw CLIP vectors for the given node ids: the picture for images, the words
    for everything else."""
    picked = [(n, t) for n, t in zip(nodes, texts) if n["id"] in wanted]
    if not picked:
        return {}
    images = [n for n, _ in picked if n.get("media") == "image"]
    documents = [(n, t) for n, t in picked if n.get("media") != "image"]
    vectors = {}
    if images:
        for node, vector in zip(images, embed_images([LIBRARY / n["path"] for n in images])):
            vectors[node["id"]] = vector
    if documents:
        encoded = embed_clip_texts([t for _, t in documents])
        for (node, _), vector in zip(documents, encoded):
            vectors[node["id"]] = vector
    return vectors


def centre_clip(nodes, by_id):
    """Line the two CLIP modalities up on a common origin.

    CLIP's image and text vectors sit in separate cones — any image is closer to
    any other image (~0.9) than to the text describing it (~0.2) — so without
    this the pictures form one island in the galaxy no matter what they show.
    """
    import numpy as np

    vectors = np.asarray([by_id[n["id"]] for n in nodes], dtype="float32")
    is_image = np.array([n.get("media") == "image" for n in nodes])
    if is_image.any() and not is_image.all():
        for group in (is_image, ~is_image):
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


def last_layout():
    """Semantic coordinates from the previous graph.json, to keep the galaxy stable."""
    out = DATA / "graph.json"
    if not out.exists():
        return {}
    try:
        graph = json.loads(out.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return {n["id"]: n["coordinates"]["semantic"] for n in graph.get("nodes", [])}


def layout(ids, joint, stale, refit):
    """Semantic coordinates: keep the old ones where nothing changed.

    A full UMAP re-projection moves every node, which throws away the reader's
    sense of where things are, so it happens only when asked for, when there is
    no previous layout, or when enough of the library has changed that the old
    one no longer describes it.
    """
    previous = last_layout()
    settled = [i for i in ids if i not in stale and i in previous]
    changed_share = 1 - len(settled) / len(ids)
    if refit or not settled or changed_share > REFIT_RATIO:
        why = "asked" if refit else ("no previous layout" if not settled
                                     else f"{changed_share:.0%} of the library changed")
        print(f"re-projecting the whole galaxy ({why})", flush=True)
        return coords.semantic(joint)

    index = {nid: i for i, nid in enumerate(ids)}
    settled = set(settled)
    moving = [i for i in ids if i not in settled]
    if not moving:
        return [previous[i] for i in ids]
    kept = [i for i in ids if i in settled]
    placed = coords.place(
        [joint[index[i]] for i in moving],
        [joint[index[i]] for i in kept],
        [previous[i] for i in kept],
    )
    print(f"placed {len(moving)} node(s); {len(settled)} kept their position", flush=True)
    spots = dict(zip(moving, placed))
    return [spots[i] if i in spots else previous[i] for i in ids]


def build(found, refit=False):
    """Graph for the whole library, re-embedding only what changed.

    UMAP still fits the entire corpus every time — it is a global layout, so one
    new document moves every coordinate — but that costs seconds where embedding
    a large library costs minutes.
    """
    nodes, texts = [n for n, _ in found], [t for _, t in found]
    ids = [n["id"] for n in nodes]
    fingerprints = {n["id"]: n.pop("fingerprint") for n in nodes}

    library, clips = collection(), clip_collection()
    text_cache = reusable(library, ids, fingerprints, MODEL)
    clip_cache = reusable(clips, ids, fingerprints, CLIP_MODEL)
    stale = {n["id"] for n in nodes if n["id"] not in text_cache or n["id"] not in clip_cache}
    picked = [(n, t) for n, t in zip(nodes, texts) if n["id"] in stale]
    if picked:
        print(f"embedding {len(picked)} new or changed of {len(nodes)}", flush=True)

    text_vectors = {**text_cache, **dict(zip(
        [n["id"] for n, _ in picked], embed([t for _, t in picked]) if picked else [],
    ))}
    clip_by_id = {**clip_cache, **raw_clip(nodes, texts, stale)}

    if picked:
        library.upsert(
            ids=[n["id"] for n, _ in picked],
            embeddings=[text_vectors[n["id"]] for n, _ in picked],
            documents=[t for _, t in picked],
            metadatas=[metadata(n, fingerprints, MODEL) for n, _ in picked],
        )
        clips.upsert(
            ids=[n["id"] for n, _ in picked],
            embeddings=[clip_by_id[n["id"]] for n, _ in picked],
            metadatas=[metadata(n, fingerprints, CLIP_MODEL) for n, _ in picked],
        )
    for store in (library, clips):
        for gone in drop_deleted(store, set(ids)):
            print(f"dropped {gone}", flush=True)

    joint = coords.join(
        [text_vectors[i] for i in ids], centre_clip(nodes, clip_by_id), CLIP_MIX
    )
    semantic = layout(ids, joint, stale, refit)

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


def main(refit=False):
    found = collect()
    if not found:
        raise SystemExit(
            f"no documents under {LIBRARY}\n"
            "create <Type>/ folders there (Projects, Concepts, Sources, Fragments, Assets),\n"
            "or point LIBRARY_DIR at your own research folder."
        )
    graph = build(found, refit=refit)
    out = DATA / "graph.json"
    out.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({len(graph['nodes'])} nodes, {len(graph['edges'])} edges)", flush=True)


if __name__ == "__main__":
    main(refit="--refit" in sys.argv)
