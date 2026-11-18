"""Sportsbook feed: FanDuel and DraftKings Anytime TD / 2+ TD prices from OddsPapi (v4) -> artifact/data/odds_feed.json.

Run by the scheduled refresh. The API key never goes into the page, a published file, the repo or a log:
  ODDSPAPI_KEY_FILE=<path>  a file holding the key, or the JSON document the admin page saved ({"key": "..."}), or
  ODDSPAPI_KEY=<key>        an environment variable.
With no key this exits 0 and leaves the previous odds_feed.json alone ("no key" is a normal state).

  python3 refresh/odds_feed.py pull            # the scheduled step
  python3 refresh/odds_feed.py probe           # prints the SHAPE of real responses (no key, no prices) for checking

Rules
* Only the books in BOOKS (the ones the family can bet). Other books on the feed are ignored.
* Anytime TD = market "Player To Score TD (incl. overtime)", outcome "Yes" or "1+"; 2+ TDs = outcome "2+".
* Only games that have not kicked off are pulled. Prices of games that have started are kept as they last were.
* captured_at = the time of this pull (the price was posted at the book then). The book's own last-change time is
  kept as changed_at. The first price seen from a book this week is kept as open_american for line moves.
* A failed pull keeps the previous prices and records the error; it never writes an empty file over good prices.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("FB_OUT", ROOT / "artifact" / "data"))
BASE = "https://api.oddspapi.io/v4"
ET = ZoneInfo("America/New_York")
SPORT_ID, TOURNAMENT_ID = 14, 31          # American football, NFL
TD_MARKET = "player to score td (incl. overtime)"
ML_MARKET = "winner (incl. overtime)"     # the game moneyline: outcome "1" = the feed's participant 1, "2" = participant 2
SPREAD_MARKET = "handicap (incl. overtime)"   # one market id per line; the handicap belongs to participant 1
TOTAL_MARKET = "total (incl. overtime)"       # one market id per line; outcomes "Over" / "Under"
BOOKS = {"fanduel": "FanDuel", "draftkings": "DraftKings"}   # feed slug -> name shown in the app
OUTCOME_MARKET = {"yes": "anytime_td", "1+": "anytime_td", "2+": "2plus_td"}
TEAMS = {  # nflverse abbreviation -> words that identify the team in a feed's team name
    "ARI": ["arizona", "cardinals"], "ATL": ["atlanta", "falcons"], "BAL": ["baltimore", "ravens"], "BUF": ["buffalo", "bills"],
    "CAR": ["carolina", "panthers"], "CHI": ["chicago", "bears"], "CIN": ["cincinnati", "bengals"], "CLE": ["cleveland", "browns"],
    "DAL": ["dallas", "cowboys"], "DEN": ["denver", "broncos"], "DET": ["detroit", "lions"], "GB": ["green bay", "packers"],
    "HOU": ["houston", "texans"], "IND": ["indianapolis", "colts"], "JAX": ["jacksonville", "jaguars"], "KC": ["kansas city", "chiefs"],
    "LA": ["rams"], "LAC": ["chargers"], "LV": ["las vegas", "raiders"], "MIA": ["miami", "dolphins"],
    "MIN": ["minnesota", "vikings"], "NE": ["new england", "patriots"], "NO": ["new orleans", "saints"], "NYG": ["giants"],
    "NYJ": ["jets"], "PHI": ["philadelphia", "eagles"], "PIT": ["pittsburgh", "steelers"], "SEA": ["seattle", "seahawks"],
    "SF": ["san francisco", "49ers"], "TB": ["tampa bay", "buccaneers"], "TEN": ["tennessee", "titans"], "WAS": ["washington", "commanders"],
}


class FeedError(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_key() -> str | None:
    f = os.environ.get("ODDSPAPI_KEY_FILE")
    if f and Path(f).exists():
        raw = Path(f).read_text().strip()
        try:
            doc = json.loads(raw)
            doc = doc.get("data", doc) if isinstance(doc, dict) else {}
            raw = str(doc.get("key") or "").strip()
        except ValueError:
            pass
        if raw:
            return raw
    return (os.environ.get("ODDSPAPI_KEY") or "").strip() or None


def scrub(text: str, key: str | None) -> str:
    """No error message, log line or file may carry the key."""
    text = re.sub(r"apiKey=[^&\s\"']+", "apiKey=***", str(text))
    return text.replace(key, "***") if key else text


def http_get(url: str, timeout: float = 60.0):
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "family-board-refresh"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


class Api:
    """OddsPapi v4: the key is the `apiKey` query parameter. A 429 names its own wait (error.retryMs)."""

    def __init__(self, key: str, get=http_get, sleep=time.sleep):
        self.key, self.get, self.sleep, self.calls = key, get, sleep, 0

    def call(self, path: str, **params):
        q = urllib.parse.urlencode({**params, "apiKey": self.key})
        for attempt in range(5):
            self.calls += 1
            try:
                status, body = self.get(f"{BASE}/{path}?{q}")
            except Exception as e:  # network error: the message can contain the URL
                raise FeedError(scrub(f"{path}: {type(e).__name__}: {e}", self.key)) from None
            if status == 429:
                try:
                    wait = float(json.loads(body)["error"]["retryMs"]) / 1000 + 0.3
                except Exception:
                    wait = 2.0
                self.sleep(min(wait, 30)); continue
            if status in (401, 403):
                raise FeedError(f"{path}: the API key was refused (HTTP {status}). Check the key on the Admin page.")
            if status == 404:
                return None          # nothing there (e.g. a fixture with no board yet): not an error
            if status >= 500 and attempt < 3:
                self.sleep(2.0 * (attempt + 1)); continue   # the service's own errors are often momentary
            if status != 200:
                raise FeedError(scrub(f"{path}: HTTP {status}: {body[:160]}", self.key))
            try:
                return json.loads(body)
            except ValueError:
                raise FeedError(f"{path}: the reply was not JSON") from None
        raise FeedError(f"{path}: still rate limited after 5 tries")


# ---------------------------------------------------------------- matching

def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", " ", s)
    return re.sub(r"[^a-z]", "", s)


def flip(name: str) -> str:
    """'Kupp, Cooper' -> 'Cooper Kupp'; 'Harrison Jr., Marvin' -> 'Marvin Harrison Jr.'"""
    name = str(name or "").strip()
    if "," in name:
        last, first = [x.strip() for x in name.split(",", 1)]
        return f"{first} {last}".strip()
    return name


def strings(x) -> list[str]:
    if isinstance(x, str):
        return [x.lower()]
    if isinstance(x, dict):
        return [s for v in x.values() for s in strings(v)]
    if isinstance(x, list):
        return [s for v in x for s in strings(v)]
    return []


def team_in(abbr: str, text: list[str]) -> bool:
    words = TEAMS.get(abbr, [])
    return any(w in s for w in words for s in text)


def match_fixture(fx: dict, games: list[dict]) -> dict | None:
    """A feed fixture -> the app's game: both team names present and kickoff within 36 hours (two teams meet once a
    week, and a flexed game moves by hours while the schedule file can lag behind). None if not exactly one."""
    try:
        start = datetime.fromisoformat(str(fx.get("startTime")).replace("Z", "+00:00"))
    except ValueError:
        return None
    text = strings({k: v for k, v in fx.items() if k != "bookmakerOdds"})
    hits = []
    for g in games:
        kick = datetime.fromisoformat(g["kickoff_et"]).replace(tzinfo=ET)
        if abs((kick - start).total_seconds()) <= 36 * 3600 and team_in(g["away"], text) and team_in(g["home"], text):
            hits.append(g)
    return hits[0] if len(hits) == 1 else None


class Players:
    """Slate candidates of one game, by normalised full name. A name two players share is left unmatched."""

    def __init__(self, slate_game: dict):
        self.by = {}
        for t in slate_game.get("teams", []):
            for c in t.get("candidates", []):
                k = norm(c.get("full_name") or c.get("player"))
                self.by[k] = None if k in self.by else {**c, "team": c.get("team") or t.get("team")}

    def find(self, feed_name: str):
        return self.by.get(norm(flip(feed_name)))


def to_american(price: dict):
    """The feed gives decimal odds (`price`) and, per its docs, `priceAmerican`. Decimal is the source of truth here."""
    try:
        dec = float(price.get("price"))
    except (TypeError, ValueError):
        return None
    if not dec > 1.0:   # some books send 0 or 1.0 for a price that isn't offered
        return None
    am = round((dec - 1) * 100) if dec >= 2 else round(-100 / (dec - 1))
    return am if abs(am) >= 100 and abs(am) <= 100000 else None


def td_rows(odds: dict, catalog: dict, game: dict, players: Players, pulled_at: str) -> tuple[list[dict], list[str], set]:
    """One fixture's odds -> price rows for BOOKS. catalog = {"market": {id: name}, "outcome": {(mid, oid): name}}."""
    rows, unmatched, seen_books = [], [], set()
    for slug, book in (odds.get("bookmakerOdds") or {}).items():
        name = BOOKS.get(str(slug).lower())
        if not name or not isinstance(book, dict) or book.get("suspended"):
            continue
        for mid, market in (book.get("markets") or {}).items():
            if str(catalog["market"].get(str(mid), "")).strip().lower() != TD_MARKET:
                continue
            for oid, outcome in (market.get("outcomes") or {}).items():
                mk = OUTCOME_MARKET.get(str(catalog["outcome"].get((str(mid), str(oid)), "")).strip().lower())
                if not mk:
                    continue
                for pid, price in (outcome.get("players") or {}).items():
                    if str(pid) == "0" or not isinstance(price, dict) or not price.get("active"):
                        continue
                    am = to_american(price)
                    if am is None:
                        continue
                    seen_books.add(name)
                    c = players.find(price.get("playerName"))
                    if not c:
                        unmatched.append(f"{flip(price.get('playerName'))} ({name})"); continue
                    rows.append({"game_id": game["game_id"], "gsis_id": c["gsis_id"], "player": c.get("full_name") or c.get("player"),
                                 "team": c.get("team"), "book": name, "market": mk, "american": am, "captured_at": pulled_at,
                                 "changed_at": price.get("bookmakerChangedAt") or price.get("changedAt"),
                                 "time_source": "sportsbook feed", "source": "OddsPapi feed"})
    # one row per player/book/market: several market ids can carry the same price
    best = {}
    for r in rows:
        best[(r["gsis_id"], r["book"], r["market"])] = r
    return list(best.values()), sorted(set(unmatched)), seen_books


def moneylines(odds: dict, catalog: dict, game: dict, fx: dict, pulled_at: str) -> list[dict]:
    """One fixture's game moneyline per book in BOOKS: {game_id, book, away, home, away_american, home_american, ...}.
    Which side is home is read from the feed's team names, never assumed from participant order."""
    side = {}
    for n in ("1", "2"):
        name = [str(fx.get(f"participant{n}Name") or "").lower()]
        hit = [s for s in ("away", "home") if team_in(game[s], name)]
        if len(hit) == 1:
            side[n] = hit[0]
    if sorted(side.values()) != ["away", "home"]:
        return []
    out = []
    for slug, book in (odds.get("bookmakerOdds") or {}).items():
        name = BOOKS.get(str(slug).lower())
        if not name or not isinstance(book, dict) or book.get("suspended"):
            continue
        for mid, market in (book.get("markets") or {}).items():
            if str(catalog["market"].get(str(mid), "")).strip().lower() != ML_MARKET or market.get("marketActive") is False:
                continue
            got = {}; changed = []
            for oid, outcome in (market.get("outcomes") or {}).items():
                s = side.get(str(catalog["outcome"].get((str(mid), str(oid)), "")).strip())
                price = (outcome.get("players") or {}).get("0")     # a match market is keyed "0" (no player)
                if not s or not isinstance(price, dict) or not price.get("active"):
                    continue
                am = to_american(price)
                if am is not None:
                    got[s] = am; changed.append(price.get("bookmakerChangedAt") or price.get("changedAt"))
            if len(got) == 2:   # both sides or nothing: half a moneyline is not shown
                out.append({"game_id": game["game_id"], "book": name, "away": game["away"], "home": game["home"],
                            "away_american": got["away"], "home_american": got["home"], "captured_at": pulled_at,
                            "changed_at": max([c for c in changed if c], default=None), "source": "OddsPapi feed"})
    return list({r["book"]: r for r in out}.values())


def _main_line(cands: list):
    """Of a book's lines for one market, the one it marks as its main line; if none is marked, the most even-priced."""
    if not cands:
        return None
    marked = [c for c in cands if c["main"]]
    return (marked or sorted(cands, key=lambda c: abs(c["a"] - c["b"])))[0] if (marked or cands) else None


def game_lines(odds: dict, catalog: dict, game: dict, fx: dict, pulled_at: str) -> list[dict]:
    """One fixture's main spread and total per book in BOOKS (the moneyline is added by the caller).
    spread: {home_line, home_american, away_american}  (away line = -home_line)
    total:  {line, over_american, under_american}
    Both sides must be posted and active, or that market is left out for the book."""
    side = {}
    for n in ("1", "2"):
        hit = [s for s in ("away", "home") if team_in(game[s], [str(fx.get(f"participant{n}Name") or "").lower()])]
        if len(hit) == 1:
            side[n] = hit[0]
    if sorted(side.values()) != ["away", "home"]:
        return []
    out = []
    for slug, book in (odds.get("bookmakerOdds") or {}).items():
        name = BOOKS.get(str(slug).lower())
        if not name or not isinstance(book, dict) or book.get("suspended"):
            continue
        sp, tot = [], []
        for mid, market in (book.get("markets") or {}).items():
            mname = str(catalog["market"].get(str(mid), "")).strip().lower()
            if mname not in (SPREAD_MARKET, TOTAL_MARKET) or market.get("marketActive") is False:
                continue
            try:
                line = float(catalog["handicap"].get(str(mid)))
            except (TypeError, ValueError):
                continue
            got, main, changed = {}, False, []
            for oid, outcome in (market.get("outcomes") or {}).items():
                oname = str(catalog["outcome"].get((str(mid), str(oid)), "")).strip()
                price = (outcome.get("players") or {}).get("0")
                if not isinstance(price, dict) or not price.get("active"):
                    continue
                am = to_american(price)
                if am is None:
                    continue
                got[oname.lower()] = am; main = main or bool(price.get("mainLine")); changed.append(price.get("bookmakerChangedAt") or price.get("changedAt"))
            ch = max([c for c in changed if c], default=None)
            if mname == SPREAD_MARKET and "1" in got and "2" in got:
                # the handicap is participant 1's; turn it into the HOME team's line
                home_line = line if side["1"] == "home" else -line
                h, a = (got["1"], got["2"]) if side["1"] == "home" else (got["2"], got["1"])
                sp.append({"main": main, "a": h, "b": a, "v": {"home_line": home_line, "home_american": h, "away_american": a}, "ch": ch})
            if mname == TOTAL_MARKET and "over" in got and "under" in got:
                tot.append({"main": main, "a": got["over"], "b": got["under"], "v": {"line": line, "over_american": got["over"], "under_american": got["under"]}, "ch": ch})
        s, tl = _main_line(sp), _main_line(tot)
        if s or tl:
            out.append({"game_id": game["game_id"], "book": name, "away": game["away"], "home": game["home"], "spread": s and s["v"], "total": tl and tl["v"],
                        "captured_at": pulled_at, "changed_at": max([c["ch"] for c in (s, tl) if c and c["ch"]], default=None), "source": "OddsPapi feed"})
    return out


def load_catalog(api: Api) -> dict:
    cat = api.call("markets", sportId=SPORT_ID) or []
    cat = cat if isinstance(cat, list) else cat.get("markets", cat.get("data", []))
    return {"handicap": {str(m.get("marketId")): m.get("handicap") for m in cat},
            "market": {str(m.get("marketId")): m.get("marketName") for m in cat},
            "outcome": {(str(m.get("marketId")), str(o.get("outcomeId"))): o.get("outcomeName") for m in cat for o in (m.get("outcomes") or [])}}


def key_of(r: dict) -> str:
    return f"{r['gsis_id']}|{r['book']}|{r['market']}"


def pull(api: Api, games: list[dict], slate: dict, prev: dict | None, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc); pulled_at = now.isoformat(timespec="seconds")
    week = slate.get("week"); prev = prev if prev and prev.get("week") == week else None
    slate_by = {g["game_id"]: g for g in slate.get("games", [])}
    wk_games = [g for g in games if g.get("week") == week and g["game_id"] in slate_by]
    open_games = [g for g in wk_games if datetime.fromisoformat(g["kickoff_et"]).replace(tzinfo=ET) > now]
    old = {key_of(r): r for r in (prev or {}).get("rows", [])}
    old_ml = {(m["game_id"], m["book"]): m for m in (prev or {}).get("moneylines", [])}
    old_gl = {(m["game_id"], m["book"]): m for m in (prev or {}).get("game_lines", [])}
    kickoffs = dict((prev or {}).get("kickoffs", {}))   # the feed's kickoff per game (Eastern), for flexed games
    out = {"source": "OddsPapi v4", "books": sorted(BOOKS.values()), "week": week, "pulled_at": pulled_at, "ok": True, "error": None,
           "rows": [], "moneylines": [], "game_lines": [], "unmatched": [], "coverage": {}, "requests": 0}
    if not open_games:
        out.update(rows=list(old.values()), moneylines=list(old_ml.values()), game_lines=list(old_gl.values()), kickoffs=dict((prev or {}).get("kickoffs", {})), coverage=(prev or {}).get("coverage", {}), note="No game left to kick off this week.")
        return out
    days = [datetime.fromisoformat(g["kickoff_et"]).replace(tzinfo=ET).astimezone(timezone.utc) for g in open_games]
    fixtures = api.call("fixtures", sportId=SPORT_ID, tournamentId=TOURNAMENT_ID,
                        **{"from": (min(days) - timedelta(days=1)).strftime("%Y-%m-%d"), "to": (max(days) + timedelta(days=1)).strftime("%Y-%m-%d")})
    fixtures = fixtures or []
    fixtures = fixtures if isinstance(fixtures, list) else fixtures.get("fixtures", fixtures.get("data", []))
    catalog = load_catalog(api)
    if TD_MARKET not in {str(v).strip().lower() for v in catalog["market"].values()}:
        raise FeedError("the market list has no 'Player To Score TD (incl. overtime)' market")
    fresh, unmatched, no_fixture, no_board, per_game, books_seen, failed = {}, [], [], [], {}, set(), []
    fresh_ml = {}; fresh_gl = {}
    for g in open_games:
        fx = next((f for f in fixtures if (match_fixture(f, [g]) or {}).get("game_id") == g["game_id"]), None)
        if not fx:
            no_fixture.append(g["game_id"]); continue
        try:   # the feed's own kickoff time: build_data.py uses it when the schedule file is behind a flex
            kickoffs[g["game_id"]] = datetime.fromisoformat(str(fx.get("startTime")).replace("Z", "+00:00")).astimezone(ET).strftime("%Y-%m-%dT%H:%M")
        except ValueError:
            pass
        if kickoffs.get(g["game_id"]) and datetime.fromisoformat(kickoffs[g["game_id"]]).replace(tzinfo=ET) <= now:
            continue   # by the feed's own clock this game has kicked off (schedule file behind a flex): keep its pregame prices
        if fx.get("hasOdds") is False:   # the feed says no book has a board for this game yet: don't spend a request on it
            no_board.append(g["game_id"]); continue
        try:
            # ask only for the books the family uses (smaller reply); everything is filtered again on our side
            api.sleep(1.0)   # the service limits bursts: without a pause every other request is refused and retried
            odds = api.call("odds", fixtureId=fx.get("fixtureId"), bookmakers=",".join(BOOKS)) or {}
        except FeedError as e:   # one game's failure never loses the other games' prices
            failed.append(f"{g['game_id']}: {e}"); continue
        for m in moneylines(odds, catalog, g, fx, pulled_at):
            o = old_ml.get((m["game_id"], m["book"]))
            if o:   # the first moneyline seen from this book this week, for line moves
                m["open_away_american"] = o.get("open_away_american", o["away_american"]); m["open_home_american"] = o.get("open_home_american", o["home_american"])
                m["open_captured_at"] = o.get("open_captured_at", o["captured_at"])
            fresh_ml[(m["game_id"], m["book"])] = m
        for m in game_lines(odds, catalog, g, fx, pulled_at):
            o = old_gl.get((m["game_id"], m["book"]))
            if o:   # the first spread / total seen from this book this week, for line moves
                m["open_spread"] = o.get("open_spread") or o.get("spread"); m["open_total"] = o.get("open_total") or o.get("total")
                m["open_captured_at"] = o.get("open_captured_at", o["captured_at"])
            # every change to the spread, total or moneyline this week, oldest first (for the Lines tab's movement line)
            mlr = fresh_ml.get((m["game_id"], m["book"])) or {}
            snap = {"at": pulled_at, "home_line": (m["spread"] or {}).get("home_line"), "total": (m["total"] or {}).get("line"),
                    "ml_home": mlr.get("home_american"), "ml_away": mlr.get("away_american")}
            hist = list((o or {}).get("history") or [])
            if not hist and o:   # a record from before history was kept: start from its opening values
                op = {"at": o.get("open_captured_at", o["captured_at"]), "home_line": ((o.get("open_spread") or o.get("spread")) or {}).get("home_line"),
                      "total": ((o.get("open_total") or o.get("total")) or {}).get("line"), "ml_home": None, "ml_away": None}
                hist.append(op)
            same = hist and all(hist[-1].get(k) == snap[k] for k in ("home_line", "total", "ml_home", "ml_away"))
            if not same:
                hist.append(snap)
            m["history"] = hist[-40:]
            fresh_gl[(m["game_id"], m["book"])] = m
        rows, um, seen = td_rows(odds, catalog, g, Players(slate_by[g["game_id"]]), pulled_at)
        per_game[g["game_id"]] = len(rows); unmatched += [f"{g['game_id']}: {x}" for x in um]; books_seen |= seen
        for r in rows:
            fresh[key_of(r)] = r
    pulled_games = set(per_game)
    merged = {}
    for k, r in old.items():
        # kept as it last was when its game has kicked off or wasn't reached this time; a game pulled now is replaced whole,
        # so a price the book took down is not shown as current
        if r.get("game_id") not in pulled_games:
            merged[k] = r
    for k, r in fresh.items():
        o = old.get(k)
        if o:   # first price seen from this book this week, for line moves
            r["open_american"] = o.get("open_american", o.get("american")); r["open_captured_at"] = o.get("open_captured_at", o.get("captured_at"))
        merged[k] = r
    ml = {k: m for k, m in old_ml.items() if m["game_id"] not in pulled_games}; ml.update(fresh_ml)
    out.update(rows=sorted(merged.values(), key=lambda r: (r["game_id"], r["player"], r["book"], r["market"])), unmatched=unmatched[:200],
               kickoffs=kickoffs, moneylines=sorted(ml.values(), key=lambda m: (m["game_id"], m["book"])),
               game_lines=sorted(({k: m for k, m in old_gl.items() if m["game_id"] not in pulled_games} | fresh_gl).values(), key=lambda m: (m["game_id"], m["book"])),
               coverage={"games_open": len(open_games), "games_with_prices": sum(1 for n in per_game.values() if n), "prices": len(fresh),
                         "players": len({r["gsis_id"] for r in fresh.values()}), "moneylines": len(fresh_ml), "game_lines": len(fresh_gl), "books": sorted(books_seen),
                         "no_fixture": no_fixture, "no_board": no_board, "failed": failed}, requests=api.calls)
    missing = sorted(set(BOOKS.values()) - books_seen)
    if failed and not per_game:   # every game's request failed: a failed pull (the caller keeps the previous prices)
        raise FeedError(failed[0])
    if missing and fresh:
        out["note"] = f"No Anytime TD prices from {', '.join(missing)} on this pull."
    if not fresh and no_board and len(no_board) + len(no_fixture) == len(open_games):
        out["note"] = "The books haven't posted prices for this week's games yet."
    elif not fresh:
        out["note"] = "The feed returned no FanDuel or DraftKings Anytime TD prices for the games still to come."
    return out


def archive(prev: dict | None, week) -> None:
    """When the slate week moves on, last week's final pregame prices go to odds_feed_history.json (for weekly grading)."""
    if not prev or prev.get("week") in (None, week) or not (prev.get("rows") or prev.get("game_lines")):
        return
    f = OUT / "odds_feed_history.json"
    try:
        hist = json.loads(f.read_text()) if f.exists() else {"rows": []}
    except ValueError:
        hist = {"rows": []}
    hist.setdefault("rows", [])
    have = {(r.get("week"), r["gsis_id"], r["book"], r["market"]) for r in hist["rows"]}
    keep = ("game_id", "gsis_id", "player", "team", "book", "market", "american", "captured_at", "open_american", "open_captured_at")
    hist["rows"] += [{"week": prev["week"], **{k: r[k] for k in keep if k in r}} for r in prev["rows"]
                     if (prev["week"], r["gsis_id"], r["book"], r["market"]) not in have]
    # the week's last pregame game lines too (Lines tab: past weeks by book)
    hist.setdefault("games", [])
    have_g = {(r.get("week"), r["game_id"], r["book"]) for r in hist["games"]}
    mls = {(m["game_id"], m["book"]): m for m in prev.get("moneylines", [])}
    for m in prev.get("game_lines", []):
        if (prev["week"], m["game_id"], m["book"]) in have_g:
            continue
        ml = mls.get((m["game_id"], m["book"])) or {}
        hist["games"].append({"week": prev["week"], "game_id": m["game_id"], "book": m["book"], "away": m.get("away"), "home": m.get("home"),
                              "spread": m.get("spread"), "total": m.get("total"), "open_spread": m.get("open_spread"), "open_total": m.get("open_total"),
                              "ml": {"away_american": ml.get("away_american"), "home_american": ml.get("home_american")} if ml else None,
                              "captured_at": m.get("captured_at")})
    tmp = OUT / "odds_feed_history.json.tmp"; tmp.write_text(json.dumps(hist, separators=(",", ":"))); tmp.replace(f)


def write(doc: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "odds_feed.json.tmp"; tmp.write_text(json.dumps(doc, separators=(",", ":"))); tmp.replace(OUT / "odds_feed.json")


def shape(x, depth=0):
    """Structure only: key names and value types, never values (used by `probe`)."""
    if isinstance(x, dict):
        ks = list(x.items())
        return {str(k) if depth < 3 or not re.fullmatch(r"[\d]+", str(k)) else "<id>": shape(v, depth + 1) for k, v in ks[:6]} | ({"...": f"{len(ks)} keys"} if len(ks) > 6 else {})
    if isinstance(x, list):
        return [shape(x[0], depth + 1), f"... {len(x)} items"] if x else []
    return type(x).__name__


def main(argv=None) -> int:
    cmd = (argv or sys.argv[1:] or ["pull"])[0]
    key = read_key()
    prev_f = OUT / "odds_feed.json"
    prev = json.loads(prev_f.read_text()) if prev_f.exists() else None
    if not key:
        print("odds_feed: no key (enter it on the Admin page, Sportsbook feed); nothing pulled"); return 0
    games = json.loads((OUT / "games.json").read_text()); slate = json.loads((OUT / "slate.json").read_text())
    api = Api(key)
    if cmd == "pull":
        archive(prev, slate.get("week"))
    try:
        if cmd == "probe":
            fx = api.call("fixtures", sportId=SPORT_ID, tournamentId=TOURNAMENT_ID,
                          **{"from": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "to": (datetime.now(timezone.utc) + timedelta(days=8)).strftime("%Y-%m-%d")})
            fxl = fx if isinstance(fx, list) else fx.get("fixtures", fx.get("data", []))
            print("fixtures:", json.dumps(shape(fx))[:1500])
            cat = load_catalog(api); td_ids = [m for m, n in cat["market"].items() if str(n).strip().lower() == TD_MARKET]
            print("TD market ids:", td_ids, "outcomes:", sorted({cat["outcome"].get((m, o)) for (m, o) in cat["outcome"] if m in td_ids}, key=str))
            if fxl:
                fxl = sorted(fxl, key=lambda f: (not f.get("hasOdds"), str(f.get("startTime"))))
                print("first fixture keys:", sorted(fxl[0].keys()), "| names:", fxl[0].get("participant1Name"), "v", fxl[0].get("participant2Name"), fxl[0].get("startTime"), "hasOdds", fxl[0].get("hasOdds"))
                od = api.call("odds", fixtureId=fxl[0].get("fixtureId")) or {}; bo = od.get("bookmakerOdds") or {}
                print("books on first fixture:", len(bo), "| wanted present:", [b for b in BOOKS if b in bo], "| similar:", [b for b in bo if "duel" in b or "draft" in b])
                for b in BOOKS:
                    if b in bo:
                        print(b, json.dumps(shape(bo[b]))[:1200])
            print("requests:", api.calls); return 0
        doc = pull(api, games, slate, prev)
    except FeedError as e:
        msg = scrub(str(e), key)
        # keep the last good prices; record the failure so the Admin page can show it
        keep = prev if prev and prev.get("week") == slate.get("week") else {"source": "OddsPapi v4", "week": slate.get("week"), "rows": [], "pulled_at": None, "coverage": {}}
        keep.update(ok=False, error=msg, failed_at=now_iso()); write(keep)
        print("odds_feed FAILED (previous prices kept):", msg); return 0
    write(doc)
    print("odds_feed:", json.dumps({"prices": len(doc["rows"]), **doc["coverage"], "unmatched": len(doc["unmatched"]), "requests": doc["requests"], "note": doc.get("note")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
