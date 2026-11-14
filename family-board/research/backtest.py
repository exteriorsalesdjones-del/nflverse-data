"""Rolling weekly backtest, 2026 Weeks 1-9. Anytime TD primary; secondary yardage/receptions in secondary.py.

For each 2026 week w: fit on 2025 (weeks 3-18) + 2026 weeks < w, predict week w. All models are scored
on the same 2026 player-games (skill players who took an offensive snap; a pick on an inactive player is
void in the app). The app's current model is reproduced from refresh/build_data.py (2026-only history,
so it starts at Week 2) and compared on its own covered subset.
Gate (same as the app): adopt an input group only if the 90% bootstrap interval (resampling games) of
its log-loss gain is above zero and no position group gets worse.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
C = ROOT / ".data" / "cache"
sys.path.insert(0, str(ROOT / "refresh"))
EPS = 1e-6
POS = ["QB", "RB", "WR", "TE"]


def lg(x):
    return np.log(np.clip(x, 0, None) + 0.01)


def design(d: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Feature groups. Each returns columns computed only from pregame fields."""
    rc = lambda a, b: (d[a].fillna(d[b]) - d[b])
    passcatcher = d.pos.isin(["WR", "TE"]).astype(float)
    adj_c = d.carry_share / (1 - d.vac_carry.clip(0, 0.6)); adj_t = d.target_share / (1 - d.vac_target.clip(0, 0.6))
    g = {
        "position": pd.get_dummies(d.pos).reindex(columns=POS, fill_value=0).astype(float),
        "team_expectation": pd.DataFrame({"log_exp_team_td": np.log(d.exp_team_td)}),
        "workload_share": pd.DataFrame({"lg_carry_share": lg(d.carry_share), "lg_target_share": lg(d.target_share)}),
        "workload_extra": pd.DataFrame({"snap_share": d.snap_share, "lg_est_routes": lg(d.est_routes_g),
                                        "tprr_proxy": (d.targets_g / d.est_routes_g.replace(0, np.nan)).clip(0, 1)}),
        "scoring_opportunity": pd.DataFrame({"lg_i5_share": lg(d.i5_share), "lg_ez_share": lg(d.ez_share), "lg_gtg_share": lg(d.gtg_share),
                                             "lg_rz_share": lg(d.rz_share), "qb_designed_g": d.designed_g, "qb_sneaks_g": d.sneaks_g,
                                             "team_i5_g": d.team_i5_g}),
        "long_td": pd.DataFrame({"expl_per_touch": d.expl_per_touch, "long_td_rate": d.long_td_rate}),
        "game_script": pd.DataFrame({"spread_for": d.spread_for, "team_plays_g": d.team_plays_g,
                                     "neutral_pass_x_rec": d.team_neutral_pass * passcatcher, "team_offtd_g": d.team_offtd_g}),
        "injuries_lineup": pd.DataFrame({"questionable": (d.inj_status == "Questionable").astype(float), "qb_out": d.qb_out.astype(float),
                                         "lg_adj_carry": lg(adj_c), "lg_adj_target": lg(adj_t)}),
        "matchup": pd.DataFrame({"opp_allow_pos_ratio": np.log(d.opp_allow_pos / d.lg_allow_pos), "opp_ypc": d.opp_ypc, "opp_pressure": d.opp_pressure}),
        "recent_role": pd.DataFrame({"d_carry_share": rc("rc_carry_share", "carry_share"), "d_target_share": rc("rc_target_share", "target_share"),
                                     "d_snap_share": rc("rc_snap_share", "snap_share"), "depth_rank": d.depth_rank.clip(upper=5),
                                     "few_games": (d.hist_games < 3).astype(float), "team_change": d.team_change.astype(float)}),
        "efficiency": pd.DataFrame({"ypc": d.ypc, "catch_over_exp": d.catch_rate - d.xcatch_rate, "adot": d.adot, "yac_per_rec": d.yac_per_rec}),
        "player_td_rate": pd.DataFrame({"td_rate": d.td_rate, "gl_td_rate": d.gl_td_rate}),
    }
    return g


BASE = ["position", "team_expectation", "workload_share"]
CANDIDATES = ["scoring_opportunity", "long_td", "game_script", "injuries_lineup", "matchup", "recent_role", "efficiency", "workload_extra", "player_td_rate"]


def fit_logit(X, y, l2=1.0, iters=50):
    X = np.column_stack([np.ones(len(X)), X]); b = np.zeros(X.shape[1])
    R = np.eye(X.shape[1]) * l2; R[0, 0] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ b)); W = p * (1 - p)
        H = X.T @ (X * W[:, None]) + R; gr = X.T @ (y - p) - R @ b
        step = np.linalg.solve(H, gr); b += step
        if np.abs(step).max() < 1e-7:
            break
    return b


def predict_logit(b, X):
    X = np.column_stack([np.ones(len(X)), X]); return 1 / (1 + np.exp(-X @ b))


def matrix(G, groups, idx_tr, idx_te):
    X = pd.concat([G[g] for g in groups], axis=1).astype(float)
    tr, te = X.loc[idx_tr], X.loc[idx_te]
    med = tr.median(); tr = tr.fillna(med); te = te.fillna(med)
    mu, sd = tr.mean(), tr.std().replace(0, 1)
    return ((tr - mu) / sd).to_numpy(), ((te - mu) / sd).to_numpy(), list(X.columns), mu, sd


def rolling(d, G, groups, target="y_td"):
    out = pd.Series(np.nan, index=d.index)
    for w in range(1, 10):
        tr = d.index[(d.season == 2025) | ((d.season == 2026) & (d.week < w))]
        te = d.index[(d.season == 2026) & (d.week == w)]
        Xtr, Xte, *_ = matrix(G, groups, tr, te)
        b = fit_logit(Xtr, d.loc[tr, target].to_numpy(float))
        out.loc[te] = predict_logit(b, Xte)
    return out


def ll(p, y):
    p = np.clip(p, EPS, 1 - EPS); return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def compare(d, p_new, p_ref, n_boot=2000, seed=11):
    """Mean log-loss gain (ref - new) per player-game, bootstrap over games."""
    y = d.y_td.to_numpy(float)
    gain = pd.Series(ll(p_ref, y) - ll(p_new, y), index=d.index)
    per_game = gain.groupby(d.game_id).sum(); n_per = d.groupby("game_id").size()
    rng = np.random.default_rng(seed); gids = per_game.index.to_numpy()
    bs = []
    for _ in range(n_boot):
        s = rng.choice(len(gids), len(gids)); bs.append(per_game.iloc[s].sum() / n_per.iloc[s].sum())
    by_pos = gain.groupby(d.pos).mean().to_dict(); by_week = gain.groupby(d.week).mean().to_dict()
    # dependence on one week / few players: gain without the best week, and share of gain from top 10 players
    wk = gain.groupby(d.week).sum(); top = gain.groupby(d.pid).sum().sort_values(ascending=False)
    return dict(gain=float(gain.mean()), ci90=[float(np.percentile(bs, 5)), float(np.percentile(bs, 95))],
                by_pos={k: round(v * 1000, 2) for k, v in by_pos.items()}, by_week={int(k): round(v * 1000, 2) for k, v in by_week.items()},
                gain_without_best_week=float((wk.sum() - wk.max()) / (len(d) - (d.week == wk.idxmax()).sum())),
                top10_player_share=float(top.head(10).sum() / gain.sum()) if gain.sum() > 0 else None)


def calib(p, y, bins=(0, .05, .1, .15, .2, .3, .4, .6, 1)):
    b = pd.cut(p, bins, include_lowest=True)
    t = pd.DataFrame({"p": p, "y": y, "b": b}).groupby("b", observed=True).agg(n=("y", "size"), pred=("p", "mean"), obs=("y", "mean"))
    return [{"bin": str(k), "n": int(r.n), "pred": round(r.pred, 3), "obs": round(r.obs, 3)} for k, r in t.iterrows()]


def scores(p, y):
    p = np.clip(p, EPS, 1 - EPS)
    return dict(n=int(len(y)), log_loss=round(float(ll(p, y).mean()), 5), brier=round(float(((p - y) ** 2).mean()), 5), mean_pred=round(float(p.mean()), 4), obs=round(float(y.mean()), 4))


def hist_rate(d, k=3.0):
    """Baseline: player's own TD rate per game (2025 at half weight + 2026), shrunk to the position average."""
    out = pd.Series(np.nan, index=d.index)
    for w in range(1, 10):
        te = (d.season == 2026) & (d.week == w); tr = (d.season == 2025) | ((d.season == 2026) & (d.week < w))
        pm = d[tr].groupby("pos").y_td.mean()
        x = d[te]; g = x.hist_games.fillna(0)
        out[te] = (x.td_rate.fillna(0) * g + k * x.pos.map(pm)) / (g + k)
    return out


def app_current(d):
    """Reproduce the app's usage-v0.2 headline (usage x implied team TDs, Platt-calibrated on earlier weeks), 2026-only history."""
    import build_data as BD
    import enhance as EN
    pbp = pd.read_parquet(C / "play_by_play_2026.parquet"); pbp = pbp[pbp.week <= 9]
    games = pd.read_csv(C / "games.csv"); games = games[(games.season == 2026) & (games.game_type == "REG")]
    o = BD.opportunity_table(pbp)
    raw = {}
    for w in range(2, 10):
        hist = o[o.week < w]; rates = BD.fit_rates(hist); ratio = BD.off_td_per_point(pbp[pbp.week < w], games[games.week < w])
        for g in games[games.week == w].itertuples():
            ip = BD.implied_points(g)
            for team, pts in ((g.away_team, ip[0]), (g.home_team, ip[1])):
                lam = EN.team_lambdas(hist, rates, team, pts * ratio, False, False)
                for r in lam.itertuples():
                    raw[(g.game_id, r.pid)] = r.p
    d = d.assign(app_raw=[raw.get((g, p), np.nan) for g, p in zip(d.game_id, d.pid)])
    d["app"] = np.nan
    for w in range(2, 10):
        m = (d.season == 2026) & (d.week == w); prior = d[(d.season == 2026) & (d.week < w) & d.app_raw.notna()]
        if len(prior) >= 200:
            ab = EN.fit_platt(prior.app_raw.to_numpy(float), prior.y_td.to_numpy(float))
            d.loc[m, "app"] = EN.apply_platt(d.loc[m, "app_raw"].to_numpy(float), ab)
        else:
            d.loc[m, "app"] = d.loc[m, "app_raw"]
    return d.app


def main():
    d = pd.read_parquet(C / "backtest_features.parquet").reset_index(drop=True)
    G = design(d)
    te = d[d.season == 2026].index
    T = d.loc[te]
    y = T.y_td.to_numpy(float)
    res = {"n_test": int(len(te)), "games": int(T.game_id.nunique()), "base_rate": float(y.mean())}
    preds = {}
    preds["constant_position"] = pd.Series(np.nan, index=d.index)
    for w in range(1, 10):
        m = (d.season == 2026) & (d.week == w); tr = (d.season == 2025) | ((d.season == 2026) & (d.week < w))
        preds["constant_position"][m] = d[m].pos.map(d[tr].groupby("pos").y_td.mean())
    preds["hist_rate"] = hist_rate(d)
    preds["team_x_workload"] = rolling(d, G, BASE)
    preds["app_current"] = app_current(d)
    res["models"] = {k: scores(v.loc[te].to_numpy(float), y) for k, v in preds.items() if k != "app_current"}
    a = T[preds["app_current"].loc[te].notna()].index
    res["app_subset"] = {"n": int(len(a)), "weeks": sorted(T.loc[a].week.unique().tolist()),
                         "app_current": scores(preds["app_current"].loc[a].to_numpy(float), d.loc[a].y_td.to_numpy(float)),
                         "team_x_workload": scores(preds["team_x_workload"].loc[a].to_numpy(float), d.loc[a].y_td.to_numpy(float)),
                         "hist_rate": scores(preds["hist_rate"].loc[a].to_numpy(float), d.loc[a].y_td.to_numpy(float)),
                         "twl_vs_app": compare(d.loc[a], preds["team_x_workload"].loc[a].to_numpy(float), preds["app_current"].loc[a].to_numpy(float))}
    res["twl_vs_hist_rate"] = compare(T, preds["team_x_workload"].loc[te].to_numpy(float), preds["hist_rate"].loc[te].to_numpy(float))
    # one group at a time on top of team x workload
    ref = preds["team_x_workload"].loc[te].to_numpy(float)
    res["add_one"] = {}
    for gname in CANDIDATES:
        p = rolling(d, G, BASE + [gname]); preds["+" + gname] = p
        c = compare(T, p.loc[te].to_numpy(float), ref)
        c["passes_gate"] = c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0
        res["add_one"][gname] = c
        print(gname, round(c["gain"] * 1000, 2), [round(x * 1000, 2) for x in c["ci90"]], c["by_pos"], c["passes_gate"], flush=True)
    # forward selection: keep adding the best passing group against the current model
    chosen = list(BASE); cur = ref; steps = []
    remaining = [g for g in CANDIDATES]
    while True:
        best = None
        for gname in remaining:
            p = rolling(d, G, chosen + [gname]).loc[te].to_numpy(float)
            c = compare(T, p, cur)
            ok = c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0
            if ok and (best is None or c["gain"] > best[1]["gain"]):
                best = (gname, c, p)
        if not best:
            break
        chosen.append(best[0]); remaining.remove(best[0]); cur = best[2]
        steps.append({"added": best[0], "gain": best[1]["gain"], "ci90": best[1]["ci90"], "by_pos": best[1]["by_pos"]})
        print("selected", best[0], flush=True)
    res["forward_selection"] = {"groups": chosen, "steps": steps}
    final = pd.Series(cur, index=te)
    res["final"] = {"scores": scores(final.to_numpy(), y), "vs_team_x_workload": compare(T, final.to_numpy(), ref),
                    "vs_hist_rate": compare(T, final.to_numpy(), preds["hist_rate"].loc[te].to_numpy(float)),
                    "calibration": calib(final.to_numpy(), y),
                    "by_pos": {p: scores(final[T.pos == p].to_numpy(), T[T.pos == p].y_td.to_numpy(float)) for p in POS},
                    "by_week": {int(w): scores(final[T.week == w].to_numpy(), T[T.week == w].y_td.to_numpy(float)) for w in range(1, 10)}}
    if len(a):
        res["final"]["vs_app_subset"] = compare(d.loc[a], final.loc[a].to_numpy(), preds["app_current"].loc[a].to_numpy(float))
    res["calibration_team_x_workload"] = calib(ref, y)
    res["calibration_app_current"] = calib(preds["app_current"].loc[a].to_numpy(float), d.loc[a].y_td.to_numpy(float)) if len(a) else None
    # goal-line vs long TD: which groups help each outcome (one at a time on base)
    res["split_outcomes"] = {}
    for tgt in ("y_gl", "y_long"):
        yy = T[tgt].to_numpy(float); base_p = rolling(d, G, BASE, tgt).loc[te].to_numpy(float)
        r = {"base": scores(base_p, yy)}
        for gname in ("scoring_opportunity", "long_td", "efficiency", "game_script"):
            p = rolling(d, G, BASE + [gname], tgt).loc[te].to_numpy(float)
            Tt = T.assign(y_td=T[tgt]); r[gname] = compare(Tt, p, base_p)
        res["split_outcomes"][tgt] = r
    # explanation (same-game actual usage) vs prediction
    A = pd.DataFrame({"a_i5": T.a_i5, "a_ez": T.a_ez, "lg_a_carries": lg(T.a_carries), "lg_a_targets": lg(T.a_targets), "a_snaps": T.a_snaps,
                      "a_team_offtd": T.a_team_offtd}).join(G["position"].loc[te])
    Xa = ((A - A.mean()) / A.std().replace(0, 1)).to_numpy(); b = fit_logit(Xa, y)
    pa = predict_logit(b, Xa)
    ll0 = ll(np.full(len(y), y.mean()), y).mean()
    res["explanation"] = {"in_sample_same_game": {"mcfadden_r2": float(1 - ll(pa, y).mean() / ll0), "std_coefs": dict(zip(A.columns, np.round(b[1:], 3).tolist()))},
                          "pregame_holdout_r2_final": float(1 - ll(final.to_numpy(), y).mean() / ll0),
                          "pregame_holdout_r2_team_x_workload": float(1 - ll(ref, y).mean() / ll0)}
    # coefficients of the final model fitted on everything up to week 9 (for the report)
    Xall, _, cols, *_ = matrix(G, chosen, d.index, d.index[:1])
    bfin = fit_logit(Xall, d.y_td.to_numpy(float))
    res["final_coefs_std"] = dict(zip(cols, np.round(bfin[1:], 3).tolist()))
    out = pd.DataFrame({k: v.loc[te] for k, v in preds.items()}).assign(final=final, game_id=T.game_id, week=T.week, pid=T.pid, pos=T.pos, team=T.team, y_td=T.y_td)
    out.to_parquet(C / "backtest_preds.parquet")
    (ROOT / "research" / "backtest_results.json").write_text(json.dumps(res, indent=1, default=float))
    print(json.dumps({k: res[k] for k in ("models", "forward_selection")}, indent=1, default=float))


if __name__ == "__main__":
    main()
