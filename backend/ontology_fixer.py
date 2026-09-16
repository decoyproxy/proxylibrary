"""Apply the ontology defaults reported by validator.py."""
import json
from pathlib import Path

import ingest
import validator

DEFAULT_DOMAIN = "Art"
DEFAULT_RELATION = "RESEARCH"


def _set_domain(path):
    """Set domain while preserving every byte outside the front matter."""
    target = ingest.meta_path(path)
    raw = target.read_text(encoding="utf-8") if target.exists() else ""
    match = ingest.FRONT_MATTER.match(raw)
    if not match:
        return ingest.write_atomic(target, f"---\ndomain: {DEFAULT_DOMAIN}\n---\n{raw}")

    front = match.group(0)
    lines = front.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.lower().startswith("domain:"):
            ending = "\n" if line.endswith("\n") else ""
            lines[index] = f"domain: {DEFAULT_DOMAIN}{ending}"
            break
    else:
        lines.insert(-1, f"domain: {DEFAULT_DOMAIN}\n")
    return ingest.write_atomic(target, "".join(lines) + raw[match.end():])


def _label_relations(path):
    target = ingest.meta_path(path)
    raw = target.read_text(encoding="utf-8")
    lines, changed = [], 0
    for line in raw.splitlines(keepends=True):
        text = line.rstrip("\r\n")
        ending = line[len(text):]
        match = ingest.LINK_LINE.match(text)
        if match and match.group("kind") is None:
            bullet = match.group("bullet") or ""
            line = f"{bullet}[{DEFAULT_RELATION}] [[{match.group('target')}]]{ending}"
            changed += 1
        lines.append(line)
    if changed:
        ingest.write_atomic(target, "".join(lines))
    return changed


def fix(root=ingest.LIBRARY):
    root = Path(root)
    health = validator.scan(root)

    for issue in health["issues"]["domains"]:
        _set_domain(root / issue["path"])

    relations = 0
    paths = {
        issue["path"] for issue in health["issues"]["relations"]
        if issue["value"] is None
    }
    for relative in sorted(paths):
        relations += _label_relations(root / relative)

    return {"domains": len(health["issues"]["domains"]), "relations": relations}


def demo():
    from tempfile import TemporaryDirectory

    with TemporaryDirectory() as directory:
        root = Path(directory)
        sources = root / "Sources"
        sources.mkdir()
        note = sources / "A.md"
        note.write_text(
            "---\ntitle: A\n---\n\nSentence [[B]] stays.\n- [[B]]\n", encoding="utf-8"
        )
        (sources / "B.md").write_text("---\ndomain: Science\n---\n", encoding="utf-8")

        original_body = ingest.front_matter(note.read_text(encoding="utf-8"))[1]
        assert fix(root) == {"domains": 1, "relations": 1}
        fixed = note.read_text(encoding="utf-8")
        assert "domain: Art" in fixed
        assert ingest.front_matter(fixed)[1].replace("- [RESEARCH]", "-") == original_body
        assert "Sentence [[B]] stays." in fixed
        assert "- [RESEARCH] [[B]]" in fixed
        assert fix(root) == {"domains": 0, "relations": 0}
    print("ontology fixer ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        demo()
    else:
        fixed = fix(Path(sys.argv[1]) if len(sys.argv) > 1 else ingest.LIBRARY)
        print(json.dumps({"fixed": fixed}, indent=2))
