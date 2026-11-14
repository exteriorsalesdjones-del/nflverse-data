"""Convert docs/ANALYSIS_W1_10.md (written by season_analysis.py) into artifact/data/analysis.json for the app's Analysis tab.
The Markdown stays the source of truth; this only restructures it into sections of headings, paragraphs, bullet lists and
tables. Inline **bold**, *italic* and `code` are kept as markers for the app to render."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def convert(md_path=ROOT / "docs" / "ANALYSIS_W1_10.md", out_path=ROOT / "artifact" / "data" / "analysis.json"):
    lines = Path(md_path).read_text().splitlines()
    title, intro, sections, cur = None, [], [], None
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip()
        blocks = cur["blocks"] if cur else intro
        if ln.startswith("# ") and title is None:
            title = ln[2:].strip()
        elif ln.startswith("## "):
            cur = {"title": ln[3:].strip(), "blocks": []}; sections.append(cur)
        elif ln.startswith("### "):
            blocks.append({"type": "h", "text": ln[4:].strip()})
        elif ln.startswith("|"):
            head = cells(ln); rows = []
            i += 2  # skip the |---| separator
            while i < len(lines) and lines[i].startswith("|"):
                rows.append(cells(lines[i])); i += 1
            assert all(len(r) == len(head) for r in rows), f"ragged table under {cur and cur['title']}: {head}"
            blocks.append({"type": "table", "head": head, "rows": rows}); continue
        elif ln.startswith("- "):
            items = []
            while i < len(lines) and lines[i].startswith("- "):
                items.append(lines[i][2:].strip()); i += 1
            blocks.append({"type": "list", "items": items}); continue
        elif ln.strip():
            blocks.append({"type": "p", "text": ln.strip()})
        i += 1
    assert title and sections, "analysis Markdown has no title or sections"
    out = {"title": title, "source": "docs/ANALYSIS_W1_10.md (research/season_analysis.py)", "intro": intro, "sections": sections}
    Path(out_path).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    return out


if __name__ == "__main__":
    o = convert()
    print(len(o["sections"]), "sections;", sum(b["type"] == "table" for s in o["sections"] for b in s["blocks"]), "tables")
