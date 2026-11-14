"""Referee crew index, rebuilt every refresh from nflverse play-by-play (accepted penalties) and the schedule's
referee column. Crew rates per game are shrunk toward the league with 6 pseudo-games; current season games weigh 1,
the previous season 0.5. Study and tests: research/referees.py, docs/METHOD.md (Referees). Information only."""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

C = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))
COVER = {"Defensive Pass Interference", "Defensive Holding", "Illegal Contact", "Roughing the Passer"}
PRESNAP = {"False Start", "Delay of Game", "Defensive Offside", "Neutral Zone Infraction", "Illegal Formation", "Encroachment",
           "Illegal Shift", "Illegal Motion", "Defensive Delay of Game", "Offside on Free Kick"}
COLS = ["flags", "off_holding", "pass_coverage", "run_play_flags", "pass_play_flags"]


def season_flags(y: int) -> pd.DataFrame:
    f = C / f"play_by_play_{y}.parquet"
    if not f.exists():
        return pd.DataFrame()
    p = pd.read_parquet(f, columns=["game_id", "season_type", "penalty", "penalty_type", "qb_dropback", "desc", "play_type", "play_id"])
    p = p[p.season_type == "REG"]
    g = pd.read_csv(C / "games.csv")
    g = g[(g.season == y) & (g.game_type == "REG") & g.result.notna() & g.referee.notna()][["game_id", "referee"]]
    pen = p[p.penalty == 1].copy(); txt = pen.desc.fillna("").str.lower()
    pen["is_pass"] = (pen.qb_dropback == 1) | txt.str.contains(" pass ") | txt.str.contains("pass incomplete") | txt.str.contains("sacked")
    pen["is_run"] = ~pen.is_pass & pen.play_type.isin(["run", "no_play"]) & ~pen.penalty_type.isin(PRESNAP)
    G = pen.groupby("game_id").agg(flags=("play_id", "size"), run_play_flags=("is_run", "sum"), pass_play_flags=("is_pass", "sum"),
                                   off_holding=("penalty_type", lambda s: int((s == "Offensive Holding").sum())),
                                   pass_coverage=("penalty_type", lambda s: int(s.isin(COVER).sum())))
    out = g.merge(G.reset_index(), on="game_id", how="left").fillna(0)
    return out.assign(season=y)


def build(season: int = 2026) -> dict:
    parts = [season_flags(season - 1).assign(w=0.5), season_flags(season).assign(w=1.0)]
    W = pd.concat([x for x in parts if len(x)], ignore_index=True)
    lg = {c: float(np.average(W[c], weights=W.w)) for c in COLS}
    crews = {}
    for ref, x in W.groupby("referee"):
        n = float(x.w.sum())
        crews[ref] = {"games": int(len(x)), "weighted_games": round(n, 2), "last_season": int(x.season.max()),
                      **{c: round((float((x[c] * x.w).sum()) + 6 * lg[c]) / (n + 6), 2) for c in COLS}}
    return {"built_from": f"nflverse pbp {season - 1}-{season} (accepted penalties), referee from schedules", "shrink_games": 6,
            "games": int(len(W)), "league": {c: round(v, 2) for c, v in lg.items()}, "crews": crews}


if __name__ == "__main__":
    print(json.dumps(build(), indent=1)[:400])
