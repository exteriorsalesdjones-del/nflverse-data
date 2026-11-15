"""Download the nflverse release files the board is built from.

Each file is downloaded to a temp name and only replaces the cached copy when
the download completes and parses, so a failed refresh keeps the last good
data (the page then shows it as stale through meta.json's timestamp).
"""

from __future__ import annotations

import os
import sys
import urllib.request
from pathlib import Path

import pandas as pd

SEASON = 2026
BASE = "https://github.com/nflverse/nflverse-data/releases/download"
FILES = {
    f"play_by_play_{SEASON}.parquet": f"{BASE}/pbp/play_by_play_{SEASON}.parquet",
    "games.csv": f"{BASE}/schedules/games.csv",
    f"advstats_week_def_{SEASON}.parquet": f"{BASE}/pfr_advstats/advstats_week_def_{SEASON}.parquet",
    "players.parquet": f"{BASE}/players/players.parquet",
    f"injuries_{SEASON}.parquet": f"{BASE}/injuries/injuries_{SEASON}.parquet",
    f"snap_counts_{SEASON}.parquet": f"{BASE}/snap_counts/snap_counts_{SEASON}.parquet",
    f"roster_weekly_{SEASON}.parquet": f"{BASE}/weekly_rosters/roster_weekly_{SEASON}.parquet",
    # model v0.3c inputs: pregame depth charts, FTN charting (QB sneaks), and 2025 as last-season history
    f"depth_charts_{SEASON}.parquet": f"{BASE}/depth_charts/depth_charts_{SEASON}.parquet",
    f"ftn_charting_{SEASON}.parquet": f"{BASE}/ftn_charting/ftn_charting_{SEASON}.parquet",
    # Last Game Usage: official game-level targets, carries and pass attempts (cross-checked against play-by-play)
    f"stats_player_week_{SEASON}.parquet": f"{BASE}/stats_player/stats_player_week_{SEASON}.parquet",
    **{f"{k}_{SEASON - 1}.parquet": f"{BASE}/{d}/{k}_{SEASON - 1}.parquet" for k, d in [
        ("play_by_play", "pbp"), ("snap_counts", "snap_counts"), ("injuries", "injuries"), ("roster_weekly", "weekly_rosters"),
        ("depth_charts", "depth_charts"), ("ftn_charting", "ftn_charting")]},
}
CACHE = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))


def fetch(name: str, url: str) -> str:
    tmp = CACHE / (name + ".part")
    urllib.request.urlretrieve(url, tmp)
    (pd.read_csv if name.endswith(".csv") else pd.read_parquet)(tmp)  # must parse
    tmp.replace(CACHE / name)
    return "ok"


def main() -> int:
    CACHE.mkdir(parents=True, exist_ok=True)
    failed = []
    for name, url in FILES.items():
        try:
            print(name, fetch(name, url))
        except Exception as e:  # keep the previous good copy
            failed.append(name)
            print(name, "FAILED, keeping previous copy:", e, file=sys.stderr)
    # kickoff weather for the upcoming week (failure keeps the page working without it)
    try:
        import weather
        weather.main()
    except Exception as e:
        print("weather FAILED, games will show no forecast:", e, file=sys.stderr)
    (CACHE / "fetch_status.json").write_text(__import__("json").dumps({"failed": failed}))
    missing = [n for n in FILES if not (CACHE / n).exists()]
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
