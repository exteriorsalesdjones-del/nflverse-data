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
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

import matchup as MU
import model_v03 as V3
import referee_index as RI
import enhance as EN

SEASON = 2026
MODEL_VERSION = "usage-v0.3c"
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
    # Kickoff passed long ago with no result and no plays: shown as not final. Judged on the kickoff in Eastern time
    # plus 12 hours, never on the runner's UTC date (that flipped night games to this status from 7 PM ET, before
    # they kicked off, which locked their picks early).
    try:
        from zoneinfo import ZoneInfo
        kick = datetime.fromisoformat(f"{row.gameday}T{row.gametime if isinstance(row.get('gametime'), str) else '23:59'}")
        if datetime.now(ZoneInfo("America/New_York")).replace(tzinfo=None) > kick + timedelta(hours=12):
            return "postponed_or_pending"
    except (TypeError, ValueError):
        pass
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
    have_plays = set(pbp.game_id.unique())
    for g in games[games.result.notna()].itertuples():
        h, a = pts.get((g.game_id, g.home_team), 0), pts.get((g.game_id, g.away_team), 0)
        tds = td[td.game_id == g.game_id]
        out[g.game_id] = {
            "reconciled": bool(h == g.home_score and a == g.away_score),
            # final on the schedule, but the play-by-play source hasn't published this game's plays yet: not a mismatch,
            # just not checkable yet. Its picks stay pending and it does not block publishing the other games.
            "awaiting_source": g.game_id not in have_plays,
            "official": [int(g.away_score), int(g.home_score)],
            "rebuilt": [a, h],
            "td_count": int(len(tds)),
            "td_by_team": {g.away_team: int((tds.td_team == g.away_team).sum()), g.home_team: int((tds.td_team == g.home_team).sum())},
        }
    return out


def results_change(tds: list, games_out: list, recon: dict | None = None) -> dict:
    """results_changed_at advances only when the results fingerprint differs from the previous meta.json in the output
    folder (the scheduled job downloads the published one first); a check with no changes keeps the old time."""
    fp = results_fingerprint(tds, games_out, recon); prev = {}
    try:
        prev = json.loads((OUT / "meta.json").read_text())
    except Exception:
        pass
    same = prev.get("results_fingerprint") == fp and prev.get("results_changed_at")
    return {"results_fingerprint": fp, "results_changed_at": prev["results_changed_at"] if same else now_iso()}


def check_scorers(tds: list, recon: dict, stats_path: Path | None = None) -> None:
    """Second check on each final game: every player's touchdown count in the rebuilt records must equal nflverse's
    nflverse weekly player stats (built from the same feed: a consistency check, not an independent source) (rushing + receiving + special-teams + defensive + fumble-recovery TDs). A matching
    final score can't catch a touchdown credited to the wrong player; this can. Adds to recon[game]:
    scorers_verified True / False / None (official stats for that game not published yet) and scorer_mismatches."""
    path = stats_path or (CACHE / f"stats_player_week_{SEASON}.parquet")
    try:
        st = pd.read_parquet(path)
    except Exception:
        for r in recon.values():
            r["scorers_verified"] = None; r["scorer_mismatches"] = []
        return
    st = st[st.season_type == "REG"] if "season_type" in st else st
    cols = [c for c in ("rushing_tds", "receiving_tds", "special_teams_tds", "def_tds", "fumble_recovery_tds") if c in st.columns]
    st = st.assign(tds=st[cols].fillna(0).sum(axis=1))
    have = set(st.game_id)
    official = st[st.tds > 0].groupby(["game_id", "player_id"]).tds.sum().to_dict()
    records: dict = {}
    for t in tds:
        if t.get("scorer_id"):
            records[(t["game_id"], t["scorer_id"])] = records.get((t["game_id"], t["scorer_id"]), 0) + 1
    ncol = next((c for c in ("player_display_name", "player_name") if c in st.columns), None)
    names = dict(zip(st.player_id, st[ncol])) if ncol else {}
    names.update({t["scorer_id"]: t.get("scorer") for t in tds if t.get("scorer_id")})
    for gid, r in recon.items():
        if gid not in have:
            r["scorers_verified"] = None; r["scorer_mismatches"] = []; continue
        pids = {p for (g, p) in official if g == gid} | {p for (g, p) in records if g == gid}
        bad = [{"player_id": p, "player": names.get(p), "records": records.get((gid, p), 0), "official": int(official.get((gid, p), 0))}
               for p in sorted(pids) if records.get((gid, p), 0) != int(official.get((gid, p), 0))]
        r["scorers_verified"] = not bad; r["scorer_mismatches"] = bad


def results_fingerprint(tds: list, games_out: list, recon: dict | None = None) -> str:
    """Changes only when a touchdown, its scorer, or a final score changes."""
    import hashlib
    parts = sorted(f"{t['key']}|{t.get('scorer_id')}|{t.get('team')}" for t in tds)
    parts += sorted(f"{g['game_id']}|{g.get('status')}|{g.get('away_score')}|{g.get('home_score')}" for g in games_out if g.get("status") == "final")
    # a game becoming settleable (score check passed, scorers verified) is a results change too
    parts += sorted(f"{k}|{v.get('reconciled')}|{v.get('scorers_verified')}|{v.get('awaiting_source')}" for k, v in (recon or {}).items())
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]


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


CONFIGS = {  # name: (recency, skill, kalman, calibrate)
    "baseline": (False, False, False, False),
    "recency": (True, False, False, False),
    "recency_skill": (True, True, False, False),
    "recency_skill_kalman": (True, True, True, False),
    "full": (True, True, True, True),
    "baseline_calibrated": (False, False, False, True),
}
MATCHUPS = ["matchup_pos", "matchup_pos_cov"]


def off_td_counts(pbp) -> dict:
    td = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1) & ((pbp.pass_touchdown == 1) | (pbp.rush_touchdown == 1))]
    return td.groupby(["game_id", "posteam"]).size().to_dict()


def week_predictions(o_hist, rates, ratio, games_hist, offc, pos, pf, cf, g, ip):
    """Raw (uncalibrated) predictions for one game's two offences under every config."""
    kx = EN.kalman_team(games_hist, offc, ratio, implied_points)
    out = []
    for team, opp, pts in ((g.away_team, g.home_team, ip[0]), (g.home_team, g.away_team, ip[1])):
        total = pts * ratio
        base = EN.team_lambdas(o_hist, rates, team, total, False, False)
        if base.empty:
            continue
        rec = EN.team_lambdas(o_hist, rates, team, total, True, False).set_index("pid")
        rs = EN.team_lambdas(o_hist, rates, team, total, True, True).set_index("pid")
        rsk = EN.team_lambdas(o_hist, rates, team, total * kx.get(team, 1.0), True, True).set_index("pid")
        m1 = MU.adjust(base, opp, pos, pf, cf, False, total)
        m2 = MU.adjust(base, opp, pos, pf, cf, True, total)
        for i, r in enumerate(base.itertuples()):
            out.append({"team": team, "opp": opp, "pid": r.pid, "baseline": r.p,
                        "recency": rec.p.get(r.pid, r.p), "recency_skill": rs.p.get(r.pid, r.p),
                        "recency_skill_kalman": rsk.p.get(r.pid, r.p),
                        "matchup_pos": m1.p_adj.iloc[i], "matchup_pos_cov": m2.p_adj.iloc[i],
                        "kalman_x": kx.get(team, 1.0)})
    return out


def validate(pbp, games, snaps, players, pfr) -> dict:
    """Walk-forward: for week w use only weeks < w. Score players who took an offensive snap.
    Every variant is scored on the same player-games."""
    o = opportunity_table(pbp)
    pos = players.dropna(subset=["gsis_id"]).drop_duplicates("gsis_id").set_index("gsis_id")["position"]
    pmap = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id")["gsis_id"]
    snaps = snaps.assign(gsis=snaps.pfr_player_id.map(pmap))
    played = snaps[snaps.offense_snaps.fillna(0) > 0].groupby("game_id").gsis.apply(set).to_dict()
    td = pbp[(pbp.touchdown == 1) & (pbp.two_point_attempt != 1)]
    scorers = td.groupby("game_id").td_player_id.apply(set).to_dict()
    offc = off_td_counts(pbp)
    rows = []
    for w in range(4, int(games[games.result.notna()].week.max()) + 1):
        hist = o[o.week < w]
        rates = fit_rates(hist)
        hist_pbp = pbp[pbp.week < w]
        gh = games[(games.week < w) & games.result.notna()]
        ratio = off_td_per_point(hist_pbp, games[games.week < w])
        pf = MU.pos_factors(hist_pbp, pos)
        cf = MU.cov_factors(pfr[pfr.week < w])
        for g in games[(games.week == w) & games.result.notna()].itertuples():
            ip = implied_points(g)
            if ip is None:
                continue
            on = played.get(g.game_id, set())
            for r in week_predictions(hist, rates, ratio, gh, offc, pos, pf, cf, g, ip):
                if r["pid"] not in on:
                    continue  # inactive or no offensive snap: a pick would be void
                rows.append({**r, "week": w, "game_id": g.game_id, "y": int(r["pid"] in scorers.get(g.game_id, set()))})
    if not rows:
        return {"n": 0}
    v = pd.DataFrame(rows)
    # calibration layers, fitted on earlier weeks only
    v["full"] = v.recency_skill_kalman.astype(float)
    v["baseline_calibrated"] = v.baseline.astype(float)
    for src, dst in (("recency_skill_kalman", "full"), ("baseline", "baseline_calibrated")):
        for w in sorted(v.week.unique()):
            prior = v[v.week < w]
            ab = EN.fit_platt(prior[src].to_numpy(float), prior.y.to_numpy(float))
            m = v.week == w
            v.loc[m, dst] = EN.apply_platt(v.loc[m, src].to_numpy(float), ab)
    base = v.y.mean()
    brier0, ll0 = _metrics(np.full(len(v), base), v.y)
    rng = np.random.default_rng(7)
    variants = {}
    names = list(CONFIGS) + MATCHUPS
    ll_row = {n: -(v.y * np.log(np.clip(v[n], 1e-6, 1)) + (1 - v.y) * np.log(np.clip(1 - v[n], 1e-6, 1))) for n in names}
    for name in names:
        b, l = _metrics(v[name], v.y)
        bins = pd.cut(v[name], [0, .05, .1, .2, .3, .4, .5, 1], include_lowest=True)
        cal = [{"bin": str(k), "n": int(len(x)), "pred": float(x[name].mean()), "actual": float(x.y.mean())}
               for k, x in v.groupby(bins, observed=True)]
        entry = {"brier": b, "log_loss": l, "calibration": cal,
                 "max_cal_gap": max((abs(c["pred"] - c["actual"]) for c in cal if c["n"] >= 50), default=None)}
        if name != "baseline":
            per_game = (ll_row["baseline"] - ll_row[name]).groupby(v.game_id).sum()
            boots = [per_game.sample(len(per_game), replace=True, random_state=int(rng.integers(1e9))).sum() / len(v) for _ in range(400)]
            entry["ll_gain"] = float(per_game.sum() / len(v))
            entry["ll_gain_ci90"] = [float(np.percentile(boots, 5)), float(np.percentile(boots, 95))]
        variants[name] = entry
    passing = [n for n in names if n != "baseline" and variants[n]["ll_gain_ci90"][0] > 0]
    chosen = min(passing, key=lambda n: variants[n]["log_loss"]) if passing else "baseline"
    c = variants[chosen]
    platt = {}
    for src, dst in (("recency_skill_kalman", "full"), ("baseline", "baseline_calibrated")):
        platt[dst] = EN.fit_platt(v[src].to_numpy(float), v.y.to_numpy(float))
    return {"model_version": MODEL_VERSION, "weeks": [4, int(v.week.max())], "n": int(len(v)),
            "base_rate": float(base), "brier": c["brier"], "brier_constant": brier0,
            "log_loss": c["log_loss"], "log_loss_constant": ll0, "calibration": c["calibration"],
            "variants": variants, "chosen": chosen, "passing": passing, "platt": platt,
            "settings": {"half_life_weeks": EN.HALF_LIFE, "skill_prior_tds": EN.A_PRIOR, "kalman_q": EN.KF_Q,
                         "matchup_k_games": MU.K_GAMES, "matchup_k_targets": MU.K_TARGETS},
            "status": "research",
            "note": "Each week is predicted from earlier weeks only, using closing spread and total. Scored on players who took an offensive snap (an inactive player's pick is void). A variant is adopted only when the 90% bootstrap interval (resampling games) of its log-loss gain over the baseline is above zero; among those, the lowest log loss wins. No sportsbook prices are included, so no closing-line value yet."}


def build_slate(pbp, games, injuries, players, games_out, pfr, validation):
    up = [g for g in games_out if g["status"] in ("upcoming", "in_progress", "postponed_or_pending")]
    if not up:
        return {"week": None, "games": []}
    week = min(g["week"] for g in up)
    o = opportunity_table(pbp)
    rates = fit_rates(o)
    ratio = off_td_per_point(pbp, games)
    # current roster: only players on this team's active roster in the latest roster week can be candidates
    rpath = CACHE / f"roster_weekly_{SEASON}.parquet"
    roster = pd.read_parquet(rpath) if rpath.exists() else pd.DataFrame()
    if len(roster):
        rw = roster[roster.week <= week]
        rw = rw[rw.week == rw.week.max()]
        cur = {r.gsis_id: (r.team, r.status) for r in rw.itertuples()}
        roster_week = int(rw.week.max())
    else:
        cur, roster_week = {}, None
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
    kx = EN.kalman_team(games[games.result.notna()], off_td_counts(pbp), ratio, implied_points)
    # v0.3c headline model (adopted after the Weeks 1-9 backtest); falls back to v0.2 if it cannot run
    try:
        v3, v3_meta = V3.predict(week, players)
        v3 = v3.set_index("pid")
    except Exception as e:  # keep the board working on the old model
        print("v0.3 model failed, using v0.2:", e, file=sys.stderr)
        HEALTH["problems"].append(f"Model v0.3c failed ({type(e).__name__}); the older v0.2 chances are shown.")
        v3, v3_meta = None, {"error": str(e)}
    # 2026 goal-line and end-zone counts with their denominators (shown on player details)
    q = pbp[pbp.play_type.isin(["run", "pass"]) & (pbp.two_point_attempt != 1)]
    r5 = q[q.rusher_player_id.notna() & (q.yardline_100 <= 5) & ((q.play_type == "run") | (q.qb_scramble == 1))]
    i5_p = r5.groupby(["posteam", "rusher_player_id"]).size().to_dict(); i5_t = r5.groupby("posteam").size().to_dict()
    ezq = q[q.receiver_player_id.notna() & (q.air_yards >= q.yardline_100)]
    ez_p = ezq.groupby(["posteam", "receiver_player_id"]).size().to_dict(); ez_t = ezq.groupby("posteam").size().to_dict()
    tgp = pbp[pbp.week < week].groupby("posteam").game_id.nunique().to_dict()
    wpath = CACHE / "weather_forecast.json"
    wx = json.loads(wpath.read_text()) if wpath.exists() else {}
    wx_games = wx.get("games", {}) if wx.get("week") == week else {}
    study_path = Path(__file__).with_name("wind_study.json")
    wind_study = json.loads(study_path.read_text()) if study_path.exists() else None
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
                    lam = lam.assign(p_raw=lam.p, p_mu=adj.p_adj.values, f_rush=adj.f_rush, f_rec=adj.f_rec, f_cov=adj.f_cov)
                    cfg = CONFIGS.get(chosen)
                    if cfg and (cfg[0] or cfg[1] or cfg[2]):
                        total = pts * ratio * (kx.get(team, 1.0) if cfg[2] else 1.0)
                        alt = EN.team_lambdas(o, rates, team, total, cfg[0], cfg[1]).set_index("pid")
                        lam = lam.assign(p=[alt.p.get(i, q) for i, q in zip(lam.pid, lam.p)])
                    elif chosen in MATCHUPS:
                        lam = lam.assign(p=lam.p_mu)
                    if cfg and cfg[3]:
                        ab = (validation.get("platt") or {}).get(chosen)
                        lam = lam.assign(p=EN.apply_platt(lam.p.to_numpy(float), ab),
                                         p_mu=EN.apply_platt(lam.p_mu.to_numpy(float), ab))
                entry["opp_cov_factor"] = round(float(cf.get(opp, 1.0)), 3)
                cands = []
                dropped = []
                for r in (lam.sort_values("p", ascending=False).itertuples() if not lam.empty else []):
                    if cur:
                        rteam, rstat = cur.get(r.pid, (None, None))
                        if rteam != team or rstat not in ("ACT", "INA"):
                            dropped.append({"player": nz(full.get(r.pid)) or r.name, "gsis_id": r.pid,
                                            "why": "not on the roster" if rteam is None else (f"now with {rteam}" if rteam != team else {"RES": "on injured reserve", "CUT": "released", "DEV": "on the practice squad", "TRD": "traded", "RET": "retired", "EXE": "exempt list"}.get(rstat, f"roster status {rstat}"))})
                            continue
                    if len(cands) >= 14:
                        break
                    ir = inj_map.get(r.pid)
                    status = nz(getattr(ir, "report_status", None)) if ir is not None else None
                    quality = "ok"
                    notes = []
                    if r.games < 3:
                        quality = "limited"; notes.append(f"only {r.games} game(s) of usage with {team}")
                    if cur and cur.get(r.pid, (None, None))[1] == "INA":
                        status = status or "Inactive"
                    if status in ("Out", "Doubtful", "Inactive"):
                        quality = "unavailable"
                    elif status == "Questionable":
                        notes.append("questionable on the injury report")
                    p = float(r.p)
                    mu = float(r.p_mu)
                    x3 = v3.loc[r.pid] if v3 is not None and r.pid in v3.index else None
                    if isinstance(x3, pd.DataFrame):
                        x3 = x3.iloc[0]
                    if x3 is not None:
                        mu = float(np.clip(float(x3.p) * (mu / p if p > 0 else 1.0), 0.001, 0.95))
                        p = float(x3.p)
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
                        "p": round(p, 4), "p_uncalibrated": round(float(r.p_raw), 4), "fair_american": american(p),
                        "lambda": round(float(r.lam), 3),
                        "rec_share": round(float(r.lam_rec / r.lam), 3) if r.lam > 0 else None,
                        "share": round(float(r.share), 3), "opps": int(r.opp), "i10": int(r.i10),
                        "games": int(r.games), "injury": status, "quality": quality, "notes": notes,
                        "reason": f"{r.share:.0%} of {team}'s expected TD opportunity this season ({r.i10} touches inside the 10).",
                        "risk": "; ".join(notes) or "Usage share can shift with game script and red-zone play calls.",
                        **v3_fields(x3, r.pid, team, i5_p, i5_t, ez_p, ez_t, tgp.get(team, 0), status, pos.get(r.pid)),
                    })
                cands.sort(key=lambda c: -c["p"])
                entry["candidates"] = [c for c in cands if c["quality"] != "unavailable"][:8] + [c for c in cands if c["quality"] == "unavailable"]
                entry["removed"] = dropped[:10]
            teams.append(entry)
        out_games.append({**g, "teams": teams, "weather": wx_games.get(g["game_id"]), "referee": nz(row.get("referee"))})
    return {"week": week, "model_version": MODEL_VERSION, "status": "research", "td_per_point": round(ratio, 4),
            "headline_model": V3.MODEL_VERSION if v3 is not None else chosen, "roster_week": roster_week, "v3": v3_meta,
            "referees": referee_index_safe(),
            "weather_fetched_at": wx.get("fetched_at") if wx_games else None, "windy_mph": wx.get("windy_mph", 15), "wind_study": wind_study,
            "games": out_games,
            "missing": ["sportsbook prices (PropLine key not configured; manual import available to admins)",
                        "confirmed inactives (published about 90 minutes before kickoff; not yet in nflverse injuries)",
                        "individual defender matchups (no public coverage-assignment data)"]}


def projections(x, position):
    """Secondary stat projections (volume x rate), validated in research/secondary.py on 2026 weeks 1-9.
    Routes are estimated from snaps (est. routes). QB passing yards only for the depth-chart starter."""
    f = lambda v, d=np.nan: d if v is None or (isinstance(v, float) and np.isnan(v)) else float(v)
    shrink = lambda val, n, prior, k: (f(val, prior) * f(n, 0) + prior * k) / (f(n, 0) + k)
    g = f(x.hist_games, 0)
    if g < 1:
        return None
    plays, dbr = f(x.team_plays_g), f(x.team_db_rate)
    if np.isnan(plays) or np.isnan(dbr):
        return None
    out = {}
    if position in ("RB", "QB"):
        ypc = shrink(x.ypc, f(x.carries_g, 0) * g, 4.3, 40)
        out["rush_yds"] = round(plays * (1 - dbr) * f(x.carry_share, 0) * ypc, 1)
    if position in ("RB", "WR", "TE"):
        tprr = min(f(x.targets_g, 0) / f(x.est_routes_g, np.nan), 0.6) if f(x.est_routes_g, 0) > 0 else 0.12
        tg = f(x.snap_share, 0) * plays * dbr * tprr
        n_t = f(x.targets_g, 0) * g
        out["targets"] = round(tg, 1)
        out["receptions"] = round(tg * shrink(x.catch_rate, n_t, 0.64, 25), 1)
        out["rec_yds"] = round(tg * shrink(x.ypt, n_t, 7.3, 25), 1)
    if position == "QB" and f(x.depth_rank, 9) == 1 and f(x.att_g, 0) >= 15:
        n_a = f(x.att_g) * g
        out["pass_yds"] = round(f(x.att_g) * shrink(x.cmp_rate, n_a, 0.64, 60) * shrink(x.yds_per_cmp, f(x.cmp_rate, .64) * n_a, 10.8, 40), 0)
    return out or None


def v3_fields(x, pid, team, i5_p, i5_t, ez_p, ez_t, team_games, status, position):
    """Board fields from the v0.3c feature row: shares with denominators, role change, main reason, biggest uncertainty."""
    out = {"i5_carries": int(i5_p.get((team, pid), 0)), "team_i5_carries": int(i5_t.get(team, 0)),
           "ez_targets": int(ez_p.get((team, pid), 0)), "team_ez_targets": int(ez_t.get(team, 0)), "team_games_2026": int(team_games)}
    if x is None:
        out.update(model="usage-v0.2", main_reason=None, uncertainty="Not in the v0.3 feature table; older model shown.", role_change=None)
        return out
    num = lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v)
    cs, ts = num(x.carry_share) or 0.0, num(x.target_share) or 0.0
    rcs, rts = num(x.rc_carry_share), num(x.rc_target_share)
    season_opp = cs + ts; recent_opp = (rcs if rcs is not None else cs) + (rts if rts is not None else ts)
    role = None
    if num(x.hist_games) and x.hist_games >= 4 and abs(recent_opp - season_opp) >= 0.08:
        role = {"dir": "up" if recent_opp > season_opp else "down", "recent": round(recent_opp, 3), "season": round(season_opp, 3)}
    drv = x.main_driver
    reasons = {
        "team": f"{team} expected to score {x.exp_team_td:.1f} offensive TDs (betting line)",
        "workload": (f"{cs:.0%} of {team}'s carries" if cs >= ts else f"{ts:.0%} of {team}'s targets") + " (2026, 2025 at half weight)",
        "goal_line": f"{(num(x.i5_share) or 0):.0%} of {team}'s carries inside the 5" if position in ("RB", "QB") else "goal-line role",
        "depth": f"#{int(x.depth_rank)} on {team}'s depth chart" if num(x.depth_rank) else "depth chart",
        "history": f"{(num(x.td_rate) or 0):.2f} TDs per game so far",
    }
    if position == "QB" and drv == "goal_line":
        reasons["goal_line"] = f"{x.designed_g:.1f} designed runs and {x.sneaks_g:.1f} sneaks per game"
    unc = None
    if x.no_history:
        unc = "No usage history yet: estimate leans on position averages."
    elif x.team_change:
        unc = "New team: usage comes from his old team."
    elif status in ("Questionable",):
        unc = "Questionable on the injury report."
    elif num(x.hist_games) is not None and x.hist_games < 3:
        unc = f"Only {x.hist_games:.1f} weighted games of usage."
    elif role is not None:
        unc = f"Role changing: {role['recent']:.0%} of team carries+targets in the last 3 games vs {role['season']:.0%} overall."
    elif x.qb_out:
        unc = "Starting QB is out."
    elif max(x.vac_carry, x.vac_target) >= 0.25:
        unc = "Teammates out free up touches; how they are split is uncertain."
    else:
        unc = "Touchdowns are rare events: even a strong 40% chance misses most weeks."
    out["proj"] = projections(x, position)
    out.update(model="usage-v0.3c", main_reason=reasons.get(drv), uncertainty=unc, role_change=role,
               carry_share=round(cs, 3), target_share=round(ts, 3), i5_share=round(num(x.i5_share) or 0, 3),
               ez_share=round(num(x.ez_share) or 0, 3), depth_rank=int(x.depth_rank) if num(x.depth_rank) else None)
    return out


HEALTH = {"problems": []}


def referee_index_safe():
    try:
        idx = RI.build(SEASON)
        Path(__file__).with_name("referee_index.json").write_text(json.dumps(idx, indent=1))
        return idx
    except Exception as e:
        HEALTH["problems"].append(f"Referee index not rebuilt ({type(e).__name__}); using the saved copy.")
        f = Path(__file__).with_name("referee_index.json")
        return json.loads(f.read_text()) if f.exists() else None


def save_predictions(slate: dict, games_out: list) -> int:
    """Keep each player's latest pregame chance per game; games that have kicked off are frozen."""
    path = OUT / "predictions.json"
    preds = json.loads(path.read_text()) if path.exists() else {}
    # frozen from kickoff (Eastern time), not only once final: a game in progress must keep its pregame record
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo("America/New_York")).replace(tzinfo=None)
    locked = {g["game_id"] for g in games_out if g["status"] != "upcoming" or datetime.fromisoformat(g["kickoff_et"]) <= now}
    n = 0
    for g in slate.get("games", []):
        if g["game_id"] in locked:
            # a slate game that has kicked off must already have its pregame record; if it doesn't, this run started
            # from a missing or out-of-date predictions.json and publishing would lose that game's record for good
            if not preds.get(g["game_id"]):
                HEALTH["problems"].append(f"No saved pregame chances for {g['game_id']}, which has kicked off (predictions.json missing or out of date at the start of this run).")
            continue
        cur = {c["gsis_id"]: {"p": c["p"], "model": c.get("model", MODEL_VERSION)} for t in g["teams"] for c in t["candidates"]}
        if not cur:
            continue  # nothing to save (e.g. no spread/total yet): never replace a saved game with an empty one
        preds[g["game_id"]] = cur
        n += len(cur)
    write_json("predictions.json", preds)
    return n


def american(p: float):
    if p <= 0 or p >= 1:
        return None
    return int(round(-100 * p / (1 - p))) if p > 0.5 else int(round(100 * (1 - p) / p))  # exactly 50% = +100 (even money)


# ---------------------------------------------------------------- main

def main() -> int:
    pbp, games, pfr, players, injuries, snaps = load()
    games_out = build_games(games, pbp)
    tds, recon = build_touchdowns(pbp, games, pfr, players)
    check_scorers(tds, recon)
    weekly = build_weekly(games_out, tds, recon)
    validation = validate(pbp, games, snaps, players, pfr)
    bt = Path(__file__).with_name("v03_backtest.json")
    if bt.exists():
        b = json.loads(bt.read_text())
        validation["v03"] = b
        validation.update({"chosen": "usage_v03c", "n": b["n"], "brier": b["brier"], "brier_constant": b["brier_constant"],
                           "log_loss": b["log_loss"], "log_loss_constant": b["log_loss_constant"], "calibration": b["calibration"],
                           "weeks": [1, 9]})
    slate = build_slate(pbp, games, injuries, players, games_out, pfr, validation)
    # Last Game Usage on every candidate (selection by snap counts; stats verified against play-by-play). A failure
    # leaves the field off and the page shows "Unavailable"; it never blocks the rest of the refresh.
    try:
        import last_game
        print("last_game:", last_game.annotate(slate, last_game.Sources.from_cache(CACHE)))
    except Exception as e:
        print("last_game FAILED, cards will show Unavailable:", e, file=sys.stderr)
    finals = [g for g in games_out if g["status"] == "final"]
    meta = {
        "season": SEASON, "refreshed_at": now_iso(),
        "feed": "Postgame results",
        "td_source": "nflverse play-by-play (NFL Game Statistics & Information System feed), published after each game ends; checked hourly during game windows",
        **results_change(tds, games_out, recon),
        "latest_final_week": max((g["week"] for g in finals), default=None),
        "final_games": len(finals), "reconciled_games": sum(1 for v in recon.values() if v["reconciled"]),
        "touchdowns": len(tds),
        "sources": [
            {"name": "nflverse play-by-play 2026", "fields": "touchdowns, scorers, play details", "through_week": int(pbp.week.max())},
            {"name": "nflverse schedules", "fields": "games, kickoffs, official final scores, closing spread/total"},
            {"name": "PFR defensive charting (nflverse pfr_advstats)", "fields": "receiving TDs allowed per defender per game", "through_week": int(pfr.week.max())},
            {"name": "nflverse injuries 2026", "fields": "weekly practice and game status", "through_week": int(injuries.week.max()) if len(injuries) else None},
            {"name": "nflverse weekly player stats 2026", "fields": "Last Game Usage: targets, rushing attempts, pass attempts (each checked against play-by-play)"},
            {"name": "nflverse snap counts 2026", "fields": "who played (settling picks, Last Game Usage)", "through_week": int(snaps.week.max()) if len(snaps) else None},
            {"name": "National Weather Service hourly forecast (US) and Open-Meteo (international, fallback)", "fields": "kickoff wind, temperature, rain chance; outdoor 15+ mph flagged", "through_week": slate.get("week") if slate.get("weather_fetched_at") else None},
        ],
        "not_connected": ["NFL.com official game books (blocked from this refresh environment; reconciliation uses official final scores instead)",
                          "film (NFL+ / NFL Pro) and paid charting (PFF)", "sportsbook prices (PropLine key not configured)"],
    }
    # who took at least one snap in each game (offense, defense or special teams), for settling picks
    pmap = players.dropna(subset=["pfr_id"]).drop_duplicates("pfr_id").set_index("pfr_id")["gsis_id"]
    s = snaps.assign(gsis=snaps.pfr_player_id.map(pmap))
    s = s[(s[["offense_snaps", "defense_snaps", "st_snaps"]].fillna(0).sum(axis=1) > 0) & s.gsis.notna()]
    played = {gid: set(x) for gid, x in s.groupby("game_id").gsis}
    # A player missing from the snap file's id mapping (no pfr_id) still played if the play-by-play shows him carrying,
    # targeted, passing or scoring. Added only to games whose snap counts are already published: a list built from
    # touches alone would read as "everyone else did not play" and void their picks.
    for col in ("rusher_player_id", "receiver_player_id", "passer_player_id", "td_player_id"):
        if col in pbp.columns:
            for gid, x in pbp[pbp[col].notna()].groupby("game_id")[col]:
                if gid in played:
                    played[gid] |= set(x)
    played = {gid: sorted(x) for gid, x in played.items()}
    write_json("played.json", played)
    write_json("defenders.json", {"through_week": int(pfr.week.max()), "min_targets": 25, "source": PFR_SOURCE,
                                  "rows": MU.defender_board(pfr)})
    bad = [k for k, v in recon.items() if not v["reconciled"] and not v.get("awaiting_source")]
    waiting = [k for k, v in recon.items() if v.get("awaiting_source")]
    if waiting:
        HEALTH["problems"].append(f"Final but not yet in the play-by-play source (picks stay pending): {', '.join(waiting)}.")
    write_json("games.json", games_out)
    write_json("touchdowns.json", tds)
    write_json("weekly.json", weekly)
    write_json("validation.json", validation)
    write_json("slate.json", slate)
    # Research tab: per-player, per-game usage (a failure leaves the Research tab's usage section on "Unavailable")
    try:
        import research_data
        write_json("usage.json", research_data.build(pbp, players))
    except Exception as e:
        print("usage FAILED, Research usage will show Unavailable:", e, file=sys.stderr)
    write_json("reconciliation.json", recon)
    n_pred = save_predictions(slate, games_out)
    try:
        import grade
        grade.main(os.environ.get("FB_LINES_DIR"))
    except Exception as e:
        HEALTH["problems"].append(f"Weekly grading failed ({type(e).__name__}).")
    fs = CACHE / "fetch_status.json"
    fstat = json.loads(fs.read_text()) if fs.exists() else {}
    for f in fstat.get("failed", []):
        HEALTH["problems"].append(f"Download failed, previous copy used: {f}")
    wx = slate.get("games", [])
    outdoor = [g for g in wx if (g.get("weather") or {}).get("roof") in ("outdoor", "retractable")]
    no_fc = [g["game_id"] for g in outdoor if (g.get("weather") or {}).get("wind_mph") is None]
    if no_fc:
        HEALTH["problems"].append(f"No weather forecast for {len(no_fc)} of {len(outdoor)} open-air games.")
    meta["health"] = {"model": slate.get("headline_model"), "predictions_saved": n_pred, "prediction_games_stored": len(json.loads((OUT / "predictions.json").read_text())), "problems": HEALTH["problems"],
                      "ok": not any(("failed" in x and "Weekly" not in x) or "v0.2" in x for x in HEALTH["problems"])}
    write_json("meta.json", meta)  # last: its timestamp marks a complete refresh
    print(json.dumps({"final_games": len(finals), "reconciled": meta["reconciled_games"], "unreconciled": bad, "awaiting_source": waiting,
                      "touchdowns": len(tds), "slate_week": slate["week"], "validation_n": validation.get("n")}))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
