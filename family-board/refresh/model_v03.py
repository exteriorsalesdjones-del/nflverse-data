"""Anytime TD model usage-v0.3c (adopted after the Weeks 1-9 2026 backtest; see research/ and docs/BACKTEST_W1_9.md).

Logistic regression, refit every refresh on 2025 weeks 3-18 plus every 2026 week already played, on players who
took an offensive snap. Inputs (all known before kickoff):
  position; log of the team's expected offensive TDs (closing spread/total x TDs per point);
  log carry share and log target share (2026 games + 2025 at half weight);
  goal-line rushing for RBs and QBs only: share of team carries inside the 5, share of goal-to-go carries,
  QB designed runs and QB sneaks per game;
  pregame depth-chart rank (last snapshot before kickoff);
  the player's own TD rate and goal-line TD rate per game.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import features as F

POS = ["QB", "RB", "WR", "TE"]
MODEL_VERSION = "usage-v0.3c"


def lg(x):
    return np.log(np.clip(x, 0, None) + 0.01)


def design(d: pd.DataFrame) -> pd.DataFrame:
    rush = d.pos.isin(["RB", "QB"]).astype(float)
    X = pd.get_dummies(d.pos).reindex(columns=POS, fill_value=0).astype(float)
    X["log_exp_team_td"] = np.log(d.exp_team_td)
    X["lg_carry_share"] = lg(d.carry_share); X["lg_target_share"] = lg(d.target_share)
    X["gl_i5"] = lg(d.i5_share) * rush; X["gl_gtg"] = lg(d.gtg_share) * rush
    X["gl_designed"] = d.designed_g * rush; X["gl_sneaks"] = d.sneaks_g * rush
    X["depth_rank"] = d.depth_rank.clip(upper=5)
    X["td_rate"] = d.td_rate; X["gl_td_rate"] = d.gl_td_rate
    return X


GROUP_OF = {"log_exp_team_td": "team", "lg_carry_share": "workload", "lg_target_share": "workload", "gl_i5": "goal_line",
            "gl_gtg": "goal_line", "gl_designed": "goal_line", "gl_sneaks": "goal_line", "depth_rank": "depth", "td_rate": "history",
            "gl_td_rate": "history"}


def fit(X, y, l2=1.0, iters=60):
    A = np.column_stack([np.ones(len(X)), X]); b = np.zeros(A.shape[1]); R = np.eye(A.shape[1]) * l2; R[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-A @ b)); W = p * (1 - p)
        step = np.linalg.solve(A.T @ (A * W[:, None]) + R, A.T @ (y - p) - R @ b); b += step
        if np.abs(step).max() < 1e-8:
            break
    return b


def upcoming_rows(week: int) -> pd.DataFrame:
    """Skill players on the latest weekly roster (ACT or INA) for teams playing in `week`."""
    games = pd.read_csv(F.C / "games.csv")
    g = games[(games.season == 2026) & (games.week == week) & (games.game_type == "REG")]
    ros = pd.read_parquet(F.C / "roster_weekly_2026.parquet")
    ros = ros[ros.week <= week]; ros = ros[ros.week == ros.week.max()]
    ros = ros[ros.status.isin(["ACT", "INA"]) & ros.position.isin(F.SKILL)]
    sides = pd.concat([g[["game_id", "home_team", "away_team"]].rename(columns={"home_team": "team", "away_team": "opponent"}),
                       g[["game_id", "away_team", "home_team"]].rename(columns={"away_team": "team", "home_team": "opponent"})])
    cur = sides.merge(ros[["team", "gsis_id", "position"]].rename(columns={"gsis_id": "pid", "position": "pos"}), on="team")
    return cur.assign(season=2026, week=week)


def predict(week: int, players: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    targets = [(2025, w) for w in range(3, 19)] + [(2026, w) for w in range(1, week)]
    d = F.build(players, targets=targets, upcoming=(2026, week, upcoming_rows(week)), max_week_2026=week - 1).reset_index(drop=True)
    is_new = (d.season == 2026) & (d.week == week)
    X = design(d); tr = ~is_new & d.y_td.notna()
    med = X[tr].median(); Xf = X.fillna(med); mu = Xf[tr].mean(); sd = Xf[tr].std().replace(0, 1)
    Z = (Xf - mu) / sd
    b = fit(Z[tr].to_numpy(), d.loc[tr, "y_td"].to_numpy(float))
    zn = Z[is_new]; logit = b[0] + zn.to_numpy() @ b[1:]
    out = d[is_new].copy(); out["p"] = 1 / (1 + np.exp(-logit))
    # main reason: input group with the largest positive contribution (coef x standardized value)
    contrib = pd.DataFrame(zn.to_numpy() * b[1:], columns=Z.columns, index=zn.index)
    grp = contrib[[c for c in contrib.columns if c in GROUP_OF]].T.groupby(lambda c: GROUP_OF[c]).sum().T
    out["main_driver"] = grp.idxmax(axis=1)
    coefs = dict(zip(["intercept"] + list(Z.columns), np.round(b, 4).tolist()))
    meta = {"model_version": MODEL_VERSION, "train_rows": int(tr.sum()), "coefs_std": coefs}
    return out, meta
