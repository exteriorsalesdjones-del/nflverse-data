"""Point-in-time game table for 2025 and 2026 Weeks 1-10 (research/season_analysis.py reads it).

For a game in week w of season s, every feature uses only:
  - the closing spread, total and moneylines and the schedule (rest days, venue, kickoff slot, division);
  - results and play-by-play of season-s games in weeks before w, plus season s-1 at quarter weight;
  - the week-w injury report and weekly roster status (both published before kickoff).
Outcome columns (scores, ATS margin, total vs line) are attached for grading only and never feed a feature.
Game-day temperature and wind are recorded conditions, used as a stand-in for a late forecast (labelled as such).
"""
from __future__ import annotations

import math
from pathlib import Path
import sys

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
from weather import STADIUMS  # noqa: E402

C = ROOT / ".data" / "cache"
HFA, PRIOR_W, SHRINK = 1.5, 0.25, 4.0
SEASONS = (2025, 2026)


def slot(r):
    h = int(str(r.gametime)[:2])
    if r.weekday == "Thursday":
        return "TNF"
    if r.weekday == "Monday":
        return "MNF"
    if r.weekday == "Sunday" and h >= 19:
        return "SNF"
    if r.weekday == "Sunday" and h < 12:
        return "Intl (Sun morning)"
    if r.weekday == "Sunday":
        return "Sunday day"
    return "Other (Fri/Sat/Wed)"


def km(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p1, p2 = math.radians(la1), math.radians(la2); dp = p2 - p1; dl = math.radians(lo2 - lo1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def team_games(g):
    """One row per team per played game: points for/against, margin, and margin/total vs the closing line."""
    p = g.dropna(subset=["home_score"])
    h = pd.DataFrame({"season": p.season, "week": p.week, "game_id": p.game_id, "team": p.home_team, "pf": p.home_score, "pa": p.away_score,
                      "imp_margin": p.spread_line, "total_line": p.total_line})
    a = pd.DataFrame({"season": p.season, "week": p.week, "game_id": p.game_id, "team": p.away_team, "pf": p.away_score, "pa": p.home_score,
                      "imp_margin": -p.spread_line, "total_line": p.total_line})
    t = pd.concat([h, a], ignore_index=True)
    t["margin"] = t.pf - t.pa; t["ats"] = t.margin - t.imp_margin; t["ou"] = t.pf + t.pa - t.total_line
    return t


def rating(t, col, season, week, center=0.0):
    """Shrunk weighted average of `col`: season games before `week` at weight 1, the previous season at PRIOR_W."""
    d = t[((t.season == season) & (t.week < week)) | (t.season == season - 1)]
    w = np.where(d.season == season, 1.0, PRIOR_W)
    d = d.assign(w=w, wv=(d[col] - center) * w)
    s = d.groupby("team").agg(wv=("wv", "sum"), w=("w", "sum"))
    return (s.wv / (s.w + SHRINK)) + center


def last_n(t, col, season, week, n=3):
    d = t[(t.season == season) & (t.week < week)].sort_values("week")
    return d.groupby("team")[col].apply(lambda s: s.tail(n).mean() if len(s) else np.nan)


def epa_team_games():
    rows = []
    for s in (2024, 2025, 2026):
        p = pd.read_parquet(C / f"play_by_play_{s}.parquet", columns=["game_id", "week", "posteam", "defteam", "play_type", "epa", "season_type"])
        p = p[(p.season_type == "REG") & p.play_type.isin(["pass", "run"]) & p.epa.notna()]
        o = p.groupby(["game_id", "posteam"]).epa.sum().rename("off").rename_axis(["game_id", "team"])
        d = p.groupby(["game_id", "defteam"]).epa.sum().rename("deff").rename_axis(["game_id", "team"])
        x = pd.concat([o, d], axis=1).reset_index(); x["season"] = s
        x["week"] = x.game_id.str.split("_").str[1].astype(int); x["net_epa"] = x.off - x.deff
        rows.append(x)
    return pd.concat(rows, ignore_index=True)


def usage(season):
    """Per team-game carry and target counts by player (for 'key player out' features)."""
    p = pd.read_parquet(C / f"play_by_play_{season}.parquet", columns=["game_id", "week", "posteam", "rusher_player_id", "receiver_player_id",
                                                                       "passer_player_id", "play_type", "season_type", "pass_attempt"])
    p = p[p.season_type == "REG"]
    car = p[p.play_type == "run"].groupby(["week", "posteam", "rusher_player_id"]).size().rename("n").reset_index().rename(columns={"rusher_player_id": "pid"})
    tgt = p[p.receiver_player_id.notna()].groupby(["week", "posteam", "receiver_player_id"]).size().rename("n").reset_index().rename(columns={"receiver_player_id": "pid"})
    att = p[p.pass_attempt == 1].groupby(["week", "posteam", "passer_player_id"]).size().rename("n").reset_index().rename(columns={"passer_player_id": "pid"})
    return car, tgt, att


def outs(season, week, team, car, tgt, att, rep, ros):
    """Key players unavailable for week `week` per the pre-game report or weekly roster: (QB1 out, # of 15%+ share skill players out)."""
    status_out = set(rep[(rep.week == week) & (rep.team == team) & rep.report_status.isin(["Out", "Doubtful"])].gsis_id)
    r = ros[(ros.week == week) & (ros.team == team)]
    inactive = set(r[~r.status.isin(["ACT"])].gsis_id); on_roster = set(r.gsis_id)
    gone = lambda pid: pid in status_out or pid in inactive or (len(on_roster) > 0 and pid not in on_roster)
    if week == 1:
        return np.nan, np.nan
    a = att[(att.week < week) & (att.posteam == team)].groupby("pid").n.sum()
    qb_out = float(gone(a.idxmax())) if len(a) else np.nan
    key = 0
    for df in (car, tgt):
        x = df[(df.week < week) & (df.posteam == team)]
        sh = x.groupby("pid").n.sum() / max(x.n.sum(), 1)
        key += sum(gone(pid) for pid in sh[sh >= 0.15].index)
    return qb_out, float(key)


def build():
    g = pd.read_csv(C / "games.csv")
    g = g[(g.game_type == "REG") & g.season.isin([2024, 2025, 2026])].copy()
    t = team_games(g)
    e = epa_team_games()
    # home stadium per team-season (most common home venue, excluding neutral sites)
    homes = g[g.location == "Home"].groupby(["season", "home_team"]).stadium_id.agg(lambda s: s.mode().iloc[0])
    out = []
    for s in SEASONS:
        rep = pd.read_parquet(C / f"injuries_{s}.parquet"); ros = pd.read_parquet(C / f"roster_weekly_{s}.parquet")
        car, tgt, att = usage(s)
        for w in range(1, 11):
            wk = g[(g.season == s) & (g.week == w)]
            if wk.empty:
                continue
            mr = rating(t, "margin", s, w); er = rating(e, "net_epa", s, w)
            pts = rating(t.assign(tot=t.pf + t.pa), "tot", s, w, center=t[t.season == s - 1].pipe(lambda d: (d.pf + d.pa).mean()))
            atsf = last_n(t, "ats", s, w); ouf = last_n(t, "ou", s, w)
            for r in wk.itertuples():
                H, A = r.home_team, r.away_team
                st = STADIUMS.get(r.stadium_id)
                def trav(team):
                    hs = STADIUMS.get(homes.get((s, team)))
                    return km(hs[:2], st[:2]) if hs and st else np.nan
                th, ta = trav(H), trav(A)
                qh, kh = outs(s, w, H, car, tgt, att, rep, ros); qa, ka = outs(s, w, A, car, tgt, att, rep, ros)
                lon_a = STADIUMS.get(homes.get((s, A)), (0, 0))[1]
                body_clock = int(lon_a < -110 and st is not None and st[1] > -90 and int(str(r.gametime)[:2]) < 14)
                home_imp = r.total_line / 2 + r.spread_line / 2
                d = dict(season=s, week=w, game_id=r.game_id, away=A, home=H, weekday=r.weekday, gametime=r.gametime, slot=slot(r),
                         spread=r.spread_line, total_line=r.total_line, home_imp=home_imp, away_imp=r.total_line - home_imp,
                         div=int(r.div_game), indoor=int(str(r.roof) in ("dome", "closed")), neutral=int(r.location == "Neutral"),
                         wind=r.wind, temp=r.temp,
                         edge_margin=float(mr.get(H, 0) - mr.get(A, 0) + HFA - r.spread_line),
                         edge_epa=float(er.get(H, 0) - er.get(A, 0) + HFA - r.spread_line),
                         rest_diff=(r.home_rest - r.away_rest) if pd.notna(r.home_rest) and pd.notna(r.away_rest) else np.nan,
                         travel_diff=(ta - th) if pd.notna(ta) and pd.notna(th) else np.nan, away_travel=ta,
                         body_clock=body_clock,
                         qb_out_diff=(qa - qh) if pd.notna(qa) and pd.notna(qh) else np.nan, qb_out_home=qh, qb_out_away=qa,
                         key_out_diff=(ka - kh) if pd.notna(ka) and pd.notna(kh) else np.nan,
                         ats_form_diff=float(atsf.get(H, np.nan) - atsf.get(A, np.nan)),
                         ou_form=float(np.nanmean([ouf.get(H, np.nan), ouf.get(A, np.nan)])) if w > 1 else np.nan,
                         edge_pts_total=float(pts.get(H, np.nan) + pts.get(A, np.nan)) / 2 - r.total_line,
                         home_score=r.home_score, away_score=r.away_score)
                out.append(d)
    df = pd.DataFrame(out)
    df["played"] = df.home_score.notna()
    df["result"] = df.home_score - df.away_score
    df["ats_home"] = df.result - df.spread                       # > 0 home covered, 0 push
    df["ou_diff"] = df.home_score + df.away_score - df.total_line  # > 0 over
    df["fav_home"] = df.spread > 0
    return df


if __name__ == "__main__":
    df = build()
    df.to_parquet(C / "season_games.parquet")
    print(df.groupby(["season", "week"]).size().unstack(0).T)
    print(df[["edge_margin", "edge_epa", "rest_diff", "travel_diff", "qb_out_diff", "key_out_diff", "ats_form_diff", "ou_form", "edge_pts_total"]].describe().T[["count", "mean", "std"]])
