"""Read-only node text endpoints."""

from fastapi import APIRouter, HTTPException

import ingest
import ocr
import store


router = APIRouter(prefix="/api/v1/nodes", tags=["nodes"])


def clean(text):
    return "\n".join(line.strip() for line in text.splitlines()).strip()


def extract_text(raw):
    """Split a sidecar into marker-free machine text and handwritten notes."""
    _, body = ingest.front_matter(raw)
    if ocr.BEGIN not in body:
        return "", clean(body.replace(ocr.END, ""))
    before, block = body.split(ocr.BEGIN, 1)
    if ocr.END not in block:
        return "", clean(before)
    machine, after = block.split(ocr.END, 1)
    note = "\n\n".join(part.strip() for part in (before, after) if part.strip())
    return clean(machine), clean(note)


def node_file(node_id):
    node = next((item for item in store.load()["nodes"] if item["id"] == node_id), None)
    if not node or not node.get("path"):
        raise HTTPException(404, f"no node {node_id}")
    root = ingest.LIBRARY.resolve()
    path = (root / node["path"]).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(404, f"no file for node {node_id}")
    return path


@router.get("/{node_id}/ocr")
def node_ocr(node_id: str):
    sidecar = ingest.meta_path(node_file(node_id))
    raw = sidecar.read_text(encoding="utf-8", errors="replace") if sidecar.exists() else ""
    ocr_text, note_text = extract_text(raw)
    return {
        "id": node_id,
        "has_ocr": bool(ocr_text),
        "ocr_text": ocr_text,
        "has_note": bool(note_text),
        "note_text": note_text,
    }
