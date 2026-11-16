"""Live in-game touchdowns: one shared backend poller -> outbox documents -> the app's shared database ("live" collection).

The poller runs as a background job inside a cloud Claude session during game windows (see docs/LIVE_RUNBOOK.md). It
asks the provider for every game in the current window, rebuilds each game's touchdown list from the provider's own
play records, compares it with the previous poll and, only when something changed, writes one JSON document per
changed game into the outbox and prints one line on stdout. The session watches stdout and saves each outbox document
with the database tool (create-only document ids, so no version bookkeeping). Nothing here writes to picks, parlays,
lines, refs, odds, overrides, reviews or locks, and nothing here settles a pick: live touchdowns are provisional. The
hourly postgame job (build_data.py) stays the final verification.

Corrections are handled the same way as the postgame build: every poll rebuilds the game's touchdowns from the source,
keyed by the source's play id, so
  * a repeated event (same play id) never duplicates,
  * a play the source drops or re-flags as non-scoring is kept with state "overturned" (shown struck through, not counted),
  * a play re-credited to another player keeps its key, takes the new scorer and records the change in "history".

Providers
  balldontlie  BALLDONTLIE NFL API (GOAT tier: /nfl/v1/games and /nfl/v1/plays). The key is NOT read here: the cloud
               environment's network secret injects the Authorization header for api.balldontlie.io. UNVERIFIED against a
               live game: the docs show the plays shape but not the scorer participant types or the in-game play latency.
  sim          A scripted event file (tests and dry runs): [{"t": seconds_from_start, "game": {...}, "plays": [...]}].

Usage
  python3 refresh/live_feed.py poll --provider balldontlie --outbox OUT [--interval 15] [--heartbeat 600] [--until-idle]
  python3 refresh/live_feed.py poll --provider sim --sim-script FILE --outbox OUT --interval 1
stdout lines:  LIVE_UPDATE <file>  |  LIVE_HEARTBEAT <file>  |  LIVE_ERROR <text>  |  LIVE_DONE <text>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("FB_OUT", ROOT / "artifact" / "data"))
ET = ZoneInfo("America/New_York")
ALIAS = {"LAR": "LA", "JAC": "JAX", "WSH": "WAS", "LVR": "LV", "OAK": "LV", "SD": "LAC", "STL": "LA"}
TD_RE = re.compile(r"touchdown", re.I)
SCORER_TYPES = ("scorer", "receiver", "rusher", "returner", "recoverer", "interceptor", "passer")   # first match wins


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def norm(s) -> str:
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv)\b\.?", "", str(s or "").lower()))


# ---------------------------------------------------------------- normalized provider records
# game:  {source_game_id, away, home, status: scheduled|in_progress|final, period, clock, away_score, home_score}
# td:    {key, scorer_name, scorer_source_id, team, qtr, clock, kind, text, wallclock}

def td_from_play(p: dict, names: dict) -> dict | None:
    """One BALLDONTLIE-shaped play -> a touchdown record, or None. Two-point tries and non-scoring plays are skipped."""
    blob = f"{p.get('type_slug', '')} {p.get('type_text', '')} {p.get('text', '')}"
    # a two-point try is skipped by its play TYPE; a touchdown whose text mentions the failed try after it still counts
    kind_blob = f"{p.get('type_slug', '')} {p.get('type_text', '')}"
    if not p.get("scoring_play") or not TD_RE.search(blob) or re.search(r"two-point|2pt|conversion", kind_blob, re.I) \
            or re.match(r"\s*\(?[\d:]*\)?\s*TWO-POINT CONVERSION ATTEMPT", p.get("text") or "", re.I):
        return None
    parts = p.get("participants") or []
    # a return or recovery touchdown is credited to the returner/recoverer, never to the offense's intended receiver
    is_return = bool(re.search(r"fumble|intercept|return|recover|punt|kickoff", kind_blob, re.I))
    order = ("scorer", "returner", "recoverer", "interceptor", "receiver", "rusher", "passer") if is_return else SCORER_TYPES
    scorer = None
    for t in order:
        hit = next((x for x in parts if x.get("type") == t), None)
        if hit and not (t == "passer" and len(parts) > 1):   # a passer scores only when he is the only player listed
            scorer = hit; break
    sid = scorer.get("player_id") if scorer else None
    name = names.get(sid) if sid is not None else None
    if not name:   # fall back to the play text: "J.Cook 74 yd run ... TOUCHDOWN" / "pass ... to D.Moore for 45 yards, TOUCHDOWN"
        m = re.search(r"to ([A-Z][\w'.-]+(?: [A-Z][\w'.-]+)?) for -?\d+ yards?, TOUCHDOWN", p.get("text", "")) or \
            re.search(r"^\(?[\d:]*\)?\s*([A-Z][\w'.-]+(?: [A-Z][\w'.-]+)?) .*TOUCHDOWN", p.get("text", ""))
        name = m.group(1) if m else None
    kind = "receiving" if re.search(r"pass|recep", blob, re.I) else "rushing" if re.search(r"rush|run", blob, re.I) else "return"
    team = (p.get("team") or {}).get("abbreviation")
    return {"key": str(p["id"]), "scorer_name": name, "scorer_source_id": sid, "team": ALIAS.get(team, team),
            "qtr": p.get("period"), "clock": p.get("clock_display"), "kind": kind, "text": p.get("text"),
            "wallclock": p.get("wallclock")}


def game_from_bdl(g: dict) -> dict:
    st = (g.get("status_state") or g.get("status") or "").lower()
    status = ("final" if st in ("post",) or st.startswith("final") else
              "in_progress" if st in ("in", "in_progress", "inprogress", "live") or re.search(r"half|quarter|overtime|\bot\b|\bq[1-4]\b|\d(st|nd|rd|th)\b|in progress", st) or
              (g.get("period") and not st.startswith(("sched", "pre", "postpon", "cancel"))) else "scheduled")
    ab = lambda t: ALIAS.get((t or {}).get("abbreviation"), (t or {}).get("abbreviation"))
    return {"source_game_id": g["id"], "away": ab(g.get("visitor_team")), "home": ab(g.get("home_team")), "status": status,
            "period": g.get("period"), "clock": g.get("time") or g.get("clock"), "away_score": g.get("visitor_team_score"),
            "home_score": g.get("home_team_score"), "date": g.get("date")}


class BallDontLie:
    BASE = "https://api.balldontlie.io/nfl/v1"
    name = "BALLDONTLIE NFL API"

    def __init__(self, season: int, week: int):
        self.season, self.week, self.names, self.requests = season, week, {}, 0

    def _get(self, path: str, **params) -> dict:
        q = "&".join(f"{k}={v}" for k, vs in params.items() for v in (vs if isinstance(vs, list) else [vs]))
        req = urllib.request.Request(f"{self.BASE}/{path}?{q}", headers={"Accept": "application/json", "User-Agent": "family-board-live/1"})
        self.requests += 1
        with urllib.request.urlopen(req, timeout=15) as r:   # Authorization is injected by the environment's network secret
            return json.load(r)

    def games(self) -> list[dict]:
        return [game_from_bdl(g) for g in self._get("games", **{"seasons[]": self.season, "weeks[]": self.week, "per_page": 100})["data"]]

    def touchdowns(self, game: dict) -> list[dict]:
        plays, cursor = [], None
        while True:
            params = {"game_id": game["source_game_id"], "per_page": 100}
            if cursor:
                params["cursor"] = cursor
            r = self._get("plays", **params); plays += r["data"]; cursor = (r.get("meta") or {}).get("next_cursor")
            if not cursor:
                break
        for sid in {x.get("player_id") for p in plays if p.get("scoring_play") for x in (p.get("participants") or [])} - set(self.names) - {None}:
            try:
                d = self._get(f"players/{sid}")["data"]; self.names[sid] = f"{d.get('first_name', '')} {d.get('last_name', '')}".strip()
            except Exception:
                self.names[sid] = None
        return [t for t in (td_from_play(p, self.names) for p in plays) if t]


class Sim:
    """Replays a scripted feed: each step replaces a game's state and play list at second t (source publish time = t)."""
    name = "simulated events"

    def __init__(self, script: Path, t0: float | None = None):
        self.steps = json.loads(Path(script).read_text()); self.t0 = t0 or time.time(); self.requests = 0
        self.names = {p["id"]: p["name"] for s in self.steps for p in s.get("players", [])}

    def _state(self):
        el = time.time() - self.t0; games = {}
        for s in self.steps:
            if s["t"] <= el:
                games[s["game"]["id"]] = (s, self.t0 + s["t"])
        return games

    def games(self):
        self.requests += 1
        return [{**game_from_bdl(s["game"]), "published_at": datetime.fromtimestamp(pub, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
                for s, pub in self._state().values()]

    def touchdowns(self, game):
        self.requests += 1
        s, _ = self._state()[game["source_game_id"]]
        return [t for t in (td_from_play(p, self.names) for p in s.get("plays", [])) if t]


# ---------------------------------------------------------------- matching to the app's games and players
class Matcher:
    def __init__(self, data: Path = DATA):
        games = json.loads((data / "games.json").read_text())
        self.games = {(g["away"], g["home"]): g for g in games}
        slate = json.loads((data / "slate.json").read_text()) if (data / "slate.json").exists() else {"games": []}
        self.players: dict = {}
        for g in slate.get("games", []):
            for t in g.get("teams", []):
                for c in t.get("candidates", []):
                    for n in {c.get("full_name"), c.get("player")}:
                        if n:
                            self.players[(t["team"], norm(n))] = (c["gsis_id"], c.get("full_name") or c.get("player"))
                            # "J.Cook" style text names: initial + last name
                            parts = (c.get("full_name") or "").split()
                            if len(parts) >= 2:
                                self.players[(t["team"], norm(parts[0][0] + parts[-1]))] = (c["gsis_id"], c.get("full_name"))

    def game(self, g: dict) -> dict | None:
        return self.games.get((g["away"], g["home"]))

    def player(self, team: str, name: str | None):
        if not name:
            return None, None
        hit = self.players.get((team, norm(name)))
        return hit if hit else (None, name)


# ---------------------------------------------------------------- diff engine (provider-agnostic)
def merge_game(prev: dict | None, tds: list[dict], seen_at: str, published_at: str | None) -> tuple[list[dict], bool]:
    """Rebuild one game's events from this poll's touchdowns and the previous events. Returns (events, changed)."""
    old = {e["key"]: e for e in (prev or {}).get("events", [])}
    cur = {t["key"]: t for t in tds}
    out, changed = [], False
    for k, t in cur.items():
        e = old.get(k)
        if not e:
            e = {**t, "state": "active", "provisional": True, "first_seen_at": seen_at, "source_published_at": published_at,
                 "updated_at": seen_at, "history": []}
            changed = True
        else:
            e = dict(e)
            if e["state"] == "overturned":                       # the source restored the play
                e["history"] = e["history"] + [{"at": seen_at, "change": "restored"}]; e["state"] = "active"; e["updated_at"] = seen_at; changed = True
            if (t["scorer_name"], t["scorer_source_id"]) != (e["scorer_name"], e["scorer_source_id"]):
                e["history"] = e["history"] + [{"at": seen_at, "change": "scorer", "from": e.get("scorer"), "to": t["scorer_name"]}]
                e.update({k2: t[k2] for k2 in ("scorer_name", "scorer_source_id", "team", "kind", "text")}); e["updated_at"] = seen_at; changed = True
            for k2 in ("qtr", "clock", "wallclock"):
                e[k2] = t[k2]
        out.append(e)
    for k, e in old.items():
        if k not in cur and e["state"] != "overturned":           # dropped or re-flagged by the source: overturned
            out.append({**e, "state": "overturned", "updated_at": seen_at, "history": e["history"] + [{"at": seen_at, "change": "overturned"}]}); changed = True
        elif k not in cur:
            out.append(e)
    out.sort(key=lambda e: (e.get("qtr") or 0, -(clock_s(e.get("clock")))))
    return out, changed


def clock_s(c) -> int:
    try:
        m, s = str(c).split(":"); return int(m) * 60 + int(s)
    except Exception:
        return 0


def counts(events: list[dict]) -> dict:
    out: dict = {}
    for e in events:
        if e["state"] == "active":
            k = e.get("gsis_id") or f"name:{e.get('scorer')}"
            out[k] = out.get(k, 0) + 1
    return out


# ---------------------------------------------------------------- poll loop
def window_games(games_json: list, now: datetime) -> list[dict]:
    """App games inside the live window: from 10 minutes before kickoff to 5 hours after."""
    out = []
    for g in games_json:
        k = datetime.fromisoformat(g["kickoff_et"]).replace(tzinfo=ET)
        if k - timedelta(minutes=10) <= now <= k + timedelta(hours=5):
            out.append(g)
    return out


def poll_once(provider, matcher: Matcher, state: dict, outbox: Path, week: int) -> list[Path]:
    seen = now_iso(); written = []; errors = state.setdefault("_errors", []); errors.clear()
    for g in provider.games():
        app = matcher.game(g)
        if not app or g["status"] == "scheduled":
            continue
        gid = app["game_id"]; prev = state.get(gid)
        try:
            tds = provider.touchdowns(g)
        except Exception as e:   # one game's failed fetch never holds up, or loses, another game's update
            errors.append(f"{gid}: {type(e).__name__}: {str(e)[:100]}"); continue
        for t in tds:
            t["gsis_id"], t["scorer"] = matcher.player(t["team"], t["scorer_name"])
            if t["scorer"] is None:
                t["scorer"] = t["scorer_name"]
        events, changed = merge_game(prev, tds, seen, g.get("published_at"))
        for e in events:                                           # keep player matching current after a correction
            e["gsis_id"], name = matcher.player(e["team"], e["scorer_name"]); e["scorer"] = name or e["scorer_name"]
        head = (g["status"],)          # write only on a touchdown change or a status change (start / final), not every score or clock tick
        if prev and not changed and head == tuple(prev.get("head", [])):
            continue
        seq = int(time.time() * 1000)
        doc = {"kind": "game", "game_id": gid, "week": week, "seq": seq, "source": provider.name, "source_game_id": g["source_game_id"],
               "status": g["status"], "period": g["period"], "clock": g["clock"], "away": g["away"], "home": g["home"],
               "away_score": g["away_score"], "home_score": g["home_score"], "checked_at": seen, "received_at": seen,
               "events": events, "counts": counts(events), "provisional": True}
        state[gid] = {"events": events, "head": list(head)}
        p = outbox / f"{gid}~{seq}.json"; p.write_text(json.dumps(doc, separators=(",", ":"))); written.append(p)
    return written


def heartbeat(outbox: Path, week: int, ok: bool, error: str | None, provider, live: int) -> Path:
    seq = int(time.time() * 1000)
    doc = {"kind": "heartbeat", "week": week, "seq": seq, "checked_at": now_iso(), "ok": ok, "error": error,
           "source": provider.name, "games_live": live, "requests": provider.requests}
    p = outbox / f"_hb~{seq}.json"; p.write_text(json.dumps(doc, separators=(",", ":"))); return p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["poll"])
    ap.add_argument("--provider", choices=["balldontlie", "sim"], required=True); ap.add_argument("--sim-script")
    ap.add_argument("--outbox", required=True); ap.add_argument("--interval", type=float, default=15.0)
    ap.add_argument("--heartbeat", type=float, default=600.0); ap.add_argument("--max-seconds", type=float, default=7000.0)
    ap.add_argument("--until-idle", action="store_true", help="stop when no game is in its live window")
    a = ap.parse_args(argv)
    outbox = Path(a.outbox); outbox.mkdir(parents=True, exist_ok=True)
    state_f = outbox / "state.json"; state = json.loads(state_f.read_text()) if state_f.exists() else {}
    games_json = json.loads((DATA / "games.json").read_text())
    week = json.loads((DATA / "slate.json").read_text()).get("week") if (DATA / "slate.json").exists() else None
    provider = Sim(Path(a.sim_script)) if a.provider == "sim" else BallDontLie(2026, week)
    matcher = Matcher(); start = time.time(); last_hb = 0.0; fails = 0
    while time.time() - start < a.max_seconds:
        live = len(window_games(games_json, datetime.now(ET))) if a.provider != "sim" else 1
        if a.until_idle and not live:
            print("LIVE_DONE no game in its live window", flush=True); return 0
        try:
            for p in poll_once(provider, matcher, state, outbox, week):
                print(f"LIVE_UPDATE {p}", flush=True)
            state_f.write_text(json.dumps(state))
            if state.get("_errors"):
                raise RuntimeError("; ".join(state["_errors"])[:200])   # reported below; the other games were already written
            fails = 0
            if time.time() - last_hb >= a.heartbeat:
                print(f"LIVE_HEARTBEAT {heartbeat(outbox, week, True, None, provider, live)}", flush=True); last_hb = time.time()
        except Exception as e:  # keep polling; the app keeps the last known results and labels the delay
            fails += 1
            print(f"LIVE_ERROR {type(e).__name__}: {str(e)[:160]}", flush=True)
            if fails in (3, 20):
                print(f"LIVE_HEARTBEAT {heartbeat(outbox, week, False, f'{type(e).__name__}: {str(e)[:120]}', provider, live)}", flush=True)
        time.sleep(a.interval if fails < 3 else min(120, a.interval * fails))
    print("LIVE_DONE time limit reached; start the poller again to continue", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
