"""Validate the local proxylibrary ontology without changing the library."""
import json
import re
from pathlib import Path

import ingest

DOMAINS = {"Art", "Science", "Philosophy"}
RELATIONS = {"SPARK", "RESEARCH", "ASSEMBLE"}
RELATION_CANDIDATE = re.compile(r"\[([A-Za-z_]+)\]\s*\[\[")


def _documents(root):
    """Yield actual nodes and their metadata text; sidecars are not nodes."""
    for folder in sorted(p for p in root.iterdir() if p.is_dir()) if root.is_dir() else []:
        if not ingest.node_type(folder.name):
            continue
        for path in sorted(folder.rglob("*")):
            if not path.is_file() or path.name.startswith(".") or not ingest.media_kind(path):
                continue
            if path.suffix == ingest.SIDECAR and path.with_suffix("").exists():
                continue
            metadata = ingest.meta_path(path)
            raw = metadata.read_text(encoding="utf-8", errors="replace") if metadata.exists() else ""
            yield path, raw


def scan(root=ingest.LIBRARY):
    root = Path(root)
    documents = list(_documents(root))
    ids = {path.stem for path, _ in documents}
    degree = {node_id: 0 for node_id in ids}
    domains, relations, broken = [], [], []

    for path, raw in documents:
        node_id = path.stem
        relative = str(path.relative_to(root))
        meta, body = ingest.front_matter(raw)
        domain = meta.get("domain")
        if domain not in DOMAINS:
            domains.append({"id": node_id, "path": relative, "value": domain})

        for line_number, line in enumerate(body.splitlines(), 1):
            match = ingest.LINK_LINE.match(line)
            targets = [target.strip().split("|", 1)[0] for target in ingest.WIKI_LINK.findall(line)]
            if match:
                relation = match.group("kind")
                if relation not in RELATIONS:
                    relations.append({
                        "id": node_id, "path": relative, "line": line_number,
                        "value": relation, "text": line.strip(),
                    })
            elif targets and RELATION_CANDIDATE.search(line):
                relations.append({
                    "id": node_id, "path": relative, "line": line_number,
                    "value": RELATION_CANDIDATE.search(line).group(1), "text": line.strip(),
                })

            for target in targets:
                if target not in ids:
                    broken.append({
                        "id": node_id, "path": relative, "line": line_number, "target": target,
                    })
                elif target != node_id:
                    degree[node_id] += 1
                    degree[target] += 1

    isolated = [
        {"id": path.stem, "path": str(path.relative_to(root))}
        for path, _ in documents if degree[path.stem] == 0
    ]
    issues = {
        "domains": domains,
        "relations": relations,
        "broken_links": broken,
        "isolated_nodes": isolated,
    }
    return {
        "healthy": not any(issues.values()),
        "root": str(root.resolve()),
        "scanned": len(documents),
        "counts": {name: len(found) for name, found in issues.items()},
        "issues": issues,
    }


def demo():
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as directory:
        root = Path(directory)
        fragments = root / "Fragments"
        fragments.mkdir()
        (fragments / "A.md").write_text(
            "---\ndomain: Art\n---\n\n- [SPARK] [[B]]\n- [[MISSING]]\n", encoding="utf-8"
        )
        (fragments / "B.md").write_text("---\ndomain: Wrong\n---\n", encoding="utf-8")
        (fragments / "C.md").write_text("---\ndomain: Science\n---\n", encoding="utf-8")
        result = scan(root)
        assert result["counts"] == {
            "domains": 1, "relations": 1, "broken_links": 1, "isolated_nodes": 1,
        }, result
        assert result["issues"]["isolated_nodes"][0]["id"] == "C"
    print("validator ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        demo()
    else:
        print(json.dumps(scan(Path(sys.argv[1]) if len(sys.argv) > 1 else ingest.LIBRARY), indent=2))
