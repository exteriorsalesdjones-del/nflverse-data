"""Secondary outcomes, 2026 Weeks 1-9 rolling: RB rushing yards, WR/TE receptions and receiving yards, QB passing yards.

M0 = player's own per-game average (2025 at half weight + earlier 2026), shrunk to the position mean.
M1 = the specified volume x rate formula:
  RB rush yds   = projected team rush attempts x carry share x expected yards/carry (shrunk)
  receptions    = projected team dropbacks x snap share (est. routes, proxy) x targets per est. route x catch rate (shrunk)
  rec yds       = projected targets x yards per target (shrunk; = catch prob x yards per catch, incl. depth and YAC)
  QB pass yds   = projected attempts x completion rate x yards per completion (shrunk)
  Projected team volume = team plays/game x (1 - dropback rate) or x dropback rate (no game adjustment).
M2+ = rolling median (LAD) regression on [M0, M1] plus one input group at a time. Scored by MAE on the same player-games,
bootstrap over games for the gain.
"""
import json, sys
import numpy as np, pandas as pd
sys.path.insert(0, "research")
import backtest as B

d = pd.read_parquet(B.C / "backtest_features.parquet").reset_index(drop=True)


def shrink(val, n, prior, k):
    return (val.fillna(prior) * n.fillna(0) + prior * k) / (n.fillna(0) + k)


def per_season_pos_mean(col, mask):
    return d[mask].groupby("pos")[col].mean()


team_rush = d.team_plays_g * (1 - d.team_db_rate)
team_db = d.team_plays_g * d.team_db_rate
carries_n = d.carries_g * d.hist_games; targets_n = d.targets_g * d.hist_games; att_n = d.att_g * d.hist_games
ypc = shrink(d.ypc, carries_n, 4.3, 40)
catch = shrink(d.catch_rate, targets_n, 0.64, 25)
ypt = shrink(d.ypt, targets_n, 7.3, 25)
cmp_r = shrink(d.cmp_rate, att_n, 0.64, 60); ypcmp = shrink(d.yds_per_cmp, d.cmp_rate * att_n, 10.8, 40)
est_routes = d.snap_share * team_db
tprr = (d.targets_g / d.est_routes_g.replace(0, np.nan)).clip(0, 0.6).fillna(0.12)
proj_targets = est_routes * tprr
OUT = {
    "rb_rush_yds": dict(mask=(d.pos == "RB"), y="y_rush_yds", m0="rush_yds_g", m1=team_rush * d.carry_share * ypc),
    "wrte_receptions": dict(mask=d.pos.isin(["WR", "TE"]), y="y_rec", m0="rec_g", m1=proj_targets * catch),
    "wrte_rec_yds": dict(mask=d.pos.isin(["WR", "TE"]), y="y_rec_yds", m0="rec_yds_g", m1=proj_targets * ypt),
    "qb_pass_yds": dict(mask=(d.pos == "QB") & (d.att_g >= 15), y="y_pass_yds", m0="pass_yds_g", m1=d.att_g * cmp_r * ypcmp),
}
G = B.design(d)
GROUPS = {
    "game_script": G["game_script"].assign(imp_pts=d.imp_pts),
    "matchup": G["matchup"],
    "recent_role": G["recent_role"][["d_carry_share", "d_target_share", "d_snap_share"]],
    "depth_rank": G["recent_role"][["depth_rank"]],
    "injuries_lineup": G["injuries_lineup"],
    "efficiency": G["efficiency"],
    "workload_extra": G["workload_extra"],
    "ngs_depth_yac": pd.DataFrame({"adot": d.adot, "yac_per_rec": d.yac_per_rec, "xcatch_rate": d.xcatch_rate}),
}


def ridge(Xtr, ytr, Xte, l2=1.0):
    mu, sd = Xtr.mean(0), Xtr.std(0); sd[sd == 0] = 1
    A = (Xtr - mu) / sd; A = np.column_stack([np.ones(len(A)), A])
    R = np.eye(A.shape[1]) * l2; R[0, 0] = 0
    b = np.linalg.solve(A.T @ A + R, A.T @ ytr)
    for _ in range(40):  # median (least absolute deviation) regression by IRLS, since outcomes are scored by MAE
        wts = 1 / np.maximum(np.abs(ytr - A @ b), 1.0)
        b = np.linalg.solve(A.T @ (A * wts[:, None]) + R, A.T @ (ytr * wts))
    Z = np.column_stack([np.ones(len(Xte)), (Xte - mu) / sd]); return Z @ b


def rolling_reg(mask, ycol, base_cols, extra=None):
    X = pd.concat([base_cols] + ([extra] if extra is not None else []), axis=1).astype(float)
    out = pd.Series(np.nan, index=d.index)
    for w in range(1, 10):
        tr = mask & ((d.season == 2025) | ((d.season == 2026) & (d.week < w))); te = mask & (d.season == 2026) & (d.week == w)
        med = X[tr].median()
        out[te] = ridge(X[tr].fillna(med).to_numpy(), d.loc[tr, ycol].to_numpy(float), X[te].fillna(med).to_numpy())
    return out.clip(lower=0)


def mae_compare(T, p_new, p_ref, ycol, n_boot=2000):
    e = pd.Series(np.abs(T[ycol] - p_ref) - np.abs(T[ycol] - p_new), index=T.index)
    pg = e.groupby(T.game_id).sum(); n = T.groupby("game_id").size(); rng = np.random.default_rng(5)
    bs = [pg.iloc[s].sum() / n.iloc[s].sum() for s in (rng.choice(len(pg), len(pg)) for _ in range(n_boot))]
    return dict(gain=round(float(e.mean()), 3), ci90=[round(float(np.percentile(bs, 5)), 3), round(float(np.percentile(bs, 95)), 3)],
                by_week={int(k): round(float(v), 2) for k, v in e.groupby(T.week).mean().items()})


res = {}
for name, o in OUT.items():
    mask = o["mask"]; ycol = o["y"]
    pm = {}
    m0 = pd.Series(np.nan, index=d.index)
    for w in range(1, 10):
        te = mask & (d.season == 2026) & (d.week == w); tr = mask & ((d.season == 2025) | ((d.season == 2026) & (d.week < w)))
        prior = d.loc[tr, ycol].mean()
        m0[te] = shrink(d.loc[te, o["m0"]], d.loc[te, "hist_games"], prior, 2)
    m1 = o["m1"].where(mask)
    test = mask & (d.season == 2026)
    T = d[test]
    base = pd.DataFrame({"m0": m0, "m1": m1})
    # M0 for training rows too (same shrink using 2025-wide mean) so the regression can be fit
    m0_all = shrink(d[o["m0"]], d.hist_games, d.loc[mask & (d.season == 2025), ycol].mean(), 2)
    base_all = pd.DataFrame({"m0": m0_all.where(~test, m0), "m1": m1})
    m2 = rolling_reg(mask, ycol, base_all)
    r = {"n": int(test.sum()), "games": int(T.game_id.nunique()), "mean_actual": round(float(T[ycol].mean()), 2),
         "MAE": {"M0_player_average": round(float((T[ycol] - m0[test]).abs().mean()), 3),
                 "M1_formula": round(float((T[ycol] - m1[test].fillna(m0[test])).abs().mean()), 3),
                 "M2_blend": round(float((T[ycol] - m2[test]).abs().mean()), 3)},
         "M1_vs_M0": mae_compare(T, m1[test].fillna(m0[test]), m0[test], ycol),
         "M2_vs_M0": mae_compare(T, m2[test], m0[test], ycol), "add_one_vs_M2": {}}
    for gname, gx in GROUPS.items():
        p = rolling_reg(mask, ycol, base_all, gx)
        c = mae_compare(T, p[test], m2[test], ycol); r["add_one_vs_M2"][gname] = c
    res[name] = r
    print(name, r["n"], r["MAE"], "M1vsM0", r["M1_vs_M0"]["gain"], r["M1_vs_M0"]["ci90"], "M2vsM0", r["M2_vs_M0"]["gain"], r["M2_vs_M0"]["ci90"], flush=True)
    for g, c in r["add_one_vs_M2"].items():
        print("   +", g, c["gain"], c["ci90"], flush=True)
json.dump(res, open("research/secondary_results.json", "w"), indent=1, default=float)
