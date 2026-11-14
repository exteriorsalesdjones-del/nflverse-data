"""Blindness check for pregame_reads.py: scramble every final score from week W on (and every post-game schedule field),
regenerate week W, and require the text to be identical to the normal run. Any leak of results would change the output."""
import sys, tempfile
from pathlib import Path
import numpy as np, pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pregame_reads as PR

for W in [int(x) for x in sys.argv[1:]] or [1, 5]:
    raw = pd.read_csv(PR.C / "games.csv")
    scr = raw.copy(); rng = np.random.default_rng(W)
    m = (scr.season == 2026) & (scr.week >= W)
    for c in ["home_score", "away_score", "result", "total"]:
        scr.loc[m, c] = rng.integers(0, 60, m.sum())
    for c in ["away_qb_name", "home_qb_name", "referee", "temp", "wind", "overtime", "roof"]:
        scr.loc[m, c] = np.nan if c != "away_qb_name" and c != "home_qb_name" and c != "referee" and c != "roof" else "SCRAMBLED"
    with tempfile.TemporaryDirectory() as t:
        a, b = Path(t) / "a.md", Path(t) / "b.md"
        PR.main(weeks=[W], out_path=a, games_override=raw)
        PR.main(weeks=[W], out_path=b, games_override=scr)
        same = a.read_text() == b.read_text()
        print(f"week {W}: output identical with all week-{W}+ results scrambled -> {same}; 'SCRAMBLED' present -> {'SCRAMBLED' in b.read_text()}")
