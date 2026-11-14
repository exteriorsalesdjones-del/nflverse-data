"""Model enhancements, each switchable and each tested walk-forward in build_data.validate().

Ideas taken from the statistics libraries reviewed for this project and rewritten here
in a few lines of Python:

  recency      Exponential recency weights on a player's opportunities
               (OnlineStats.jl's ExponentialWeight). Half-life HALF_LIFE weeks.
  skill        Poisson-Gamma conjugate shrinkage of each player's touchdown conversion
               (Cognitive Foundry's PoissonBayesianEstimator): factor =
               (actual TDs + A) / (expected TDs + A). A small sample barely moves it;
               a long record of beating expectation does.
  kalman       A one-dimensional Kalman filter per team (Cognitive Foundry's KalmanFilter)
               tracking how many offensive TDs the team scores relative to its
               betting-implied expectation, game by game.
  calibrate    Platt scaling: a two-parameter logistic regression (Cognitive Foundry's
               LogisticRegression) on log-odds, fitted only on earlier weeks' predictions
               and outcomes, applied to the next week.

Settings below were fixed before testing and are not tuned on the test weeks.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

HALF_LIFE = 4.0       # weeks
A_PRIOR = 2.0         # pseudo expected TDs in the Poisson-Gamma prior
KF_Q = 0.01           # Kalman process variance per game (team multiplier drift)
KF_P0 = 0.05          # initial variance of the team multiplier
CAL_MIN_ROWS = 300    # Platt scaling needs this many earlier predictions


def team_lambdas(o_hist: pd.DataFrame, rates: dict, team: str, team_total: float,
                 recency: bool, skill: bool) -> pd.DataFrame:
    """Expected TDs per player on `team` (sums to team_total), with rush/rec split."""
    t = o_hist[o_hist.posteam == team].copy()
    if t.empty:
        return pd.DataFrame()
    t["xtd"] = t.cell.map(rates).fillna(0.0)
    if recency:
        last = t.week.max()
        t["w"] = 0.5 ** ((last - t.week) / HALF_LIFE)
    else:
        t["w"] = 1.0
    t["wx"] = t.xtd * t.w
    t["wx_rush"] = np.where(t.kind == "carry", t.wx, 0.0)
    t["wx_rec"] = np.where(t.kind == "target", t.wx, 0.0)
    per = t.groupby("pid").agg(name=("name", "last"), wx=("wx", "sum"), wx_rush=("wx_rush", "sum"),
                               wx_rec=("wx_rec", "sum"), xtd=("xtd", "sum"), td=("td", "sum"),
                               opp=("cell", "size"), i10=("zone", lambda z: int((z == "i10").sum())),
                               games=("game_id", "nunique"))
    per["f_skill"] = (per.td + A_PRIOR) / (per.xtd + A_PRIOR) if skill else 1.0
    raw = per.wx * per.f_skill
    tot = raw.sum()
    if tot <= 0:
        return pd.DataFrame()
    per["share"] = raw / tot
    per["lam"] = team_total * per.share
    rush_frac = np.where(per.wx > 0, per.wx_rush / per.wx.replace(0, np.nan), 0.0)
    per["lam_rush"] = per.lam * np.nan_to_num(rush_frac)
    per["lam_rec"] = per.lam - per.lam_rush
    per["p"] = 1 - np.exp(-per.lam)
    return per.reset_index()


def kalman_team(games_hist: pd.DataFrame, off_tds: dict, ratio: float, implied) -> dict:
    """{team: multiplier} on expected offensive TDs, filtered over earlier final games.
    off_tds: {(game_id, team): offensive TDs}. implied(row) -> (away_pts, home_pts) or None."""
    x, P = {}, {}
    for g in games_hist.sort_values(["week", "game_id"]).itertuples():
        ip = implied(g)
        if ip is None:
            continue
        for team, pts in ((g.away_team, ip[0]), (g.home_team, ip[1])):
            exp_td = max(pts * ratio, 0.5)
            xi, Pi = x.get(team, 1.0), P.get(team, KF_P0) + KF_Q
            y = off_tds.get((g.game_id, team), 0) / exp_td      # observed multiplier this game
            R = 1.0 / exp_td                                   # Poisson noise of that ratio
            K = Pi / (Pi + R)
            x[team], P[team] = xi + K * (y - xi), (1 - K) * Pi
    return x


def fit_platt(p: np.ndarray, y: np.ndarray):
    """Logistic regression of outcome on logit(p): returns (a, b) or None. Newton steps."""
    if len(p) < CAL_MIN_ROWS or y.sum() < 20:
        return None
    z = np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    X = np.column_stack([np.ones_like(z), z])
    w = np.array([0.0, 1.0])
    for _ in range(25):
        m = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (y - m)
        H = -(X * (m * (1 - m))[:, None]).T @ X - 1e-6 * np.eye(2)
        w = w - np.linalg.solve(H, g)
    return float(w[0]), float(w[1])


def apply_platt(p, ab):
    if ab is None:
        return np.asarray(p, float)
    z = np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    return 1 / (1 + np.exp(-(ab[0] + ab[1] * z)))
