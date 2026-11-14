"""Run: python3 tests/test_grade.py  (no dependencies beyond numpy)."""
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "refresh"))
import grade

with tempfile.TemporaryDirectory() as t:
    D = Path(t) / "data"; D.mkdir(); L = Path(t) / "lines" / "lines" / "u1" / "weeks"; L.mkdir(parents=True)
    grade.D = D
    (D / "games.json").write_text(json.dumps([{"game_id": "g1", "week": 10, "status": "final", "kickoff_et": "2026-11-15T13:00"}]))
    (D / "touchdowns.json").write_text(json.dumps([{"game_id": "g1", "scorer_id": "a"}]))
    (D / "played.json").write_text(json.dumps({"g1": ["a", "b", "c"]}))
    (D / "predictions.json").write_text(json.dumps({"g1": {"a": {"p": 0.5, "model": "usage-v0.3c"}, "b": {"p": 0.2, "model": "usage-v0.3c"},
                                                           "c": {"p": 0.3, "model": "usage-v0.3c (backtest)"}, "z": {"p": 0.4, "model": "usage-v0.3c"}}}))
    rows = [{"gsis_id": "a", "book": "FanDuel", "american": 100, "market": "anytime_td", "captured_at": "2026-11-15T16:00:00Z"},   # before kickoff (18:00Z)
            {"gsis_id": "a", "book": "DraftKings", "american": 150, "market": "anytime_td", "captured_at": "2026-11-15T17:30:00Z"},
            {"gsis_id": "b", "book": "FanDuel", "american": 300, "market": "anytime_td", "captured_at": "2026-11-15T18:30:00Z"}]  # after kickoff: ignored
    (L / "w10.json").write_text(json.dumps({"data": {"rows": rows}}))
    out = grade.main(str(Path(t) / "lines"))
    assert out["model"]["n"] == 2, out["model"]            # live only, z did not play
    assert out["backtest"]["n"] == 1, out["backtest"]
    assert out["market"]["n"] == 1, out["market"]          # only a has a pre-kickoff price
    imp = (0.5 + 0.4) / 2 * 0.90                            # average across books x default overround factor
    import numpy as np
    assert abs(out["market"]["log_loss_market"] - round(-np.log(imp), 4)) < 1e-4, out["market"]
print("grade tests passed")
