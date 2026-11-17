"""Do three proposed improvements beat usage-v0.3c on weeks they have not seen?

  1. market blend      model + sportsbook implied chance (only where pre-kickoff prices exist: 2026 Weeks 2-4)
  2. defense inputs    split by how the TD is scored, opponent-adjusted (refresh/features_plus.py)
  3. role changes      recent goal-line work, vacated work, next man up, depth-chart promotion

Same rules as research/backtest.py: every 2026 week is forecast from 2025 + earlier 2026 weeks only; an input is adopted
only if the 90% bootstrap interval (resampling games) of its log-loss gain over v0.3c is above zero AND no position
gets worse. Each group is also checked on 2025 alone (train weeks < w, test weeks 10-18) as an independent season.
Run: python3 research/improvements.py [--rebuild]      -> research/improvements_results.json
"""
import json, re, sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh")); sys.path.insert(0, str(ROOT / "research"))
import backtest as B          # noqa: E402
import features as F          # noqa: E402
import features_plus as FP    # noqa: E402
import model_v03 as M         # noqa: E402

CACHE = F.C / "improvements_features.parquet"
players = pd.read_parquet(F.C / "players.parquet")
MAXW = int(pd.read_parquet(F.C / "play_by_play_2026.parquet", columns=["week", "season_type"]).query("season_type == 'REG'").week.max())
if "--rebuild" in sys.argv or not CACHE.exists():
    d = F.build(players, max_week_2026=MAXW).reset_index(drop=True)
    d = FP.add(FP.load(players, MAXW), d); d.to_parquet(CACHE)
d = pd.read_parquet(CACHE).reset_index(drop=True)
WEEKS = sorted(d[d.season == 2026].week.unique())
BASE = M.design(d); G = FP.groups(d)


def roll(extra, season=2026, weeks=None, train_prior=True):
    X = pd.concat([BASE] + [G[g] for g in extra], axis=1).astype(float)
    out = pd.Series(np.nan, index=d.index)
    for w in (weeks or WEEKS):
        tr = d.index[((d.season == 2025) & train_prior) | ((d.season == season) & (d.week < w))] if season == 2026 else d.index[(d.season == 2025) & (d.week < w)]
        te = d.index[(d.season == season) & (d.week == w)]
        a, b = X.loc[tr], X.loc[te]; med = a.median(); a = a.fillna(med); b = b.fillna(med); mu, sd = a.mean(), a.std().replace(0, 1)
        coef = M.fit(((a - mu) / sd).to_numpy(), d.loc[tr, "y_td"].to_numpy(float))
        out.loc[te] = 1 / (1 + np.exp(-(coef[0] + ((b - mu) / sd).to_numpy() @ coef[1:])))
    return out


res = {"weeks_2026": [int(w) for w in WEEKS], "n_2026": int((d.season == 2026).sum()), "rule": "adopt only if ci90 low > 0 and no position worse"}
te26 = d.index[d.season == 2026]; T26 = d.loc[te26]; te25 = d.index[(d.season == 2025) & (d.week >= 10)]; T25 = d.loc[te25]
ref26 = roll([]); ref25 = roll([], season=2025, weeks=range(10, 19))
res["v03c"] = {"2026": B.scores(ref26.loc[te26].to_numpy(float), T26.y_td.to_numpy(float)), "2025_w10_18": B.scores(ref25.loc[te25].to_numpy(float), T25.y_td.to_numpy(float))}
print("v0.3c", res["v03c"], flush=True)
SETS = {"def_epa": ["def_epa"], "def_td_split": ["def_td_split"], "def_pos_share": ["def_pos_share"], "defense_all": ["def_epa", "def_td_split", "def_pos_share"],
        "role_goal_line": ["role_goal_line"], "role_workload": ["role_workload"], "role_vacated": ["role_vacated"], "role_depth": ["role_depth"],
        "role_all": ["role_goal_line", "role_workload", "role_vacated", "role_depth"]}
res["inputs"] = {}; preds = {}
for name, gs in SETS.items():
    p26 = roll(gs); p25 = roll(gs, season=2025, weeks=range(10, 19)); preds[name] = p26
    c26 = B.compare(T26, p26.loc[te26].to_numpy(float), ref26.loc[te26].to_numpy(float)); c25 = B.compare(T25, p25.loc[te25].to_numpy(float), ref25.loc[te25].to_numpy(float))
    ok = c26["ci90"][0] > 0 and min(c26["by_pos"].values()) >= 0
    res["inputs"][name] = {"2026": c26, "2025_w10_18": c25, "passes_gate": bool(ok), "also_positive_2025": bool(c25["gain"] > 0)}
    print(f"{name:15s} 2026 gain x1000 {c26['gain']*1000:+.2f} ci90 [{c26['ci90'][0]*1000:+.2f}, {c26['ci90'][1]*1000:+.2f}] by pos {c26['by_pos']} | 2025 {c25['gain']*1000:+.2f} [{c25['ci90'][0]*1000:+.2f}, {c25['ci90'][1]*1000:+.2f}] | {'PASS' if ok else 'fail'}", flush=True)

# ---------------------------------------------------------------- 1. market blend
mp = Path(sys.argv[sys.argv.index("--prices") + 1]) if "--prices" in sys.argv else None
if mp and mp.exists():
    m = pd.read_csv(mp); m = m[m.market.astype(str).str.lower().str.contains("any")].copy()
    norm = lambda s: re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", str(s).lower()))
    pl = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").display_name.map(norm)
    T2 = T26.assign(k=T26.pid.map(pl), p_model=ref26.loc[te26]); m["k"] = m.player.map(norm); m["week"] = m.week.astype(int)
    j = m.merge(T2[["k", "week", "pid", "pos", "game_id", "y_td", "p_model"]], on=["k", "week"], how="inner")
    j = j.sort_values("captured_at").groupby(["pid", "week"]).tail(1).reset_index(drop=True)   # latest capture before kickoff
    j["imp"] = np.where(j.american > 0, 100 / (j.american + 100), -j.american / (-j.american + 100))
    y = j.y_td.to_numpy(float); lgt = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4))); sg = lambda z: 1 / (1 + np.exp(-z))
    P = {"model": j.p_model.to_numpy(float), "market_raw": j.imp.to_numpy(float)}
    # fitted on the OTHER weeks only (leave one week out): a + b1*logit(model) + b2*logit(market)
    for nm, cols in (("market_recalibrated", ["imp"]), ("blend_fitted", ["p_model", "imp"])):
        out = np.full(len(j), np.nan)
        for wk in sorted(j.week.unique()):
            tr = (j.week != wk).to_numpy(); te = ~tr
            if tr.sum() < 60:
                continue
            Xa = np.column_stack([lgt(j.loc[tr, c].to_numpy(float)) for c in cols]); Xb = np.column_stack([lgt(j.loc[te, c].to_numpy(float)) for c in cols])
            coef = M.fit(Xa, y[tr], l2=0.5); out[te] = sg(coef[0] + Xb @ coef[1:])
        P[nm] = out
    # no fitted weights at all: equal parts model and (recalibrated) market on the logit scale
    P["blend_equal"] = sg(0.5 * lgt(P["model"]) + 0.5 * lgt(P["market_recalibrated"]))
    # the form the app can use without any fitting: equal parts model and the price's raw implied chance (margin included)
    P["blend_equal_raw"] = sg(0.5 * lgt(P["model"]) + 0.5 * lgt(P["market_raw"]))
    # as adopted: RB / WR / TE only; a QB keeps the model's chance (the QB rows are the one group where prices did worse)
    P["blend_equal_raw_no_qb"] = np.where((j.pos == "QB").to_numpy(), P["model"], P["blend_equal_raw"])
    P["blend_30_70_raw"] = sg(0.3 * lgt(P["model"]) + 0.7 * lgt(P["market_raw"]))
    ok = ~np.isnan(P["blend_fitted"]); jj = j[ok]
    mk = {"n": int(ok.sum()), "by_week": jj.week.value_counts().sort_index().to_dict(), "books": jj.book.value_counts().to_dict(), "games": int(jj.game_id.nunique()),
          "scores": {k: B.scores(v[ok], y[ok]) for k, v in P.items()}, "vs_model": {}}
    mk["n_by_pos"] = jj.pos.value_counts().to_dict(); print("market rows by position", mk["n_by_pos"], "by week", mk["by_week"], "games", mk["games"])
    for k in ("market_raw", "market_recalibrated", "blend_fitted", "blend_equal", "blend_equal_raw", "blend_equal_raw_no_qb", "blend_30_70_raw"):
        c = B.compare(jj, P[k][ok], P["model"][ok]); c["passes_gate"] = bool(c["ci90"][0] > 0 and min(c["by_pos"].values()) >= 0); mk["vs_model"][k] = c
        c["by_week"] = {int(w): round(float((B.ll(P["model"][ok], y[ok]) - B.ll(P[k][ok], y[ok]))[(jj.week == w).to_numpy()].mean() * 1000), 2) for w in sorted(jj.week.unique())}
        print(f"market {k:20s} log loss {mk['scores'][k]['log_loss']:.4f} (model {mk['scores']['model']['log_loss']:.4f}) gain x1000 {c['gain']*1000:+.2f} ci90 [{c['ci90'][0]*1000:+.2f}, {c['ci90'][1]*1000:+.2f}] by pos {c['by_pos']} by week {c['by_week']} {'PASS' if c['passes_gate'] else 'fail'}", flush=True)
    full = M.fit(np.column_stack([lgt(j.p_model.to_numpy(float)), lgt(j.imp.to_numpy(float))]), y, l2=0.5)
    mk["blend_coefs_all_rows"] = {"intercept": float(full[0]), "logit_model": float(full[1]), "logit_market": float(full[2])}
    mk["corr_model_market"] = float(np.corrcoef(lgt(P["model"]), lgt(P["market_raw"]))[0, 1])
    res["market"] = mk
json.dump(res, open(ROOT / "research" / "improvements_results.json", "w"), indent=1, default=float)
print("saved research/improvements_results.json")
