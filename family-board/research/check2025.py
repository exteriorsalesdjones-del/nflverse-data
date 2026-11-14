"""Out-of-sample check of position scope on 2025 (train 2025 weeks < w, test weeks 10-18), independent of 2026."""
import json, numpy as np, pandas as pd, sys
sys.path.insert(0, "research")
import backtest as B
d = pd.read_parquet(B.C / "backtest_features.parquet").reset_index(drop=True)
d = d[d.season == 2025].reset_index(drop=True)
G = B.design(d)
rush_like = d.pos.isin(["RB", "QB"]).astype(float)
so = G["scoring_opportunity"]
G["gl_rush_by_pos"] = pd.DataFrame({"i5": so.lg_i5_share, "gtg": so.lg_gtg_share, "des": so.qb_designed_g, "sneak": so.qb_sneaks_g}).mul(rush_like, axis=0)
G["ez_targets"] = pd.DataFrame({"ez": so.lg_ez_share, "rz": so.lg_rz_share})
G["depth_rank"] = G["recent_role"][["depth_rank"]]
G["recent_share_change"] = G["recent_role"][["d_carry_share", "d_target_share", "d_snap_share"]]
def roll(groups):
    out = pd.Series(np.nan, index=d.index)
    for w in range(10, 19):
        tr = d.index[d.week < w]; te = d.index[d.week == w]
        Xtr, Xte, *_ = B.matrix(G, groups, tr, te)
        out.loc[te] = B.predict_logit(B.fit_logit(Xtr, d.loc[tr, "y_td"].to_numpy(float)), Xte)
    return out
te = d.index[d.week >= 10]; T = d.loc[te]
ref = roll(B.BASE).loc[te].to_numpy(float)
res = {"n": int(len(te))}
for g in ["gl_rush_by_pos", "ez_targets", "depth_rank", "recent_share_change", "long_td", "workload_extra", "player_td_rate", "game_script", "injuries_lineup", "matchup", "efficiency"]:
    p = roll(B.BASE + [g]).loc[te].to_numpy(float); c = B.compare(T, p, ref); res[g] = c
    print(g, round(c["gain"]*1000, 2), [round(x*1000, 2) for x in c["ci90"]], c["by_pos"], flush=True)
json.dump(res, open("research/check2025_results.json", "w"), indent=1, default=float)
