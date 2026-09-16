"""Read-only node text endpoints."""

from fastapi import APIRouter, HTTPException

import ingest
import ocr
import store


router = APIRouter(prefix="/api/v1/nodes", tags=["nodes"])


def extract_ocr(raw):
    """Return a marker-free OCR block with normalized line whitespace."""
    if ocr.BEGIN not in raw:
        return ""
    _, block = raw.split(ocr.BEGIN, 1)
    if ocr.END not in block:
        return ""
    block, _ = block.split(ocr.END, 1)
    return "\n".join(line.strip() for line in block.splitlines()).strip()


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
    text = extract_ocr(raw)
    return {"id": node_id, "has_ocr": bool(text), "ocr_text": text}
