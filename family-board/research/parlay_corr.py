"""Do two players' touchdown chances move together, and does modelling that beat multiplying their chances?

Pairs of skill players in the same game, each with a pregame model chance (usage-v0.3c, rolling: every week forecast
from earlier weeks only). Compared: independence (p_a x p_b) against a one-parameter dependence model that leaves
each player's own chance unchanged:
    P(none of a set scores) = (1 + sum_i((1 - p_i)^(-1/k) - 1))^(-k)
k > 0: the players' chances rise and fall together (a shared scoring environment); smaller k = stronger.
k < 0: they compete for a limited number of scores, n = -k (teammates); smaller n = stronger. |k| large = independence.
k is fitted on 2025 pairs and scored once on 2026 pairs. Same-team and opposite-team pairs are fitted separately.
Run: python3 research/parlay_corr.py -> research/parlay_corr_results.json
"""
import json, sys
from itertools import combinations
from pathlib import Path
import numpy as np, pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh")); sys.path.insert(0, str(ROOT / "research"))
import features as F, model_v03 as M, backtest as B   # noqa: E402

d = pd.read_parquet(F.C / "improvements_features.parquet").reset_index(drop=True)
X = M.design(d).astype(float)
def roll(season, weeks, prior):
    out = pd.Series(np.nan, index=d.index)
    for w in weeks:
        tr = d.index[((d.season == 2025) & prior) | ((d.season == season) & (d.week < w))] if season == 2026 else d.index[(d.season == 2025) & (d.week < w)]
        te = d.index[(d.season == season) & (d.week == w)]
        if len(tr) < 400 or not len(te): continue
        a, b = X.loc[tr], X.loc[te]; med = a.median(); a = a.fillna(med); b = b.fillna(med); mu, sd = a.mean(), a.std().replace(0, 1)
        c = M.fit(((a - mu) / sd).to_numpy(), d.loc[tr, "y_td"].to_numpy(float)); out.loc[te] = 1 / (1 + np.exp(-(c[0] + ((b - mu) / sd).to_numpy() @ c[1:])))
    return out
d["p"] = roll(2025, range(6, 19), False).fillna(roll(2026, sorted(d[d.season == 2026].week.unique()), True))
T = d[d.p.notna() & (d.p >= 0.08)].copy()

def pairs(season):
    rows = []
    for gid, g in T[T.season == season].groupby("game_id"):
        r = g[["pid", "team", "pos", "p", "y_td"]].to_numpy()
        for a, b in combinations(range(len(r)), 2):
            rows.append((gid, r[a][1] == r[b][1], r[a][2], r[b][2], r[a][3], r[b][3], int(r[a][4] and r[b][4]), int(r[a][4]), int(r[b][4])))
    return pd.DataFrame(rows, columns=["game_id", "same_team", "pos_a", "pos_b", "pa", "pb", "both", "ya", "yb"])

def joint(pa, pb, k):
    if k is None: return pa * pb
    none = np.clip(1 + ((1 - pa) ** (-1 / k) - 1) + ((1 - pb) ** (-1 / k) - 1), 1e-9, None) ** (-k)
    return np.clip(pa + pb - 1 + none, 1e-6, 1 - 1e-6)
def ll(P, y): P = np.clip(P, 1e-6, 1 - 1e-6); return -(y * np.log(P) + (1 - y) * np.log(1 - P))
def boot(df, gain, n=1000):
    per = pd.Series(gain, index=df.index).groupby(df.game_id).sum(); cnt = df.groupby("game_id").size(); rng = np.random.default_rng(7); ids = np.arange(len(per)); bs = []
    for _ in range(n):
        s = rng.choice(ids, len(ids)); bs.append(per.iloc[s].sum() / cnt.iloc[s].sum())
    return [float(np.percentile(bs, 5)), float(np.percentile(bs, 95))]
KS = [2, 3, 4, 6, 8, 12, 20, 40, -40, -20, -12, -10, -8, -7, -6, -5, -4, -3]
P25, P26 = pairs(2025), pairs(2026); res = {"min_chance": 0.08, "groups": {}}
for name, sel in (("same team", lambda q: q.same_team), ("opposite teams", lambda q: ~q.same_team)):
    a, b = P25[sel(P25)], P26[sel(P26)]
    fit = {k: float(ll(joint(a.pa.to_numpy(), a.pb.to_numpy(), k), a.both.to_numpy()).mean()) for k in KS}; fit[None] = float(ll(joint(a.pa.to_numpy(), a.pb.to_numpy(), None), a.both.to_numpy()).mean())
    kbest = min(KS, key=lambda k: fit[k])
    out = {"pairs_2025": len(a), "pairs_2026": len(b), "k_fitted_on_2025": kbest, "loss_2025": {"independent": fit[None], "correlated": fit[kbest]}}
    for lab, q in (("2025", a), ("2026", b)):
        ind = joint(q.pa.to_numpy(), q.pb.to_numpy(), None); cor = joint(q.pa.to_numpy(), q.pb.to_numpy(), kbest); y = q.both.to_numpy()
        g = ll(ind, y) - ll(cor, y)
        out[lab] = {"observed_both": float(y.mean()), "independent_says": float(ind.mean()), "correlated_says": float(cor.mean()), "gain_x1000": float(g.mean() * 1000), "ci90_x1000": [x * 1000 for x in boot(q, g)],
                    "corr_of_outcomes": float(np.corrcoef(q.ya, q.yb)[0, 1])}
    res["groups"][name] = out
    print(f"{name}: pairs 2025 {len(a)}, 2026 {len(b)} | k fitted on 2025 = {kbest}")
    for lab in ("2025", "2026"):
        o = out[lab]; print(f"   {lab}: both scored {o['observed_both']:.4f} | multiply says {o['independent_says']:.4f} | correlated says {o['correlated_says']:.4f} | gain x1000 {o['gain_x1000']:+.2f} [{o['ci90_x1000'][0]:+.2f}, {o['ci90_x1000'][1]:+.2f}] | outcome correlation {o['corr_of_outcomes']:+.3f}")
# same team by position pairing (2025 + 2026 together): where is the dependence?
A = pd.concat([P25, P26]); A = A[A.same_team]
A["kind"] = [("RB+RB" if x == y == "RB" else "QB+other" if "QB" in (x, y) else "RB+pass catcher" if "RB" in (x, y) else "two pass catchers") for x, y in zip(A.pos_a, A.pos_b)]
res["same_team_by_kind"] = {}
for kd, q in A.groupby("kind"):
    res["same_team_by_kind"][kd] = {"pairs": len(q), "observed_both": float(q.both.mean()), "independent_says": float((q.pa * q.pb).mean()), "ratio": float(q.both.mean() / (q.pa * q.pb).mean())}
    print(f"   {kd:18s} pairs {len(q):5d} | both scored {q.both.mean():.4f} | multiply says {(q.pa * q.pb).mean():.4f} | ratio {q.both.mean() / (q.pa * q.pb).mean():.2f}")
json.dump(res, open(ROOT / "research" / "parlay_corr_results.json", "w"), indent=1)

# ---- The 2025 chances are fitted on 2025 alone and run high for these players, which the fit above mistakes for
# dependence. Check, then choose n on 2026 (where the chances are well calibrated) by leaving one week out at a time.
for s in (2025, 2026):
    q = T[T.season == s]; print(f"players in pairs, {s}: average chance {q.p.mean():.4f}, scored {q.y_td.mean():.4f}")
res["calibration_of_singles"] = {str(s): {"avg_chance": float(T[T.season == s].p.mean()), "scored": float(T[T.season == s].y_td.mean())} for s in (2025, 2026)}
W = pd.read_parquet(F.C / "improvements_features.parquet")[["game_id", "week", "season"]].drop_duplicates("game_id").set_index("game_id").week
Q = P26[P26.same_team].copy(); Q["week"] = Q.game_id.map(W)
NS = [-3, -4, -5, -6, -8, -10, -12, -16, -20, -30, -40]
gains = []; chosen = []
for wk in sorted(Q.week.unique()):
    tr, te = Q[Q.week != wk], Q[Q.week == wk]
    kb = min(NS, key=lambda k: ll(joint(tr.pa.to_numpy(), tr.pb.to_numpy(), k), tr.both.to_numpy()).mean()); chosen.append(-kb)
    gains.append(pd.Series(ll(joint(te.pa.to_numpy(), te.pb.to_numpy(), None), te.both.to_numpy()) - ll(joint(te.pa.to_numpy(), te.pb.to_numpy(), kb), te.both.to_numpy()), index=te.index))
g = pd.concat(gains).reindex(Q.index); full = min(NS, key=lambda k: ll(joint(Q.pa.to_numpy(), Q.pb.to_numpy(), k), Q.both.to_numpy()).mean())
cv = {"n_chosen_each_fold": chosen, "n_on_all_2026": -full, "gain_x1000": float(g.mean() * 1000), "ci90_x1000": [x * 1000 for x in boot(Q, g.to_numpy())],
      "observed_both": float(Q.both.mean()), "multiply_says": float((Q.pa * Q.pb).mean()), "model_says": float(joint(Q.pa.to_numpy(), Q.pb.to_numpy(), full).mean())}
res["same_team_2026_leave_one_week_out"] = cv
print("same team, 2026, leave one week out:", json.dumps(cv))
for k in (-6, -8, -10, -12, -16):
    m = joint(Q.pa.to_numpy(), Q.pb.to_numpy(), k); gg = ll(joint(Q.pa.to_numpy(), Q.pb.to_numpy(), None), Q.both.to_numpy()) - ll(m, Q.both.to_numpy())
    print(f"   n={-k}: says {m.mean():.4f} (observed {Q.both.mean():.4f}) gain x1000 {gg.mean()*1000:+.2f} {[round(x*1000,2) for x in boot(Q, gg)]}")
json.dump(res, open(ROOT / "research" / "parlay_corr_results.json", "w"), indent=1)

# Is the shortfall itself real on 2026? Difference between how often both scored and what multiplying says, by game.
def boot_mean(df, v, n=2000):
    per = pd.Series(v, index=df.index).groupby(df.game_id).sum(); cnt = df.groupby("game_id").size(); rng = np.random.default_rng(3); ids = np.arange(len(per)); bs = []
    for _ in range(n):
        s = rng.choice(ids, len(ids)); bs.append(per.iloc[s].sum() / cnt.iloc[s].sum())
    return [float(np.percentile(bs, 5)), float(np.percentile(bs, 95))]
for lab, q in (("same team", P26[P26.same_team]), ("opposite teams", P26[~P26.same_team])):
    diff = (q.both - q.pa * q.pb).to_numpy(); ci = boot_mean(q, diff)
    res.setdefault("shortfall_2026", {})[lab] = {"observed_minus_multiply": float(diff.mean()), "ci90": ci, "ratio": float(q.both.mean() / (q.pa * q.pb).mean())}
    print(f"2026 {lab}: both scored minus multiply = {diff.mean():+.4f} [{ci[0]:+.4f}, {ci[1]:+.4f}] ratio {q.both.mean() / (q.pa * q.pb).mean():.2f}")
json.dump(res, open(ROOT / "research" / "parlay_corr_results.json", "w"), indent=1)
