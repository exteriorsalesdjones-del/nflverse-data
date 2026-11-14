"""Run: python3 tests/test_grade.py  (needs numpy). Worked examples are computed by hand in the comments."""
import json, math, sys, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
import grade
import make_locks


def setup(t, rows, preds):
    D = Path(t) / "data"; D.mkdir(); L = Path(t) / "lines" / "lines" / "u1" / "weeks"; L.mkdir(parents=True)
    grade.D = D
    # kickoff 1:00 PM ET on Nov 15 = 18:00Z
    (D / "games.json").write_text(json.dumps([{"game_id": "g1", "week": 10, "status": "final", "kickoff_et": "2026-11-15T13:00"}]))
    (D / "touchdowns.json").write_text(json.dumps([{"game_id": "g1", "scorer_id": "a"}]))
    (D / "played.json").write_text(json.dumps({"g1": ["a", "b", "c"]}))
    (D / "predictions.json").write_text(json.dumps({"g1": preds}))
    (L / "w10.json").write_text(json.dumps({"data": {"rows": rows}}))
    return str(Path(t) / "lines")


# 1) market chance = average RAW implied across books, newest pre-kickoff observation per book
with tempfile.TemporaryDirectory() as t:
    rows = [
        # player a: FanDuel newest pre-kick is +100 (the older +300 is superseded; mixed timestamp formats on purpose)
        {"gsis_id": "a", "book": "FanDuel", "american": 300, "market": "anytime_td", "captured_at": "2026-11-15T15:00:00.000Z"},
        {"gsis_id": "a", "book": "FanDuel", "american": 100, "market": "anytime_td", "captured_at": "2026-11-15T16:00:00+00:00"},
        {"gsis_id": "a", "book": "DraftKings", "american": 150, "market": "anytime_td", "captured_at": "2026-11-15T17:30:00Z"},
        {"gsis_id": "a", "book": "BetMGM", "american": 500, "market": "anytime_td", "captured_at": "2026-11-15T18:05:00Z"},  # after kickoff: ignored
        {"gsis_id": "a", "book": "Caesars", "american": 500, "market": "anytime_td", "captured_at": "not a time"},          # invalid: ignored, no crash
        {"gsis_id": "a", "book": "BetRivers", "american": 500, "market": "anytime_td", "captured_at": "2026-11-15T12:00:00"}, # no zone: ignored
        {"gsis_id": "a", "book": "FanDuel", "american": 900, "market": "2plus_td", "captured_at": "2026-11-15T16:00:00Z"},  # other market: ignored
        # player b: only a post-kickoff price -> not priced
        {"gsis_id": "b", "book": "FanDuel", "american": 300, "market": "anytime_td", "captured_at": "2026-11-15T18:30:00Z"},
    ]
    out = grade.main(setup(t, rows, {"a": {"p": 0.5, "model": "usage-v0.3c"}, "b": {"p": 0.2, "model": "usage-v0.3c"},
                                     "c": {"p": 0.3, "model": "usage-v0.3c (backtest)"}, "z": {"p": 0.4, "model": "usage-v0.3c"}}))
    assert out["model"]["n"] == 2 and out["backtest"]["n"] == 1, (out["model"], out["backtest"])
    m = out["market"]
    assert m["n"] == 1, m
    # by hand: +100 -> 100/200 = 0.50 ; +150 -> 100/250 = 0.40 ; average 0.45 ; a scored -> log loss = -ln(0.45) = 0.79851
    assert abs(m["log_loss_market_raw"] - 0.7985) < 1e-4, m
    # model p=0.5 for a -> -ln(0.5) = 0.69315
    assert abs(m["log_loss_model"] - 0.6931) < 1e-4, m
    assert "scaled_heuristic" not in m, m       # fewer than 100 earlier rows: no heuristic, and no default factor
    assert "log_loss_market" not in m            # the old ambiguous key is gone

# 2) negative odds: -150 -> 150/250 = 0.60 ; -120 -> 120/220 = 0.54545 ; average 0.572727 ; a scored -> -ln(0.572727) = 0.55734
with tempfile.TemporaryDirectory() as t:
    rows = [{"gsis_id": "a", "book": "FanDuel", "american": -150, "market": "anytime_td", "captured_at": "2026-11-15T17:00:00Z"},
            {"gsis_id": "a", "book": "DraftKings", "american": -120, "market": "anytime_td", "captured_at": "2026-11-15T17:00:00Z"}]
    m = grade.main(setup(t, rows, {"a": {"p": 0.6, "model": "usage-v0.3c"}}))["market"]
    assert abs(m["log_loss_market_raw"] - 0.5573) < 1e-4, m

# 3) kickoff snapshots: strict "before kickoff", using the pick's own (device-written) timestamp
with tempfile.TemporaryDirectory() as t:
    T = Path(t); (T / "picks").mkdir(); (T / "parlays").mkdir()
    gid = "2026_10_WAS_NYG"  # kickoff Thu Nov 12 8:15 PM ET = 2026-11-13T01:15:00Z (final game in games.json)
    items = {k: {"key": k, "game_id": gid, "gsis_id": k, "status": "submitted", "submitted_at": ts} for k, ts in {
        "before": "2026-11-13T01:14:59Z", "exactly": "2026-11-13T01:15:00Z", "after": "2026-11-13T01:16:00Z",
        "nozone": "2026-11-13T01:00:00", "garbage": "yesterday"}.items()}
    items["legacy"] = {"key": "legacy", "game_id": gid, "gsis_id": "legacy", "status": "submitted"}  # older record without a timestamp
    (T / "picks" / "u1.json").write_text(json.dumps({"data": {"items": items}, "updatedAt": "2026-11-13T02:00:00Z"}))
    made = make_locks.main(str(T), str(T / "out"), [])
    assert gid in made
    lock = json.loads((T / "out" / "locks" / f"{gid}.json").read_text())
    assert sorted(lock["picks"]["u1"]) == ["before"], lock["picks"]          # only the clearly on-time pick counts
    assert sorted(lock["review"]["u1"]) == ["after", "exactly", "garbage", "legacy", "nozone"], lock["review"]  # kept visible
    assert "No submission time" in lock["review"]["u1"]["legacy"] and "no time zone" in lock["review"]["u1"]["nozone"]
    assert lock["picks_doc_server_updated_at"] == {"u1": "2026-11-13T02:00:00Z"}
    # an existing snapshot is never rebuilt: passing its id leaves it out of the run entirely
    out2 = T / "out2"
    assert make_locks.main(str(T), str(out2), [gid]) == [] and not (out2 / "locks" / f"{gid}.json").exists()

print("grade and snapshot tests passed")
