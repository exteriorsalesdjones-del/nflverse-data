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


# Uncertainty range shown around each touchdown chance (see docs/METHOD.md): logit(chance) +/- z * sd_logit.
# Sized so that about 8 in 10 of the model-vs-sportsbook gaps fall inside it: on 407 graded player-games (2026 weeks
# 2-4, research/betting_record.py) 80% of gaps were within 0.46 on the log-odds scale = 1.28 x 0.36.
# range_check() re-measures this on live results at every refresh.
RANGE = {"sd_logit": 0.36, "z": 1.28, "cover": 0.80,
         "basis": "how far the model's chance typically sits from the sportsbooks' chance for the same player (407 graded player-games); about 8 in 10 fall inside"}
ABOVE_FAIR_PTS = 0.03   # the app's "Above fair" marker: model chance at least 3 points over the price's implied chance


# Historical flat-bet record (research/betting_record.py; workbook prices are private, so the result is kept here
# the same way BLEND keeps its evidence). Shown on the Research tab beside the live record.
BETTING_BACKTEST = {'weeks': [2, 3, 4],
 'games': 43,
 'rules': [{'key': 'all',
            'name': 'Every priced player',
            'what': "one unit on every player who had a price: shows what the books' margin costs",
            'n': 407,
            'wins': 113,
            'units': -19.5,
            'roi': -0.0479,
            'roi_ci90': [-0.1566, 0.0688],
            'max_drawdown_units': 52.4,
            'longest_losing_run': 20,
            'avg_implied': 0.2994,
            'avg_model': 0.2447,
            'hit_rate': 0.2776,
            'by_week': {'2': {'n': 16, 'wins': 9, 'roi': 0.3853},
                        '3': {'n': 212, 'wins': 56, 'roi': -0.0099},
                        '4': {'n': 179, 'wins': 48, 'roi': -0.1316}},
            'by_pos': {'QB': {'n': 44, 'wins': 5, 'roi': -0.5634},
                       'RB': {'n': 112, 'wins': 38, 'roi': -0.0999},
                       'TE': {'n': 77, 'wins': 19, 'roi': -0.0935},
                       'WR': {'n': 174, 'wins': 51, 'roi': 0.1361}},
            'by_price': {'+200 to +499': {'n': 202, 'wins': 48, 'roi': 0.0064},
                         '+500 and longer': {'n': 68, 'wins': 9, 'roi': -0.0956},
                         'under +200': {'n': 137, 'wins': 56, 'roi': -0.1044}},
            'price_move': None},
           {'key': 'marker',
            'name': 'Above fair marker',
            'what': "model chance at least 3 points over the price's implied chance",
            'n': 36,
            'wins': 8,
            'units': -1.4,
            'roi': -0.0389,
            'roi_ci90': [-0.4656, 0.3595],
            'max_drawdown_units': 14.5,
            'longest_losing_run': 11,
            'avg_implied': 0.2231,
            'avg_model': 0.2898,
            'hit_rate': 0.2222,
            'by_week': {'2': {'n': 1, 'wins': 1, 'roi': 2.2}, '3': {'n': 17, 'wins': 5, 'roi': 0.4294}, '4': {'n': 18, 'wins': 2, 'roi': -0.6056}},
            'by_pos': {'RB': {'n': 17, 'wins': 5, 'roi': 0.0765}, 'TE': {'n': 8, 'wins': 1, 'roi': -0.0625}, 'WR': {'n': 11, 'wins': 2, 'roi': -0.2}},
            'by_price': {'+200 to +499': {'n': 23, 'wins': 5, 'roi': -0.2043},
                         '+500 and longer': {'n': 10, 'wins': 2, 'roi': 0.35},
                         'under +200': {'n': 3, 'wins': 1, 'roi': -0.0667}},
            'price_move': None},
           {'key': 'firm',
            'name': 'Low end clears the price',
            'what': 'even the low end of the chance range beats the price',
            'n': 9,
            'wins': 0,
            'units': -9.0,
            'roi': -1.0,
            'roi_ci90': [-1.0, -1.0],
            'max_drawdown_units': 9.0,
            'longest_losing_run': 9,
            'avg_implied': 0.1855,
            'avg_model': 0.3075,
            'hit_rate': 0.0,
            'by_week': {'3': {'n': 6, 'wins': 0, 'roi': -1.0}, '4': {'n': 3, 'wins': 0, 'roi': -1.0}},
            'by_pos': {'RB': {'n': 7, 'wins': 0, 'roi': -1.0}, 'TE': {'n': 1, 'wins': 0, 'roi': -1.0}, 'WR': {'n': 1, 'wins': 0, 'roi': -1.0}},
            'by_price': {'+200 to +499': {'n': 5, 'wins': 0, 'roi': -1.0}, '+500 and longer': {'n': 4, 'wins': 0, 'roi': -1.0}},
            'price_move': None}],
 'note': 'One unit per bet at the best price seen before kickoff; ROI = profit per unit staked; the range is 90% from resampling games. Price move = '
         "change in the book's implied chance from its first to its last pregame price (positive = the price shortened after it was first seen).",
 'source': 'rolling backtest forecasts vs workbook sportsbook prices, 2026 weeks 2, 3, 4',
 'books': ['BetMGM', 'FanDuel']}


def _logit(p):
    p = min(0.999, max(0.001, float(p)))
    return float(np.log(p / (1 - p)))


def _positions() -> dict:
    try:
        import pandas as pd
        cache = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))
        return pd.read_parquet(cache / "players.parquet", columns=["gsis_id", "position"]).dropna().drop_duplicates("gsis_id").set_index("gsis_id").position.to_dict()
    except Exception:
        return {}


def range_low(p: float) -> float:
    return float(1 / (1 + np.exp(-(_logit(p) - RANGE["z"] * RANGE["sd_logit"]))))


def range_check(mrows: list) -> dict | None:
    """Live re-measurement of the range: spread of (model - book) on the log-odds scale and the share inside the range."""
    rows = [r for r in mrows if 0 < r["p"] < 1 and 0 < r["imp"] < 1]
    if len(rows) < 30:
        return None
    gap = np.array([_logit(r["p"]) - _logit(r["imp"]) for r in rows]); c = gap - gap.mean()   # centred: the books' margin shifts every gap
    return {"n": len(rows), "sd_logit": round(float(c.std()), 3), "inside_share": round(float(np.mean(np.abs(c) <= RANGE["z"] * RANGE["sd_logit"])), 3),
            "setting": {k: RANGE[k] for k in ("sd_logit", "z", "cover")}}


def betting(mrows: list) -> dict | None:
    """Flat one-unit bets at the best pregame price each player had, graded on results. Three rules:
    every priced player (what the books' margin costs), the 'Above fair' marker, and the stricter rule where even the
    low end of the chance range beats the price. A record, not a forecast: small samples swing widely."""
    rows = [r for r in mrows if r.get("best") is not None and 0 < r["p"] < 1]
    if not rows:
        return None
    pos = _positions()
    rows = sorted(rows, key=lambda r: (r["kick"], r["pid"]))
    dec = lambda a: 1 + (a / 100 if a > 0 else 100 / -a)
    band = lambda a: "under +200" if a < 200 else "+200 to +499" if a < 500 else "+500 and longer"

    def summary(sel):
        if not sel:
            return {"n": 0}
        pnl = np.array([(dec(r["best"]) - 1) if r["y"] else -1.0 for r in sel])
        cum = np.cumsum(pnl); peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
        streak = worst = 0
        for v in pnl:
            streak = streak + 1 if v < 0 else 0; worst = max(worst, streak)
        gid = np.array([r["game_id"] for r in sel]); games = sorted(set(gid)); idx = {g: np.where(gid == g)[0] for g in games}
        rng = np.random.default_rng(7); bs = []
        for _ in range(1000):
            pick = np.concatenate([idx[games[i]] for i in rng.integers(0, len(games), len(games))]); bs.append(pnl[pick].mean())
        seg = lambda key: {k: {"n": len(v), "wins": int(sum(1 for x in v if x > 0)), "roi": round(float(np.mean(v)), 4)}
                           for k, v in sorted({k: [x for kk, x in zip([key(r) for r in sel], pnl) if kk == k] for k in {key(r) for r in sel}}.items())}
        moves = [r["move_pts"] for r in sel if r.get("move_pts") is not None]
        return {"n": len(sel), "wins": int((pnl > 0).sum()), "units": round(float(pnl.sum()), 2), "roi": round(float(pnl.mean()), 4),
                "roi_ci90": [round(float(np.percentile(bs, 5)), 4), round(float(np.percentile(bs, 95)), 4)],
                "max_drawdown_units": round(float((peak - cum).max()), 2), "longest_losing_run": int(worst),
                "avg_implied": round(float(np.mean([implied(r["best"]) for r in sel])), 4), "avg_model": round(float(np.mean([r["p"] for r in sel])), 4),
                "hit_rate": round(float(np.mean([r["y"] for r in sel])), 4),
                "by_week": seg(lambda r: str(r["week"])), "by_pos": seg(lambda r: pos.get(r["pid"]) or "?"), "by_price": seg(lambda r: band(r["best"])),
                "price_move": {"n": len(moves), "avg_pts": round(float(np.mean(moves)) * 100, 2)} if moves else None}

    marker = [r for r in rows if r["p"] - implied(r["best"]) >= ABOVE_FAIR_PTS]
    firm = [r for r in rows if range_low(r["p"]) > implied(r["best"])]
    return {"weeks": sorted({r["week"] for r in rows}), "games": len({r["game_id"] for r in rows}),
            "rules": [{"key": "all", "name": "Every priced player", "what": "one unit on every player who had a price: shows what the books' margin costs", **summary(rows)},
                      {"key": "marker", "name": "Above fair marker", "what": "model chance at least 3 points over the price's implied chance", **summary(marker)},
                      {"key": "firm", "name": "Low end clears the price", "what": "even the low end of the chance range beats the price", **summary(firm)}],
            "note": "One unit per bet at the best price seen before kickoff; ROI = profit per unit staked; the range is 90% from resampling games. "
                    "Price move = change in the book's implied chance from its first to its last pregame price (positive = the price shortened after it was first seen)."}


def blend_live(mrows: list, key: str = "imp") -> dict | None:
    """Live check of the model + market blend (BLEND above) on player-games that had a price before kickoff:
    log-loss gain of the blend over the saved pregame model chance, with a 90% interval from resampling games.
    build_data.py switches the blend off when this has 300+ rows and the whole interval is below zero."""
    cfg = BLEND; pos = _positions()
    if not pos:
        return None
    w = float(cfg.get("model_weight", 0.5)); keep = set(cfg.get("positions", []))
    lg = lambda p: float(np.log(min(0.999, max(0.001, p)) / (1 - min(0.999, max(0.001, p)))))
    rows = [r for r in mrows if pos.get(r["pid"]) in keep and 0 < r["p"] < 1 and r.get(key) is not None and 0 < r[key] < 1]
    if not rows:
        return None
    one = lambda p, y: -(y * np.log(min(1 - 1e-6, max(1e-6, p))) + (1 - y) * np.log(1 - min(1 - 1e-6, max(1e-6, p))))
    gain = np.array([one(r["p"], r["y"]) - one(1 / (1 + np.exp(-(w * lg(r["p"]) + (1 - w) * lg(r[key])))), r["y"]) for r in rows])
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
        cand = []; fair = None
        for x in prices.get(r["pid"], []):
            t = observed(x)
            a = american(x)
            if t is None or a is None:
                continue  # invalid time or price: never graded
            if t < r["kick"] and r["kick"] - t < timedelta(days=7):
                cand.append((t, a, x.get("book") or "Unknown book"))
                fp = x.get("fair_p")   # exchanges' no-margin chance pulled with this price (feed rows only)
                if isinstance(fp, (int, float)) and 0 < fp < 1 and (fair is None or t > fair[0]):
                    fair = (t, float(fp))
                try:   # the feed keeps each price's first sighting on the same row
                    t0 = datetime.fromisoformat(str(x.get("open_captured_at") or "").replace("Z", "+00:00")); a0 = float(x.get("open_american"))
                    if t0.tzinfo and abs(a0) >= 100 and t0 < r["kick"] and r["kick"] - t0 < timedelta(days=7):
                        cand.append((t0, a0, x.get("book") or "Unknown book"))
                except (TypeError, ValueError):
                    pass
        if not cand:
            continue
        latest = {}; first = {}
        for t, a, book in cand:  # newest observation per book, compared as times (not strings)
            if book not in latest or t > latest[book][0]:
                latest[book] = (t, a)
            if book not in first or t < first[book][0]:
                first[book] = (t, a)
        moves = [implied(latest[b][1]) - implied(first[b][1]) for b in latest if latest[b][0] > first[b][0]]
        mrows.append({**r, "imp": float(np.mean([implied(a) for t, a in latest.values()])), "books": sorted(latest),
                      "best": max(a for t, a in latest.values()), "fair": fair[1] if fair else None,
                      "move_pts": float(np.mean(moves)) if moves else None})
    out["betting_backtest"] = BETTING_BACKTEST
    if mrows:
        bl = blend_live(mrows)
        if bl:
            out["blend_live"] = bl
        # same blend with the exchanges' no-margin chance as the market input: a side-by-side trial, not in use.
        # Two-sided exchange prices only exist from the Nov 2026 feed onward, so this fills in week by week.
        bf = blend_live([r for r in mrows if r.get("fair") is not None], "fair")
        if bf:
            same = blend_live([r for r in mrows if r.get("fair") is not None]) or {}
            out["blend_fair_live"] = {**bf, "raw_blend_same_rows_x1000": same.get("gain_x1000"),
                                      "note": "blend using the exchanges' no-margin chance minus model, log loss x1000 (positive = better than the model); raw_blend_same_rows = today's blend on the same player-games"}
        bet = betting(mrows)
        if bet:
            out["betting"] = bet
        rc = range_check(mrows)
        if rc:
            out["range_check"] = rc
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
