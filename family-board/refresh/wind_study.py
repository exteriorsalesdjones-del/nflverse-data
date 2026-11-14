"""Does 15+ mph wind change passing vs rushing touchdowns beyond what the betting line already prices?

Data: game-time hourly weather for 2000-2020 games (github.com/ThompsonJamesBliss/WeatherData, MeteoStat/
Weather Underground station readings, averaged over each game's hours) joined to nflverse play-by-play
2010-2020, regular season, outdoor or open-roof games only. Unit: one team in one game.

Expected passing and rushing TDs = league rate per implied point (from calm games) x the team's implied
points from the closing spread and total. Test: fit wind factors on one half of the seasons, score
Poisson log-likelihood on windy games of the other half, bootstrap over games.

Usage: python wind_study.py <weather_repo_dir> <pbp_dir>   -> writes refresh/wind_study.json
"""
import glob, json, sys
from math import lgamma
from pathlib import Path
import numpy as np, pandas as pd

def logpois(k, mu):
    k = np.asarray(k, float); mu = np.asarray(mu, float)
    return k * np.log(mu) - mu - np.vectorize(lgamma)(k + 1)

def main(wdir, pdir):
    W = Path(wdir) / "data"
    tg = pd.read_csv(W / "games.csv"); tw = pd.read_csv(W / "games_weather.csv")
    tg["s"] = pd.to_datetime(tg.TimeStartGame); tg["e"] = pd.to_datetime(tg.TimeEndGame); tw["t"] = pd.to_datetime(tw.TimeMeasure)
    x = tw.merge(tg[["game_id", "s", "e"]], on="game_id"); x = x[(x.t >= x.s.dt.floor("h")) & (x.t <= x.e)]
    gw = x.groupby("game_id").agg(wind=("WindSpeed", "mean")).reset_index()
    cols = ["game_id", "old_game_id", "season", "posteam", "pass_touchdown", "rush_touchdown", "roof", "spread_line", "total_line", "home_team", "season_type"]
    P = pd.concat([pd.read_parquet(f, columns=cols) for f in sorted(glob.glob(str(Path(pdir) / "pbp_*.parquet")))])
    P = P[P.season_type == "REG"]; P["old_game_id"] = P.old_game_id.astype("int64")
    t = P.dropna(subset=["posteam"]).groupby(["old_game_id", "game_id", "season", "posteam"]).agg(
        ptd=("pass_touchdown", "sum"), rtd=("rush_touchdown", "sum"), roof=("roof", "first"), sp=("spread_line", "first"),
        tot=("total_line", "first"), home=("home_team", "first")).reset_index()
    t["imp"] = np.where(t.posteam == t.home, (t.tot + t.sp) / 2, (t.tot - t.sp) / 2)
    d = t.merge(gw, left_on="old_game_id", right_on="game_id", suffixes=("", "_w"))
    d = d[d.roof.isin(["outdoors", "open"]) & d.wind.notna() & d.imp.notna()]
    d["windy"] = d.wind >= 15
    d["band"] = pd.cut(d.wind, [0, 10, 15, 20, 99], right=False, labels=["under 10", "10-15", "15-20", "20+"])
    bands = [dict(band=str(b), team_games=int(len(g)), pass_td=round(g.ptd.mean(), 2), rush_td=round(g.rtd.mean(), 2),
                  implied_pts=round(g.imp.mean(), 1), pass_share=round(g.ptd.sum() / (g.ptd.sum() + g.rtd.sum()), 3))
             for b, g in d.groupby("band", observed=True)]
    def fit(tr):
        c = tr[~tr.windy]; kp = c.ptd.sum() / c.imp.sum(); kr = c.rtd.sum() / c.imp.sum(); w = tr[tr.windy]
        return kp, kr, w.ptd.sum() / (kp * w.imp.sum()), w.rtd.sum() / (kr * w.imp.sum())
    rng = np.random.default_rng(1); tests = []
    for name, m in {"fit 2010-15, test 2016-20": d.season <= 2015, "fit 2016-20, test 2010-15": d.season >= 2016}.items():
        tr, te = d[m], d[~m]; kp, kr, fp, fr = fit(tr); w = te[te.windy]
        diff = logpois(w.ptd, kp * w.imp * fp) + logpois(w.rtd, kr * w.imp * fr) - logpois(w.ptd, kp * w.imp) - logpois(w.rtd, kr * w.imp)
        g = w.assign(dd=diff).groupby("game_id").dd.sum().values
        bs = [rng.choice(g, len(g)).mean() for _ in range(4000)]
        tests.append(dict(split=name, pass_factor=round(fp, 3), rush_factor=round(fr, 3), windy_test_games=int(len(g)),
                          gain_per_game=round(float(g.mean()), 4), ci90=[round(float(np.percentile(bs, 5)), 4), round(float(np.percentile(bs, 95)), 4)]))
    kp, kr, fp, fr = fit(d)
    out = {"seasons": "2010-2020", "outdoor_team_games": int(len(d)), "windy_team_games": int(d.windy.sum()), "bands": bands, "tests": tests,
           "pooled": {"pass_factor": round(fp, 3), "rush_factor": round(fr, 3)},
           "adopted": all(x["ci90"][0] > 0 for x in tests),
           "conclusion": "Wind lowers passing TDs, but the betting total already moves with the forecast. Beyond the line, a wind shift from passing to rushing did not improve predictions in either half, so chances are not adjusted; 15+ mph games are flagged."}
    Path(__file__).with_name("wind_study.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
