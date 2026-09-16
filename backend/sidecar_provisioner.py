"""Create standard metadata sidecars for media that do not have one."""
import json
from datetime import date
from pathlib import Path

import ingest

MEDIA_SUFFIXES = ingest.IMAGE_SUFFIXES | ingest.PDF_SUFFIXES


def missing(root=ingest.LIBRARY):
    root = Path(root)
    return [
        path for path in sorted(root.rglob("*"))
        if path.is_file()
        and not any(part.startswith(".") for part in path.relative_to(root).parts)
        and path.suffix.lower() in MEDIA_SUFFIXES
        and not ingest.meta_path(path).exists()
    ]


def provision(root=ingest.LIBRARY):
    root = Path(root)
    created = []
    for asset in missing(root):
        sidecar = ingest.meta_path(asset)
        if sidecar.exists():
            continue
        title = asset.stem.replace("_", " ").replace("-", " ")
        modified = date.fromtimestamp(asset.stat().st_mtime).isoformat()
        ingest.write_atomic(
            sidecar,
            f"---\ntitle: {title}\nimportance: 3\ndomain: Art\ndate: {modified}\ntags: \n---\n",
        )
        created.append(str(sidecar.relative_to(root)))
    return created


def demo():
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as directory:
        root = Path(directory)
        assets = root / "Assets"
        assets.mkdir()
        (assets / "new-image.jpg").write_bytes(b"image")
        (assets / "kept.png").write_bytes(b"image")
        existing = assets / "kept.png.md"
        existing.write_text("keep me\n", encoding="utf-8")

        assert provision(root) == ["Assets/new-image.jpg.md"]
        made = (assets / "new-image.jpg.md").read_text(encoding="utf-8")
        assert "domain: Art" in made and "title: new image" in made
        assert provision(root) == []
        assert existing.read_text(encoding="utf-8") == "keep me\n"
        assert not list(assets.glob(".*.writing"))
    print("sidecar provisioner ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        demo()
    else:
        created = provision(Path(sys.argv[1]) if len(sys.argv) > 1 else ingest.LIBRARY)
        print(json.dumps({"created": created, "count": len(created)}, indent=2))
