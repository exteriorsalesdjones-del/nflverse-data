"""Point-in-time anytime-TD chances for every 2026 player, Weeks 1-10, from model usage-v0.3c refit on earlier weeks only
(refresh/model_v03.predict(w) trains on 2025 W3-18 + 2026 weeks < w; inputs are pre-kickoff). Outcomes are attached
afterwards from play-by-play for grading. Writes .data/cache/season_players.parquet."""
from pathlib import Path
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
import model_v03 as M  # noqa: E402

C = ROOT / ".data" / "cache"


def main():
    players = pd.read_parquet(C / "players.parquet")
    frames = []
    for w in range(1, 11):
        p, _ = M.predict(w, players)
        frames.append(p[["season", "week", "game_id", "team", "pid", "pos", "p", "inj_status", "depth_rank", "main_driver",
                         "carry_share", "target_share"]])
        print("week", w, len(p), flush=True)
    d = pd.concat(frames, ignore_index=True)
    # outcomes (grading only)
    pbp = pd.read_parquet(C / "play_by_play_2026.parquet", columns=["game_id", "touchdown", "two_point_attempt", "td_player_id"])
    td = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1) & pbp.td_player_id.notna()]
    scored = td.groupby(["game_id", "td_player_id"]).size().rename("tds").rename_axis(["game_id", "pid"]).reset_index()
    sc = pd.read_parquet(C / "snap_counts_2026.parquet")
    ids = players.dropna(subset=["pfr_id", "gsis_id"]).drop_duplicates("pfr_id").set_index("pfr_id").gsis_id
    sc = sc.assign(pid=sc.pfr_player_id.map(ids))
    snapped = sc[(sc.offense_snaps.fillna(0) + sc.st_snaps.fillna(0)) > 0][["game_id", "pid"]].drop_duplicates().assign(played=True)
    d = d.merge(scored, on=["game_id", "pid"], how="left").merge(snapped, on=["game_id", "pid"], how="left")
    d["tds"] = d.tds.fillna(0); d["played"] = d.played.fillna(False).astype(bool)
    d["game_final"] = d.game_id.isin(set(sc.game_id))
    d["name"] = d.pid.map(players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id").display_name)
    d.to_parquet(C / "season_players.parquet")
    print(d.groupby("week").agg(n=("pid", "size"), final=("game_final", "mean"), played=("played", "mean"), td=("tds", lambda s: (s > 0).mean())))


if __name__ == "__main__":
    main()
