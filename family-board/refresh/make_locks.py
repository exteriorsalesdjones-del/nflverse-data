"""Build kickoff snapshots ("locks") for games that have started.

Input: a directory of picks documents exported with
  ArtifactData list collection=picks out_dir=<dir>   -> <dir>/picks/<uid>.json
plus artifact/data/games.json and the ids of games that already have a lock.

Output: one JSON file per newly started game in <out>/locks/<game_id>.json, ready
for ArtifactData set collection=locks doc_id=<game_id> file_path=<file>.
Only submitted picks are frozen. Existing locks are never rewritten, so a rerun
cannot move a snapshot after the fact.

Usage: python make_locks.py <picks_dir> <out_dir> [existing_lock_id ...]
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
GAMES = Path(__file__).resolve().parents[1] / "artifact" / "data" / "games.json"


def kickoff_utc(et: str) -> datetime:
    return datetime.fromisoformat(et).replace(tzinfo=ET).astimezone(timezone.utc)


def main(picks_dir: str, out_dir: str, existing: list[str]) -> list[str]:
    now = datetime.now(timezone.utc)
    games = json.loads(GAMES.read_text())
    started = [g for g in games if g["status"] != "upcoming" or kickoff_utc(g["kickoff_et"]) <= now]
    picks = {}
    for f in Path(picks_dir, "picks").glob("*.json"):
        doc = json.loads(f.read_text())
        picks[f.stem] = (doc.get("data") or doc).get("items", {})
    # parlays: exported the same way (ArtifactData list collection=parlays out_dir=<dir>) -> <dir>/parlays/<uid>.json
    gmap = {g["game_id"]: g for g in games}
    parlays = {}
    for f in Path(picks_dir, "parlays").glob("*.json"):
        doc = json.loads(f.read_text())
        parlays[f.stem] = (doc.get("data") or doc).get("items", {})
    def first_game(par):
        gs = [gmap[l["game_id"]] for l in par.get("legs", []) if l.get("game_id") in gmap]
        return min(gs, key=lambda g: kickoff_utc(g["kickoff_et"]))["game_id"] if gs else None
    wanted = {p["game_id"] for items in picks.values() for p in items.values() if p.get("status") == "submitted"}
    wanted |= {first_game(par) for items in parlays.values() for par in items.values()} - {None}
    made = []
    out = Path(out_dir, "locks")
    out.mkdir(parents=True, exist_ok=True)
    for g in started:
        gid = g["game_id"]
        if gid in existing or gid not in wanted:
            continue
        frozen = {}
        for uid, items in picks.items():
            kick = kickoff_utc(g["kickoff_et"])
            def before_kick(p):  # a pick timestamped after kickoff (device clock off) is left out and settles as "needs review"
                t = p.get("submitted_at") or p.get("saved_at")
                try:
                    return t is None or datetime.fromisoformat(str(t).replace("Z", "+00:00")) <= kick
                except ValueError:
                    return True
            mine = {k: {"gsis_id": p["gsis_id"], "status": p["status"], "price": p.get("price")}
                    for k, p in items.items() if p.get("game_id") == gid and p.get("status") == "submitted" and before_kick(p)}
            if mine:
                frozen[uid] = mine
        fpar = {}
        for uid, items in parlays.items():
            for pid, par in items.items():
                if first_game(par) == gid:
                    fpar.setdefault(uid, {})[pid] = [l["gsis_id"] for l in par.get("legs", [])]
        (out / f"{gid}.json").write_text(json.dumps({"frozen_at": now.isoformat(timespec="seconds"), "by": "scheduled refresh", "picks": frozen, "parlays": fpar}))
        made.append(gid)
    return made


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], sys.argv[2], sys.argv[3:])))
