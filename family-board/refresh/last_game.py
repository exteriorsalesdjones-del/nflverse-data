"""Last Game Usage for every slate candidate -> slate.json candidates[].last_game

Which game: the most recent game, before the matchup being viewed, that was FINAL before that matchup's kickoff and in
which the player took at least one snap (offense, defense or special teams, nflverse snap counts). Byes, inactive games
and zero-snap games are skipped. If the snap counts for a team game aren't published yet, the player's own stat line can
still confirm he appeared; with neither, the game can't be resolved and the result is "unavailable" (never silently
skipped to an older game). The player's team for each week comes from the weekly roster, so traded players are followed.

What is counted, per position (game-level totals):
  targets, rushing attempts, pass attempts: nflverse weekly player stats (stats_player_week), each cross-checked against
  a count from play-by-play (plays nullified by penalty and two-point tries excluded). A value is shown only when both
  agree; a player who appeared but has no stat line is a verified 0 when play-by-play also shows 0.
  QB handoffs: NOT available. Play-by-play names the ball carrier on a run but never the player who handed off, tosses
  and pitches aren't marked, and 2026 participation (who was on the field each play) isn't published. Team rushing
  attempts and RB carries are never used as a substitute.

Statuses: "ok" (game found), "none" (season records show no earlier appearance), "unavailable" (can't be resolved).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".data" / "cache"
DATA = ROOT / "artifact" / "data"
SEASON = 2026
HANDOFF_NOTE = ("Handoffs unavailable: play-by-play doesn't record who handed the ball off (or mark tosses and pitches), "
                "and 2026 on-field participation isn't published.")
TEAM_NAME = {
    "ARI": "Arizona", "ATL": "Atlanta", "BAL": "Baltimore", "BUF": "Buffalo", "CAR": "Carolina", "CHI": "Chicago",
    "CIN": "Cincinnati", "CLE": "Cleveland", "DAL": "Dallas", "DEN": "Denver", "DET": "Detroit", "GB": "Green Bay",
    "HOU": "Houston", "IND": "Indianapolis", "JAX": "Jacksonville", "KC": "Kansas City", "LA": "LA Rams", "LAC": "LA Chargers",
    "LV": "Las Vegas", "MIA": "Miami", "MIN": "Minnesota", "NE": "New England", "NO": "New Orleans", "NYG": "NY Giants",
    "NYJ": "NY Jets", "PHI": "Philadelphia", "PIT": "Pittsburgh", "SEA": "Seattle", "SF": "San Francisco", "TB": "Tampa Bay",
    "TEN": "Tennessee", "WAS": "Washington",
}
STATS_FOR = {"WR": ["targets"], "TE": ["targets"], "RB": ["rush_att", "targets"], "FB": ["rush_att", "targets"], "QB": ["pass_att", "handoffs"]}


class Sources:
    """Everything the selection and counting need, loaded once."""

    def __init__(self, pbp, games, snaps, players, stats, roster):
        g = games[(games.season == SEASON) & (games.game_type == "REG")].copy()
        g["kick"] = pd.to_datetime(g.gameday + " " + g.gametime)  # Eastern, naive: compared only with other Eastern times
        g["final"] = g.home_score.notna() & g.away_score.notna()
        self.games = g.set_index("game_id")
        by_team = []
        for side, opp in (("home_team", "away_team"), ("away_team", "home_team")):
            by_team.append(g[["game_id", "week", "kick", "final", side, opp]].rename(columns={side: "team", opp: "opp"}).assign(home=side == "home_team"))
        self.team_games = pd.concat(by_team, ignore_index=True)
        # participation: snaps > 0 in any phase, mapped from PFR ids to gsis ids
        pmap = players.dropna(subset=["pfr_id", "gsis_id"]).drop_duplicates("pfr_id").set_index("pfr_id").gsis_id
        s = snaps.assign(gsis=snaps.pfr_player_id.map(pmap))
        s["snaps"] = s[["offense_snaps", "defense_snaps", "st_snaps"]].fillna(0).sum(axis=1)
        self.snap_games = set(snaps.game_id)
        self.snapped = set(zip(s[s.snaps > 0].game_id, s[s.snaps > 0].gsis))
        # official stat lines
        st = stats[stats.season_type == "REG"] if "season_type" in stats else stats
        self.stat_games = set(st.game_id)
        self.stat = st.set_index(["game_id", "player_id"])[["targets", "carries", "attempts"]]
        # play-by-play counts (nullified plays and two-point tries excluded)
        q = pbp[(pbp.play_type != "no_play") & (pbp.two_point_attempt != 1)]
        self.pbp_games = set(pbp.game_id)
        self.pbp = {
            "targets": q[(q.pass_attempt == 1) & q.receiver_player_id.notna()].groupby(["game_id", "receiver_player_id"]).size(),
            "carries": q[(q.rush_attempt == 1) & q.rusher_player_id.notna()].groupby(["game_id", "rusher_player_id"]).size(),
            "attempts": q[(q.pass_attempt == 1) & (q.sack != 1) & q.passer_player_id.notna()].groupby(["game_id", "passer_player_id"]).size(),
        }
        r = roster[(roster.season == SEASON)] if "season" in roster else roster
        self.team_of = {(int(w), pid): t for w, pid, t in zip(r.week, r.gsis_id, r.team)}

    @classmethod
    def from_cache(cls, cache=CACHE):
        rd = lambda n: pd.read_parquet(cache / n)
        return cls(rd(f"play_by_play_{SEASON}.parquet"), pd.read_csv(cache / "games.csv"), rd(f"snap_counts_{SEASON}.parquet"),
                   rd("players.parquet"), rd(f"stats_player_week_{SEASON}.parquet"), rd(f"roster_weekly_{SEASON}.parquet"))

    def verified(self, game_id, pid, field):
        """Official total when it matches the play-by-play count; None when either source is missing or they disagree."""
        if game_id not in self.stat_games or game_id not in self.pbp_games:
            return None
        off = self.stat.loc[(game_id, pid), field] if (game_id, pid) in self.stat.index else 0  # no stat line = 0
        off = 0 if pd.isna(off) else int(off)
        pb = int(self.pbp[field].get((game_id, pid), 0))
        return off if off == pb else None

    def appeared(self, game_id, pid):
        """True / False when the game's snap counts are published; otherwise True only if he has a stat line, else None."""
        if game_id in self.snap_games:
            return (game_id, pid) in self.snapped
        if (game_id, pid) in self.stat.index:
            return True
        return None

    def last_game(self, pid, pos, team, week, kick):
        """The player's last game before a matchup in `week` kicking off at `kick` (Eastern, naive Timestamp)."""
        tg = self.team_games
        for w in range(int(week) - 1, 0, -1):
            t = self.team_of.get((w, pid), team)
            row = tg[(tg.team == t) & (tg.week == w)]
            if row.empty:
                continue  # bye (or not on a roster that week)
            r = row.iloc[0]
            if not r.final or r.kick >= kick:
                continue  # not final before this matchup kicked off
            seen = self.appeared(r.game_id, pid)
            if seen is None:
                return {"status": "unavailable", "why": f"Snap counts for week {w} ({r.game_id}) aren't published yet, so the last game can't be confirmed."}
            if not seen:
                continue  # inactive or no snaps
            out = {"status": "ok", "week": int(w), "game_id": r.game_id, "team": t, "opp": r.opp, "opp_name": TEAM_NAME.get(r.opp, r.opp), "home": bool(r.home)}
            for k in STATS_FOR.get(pos, ["targets"]):
                if k == "handoffs":
                    out["handoffs"] = None; out["handoffs_note"] = HANDOFF_NOTE
                else:
                    out[k] = self.verified(r.game_id, pid, {"targets": "targets", "rush_att": "carries", "pass_att": "attempts"}[k])
            return out
        return {"status": "none", "why": f"No earlier {SEASON} game with a snap for this player."}


def annotate(slate: dict, src: Sources) -> dict:
    n = {"ok": 0, "none": 0, "unavailable": 0}
    for g in slate["games"]:
        kick = pd.Timestamp(g["kickoff_et"])
        for t in g["teams"]:
            for c in t["candidates"]:
                c["last_game"] = src.last_game(c["gsis_id"], c.get("pos"), c.get("team") or t["team"], g["week"], kick)
                n[c["last_game"]["status"]] += 1
    slate["last_game_source"] = {"selection": "nflverse snap counts (participation), weekly rosters (team), schedules (final, kickoff)",
                                 "stats": "nflverse weekly player stats, each cross-checked against play-by-play",
                                 "handoffs": HANDOFF_NOTE, "counts": n}
    return n


if __name__ == "__main__":
    p = DATA / "slate.json"; slate = json.loads(p.read_text())
    n = annotate(slate, Sources.from_cache())
    p.write_text(json.dumps(slate, separators=(",", ":"), allow_nan=False))
    print("last_game:", n)
    sys.exit(0)
