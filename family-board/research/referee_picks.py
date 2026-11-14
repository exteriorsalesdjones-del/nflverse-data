"""Pick test: do pregame crew indices improve the v0.3c Anytime TD model for runners (RB/QB) or pass catchers (WR/TE)?
Crew index for a game uses only games before that week (2024 + earlier weeks of the same/previous season), shrunk
6 games toward the league. Runners get the crew's offensive-holding and run-play-flag indices; pass catchers get
the pass-coverage and pass-play-flag indices (each as z-scores; zero for the other group).
Test A: 2025 weeks 6-18, trained on 2025 weeks before the target week.
Test B: 2026 games with a known referee, trained on 2025 + earlier 2026 weeks."""
import json, sys
import numpy as np, pandas as pd
sys.path.insert(0, "research"); sys.path.insert(0, "refresh")
import backtest as B
import model_v03 as M
d = pd.read_parquet(B.C / "backtest_features.parquet").reset_index(drop=True)
RG = pd.read_parquet(B.C / "referee_games.parquet"); R26 = pd.read_parquet(B.C / "referee_games_2526.parquet")
RG = pd.concat([RG, R26[R26.season == 2026]], ignore_index=True)
RG["t"] = (RG.season - 2024) * 20 + RG.week
ref_of = pd.concat([RG[["game_id", "referee"]]]).drop_duplicates("game_id").set_index("game_id").referee
COLS = ["off_holding", "run_play_flags", "pass_coverage", "pass_play_flags"]
def crew_idx(season, week):
    t0 = (season - 2024) * 20 + week; h = RG[RG.t < t0].copy()
    h["w"] = np.where(h.season == season, 1.0, np.where(h.season == season - 1, 0.5, 0.25))
    lg = {c: np.average(h[c], weights=h.w) for c in COLS}; sd = {c: h[c].std() for c in COLS}
    g = h.groupby("referee")
    out = {}
    for ref, x in g:
        n = x.w.sum(); out[ref] = {c: (((x[c] * x.w).sum() + 6 * lg[c]) / (n + 6) - lg[c]) / sd[c] for c in COLS}
    return out
d["referee"] = d.game_id.map(ref_of)
for c in COLS:
    d["crew_" + c] = np.nan
for (s, w), idx in d.groupby(["season", "week"]).groups.items():
    ci = crew_idx(s, w)
    for c in COLS:
        d.loc[idx, "crew_" + c] = [ci.get(r, {}).get(c, 0.0) if isinstance(r, str) else np.nan for r in d.loc[idx, "referee"]]
runner = d.pos.isin(["RB", "QB"]).astype(float); catcher = d.pos.isin(["WR", "TE"]).astype(float)
X0 = M.design(d)
CREW = pd.DataFrame({"run_holding": d.crew_off_holding * runner, "run_flags": d.crew_run_play_flags * runner,
                     "pass_cov": d.crew_pass_coverage * catcher, "pass_flags": d.crew_pass_play_flags * catcher}).fillna(0)
X1 = pd.concat([X0, CREW], axis=1)
def roll(X, test_mask_fn, train_mask_fn, weeks):
    out = pd.Series(np.nan, index=d.index)
    for (s, w) in weeks:
        te = test_mask_fn(s, w); tr = train_mask_fn(s, w)
        if te.sum() == 0:
            continue
        A = X[tr]; med = A.median(); A = A.fillna(med); mu = A.mean(); sd = A.std().replace(0, 1)
        b = M.fit(((A - mu) / sd).to_numpy(), d.loc[tr, "y_td"].to_numpy(float))
        Z = ((X[te].fillna(med) - mu) / sd).to_numpy(); out[te] = 1 / (1 + np.exp(-(b[0] + Z @ b[1:])))
    return out
res = {}
known = d.referee.notna()
tests = {
  "A_2025_w6_18": ([(2025, w) for w in range(6, 19)], lambda s, w: known & (d.season == s) & (d.week == w), lambda s, w: (d.season == 2025) & (d.week < w)),
  "B_2026_known_ref": ([(2026, w) for w in range(1, 10)], lambda s, w: known & (d.season == s) & (d.week == w), lambda s, w: (d.season == 2025) | ((d.season == 2026) & (d.week < w))),
}
for name, (weeks, tm, trm) in tests.items():
    p0 = roll(X0, tm, trm, weeks); p1 = roll(X1, tm, trm, weeks)
    m = p0.notna(); T = d[m]
    c = B.compare(T, p1[m].to_numpy(float), p0[m].to_numpy(float))
    grp = {}
    for gname, gm in {"runners_RB_QB": T.pos.isin(["RB", "QB"]), "pass_catchers_WR_TE": T.pos.isin(["WR", "TE"])}.items():
        cc = B.compare(T[gm], p1[m][gm].to_numpy(float), p0[m][gm].to_numpy(float)); grp[gname] = {"n": int(gm.sum()), "gain_x1000": round(cc["gain"] * 1000, 2), "ci90_x1000": [round(x * 1000, 2) for x in cc["ci90"]]}
    res[name] = {"n": int(m.sum()), "games": int(T.game_id.nunique()), "gain_x1000": round(c["gain"] * 1000, 2), "ci90_x1000": [round(x * 1000, 2) for x in c["ci90"]], "by_group": grp,
                 "passes_gate": c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0}
    print(name, json.dumps(res[name]), flush=True)
json.dump(res, open("research/referee_picks_results.json", "w"), indent=1)
