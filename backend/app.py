import os
import subprocess
import sys
import threading
from contextlib import contextmanager
from functools import wraps
from datetime import date as date_cls

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

import ingest
import hybrid_search
import store
from routes_nodes import router as nodes_router
from routes_presets import router as presets_router
from routes_validator import router as validator_router

QUERY_PREFIX = os.environ.get("QUERY_PREFIX", "query: ")

app = FastAPI(title="proxylibrary")
app.include_router(nodes_router)
app.include_router(presets_router)
app.include_router(validator_router)
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"]
)

# One request at a time may use the models and the vector store. Overlapping
# ingests interleave their writes and leave the store describing a library that
# never existed — and worse, two threads running inference on MPS at once take
# the whole process down with a Metal assertion (seen: two bulk edits fired
# together killed the server mid-embed). FastAPI runs these endpoints in a
# threadpool, so "at once" is the normal case, not a rare one. The browser locks
# its own UI while a rebuild runs, but another tab, a curl or watch.py are not
# covered by that.
_models = threading.Lock()
INGEST_WAIT = float(os.environ.get("INGEST_WAIT", 180))


def serialized(handler):
    """Run this handler with the models and the vector store to itself."""

    @wraps(handler)
    def waits_its_turn(*args, **kwargs):
        with rebuilding():
            return handler(*args, **kwargs)

    return waits_its_turn


@contextmanager
def rebuilding():
    if not _models.acquire(timeout=INGEST_WAIT):
        raise HTTPException(503, "the library is still rebuilding — try again in a moment")
    try:
        yield
    finally:
        _models.release()


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


DOMAINS = ("Art", "Science", "Philosophy")
RELATIONS = ("SPARK", "RESEARCH", "ASSEMBLE")


class Link(BaseModel):
    target: str
    relation: str

    @field_validator("relation")
    @classmethod
    def known_relation(cls, value):
        if value not in RELATIONS:
            raise ValueError(f"relation must be one of {', '.join(RELATIONS)}")
        return value


class Edit(BaseModel):
    """What the inspector is allowed to change. Everything else is off limits:
    this writes to the reader's own research files."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    date: str | None = None
    importance: int | None = Field(default=None, ge=1, le=5)
    domain: str | None = None
    tags: list[str] | None = None

    @field_validator("title")
    @classmethod
    def single_line(cls, value):
        # Front matter is one `key: value` per line, so a newline in a title
        # would turn the rest of it into a bogus key.
        if "\n" in value or not value.strip():
            raise ValueError("title must be a single non-empty line")
        return value.strip()

    @field_validator("date")
    @classmethod
    def real_date(cls, value):
        try:
            return date_cls.fromisoformat(value).isoformat()
        except ValueError:
            raise ValueError("date must be YYYY-MM-DD") from None

    @field_validator("domain")
    @classmethod
    def known_domain(cls, value):
        if value not in DOMAINS:
            raise ValueError(f"domain must be one of {', '.join(DOMAINS)}")
        return value

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, values):
        tags = [t.strip() for t in values if t.strip()]
        if len(tags) > 20 or any(len(t) > 40 for t in tags):
            raise ValueError("at most 20 tags, 40 characters each")
        if any("," in t or "\n" in t for t in tags):
            raise ValueError("tags cannot contain commas or newlines")
        return tags


@app.get("/api/v1/nodes")
def nodes():
    return store.load()


def regraph(written, node_id):
    """Re-ingest and answer with the whole graph: an edge belongs to two nodes,
    so the caller cannot patch its own copy from one of them."""
    ingest.main()
    graph = store.load()
    global _collection
    _collection = None
    return {
        "node": next((n for n in graph["nodes"] if n["id"] == node_id), None),
        "nodes": graph["nodes"],
        "edges": graph["edges"],
        "wrote": str(written.relative_to(ingest.LIBRARY)),
    }


@app.post("/api/v1/nodes/{node_id}/links")
@serialized
def add_link(node_id: str, link: Link):
    """Write the relation into the note as `- [RELATION] [[target]]`."""
    source = library_file(node_id)
    if link.target == node_id:
        raise HTTPException(400, "a node cannot link to itself")
    if not any(n["id"] == link.target for n in store.load()["nodes"]):
        raise HTTPException(404, f"no node {link.target}")
    return regraph(ingest.set_link(source, link.target, link.relation), node_id)


@app.delete("/api/v1/nodes/{node_id}/links/{target}")
@serialized
def remove_link(node_id: str, target: str):
    """Remove a link that sits on a line of its own; leave prose alone."""
    written = ingest.drop_link(library_file(node_id), target)
    if not written:
        raise HTTPException(
            409,
            f"{target} is linked from inside a sentence, not on a line of its own — "
            "edit the note itself so the writing is not lost",
        )
    return regraph(written, node_id)


class NewNode(BaseModel):
    """A note made from the galaxy rather than from the Finder."""

    type: str
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=20000)
    tags: list[str] = Field(default_factory=list)

    @field_validator("type")
    @classmethod
    def known_type(cls, value):
        if value not in ingest.TYPES:
            raise ValueError(f"type must be one of {', '.join(ingest.TYPES)}")
        return value

    @field_validator("title")
    @classmethod
    def single_line(cls, value):
        if "\n" in value or not value.strip():
            raise ValueError("title must be a single non-empty line")
        return value.strip()

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, values):
        return Edit.clean_tags(values)


@app.post("/api/v1/nodes", status_code=201)
@serialized
def create_node(new: NewNode):
    """Write a new note to the library and let the ingest place it.

    Its position comes from what it says, like every other node — there is no
    way to put a node somewhere in the galaxy, only to write something that
    belongs there.
    """
    try:
        written = ingest.new_note(new.type, new.title, new.body, new.tags)
    except FileExistsError as clash:
        raise HTTPException(409, f"{clash} already exists") from None
    graph = regraph(written, written.stem)
    if not graph["node"]:
        raise HTTPException(500, f"{written.stem} did not come back from the ingest")
    return graph


class BulkEdit(BaseModel):
    """One change applied to many notes. Tags are added and removed rather than
    replaced: the selection's notes do not share a tag list to overwrite."""

    ids: list[str] = Field(min_length=1, max_length=500)
    domain: str | None = None
    add_tags: list[str] = Field(default_factory=list)
    remove_tags: list[str] = Field(default_factory=list)

    @field_validator("domain")
    @classmethod
    def known_domain(cls, value):
        if value not in DOMAINS:
            raise ValueError(f"domain must be one of {', '.join(DOMAINS)}")
        return value

    @field_validator("add_tags", "remove_tags")
    @classmethod
    def clean_tags(cls, values):
        tags = [tag.strip() for tag in values if tag.strip()]
        if len(tags) > 20 or any(len(tag) > 40 for tag in tags):
            raise ValueError("at most 20 tags, 40 characters each")
        if any("," in tag or "\n" in tag for tag in tags):
            raise ValueError("tags cannot contain commas or newlines")
        return tags


class Bulk(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


def whole_graph(extra):
    """Every bulk action rewrites many files and then ingests once — the ingest
    is the expensive part, and doing it per file would make a selection of fifty
    notes unusable."""
    ingest.main()
    graph = store.load()
    global _collection
    _collection = None
    return {**extra, "nodes": graph["nodes"], "edges": graph["edges"]}


@app.patch("/api/v1/nodes")
@serialized
def edit_many(edit: BulkEdit):
    if not (edit.domain or edit.add_tags or edit.remove_tags):
        raise HTTPException(400, "nothing to change")
    known = {node["id"]: node for node in store.load()["nodes"]}
    missing = [node_id for node_id in edit.ids if node_id not in known]
    if missing:
        raise HTTPException(404, f"no such nodes: {', '.join(missing[:5])}")

    changed = []
    for node_id in edit.ids:
        node = known[node_id]
        updates = {}
        if edit.domain:
            updates["domain"] = edit.domain
        if edit.add_tags or edit.remove_tags:
            tags = [tag for tag in node.get("tags", []) if tag not in edit.remove_tags]
            tags += [tag for tag in edit.add_tags if tag not in tags]
            updates["tags"] = ", ".join(tags)
        if updates:
            ingest.write_meta(library_file(node_id), updates)
            changed.append(node_id)
    return whole_graph({"changed": changed})


@app.delete("/api/v1/nodes")
@serialized
def delete_many(bulk: Bulk):
    trashed = []
    for node_id in bulk.ids:
        for path in ingest.trash(library_file(node_id)):
            trashed.append(str(path.relative_to(ingest.DATA)))
    if not trashed:
        raise HTTPException(404, "nothing on disk for those nodes")
    return whole_graph({"removed": bulk.ids, "trashed": trashed})


@app.get("/api/v1/trash")
def list_trash():
    return {"entries": ingest.trashed()}


@app.post("/api/v1/trash/restore/{batch}")
@serialized
def restore_trash(batch: str):
    """Put a deleted node's files back and re-ingest it into the graph."""
    try:
        restored = ingest.restore(batch)
    except FileNotFoundError:
        raise HTTPException(404, f"no such batch in the trash: {batch}") from None
    except FileExistsError as clash:
        raise HTTPException(409, f"{clash} is back in the library already") from None
    ingest.main()
    graph = store.load()
    global _collection
    _collection = None
    return {
        "restored": [str(path.relative_to(ingest.LIBRARY)) for path in restored],
        "nodes": graph["nodes"],
        "edges": graph["edges"],
        "entries": ingest.trashed(),
    }


@app.delete("/api/v1/trash")
def clear_trash():
    """Erase the trash. This one really does delete."""
    return {"erased": ingest.empty_trash(), "entries": ingest.trashed()}


@app.delete("/api/v1/nodes/{node_id}")
@serialized
def delete_node(node_id: str):
    """Move the node's files to the trash and rebuild the graph without it.

    Links in *other* notes that pointed here are left exactly as written — they
    are someone's sentences, and a dangling [[link]] simply stops being an edge.
    """
    target = library_file(node_id)
    moved = ingest.trash(target)
    if not moved:
        raise HTTPException(404, f"nothing on disk for {node_id}")
    ingest.main()
    graph = store.load()
    global _collection
    _collection = None
    return {
        "removed": node_id,
        "trashed": [str(path.relative_to(ingest.DATA)) for path in moved],
        "nodes": graph["nodes"],
        "edges": graph["edges"],
    }


@app.patch("/api/v1/nodes/{node_id}")
@serialized
def edit_node(node_id: str, edit: Edit):
    """Write the change back to the file, then re-ingest and return the node.

    The file is the source of truth, so it is updated first and everything else
    is derived from it — no path where the graph claims something the note on
    disk does not say. Re-ingest is incremental: the edited file is the only one
    whose vectors are recomputed, and every other node keeps its position.
    """
    changes = edit.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "nothing to change")
    target = library_file(node_id)
    if "tags" in changes:
        changes["tags"] = ", ".join(changes["tags"])

    written = ingest.write_meta(target, changes)
    ingest.main()
    updated = next((n for n in store.load()["nodes"] if n["id"] == node_id), None)
    if not updated:
        raise HTTPException(500, f"{node_id} vanished from the graph after the edit")
    global _collection
    _collection = None  # the collection handle outlives the re-ingest; the data does not
    return {"node": updated, "wrote": str(written.relative_to(ingest.LIBRARY))}


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
@serialized
def search(q: str, limit: int = 8):
    """Semantic search over the vectors the last ingest stored. No re-embedding of the corpus."""
    collection = library()
    if not q.strip():
        return {"query": q, "results": []}
    # Searching runs the same models an ingest does, so it waits its turn rather
    # than racing one. First call loads the model; later ones reuse it.
    found = collection.query(
        query_embeddings=ingest.embed([q], prefix=QUERY_PREFIX),
        n_results=min(limit, max(collection.count(), 1)),
    )
    images = search_images(q, limit)
    return {
        "query": q,
        "images": images,
        "results": [
            {"id": nid, "title": meta.get("title", nid), "type": meta.get("type"),
             "score": round(1 - distance, 3)}
            for nid, meta, distance in zip(
                found["ids"][0], found["metadatas"][0], found["distances"][0]
            )
        ],
    }


@app.get("/api/v1/search/hybrid")
@serialized
def search_hybrid(q: str, limit: int = 8):
    return hybrid_search.search(q, limit, library())
