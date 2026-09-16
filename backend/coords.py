"""Coordinate rules for the three view modes.

Shared by seed.py (placeholder data) and ingest.py (real files) so the two can
never drift apart. Only `semantic` needs embeddings; the other two are pure
metadata rules, which is why the galaxy still works before any model is loaded.
"""
import math

# Ontological view: node type is a vertical layer, domain is an angular sector,
# importance pulls a node toward the axis.
LAYER = {"Project": 90.0, "Concept": 30.0, "Source": -30.0, "Fragment": -70.0, "Asset": -110.0}
SECTOR = {"Art": 0, "Philosophy": 1, "Science": 2}
EPOCH = 2025 * 12  # month zero of the temporal axis
SPAN = 100.0  # semantic coordinates are normalised into +/- SPAN


def sector(domain):
    return SECTOR.get(domain, len(SECTOR))


def ontological(index, node_type, domain, importance):
    angle = math.radians(sector(domain) * 120 + index * 7)
    radius = 40 + (5 - importance) * 14
    return {
        "x": round(radius * math.cos(angle), 1),
        "y": LAYER.get(node_type, -150.0),
        "z": round(radius * math.sin(angle), 1),
    }


def temporal(date, domain, importance):
    year, month = (int(p) for p in date.split("-")[:2])
    return {
        "x": round((year * 12 + month - EPOCH) * 14 - 90, 1),
        "y": round((importance - 3) * 22, 1),
        "z": round(sector(domain) * 55 - 55, 1),
    }


def semantic(vectors):
    """Project embeddings to 3D with UMAP, normalised into the +/- SPAN cube.

    Falls back to a spiral when there are too few documents for UMAP to fit.
    """
    n = len(vectors)
    if n < 5:
        return [
            {"x": round(SPAN * math.cos(i), 1), "y": round(i * 20 - SPAN, 1),
             "z": round(SPAN * math.sin(i), 1)}
            for i in range(n)
        ]
    import numpy as np
    import umap

    reduced = umap.UMAP(
        n_components=3, n_neighbors=min(15, n - 1), min_dist=0.25, metric="cosine",
        random_state=42,
    ).fit_transform(np.asarray(vectors))
    lo, hi = reduced.min(axis=0), reduced.max(axis=0)
    scaled = (reduced - lo) / np.maximum(hi - lo, 1e-9) * (2 * SPAN) - SPAN
    return [{"x": round(float(x), 1), "y": round(float(y), 1), "z": round(float(z), 1)}
            for x, y, z in scaled]


def demo():
    assert ontological(0, "Project", "Art", 5)["y"] == 90.0
    assert temporal("2025-01-01", "Art", 3) == {"x": -76.0, "y": 0.0, "z": -55.0}
    assert temporal("2026-01-01", "Art", 3)["x"] == 92.0  # a year later, further along x
    assert len(semantic([[0.0, 1.0]] * 3)) == 3  # small-input fallback, no UMAP
    print("coords ok")


if __name__ == "__main__":
    demo()
