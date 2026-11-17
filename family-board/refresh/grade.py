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


# Model + market blend for the headline chance (see docs/IMPROVEMENTS_NOV16.md). Kept here, in a file every refresh
# already downloads, so build_data.py and this live check always agree on it.
BLEND = {
    "enabled": True,
    "model_weight": 0.5,
    "positions": [
        "RB",
        "WR",
        "TE"
    ],
    "rule": "chance = equal parts, on the log-odds scale, of the model's chance and the average raw implied chance of the available books (margin included); fresh prices only before kickoff",
    "evidence": {
        "test": "2026 Weeks 2-4, FanDuel (and 12 BetMGM) prices captured before kickoff",
        "n": 407,
        "games": 43,
        "log_loss_model": 0.5749,
        "log_loss_blend": 0.5629,
        "gain_x1000": 11.95,
        "ci90_x1000": [
            5.04,
            19.45
        ],
        "by_pos_x1000": {
            "QB": 0.0,
            "RB": 15.58,
            "TE": 3.57,
            "WR": 16.35
        },
        "by_week_x1000": {
            "2": 37.64,
            "3": 14.91,
            "4": 6.16
        },
        "qb_note": "QBs keep the model's chance: on 44 QB rows the blend scored worse (-13.2), so they are excluded; that choice was made after seeing the test",
        "script": "research/improvements.py"
    },
    "auto_off": "turned off by the refresh when the live check (grades.json blend_live) has 300+ player-games and the upper end of its 90% interval is below zero"
}


def blend_live(mrows: list) -> dict | None:
    """Live check of the model + market blend (BLEND above) on player-games that had a price before kickoff:
    log-loss gain of the blend over the saved pregame model chance, with a 90% interval from resampling games.
    build_data.py switches the blend off when this has 300+ rows and the whole interval is below zero."""
    try:
        cfg = BLEND
        import pandas as pd
        cache = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))
        pos = pd.read_parquet(cache / "players.parquet", columns=["gsis_id", "position"]).dropna().drop_duplicates("gsis_id").set_index("gsis_id").position.to_dict()
    except Exception:
        return None
    w = float(cfg.get("model_weight", 0.5)); keep = set(cfg.get("positions", []))
    lg = lambda p: float(np.log(min(0.999, max(0.001, p)) / (1 - min(0.999, max(0.001, p)))))
    rows = [r for r in mrows if pos.get(r["pid"]) in keep and 0 < r["p"] < 1 and 0 < r["imp"] < 1]
    if not rows:
        return None
    one = lambda p, y: -(y * np.log(min(1 - 1e-6, max(1e-6, p))) + (1 - y) * np.log(1 - min(1 - 1e-6, max(1e-6, p))))
    gain = np.array([one(r["p"], r["y"]) - one(1 / (1 + np.exp(-(w * lg(r["p"]) + (1 - w) * lg(r["imp"])))), r["y"]) for r in rows])
    gid = np.array([r["game_id"] for r in rows]); games = sorted(set(gid)); idx = {g: np.where(gid == g)[0] for g in games}
    rng = np.random.default_rng(11); bs = []
    for _ in range(1000):
        pick = np.concatenate([idx[games[i]] for i in rng.integers(0, len(games), len(games))]); bs.append(gain[pick].mean())
    by = {}
    for r, g in zip(rows, gain):
        by.setdefault(pos[r["pid"]], []).append(g)
    return {"n": len(rows), "games": len(games), "weeks": sorted({r["week"] for r in rows}), "gain_x1000": round(float(gain.mean()) * 1000, 2),
            "ci90_x1000": [round(float(np.percentile(bs, 5)) * 1000, 2), round(float(np.percentile(bs, 95)) * 1000, 2)],
            "by_pos_x1000": {k: round(float(np.mean(v)) * 1000, 2) for k, v in sorted(by.items())},
            "note": "blend minus model, log loss per player-game x1000 (positive = blend better); positions " + "/".join(sorted(keep))}


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
    # the sportsbook feed's prices (odds_feed.json: FanDuel / DraftKings, timed at each pull) grade the same way
    try:
        feed = []
        for name in ("odds_feed.json", "odds_feed_history.json"):
            if (D / name).exists():
                feed += json.loads((D / name).read_text()).get("rows", [])
        for r in feed:
            if (r.get("market") or "anytime_td") == "anytime_td" and r.get("gsis_id") and r.get("captured_at"):
                prices.setdefault(r["gsis_id"], []).append(r)
    except (OSError, ValueError):
        pass
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
        bl = blend_live(mrows)
        if bl:
            out["blend_live"] = bl
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
