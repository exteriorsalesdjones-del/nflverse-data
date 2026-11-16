"""Pregame feature table for the Weeks 1-9 2026 backtest (and 2025 training rows).

Every feature for a game in (season, week) is built only from games played before that week,
plus information published before kickoff (closing spread/total, Friday injury report, weekly
roster status, the last depth-chart snapshot before kickoff). 2025 is the prior season for 2026:
2025 games count at PRIOR_WEIGHT relative to 2026 games. 2025 rows themselves use 2025-only
history (no 2024 data loaded), so they are training rows from week 3 on.

Outcomes (same game, never used as features): anytime TD (any TD credited to the player, which for a
QB excludes TD passes because the receiver is credited), goal-line TD (play started inside the 10),
long TD (20+ yards), rushing yards, receptions, receiving yards, passing yards.
"""
from __future__ import annotations

from pathlib import Path

import os
import numpy as np
import pandas as pd

C = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))
PRIOR_WEIGHT = 0.5
SKILL = ["QB", "RB", "WR", "TE"]


def load_season(y: int, max_week_2026: int = 9):
    p = pd.read_parquet(C / f"play_by_play_{y}.parquet")
    p = p[p.season_type == "REG"]
    if y == 2026:
        p = p[p.week <= max_week_2026]
    s = pd.read_parquet(C / f"snap_counts_{y}.parquet")
    s = s[(s.game_type == "REG") & s.week.isin(p.week.unique())]
    inj = pd.read_parquet(C / f"injuries_{y}.parquet")
    ros = pd.read_parquet(C / f"roster_weekly_{y}.parquet")
    ftn = pd.read_parquet(C / f"ftn_charting_{y}.parquet")
    dc = pd.read_parquet(C / f"depth_charts_{y}.parquet")
    return p, s, inj, ros, ftn, dc


def player_games(y, p, s, players, ftn):
    """One row per (game, team, player) for skill players with an offensive snap, with same-game stats."""
    pmap = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id").gsis_id
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").position
    s = s.assign(pid=s.pfr_player_id.map(pmap))
    s = s[s.pid.notna() & (s.offense_snaps.fillna(0) > 0)]
    s = s.assign(pos=s.pid.map(pos).fillna(s.position))
    s = s[s.pos.isin(SKILL)]
    tmax = s.groupby(["game_id", "team"]).offense_snaps.transform("max")
    base = s[["game_id", "season", "week", "team", "opponent", "pid", "pos", "offense_snaps"]].assign(team_snaps=tmax)

    q = p[p.play_type.isin(["run", "pass"]) & (p.two_point_attempt != 1)].copy()
    sneak = ftn[ftn.is_qb_sneak == True][["nflverse_game_id", "nflverse_play_id"]].assign(sneak=1)
    q = q.merge(sneak, left_on=["game_id", "play_id"], right_on=["nflverse_game_id", "nflverse_play_id"], how="left")
    q["sneak"] = q.sneak.fillna(0)
    rush = q[q.rusher_player_id.notna() & ((q.play_type == "run") | (q.qb_scramble == 1))].copy()
    rush["i5"] = (rush.yardline_100 <= 5).astype(int); rush["i12"] = (rush.yardline_100 <= 2).astype(int)
    rush["i35"] = rush.yardline_100.between(3, 5).astype(int); rush["gtg"] = (rush.goal_to_go == 1).astype(int)
    rush["designed"] = ((rush.qb_scramble != 1)).astype(int)
    rush["expl"] = (rush.rushing_yards >= 20).astype(int)
    tgt = q[q.receiver_player_id.notna()].copy()
    tgt["ez"] = (tgt.air_yards >= tgt.yardline_100).astype(int)
    tgt["rz"] = (tgt.yardline_100 <= 20).astype(int)
    tgt["expl"] = (tgt.receiving_yards.fillna(0) >= 20).astype(int)
    tgt["cp"] = tgt.cp
    R = rush.groupby(["game_id", "rusher_player_id"]).agg(carries=("play_id", "size"), rush_yds=("rushing_yards", "sum"),
        i5=("i5", "sum"), i12=("i12", "sum"), i35=("i35", "sum"), gtg=("gtg", "sum"), designed=("designed", "sum"),
        sneaks=("sneak", "sum"), rush_expl=("expl", "sum")).rename_axis(["game_id", "pid"])
    T = tgt.groupby(["game_id", "receiver_player_id"]).agg(targets=("play_id", "size"), rec=("complete_pass", "sum"),
        rec_yds=("receiving_yards", "sum"), ez=("ez", "sum"), rz=("rz", "sum"), air=("air_yards", "sum"),
        yac=("yards_after_catch", "sum"), xcatch=("cp", "sum"), rec_expl=("expl", "sum")).rename_axis(["game_id", "pid"])
    pa = p[p.pass_attempt == 1].groupby(["game_id", "passer_player_id"]).agg(att=("pass_attempt", "sum"),
        cmp=("complete_pass", "sum"), pass_yds=("passing_yards", "sum")).rename_axis(["game_id", "pid"])
    td = p[(p.touchdown == 1) & (p.two_point_attempt != 1) & p.td_player_id.notna()].copy()
    yd = np.where(td.rush_touchdown == 1, td.rushing_yards, np.where(td.pass_touchdown == 1, td.yards_gained, td.yards_gained))
    td["gl"] = (td.yardline_100 <= 10).astype(int); td["long"] = (pd.Series(yd, index=td.index).fillna(0) >= 20).astype(int)
    TD = td.groupby(["game_id", "td_player_id"]).agg(tds=("play_id", "size"), gl_tds=("gl", "sum"), long_tds=("long", "sum")).rename_axis(["game_id", "pid"])
    df = base.join(R, on=["game_id", "pid"]).join(T, on=["game_id", "pid"]).join(pa, on=["game_id", "pid"]).join(TD, on=["game_id", "pid"])
    num = [c for c in df.columns if c not in ("game_id", "season", "week", "team", "opponent", "pid", "pos")]
    df[num] = df[num].fillna(0)  # a snap row with no carry/target is a true zero
    # team-game totals
    team = q.groupby(["game_id", "posteam"]).agg(plays=("play_id", "size"), dropbacks=("qb_dropback", "sum")).rename_axis(["game_id", "team"])
    tr = rush.groupby(["game_id", "posteam"]).agg(t_carries=("play_id", "size"), t_i5=("i5", "sum"), t_gtg=("gtg", "sum")).rename_axis(["game_id", "team"])
    tt = tgt.groupby(["game_id", "posteam"]).agg(t_targets=("play_id", "size"), t_ez=("ez", "sum"), t_rz=("rz", "sum")).rename_axis(["game_id", "team"])
    off = p[(p.touchdown == 1) & (p.two_point_attempt != 1) & ((p.pass_touchdown == 1) | (p.rush_touchdown == 1))]
    to = off.groupby(["game_id", "posteam"]).size().rename("t_offtd").rename_axis(["game_id", "team"])
    # neutral situations: score within 7, quarters 1-3
    nq = q[(q.score_differential.abs() <= 7) & (q.qtr <= 3)]
    tn = nq.groupby(["game_id", "posteam"]).agg(n_plays=("play_id", "size"), n_db=("qb_dropback", "sum")).rename_axis(["game_id", "team"])
    tg = team.join(tr).join(tt).join(to).join(tn).fillna(0).reset_index()
    df = df.merge(tg, on=["game_id", "team"], how="left")
    df["td_any"] = (df.tds > 0).astype(int); df["td_gl"] = (df.gl_tds > 0).astype(int); df["td_long"] = (df.long_tds > 0).astype(int)
    return df


def defense_games(p, players):
    """Per defense-game: TDs allowed by scorer position group, rush yards/carry allowed, pressure."""
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").position
    off = p[(p.touchdown == 1) & (p.two_point_attempt != 1) & ((p.pass_touchdown == 1) | (p.rush_touchdown == 1))].copy()
    off["g"] = off.td_player_id.map(pos)
    a = off.pivot_table(index=["game_id", "defteam"], columns="g", values="play_id", aggfunc="size", fill_value=0)
    a = a.reindex(columns=SKILL, fill_value=0).add_prefix("allow_")
    q = p[p.play_type.isin(["run", "pass"])]
    r = q[q.play_type == "run"].groupby(["game_id", "defteam"]).agg(d_carries=("play_id", "size"), d_rush_yds=("yards_gained", "sum"))
    d = q[q.qb_dropback == 1].groupby(["game_id", "defteam"]).agg(d_db=("play_id", "size"), d_pressure=("qb_hit", "sum"), d_sacks=("sack", "sum"))
    out = a.join(r, how="outer").join(d, how="outer").fillna(0).reset_index().rename(columns={"defteam": "opp"})
    return out


SUMS = ["offense_snaps", "team_snaps", "carries", "rush_yds", "i5", "i12", "i35", "gtg", "designed", "sneaks", "rush_expl",
        "targets", "rec", "rec_yds", "ez", "rz", "air", "yac", "xcatch", "rec_expl", "att", "cmp", "pass_yds", "tds", "gl_tds", "long_tds",
        "t_carries", "t_i5", "t_gtg", "t_targets", "t_ez", "t_rz", "plays", "dropbacks"]


def _wsum(h, keys):
    hw = h[SUMS].multiply(h.w, axis=0)
    hw[keys] = h[keys]
    hw["games"] = h.w
    return hw.groupby(keys).sum()


def _depth_ranks(dc, kickoff_utc, teams):
    """pos_rank per (team, pid) from the last snapshot before kickoff (offensive skill slots only)."""
    d = dc[dc.dt < kickoff_utc]
    if d.empty:
        return {}
    d = d[d.team.isin(teams)]
    last = d.groupby("team").dt.transform("max")
    d = d[(d.dt == last) & d.pos_abb.isin(["QB", "RB", "WR", "TE", "LWR", "RWR", "SWR", "SLWR", "SRWR", "HB", "FB"])]
    return d.dropna(subset=["gsis_id"]).groupby(["team", "gsis_id"]).pos_rank.min().to_dict()


def build(players, targets=None, upcoming=None, max_week_2026=9):
    """targets: list of (season, week) to build from played games; upcoming: (season, week, cur_df) for a week not played yet
    (cur_df has game_id, team, opponent, pid, pos)."""
    seasons = {}
    for y in (2025, 2026):
        p, s, inj, ros, ftn, dc = load_season(y, max_week_2026)
        dc = dc.assign(dt=pd.to_datetime(dc.dt, utc=True))
        seasons[y] = dict(p=p, pg=player_games(y, p, s, players, ftn), inj=inj, ros=ros, dc=dc, dg=defense_games(p, players))
    games = pd.read_csv(C / "games.csv")
    games = games[games.season.isin([2025, 2026]) & (games.game_type == "REG")]
    games["kick"] = pd.to_datetime(games.gameday + " " + games.gametime).dt.tz_localize("America/New_York").dt.tz_convert("UTC")
    gidx = games.set_index("game_id")
    PG = pd.concat([seasons[y]["pg"] for y in seasons], ignore_index=True)
    PG["t"] = (PG.season - 2025) * 20 + PG.week
    DG = pd.concat([seasons[y]["dg"].assign(season=y) for y in seasons], ignore_index=True)
    DG = DG.merge(games[["game_id", "week"]], on="game_id")
    DG["t"] = (DG.season - 2025) * 20 + DG.week
    # team-game table (one row per team-game) for team history
    TG = PG.drop_duplicates(["game_id", "team"])[["game_id", "season", "week", "t", "team", "plays", "dropbacks", "n_plays", "n_db", "t_offtd", "t_i5", "t_ez", "t_carries", "t_targets"]]
    pts = []
    for g in games.itertuples():
        pts += [(g.game_id, g.home_team, g.home_score), (g.game_id, g.away_team, g.away_score)]
    TG = TG.merge(pd.DataFrame(pts, columns=["game_id", "team", "points"]), on=["game_id", "team"], how="left")
    rows = []
    if targets is None:
        targets = [(2025, w) for w in range(3, 19)] + [(2026, w) for w in range(1, max_week_2026 + 1)]
    jobs = [(y, w, PG[(PG.season == y) & (PG.week == w)].copy()) for (y, w) in targets]
    if upcoming is not None:
        jobs.append(upcoming)
    for (y, w, cur) in jobs:
        t0 = (y - 2025) * 20 + w
        cur = cur.reset_index(drop=True)
        H = PG[(PG.t < t0) & (PG.season >= y - 1)].copy()
        H["w"] = np.where(H.season == y, 1.0, PRIOR_WEIGHT)
        same = _wsum(H, ["pid", "team"]); anyt = _wsum(H, ["pid"])
        # current-team history, else any team (team change)
        j = cur[["pid", "team"]].join(same, on=["pid", "team"])
        fb = j.games.isna() | (j.games < 1)
        alt = cur[["pid"]].join(anyt, on="pid")
        for c in same.columns:
            j.loc[fb, c] = alt.loc[fb, c]
        j["team_change"] = fb & alt.games.notna()
        j["no_history"] = j.games.isna()
        Hs = H.sort_values("t")
        rec = Hs.groupby("pid").tail(3).groupby("pid")[["carries", "t_carries", "targets", "t_targets", "offense_snaps", "team_snaps"]].sum()
        TH = TG[(TG.t < t0) & (TG.season >= y - 1)].copy(); TH["w"] = np.where(TH.season == y, 1.0, PRIOR_WEIGHT)
        tcols = ["plays", "dropbacks", "n_plays", "n_db", "t_offtd", "points", "t_i5", "t_ez"]
        tw = TH[tcols].multiply(TH.w, axis=0).assign(team=TH.team, games=TH.w).groupby("team").sum()
        ratio = (TH.t_offtd * TH.w).sum() / (TH.points * TH.w).sum()
        DH = DG[(DG.t < t0) & (DG.season >= y - 1)].copy(); DH["w"] = np.where(DH.season == y, 1.0, PRIOR_WEIGHT)
        dcols = [c for c in DH.columns if c.startswith("allow_")] + ["d_carries", "d_rush_yds", "d_db", "d_pressure"]
        dw = DH[dcols].multiply(DH.w, axis=0).assign(opp=DH.opp, games=DH.w).groupby("opp").sum()
        lg = DH[dcols].multiply(DH.w, axis=0).sum() / DH.w.sum()
        # injuries / roster this week
        inj = seasons[y]["inj"]; inj = inj[(inj.week == w) & (inj.game_type == "REG") if "game_type" in inj else (inj.week == w)]
        st = inj.set_index("gsis_id").report_status.to_dict()
        ros = seasons[y]["ros"]; ros = ros[ros.week == w]
        rstat = ros.set_index("gsis_id").status.to_dict(); rteam = ros.set_index("gsis_id").team.to_dict()
        # vacated opportunity: players with history on this team who are out this week
        tm_hist = same.reset_index()
        tm_hist = tm_hist[tm_hist.games >= 1]
        out_flag = tm_hist.pid.map(lambda x: st.get(x) in ("Out", "Doubtful") or rstat.get(x) in ("RES", "CUT", "INA", "DEV") or (x in rteam and rteam[x] not in (None,) and False))
        moved = tm_hist.apply(lambda r: r.pid in rteam and rteam[r.pid] != r.team, axis=1)
        tm_hist["out"] = out_flag | moved
        tm_hist["cs"] = tm_hist.carries / tm_hist.t_carries.replace(0, np.nan); tm_hist["ts"] = tm_hist.targets / tm_hist.t_targets.replace(0, np.nan)
        vac = tm_hist[tm_hist.out].groupby("team")[["cs", "ts"]].sum()
        # starting QB out: QB with most weighted attempts on this team in the last 3 team games
        qbh = Hs[(Hs.pos == "QB")].groupby(["team"]).apply(lambda d: d[d.t >= d.t.max() - 2].groupby("pid").att.sum().idxmax() if d.att.sum() > 0 else None, include_groups=False)
        for g_id, gg in cur.groupby("game_id"):
            g = gidx.loc[g_id]
            home_pts = g.total_line / 2 + g.spread_line / 2; away_pts = g.total_line - home_pts
            ranks = _depth_ranks(seasons[y]["dc"], g.kick, [g.home_team, g.away_team])
            for r in gg.itertuples():
                a = j.loc[r.Index]
                team_imp = home_pts if r.team == g.home_team else away_pts
                T = tw.loc[r.team] if r.team in tw.index else None
                D = dw.loc[r.opponent] if r.opponent in dw.index else None
                def sh(x, d):
                    return float(a[x] / a[d]) if pd.notna(a[x]) and a[d] > 0 else 0.0
                k = 4.0  # shrink defense rates toward league with 4 pseudo-games
                dval = lambda c: float(((D[c] if D is not None else 0) + k * lg[c]) / ((D.games if D is not None else 0) + k))
                rc = rec.loc[r.pid] if r.pid in rec.index else None
                qbs = qbh.get(r.team) if hasattr(qbh, "get") else None
                v = vac.loc[r.team] if r.team in vac.index else pd.Series({"cs": 0.0, "ts": 0.0})
                hist_games = float(a.games) if pd.notna(a.games) else 0.0
                rows.append(dict(
                    game_id=g_id, season=y, week=w, team=r.team, opp=r.opponent, pid=r.pid, pos=r.pos,
                    # outcomes
                    **({} if not hasattr(r, "td_any") else dict(
                    y_td=r.td_any, y_gl=r.td_gl, y_long=r.td_long, y_rush_yds=r.rush_yds, y_rec=r.rec, y_rec_yds=r.rec_yds,
                    y_pass_yds=r.pass_yds, y_carries=r.carries, y_targets=r.targets, y_att=r.att,
                    a_i5=r.i5, a_ez=r.ez, a_carries=r.carries, a_targets=r.targets, a_gtg=r.gtg, a_snaps=r.offense_snaps / max(r.team_snaps, 1),
                    a_team_offtd=r.t_offtd)),
                    # market / team
                    imp_pts=team_imp, spread_for=(g.spread_line if r.team == g.home_team else -g.spread_line), ratio=ratio,
                    exp_team_td=team_imp * ratio,
                    team_plays_g=float(T.plays / T.games) if T is not None else np.nan,
                    team_db_rate=float(T.dropbacks / T.plays) if T is not None and T.plays else np.nan,
                    team_neutral_pass=float(T.n_db / T.n_plays) if T is not None and T.n_plays else np.nan,
                    team_offtd_g=float(T.t_offtd / T.games) if T is not None else np.nan,
                    team_i5_g=float(T.t_i5 / T.games) if T is not None else np.nan,
                    # player history
                    hist_games=hist_games, team_change=bool(a.team_change), no_history=bool(a.no_history),
                    snap_share=sh("offense_snaps", "team_snaps"), carry_share=sh("carries", "t_carries"), target_share=sh("targets", "t_targets"),
                    i5_share=sh("i5", "t_i5"), gtg_share=sh("gtg", "t_gtg"), ez_share=sh("ez", "t_ez"), rz_share=sh("rz", "t_rz"),
                    td_rate=float(a.tds / a.games) if hist_games else np.nan, gl_td_rate=float(a.gl_tds / a.games) if hist_games else np.nan,
                    long_td_rate=float(a.long_tds / a.games) if hist_games else np.nan,
                    expl_per_touch=float((a.rush_expl + a.rec_expl) / max(a.carries + a.rec, 1)) if hist_games else np.nan,
                    designed_g=float(a.designed / a.games) if hist_games and r.pos == "QB" else 0.0,
                    sneaks_g=float(a.sneaks / a.games) if hist_games and r.pos == "QB" else 0.0,
                    carries_g=float(a.carries / a.games) if hist_games else np.nan, targets_g=float(a.targets / a.games) if hist_games else np.nan,
                    ypc=float(a.rush_yds / a.carries) if hist_games and a.carries else np.nan,
                    catch_rate=float(a.rec / a.targets) if hist_games and a.targets else np.nan,
                    xcatch_rate=float(a.xcatch / a.targets) if hist_games and a.targets else np.nan,
                    ypt=float(a.rec_yds / a.targets) if hist_games and a.targets else np.nan,
                    adot=float(a.air / a.targets) if hist_games and a.targets else np.nan,
                    yac_per_rec=float(a.yac / a.rec) if hist_games and a.rec else np.nan,
                    att_g=float(a.att / a.games) if hist_games else np.nan,
                    cmp_rate=float(a.cmp / a.att) if hist_games and a.att else np.nan,
                    yds_per_cmp=float(a.pass_yds / a.cmp) if hist_games and a.cmp else np.nan,
                    rush_yds_g=float(a.rush_yds / a.games) if hist_games else np.nan, rec_g=float(a.rec / a.games) if hist_games else np.nan,
                    rec_yds_g=float(a.rec_yds / a.games) if hist_games else np.nan, pass_yds_g=float(a.pass_yds / a.games) if hist_games else np.nan,
                    snaps_g=float(a.offense_snaps / a.games) if hist_games else np.nan,
                    # est. routes proxy: snaps on dropbacks, estimated as snaps x team dropback rate (position factor fitted later)
                    est_routes_g=float(a.offense_snaps / a.games * (a.dropbacks / a.plays)) if hist_games and a.plays else np.nan,
                    # recent role (last 3 games played)
                    rc_carry_share=float(rc.carries / rc.t_carries) if rc is not None and rc.t_carries else np.nan,
                    rc_target_share=float(rc.targets / rc.t_targets) if rc is not None and rc.t_targets else np.nan,
                    rc_snap_share=float(rc.offense_snaps / rc.team_snaps) if rc is not None and rc.team_snaps else np.nan,
                    # injuries / lineup (pregame)
                    inj_status=st.get(r.pid) or "", qb_out=int(qbs is not None and qbs != r.pid and (st.get(qbs) in ("Out", "Doubtful") or rstat.get(qbs) in ("RES", "INA", "CUT", "DEV"))),
                    vac_carry=float(v.cs or 0), vac_target=float(v.ts or 0),
                    depth_rank=ranks.get((r.team, r.pid), np.nan),
                    # matchup (opponent defense, shrunk)
                    opp_allow_pos=dval("allow_" + r.pos), lg_allow_pos=float(lg["allow_" + r.pos]),
                    opp_ypc=dval("d_rush_yds") / max(dval("d_carries"), 1e-6), opp_pressure=dval("d_pressure") / max(dval("d_db"), 1e-6),
                ))
        print("built", y, w, len(cur), flush=True)
    return pd.DataFrame(rows)


if __name__ == "__main__":
    players = pd.read_parquet(C / "players.parquet")
    df = build(players)
    out = C / "backtest_features.parquet"
    df.to_parquet(out)
    print(df.shape, out)
