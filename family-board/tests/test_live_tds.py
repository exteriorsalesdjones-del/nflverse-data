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

# ---- game status: a night game must stay "upcoming" until well after kickoff (the runner's clock is UTC)
import datetime as _dt
from zoneinfo import ZoneInfo as _Z
class _Clock(_dt.datetime):
    fixed = None
    @classmethod
    def now(cls, tz=None):
        return cls.fixed.astimezone(tz) if tz else cls.fixed.astimezone(_dt.timezone.utc).replace(tzinfo=None)
_real = BD.datetime; BD.datetime = _Clock
row = pd.Series({"game_id": "2026_10_PIT_CIN", "result": float("nan"), "gameday": "2026-11-15", "gametime": "20:20"})
def status_at(et):
    _Clock.fixed = _dt.datetime.fromisoformat(et).replace(tzinfo=_Z("America/New_York")); return BD.game_status(row, set())
check("7:30 PM ET (already the next day in UTC), 50 minutes before an 8:20 PM kickoff: still upcoming", status_at("2026-11-15T19:30") == "upcoming", status_at("2026-11-15T19:30"))
check("during the game, no plays posted yet: still upcoming (not postponed)", status_at("2026-11-15T22:30") == "upcoming")
check("12+ hours after kickoff with no result: shown as not final", status_at("2026-11-16T09:00") == "postponed_or_pending")
# ---- saved pregame chances
tmp = Path(tempfile.mkdtemp()); old_out = BD.OUT; BD.OUT = tmp
import json as _json
cand = lambda p: {"teams": [{"candidates": [{"gsis_id": "00-1", "p": p}]}]}
games_out = [{"game_id": "A", "status": "upcoming", "kickoff_et": "2026-11-16T20:15"}, {"game_id": "B", "status": "upcoming", "kickoff_et": "2026-11-15T13:00"}]
(tmp / "predictions.json").write_text(_json.dumps({"A": {"00-1": {"p": 0.2, "model": "m"}}, "B": {"00-1": {"p": 0.3, "model": "m"}}, "OLD": {"x": {"p": 0.1}}}))
_Clock.fixed = _dt.datetime(2026, 11, 16, 17, 0, tzinfo=_Z("America/New_York")); BD.HEALTH["problems"].clear()
n = BD.save_predictions({"games": [{"game_id": "A", **cand(0.25)}, {"game_id": "B", **cand(0.9)}]}, games_out)
pr = _json.loads((tmp / "predictions.json").read_text())
check("before kickoff the chance updates; after kickoff it is frozen; earlier weeks are kept", pr["A"]["00-1"]["p"] == 0.25 and pr["B"]["00-1"]["p"] == 0.3 and "OLD" in pr and n == 1, _json.dumps(pr))
BD.save_predictions({"games": [{"game_id": "A", "teams": []}]}, games_out)
check("an empty candidate list never replaces a saved game", _json.loads((tmp / "predictions.json").read_text())["A"]["00-1"]["p"] == 0.25)
(tmp / "predictions.json").unlink(); BD.HEALTH["problems"].clear()
BD.save_predictions({"games": [{"game_id": "B", **cand(0.9)}]}, games_out)
check("a run that starts without the saved file reports the kicked-off game instead of silently losing it", any("No saved pregame chances for B" in x for x in BD.HEALTH["problems"]), str(BD.HEALTH["problems"]))
BD.OUT = old_out; BD.datetime = _real; BD.HEALTH["problems"].clear()
# ---- flexed kickoff: the feed's time replaces a stale schedule time before anything else uses it
tmp2 = Path(tempfile.mkdtemp()); old_out = BD.OUT; BD.OUT = tmp2; BD.HEALTH["problems"].clear()
(tmp2 / "odds_feed.json").write_text(_json.dumps({"kickoffs": {"G1": "2026-11-22T13:00", "G2": "2026-11-22T16:25", "G3": "2026-11-22T13:02", "G4": "2026-11-30T13:00", "GF": "2026-11-15T13:00"}}))
sched = pd.DataFrame({"game_id": ["G1", "G2", "G3", "G4", "GF", "G9"], "gameday": ["2026-11-22"] * 4 + ["2026-11-15", "2026-11-22"], "gametime": ["16:25", "13:00", "13:00", "13:00", "16:25", "13:00"],
                      "weekday": ["Sunday"] * 6, "result": [float("nan")] * 4 + [7.0, float("nan")]})
fx_ = BD.flex_kickoffs(sched).set_index("game_id")
check("a flexed game takes the feed's kickoff (4:25 -> 1:00 and 1:00 -> 4:25)", fx_.gametime["G1"] == "13:00" and fx_.gametime["G2"] == "16:25")
check("a 2-minute difference, a week-long difference, a finished game and a game not on the feed are left alone", fx_.gametime["G3"] == "13:00" and fx_.gameday["G4"] == "2026-11-22" and fx_.gametime["GF"] == "16:25" and fx_.gametime["G9"] == "13:00")
check("the change is reported in the refresh's health notes", any("G1 Sun 16:25 -> Sun 13:00" in x for x in BD.HEALTH["problems"]), str(BD.HEALTH["problems"]))
(tmp2 / "odds_feed.json").unlink(); check("no feed file: the schedule is used as it is", BD.flex_kickoffs(sched).equals(sched))
BD.OUT = old_out; BD.HEALTH["problems"].clear()
# ---- results fingerprint moves when a game becomes settleable
fa = BD.results_fingerprint([], [], {"G": {"reconciled": True, "scorers_verified": None}}); fb = BD.results_fingerprint([], [], {"G": {"reconciled": True, "scorers_verified": True}})
check("results fingerprint changes when scorers become verified", fa != fb)
print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
