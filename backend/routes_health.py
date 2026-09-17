"""Cheap process, graph and vector-store health checks."""

import time
from functools import lru_cache

from fastapi import APIRouter

import ingest
import store


router = APIRouter(prefix="/api/v1/system", tags=["system"])
CACHE_SECONDS = 5


def has_semantic_xyz(node):
    point = node.get("coordinates", {}).get("semantic", {})
    return all(isinstance(point.get(axis), (int, float)) for axis in ("x", "y", "z"))


@lru_cache(maxsize=1)
def status_snapshot(_graph_mtime_ns, _cache_slot):
    started = time.perf_counter()
    errors = []
    try:
        graph = store.load()
        nodes, edges = graph["nodes"], graph["edges"]
        updated = graph.get("umap_updated_at")
        if not updated:
            errors.append("graph: missing umap_updated_at")
    except Exception as error:
        nodes, edges = [], []
        updated = None
        errors.append(f"graph: {type(error).__name__}")
    graph_load_ms = round((time.perf_counter() - started) * 1000, 3)

    text_vectors = clip_vectors = None
    try:
        text_vectors = ingest.collection().count()
        clip_vectors = ingest.clip_collection().count()
    except Exception as error:
        errors.append(f"chromadb: {type(error).__name__}")

    geometry_nodes = sum(has_semantic_xyz(node) for node in nodes)
    index_warmed = text_vectors is not None and clip_vectors is not None
    vectors_synced = index_warmed and text_vectors == clip_vectors == len(nodes)
    return {
        "status": (
            "ok" if not errors and geometry_nodes == len(nodes) and vectors_synced else "degraded"
        ),
        "node_count": len(nodes),
        "edge_count": len(edges),
        "umap_updated_at": updated,
        "geometry_3d_nodes": geometry_nodes,
        "graph_load_ms": graph_load_ms,
        "chromadb": {
            "healthy": index_warmed,
            "synced": vectors_synced,
            "text_vectors": text_vectors,
            "clip_vectors": clip_vectors,
        },
        "hybrid_search": {
            "index_warmed": index_warmed,
            "memory_loaded": ingest._clip is not None,
        },
        "errors": errors,
    }


@router.get("/status")
def system_status():
    modified = store.DATA.stat().st_mtime_ns if store.DATA.exists() else 0
    return status_snapshot(modified, int(time.monotonic() // CACHE_SECONDS))
