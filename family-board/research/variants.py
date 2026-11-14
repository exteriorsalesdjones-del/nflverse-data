"""Diagnose sub-groups: which parts of recent_role / scoring_opportunity help or hurt, by position."""
import json, numpy as np, pandas as pd, sys
sys.path.insert(0, "research")
import backtest as B
d = pd.read_parquet(B.C / "backtest_features.parquet").reset_index(drop=True)
G = B.design(d); te = d[d.season == 2026].index; T = d.loc[te]
rush_like = d.pos.isin(["RB", "QB"]).astype(float); rec_like = d.pos.isin(["WR", "TE"]).astype(float)
so = G["scoring_opportunity"]
G["gl_rush"] = pd.DataFrame({"lg_i5_share": so.lg_i5_share, "lg_gtg_share": so.lg_gtg_share, "qb_designed_g": so.qb_designed_g, "qb_sneaks_g": so.qb_sneaks_g})
G["ez_targets"] = pd.DataFrame({"lg_ez_share": so.lg_ez_share, "lg_rz_share": so.lg_rz_share})
G["gl_rush_by_pos"] = G["gl_rush"].mul(rush_like, axis=0).add_suffix("_rbqb")
G["ez_by_pos_wr"] = G["ez_targets"].mul((d.pos == "WR").astype(float), axis=0).add_suffix("_wr")
G["scoring_opp_by_pos"] = pd.concat([G["gl_rush_by_pos"], G["ez_by_pos_wr"]], axis=1)
rr = G["recent_role"]
G["recent_share_change"] = rr[["d_carry_share", "d_target_share", "d_snap_share"]]
G["depth_rank"] = rr[["depth_rank"]]
G["long_td_by_pos"] = G["long_td"].mul(rec_like + rush_like, axis=0)
ref = B.rolling(d, G, B.BASE).loc[te].to_numpy(float)
out = {}
for g in ["gl_rush", "ez_targets", "gl_rush_by_pos", "ez_by_pos_wr", "scoring_opp_by_pos", "recent_share_change", "depth_rank", "workload_extra", "player_td_rate"]:
    p = B.rolling(d, G, B.BASE + [g]).loc[te].to_numpy(float); c = B.compare(T, p, ref)
    c["passes_gate"] = c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0
    out[g] = c; print(g, round(c["gain"] * 1000, 2), [round(x * 1000, 2) for x in c["ci90"]], c["by_pos"], "PASS" if c["passes_gate"] else "", flush=True)
# combination: scoring_opp_by_pos + next best
best = B.BASE + ["scoring_opp_by_pos"]; pb = B.rolling(d, G, best).loc[te].to_numpy(float)
for g in ["recent_share_change", "depth_rank", "long_td", "workload_extra", "player_td_rate", "game_script", "injuries_lineup", "matchup", "efficiency"]:
    p = B.rolling(d, G, best + [g]).loc[te].to_numpy(float); c = B.compare(T, p, pb)
    c["passes_gate"] = c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0
    out["after_sobp+" + g] = c; print("  +", g, round(c["gain"] * 1000, 2), [round(x * 1000, 2) for x in c["ci90"]], c["by_pos"], "PASS" if c["passes_gate"] else "", flush=True)
json.dump(out, open("research/variants_results.json", "w"), indent=1, default=float)
