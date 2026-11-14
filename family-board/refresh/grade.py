"""Weekly grading: the live model's record on games it forecast before kickoff, and model vs uploaded prices.

Inputs: artifact/data/predictions.json (pregame chances kept by build_data.py, frozen at kickoff),
artifact/data/touchdowns.json + played.json (outcomes), and optionally a directory of exported lines documents
(ArtifactData list collection=lines/<uid>/weeks out_dir=<dir>), which gives <dir>/lines/<uid>/weeks/w<week>.json.
Market rule: for each player-game and book, the latest anytime-TD price captured before kickoff; the market chance is
the average implied probability across books, scaled by an overround factor fitted on earlier graded weeks only
(0.90 before any history). Output: artifact/data/grades.json.
Usage: python grade.py [lines_export_dir]
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

D = Path(__file__).resolve().parents[1] / "artifact" / "data"
ET = ZoneInfo("America/New_York")


def ll(p, y):
    p = np.clip(np.asarray(p, float), 1e-4, 1 - 1e-4); y = np.asarray(y, float)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def implied(a):
    a = float(a)
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)


def record(rows: list) -> dict:
    if not rows:
        return {}
    y = [r["y"] for r in rows]; p = [r["p"] for r in rows]; base = float(np.mean(y)); weeks = sorted({r["week"] for r in rows})
    wk = lambda w: [r for r in rows if r["week"] == w]
    return {"n": len(rows), "weeks": weeks, "log_loss": round(ll(p, y), 4), "log_loss_constant": round(ll([base] * len(y), y), 4),
            "brier": round(float(np.mean((np.array(p) - np.array(y)) ** 2)), 4),
            "by_week": [{"week": w, "n": len(wk(w)), "log_loss": round(ll([r["p"] for r in wk(w)], [r["y"] for r in wk(w)]), 4), "scored": sum(r["y"] for r in wk(w))} for w in weeks],
            "calibration": [{"bin": f"{lo:.0%}-{hi:.0%}", "n": len(b), "pred": round(float(np.mean([r["p"] for r in b])), 3), "actual": round(float(np.mean([r["y"] for r in b])), 3)}
                            for lo, hi in ((0, .1), (.1, .2), (.2, .3), (.3, .45), (.45, 1)) for b in [[r for r in rows if lo <= r["p"] < hi]] if b]}


def main(lines_dir: str | None = None) -> dict:
    preds = json.loads((D / "predictions.json").read_text()) if (D / "predictions.json").exists() else {}
    games = {g["game_id"]: g for g in json.loads((D / "games.json").read_text())}
    tds = json.loads((D / "touchdowns.json").read_text())
    played = json.loads((D / "played.json").read_text()) if (D / "played.json").exists() else {}
    scorers = {}
    for t in tds:
        scorers.setdefault(t["game_id"], set()).add(t.get("scorer_id"))
    rows = []
    for gid, ps in preds.items():
        g = games.get(gid)
        if not g or g.get("status") != "final" or gid not in played:
            continue
        on = set(played[gid])
        for pid, x in ps.items():
            if pid in on:
                rows.append({"game_id": gid, "week": g["week"], "pid": pid, "p": x["p"], "model": x.get("model"), "y": int(pid in scorers.get(gid, set())),
                             "kick": datetime.fromisoformat(g["kickoff_et"]).replace(tzinfo=ET)})
    out = {"graded_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "model": {}, "backtest": {}, "market": {"n": 0},
           "note": "Live = chances published before kickoff (top candidates per team). Backtest = weeks 1-9 rolling forecasts for every player who took a snap. Graded separately because the populations differ."}
    out["backtest"] = record([r for r in rows if "backtest" in str(r.get("model"))])
    out["model"] = record([r for r in rows if "backtest" not in str(r.get("model"))])
    rows = [r for r in rows if "backtest" not in str(r.get("model"))]  # market comparison uses live pregame chances only
    # market
    prices = {}
    if lines_dir:
        for f in Path(lines_dir).glob("lines/*/weeks/*.json"):
            doc = json.loads(f.read_text()); doc = doc.get("data") or doc
            for r in doc.get("rows", []):
                if (r.get("market") or "anytime_td") != "anytime_td" or not r.get("gsis_id") or not r.get("captured_at"):
                    continue
                prices.setdefault(r["gsis_id"], []).append(r)
    mrows = []
    for r in rows:
        ts = lambda x: datetime.fromisoformat(x["captured_at"].replace("Z", "+00:00"))
        cand = [x for x in prices.get(r["pid"], []) if ts(x) < r["kick"] and (r["kick"] - ts(x)).days < 7]  # last week before kickoff
        if not cand:
            continue
        latest = {}
        for x in cand:
            if x["book"] not in latest or x["captured_at"] > latest[x["book"]]["captured_at"]:
                latest[x["book"]] = x
        mrows.append({**r, "imp": float(np.mean([implied(x["american"]) for x in latest.values()])), "books": sorted(latest)})
    if mrows:
        weeks = sorted({r["week"] for r in mrows}); scored = []
        for w in weeks:  # overround factor from earlier graded weeks only
            prior = [r for r in mrows if r["week"] < w]
            f = (np.mean([r["y"] for r in prior]) / np.mean([r["imp"] for r in prior])) if len(prior) >= 100 else 0.90
            for r in mrows:
                if r["week"] == w:
                    scored.append({**r, "mkt": min(r["imp"] * f, 0.97)})
        y = [r["y"] for r in scored]
        out["market"] = {"n": len(scored), "weeks": weeks, "log_loss_model": round(ll([r["p"] for r in scored], y), 4),
                         "log_loss_market": round(ll([r["mkt"] for r in scored], y), 4),
                         "model_better_share_of_weeks": round(float(np.mean([ll([r["p"] for r in scored if r["week"] == w], [r["y"] for r in scored if r["week"] == w]) <
                                                                             ll([r["mkt"] for r in scored if r["week"] == w], [r["y"] for r in scored if r["week"] == w]) for w in weeks])), 2),
                         "note": "Latest anytime price per book captured before kickoff (uploads), averaged; overround removed with a factor from earlier weeks."}
    (D / "grades.json").write_text(json.dumps(out, separators=(",", ":")))
    return out


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1] if len(sys.argv) > 1 else None))[:600])
