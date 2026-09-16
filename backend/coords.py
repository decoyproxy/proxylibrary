"""Coordinate rules for the three view modes.

Shared by seed.py (placeholder data) and ingest.py (real files) so the two can
never drift apart. Only `semantic` needs embeddings; the other two are pure
metadata rules, which is why the galaxy still works before any model is loaded.
"""
import math
import os

# Ontological view: node type is a vertical layer, domain is an angular sector,
# importance pulls a node toward the axis.
LAYER = {"Project": 90.0, "Concept": 30.0, "Source": -30.0, "Fragment": -70.0, "Asset": -110.0}
SECTOR = {"Art": 0, "Philosophy": 1, "Science": 2}
EPOCH = 2025 * 12  # month zero of the temporal axis
SPAN = 100.0  # semantic coordinates are normalised into +/- SPAN
TEMPERATURE = 0.02  # how sharply place() favours the closest neighbour


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


def months(date):
    """A date as a month number, for measuring distances along the time axis."""
    year, month = (int(part) for part in date.split("-")[:2])
    return year * 12 + month


def temporal(date, domain, importance, span=None):
    """Time on x, importance on y, domain on z.

    `span` is the (earliest, latest) month in the library, and the axis is
    stretched to fit it. A fixed scale worked only while everything was dated
    within a year or two of now: a 1968 photobook — an ordinary thing in a
    research archive — landed 9,500 units off, and the camera then framed the
    rest of the galaxy as a dot.
    """
    # With no span there is no axis to place the date on — a lone node sits at
    # the start of its own timeline.
    first, last = span or (months(date), months(date))
    position = (months(date) - first) / max(last - first, 1)
    return {
        "x": round(position * 2 * SPAN - SPAN, 1),
        "y": round((importance - 3) * 22, 1),
        "z": round(sector(domain) * 55 - 55, 1),
    }


def join(text_vectors, clip_vectors, clip_mix):
    """Concatenate two embedding spaces into one joint space for UMAP.

    Text similarity comes from the text model, visual similarity from CLIP.
    Each half is L2-normalised and then weighted, so cosine distance over the
    result is the weighted sum of the two cosines — images end up close to the
    images they look like, and to the text whose CLIP reading matches them,
    without CLIP's weak long-text handling degrading text-to-text distances.

    clip_mix is CLIP's share, 0 (text only) to 1 (visual only).
    """
    import numpy as np

    def block(vectors, weight):
        array = np.asarray(vectors, dtype="float32")
        array /= np.maximum(np.linalg.norm(array, axis=1, keepdims=True), 1e-9)
        return array * weight

    return np.hstack([
        block(text_vectors, (1 - clip_mix) ** 0.5),
        block(clip_vectors, clip_mix ** 0.5),
    ]).tolist()


def semantic(vectors):
    """Project embeddings to 3D with UMAP, normalised into the +/- SPAN cube.

    This is the full projection, and it is not stable across runs: UMAP's
    optimisation is chaotic at this scale, and an input difference of 1e-6 — the
    float32 round-trip through the vector store is enough — moves nodes across
    the whole cube. Seeding it with the previous layout does not help, the
    optimiser walks away from any starting point. So a re-ingest keeps the old
    coordinates and uses `place()` for what changed; this runs only when the
    layout is rebuilt outright.

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

    # n_neighbors decides how local the layout is. A quarter of a small corpus
    # keeps visual clusters intact; 15 over 30 documents averages them away
    # (measured: same-family image distance ratio 0.66 at 15, 0.29 at 8).
    neighbors = int(os.environ.get("UMAP_NEIGHBORS", 0)) or min(15, max(4, n // 4))
    reduced = umap.UMAP(
        n_components=3, n_neighbors=min(neighbors, n - 1), min_dist=0.25, metric="cosine",
        random_state=42,
    ).fit_transform(np.asarray(vectors))
    lo, hi = reduced.min(axis=0), reduced.max(axis=0)
    scaled = (reduced - lo) / np.maximum(hi - lo, 1e-9) * (2 * SPAN) - SPAN
    return [{"x": round(float(x), 1), "y": round(float(y), 1), "z": round(float(z), 1)}
            for x, y, z in scaled]


def place(vectors, known_vectors, known_coords, k=5):
    """Position new or edited nodes among the nodes that did not move.

    Each one lands among its k nearest neighbours in the embedding space, nudged
    so two identical documents do not occupy exactly the same point. The weights
    are a sharp softmax rather than plain similarity: a flat mean of five
    neighbours lands in the empty middle between clusters, which is how a note
    about latent space ended up parked beside a lens flare photograph.

    Cheap, and it keeps every other node exactly where the reader last saw it —
    a full re-projection would move everything.
    """
    import numpy as np

    if not len(known_vectors):
        return None
    if not len(vectors):  # nothing moved: a delete-only or metadata-only ingest
        return []
    new = np.asarray(vectors, dtype="float32")
    old = np.asarray(known_vectors, dtype="float32")
    new /= np.maximum(np.linalg.norm(new, axis=1, keepdims=True), 1e-9)
    old /= np.maximum(np.linalg.norm(old, axis=1, keepdims=True), 1e-9)
    coordinates = np.asarray(
        [[c["x"], c["y"], c["z"]] for c in known_coords], dtype="float32"
    )
    rng = np.random.default_rng(42)
    nudge = float(np.linalg.norm(coordinates.std(axis=0))) * 0.03 + 1e-3

    placed = []
    for row in new @ old.T:
        top = np.argsort(row)[-min(k, len(row)):]
        weights = np.exp((row[top] - row[top].max()) / TEMPERATURE)
        centre = (coordinates[top] * weights[:, None]).sum(axis=0) / weights.sum()
        x, y, z = centre + rng.normal(0, nudge, 3)
        placed.append({"x": round(float(x), 1), "y": round(float(y), 1), "z": round(float(z), 1)})
    return placed


def demo():
    import numpy as np

    assert ontological(0, "Project", "Art", 5)["y"] == 90.0
    span = (months("2025-01-01"), months("2026-01-01"))
    assert temporal("2025-01-01", "Art", 3) == {"x": -100.0, "y": 0.0, "z": -55.0}
    assert temporal("2026-01-01", "Art", 3, span)["x"] == 100.0  # last month, far end
    assert temporal("2025-07-01", "Art", 3, span)["x"] == 0.0  # halfway
    # A much older document stretches the axis instead of flying off it.
    wide = (months("1968-01-01"), months("2026-01-01"))
    assert -100.0 <= temporal("1968-11-01", "Art", 3, wide)["x"] <= 100.0
    assert len(semantic([[0.0, 1.0]] * 3)) == 3  # small-input fallback, no UMAP
    # A new node lands next to the neighbour it matches, not at the origin.
    known = [[1.0, 0.0], [0.0, 1.0]]
    spots = [{"x": 50.0, "y": 0.0, "z": 0.0}, {"x": -50.0, "y": 0.0, "z": 0.0}]
    near = place([[0.99, 0.01]], known, spots, k=1)[0]
    assert near["x"] > 40, near
    # With a far-off second neighbour in range, the nearest still wins.
    both = place([[0.99, 0.01]], known, spots, k=2)[0]
    assert both["x"] > 40, both
    assert place([[1.0, 0.0]], [], [], k=1) is None
    assert place([], known, spots, k=1) == []

    # Two documents whose text differs but whose images match should sit closer
    # together in the joint space as clip_mix rises.
    text = [[1.0, 0.0], [0.0, 1.0]]
    clip = [[1.0, 0.0], [1.0, 0.0]]
    def gap(mix):
        a, b = np.asarray(join(text, clip, mix))
        return float(np.linalg.norm(a - b))
    assert gap(0.0) > gap(0.5) > gap(1.0), (gap(0.0), gap(0.5), gap(1.0))
    assert abs(gap(1.0)) < 1e-6  # identical images, identical position
    print("coords ok")


if __name__ == "__main__":
    demo()
