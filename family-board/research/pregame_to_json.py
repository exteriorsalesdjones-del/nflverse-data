"""Convert docs/PREGAME_READS_W1_9.md (written by pregame_reads.py) into artifact/data/pregame_reads.json for the app.
The Markdown stays the source of truth; this only restructures it. No results are added."""
import json, re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIELDS = {"Line": "line", "Call": "call", "Context": "context", "Lineup notes (final pre-game report)": "lineup", "Anytime TD read": "td"}


def convert(md_path=ROOT / "docs" / "PREGAME_READS_W1_9.md", out_path=ROOT / "artifact" / "data" / "pregame_reads.json"):
    weeks, week, game = {}, None, None
    for raw in Path(md_path).read_text().splitlines():
        line = raw.strip()
        m = re.match(r"^## Week (\d+)$", line)
        if m:
            week = int(m.group(1)); weeks[week] = []; continue
        m = re.match(r"^### (\S+) at (\S+)( \(division\))?$", line)
        if m and week:
            game = {"away": m.group(1), "home": m.group(2), "division": bool(m.group(3))}; weeks[week].append(game); continue
        if game is None:
            continue
        m = re.match(r"^\*(.+) · (.+)\*$", line)
        if m:
            game["kickoff"], game["stadium"] = m.group(1), m.group(2); continue
        m = re.match(r"^\*\*(.+?):\*\* (.*)$", line)
        if m and m.group(1) in FIELDS:
            key = FIELDS[m.group(1)]; text = m.group(2)
            if key == "call":
                lean = re.search(r"lean toward \*\*(\w+)\*\*", text)
                game["lean"] = lean.group(1) if lean else None
                game["close"] = "genuinely close" in text
            game[key] = text.replace("**", "")
    games = sum(len(v) for v in weeks.values())
    missing = [(w, g["away"], g["home"]) for w, v in weeks.items() for g in v if not all(k in g for k in ("line", "call", "context", "td", "kickoff"))]
    assert not missing, f"incomplete games: {missing[:3]}"
    out = {"title": "Blind pre-game reads, 2026 weeks 1-9", "source": "docs/PREGAME_READS_W1_9.md (research/pregame_reads.py)",
           "note": "Each read uses only what was known before that game kicked off. Results are deliberately not shown.",
           "games": games, "weeks": {str(w): v for w, v in weeks.items()}}
    Path(out_path).write_text(json.dumps(out, separators=(",", ":")))
    return out


if __name__ == "__main__":
    o = convert()
    print(o["games"], "games;", {w: len(v) for w, v in o["weeks"].items()})
