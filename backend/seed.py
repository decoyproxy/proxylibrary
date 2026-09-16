"""Generate data/graph.json seed. ponytail: deterministic fake coords until Phase 2 UMAP."""
import json
import math
import random
from pathlib import Path

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

# Ontological view: type = vertical layer, domain = angular sector.
LAYER = {"Project": 90.0, "Concept": 30.0, "Source": -30.0, "Fragment": -70.0, "Asset": -110.0}
SECTOR = {"Art": 0, "Philosophy": 1, "Science": 2}
# Semantic view: topical cluster centers.
CLUSTER = {
    "umwelt": (70, 20, -30),
    "photo": (-60, -10, 40),
    "machine": (10, 60, 70),
    "decoy": (-20, -60, -60),
}
EPOCH = 2025 * 12  # months


def months(date):
    y, m, _ = (int(p) for p in date.split("-"))
    return y * 12 + m - EPOCH


def build():
    rng = random.Random(42)
    nodes = []
    for i, (nid, title, ntype, imp, domain, date, cluster) in enumerate(NODES):
        cx, cy, cz = CLUSTER[cluster]
        spread = 26
        angle = (SECTOR[domain] * 120 + i * 7) * 3.14159 / 180
        radius = 40 + (5 - imp) * 14
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
                "ontological": {
                    "x": round(radius * math.cos(angle), 1),
                    "y": LAYER[ntype],
                    "z": round(radius * math.sin(angle), 1),
                },
                "temporal": {
                    "x": round(months(date) * 14 - 90, 1),
                    "y": round((imp - 3) * 22, 1),
                    "z": round(SECTOR[domain] * 55 - 55, 1),
                },
            },
        })
    edges = [{"source": s, "target": t, "type": k} for s, t, k in EDGES]
    return {"nodes": nodes, "edges": edges}


if __name__ == "__main__":
    out = Path(__file__).parent / "data" / "graph.json"
    out.write_text(json.dumps(build(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {out} ({len(NODES)} nodes, {len(EDGES)} edges)")
