"""Historical flat-bet record for the Research tab's testing dashboard.

Point-in-time model chances (rolling backtest forecasts, .data/cache/backtest_preds.parquet, column `final`) against the
sportsbook anytime-TD prices kept in the family's weekly workbooks (weeks 2-4 of 2026), graded with the SAME code the
live record uses (refresh/grade.py betting()). One unit per bet at the best price a player had that week.

Run: python3 research/betting_record.py --prices <market_prices.csv>   (the CSV is a private workbook export: not in git)
Writes research/betting_record_results.json. The summary is copied by hand into grade.BETTING_BACKTEST.
"""
import json, re, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
import grade

cache = ROOT / ".data" / "cache"
bt = pd.read_parquet(cache / "backtest_preds.parquet")
players = pd.read_parquet(cache / "players.parquet", columns=["gsis_id", "display_name"])
m = pd.read_csv(sys.argv[sys.argv.index("--prices") + 1]); m = m[m.market.astype(str).str.lower().str.contains("any")].copy()
norm = lambda s: re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", str(s).lower()))
pl = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").display_name.map(norm)
bt = bt.assign(k=bt.pid.map(pl)); m["k"] = m.player.map(norm); m["week"] = m.week.astype(int)
m = m[np.isfinite(pd.to_numeric(m.american, errors="coerce")) & (pd.to_numeric(m.american, errors="coerce").abs() >= 100)]
m["american"] = m.american.astype(float)
j = m.merge(bt[["k", "week", "pid", "pos", "game_id", "y_td", "final"]], on=["k", "week"], how="inner")
rows = []
for (pid, week), g in j.groupby(["pid", "week"]):
    per_book = g.groupby("book").american.last()          # one price per book (the workbook's last entry)
    r = g.iloc[0]
    rows.append({"game_id": r.game_id, "week": int(week), "pid": pid, "p": float(r.final), "y": int(r.y_td),
                 "kick": datetime(2026, 9, 1, tzinfo=timezone.utc) + timedelta(days=7 * int(week)),   # order only
                 "imp": float(np.mean([grade.implied(a) for a in per_book])), "best": float(per_book.max()), "books": sorted(per_book.index), "move_pts": None})
grade._positions = lambda: bt.drop_duplicates("pid").set_index("pid").pos.to_dict()
out = grade.betting(rows)
out["source"] = "rolling backtest forecasts vs workbook sportsbook prices, 2026 weeks " + ", ".join(str(w) for w in out["weeks"])
out["books"] = sorted({b for r in rows for b in r["books"]})
out["range_check"] = grade.range_check(rows)
(ROOT / "research" / "betting_record_results.json").write_text(json.dumps(out, indent=1))
for r in out["rules"]:
    print(f"{r['name']:26s} n={r['n']:4d} wins={r.get('wins')} units={r.get('units')} roi={r.get('roi')} ci90={r.get('roi_ci90')} dd={r.get('max_drawdown_units')} run={r.get('longest_losing_run')} implied={r.get('avg_implied')} model={r.get('avg_model')} hit={r.get('hit_rate')}")
    print("   by_pos", r.get("by_pos")); print("   by_price", r.get("by_price")); print("   by_week", r.get("by_week"))
print("range", out["range_check"])
