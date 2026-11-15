"""Simulated live feed for tests: two simultaneous Week 10 games (BUF at NYJ, CAR at NO), shaped like BALLDONTLIE's
documented /games and /plays responses. Every event here is made up for testing; none of it is real game data.

Timeline (seconds after start), with what each step should do:
  t=0   both games kick off, no scoring
  t=2   BUF: James Cook 12-yd run TD (play 1001)                         -> new event
  t=4   same feed again (play 1001 repeated)                             -> no duplicate, no update
  t=6   CAR: Chuba Hubbard 3-yd run TD (play 2001), same moment as
        BUF: Dalton Kincaid... credited to Josh Allen (play 1002)        -> two games update together
  t=8   BUF: James Cook second TD, 30-yd run (play 1003)                -> Cook count 2
  t=10  BUF play 1002 corrected: receiver is DJ Moore, not Josh Allen     -> scorer correction, Allen 0, Moore 1
  t=12  CAR play 2001 overturned (source drops it)                         -> overturned, Hubbard 0
"""
import json
from pathlib import Path

TEAM = {"BUF": {"id": 4, "abbreviation": "BUF"}, "NYJ": {"id": 20, "abbreviation": "NYJ"},
        "CAR": {"id": 29, "abbreviation": "CAR"}, "NO": {"id": 18, "abbreviation": "NO"}}
PLAYERS = [{"id": 501, "name": "James Cook"}, {"id": 502, "name": "Josh Allen"}, {"id": 503, "name": "DJ Moore"},
           {"id": 601, "name": "Chuba Hubbard"}]


def game(gid, away, home, a, h, period=1, clock="10:00", state="in"):
    return {"id": gid, "visitor_team": TEAM[away], "home_team": TEAM[home], "status_state": state, "period": period,
            "time": clock, "visitor_team_score": a, "home_team_score": h, "date": "2026-11-15T18:00:00.000Z"}


def play(pid, team, kind, text, parts, period, clock):
    slug = {"rush": "rushing-touchdown", "pass": "passing-touchdown"}[kind]
    return {"id": str(pid), "type_slug": slug, "type_text": slug.replace("-", " ").title(), "text": text, "scoring_play": True,
            "period": period, "clock_display": clock, "team": TEAM[team], "participants": parts,
            "wallclock": None}


C1 = play(1001, "BUF", "rush", "J.Cook 12 yd run (M.Prater kick) TOUCHDOWN", [{"player_id": 501, "type": "rusher"}], 1, "8:12")
A2 = play(1002, "BUF", "pass", "J.Allen pass to J.Allen for 18 yards, TOUCHDOWN", [{"player_id": 502, "type": "passer"}, {"player_id": 502, "type": "receiver"}], 2, "11:40")
A2fix = play(1002, "BUF", "pass", "J.Allen pass to D.Moore for 18 yards, TOUCHDOWN", [{"player_id": 502, "type": "passer"}, {"player_id": 503, "type": "receiver"}], 2, "11:40")
C3 = play(1003, "BUF", "rush", "J.Cook 30 yd run (M.Prater kick) TOUCHDOWN", [{"player_id": 501, "type": "rusher"}], 2, "4:05")
H1 = play(2001, "CAR", "rush", "C.Hubbard 3 yd run (R.Fitzgerald kick) TOUCHDOWN", [{"player_id": 601, "type": "rusher"}], 1, "2:30")
NOISE = {"id": "1999", "type_slug": "kickoff", "text": "kickoff", "scoring_play": False, "period": 1, "clock_display": "15:00", "team": TEAM["NYJ"], "participants": []}

STEPS = [
    {"t": 0, "game": game(9001, "BUF", "NYJ", 0, 0), "plays": [NOISE], "players": PLAYERS},
    {"t": 0, "game": game(9002, "CAR", "NO", 0, 0), "plays": [], "players": PLAYERS},
    {"t": 2, "game": game(9001, "BUF", "NYJ", 7, 0), "plays": [NOISE, C1]},
    {"t": 4, "game": game(9001, "BUF", "NYJ", 7, 0), "plays": [NOISE, C1]},
    {"t": 6, "game": game(9002, "CAR", "NO", 7, 0), "plays": [H1]},
    {"t": 6, "game": game(9001, "BUF", "NYJ", 14, 0, 2, "11:40"), "plays": [NOISE, C1, A2]},
    {"t": 8, "game": game(9001, "BUF", "NYJ", 21, 0, 2, "4:05"), "plays": [NOISE, C1, A2, C3]},
    {"t": 10, "game": game(9001, "BUF", "NYJ", 21, 0, 2, "4:05"), "plays": [NOISE, C1, A2fix, C3]},
    {"t": 12, "game": game(9002, "CAR", "NO", 0, 0, 1, "2:30"), "plays": []},
]


def write(path: Path, scale: float = 1.0) -> Path:
    path.write_text(json.dumps([{**s, "t": s["t"] * scale} for s in STEPS])); return path
