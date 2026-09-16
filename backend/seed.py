"""The seed corpus, in one place.

`python seed.py` writes two things from the same list:
  data/graph.json  - placeholder graph, so the frontend runs with no model installed
  data/library/    - the same corpus as markdown, as input for ingest.py

Real coordinates come from ingest.py; the semantic ones here are deterministic
fakes (clustered by topic) standing in until embeddings are computed.
"""
import json
import random
from pathlib import Path

import coords

# (id, title, type, importance, domain, date, cluster)
NODES = [
    ("PRJ_UMWELT", "UMWELT", "Project", 5, "Art", "2026-01-10", "umwelt"),
    ("PRJ_DECOY", "Decoy Proxy", "Project", 4, "Art", "2025-06-02", "decoy"),
    ("CON_NONHUMAN", "Non-human perception", "Concept", 5, "Philosophy", "2025-08-14", "umwelt"),
    ("CON_MATERIALITY", "Materiality of photography", "Concept", 5, "Art", "2025-09-01", "photo"),
    ("CON_UEXKULL", "Umwelt (von Uexkull)", "Concept", 4, "Philosophy", "2025-08-20", "umwelt"),
    ("CON_MACHINE_VISION", "Machine vision", "Concept", 4, "Science", "2025-10-05", "machine"),
    ("CON_INDEXICALITY", "Indexicality", "Concept", 3, "Art", "2025-09-18", "photo"),
    ("CON_LATENT", "Latent space", "Concept", 3, "Science", "2025-11-11", "machine"),
    ("SRC_2026_001", "Non-Human Perception Paper", "Source", 5, "Science", "2026-01-04", "umwelt"),
    ("SRC_UEXKULL_BOOK", "A Foray into the Worlds of Animals and Humans", "Source", 4, "Philosophy", "2025-08-19", "umwelt"),
    ("SRC_FLUSSER", "Towards a Philosophy of Photography", "Source", 4, "Philosophy", "2025-09-02", "photo"),
    ("SRC_PAGLEN", "Trevor Paglen - Invisible Images", "Source", 4, "Art", "2025-10-07", "machine"),
    ("SRC_CLIP", "Learning Transferable Visual Models (CLIP)", "Source", 3, "Science", "2025-11-09", "machine"),
    ("SRC_PHOTOBOOK_A", "Photobook reference: Provoke", "Source", 2, "Art", "2025-07-21", "photo"),
    ("FRG_TICK", "Note: the tick only senses three things", "Fragment", 3, "Philosophy", "2025-08-21", "umwelt"),
    ("FRG_CAMERA_EYE", "Dump: camera is not an eye", "Fragment", 3, "Art", "2025-09-03", "photo"),
    ("FRG_AI_CHAT_01", "AI chat log: what does a sensor want", "Fragment", 2, "Science", "2025-10-12", "machine"),
    ("FRG_STUDIO_01", "Studio note: darkroom smell as data", "Fragment", 2, "Art", "2025-09-25", "photo"),
    ("FRG_WALK_01", "KakaoTalk dump: night walk, IR trail cam", "Fragment", 2, "Art", "2025-12-02", "umwelt"),
    ("AST_RAW_0431", "RAW_0431.ARW - forest IR plate", "Asset", 3, "Art", "2025-12-03", "umwelt"),
    ("AST_RAW_0522", "RAW_0522.ARW - lens flare study", "Asset", 2, "Art", "2025-12-09", "photo"),
    ("AST_SCRIPT_EMB", "embed_gallery.py", "Asset", 3, "Science", "2026-01-08", "machine"),
    ("AST_VIDEO_01", "umwelt_test_render.mp4", "Asset", 3, "Art", "2026-01-12", "umwelt"),
    ("AST_PRINT_01", "Print test - platinum palladium", "Asset", 2, "Art", "2026-02-01", "photo"),
]

EDGES = [
    ("SRC_2026_001", "FRG_TICK", "SPARK"),
    ("SRC_UEXKULL_BOOK", "FRG_TICK", "SPARK"),
    ("SRC_FLUSSER", "FRG_CAMERA_EYE", "SPARK"),
    ("SRC_PAGLEN", "FRG_AI_CHAT_01", "SPARK"),
    ("SRC_CLIP", "FRG_AI_CHAT_01", "SPARK"),
    ("SRC_PHOTOBOOK_A", "FRG_STUDIO_01", "SPARK"),
    ("SRC_2026_001", "FRG_WALK_01", "SPARK"),
    ("SRC_2026_001", "CON_NONHUMAN", "RESEARCH"),
    ("SRC_UEXKULL_BOOK", "CON_UEXKULL", "RESEARCH"),
    ("SRC_FLUSSER", "CON_MATERIALITY", "RESEARCH"),
    ("SRC_FLUSSER", "CON_INDEXICALITY", "RESEARCH"),
    ("SRC_PAGLEN", "CON_MACHINE_VISION", "RESEARCH"),
    ("SRC_CLIP", "CON_LATENT", "RESEARCH"),
    ("FRG_AI_CHAT_01", "CON_MACHINE_VISION", "RESEARCH"),
    ("CON_UEXKULL", "CON_NONHUMAN", "RESEARCH"),
    ("CON_NONHUMAN", "PRJ_UMWELT", "ASSEMBLE"),
    ("CON_UEXKULL", "PRJ_UMWELT", "ASSEMBLE"),
    ("CON_MACHINE_VISION", "PRJ_UMWELT", "ASSEMBLE"),
    ("FRG_TICK", "PRJ_UMWELT", "ASSEMBLE"),
    ("FRG_WALK_01", "PRJ_UMWELT", "ASSEMBLE"),
    ("AST_RAW_0431", "PRJ_UMWELT", "ASSEMBLE"),
    ("AST_VIDEO_01", "PRJ_UMWELT", "ASSEMBLE"),
    ("AST_SCRIPT_EMB", "PRJ_UMWELT", "ASSEMBLE"),
    ("CON_MATERIALITY", "PRJ_DECOY", "ASSEMBLE"),
    ("CON_INDEXICALITY", "PRJ_DECOY", "ASSEMBLE"),
    ("FRG_CAMERA_EYE", "PRJ_DECOY", "ASSEMBLE"),
    ("FRG_STUDIO_01", "PRJ_DECOY", "ASSEMBLE"),
    ("AST_PRINT_01", "PRJ_DECOY", "ASSEMBLE"),
    ("AST_RAW_0522", "PRJ_DECOY", "ASSEMBLE"),
    ("CON_LATENT", "PRJ_DECOY", "ASSEMBLE"),
]

# A few tags, so a fresh clone has something for the tag filter to show.
TAGS = {
    "PRJ_UMWELT": ["umwelt", "fieldwork"],
    "PRJ_DECOY": ["darkroom", "print"],
    "CON_NONHUMAN": ["umwelt", "perception"],
    "CON_UEXKULL": ["umwelt", "perception"],
    "CON_MATERIALITY": ["darkroom", "print", "materiality"],
    "CON_MACHINE_VISION": ["machine vision", "perception"],
    "CON_INDEXICALITY": ["materiality"],
    "CON_LATENT": ["machine vision", "embedding"],
    "SRC_2026_001": ["umwelt", "perception"],
    "SRC_UEXKULL_BOOK": ["umwelt", "perception"],
    "SRC_FLUSSER": ["materiality", "print"],
    "SRC_PAGLEN": ["machine vision"],
    "SRC_CLIP": ["machine vision", "embedding"],
    "SRC_PHOTOBOOK_A": ["print"],
    "FRG_TICK": ["umwelt", "perception"],
    "FRG_CAMERA_EYE": ["perception", "materiality"],
    "FRG_AI_CHAT_01": ["machine vision", "embedding"],
    "FRG_STUDIO_01": ["darkroom", "materiality"],
    "FRG_WALK_01": ["fieldwork", "night"],
    "AST_RAW_0431": ["fieldwork", "night"],
    "AST_RAW_0522": ["print"],
    "AST_SCRIPT_EMB": ["embedding"],
    "AST_VIDEO_01": ["umwelt", "fieldwork"],
    "AST_PRINT_01": ["darkroom", "print"],
}

# Semantic view stand-in: topical cluster centers.
CLUSTER = {
    "umwelt": (70, 20, -30),
    "photo": (-60, -10, 40),
    "machine": (10, 60, 70),
    "decoy": (-20, -60, -60),
}


def build():
    rng = random.Random(42)
    nodes = []
    for i, (nid, title, ntype, imp, domain, date, cluster) in enumerate(NODES):
        cx, cy, cz = CLUSTER[cluster]
        spread = 26
        nodes.append({
            "id": nid,
            "title": title,
            "type": ntype,
            "importance": imp,
            "domain": domain,
            "date": date,
            "coordinates": {
                "semantic": {
                    "x": round(cx + rng.uniform(-spread, spread), 1),
                    "y": round(cy + rng.uniform(-spread, spread), 1),
                    "z": round(cz + rng.uniform(-spread, spread), 1),
                },
                "ontological": coords.ontological(i, ntype, domain, imp),
                "temporal": coords.temporal(date, domain, imp),
            },
        })
    edges = [{"source": s, "target": t, "type": k} for s, t, k in EDGES]
    return {"nodes": nodes, "edges": edges}


def write_library(root):
    """Emit the same corpus as markdown so ingest.py has something to chew on."""
    links = {}
    for source, target, _ in EDGES:
        links.setdefault(source, []).append(target)
    written = 0
    for nid, title, ntype, imp, domain, date, _ in NODES:
        folder = root / f"{ntype}s"
        folder.mkdir(parents=True, exist_ok=True)
        body = "\n".join(f"- [[{t}]]" for t in links.get(nid, [])) or "(no links yet)"
        tags = ", ".join(TAGS.get(nid, []))
        (folder / f"{nid}.md").write_text(
            f"---\ntitle: {title}\nimportance: {imp}\ndomain: {domain}\ndate: {date}\n"
            f"tags: {tags}\n---\n\n# {title}\n\n{body}\n",
            encoding="utf-8",
        )
        written += 1
    return written


if __name__ == "__main__":
    data = Path(__file__).parent / "data"
    out = data / "graph.json"
    out.write_text(json.dumps(build(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({len(NODES)} nodes, {len(EDGES)} edges)")
    print(f"wrote {write_library(data / 'library')} markdown files to {data / 'library'}")
