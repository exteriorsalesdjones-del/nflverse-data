"""Data inventory for the Weeks 1-9 2026 backtest: coverage, nulls, pregame availability, join keys."""
import json, pandas as pd, numpy as np
from pathlib import Path
C = Path(__file__).resolve().parents[1] / ".data" / "cache"
out = {}
g = pd.read_csv(C / "games.csv")
g26 = g[(g.season == 2026) & (g.week <= 9) & (g.game_type == "REG")]
out["games"] = dict(rows=len(g26), final=int(g26.result.notna().sum()), weeks=sorted(g26.week.unique().tolist()),
    null_spread=int(g26.spread_line.isna().sum()), null_total=int(g26.total_line.isna().sum()),
    null_wind_outdoor=int(g26[g26.roof.isin(["outdoors", "open"])].wind.isna().sum()), outdoor=int(g26.roof.isin(["outdoors", "open"]).sum()),
    null_referee=int(g26.referee.isna().sum()))
gids = set(g26.game_id)
p = pd.read_parquet(C / "play_by_play_2026.parquet")
p9 = p[p.week <= 9]
out["pbp"] = dict(plays=len(p9), games=p9.game_id.nunique(), games_missing=sorted(gids - set(p9.game_id)),
    null_air_yards_on_targets=round(float(p9[(p9.pass_attempt == 1) & p9.receiver_player_id.notna()].air_yards.isna().mean()), 4),
    null_receiver_on_complete=int(p9[(p9.complete_pass == 1)].receiver_player_id.isna().sum()),
    null_rusher_on_rush=int(p9[(p9.rush_attempt == 1)].rusher_player_id.isna().sum()),
    qb_scramble_flag_present=bool("qb_scramble" in p9), xyac_null=round(float(p9[p9.complete_pass == 1].xyac_mean_yardage.isna().mean()), 3) if "xyac_mean_yardage" in p9 else None,
    cp_null=round(float(p9[(p9.pass_attempt == 1) & p9.receiver_player_id.notna()].cp.isna().mean()), 3) if "cp" in p9 else None)
s = pd.read_parquet(C / "snap_counts_2026.parquet"); s9 = s[s.week <= 9]
pl = pd.read_parquet(C / "players.parquet")
pmap = pl.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id").gsis_id
s9 = s9.assign(gsis=s9.pfr_player_id.map(pmap))
out["snap_counts"] = dict(rows=len(s9), games=s9.game_id.nunique(), games_missing=sorted(gids - set(s9.game_id)),
    unmatched_pfr_to_gsis=round(float(s9.gsis.isna().mean()), 4), unmatched_offense_players=int(s9[(s9.offense_snaps > 0) & s9.gsis.isna()].shape[0]))
inj = pd.read_parquet(C / "injuries_2026.parquet"); i9 = inj[inj.week <= 9]
out["injuries"] = dict(rows=len(i9), weeks=sorted(i9.week.unique().tolist()), report_status_values=i9.report_status.fillna("(none)").value_counts().to_dict(),
    has_date_modified=bool("date_modified" in i9), date_range=[str(i9.date_modified.min()), str(i9.date_modified.max())] if "date_modified" in i9 else None)
r = pd.read_parquet(C / "roster_weekly_2026.parquet"); r9 = r[r.week <= 9]
out["rosters_weekly"] = dict(rows=len(r9), weeks=sorted(r9.week.unique().tolist()), status_values=r9.status.value_counts().to_dict())
f = pd.read_parquet(C / "ftn_charting_2026.parquet"); f9 = f[f.week <= 9]
out["ftn"] = dict(plays=len(f9), games=f9.nflverse_game_id.nunique(), games_missing=sorted(gids - set(f9.nflverse_game_id)),
    pbp_play_match=round(float(f9.merge(p9[["game_id", "play_id"]], left_on=["nflverse_game_id", "nflverse_play_id"], right_on=["game_id", "play_id"], how="left").play_id.notna().mean()), 4),
    sneaks=int(f9.is_qb_sneak.sum()), null_box=round(float(f9.n_defense_box.isna().mean()), 4))
d = pd.read_parquet(C / "depth_charts_2026.parquet"); d["dt"] = pd.to_datetime(d.dt)
days = d.dt.dt.date.value_counts().sort_index()
out["depth_charts"] = dict(rows=len(d), snapshots=int(d.dt.nunique()), first=str(d.dt.min()), last=str(d.dt.max()), days_with_snapshots=int(len(days)),
    unmatched_gsis=round(float(d.gsis_id.isna().mean()), 4))
n = pd.read_parquet(C / "ngs_receiving.parquet"); n = n[(n.season == 2026) & (n.week.between(1, 9))]
out["ngs_receiving"] = dict(rows=len(n), weeks=sorted(n.week.unique().tolist()), per_week=int(n.groupby("week").size().median()), note="qualifying receivers only")
a = pd.read_parquet(C / "advstats_week_def_2026.parquet"); a9 = a[a.week <= 9]
out["pfr_def"] = dict(rows=len(a9), games=a9.game_id.nunique(), null_targets=round(float(a9.def_targets.isna().mean()), 4))
st = pd.read_parquet(C / "stats_player_week_2026.parquet"); st9 = st[st.week <= 9]
out["stats_player"] = dict(rows=len(st9), games=st9.game_id.nunique())
for y in (2025,):
    pp = pd.read_parquet(C / f"play_by_play_{y}.parquet", columns=["game_id", "season_type", "week"])
    pt = pd.read_parquet(C / f"pbp_participation_{y}.parquet")
    out[f"prior_{y}"] = dict(pbp_reg_games=int(pp[pp.season_type == "REG"].game_id.nunique()), participation_rows=len(pt), participation_cols=[c for c in pt.columns][:30],
        route_null=round(float(pt.route.isna().mean()), 3) if "route" in pt else None)
# true zero vs unknown: a player on the active roster with a snap row but 0 offensive snaps vs no snap row at all
act = r9[r9.status == "ACT"][["week", "team", "gsis_id", "position"]]
sk = act[act.position.isin(["RB", "WR", "TE", "QB"])]
gw = g26[["game_id", "week", "home_team", "away_team"]]
gw = pd.concat([gw.rename(columns={"home_team": "team"}), gw.rename(columns={"away_team": "team"})])[["game_id", "week", "team"]]
sk = sk.merge(gw, on=["week", "team"])
sn = s9[["game_id", "gsis", "offense_snaps"]].rename(columns={"gsis": "gsis_id"})
m = sk.merge(sn, on=["game_id", "gsis_id"], how="left")
out["zero_vs_unknown"] = dict(active_skill_player_games=len(m), snap_row_with_offense_snaps=int((m.offense_snaps > 0).sum()),
    snap_row_zero_offense=int((m.offense_snaps == 0).sum()), no_snap_row=int(m.offense_snaps.isna().sum()))
print(json.dumps(out, indent=1, default=str))
