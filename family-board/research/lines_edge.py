"""Is there an edge on game totals or spreads? Every option, tested out of sample.

Models are tuned on the 2025 season (ratings start from 2024) and then frozen and scored once on 2026. Situational
angles are counted on 2015-2023 and checked on 2024-2026. A bet at -110 needs 52.4% to break even. With this many
things tried, a few will look good by chance: only what holds on the held-out seasons counts.
Run: python3 research/lines_edge.py   -> research/lines_edge_results.json
"""
import itertools, json, math, sys
from pathlib import Path
import numpy as np, pandas as pd

ROOT = Path(__file__).resolve().parents[1]; C = ROOT / ".data" / "cache"
G = pd.read_csv(C / "games.csv"); G = G[(G.game_type == "REG") & G.home_score.notna()].copy()
G["act_total"] = G.home_score + G.away_score; G["act_margin"] = G.home_score - G.away_score      # home minus away


def team_games(y):
    p = pd.read_parquet(C / f"play_by_play_{y}.parquet"); p = p[p.season_type == "REG"].sort_values(["game_id", "play_id"])
    q = p[p.play_type.isin(["run", "pass"]) & (p.two_point_attempt != 1)]
    plays = q.groupby(["game_id", "posteam"]).agg(plays=("play_id", "size"), epa=("epa", "sum")).reset_index().rename(columns={"posteam": "team"})
    td = p[(p.touchdown == 1) & p.td_team.notna()].copy(); td["off"] = ((td.pass_touchdown == 1) | (td.rush_touchdown == 1)) & (td.td_team == td.posteam)
    p["td_off"] = np.nan; p.loc[td.index, "td_off"] = td.off.astype(float); p["last"] = p.groupby("game_id").td_off.ffill()
    parts = [td[td.off].assign(team=lambda d: d.td_team, v=6)[["game_id", "team", "v"]]]
    xp = p[(p.extra_point_result == "good") & (p["last"] == 1)]; parts.append(xp.assign(team=xp.posteam, v=1)[["game_id", "team", "v"]])
    tp = p[(p.two_point_conv_result == "success") & (p["last"] == 1)]; parts.append(tp.assign(team=tp.posteam, v=2)[["game_id", "team", "v"]])
    fg = p[p.field_goal_result == "made"]; parts.append(fg.assign(team=fg.posteam, v=3)[["game_id", "team", "v"]])
    opf = pd.concat(parts).groupby(["game_id", "team"]).v.sum().rename("opf").reset_index()
    rows = []
    for r in G[G.season == y].itertuples():
        rows += [dict(game_id=r.game_id, season=y, week=r.week, team=r.home_team, opp=r.away_team, pf=r.home_score, pa=r.away_score, home=1),
                 dict(game_id=r.game_id, season=y, week=r.week, team=r.away_team, opp=r.home_team, pf=r.away_score, pa=r.home_score, home=0)]
    T = pd.DataFrame(rows).merge(plays, on=["game_id", "team"]).merge(opf, on=["game_id", "team"], how="left").fillna({"opf": 0})
    o = T[["game_id", "team", "plays", "opf", "epa"]].rename(columns={"team": "opp", "plays": "opp_plays", "opf": "opa", "epa": "opp_epa"})
    return T.merge(o, on=["game_id", "opp"])


TG = pd.concat([team_games(y) for y in (2024, 2025, 2026)], ignore_index=True)
TEAMS = sorted(TG.team.unique()); IDX = {t: i for i, t in enumerate(TEAMS)}


def history(y, w, wp, hl):
    cur = TG[(TG.season == y) & (TG.week < w)].copy(); cur["wt"] = 1.0 if not hl else 0.5 ** ((w - cur.week) / hl)
    pri = TG[TG.season == y - 1].copy(); pri["wt"] = wp
    return pd.concat([cur, pri[pri.wt > 0]], ignore_index=True)


def formula(H, home, away, k, off_only):
    """The user's formula with shrinkage: k league-average games are added to every rate. k = 0 is the original."""
    f, a = ("opf", "opa") if off_only else ("pf", "pa")
    lg_rate = (H[f] * H.wt).sum() / (H.plays * H.wt).sum(); lg_plays = (H.plays * H.wt).sum() / H.wt.sum()
    extra = 0.0 if not off_only else ((H.pf - H.opf) * H.wt).sum() / H.wt.sum()      # league non-offensive points per team-game
    out = []
    for t, o in ((home, away), (away, home)):
        A = H[H.team == t]; B = H[H.team == o]
        if A.wt.sum() < 2.5 or B.wt.sum() < 2.5:
            return None
        ppg = ((A.plays * A.wt).sum() + k * lg_plays) / (A.wt.sum() + k)
        r1 = ((A[f] * A.wt).sum() + k * lg_rate * lg_plays) / ((A.plays * A.wt).sum() + k * lg_plays)
        r2 = ((B[a] * B.wt).sum() + k * lg_rate * lg_plays) / ((B.opp_plays * B.wt).sum() + k * lg_plays)
        out.append((ppg * r1 + ppg * r2) / 2 + extra)
    return out


def ridge(H, home, away, lam, target):
    """Opponent-adjusted ratings: target = league + home edge + offence[team] + defence[opponent], ridge-shrunk."""
    n = len(TEAMS); X = np.zeros((len(H), 2 * n + 2)); X[:, 0] = 1; X[:, 1] = H.home.to_numpy() - 0.5
    X[np.arange(len(H)), 2 + H.team.map(IDX).to_numpy()] = 1; X[np.arange(len(H)), 2 + n + H.opp.map(IDX).to_numpy()] = 1
    w = H.wt.to_numpy(float); yv = H[target].to_numpy(float) if target != "ppp" else None
    if target == "ppp":
        yv = (H.pf / H.plays).to_numpy(float); w = w * H.plays.to_numpy(float) / H.plays.mean()
    R = np.eye(2 * n + 2) * lam; R[0, 0] = 0; R[1, 1] = 0.01
    b = np.linalg.solve(X.T @ (X * w[:, None]) + R, X.T @ (yv * w))
    pred = lambda t, o, h: b[0] + b[1] * (h - 0.5) + b[2 + IDX[t]] + b[2 + n + IDX[o]]
    hp, ap = pred(home, away, 1), pred(away, home, 0)
    if target == "ppp":   # points per play x expected plays (average of the team's plays and the plays its opponent allows)
        ex = lambda t, o: 0.5 * ((H[H.team == t].plays * H[H.team == t].wt).sum() / max(H[H.team == t].wt.sum(), 1e-9) + (H[H.team == o].opp_plays * H[H.team == o].wt).sum() / max(H[H.team == o].wt.sum(), 1e-9))
        hp, ap = hp * ex(home, away), ap * ex(away, home)
    return [hp, ap]


def run(y, weeks, kind, **kw):
    out = []
    for r in G[(G.season == y) & G.week.isin(weeks)].itertuples():
        H = history(y, r.week, kw.get("wp", 0.0), kw.get("hl"))
        if H[(H.team == r.home_team)].wt.sum() < 2.5 or H[(H.team == r.away_team)].wt.sum() < 2.5:
            continue
        p = formula(H, r.home_team, r.away_team, kw.get("k", 0), kw.get("off_only", False)) if kind == "formula" else ridge(H, r.home_team, r.away_team, kw["lam"], kw.get("target", "pf"))
        if p:
            out.append(dict(game_id=r.game_id, week=r.week, total=p[0] + p[1], margin=p[0] - p[1], line=r.total_line, spread=r.spread_line, act_total=r.act_total, act_margin=r.act_margin))
    return pd.DataFrame(out)


def wilson(w, n, z=1.645):
    if n == 0: return [None, None]
    p = w / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [round((c - h) / d, 3), round((c + h) / d, 3)]


def bets(R, model, line, actual, thr):
    d = R[(R[model] - R[line]).abs() >= thr]; hi = d[model] > d[line]
    win = (hi & (d[actual] > d[line])) | (~hi & (d[actual] < d[line])); push = d[actual] == d[line]; n = int((~push).sum()); w = int(win.sum())
    return {"n": n, "wins": w, "pct": round(w / n, 3) if n else None, "ci90": wilson(w, n), "units": round(w * (100 / 110) - (n - w), 2)}


def score(R):
    if len(R) < 20: return None
    x = (R.total - R.line).to_numpy(); yv = (R.act_total - R.line).to_numpy(); b = float((x * yv).sum() / (x * x).sum()); se = float(np.sqrt(((yv - b * x) ** 2).sum() / (len(x) - 1) / (x * x).sum()))
    xm = (R.margin - R.spread).to_numpy(); ym = (R.act_margin - R.spread).to_numpy(); bm = float((xm * ym).sum() / (xm * xm).sum()); sem = float(np.sqrt(((ym - bm * xm) ** 2).sum() / (len(xm) - 1) / (xm * xm).sum()))
    return {"n": len(R), "total_mae": round(float((R.total - R.act_total).abs().mean()), 2), "line_mae": round(float((R.line - R.act_total).abs().mean()), 2),
            "total_corr": round(float(np.corrcoef(R.total, R.act_total)[0, 1]), 3), "line_corr": round(float(np.corrcoef(R.line, R.act_total)[0, 1]), 3),
            "margin_mae": round(float((R.margin - R.act_margin).abs().mean()), 2), "spread_mae": round(float((R.spread - R.act_margin).abs().mean()), 2),
            "info_beyond_total": {"slope": round(b, 3), "se": round(se, 3), "t": round(b / se, 2)}, "info_beyond_spread": {"slope": round(bm, 3), "se": round(sem, 3), "t": round(bm / sem, 2)},
            "ou": {str(t): bets(R, "total", "line", "act_total", t) for t in (2, 3, 4)}, "ats": {str(t): bets(R, "margin", "spread", "act_margin", t) for t in (2, 3, 4)}}


DEV, TEST = (2025, range(3, 19)), (2026, range(3, 19))
grid = [("formula", dict(k=k, wp=wp, off_only=oo, hl=hl)) for k in (0, 2, 4, 8) for wp in (0.0, 0.3, 0.5) for oo in (False, True) for hl in (None, 6)]
grid += [("ridge", dict(lam=lam, wp=wp, target=tg, hl=hl)) for lam in (2, 5, 10, 20, 40) for wp in (0.0, 0.3, 0.5) for tg in ("pf", "opf", "ppp") for hl in (None, 6)]
res = {"tried": len(grid), "dev": "2025 weeks 3-18 (ratings start from 2024)", "test": "2026 weeks 3-10 (ratings start from 2025), scored once with settings frozen", "models": []}
rows = []
for kind, kw in grid:
    d = run(DEV[0], DEV[1], kind, **kw); s = score(d)
    if s: rows.append((s["total_mae"] + s["margin_mae"], kind, kw, s))
rows.sort(key=lambda x: x[0])
named = {"original formula": ("formula", dict(k=0, wp=0.0, off_only=False, hl=None))}
best_f = next(r for r in rows if r[1] == "formula"); best_r = next(r for r in rows if r[1] == "ridge")
named["best formula variant on 2025"] = (best_f[1], best_f[2]); named["best opponent-adjusted model on 2025"] = (best_r[1], best_r[2])
for name, (kind, kw) in named.items():
    d = run(DEV[0], DEV[1], kind, **kw); t = run(TEST[0], TEST[1], kind, **kw)
    res["models"].append({"name": name, "kind": kind, "settings": kw, "dev_2025": score(d), "test_2026": score(t)})
    s, u = score(d), score(t)
    print(f"\n{name}  {kind} {kw}")
    for lab, x in (("2025", s), ("2026", u)):
        print(f"  {lab}: n={x['n']} total miss {x['total_mae']} (line {x['line_mae']}) corr {x['total_corr']} (line {x['line_corr']}) | margin miss {x['margin_mae']} (spread {x['spread_mae']})"
              f" | info beyond total: slope {x['info_beyond_total']['slope']} t={x['info_beyond_total']['t']} | beyond spread: slope {x['info_beyond_spread']['slope']} t={x['info_beyond_spread']['t']}")
        print("     O/U when 2+/3+/4+ from the line:", " ".join(f"{v['wins']}-{v['n'] - v['wins']} ({v['pct']})" for v in x["ou"].values()), "| ATS:", " ".join(f"{v['wins']}-{v['n'] - v['wins']} ({v['pct']})" for v in x["ats"].values()))
# how many of ALL the variants tried would have looked profitable on 2025, and how those do on 2026
look = [(kind, kw) for _, kind, kw, s in rows if (s["ou"]["3"]["pct"] or 0) >= 0.55 and s["ou"]["3"]["n"] >= 30]
t26 = [score(run(TEST[0], TEST[1], kind, **kw))["ou"]["3"] for kind, kw in look]
res["selection_check"] = {"variants_tried": len(rows), "looked_profitable_on_2025_ou3": len(look), "their_2026_record": [sum(x["wins"] for x in t26), sum(x["n"] - x["wins"] for x in t26)]}
print("\nvariants tried:", len(rows), "| O/U 55%+ on 2025 (3+ pts, 30+ bets):", len(look), "| those same variants on 2026:", res["selection_check"]["their_2026_record"])

# ---------------------------------------------------------------- situational angles (market only)
A = G[(G.season >= 2015) & G.total_line.notna() & G.spread_line.notna()].copy()
A["hour"] = A.gametime.str.slice(0, 2).astype(float); A["prime"] = (A.weekday.isin(["Thursday", "Monday"])) | ((A.weekday == "Sunday") & (A.hour >= 20))
A["outdoor"] = A.roof.isin(["outdoors", "open"]); A["dog_home"] = A.spread_line < 0     # spread_line > 0: home favoured
def rec(mask, side, kind):
    d = A[mask]
    if kind == "total": win = (d.act_total > d.total_line) if side == "over" else (d.act_total < d.total_line); push = d.act_total == d.total_line
    else: cov = d.act_margin - d.spread_line; win = (cov > 0) if side == "home" else (cov < 0); push = cov == 0
    out = {}
    for lab, m in (("2015-2023", d.season <= 2023), ("2024-2026", d.season >= 2024)):
        n = int((m & ~push).sum()); w = int((m & win).sum()); out[lab] = {"n": n, "wins": w, "pct": round(w / n, 3) if n else None, "ci90": wilson(w, n), "units": round(w * (100 / 110) - (n - w), 2)}
    return out
ANG = {"wind 15+ mph outdoors: under": (A.outdoor & (A.wind >= 15), "under", "total"), "cold 32F or less outdoors: under": (A.outdoor & (A.temp <= 32), "under", "total"),
       "prime time: under": (A.prime, "under", "total"), "division game: under": (A.div_game == 1, "under", "total"),
       "total 50 or higher: under": (A.total_line >= 50, "under", "total"), "total 38 or lower: over": (A.total_line <= 38, "over", "total"),
       "home underdog": (A.dog_home, "home", "spread"), "road underdog": (A.spread_line > 0, "away", "spread"),
       "underdog of 10+": ((A.spread_line.abs() >= 10), None, "spread"), "home team off a bye (13+ days rest)": (A.home_rest >= 13, "home", "spread"),
       "road team off a bye": (A.away_rest >= 13, "away", "spread"), "road team on short rest (under 6 days)": (A.away_rest < 6, "away", "spread"),
       "division underdog": ((A.div_game == 1), None, "spread")}
res["angles"] = {}
print("\nangle                                      2015-2023              2024-2026")
for name, (mask, side, kind) in ANG.items():
    if side is None:   # the underdog, whichever side it is
        a = rec(mask & (A.spread_line > 0), "away", kind); b = rec(mask & (A.spread_line < 0), "home", kind)
        r = {k: {"n": a[k]["n"] + b[k]["n"], "wins": a[k]["wins"] + b[k]["wins"]} for k in a}
        for k in r: r[k].update(pct=round(r[k]["wins"] / r[k]["n"], 3) if r[k]["n"] else None, ci90=wilson(r[k]["wins"], r[k]["n"]), units=round(r[k]["wins"] * (100 / 110) - (r[k]["n"] - r[k]["wins"]), 2))
    else:
        r = rec(mask, side, kind)
    res["angles"][name] = r
    f = lambda x: f"{x['wins']}-{x['n'] - x['wins']} {x['pct']} [{x['ci90'][0]}, {x['ci90'][1]}]" if x["n"] else "no games"
    print(f"{name:42s} {f(r['2015-2023']):26s} {f(r['2024-2026'])}")
json.dump(res, open(ROOT / "research" / "lines_edge_results.json", "w"), indent=1, default=float)
