"""Weekly grading: the live model's record on games it forecast before kickoff, and model vs uploaded prices.

Inputs: artifact/data/predictions.json (pregame chances kept by build_data.py, frozen at kickoff),
artifact/data/touchdowns.json + played.json (outcomes), and optionally a directory of exported lines documents
(ArtifactData list collection=lines/<uid>/weeks out_dir=<dir>), which gives <dir>/lines/<uid>/weeks/w<week>.json.
Market rule: for each player-game and book, the most recent anytime-TD price OBSERVED (captured_at) in the 7 days
before kickoff. Market chance = average across books of the raw implied probability of the posted "Yes" price.
That includes the book's margin: only one side of the anytime market is posted, so a true no-vig probability cannot be
computed from this data. A second figure, "scaled_heuristic", multiplies the raw value by (observed scoring rate /
average raw implied) from EARLIER graded weeks only, and only once 100+ earlier rows exist. It is an outcome-based
calibration, not vig removal, and is labeled as such. Output: artifact/data/grades.json.
Usage: python grade.py [lines_export_dir]
"""
from __future__ import annotations

import json
import sys
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

D = Path(os.environ.get("FB_OUT", Path(__file__).resolve().parents[1] / "artifact" / "data"))  # same folder build_data.py writes
ET = ZoneInfo("America/New_York")


def ll(p, y):
    p = np.clip(np.asarray(p, float), 1e-4, 1 - 1e-4); y = np.asarray(y, float)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def observed(x):
    """captured_at as an aware UTC datetime, or None when missing or invalid."""
    try:
        t = datetime.fromisoformat(str(x.get("captured_at") or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None  # a time without a zone is ambiguous: not graded


def american(x):
    try:
        a = float(x.get("american"))
    except (TypeError, ValueError):
        return None
    return a if abs(a) >= 100 else None


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
        cand = []
        for x in prices.get(r["pid"], []):
            t = observed(x)
            a = american(x)
            if t is None or a is None:
                continue  # invalid time or price: never graded
            if t < r["kick"] and r["kick"] - t < timedelta(days=7):
                cand.append((t, a, x.get("book") or "Unknown book"))
        if not cand:
            continue
        latest = {}
        for t, a, book in cand:  # newest observation per book, compared as times (not strings)
            if book not in latest or t > latest[book][0]:
                latest[book] = (t, a)
        mrows.append({**r, "imp": float(np.mean([implied(a) for t, a in latest.values()])), "books": sorted(latest)})
    if mrows:
        weeks = sorted({r["week"] for r in mrows})
        y = [r["y"] for r in mrows]
        wk = lambda w, k: [r[k] for r in mrows if r["week"] == w]
        out["market"] = {"n": len(mrows), "weeks": weeks,
                         "log_loss_model": round(ll([r["p"] for r in mrows], y), 4),
                         "log_loss_market_raw": round(ll([r["imp"] for r in mrows], y), 4),
                         "model_better_than_raw_share_of_weeks": round(float(np.mean([ll(wk(w, "p"), wk(w, "y")) < ll(wk(w, "imp"), wk(w, "y")) for w in weeks])), 2),
                         "note": "Raw = average implied probability of the newest pre-kickoff 'Yes' price per book (margin included; a no-vig probability cannot be computed from one-sided prices)."}
        scaled = []
        for w in weeks:  # outcome-based scale from EARLIER weeks only; no default factor
            prior = [r for r in mrows if r["week"] < w]
            if len(prior) < 100:
                continue
            f = float(np.mean([r["y"] for r in prior]) / np.mean([r["imp"] for r in prior]))
            scaled += [{**r, "mkt": min(r["imp"] * f, 0.97), "f": f} for r in mrows if r["week"] == w]
        if scaled:
            ys = [r["y"] for r in scaled]
            out["market"]["scaled_heuristic"] = {"n": len(scaled), "log_loss_model": round(ll([r["p"] for r in scaled], ys), 4),
                                                 "log_loss_market_scaled": round(ll([r["mkt"] for r in scaled], ys), 4),
                                                 "note": "Heuristic: raw implied x (scoring rate / raw implied) from earlier weeks. A calibration using outcomes, not a no-vig price."}
    (D / "grades.json").write_text(json.dumps(out, separators=(",", ":")))
    return out


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1] if len(sys.argv) > 1 else None))[:600])
