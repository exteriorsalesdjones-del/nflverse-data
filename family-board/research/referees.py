"""Referee crews: do they change penalties, and through penalties the running or passing game?

Data: nflverse play-by-play 2024 and 2025 (all regular-season games, referee from the schedule file), plus the
2026 games whose referee is published (weeks 1-4 and a few later). Accepted penalties only (pbp `penalty == 1`).
Crew = head referee (crews keep the same referee all season; other members can change).

Algorithms
- Penalty categories: offensive holding; pass-coverage flags on the defense (DPI, defensive holding, illegal
  contact, roughing the passer); pre-snap/procedural; personal fouls; everything else. Each flag is tagged run
  or pass play from the play description.
- Crew index (empirical Bayes): crew rate per game shrunk toward the league mean,
  shrunk = (n*crew_mean + k*league_mean)/(n + k), k = within-crew variance / between-crew variance (method of moments).
- Is the crew effect real? Permutation test: shuffle referees across games within a season (2,000 times) and
  compare the between-crew variance of game means with the shuffled ones.
- Does it persist? Correlate each crew's 2024 rate with its 2025 rate.
- Run vs pass: same tests on game outcomes measured against the closing total (rush yards, pass yards incl. DPI
  yards, EPA per rush and per dropback, rushing and passing TDs, pass rate), and whether the crew's PRIOR-season
  index predicts next-season outcomes.
- Pick test: add pregame crew indices (from games before the target week only) to the v0.3c Anytime TD model,
  separately for runners (RB/QB, crew run-game index) and pass catchers (WR/TE, crew pass-coverage index).
"""
from __future__ import annotations

import json, sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
C = ROOT / ".data" / "cache"
COVER = {"Defensive Pass Interference", "Defensive Holding", "Illegal Contact", "Roughing the Passer"}
PRESNAP = {"False Start", "Delay of Game", "Defensive Offside", "Neutral Zone Infraction", "Illegal Formation", "Encroachment",
           "Illegal Shift", "Illegal Motion", "Defensive Delay of Game", "Offside on Free Kick"}
PERSONAL = {"Unnecessary Roughness", "Face Mask", "Horse Collar Tackle", "Unsportsmanlike Conduct", "Taunting", "Lowering the Head to Initiate Contact"}
rng = np.random.default_rng(3)


def season_games(y, max_week=None):
    p = pd.read_parquet(C / f"play_by_play_{y}.parquet")
    p = p[p.season_type == "REG"]
    if max_week:
        p = p[p.week <= max_week]
    g = pd.read_csv(C / "games.csv")
    g = g[(g.season == y) & (g.game_type == "REG") & g.result.notna() & g.referee.notna()][["game_id", "week", "referee", "total_line", "home_score", "away_score"]]
    pen = p[p.penalty == 1].copy()
    txt = pen.desc.fillna("").str.lower()
    pen["is_pass"] = (pen.qb_dropback == 1) | txt.str.contains(" pass ") | txt.str.contains("pass incomplete") | txt.str.contains("sacked")
    pen["is_run"] = ~pen.is_pass & pen.play_type.isin(["run", "no_play"]) & ~pen.penalty_type.isin(PRESNAP)
    pen["cat"] = np.select([pen.penalty_type == "Offensive Holding", pen.penalty_type.isin(COVER), pen.penalty_type.isin(PRESNAP), pen.penalty_type.isin(PERSONAL)],
                           ["off_holding", "pass_coverage", "presnap", "personal"], "other")
    G = pen.groupby("game_id").agg(flags=("play_id", "size"), flag_yds=("penalty_yards", "sum"),
                                   run_play_flags=("is_run", "sum"), pass_play_flags=("is_pass", "sum"))
    G = G.join(pen.pivot_table(index="game_id", columns="cat", values="play_id", aggfunc="size", fill_value=0))
    G["dpi_yds"] = pen[pen.penalty_type == "Defensive Pass Interference"].groupby("game_id").penalty_yards.sum()
    q = p[p.play_type.isin(["run", "pass"]) & (p.two_point_attempt != 1)]
    r = q[(q.play_type == "run") & (q.qb_scramble != 1)]; d = q[q.qb_dropback == 1]
    O = pd.DataFrame({"rush_att": r.groupby("game_id").size(), "rush_yds": r.groupby("game_id").yards_gained.sum(),
                      "epa_rush": r.groupby("game_id").epa.mean(), "rush_td": p.groupby("game_id").rush_touchdown.sum(),
                      "dropbacks": d.groupby("game_id").size(), "pass_yds": d.groupby("game_id").yards_gained.sum(),
                      "epa_db": d.groupby("game_id").epa.mean(), "pass_td": p.groupby("game_id").pass_touchdown.sum()})
    O["pass_rate"] = O.dropbacks / (O.dropbacks + O.rush_att)
    out = g.merge(G.reset_index(), on="game_id", how="left").merge(O.reset_index(), on="game_id", how="left").fillna({"dpi_yds": 0})
    for c in ["off_holding", "pass_coverage", "presnap", "personal", "other"]:
        out[c] = out.get(c, 0)
        out[c] = out[c].fillna(0)
    out["pass_yds_incl_dpi"] = out.pass_yds + out.dpi_yds
    out["points_vs_total"] = out.home_score + out.away_score - out.total_line
    out["season"] = y
    return out


PEN = ["flags", "flag_yds", "off_holding", "pass_coverage", "presnap", "personal", "run_play_flags", "pass_play_flags", "dpi_yds"]
OUTC = ["rush_yds", "rush_att", "epa_rush", "rush_td", "pass_yds_incl_dpi", "dropbacks", "epa_db", "pass_td", "pass_rate", "points_vs_total"]


def resid_on_total(df, col):
    """Outcome measured against the closing total (removes the matchup the market already priced)."""
    x = df.total_line.to_numpy(float); y = df[col].to_numpy(float); m = ~np.isnan(y)
    b = np.polyfit(x[m], y[m], 1)
    return y - np.polyval(b, x)


def crew_test(df, col, n_perm=2000):
    """Between-crew variance of game means vs. shuffled referees (within season). Returns share of variance and p-value."""
    v = df[col].to_numpy(float); ref = df.referee.to_numpy(); seas = df.season.to_numpy()
    def stat(labels):
        s = pd.Series(v).groupby([seas, labels]).agg(["mean", "size"])
        return float(np.average((s["mean"] - np.nanmean(v)) ** 2, weights=s["size"]))
    obs = stat(ref)
    perm = []
    for _ in range(n_perm):
        lab = ref.copy()
        for y in np.unique(seas):
            m = seas == y; lab[m] = rng.permutation(lab[m])
        perm.append(stat(lab))
    perm = np.array(perm)
    share = max(0.0, (obs - perm.mean()) / np.nanvar(v))  # variance attributable to crews beyond chance
    return {"p_value": float((perm >= obs).mean()), "crew_share_of_variance": round(share, 4)}


def shrink_table(df, col):
    """Empirical-Bayes crew index for one metric."""
    s = df.groupby("referee")[col].agg(["mean", "size", "var"])
    lg = df[col].mean(); within = np.nanmean(s["var"]); between = max(np.nanvar(s["mean"]) - within / s["size"].mean(), 1e-9)
    k = within / between
    return ((s["mean"] * s["size"] + k * lg) / (s["size"] + k)).rename(col), float(k)


def main():
    seasons = {y: season_games(y) for y in (2024, 2025)}
    seasons[2026] = season_games(2026, max_week=9)
    A = pd.concat([seasons[2024], seasons[2025]], ignore_index=True)
    for c in OUTC:
        A[c + "_r"] = resid_on_total(A, c)
    res = {"games": {str(y): int(len(seasons[y])) for y in seasons}, "crews": int(A.referee.nunique()),
           "league_per_game": {c: round(float(A[c].mean()), 2) for c in PEN}}
    # 1) do crews differ? (penalties)
    res["penalty_crew_effect"] = {c: crew_test(A, c) for c in PEN}
    # 2) persistence 2024 -> 2025
    b24 = seasons[2024].groupby("referee")[PEN].mean(); b25 = seasons[2025].groupby("referee")[PEN].mean()
    both = b24.index.intersection(b25.index)
    res["persistence_2024_to_2025"] = {"crews_in_both": int(len(both)), **{c: round(float(np.corrcoef(b24.loc[both, c], b25.loc[both, c])[0, 1]), 3) for c in PEN}}
    # 3) run vs pass outcomes (vs closing total)
    res["outcome_crew_effect"] = {c: crew_test(A, c + "_r") for c in OUTC}
    # 4) do penalty tendencies move rushing/passing? prior-season crew index -> next-season outcome residuals
    idx24 = pd.concat([shrink_table(seasons[2024], c)[0] for c in ["flags", "off_holding", "pass_coverage", "run_play_flags", "pass_play_flags"]], axis=1)
    g25 = seasons[2025].copy()
    for c in OUTC:
        g25[c + "_r"] = resid_on_total(g25, c)
    g25 = g25.join(idx24.add_prefix("crew24_"), on="referee")
    pred = {}
    for ix in ["crew24_flags", "crew24_off_holding", "crew24_pass_coverage", "crew24_run_play_flags", "crew24_pass_play_flags"]:
        m = g25[ix].notna(); pred[ix] = {}
        for c in OUTC:
            x = g25.loc[m, ix].to_numpy(float); y = g25.loc[m, c + "_r"].to_numpy(float)
            bs = [np.corrcoef(x[s], y[s])[0, 1] for s in (rng.choice(len(x), len(x)) for _ in range(1000))]
            pred[ix][c] = {"r": round(float(np.corrcoef(x, y)[0, 1]), 3), "ci90": [round(float(np.percentile(bs, 5)), 3), round(float(np.percentile(bs, 95)), 3)]}
        pred[ix]["n_games"] = int(m.sum())
    res["prior_season_index_predicts_2025"] = pred
    # same-season association (explanatory): game flags of each type vs that game's run/pass residuals
    res["same_game_association"] = {pc: {c: round(float(np.corrcoef(A[pc], A[c + "_r"])[0, 1]), 3) for c in ["rush_yds", "epa_rush", "rush_td", "pass_yds_incl_dpi", "epa_db", "pass_td", "pass_rate"]}
                                    for pc in ["off_holding", "pass_coverage", "run_play_flags", "pass_play_flags", "flags"]}
    # crew table for the app (2024 + 2025 + 2026 known, current season weighted 1, earlier 0.5)
    W = pd.concat([seasons[2024].assign(w=0.25), seasons[2025].assign(w=0.5), seasons[2026].assign(w=1.0)])
    tab = {}
    lg = {c: float(np.average(W[c], weights=W.w)) for c in ["flags", "off_holding", "pass_coverage", "run_play_flags", "pass_play_flags"]}
    for ref, x in W.groupby("referee"):
        n = float(x.w.sum()); k = 6.0
        tab[ref] = {"games": int(len(x)), "weighted_games": round(n, 2), "last_season": int(x.season.max()),
                    **{c: round((float((x[c] * x.w).sum()) + k * lg[c]) / (n + k), 2) for c in lg}}
    res["league_index"] = {c: round(v, 2) for c, v in lg.items()}
    (ROOT / "refresh" / "referee_index.json").write_text(json.dumps({"built_from": "nflverse pbp 2024-2026 (accepted penalties), referee from schedules", "shrink_games": 6,
                                                                      "league": res["league_index"], "crews": tab}, indent=1))
    A.to_parquet(C / "referee_games.parquet")
    pd.concat([seasons[2025], seasons[2026]]).to_parquet(C / "referee_games_2526.parquet")
    (ROOT / "research" / "referees_results.json").write_text(json.dumps(res, indent=1, default=float))
    print(json.dumps({k: res[k] for k in ("games", "crews", "league_per_game", "persistence_2024_to_2025")}, indent=1))
    print("PENALTY crew effect", {k: (v["p_value"], v["crew_share_of_variance"]) for k, v in res["penalty_crew_effect"].items()})
    print("OUTCOME crew effect", {k: (v["p_value"], v["crew_share_of_variance"]) for k, v in res["outcome_crew_effect"].items()})
    for ix, v in pred.items():
        print(ix, {c: v[c]["r"] for c in OUTC}, "n", v["n_games"])
    print("same game", json.dumps(res["same_game_association"]))


if __name__ == "__main__":
    main()
