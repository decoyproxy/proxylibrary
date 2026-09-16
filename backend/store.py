"""Graph storage. ponytail: single JSON file; swap for ChromaDB in Phase 2."""
import json
from pathlib import Path

DATA = Path(__file__).parent / "data" / "graph.json"
VIEWS = ("semantic", "ontological", "temporal")


def load():
    graph = json.loads(DATA.read_text(encoding="utf-8"))
    for node in graph["nodes"]:
        missing = [v for v in VIEWS if v not in node.get("coordinates", {})]
        if missing:
            raise ValueError(f"{node['id']} missing coordinates: {missing}")
    ids = {n["id"] for n in graph["nodes"]}
    for edge in graph["edges"]:
        weight = edge.get("weight")
        if weight is not None and not 0 <= weight <= 1:
            raise ValueError(f"edge weight out of range: {edge}")
    for edge in graph["edges"]:
        for end in ("source", "target"):
            if edge[end] not in ids:
                raise ValueError(f"edge references unknown node: {edge[end]}")
    return graph


def demo():
    g = load()
    assert g["nodes"] and g["edges"]
    print(f"ok: {len(g['nodes'])} nodes, {len(g['edges'])} edges")


if __name__ == "__main__":
    demo()
