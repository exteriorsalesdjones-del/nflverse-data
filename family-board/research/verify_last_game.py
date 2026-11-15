"""Independent check of Last Game Usage (refresh/last_game.py) against the raw sources.

For each case the expected value is recomputed here directly from the raw files (snap counts, weekly stats, play-by-play,
schedule) with separate code, then compared with what the module returns and, for the current slate, with what
artifact/data/slate.json (shown on the cards) holds. Run: python3 research/verify_last_game.py
"""
import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
import last_game as LG  # noqa: E402

C = ROOT / ".data" / "cache"
src = LG.Sources.from_cache()
pbp = pd.read_parquet(C / "play_by_play_2026.parquet")
stats = pd.read_parquet(C / "stats_player_week_2026.parquet"); stats = stats[stats.season_type == "REG"]
snaps = pd.read_parquet(C / "snap_counts_2026.parquet")
players = pd.read_parquet(C / "players.parquet")
games = pd.read_csv(C / "games.csv"); games = games[(games.season == 2026) & (games.game_type == "REG")]
roster = pd.read_parquet(C / "roster_weekly_2026.parquet")
slate = json.loads((ROOT / "artifact" / "data" / "slate.json").read_text())
name = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").display_name
pfr_of = players.dropna(subset=["gsis_id", "pfr_id"]).drop_duplicates("gsis_id").set_index("gsis_id").pfr_id
cards = {c["gsis_id"]: (c, g) for g in slate["games"] for t in g["teams"] for c in t["candidates"]}
results = []


def check(label, ok, detail):
    results.append(ok); print(("PASS " if ok else "FAIL ") + label + " — " + detail)


def raw_last_game(pid, week, kick):
    """Independent: walk the player's weekly team backwards; a game counts if final before kickoff and he has snaps > 0."""
    pfr = pfr_of.get(pid)
    for w in range(week - 1, 0, -1):
        r = roster[(roster.week == w) & (roster.gsis_id == pid)]
        team = r.team.iloc[0] if len(r) else None
        if team is None:
            continue
        g = games[(games.week == w) & ((games.home_team == team) | (games.away_team == team))]
        if g.empty or g.home_score.isna().iloc[0] or pd.Timestamp(g.gameday.iloc[0] + " " + g.gametime.iloc[0]) >= kick:
            continue
        gid = g.game_id.iloc[0]
        sn = snaps[(snaps.game_id == gid) & (snaps.pfr_player_id == pfr)]
        if len(sn) and (sn[["offense_snaps", "defense_snaps", "st_snaps"]].fillna(0).sum(axis=1) > 0).any():
            return gid, w
    return None, None


def raw_counts(gid, pid):
    """Independent: official stat line, and the same three counts from play-by-play."""
    s = stats[(stats.game_id == gid) & (stats.player_id == pid)]
    off = {k: (int(s[k].iloc[0]) if len(s) else 0) for k in ("targets", "carries", "attempts")}
    q = pbp[(pbp.game_id == gid) & (pbp.play_type != "no_play") & (pbp.two_point_attempt != 1)]
    pb = {"targets": int(((q.pass_attempt == 1) & (q.receiver_player_id == pid)).sum()),
          "carries": int(((q.rush_attempt == 1) & (q.rusher_player_id == pid)).sum()),
          "attempts": int(((q.pass_attempt == 1) & (q.sack != 1) & (q.passer_player_id == pid)).sum())}
    return off, pb


def verify_card(label, pid):
    c, g = cards[pid]; lg = c["last_game"]; kick = pd.Timestamp(g["kickoff_et"])
    gid, w = raw_last_game(pid, g["week"], kick)
    off, pb = raw_counts(gid, pid)
    want = {"targets": off["targets"], "rush_att": off["carries"], "pass_att": off["attempts"]}
    shown = {k: lg.get(k) for k in LG.STATS_FOR[c["pos"]] if k != "handoffs"}
    ok = lg["game_id"] == gid and all(shown[k] == want[k] for k in shown) and all(off[f] == pb[f] for f in off)
    extra = " · handoffs: " + ("unavailable" if lg.get("handoffs") is None and lg.get("handoffs_note") else str(lg.get("handoffs"))) if c["pos"] == "QB" else ""
    check(label, ok, f"{name.get(pid, pid)} ({c['pos']} {c['team']}): card week {lg['week']} {'vs' if lg['home'] else 'at'} {lg['opp']} {shown}{extra}; "
                     f"raw: {gid} official {off} = play-by-play {pb}")
    return lg


# 1. one player per position on the current slate (highest chance at each position)
by_pos = {}
for pid, (c, g) in cards.items():
    if c["pos"] in ("WR", "TE", "RB", "QB") and (c["pos"] not in by_pos or c["p"] > cards[by_pos[c["pos"]]][0]["p"]):
        by_pos[c["pos"]] = pid
for pos in ("WR", "TE", "RB", "QB"):
    verify_card(f"{pos} on the Week 10 slate", by_pos[pos])

# 2. returning from an absence: last game is earlier than his team's most recent final game
ret = None
for pid, (c, g) in cards.items():
    lg = c["last_game"]; kick = pd.Timestamp(g["kickoff_et"])
    tg = src.team_games[(src.team_games.team == c["team"]) & src.team_games.final & (src.team_games.kick < kick)]
    if lg["status"] == "ok" and len(tg) and lg["week"] < tg.week.max():
        ret = pid; break
if ret:
    lg = verify_card("Player returning from an absence", ret)
    c, g = cards[ret]
    missed = sorted(set(src.team_games[(src.team_games.team == c["team"]) & src.team_games.final & (src.team_games.week > lg["week"]) & (src.team_games.week < g["week"])].week))
    print(f"      skipped team weeks {missed} (no snaps / inactive)")
else:
    check("Player returning from an absence", False, "none found on the slate")

# 3. a verified zero: appeared (snaps) but 0 in a displayed stat
zero = next((pid for pid, (c, g) in cards.items() if c["last_game"]["status"] == "ok" and any(c["last_game"].get(k) == 0 for k in ("targets", "rush_att", "pass_att"))), None)
if zero:
    verify_card("Verified zero (played, 0 in a shown stat)", zero)
    c, _ = cards[zero]; gid = c["last_game"]["game_id"]
    sn = snaps[(snaps.game_id == gid) & (snaps.pfr_player_id == pfr_of.get(zero))]
    print(f"      snap counts confirm he played: offense {int(sn.offense_snaps.sum())}, special teams {int(sn.st_snaps.sum())}")
else:
    check("Verified zero", False, "none found")

# 4. historical matchups: rebuild the Week 6 slate's answers and compare with raw data; Week 2 shows "no prior game"
hist_ok = 0; hist_n = 0; bad = []
for g in games[games.week == 6].itertuples():
    kick = pd.Timestamp(g.gameday + " " + g.gametime)
    for team in (g.home_team, g.away_team):
        ids = roster[(roster.week == 6) & (roster.team == team) & roster.position.isin(["WR", "TE", "RB", "QB"]) & (roster.status == "ACT")]
        for r in ids.itertuples():
            lg = src.last_game(r.gsis_id, r.position, team, 6, kick)
            gid, w = raw_last_game(r.gsis_id, 6, kick)
            hist_n += 1
            got = lg.get("game_id") if lg["status"] == "ok" else None
            if got == gid:
                hist_ok += 1
            else:
                bad.append((r.full_name, got, gid, lg["status"]))
check("Historical slate (Week 6): every active WR/TE/RB/QB's last game matches the raw data", hist_ok == hist_n, f"{hist_ok}/{hist_n} match{'; first mismatches ' + str(bad[:3]) if bad else ''}")
# a Week 6 game must never use a Week 6 game, and only games final before ITS kickoff
th = games[games.week == 6].sort_values(["gameday", "gametime"]).iloc[0]
lg = src.last_game("00-0039139", "RB", "DET", 6, pd.Timestamp(th.gameday + " " + th.gametime))
check("Historical cutoff: nothing at or after the viewed week", lg["status"] != "ok" or lg["week"] < 6, f"Gibbs before Week 6 -> week {lg.get('week')}")
w2 = games[games.week == 2]; none_seen = []
for g in w2.itertuples():
    kick = pd.Timestamp(g.gameday + " " + g.gametime)
    for team in (g.home_team, g.away_team):
        for r in roster[(roster.week == 2) & (roster.team == team) & roster.position.isin(["WR", "TE", "RB", "QB"]) & (roster.status == "ACT")].itertuples():
            lg = src.last_game(r.gsis_id, r.position, team, 2, kick)
            if lg["status"] == "none":
                gid, _ = raw_last_game(r.gsis_id, 2, kick); none_seen.append((r.full_name, gid))
check("No prior game played (Week 2 slate, players with no Week 1 snap)", len(none_seen) > 0 and all(gid is None for _, gid in none_seen),
      f"{len(none_seen)} players, e.g. {[n for n, _ in none_seen[:3]]}; raw data shows no earlier snap for any of them")

# 5. games with two quarterbacks passing, and direct snaps
q = pbp[(pbp.play_type != "no_play") & (pbp.two_point_attempt != 1) & (pbp.pass_attempt == 1) & (pbp.sack != 1)]
multi = q.groupby(["game_id", "posteam"]).passer_player_id.nunique()
mg = multi[multi >= 2].index.tolist()
if mg:
    gid, team = mg[-1]
    qbs = q[(q.game_id == gid) & (q.posteam == team)].passer_player_id.value_counts()
    week = int(gid.split("_")[1]) + 1
    nxt = games[(games.week == week) & ((games.home_team == team) | (games.away_team == team))]
    kick = pd.Timestamp(nxt.gameday.iloc[0] + " " + nxt.gametime.iloc[0]) if len(nxt) else pd.Timestamp("2026-12-31")
    parts = []; ok = True
    for pid, n_pb in qbs.items():
        lg = src.last_game(pid, "QB", team, week, kick)
        off = stats[(stats.game_id == gid) & (stats.player_id == pid)].attempts
        off = int(off.iloc[0]) if len(off) else 0
        same = lg.get("game_id") == gid
        ok &= (not same) or (lg["pass_att"] == off == n_pb and lg["handoffs"] is None)
        parts.append(f"{name.get(pid, pid)} {lg.get('pass_att') if same else '(later game: ' + str(lg.get('game_id')) + ')'} (official {off}, pbp {n_pb})")
    check(f"Two QBs in one game ({gid}, {team}): each QB gets only his own attempts; handoffs unavailable", ok, "; ".join(parts))
ds = pbp[pbp.desc.fillna("").str.contains("Direct snap", case=False) & (pbp.play_type == "run") & (pbp.two_point_attempt != 1)]
if len(ds):
    r = ds.iloc[0]; gid, pid = r.game_id, r.rusher_player_id
    off, pb = raw_counts(gid, pid)
    lgx = src.verified(gid, pid, "carries")
    check("Direct snap: credited to the player who ran it, not a QB", lgx == off["carries"] == pb["carries"] and pd.isna(r.passer_player_id),
          f"{gid} {name.get(pid, pid)} carries {lgx} (official {off['carries']}, pbp {pb['carries']}); play: {r.desc[:90]}")

# 6. "Unavailable" when participation for the latest team game isn't published (simulated by hiding one game's snaps)
c, g = cards[by_pos["WR"]]; gid = c["last_game"]["game_id"]
saved = (src.snap_games, src.snapped, src.stat)
src.snap_games = src.snap_games - {gid}
src.stat = src.stat.drop(index=[(gid, c["gsis_id"])], errors="ignore")
lg = src.last_game(c["gsis_id"], c["pos"], c["team"], g["week"], pd.Timestamp(g["kickoff_et"]))
src.snap_games, src.snapped, src.stat = saved
check("Missing snap counts and stat line -> Unavailable (never an older game)", lg["status"] == "unavailable", lg.get("why", ""))

print(f"\n{sum(results)} passed, {len(results) - sum(results)} failed")
sys.exit(0 if all(results) else 1)
