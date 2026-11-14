"""Build the data files behind the Anytime TD Family Board artifact.

Inputs are nflverse release files (downloaded by fetch_sources.py into a
cache directory). Outputs are JSON files in OUT_DIR that the artifact page
loads with relative fetches:

  meta.json        refresh time, sources, coverage, season state
  games.json       every 2026 regular-season game with status and ET kickoff
  touchdowns.json  every touchdown in final games, with attribution records
  weekly.json      per-week scoring completeness and attribution coverage
  slate.json       upcoming games and baseline anytime-TD candidates
  validation.json  walk-forward test of the baseline model

Rules that matter (see docs/METHOD.md):
  * A touchdown is a play with touchdown == 1 that is not a two-point try.
    Plays wiped out by penalty never carry touchdown == 1 in nflverse.
  * A game counts as reconciled only when each team's touchdowns, kicks,
    conversions and safeties add up to the official final score.
  * Defender responsibility is attributed only from a charting source. PFR's
    per-game "receiving TD allowed" charting identifies an individual on a
    play only when one charted defender accounts for every receiving TD the
    team allowed in that game. Everything else stays Unknown, with the
    charted candidates and the missing evidence recorded.

The script is deterministic and safe to rerun: every record is keyed by
game_id and play_id, and outputs are written to temp files then renamed.
"""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import matchup as MU

SEASON = 2026
MODEL_VERSION = "baseline-usage-v0.1"
CACHE = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))
OUT = Path(os.environ.get("FB_OUT", Path(__file__).resolve().parents[1] / "artifact" / "data"))

PBP_SOURCE = "nflverse play-by-play (NFL Game Statistics & Information System feed)"
PFR_SOURCE = "Pro Football Reference defensive charting via nflverse pfr_advstats"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def clean(v):
    """JSON-safe scalar."""
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if v is pd.NA:
        return None
    return v


def nz(v):
    v = clean(v)
    return v if v not in ("", "NA") else None


def write_json(name: str, obj) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / (name + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), default=clean))
    tmp.replace(OUT / name)


# ---------------------------------------------------------------- load

def load():
    pbp = pd.read_parquet(CACHE / f"play_by_play_{SEASON}.parquet")
    games = pd.read_csv(CACHE / "games.csv")
    games = games[(games.season == SEASON) & (games.game_type == "REG")].copy()
    pfr = pd.read_parquet(CACHE / f"advstats_week_def_{SEASON}.parquet")
    players = pd.read_parquet(CACHE / "players.parquet")
    injuries = pd.read_parquet(CACHE / f"injuries_{SEASON}.parquet")
    snaps = pd.read_parquet(CACHE / f"snap_counts_{SEASON}.parquet")
    return pbp, games, pfr, players, injuries, snaps


# ---------------------------------------------------------------- games

def game_status(row, pbp_games: set) -> str:
    if pd.notna(row.result):
        return "final"
    if row.game_id in pbp_games:
        return "in_progress"
    if isinstance(row.get("gameday"), str) and row.gameday < datetime.now().strftime("%Y-%m-%d"):
        return "postponed_or_pending"  # date passed, no result: shown as not final
    return "upcoming"


def build_games(games: pd.DataFrame, pbp: pd.DataFrame) -> list[dict]:
    pbp_games = set(pbp.game_id.unique())
    out = []
    for r in games.sort_values(["week", "gameday", "gametime", "game_id"]).itertuples():
        d = r._asdict()
        out.append({
            "game_id": r.game_id, "week": int(r.week),
            "away": r.away_team, "home": r.home_team,
            "kickoff_et": f"{r.gameday}T{r.gametime}" if isinstance(r.gametime, str) else r.gameday,
            "weekday": nz(d.get("weekday")),
            "status": game_status(pd.Series(d), pbp_games),
            "away_score": nz(r.away_score), "home_score": nz(r.home_score),
            "spread_line": nz(d.get("spread_line")), "total_line": nz(d.get("total_line")),
            "roof": nz(d.get("roof")), "stadium": nz(d.get("stadium")),
        })
    return out


# ---------------------------------------------------------------- touchdowns

def td_type(p) -> str:
    if p.pass_touchdown == 1:
        return "passing"
    if p.rush_touchdown == 1:
        return "rushing"
    if p.play_type == "punt" and p.punt_blocked == 1:
        return "blocked_punt_return"
    if p.play_type in ("field_goal", "extra_point"):
        return "blocked_kick_return"
    if p.return_touchdown == 1:
        if p.interception == 1:
            return "interception_return"
        if p.play_type == "kickoff":
            return "kickoff_return"
        if p.play_type == "punt":
            return "blocked_punt_return" if p.punt_blocked == 1 else "punt_return"
        if p.play_type in ("field_goal", "extra_point"):
            return "blocked_kick_return"
        if p.fumble == 1:
            return "fumble_return"
        return "other_return"
    if p.fumble == 1:
        return "fumble_recovery"
    return "other"


def td_unit(p, kind: str) -> str:
    if p.play_type in ("kickoff", "punt", "field_goal", "extra_point") or kind.endswith("kick_return") or kind in ("kickoff_return", "punt_return", "blocked_punt_return"):
        return "special_teams"
    return "offense" if p.td_team == p.posteam else "defense"


def reconcile(pbp: pd.DataFrame, td: pd.DataFrame, games: pd.DataFrame) -> dict:
    """Rebuild each team's points from the play log and compare with the official final."""
    pts: dict[tuple, int] = {}

    def add(gid, team, v):
        pts[(gid, team)] = pts.get((gid, team), 0) + v

    for r in td.itertuples():
        add(r.game_id, r.td_team, 6)
    for r in pbp[pbp.extra_point_result == "good"].itertuples():
        add(r.game_id, r.posteam, 1)
    for r in pbp[pbp.field_goal_result == "made"].itertuples():
        add(r.game_id, r.posteam, 3)
    for r in pbp[(pbp.two_point_attempt == 1) & (pbp.two_point_conv_result == "success")].itertuples():
        add(r.game_id, r.posteam, 2)
    for r in pbp[pbp.safety == 1].itertuples():
        add(r.game_id, r.defteam, 2)
    for r in pbp[(pbp.defensive_two_point_conv == 1) | (pbp.defensive_extra_point_conv == 1)].itertuples():
        add(r.game_id, r.defteam, 2)

    out = {}
    for g in games[games.result.notna()].itertuples():
        h, a = pts.get((g.game_id, g.home_team), 0), pts.get((g.game_id, g.away_team), 0)
        tds = td[td.game_id == g.game_id]
        out[g.game_id] = {
            "reconciled": bool(h == g.home_score and a == g.away_score),
            "official": [int(g.away_score), int(g.home_score)],
            "rebuilt": [a, h],
            "td_count": int(len(tds)),
            "td_by_team": {g.away_team: int((tds.td_team == g.away_team).sum()), g.home_team: int((tds.td_team == g.home_team).sum())},
        }
    return out


def pfr_attribution(td: pd.DataFrame, pfr: pd.DataFrame, players: pd.DataFrame) -> dict:
    """Map PFR per-game receiving-TD-allowed charting onto individual plays where it is unambiguous."""
    pmap = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id")
    charted = pfr[pfr.def_receiving_td_allowed.fillna(0) > 0]
    pfr_games = set(pfr.game_id)
    result = {}
    passing = td[td.pass_touchdown == 1]
    for (gid, dteam), plays in passing.groupby(["game_id", "defteam"]):
        n = len(plays)
        rows = charted[(charted.game_id == gid) & (charted.team == dteam)]
        cands = []
        for r in rows.itertuples():
            info = pmap.loc[r.pfr_player_id] if r.pfr_player_id in pmap.index else None
            cands.append({
                "name": r.pfr_player_name,
                "pfr_id": r.pfr_player_id,
                "gsis_id": nz(info["gsis_id"]) if info is not None else None,
                "position": nz(info["position"]) if info is not None else None,
                "team": dteam,
                "td_allowed_in_game": int(r.def_receiving_td_allowed),
                "targets_in_game": nz(r.def_targets),
            })
        total = sum(c["td_allowed_in_game"] for c in cands)
        for p in plays.itertuples():
            key = f"{p.game_id}:{int(p.play_id)}"
            if gid not in pfr_games:
                result[key] = {"status": "unknown", "defenders": [], "candidates": [],
                               "missing": "PFR has not charted this game yet; no film or charting reviewed."}
            elif len(cands) == 1 and total == n:
                c = cands[0]
                result[key] = {
                    "status": "probable_individual",
                    "defenders": [{
                        **{k: c[k] for k in ("name", "gsis_id", "pfr_id", "position", "team")},
                        "role": "primary_coverage",
                        "observed": f"PFR charted {c['name']} as the defender on {c['td_allowed_in_game']} of {n} receiving TD(s) {dteam} allowed in this game.",
                        "inferred": "Primary coverage defender on this touchdown, because PFR's game charting accounts for every receiving TD the team allowed. Coverage type (man, zone handoff, safety help) is not charted.",
                        "evidence": [{"source": PFR_SOURCE, "detail": f"game {gid}: def_receiving_td_allowed={c['td_allowed_in_game']}, targets={c['targets_in_game']}"}],
                    }],
                    "candidates": [],
                    "missing": "Film review to confirm the assignment and any safety help or post-catch missed tackle.",
                }
            else:
                why = ("PFR charted no defender for this team's receiving TDs in this game." if not cands else
                       f"PFR charted {total} receiving TD(s) across {len(cands)} defenders for {n} receiving TD play(s); charting is per game, so it cannot say which defender was on this play."
                       if total == n else
                       f"PFR charted {total} receiving TD(s) against {n} play(s) in the play log; counts disagree, so no defender is attributed.")
                result[key] = {"status": "unknown", "defenders": [], "candidates": cands,
                               "missing": why + " Needs film or play-level charting."}
    return result


def missing_note(kind: str) -> str:
    return {
        "rushing": "No public play-level charting of missed tackles, run fits or edge responsibility. Needs film review.",
        "interception_return": "Defensive score: the breakdown is on the offense or return coverage. No public charting of who missed the tackle on the return.",
        "fumble_return": "Defensive score: no public charting of the return or the strip.",
        "fumble_recovery": "Recovery in the end zone: no public charting of the breakdown.",
        "kickoff_return": "Special teams: no public charting of lane assignments or missed tackles on coverage.",
        "punt_return": "Special teams: no public charting of lane assignments or missed tackles on coverage.",
        "blocked_punt_return": "Special teams: no public charting of the protection breakdown.",
        "blocked_kick_return": "Special teams: no public charting of the protection breakdown.",
    }.get(kind, "No public charting covers this play type. Needs film review.")


def build_touchdowns(pbp, games, pfr, players):
    td = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1)].copy()
    final_ids = set(games[games.result.notna()].game_id)
    td = td[td.game_id.isin(final_ids)]
    recon = reconcile(pbp, td, games)
    attrib = pfr_attribution(td, pfr, players)
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id")["position"]
    verified_at = now_iso()
    rows = []
    for p in td.sort_values(["week", "game_id", "play_id"]).itertuples():
        kind = td_type(p)
        unit = td_unit(p, kind)
        key = f"{p.game_id}:{int(p.play_id)}"
        opp = p.defteam if p.td_team == p.posteam else p.posteam
        a = attrib.get(key) or {"status": "unknown", "defenders": [], "candidates": [], "missing": missing_note(kind)}
        rows.append({
            "key": key, "game_id": p.game_id, "play_id": int(p.play_id), "week": int(p.week),
            "qtr": int(p.qtr), "clock": nz(p.time), "yards": nz(p.yards_gained),
            "yardline_100": nz(p.yardline_100),
            "team": p.td_team, "opp": opp, "type": kind, "unit": unit,
            "scorer": nz(p.td_player_name), "scorer_id": nz(p.td_player_id),
            "scorer_pos": nz(pos.get(p.td_player_id)) if isinstance(p.td_player_id, str) else None,
            "passer": nz(p.passer_player_name) if kind == "passing" else None,
            "desc": nz(p.desc),
            "source": PBP_SOURCE,
            "film_ref": None,
            "reconciled": recon.get(p.game_id, {}).get("reconciled", False),
            "verified_at": verified_at,
            "attribution": a,
        })
    return rows, recon


# ---------------------------------------------------------------- weekly coverage

STATUSES = ["verified_individual", "probable_individual", "shared", "team_unit", "unknown"]


def build_weekly(games_out, tds, recon):
    weeks = sorted({g["week"] for g in games_out})
    out = []
    for w in weeks:
        g = [x for x in games_out if x["week"] == w]
        finals = [x for x in g if x["status"] == "final"]
        t = [x for x in tds if x["week"] == w]
        counts = {s: sum(1 for x in t if x["attribution"]["status"] == s) for s in STATUSES}
        out.append({
            "week": w, "games": len(g), "final": len(finals),
            "reconciled": sum(1 for x in finals if recon.get(x["game_id"], {}).get("reconciled")),
            "td_plays": len(t), "attribution": counts,
            "applicable": sum(1 for x in t if x["unit"] == "offense"),
        })
    return out


# ---------------------------------------------------------------- baseline model

def opportunity_table(pbp: pd.DataFrame) -> pd.DataFrame:
    """One row per offensive opportunity (carry or target) with the player who got it."""
    p = pbp[(pbp.play_type.isin(["run", "pass"])) & (pbp.two_point_attempt != 1)]
    carries = p[p.rusher_player_id.notna() & (p.play_type == "run") | (p.qb_scramble == 1) & p.rusher_player_id.notna()]
    carries = carries.assign(pid=carries.rusher_player_id, name=carries.rusher_player_name, kind="carry",
                             td=(carries.rush_touchdown == 1).astype(int))
    targets = p[p.receiver_player_id.notna()]
    targets = targets.assign(pid=targets.receiver_player_id, name=targets.receiver_player_name, kind="target",
                             td=(targets.pass_touchdown == 1).astype(int))
    o = pd.concat([carries, targets])[["game_id", "week", "posteam", "pid", "name", "kind", "td", "yardline_100"]]
    o["zone"] = np.where(o.yardline_100 <= 10, "i10", np.where(o.yardline_100 <= 20, "rz", "field"))
    o["cell"] = o.kind + "_" + o.zone
    return o


def fit_rates(o: pd.DataFrame) -> dict:
    g = o.groupby("cell").td.agg(["sum", "size"])
    return {c: (r["sum"] + 0.5) / (r["size"] + 10) for c, r in g.iterrows()}


def implied_points(g) -> tuple[float, float] | None:
    if pd.isna(g.spread_line) or pd.isna(g.total_line):
        return None
    home = g.total_line / 2 + g.spread_line / 2
    return g.total_line - home, home  # away, home


def player_lambdas(o_hist, rates, team, team_off_td, recent_games=None):
    """Expected TDs for each player on `team`: team TD expectation split by xTD share."""
    t = o_hist[o_hist.posteam == team].copy()
    if t.empty:
        return pd.DataFrame()
    t["xtd"] = t.cell.map(rates).fillna(0)
    gids = sorted(t.game_id.unique())
    if recent_games:
        gids = gids[-recent_games:]
        t = t[t.game_id.isin(gids)]
    t["xtd_rush"] = np.where(t.kind == "carry", t.xtd, 0.0)
    t["xtd_rec"] = np.where(t.kind == "target", t.xtd, 0.0)
    per = t.groupby(["pid"]).agg(name=("name", "last"), xtd=("xtd", "sum"), xtd_rush=("xtd_rush", "sum"),
                                 xtd_rec=("xtd_rec", "sum"), opp=("cell", "size"),
                                 i10=("zone", lambda z: int((z == "i10").sum())), games=("game_id", "nunique"))
    tot = per.xtd.sum()
    if tot <= 0:
        return pd.DataFrame()
    per["share"] = per.xtd / tot
    per["lam"] = team_off_td * per.share
    per["lam_rush"] = team_off_td * per.xtd_rush / tot
    per["lam_rec"] = team_off_td * per.xtd_rec / tot
    per["p"] = 1 - np.exp(-per["lam"])
    per["team_games"] = len(gids)
    return per.reset_index()


def off_td_per_point(pbp, games) -> float:
    fin = games[games.result.notna()]
    pts = fin.home_score.sum() + fin.away_score.sum()
    off = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1) & ((pbp.pass_touchdown == 1) | (pbp.rush_touchdown == 1))]
    off = off[off.game_id.isin(fin.game_id)]
    return len(off) / pts if pts else 0.11


def _metrics(p, y):
    eps = 1e-6
    p = np.clip(np.asarray(p, float), eps, 1 - eps); y = np.asarray(y, float)
    return float(((p - y) ** 2).mean()), float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


VARIANTS = {"baseline": None, "matchup_pos": False, "matchup_pos_cov": True}


def validate(pbp, games, snaps, players, pfr) -> dict:
    """Walk-forward: for week w use only weeks < w. Score players who took an offensive snap.
    Scores the baseline and each matchup variant on the same player-games."""
    o = opportunity_table(pbp)
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id")["position"]
    pmap = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id")["gsis_id"]
    snaps = snaps.assign(gsis=snaps.pfr_player_id.map(pmap))
    played = snaps[snaps.offense_snaps.fillna(0) > 0].groupby("game_id").gsis.apply(set).to_dict()
    td = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1)]
    scorers = td.groupby("game_id").td_player_id.apply(set).to_dict()
    rows = []
    for w in range(4, int(games[games.result.notna()].week.max()) + 1):
        hist = o[o.week < w]
        rates = fit_rates(hist)
        hist_pbp = pbp[pbp.week < w]
        ratio = off_td_per_point(hist_pbp, games[games.week < w])
        pf = MU.pos_factors(hist_pbp, pos)
        cf = MU.cov_factors(pfr[pfr.week < w])
        for g in games[(games.week == w) & games.result.notna()].itertuples():
            ip = implied_points(g)
            if ip is None:
                continue
            for team, opp, pts in ((g.away_team, g.home_team, ip[0]), (g.home_team, g.away_team, ip[1])):
                lam = player_lambdas(hist, rates, team, pts * ratio)
                if lam.empty:
                    continue
                a1 = MU.adjust(lam, opp, pos, pf, cf, False, pts * ratio)
                a2 = MU.adjust(lam, opp, pos, pf, cf, True, pts * ratio)
                on = played.get(g.game_id, set())
                for r, p1, p2 in zip(lam.itertuples(), a1.p_adj, a2.p_adj):
                    if r.pid not in on:
                        continue  # inactive or no offensive snap: a pick would be void
                    rows.append((w, g.game_id, r.p, p1, p2, int(r.pid in scorers.get(g.game_id, set()))))
    if not rows:
        return {"n": 0}
    v = pd.DataFrame(rows, columns=["week", "game_id", "baseline", "matchup_pos", "matchup_pos_cov", "y"])
    base = v.y.mean()
    brier0, ll0 = _metrics(np.full(len(v), base), v.y)
    variants = {}
    rng = np.random.default_rng(7)
    gids = v.game_id.unique()
    for name in VARIANTS:
        b, l = _metrics(v[name], v.y)
        bins = pd.cut(v[name], [0, .05, .1, .2, .3, .4, .5, 1], include_lowest=True)
        cal = [{"bin": str(k), "n": int(len(x)), "pred": float(x[name].mean()), "actual": float(x.y.mean())}
               for k, x in v.groupby(bins, observed=True)]
        entry = {"brier": b, "log_loss": l, "calibration": cal}
        if name != "baseline":
            # paired bootstrap over games: log-loss improvement vs baseline (positive = better)
            per_game = v.assign(d=[_metrics([pb], [y])[1] - _metrics([pm], [y])[1] for pb, pm, y in zip(v.baseline, v[name], v.y)]).groupby("game_id").d.sum()
            boots = [per_game.sample(len(per_game), replace=True, random_state=int(rng.integers(1e9))).sum() / len(v) for _ in range(400)]
            entry["ll_gain"] = float(per_game.sum() / len(v))
            entry["ll_gain_ci90"] = [float(np.percentile(boots, 5)), float(np.percentile(boots, 95))]
        variants[name] = entry
    best = min(variants, key=lambda k: variants[k]["log_loss"])
    adopt = best != "baseline" and variants[best]["ll_gain_ci90"][0] > 0
    chosen = best if adopt else "baseline"
    c = variants[chosen]
    return {"model_version": MODEL_VERSION, "weeks": [4, int(v.week.max())], "n": int(len(v)),
            "base_rate": float(base), "brier": c["brier"], "brier_constant": brier0,
            "log_loss": c["log_loss"], "log_loss_constant": ll0, "calibration": c["calibration"],
            "variants": variants, "chosen": chosen, "best_by_log_loss": best,
            "status": "research",
            "note": "Each week is predicted from earlier weeks only, using closing spread and total and matchup factors built from earlier games. Scored on players who took an offensive snap (an inactive player's pick is void). A matchup variant is adopted only when the 90% bootstrap interval of its log-loss gain over the baseline is above zero. No sportsbook prices are included, so no closing-line value yet."}


def build_slate(pbp, games, injuries, players, games_out, pfr, validation):
    up = [g for g in games_out if g["status"] in ("upcoming", "in_progress", "postponed_or_pending")]
    if not up:
        return {"week": None, "games": []}
    week = min(g["week"] for g in up)
    o = opportunity_table(pbp)
    rates = fit_rates(o)
    ratio = off_td_per_point(pbp, games)
    inj = injuries[injuries.week == injuries[injuries.week <= week].week.max()] if len(injuries) else injuries
    inj_map = {r.gsis_id: r for r in inj.itertuples()} if len(inj) else {}
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id")["position"]
    full = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id")["display_name"]
    # team-level context from the play log: TDs allowed by position group
    td = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1) & ((pbp.pass_touchdown == 1) | (pbp.rush_touchdown == 1))]
    td = td.assign(pos=td.td_player_id.map(pos))
    allowed = td.groupby(["defteam", "pos"]).size().unstack(fill_value=0)
    def_games = pbp.groupby("defteam").game_id.nunique()
    pf = MU.pos_factors(pbp, pos)
    cf = MU.cov_factors(pfr)
    chosen = validation.get("chosen", "baseline")
    out_games = []
    gdf = games.set_index("game_id")
    for g in [x for x in games_out if x["week"] == week]:
        row = gdf.loc[g["game_id"]]
        ip = implied_points(row)
        teams = []
        for side, team, opp in (("away", g["away"], g["home"]), ("home", g["home"], g["away"])):
            entry = {"team": team, "opp": opp, "implied_points": None, "expected_off_tds": None, "candidates": [],
                     "opp_td_allowed_by_pos": {k: int(v) for k, v in allowed.loc[opp].items()} if opp in allowed.index else {},
                     "opp_games": int(def_games.get(opp, 0))}
            if ip is not None:
                pts = ip[0] if side == "away" else ip[1]
                entry["implied_points"] = round(float(pts), 1)
                entry["expected_off_tds"] = round(float(pts * ratio), 2)
                lam = player_lambdas(o, rates, team, pts * ratio)
                lam = lam[lam.pid.isin(set(players.gsis_id))] if not lam.empty else lam
                if not lam.empty:
                    adj = MU.adjust(lam, opp, pos, pf, cf, True, pts * ratio)
                    lam = lam.assign(p_mu=adj.p_adj.values, f_rush=adj.f_rush, f_rec=adj.f_rec, f_cov=adj.f_cov)
                    if chosen != "baseline":
                        lam = lam.assign(p=lam.p_mu)
                entry["opp_cov_factor"] = round(float(cf.get(opp, 1.0)), 3)
                cands = []
                for r in (lam.sort_values("p", ascending=False).head(14).itertuples() if not lam.empty else []):
                    ir = inj_map.get(r.pid)
                    status = nz(getattr(ir, "report_status", None)) if ir is not None else None
                    quality = "ok"
                    notes = []
                    if r.games < 3:
                        quality = "limited"; notes.append(f"only {r.games} game(s) of usage with {team}")
                    if status in ("Out", "Doubtful"):
                        quality = "unavailable"
                    elif status == "Questionable":
                        notes.append("questionable on the injury report")
                    p = float(r.p)
                    mu = float(r.p_mu)
                    grp = MU.GROUP.get(pos.get(r.pid), "OTHER")
                    parts = []
                    if r.lam_rush > 0.01 and abs(r.f_rush - 1) >= 0.03:
                        parts.append(f"{opp} allows {'more' if r.f_rush > 1 else 'fewer'} rushing TDs to {grp}s than average (x{r.f_rush:.2f})")
                    if r.lam_rec > 0.01 and abs(r.f_rec - 1) >= 0.03:
                        parts.append(f"{opp} allows {'more' if r.f_rec > 1 else 'fewer'} receiving TDs to {grp}s than average (x{r.f_rec:.2f})")
                    if r.lam_rec > 0.01 and abs(r.f_cov - 1) >= 0.03:
                        parts.append(f"{opp}'s charted coverage allows {'more' if r.f_cov > 1 else 'fewer'} TDs per target than average (x{r.f_cov:.2f})")
                    cands.append({
                        "p_matchup": round(mu, 4), "matchup_pct": round((mu / p - 1) * 100, 1) if p > 0 else None,
                        "matchup_why": "; ".join(parts) or f"{opp} is close to league average against this role.",
                        "player": r.name, "full_name": nz(full.get(r.pid)), "gsis_id": r.pid, "pos": nz(pos.get(r.pid)), "team": team, "game_id": g["game_id"],
                        "p": round(p, 4), "fair_american": american(p),
                        "lambda": round(float(r.lam), 3),
                        "share": round(float(r.share), 3), "opps": int(r.opp), "i10": int(r.i10),
                        "games": int(r.games), "injury": status, "quality": quality, "notes": notes,
                        "reason": f"{r.share:.0%} of {team}'s expected TD opportunity this season ({r.i10} touches inside the 10).",
                        "risk": "; ".join(notes) or "Usage share can shift with game script and red-zone play calls.",
                    })
                entry["candidates"] = [c for c in cands if c["quality"] != "unavailable"][:8] + [c for c in cands if c["quality"] == "unavailable"]
            teams.append(entry)
        out_games.append({**g, "teams": teams})
    return {"week": week, "model_version": MODEL_VERSION, "status": "research", "td_per_point": round(ratio, 4),
            "headline_model": chosen,
            "games": out_games,
            "missing": ["sportsbook prices (PropLine key not configured; manual import available to admins)",
                        "weather forecasts (no permitted source connected)",
                        "confirmed inactives (published about 90 minutes before kickoff; not yet in nflverse injuries)",
                        "individual defender matchups (no public coverage-assignment data)"]}


def american(p: float):
    if p <= 0 or p >= 1:
        return None
    return int(round(-100 * p / (1 - p))) if p >= 0.5 else int(round(100 * (1 - p) / p))


# ---------------------------------------------------------------- main

def main() -> int:
    pbp, games, pfr, players, injuries, snaps = load()
    games_out = build_games(games, pbp)
    tds, recon = build_touchdowns(pbp, games, pfr, players)
    weekly = build_weekly(games_out, tds, recon)
    validation = validate(pbp, games, snaps, players, pfr)
    slate = build_slate(pbp, games, injuries, players, games_out, pfr, validation)
    finals = [g for g in games_out if g["status"] == "final"]
    meta = {
        "season": SEASON, "refreshed_at": now_iso(),
        "latest_final_week": max((g["week"] for g in finals), default=None),
        "final_games": len(finals), "reconciled_games": sum(1 for v in recon.values() if v["reconciled"]),
        "touchdowns": len(tds),
        "sources": [
            {"name": "nflverse play-by-play 2026", "fields": "touchdowns, scorers, play details", "through_week": int(pbp.week.max())},
            {"name": "nflverse schedules", "fields": "games, kickoffs, official final scores, closing spread/total"},
            {"name": "PFR defensive charting (nflverse pfr_advstats)", "fields": "receiving TDs allowed per defender per game", "through_week": int(pfr.week.max())},
            {"name": "nflverse injuries 2026", "fields": "weekly practice and game status", "through_week": int(injuries.week.max()) if len(injuries) else None},
            {"name": "nflverse snap counts 2026", "fields": "who played (validation only)", "through_week": int(snaps.week.max()) if len(snaps) else None},
        ],
        "not_connected": ["NFL.com official game books (blocked from this refresh environment; reconciliation uses official final scores instead)",
                          "film (NFL+ / NFL Pro) and paid charting (PFF)", "sportsbook prices (PropLine key not configured)",
                          "weather forecasts"],
    }
    # who took at least one snap in each game (offense, defense or special teams), for settling picks
    pmap = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id")["gsis_id"]
    s = snaps.assign(gsis=snaps.pfr_player_id.map(pmap))
    s = s[(s[["offense_snaps", "defense_snaps", "st_snaps"]].fillna(0).sum(axis=1) > 0) & s.gsis.notna()]
    played = {gid: sorted(set(x)) for gid, x in s.groupby("game_id").gsis}
    write_json("played.json", played)
    write_json("defenders.json", {"through_week": int(pfr.week.max()), "min_targets": 25, "source": PFR_SOURCE,
                                  "rows": MU.defender_board(pfr)})
    bad = [k for k, v in recon.items() if not v["reconciled"]]
    write_json("games.json", games_out)
    write_json("touchdowns.json", tds)
    write_json("weekly.json", weekly)
    write_json("validation.json", validation)
    write_json("slate.json", slate)
    write_json("reconciliation.json", recon)
    write_json("meta.json", meta)  # last: its timestamp marks a complete refresh
    print(json.dumps({"final_games": len(finals), "reconciled": meta["reconciled_games"], "unreconciled": bad,
                      "touchdowns": len(tds), "slate_week": slate["week"], "validation_n": validation.get("n")}))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
