"""Research tab data: per-player, per-game usage for the season -> artifact/data/usage.json

One row per player per game in which he had a target, a rushing attempt or a pass attempt, counted from nflverse
play-by-play (plays nullified by penalty and two-point tries excluded). These counts matched nflverse's official weekly
player stats on every 2026 player-game when checked (2,180 with targets, 1,093 with carries, 317 with pass attempts).
  tgt  targets              car  rushing attempts        att  pass attempts (sacks excluded)
  gl   goal-line carries: rushing attempts that started inside the opponent's 5
  ez   end-zone targets (proxy): targets whose air yards reach the end zone (air_yards >= yards to the goal line)
QB handoffs are not included: play-by-play does not record who handed the ball off.
A player who appeared but had none of these is not listed here; snap counts (played.json) confirm appearances.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

SEASON = 2026
COLS = ["week", "game_id", "team", "opp", "pid", "name", "pos", "tgt", "car", "att", "gl", "ez"]


def build(pbp: pd.DataFrame, players: pd.DataFrame) -> dict:
    q = pbp[(pbp.season_type == "REG") & (pbp.play_type != "no_play") & (pbp.two_point_attempt != 1)].copy()
    q["is_tgt"] = (q.pass_attempt == 1) & q.receiver_player_id.notna()
    q["is_car"] = (q.rush_attempt == 1) & q.rusher_player_id.notna()
    q["is_att"] = (q.pass_attempt == 1) & (q.sack != 1) & q.passer_player_id.notna()
    parts = []
    for pid_col, flag, extra in (("receiver_player_id", "is_tgt", "ez"), ("rusher_player_id", "is_car", "gl"), ("passer_player_id", "is_att", None)):
        x = q[q[flag]].copy()
        x["pid"] = x[pid_col]
        x["n_tgt"] = flag == "is_tgt"; x["n_car"] = flag == "is_car"; x["n_att"] = flag == "is_att"
        x["n_gl"] = (flag == "is_car") & (x.yardline_100 <= 5)
        x["n_ez"] = (flag == "is_tgt") & x.air_yards.notna() & (x.air_yards >= x.yardline_100)
        parts.append(x[["week", "game_id", "posteam", "defteam", "pid", "n_tgt", "n_car", "n_att", "n_gl", "n_ez"]])
    d = pd.concat(parts, ignore_index=True)
    g = d.groupby(["week", "game_id", "posteam", "defteam", "pid"], as_index=False)[["n_tgt", "n_car", "n_att", "n_gl", "n_ez"]].sum()
    meta = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id")
    g["name"] = g.pid.map(meta.display_name).fillna(g.pid)
    g["pos"] = g.pid.map(meta.position).fillna("")
    g = g.sort_values(["week", "game_id", "posteam", "name"])
    rows = [[int(r.week), r.game_id, r.posteam, r.defteam, r.pid, r.name, r.pos, int(r.n_tgt), int(r.n_car), int(r.n_att), int(r.n_gl), int(r.n_ez)]
            for r in g.itertuples()]
    return {"season": SEASON, "through_week": int(g.week.max()) if len(g) else None, "cols": COLS, "rows": rows,
            "source": "nflverse play-by-play (counts match nflverse weekly player stats); published after each game ends",
            "notes": {"gl": "rushing attempts that started inside the opponent's 5", "ez": "targets whose air yards reach the end zone (proxy)",
                      "handoffs": "QB handoffs: unavailable (play-by-play doesn't record who handed off)"}}


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]; cache = root / ".data" / "cache"
    out = build(pd.read_parquet(cache / f"play_by_play_{SEASON}.parquet"), pd.read_parquet(cache / "players.parquet"))
    (root / "artifact" / "data" / "usage.json").write_text(json.dumps(out, separators=(",", ":")))
    print("usage rows", len(out["rows"]), "through week", out["through_week"])
