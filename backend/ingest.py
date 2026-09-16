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

Edges come from [[wiki-links]] in the body. A link on a line of its own may name
its relation — "- [SPARK] [[FRG_TICK]]" — and otherwise the type is derived from
what the link points AT (-> Project = ASSEMBLE, -> Concept = RESEARCH, else
SPARK), which is what every note written before relations were editable does.

Everything runs locally: the embedding model runs on MPS, ChromaDB is embedded
on disk. No network calls beyond the one-time model download.
"""
import json
import os
import re
import sys
from datetime import date as date_cls
from datetime import datetime
from pathlib import Path

import coords

DATA = Path(__file__).parent / "data"
LIBRARY = Path(os.environ.get("LIBRARY_DIR", DATA / "library"))
CHROMA = DATA / "chroma"
# Deleting a node moves its files here. Outside LIBRARY, so the next ingest does
# not simply pick them up again.
TRASH = Path(os.environ.get("TRASH_DIR", DATA / ".trash"))
# CLAUDE.md specifies nomic-embed-text, but its v1.5 remote code is broken under
# transformers 5.x and pinning transformers back would freeze every contributor's
# env. multilingual-e5 needs no remote code and handles the Korean notes better.
# Override with EMBED_MODEL if you want something else.
MODEL = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-base")
PREFIX = os.environ.get("EMBED_PREFIX", "passage: ")
TEXT_SUFFIXES = {".md", ".txt", ".json"}
SIDECAR = ".md"  # metadata for a file that cannot hold front matter itself
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
# Id prefixes, matching the seed corpus. Not to be confused with PREFIX, which
# is what the embedding model wants in front of a document.
ID_PREFIX = {"Project": "PRJ", "Concept": "CON", "Source": "SRC",
             "Fragment": "FRG", "Asset": "AST"}
EDGE_BY_TARGET = {"Project": "ASSEMBLE", "Concept": "RESEARCH"}

FRONT_MATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
WIKI_LINK = re.compile(r"\[\[([^\]|]+)")
# A whole line that is nothing but a link, optionally bulleted and typed. Only
# these are safe for the editor to rewrite or delete; a link inside a sentence
# belongs to the sentence.
LINK_LINE = re.compile(
    r"^(?P<bullet>\s*[-*]\s*)?(?:\[(?P<kind>[A-Z]+)\]\s*)?\[\[(?P<target>[^\]|]+)\]\]\s*$"
)


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


def front_matter(raw):
    """-> (meta dict, body). Flat `key: value` only; unknown keys are kept."""
    meta, body = {}, raw
    match = FRONT_MATTER.match(raw)
    if match:
        body = raw[match.end():]
        for line in match.group(1).splitlines():
            key, _, value = line.partition(":")
            if value.strip():
                meta[key.strip().lower()] = value.strip()
    return meta, body


def meta_path(path):
    """Where a node's front matter lives.

    Markdown carries its own. A photograph or a PDF cannot, so its metadata goes
    in a sidecar named after the whole file — "plate.jpg.md", not "plate.md",
    which would collide with the image's own node id.
    """
    if media_kind(path) == "text":
        return path
    return path.with_name(path.name + SIDECAR)


def parse(path):
    """-> (meta dict, body text) for one library file, sidecar included."""
    kind = media_kind(path)
    if kind == "pdf":
        body = read_pdf(path)
    elif kind == "text":
        body = path.read_text(encoding="utf-8", errors="replace")
    else:
        body = ""
    meta, body = front_matter(body)
    sidecar = meta_path(path)
    if sidecar != path and sidecar.exists():
        extra, note = front_matter(sidecar.read_text(encoding="utf-8", errors="replace"))
        meta.update(extra)
        body = f"{body}\n{note}".strip()
    return meta, body


def read_links(body):
    """-> [(target, relation or None)] for every wiki link in the text."""
    links = []
    for line in body.splitlines():
        match = LINK_LINE.match(line)
        if match:
            links.append((match.group("target").strip(), match.group("kind")))
        else:
            links.extend((target.strip(), None) for target in WIKI_LINK.findall(line))
    return links


def write_atomic(path, text):
    """Write through a temporary and rename over the original, so an interrupted
    write cannot leave someone's research note truncated."""
    temporary = path.with_name(f".{path.name}.writing")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)
    return path


def set_link(path, target, kind):
    """Add a relation, or change the one an existing link line carries."""
    file = meta_path(path)
    raw = file.read_text(encoding="utf-8") if file.exists() else ""
    lines = raw.splitlines()
    written = f"- [{kind}] [[{target}]]"
    for i, line in enumerate(lines):
        match = LINK_LINE.match(line)
        if match and match.group("target").strip() == target:
            lines[i] = written
            break
    else:
        # Keep link lines together; separate them from prose with one blank line.
        if lines and lines[-1].strip() and not LINK_LINE.match(lines[-1]):
            lines.append("")
        lines.append(written)
    return write_atomic(file, "\n".join(lines) + "\n")


def drop_link(path, target):
    """Remove a link that sits on a line of its own.

    A link inside a sentence is left alone: deleting that line would delete the
    sentence, and no edge is worth someone's note.
    """
    file = meta_path(path)
    raw = file.read_text(encoding="utf-8") if file.exists() else ""
    kept, removed = [], False
    for line in raw.splitlines():
        match = LINK_LINE.match(line)
        if match and match.group("target").strip() == target:
            removed = True
            continue
        kept.append(line)
    if not removed:
        return None
    write_atomic(file, "\n".join(kept) + "\n")
    return file


def new_note(node_type, title, body="", tags=(), today=None):
    """Create a note and return its path. The id follows the seed corpus:
    FRG_2026_001, numbered per type and year so two notes made the same day
    cannot collide."""
    day = today or date_cls.today()
    folder = LIBRARY / f"{node_type}s"
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{ID_PREFIX[node_type]}_{day.year}"
    taken = {path.stem for path in folder.glob(f"{stem}_*")}
    number = 1
    while f"{stem}_{number:03d}" in taken:
        number += 1
    path = folder / f"{stem}_{number:03d}.md"
    if path.exists():  # a file we do not treat as a node, but the name is taken
        raise FileExistsError(path)

    front = {"title": title, "importance": 3, "domain": "Art", "date": day.isoformat(),
             "tags": ", ".join(tags)}
    block = "\n".join(f"{key}: {value}" for key, value in front.items())
    write_atomic(path, f"---\n{block}\n---\n\n{body.strip()}\n")
    return path


def trash(path):
    """Move a node's files out of the library instead of deleting them.

    Returns the paths as they now sit in the trash. A research archive is not
    the place to learn that a delete button meant it; the files keep their
    relative layout under a timestamped folder, so putting one back is a `mv`.
    """
    import shutil

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    moved = []
    for original in (path, meta_path(path)):
        if original in moved or not original.exists():
            continue
        destination = TRASH / stamp / original.relative_to(LIBRARY)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(original), str(destination))
        moved.append(destination)
    return moved


def deleted_at(batch_name):
    """20260916-215952 -> 2026-09-16 21:59, or the raw name if it is not one."""
    try:
        return datetime.strptime(batch_name, "%Y%m%d-%H%M%S").strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return batch_name


def trashed():
    """What is in the trash: one entry per deleted node, newest first.

    A node's files sit under <stamp>/<the path they had in the library>, so the
    id is the stem of the first non-sidecar file in each batch.
    """
    entries = []
    for batch in sorted(TRASH.iterdir() if TRASH.is_dir() else [], reverse=True):
        if not batch.is_dir():
            continue
        files = sorted(path for path in batch.rglob("*") if path.is_file())
        originals = [path for path in files
                     if not (path.suffix == SIDECAR and path.with_suffix("").exists())]
        if not originals:
            continue
        entries.append({
            "id": originals[0].stem,
            "batch": batch.name,
            "deleted": deleted_at(batch.name),
            "files": [str(path.relative_to(batch)) for path in files],
        })
    return entries


def restore(batch_name):
    """Move a trashed batch back where it came from. Returns the restored paths."""
    import shutil

    batch = TRASH / batch_name
    if ".." in batch_name or not batch.is_dir():
        raise FileNotFoundError(batch_name)
    restored = []
    for path in sorted(p for p in batch.rglob("*") if p.is_file()):
        destination = LIBRARY / path.relative_to(batch)
        if destination.exists():
            raise FileExistsError(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(destination))
        restored.append(destination)
    shutil.rmtree(batch, ignore_errors=True)
    return restored


def empty_trash():
    """Delete the trash for real. The only place in this codebase that does."""
    import shutil

    count = len([path for path in TRASH.rglob("*") if path.is_file()]) if TRASH.is_dir() else 0
    shutil.rmtree(TRASH, ignore_errors=True)
    return count


def write_meta(path, updates):
    """Update front matter in place, keeping the body and any keys we don't know."""
    target = meta_path(path)
    raw = target.read_text(encoding="utf-8") if target.exists() else ""
    fields, body = front_matter(raw)
    if not FRONT_MATTER.match(raw):
        body = raw  # no front matter yet: the whole file is body
    fields.update({k: v for k, v in updates.items() if v is not None})

    block = "\n".join(f"{key}: {value}" for key, value in fields.items())
    body = body.lstrip("\n")
    rewritten = f"---\n{block}\n---\n" + (f"\n{body}" if body else "")
    return write_atomic(target, rewritten)


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
            # "plate.jpg.md" is metadata for "plate.jpg", not a node of its own.
            if path.suffix == SIDECAR and path.with_suffix("").exists():
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
                "tags": [t.strip() for t in meta.get("tags", "").split(",") if t.strip()],
                "date": meta.get("date", date_cls.fromtimestamp(path.stat().st_mtime).isoformat()),
                "path": str(path.relative_to(LIBRARY)),
                "media": media_kind(path),
                "fingerprint": fingerprint(path),
                "links": read_links(body),
            }
            # Tags are part of what a document is about, so they belong in the
            # text that gets embedded, not only in the metadata.
            labels = ", ".join(node["tags"])
            text = "\n\n".join(part for part in (node["title"], labels, body) if part).strip()
            found.append((node, text or node["title"]))
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
    return {**{k: node[k] for k in fields}, "tags": ", ".join(node["tags"]),
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
        for target, kind in node.pop("links"):
            if target not in by_id or target == node["id"] or (node["id"], target) in seen:
                continue
            seen.add((node["id"], target))
            edges.append({
                "source": node["id"],
                "target": target,
                "type": kind or EDGE_BY_TARGET.get(by_id[target]["type"], "SPARK"),
            })

    span = (min(coords.months(n["date"]) for n in nodes),
            max(coords.months(n["date"]) for n in nodes))
    for i, node in enumerate(nodes):
        node["coordinates"] = {
            "semantic": semantic[i],
            "ontological": coords.ontological(i, node["type"], node["domain"], node["importance"]),
            "temporal": coords.temporal(node["date"], node["domain"], node["importance"], span),
        }
    return {"nodes": nodes, "edges": edges}


def reopen_store():
    """Drop Chroma's process-wide client cache before reading the store.

    The API server ingests in-process, but watch.py and a manual `python
    ingest.py` write the same embedded database from another process. A client
    cached from before their write points at segments that are no longer there,
    and Chroma answers with "Error finding id" on the next read.
    """
    try:
        from chromadb.api.client import SharedSystemClient

        SharedSystemClient.clear_system_cache()
    except Exception as error:  # a Chroma version without it is not a reason to stop
        print(f"could not reset the vector store client: {error}", flush=True)


def main(refit=False):
    reopen_store()
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
