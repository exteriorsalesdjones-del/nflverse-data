"""Gate check of candidate models against the app's current model, plus a market comparison on Weeks 2-4 prices."""
import json, re, numpy as np, pandas as pd, sys
sys.path.insert(0, "research")
import backtest as B
d = pd.read_parquet(B.C / "backtest_features.parquet").reset_index(drop=True)
G = B.design(d)
rush_like = d.pos.isin(["RB", "QB"]).astype(float); so = G["scoring_opportunity"]
G["gl_rush_by_pos"] = pd.DataFrame({"i5": so.lg_i5_share, "gtg": so.lg_gtg_share, "des": so.qb_designed_g, "sneak": so.qb_sneaks_g}).mul(rush_like, axis=0)
G["depth_rank"] = G["recent_role"][["depth_rank"]]
te = d[d.season == 2026].index; T = d.loc[te]; y = T.y_td.to_numpy(float)
P = pd.read_parquet(B.C / "backtest_preds.parquet")
app = P.app_current.reindex(te) if False else pd.Series(P.app_current.values, index=te)
cands = {"v0.3a = team x workload + goal-line rushing": B.BASE + ["gl_rush_by_pos"],
         "v0.3b = v0.3a + depth rank": B.BASE + ["gl_rush_by_pos", "depth_rank"],
         "v0.3c = v0.3b + player TD rate": B.BASE + ["gl_rush_by_pos", "depth_rank", "player_td_rate"],
         "team x workload": B.BASE}
a = te[app.notna().values]
res = {"app_subset_n": int(len(a))}; preds = {}
for name, groups in cands.items():
    p = B.rolling(d, G, groups); preds[name] = p
    c = B.compare(d.loc[a], p.loc[a].to_numpy(float), app.loc[a].to_numpy(float))
    c["passes_gate"] = c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0
    full = B.scores(p.loc[te].to_numpy(float), y)
    res[name] = {"vs_app": c, "all_weeks": full, "calibration": B.calib(p.loc[te].to_numpy(float), y),
                 "by_week": {int(w): B.scores(p.loc[te][T.week == w].to_numpy(float), T[T.week == w].y_td.to_numpy(float)) for w in range(1, 10)},
                 "by_pos": {q: B.scores(p.loc[te][T.pos == q].to_numpy(float), T[T.pos == q].y_td.to_numpy(float)) for q in B.POS}}
    print(name, "vs app", round(c["gain"]*1000, 2), [round(x*1000, 2) for x in c["ci90"]], c["by_pos"], "PASS" if c["passes_gate"] else "FAIL", full, flush=True)
# ---- market comparison (FanDuel anytime prices captured before kickoff, weeks 3-4; BetMGM wk2-3 articles)
m = pd.read_csv("/tmp/claude-0/-home-user-nflverse-data/74951fdd-f9aa-5eef-be5e-7d0f85d50476/scratchpad/drive_odds/market_prices.csv")
m = m[m.market.astype(str).str.lower().str.contains("any")].copy()
pl = pd.read_parquet(B.C / "players.parquet")[["gsis_id", "display_name", "position"]].dropna(subset=["gsis_id"])
norm = lambda s: re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", str(s).lower()))
pl["k"] = pl.display_name.map(norm); m["k"] = m.player.map(norm)
T2 = T.assign(k=T.pid.map(pl.set_index("gsis_id").k))
m["week"] = m.week.astype(int)
j = m.merge(T2[["k", "week", "team", "pid", "game_id", "y_td"]].reset_index(), on=["k", "week"], how="inner")
j = j[(j.team_x if "team_x" in j else j.team) == (j.team_y if "team_y" in j else j.team)] if "team_x" in j else j
j = j.sort_values("captured_at").groupby(["index"]).tail(1)  # latest pre-kickoff capture per player-game
j["imp"] = np.where(j.american > 0, 100 / (j.american + 100), -j.american / (-j.american + 100))
res["market"] = {"rows_in_csv": int(len(m)), "matched_player_games": int(len(j)), "by_week": j.week.value_counts().sort_index().to_dict(), "books": j.book.value_counts().to_dict()}
yy = j.y_td.to_numpy(float)
mk = {"market_raw_implied": j.imp.to_numpy()}
# remove overround with one scale factor fitted on week 3, applied to week 4 (and vice versa)
f3 = (j[j.week == 3].y_td.mean() / j[j.week == 3].imp.mean()); f4 = (j[j.week == 4].y_td.mean() / j[j.week == 4].imp.mean())
mk["market_devig_crossweek"] = np.where(j.week == 3, j.imp * f4, j.imp * f3)
for name in cands:
    mk[name] = preds[name].loc[j["index"]].to_numpy(float)
mk["app_current"] = app.loc[j["index"]].to_numpy(float)
res["market"]["scores"] = {k: B.scores(np.clip(v, 1e-4, 1 - 1e-4), yy) for k, v in mk.items() if not np.isnan(v).any()}
res["market"]["note"] = "FanDuel 'Yes' prices typed from app screenshots (one-sided, vig included); matched by name+week to 2026 player-games who took a snap"
best = "v0.3a = team x workload + goal-line rushing"
jj = d.loc[j["index"]].assign(y_td=yy)
res["market"]["v03a_vs_market_devig"] = B.compare(jj, mk[best], mk["market_devig_crossweek"])
res["market"]["v03a_corr_with_market"] = float(np.corrcoef(mk[best], j.imp)[0, 1])
print(json.dumps(res["market"], indent=1, default=float))
pd.DataFrame({k: v.loc[te] for k, v in preds.items()}).assign(app=app, y=T.y_td, week=T.week, pos=T.pos, pid=T.pid, game_id=T.game_id, team=T.team).to_parquet(B.C / "candidate_preds.parquet")
json.dump(res, open("research/candidates_results.json", "w"), indent=1, default=float)
