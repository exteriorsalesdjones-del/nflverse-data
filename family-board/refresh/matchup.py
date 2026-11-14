"""Matchup adjustments for the anytime-TD model, and the defender leaderboard.

Everything here uses only games before the one being predicted.

Two opponent factors, each "1.0 = league average", shrunk toward 1.0 so a few games
cannot swing them:

  pos factor  How many touchdowns this defence has allowed to a position group
              (RB, WR, TE, QB) on runs and on catches, per game, against the league.
              Prior: K_GAMES games at league average.
  cov factor  The defence's charted coverage players' receiving TDs per target
              (Pro Football Reference charting), against the league.
              Prior: K_TARGETS targets at league average.

A player's expected touchdowns are split into a rushing part and a receiving part
(from where his opportunities came), each part is multiplied by its factor, and the
team's total is then scaled back to the Vegas-implied total. The betting total already
prices the defence overall; the factors only move touchdowns between players
(for example from the backs to the tight end against a defence that leaks TEs).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

K_GAMES = 16.0     # tested 4-32: heavier shrinkage is never worse; see METHOD.md
K_TARGETS = 600.0
GROUP = {"RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR", "TE": "TE", "QB": "QB"}


def pos_group(pos_series: pd.Series, pid: pd.Series) -> pd.Series:
    return pid.map(pos_series).map(GROUP).fillna("OTHER")


def pos_factors(pbp_hist: pd.DataFrame, pos: pd.Series) -> dict:
    """{defteam: {(group, kind): factor}} plus league rates, from offensive TDs allowed."""
    td = pbp_hist[(pbp_hist.touchdown == 1) & (pbp_hist.two_point_attempt != 1)
                  & ((pbp_hist.pass_touchdown == 1) | (pbp_hist.rush_touchdown == 1))].copy()
    if td.empty:
        return {}
    td["kind"] = np.where(td.pass_touchdown == 1, "rec", "rush")
    td["grp"] = pos_group(pos, td.td_player_id)
    games = pbp_hist.groupby("defteam").game_id.nunique()
    team_games = games.sum()
    lg = td.groupby(["grp", "kind"]).size() / team_games  # TDs per team-game
    allowed = td.groupby(["defteam", "grp", "kind"]).size()
    out = {}
    for d, n in games.items():
        f = {}
        for (grp, kind), L in lg.items():
            a = allowed.get((d, grp, kind), 0)
            f[(grp, kind)] = float((a + K_GAMES * L) / ((n + K_GAMES) * L)) if L > 0 else 1.0
        out[d] = f
    return out


def cov_factors(pfr_hist: pd.DataFrame) -> dict:
    """{defteam: factor} from charted receiving TDs per target allowed."""
    if pfr_hist is None or pfr_hist.empty:
        return {}
    t = pfr_hist.groupby("team").agg(tgt=("def_targets", "sum"), td=("def_receiving_td_allowed", "sum"))
    lg = t.td.sum() / t.tgt.sum() if t.tgt.sum() else 0
    if lg <= 0:
        return {}
    return {d: float((r.td + K_TARGETS * lg) / ((r.tgt + K_TARGETS) * lg)) for d, r in t.iterrows()}


def adjust(lam: pd.DataFrame, opp: str, pos: pd.Series, pf: dict, cf: dict, use_cov: bool, team_total: float) -> pd.DataFrame:
    """Return a copy with lam_adj, p_adj and the factors used. lam needs lam_rush, lam_rec, pid."""
    out = lam.copy()
    grp = pos_group(pos, out.pid)
    f = pf.get(opp, {})
    f_rush = np.array([f.get((g, "rush"), 1.0) for g in grp])
    f_rec = np.array([f.get((g, "rec"), 1.0) for g in grp])
    c = cf.get(opp, 1.0) if use_cov else 1.0
    raw = out.lam_rush * f_rush + out.lam_rec * f_rec * c
    s = raw.sum()
    out["lam_adj"] = raw * (team_total / s) if s > 0 else raw
    out["p_adj"] = 1 - np.exp(-out.lam_adj)
    out["f_rush"], out["f_rec"], out["f_cov"] = f_rush, f_rec, c
    return out


def defender_board(pfr: pd.DataFrame, min_targets: int = 25) -> list[dict]:
    """Season charting by defender. Rates only where targets >= min_targets."""
    g = pfr.groupby(["pfr_player_id"]).agg(name=("pfr_player_name", "last"), team=("team", "last"),
                                           games=("game_id", "nunique"), tgt=("def_targets", "sum"),
                                           cmp=("def_completions_allowed", "sum"), yds=("def_yards_allowed", "sum"),
                                           td=("def_receiving_td_allowed", "sum"), ints=("def_ints", "sum"),
                                           missed=("def_missed_tackles", "sum"), through_week=("week", "max")).reset_index()
    g = g[g.tgt.fillna(0) > 0]
    rows = []
    for r in g.itertuples():
        ok = r.tgt >= min_targets
        rows.append({"pfr_id": r.pfr_player_id, "name": r.name, "team": r.team, "games": int(r.games),
                     "targets": int(r.tgt), "td": int(r.td), "ints": int(r.ints or 0),
                     "missed_tackles": int(r.missed or 0) if pd.notna(r.missed) else None,
                     "td_per100": round(100 * r.td / r.tgt, 1) if ok else None,
                     "cmp_pct": round(100 * r.cmp / r.tgt, 1) if ok else None,
                     "yds_per_tgt": round(r.yds / r.tgt, 1) if ok else None})
    rows.sort(key=lambda x: (-x["td"], x["targets"]))
    return rows
