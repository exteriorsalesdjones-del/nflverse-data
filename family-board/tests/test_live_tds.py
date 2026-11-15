"""Scenario tests for touchdown updates, run on isolated copies of real 2026 play-by-play (nothing live is touched).
Uses the refresh's own build_touchdowns / reconcile (refresh/build_data.py) and the source download step (fetch_sources).
Run: python3 tests/test_live_tds.py"""
import sys, tempfile, shutil
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
import build_data as BD  # noqa: E402
import fetch_sources as FS  # noqa: E402

C = ROOT / ".data" / "cache"
pbp_all = pd.read_parquet(C / "play_by_play_2026.parquet")
games_all = pd.read_csv(C / "games.csv"); games_all = games_all[(games_all.season == 2026) & (games_all.game_type == "REG")]
pfr = pd.read_parquet(C / "advstats_week_def_2026.parquet"); players = pd.read_parquet(C / "players.parquet")
results = []


def check(name, ok, detail=""):
    results.append(ok); print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def run(pbp, games):
    rows, recon = BD.build_touchdowns(pbp, games, pfr, players)
    return {r["key"]: r for r in rows}, recon


# two games that kicked off at the same time (Week 9, Sunday 1:00 PM)
w9 = games_all[(games_all.week == 9) & (games_all.gametime == "13:00")].head(2)
ids = list(w9.game_id); g = games_all[games_all.game_id.isin(ids)]; p = pbp_all[pbp_all.game_id.isin(ids)].copy()

# 1. simultaneous games
tds, recon = run(p, g)
by_game = {gid: sum(1 for t in tds.values() if t["game_id"] == gid) for gid in ids}
check("simultaneous games: both games built and reconciled with the official score", all(recon[gid]["reconciled"] for gid in ids) and all(by_game.values()),
      f"{by_game}; official vs rebuilt " + "; ".join(f"{gid} {recon[gid]['official']} = {recon[gid]['rebuilt']}" for gid in ids))

# 2. a two-touchdown scorer (any game this season)
allg = pbp_all[(pbp_all.touchdown == 1) & (pbp_all.two_point_attempt != 1)].groupby(["game_id", "td_player_id"]).size()
gid2, pid2 = allg[allg >= 2].index[0]
t2, _ = run(pbp_all[pbp_all.game_id == gid2], games_all[games_all.game_id == gid2])
mine = [t for t in t2.values() if t["scorer_id"] == pid2]
check("two-TD scorer: two distinct touchdowns, each with its own play-id key", len(mine) >= 2 and len({t["key"] for t in mine}) == len(mine),
      f"{mine[0]['scorer']} in {gid2}: " + ", ".join(f"{t['key']} Q{t['qtr']} {t['clock']}" for t in mine))

# 3. repeated runs: same keys, no duplicates
tds_b, _ = run(p, g)
check("repeated runs: identical touchdown keys, no duplicates", list(tds) == list(tds_b) and len(tds) == len(set(tds)), f"{len(tds)} touchdowns both times")

# 4. overturned touchdown: an earlier feed had an extra TD that was later overturned (removed by the source)
tdrows = p[(p.touchdown == 1) & (p.two_point_attempt != 1)]
fake = tdrows.iloc[[0]].copy(); fake["play_id"] = 999999; p_wrong = pd.concat([p, fake])
tds_w, recon_w = run(p_wrong, g); gid_f = fake.game_id.iloc[0]
held = not recon_w[gid_f]["reconciled"]
tds_c, recon_c = run(p, g)   # corrected feed
check("overturned TD: while the feed has it, the game no longer matches the official score (held for review)", held and f"{gid_f}:999999" in tds_w,
      f"rebuilt {recon_w[gid_f]['rebuilt']} vs official {recon_w[gid_f]['official']}")
check("overturned TD: after the source drops it, the TD disappears and the game reconciles again", f"{gid_f}:999999" not in tds_c and recon_c[gid_f]["reconciled"])

# 5. corrected scorer: same play, scorer changed by the source -> same key, updated scorer, no duplicate
row = tdrows.iloc[0]; key = f"{row.game_id}:{int(row.play_id)}"
p_bad = p.copy(); m = (p_bad.game_id == row.game_id) & (p_bad.play_id == row.play_id)
p_bad.loc[m, "td_player_id"] = "00-0000000"; p_bad.loc[m, "td_player_name"] = "Wrong.Player"
tds_bad, _ = run(p_bad, g); tds_fix, _ = run(p, g)
check("corrected scorer: the same play key updates to the right scorer, count unchanged",
      tds_bad[key]["scorer"] == "Wrong.Player" and tds_fix[key]["scorer"] == row.td_player_name and len(tds_bad) == len(tds_fix),
      f"{key}: {tds_bad[key]['scorer']} -> {tds_fix[key]['scorer']}")

# 6. temporary source outage: a failed download keeps the previous good copy
tmp = Path(tempfile.mkdtemp())
try:
    old = FS.CACHE; FS.CACHE = tmp
    (tmp / "games.csv").write_text("previous good copy\n")
    try:
        FS.fetch("games.csv", "https://127.0.0.1:9/unreachable.csv"); failed = False
    except Exception:
        failed = True
    check("source outage: the download fails and the previous copy is kept", failed and (tmp / "games.csv").read_text() == "previous good copy\n")
finally:
    FS.CACHE = old; shutil.rmtree(tmp, ignore_errors=True)

# 7. final reconciliation across a whole week
wk = games_all[games_all.week == 9]; tdw, recw = run(pbp_all[pbp_all.game_id.isin(wk.game_id)], wk)
okw = [gid for gid, r in recw.items() if r["reconciled"]]
check("final reconciliation: every final Week 9 game matches its official score", len(okw) == len(recw) and len(recw) == int(wk.result.notna().sum()), f"{len(okw)}/{len(recw)} games")

# 8. a game that's final on the schedule but not yet in the play-by-play (today's NE at DET at 3:05 PM): pending, not a failure
p_missing = p[p.game_id != ids[1]]
_, recon_m = run(p_missing, g)
check("final but not yet in the source: marked awaiting_source (pending), the other game still reconciles",
      recon_m[ids[1]]["awaiting_source"] and not recon_m[ids[1]]["reconciled"] and recon_m[ids[0]]["reconciled"] and not recon_m[ids[0]]["awaiting_source"],
      f"{ids[1]} rebuilt {recon_m[ids[1]]['rebuilt']} vs official {recon_m[ids[1]]['official']}")

# 9. scorer check against official player stats: a wrong scorer on one play is caught even though the score still matches
rows_ok, rec_ok = BD.build_touchdowns(p, g, pfr, players); BD.check_scorers(rows_ok, rec_ok)
rows_bad, rec_bad = BD.build_touchdowns(p_bad, g, pfr, players); BD.check_scorers(rows_bad, rec_bad)
check("scorer check: correct records verify against official player stats", all(rec_ok[gid]["scorers_verified"] is True for gid in ids))
check("scorer check: a wrongly credited TD is flagged even though the final score still reconciles",
      rec_bad[row.game_id]["reconciled"] and rec_bad[row.game_id]["scorers_verified"] is False and len(rec_bad[row.game_id]["scorer_mismatches"]) == 2,
      "; ".join(f"{m['player']}: records {m['records']} vs official {m['official']}" for m in rec_bad[row.game_id]["scorer_mismatches"]))

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
