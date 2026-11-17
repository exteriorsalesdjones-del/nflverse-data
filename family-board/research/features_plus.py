"""Extra pregame inputs tested on top of usage-v0.3c (research/improvements.py decides which, if any, are adopted).

Everything for a game in (season, week) uses only games played before that week plus information published before
kickoff, exactly like features.py. Two families:

1. Defense, split by HOW a touchdown is scored and adjusted for who the defense has played.
   For every earlier game the defense's result is compared with what that offense does against everyone else
   (leave-this-game-out), so a defense that has faced strong running teams isn't marked down for it. Shrunk toward
   zero (= league average) because ten weeks is a small sample.
     rush_epa_adj, pass_epa_adj      expected points per run / per dropback allowed, vs the offenses' norms
     rushtd_adj                      rushing TDs allowed per game, vs the offenses' norms
     rectd_{WR,TE,RB}_adj            receiving TDs allowed per game to that position, vs the offenses' norms
     tshare_{WR,TE,RB}_adj           share of targets that position gets against this defense, vs the offenses' norms
     gl_stop_adj                     TDs per carry inside the 5 allowed, vs league

2. Role changes: who has the scoring work NOW, when it differs from the season totals the model already uses.
     l2_i5_share, l2_gtg_share       share of the team's inside-the-5 and goal-to-go carries in his last 2 games
     l2_carry_share, l2_target_share, l1_snap_share
     vac_i5, vac_gtg, vac_ez         share of the team's goal-line carries / end-zone targets held by teammates who are
                                     out this week (final injury report Out/Doubtful, or not on the active roster)
     next_up                         1 for the highest-usage remaining player at his position when a teammate is out
     depth_promo                     depth-chart places gained over the last 14 days
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import features as F

OUT_STATUS = ("RES", "CUT", "INA", "DEV")
RPOS = ["WR", "TE", "RB"]


def load(players: pd.DataFrame, max_week_2026: int) -> dict:
    """Per-season tables shared by both families."""
    S = {}
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").position
    games = pd.read_csv(F.C / "games.csv")
    games = games[games.season.isin([2025, 2026]) & (games.game_type == "REG")]
    games["kick"] = pd.to_datetime(games.gameday + " " + games.gametime).dt.tz_localize("America/New_York").dt.tz_convert("UTC")
    for y in (2025, 2026):
        p, s, inj, ros, ftn, dc = F.load_season(y, max_week_2026)
        pg = F.player_games(y, p, s, players, ftn)
        pg["t"] = (y - 2025) * 20 + pg.week
        S[y] = dict(pg=pg, inj=inj, ros=ros, dc=dc.assign(dt=pd.to_datetime(dc.dt, utc=True)), dg=_def_games(p, pos, y))
    S["games"] = games.set_index("game_id")
    S["PG"] = pd.concat([S[2025]["pg"], S[2026]["pg"]], ignore_index=True)
    S["DG"] = pd.concat([S[2025]["dg"], S[2026]["dg"]], ignore_index=True)
    return S


# ---------------------------------------------------------------- defense

def _def_games(p: pd.DataFrame, pos: pd.Series, y: int) -> pd.DataFrame:
    """One row per (game, offense, defense) with the split counts."""
    q = p[p.play_type.isin(["run", "pass"]) & (p.two_point_attempt != 1) & p.posteam.notna() & p.defteam.notna()].copy()
    q["epa"] = q.epa.fillna(0.0)
    run = q[(q.play_type == "run") & (q.qb_scramble != 1)]
    db = q[q.qb_dropback == 1]
    tg = q[q.receiver_player_id.notna()].assign(rp=lambda d: d.receiver_player_id.map(pos))
    key = ["game_id", "posteam", "defteam"]
    out = run.groupby(key).agg(rush_n=("play_id", "size"), rush_epa=("epa", "sum"), rush_td=("rush_touchdown", "sum")).join(
        db.groupby(key).agg(db_n=("play_id", "size"), pass_epa=("epa", "sum")), how="outer")
    i5 = run[run.yardline_100 <= 5]
    out = out.join(i5.groupby(key).agg(i5_n=("play_id", "size"), i5_td=("rush_touchdown", "sum")), how="left")
    out = out.join(tg.groupby(key).size().rename("tgt_all"), how="left")
    for r in RPOS:
        x = tg[tg.rp == r]
        out = out.join(x.groupby(key).agg(**{f"tgt_{r}": ("play_id", "size"), f"rectd_{r}": ("pass_touchdown", "sum")}), how="left")
    out = out.fillna(0.0).reset_index().rename(columns={"posteam": "off", "defteam": "opp"})
    wk = p.drop_duplicates("game_id").set_index("game_id").week
    out["season"] = y; out["week"] = out.game_id.map(wk); out["t"] = (y - 2025) * 20 + out.week
    return out


def defense_table(S: dict, y: int, w: int) -> pd.DataFrame:
    """Opponent-adjusted defense numbers known before (y, w). Index: defense team. 0 = league average."""
    t0 = (y - 2025) * 20 + w
    H = S["DG"]; H = H[(H.t < t0) & (H.season >= y - 1)].copy()
    if H.empty:
        return pd.DataFrame()
    H["w"] = np.where(H.season == y, 1.0, F.PRIOR_WEIGHT)
    cols = ["rush_n", "rush_epa", "rush_td", "db_n", "pass_epa", "tgt_all", "i5_n", "i5_td"] + [f"tgt_{r}" for r in RPOS] + [f"rectd_{r}" for r in RPOS]
    W = H[cols].multiply(H.w, axis=0)
    W["off"] = H.off.values; W["opp"] = H.opp.values; W["g"] = H.w.values
    tot = W.groupby("off")[cols + ["g"]].sum()
    lg = W[cols + ["g"]].sum()
    o = tot.reindex(W.off.values); o.index = W.index
    rest = o[cols + ["g"]] - W[cols + ["g"]]                # the offense's other games (leave this one out)

    def norm(num, den):                                     # offense norm per `den`, league value when it has no other game
        return np.where(rest[den] > 0, rest[num] / rest[den].replace(0, np.nan), lg[num] / lg[den])

    D = pd.DataFrame(index=W.index); D["opp"] = W.opp.values
    # per-play rates: weight by plays in the game
    D["rush_epa_d"] = W.rush_epa - norm("rush_epa", "rush_n") * W.rush_n; D["rush_n"] = W.rush_n
    D["pass_epa_d"] = W.pass_epa - norm("pass_epa", "db_n") * W.db_n; D["db_n"] = W.db_n
    # per-game counts
    D["rushtd_d"] = W.rush_td - norm("rush_td", "g") * W.g; D["g"] = W.g
    for r in RPOS:
        D[f"rectd_{r}_d"] = W[f"rectd_{r}"] - norm(f"rectd_{r}", "g") * W.g
        D[f"tshare_{r}_d"] = W[f"tgt_{r}"] - norm(f"tgt_{r}", "tgt_all") * W.tgt_all
    D["tgt_all"] = W.tgt_all
    D["i5_d"] = W.i5_td - (lg.i5_td / max(lg.i5_n, 1e-9)) * W.i5_n; D["i5_n"] = W.i5_n
    a = D.groupby("opp").sum()
    out = pd.DataFrame(index=a.index)
    out["rush_epa_adj"] = a.rush_epa_d / (a.rush_n + 150.0)     # shrink: 150 runs, 200 dropbacks, 4 games, 120 targets, 15 carries
    out["pass_epa_adj"] = a.pass_epa_d / (a.db_n + 200.0)
    out["rushtd_adj"] = a.rushtd_d / (a.g + 4.0)
    for r in RPOS:
        out[f"rectd_{r}_adj"] = a[f"rectd_{r}_d"] / (a.g + 4.0)
        out[f"tshare_{r}_adj"] = a[f"tshare_{r}_d"] / (a.tgt_all + 120.0)
    out["gl_stop_adj"] = a.i5_d / (a.i5_n + 15.0)
    return out


# ---------------------------------------------------------------- role changes

def _out_now(S: dict, y: int, w: int):
    inj = S[y]["inj"]; inj = inj[inj.week == w]
    if "game_type" in inj:
        inj = inj[inj.game_type == "REG"]
    st = inj.set_index("gsis_id").report_status.to_dict()
    ros = S[y]["ros"]; ros = ros[ros.week == w]
    return st, ros.set_index("gsis_id").status.to_dict(), ros.set_index("gsis_id").team.to_dict()


def role_table(S: dict, y: int, w: int, cur: pd.DataFrame) -> pd.DataFrame:
    """Role-change inputs for the rows of `cur` (game_id, team, pid, pos), aligned to cur.index."""
    t0 = (y - 2025) * 20 + w
    H = S["PG"]; H = H[(H.t < t0) & (H.season >= y - 1)].sort_values("t")
    out = pd.DataFrame(index=cur.index, dtype=float)
    cols = ["l2_i5_share", "l2_gtg_share", "l2_carry_share", "l2_target_share", "l1_snap_share", "vac_i5", "vac_gtg", "vac_ez", "next_up", "depth_promo"]
    for c in cols:
        out[c] = np.nan
    if H.empty:
        return out.assign(vac_i5=0.0, vac_gtg=0.0, vac_ez=0.0, next_up=0.0, depth_promo=0.0)
    key = list(zip(cur.pid, cur.team))
    same = H.groupby(["pid", "team"])
    l2 = same.tail(2).groupby(["pid", "team"])[["i5", "t_i5", "gtg", "t_gtg", "carries", "t_carries", "targets", "t_targets"]].sum()
    l1 = same.tail(1).set_index(["pid", "team"])[["offense_snaps", "team_snaps"]]
    sh = lambda a, b: (l2[a] / l2[b].replace(0, np.nan))
    L = pd.DataFrame({"l2_i5_share": sh("i5", "t_i5"), "l2_gtg_share": sh("gtg", "t_gtg"), "l2_carry_share": sh("carries", "t_carries"),
                      "l2_target_share": sh("targets", "t_targets")})
    L["l1_snap_share"] = l1.offense_snaps / l1.team_snaps.replace(0, np.nan)
    L = L.reindex(pd.MultiIndex.from_tuples(key))
    for c in L.columns:
        out[c] = L[c].to_numpy()
    # vacated scoring work: season shares (this season weighted 1, last 0.5) of teammates who are out this week
    Hw = H.assign(wt=np.where(H.season == y, 1.0, F.PRIOR_WEIGHT))
    sums = ["i5", "t_i5", "gtg", "t_gtg", "ez", "t_ez", "carries", "t_carries", "targets", "t_targets"]
    tm = Hw[sums].multiply(Hw.wt, axis=0).assign(pid=Hw.pid.values, team=Hw.team.values, pos=Hw.pos.values, games=Hw.wt.values)
    tm = tm.groupby(["pid", "team", "pos"]).sum().reset_index(); tm = tm[tm.games >= 1]
    st, rstat, rteam = _out_now(S, y, w)
    tm["out"] = [st.get(p) in ("Out", "Doubtful") or rstat.get(p) in OUT_STATUS or (p in rteam and rteam[p] != t) for p, t in zip(tm.pid, tm.team)]
    for c, n, d in (("i5s", "i5", "t_i5"), ("gtgs", "gtg", "t_gtg"), ("ezs", "ez", "t_ez"), ("cs", "carries", "t_carries"), ("ts", "targets", "t_targets")):
        tm[c] = (tm[n] / tm[d].replace(0, np.nan)).fillna(0.0)
    vac = tm[tm.out].groupby("team")[["i5s", "gtgs", "ezs", "cs", "ts"]].sum().clip(upper=0.9)
    v = vac.reindex(cur.team.values).fillna(0.0)
    out["vac_i5"] = v.i5s.to_numpy(); out["vac_gtg"] = v.gtgs.to_numpy(); out["vac_ez"] = v.ezs.to_numpy()
    # next man up: the remaining player with the largest workload at a position where a teammate with real work is out
    tm["work"] = np.where(tm.pos.isin(["RB", "QB"]), tm.cs, tm.ts)
    lost = tm[tm.out & (tm.work >= 0.15)].groupby(["team", "pos"]).size()
    avail = tm[~tm.out].sort_values("work", ascending=False).groupby(["team", "pos"]).head(1).set_index(["team", "pos"]).pid
    nxt = {(tp, avail.get(tp)) for tp in lost.index if tp in avail.index}
    out["next_up"] = [float(((t, q), p) in nxt) for p, t, q in zip(cur.pid, cur.team, cur.pos)]
    # depth-chart places gained in the 14 days before kickoff
    dc = S[y]["dc"]; promo = np.zeros(len(cur))
    G = S["games"]
    for g_id, idx in cur.groupby("game_id").groups.items():
        g = G.loc[g_id]
        now = F._depth_ranks(dc, g.kick, [g.home_team, g.away_team]); was = F._depth_ranks(dc, g.kick - pd.Timedelta(days=14), [g.home_team, g.away_team])
        for i in idx:
            k = (cur.at[i, "team"], cur.at[i, "pid"])
            if k in now and k in was:
                promo[cur.index.get_loc(i)] = float(np.clip(was[k] - now[k], -2, 2))
    out["depth_promo"] = promo
    return out


def add(S: dict, d: pd.DataFrame) -> pd.DataFrame:
    """Attach both families to a features.py table (columns season, week, game_id, team, opp, pid, pos)."""
    parts = []
    for (y, w), cur in d.groupby(["season", "week"]):
        D = defense_table(S, int(y), int(w))
        x = pd.DataFrame(index=cur.index)
        for c in ["rush_epa_adj", "pass_epa_adj", "rushtd_adj", "gl_stop_adj"]:
            x["def_" + c] = cur.opp.map(D[c]).fillna(0.0).to_numpy() if len(D) else 0.0
        for fam in ("rectd", "tshare"):
            vals = np.zeros(len(cur))
            for r in RPOS:
                m = (cur.pos == r).to_numpy()
                if len(D) and m.any():
                    vals[m] = cur.opp[m].map(D[f"{fam}_{r}_adj"]).fillna(0.0).to_numpy()
            x[f"def_{fam}_pos_adj"] = vals
        parts.append(pd.concat([x, role_table(S, int(y), int(w), cur)], axis=1))
    return pd.concat([d, pd.concat(parts).reindex(d.index)], axis=1)


def groups(d: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Model columns for each candidate group (all zero / neutral when the input doesn't apply to the position)."""
    lg = lambda x: np.log(np.clip(x, 0, None) + 0.01)
    rush = d.pos.isin(["RB", "QB"]).astype(float); rb = (d.pos == "RB").astype(float); rec = d.pos.isin(["WR", "TE"]).astype(float)
    ch = lambda recent, season: (lg(d[recent].fillna(d[season])) - lg(d[season]))
    return {
        "def_epa": pd.DataFrame({"mx_rush_epa": d.def_rush_epa_adj * rush, "mx_pass_epa": d.def_pass_epa_adj * rec}),
        "def_td_split": pd.DataFrame({"mx_rushtd": d.def_rushtd_adj * rush, "mx_rectd_pos": d.def_rectd_pos_adj * (1 - (d.pos == "QB")),
                                      "mx_gl_stop": d.def_gl_stop_adj * rush}),
        "def_pos_share": pd.DataFrame({"mx_tshare_pos": d.def_tshare_pos_adj * (1 - (d.pos == "QB"))}),
        "role_goal_line": pd.DataFrame({"d_i5": ch("l2_i5_share", "i5_share") * rush, "d_gtg": ch("l2_gtg_share", "gtg_share") * rush}),
        "role_workload": pd.DataFrame({"d_carry": ch("l2_carry_share", "carry_share"), "d_target": ch("l2_target_share", "target_share"),
                                       "d_snap": (d.l1_snap_share.fillna(d.snap_share) - d.snap_share)}),
        "role_vacated": pd.DataFrame({"vac_i5_rb": d.vac_i5 * rb, "vac_ez_rec": d.vac_ez * rec, "next_up": d.next_up,
                                      "next_up_x_vac": d.next_up * (d.vac_i5 * rush + d.vac_ez * rec)}),
        "role_depth": pd.DataFrame({"depth_promo": d.depth_promo}),
    }
