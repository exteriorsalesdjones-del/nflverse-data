"""Sportsbook feed (refresh/odds_feed.py) on SIMULATED OddsPapi responses shaped like its documented v4 API.
Every price here is made up. Run: python3 tests/test_odds_feed.py"""
import json, sys, urllib.parse
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh"))
import odds_feed as OF  # noqa: E402

res = []
def check(n, ok, d=""):
    res.append(bool(ok)); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""))

KEY = "sk_test_SECRET123"
games = [{"game_id": "2026_11_BUF_NYJ", "week": 11, "away": "BUF", "home": "NYJ", "kickoff_et": "2026-11-22T13:00"},
         {"game_id": "2026_11_CAR_NO", "week": 11, "away": "CAR", "home": "NO", "kickoff_et": "2026-11-22T13:00"},
         {"game_id": "2026_11_KC_DEN", "week": 11, "away": "KC", "home": "DEN", "kickoff_et": "2026-11-19T20:15"}]
cand = lambda i, n, t: {"gsis_id": i, "full_name": n, "team": t}
slate = {"week": 11, "games": [
    {"game_id": "2026_11_BUF_NYJ", "teams": [{"team": "BUF", "candidates": [cand("00-1", "James Cook", "BUF"), cand("00-2", "Marvin Harrison Jr.", "BUF")]}, {"team": "NYJ", "candidates": [cand("00-3", "Breece Hall", "NYJ")]}]},
    {"game_id": "2026_11_CAR_NO", "teams": [{"team": "CAR", "candidates": [cand("00-4", "Chuba Hubbard", "CAR")]}, {"team": "NO", "candidates": [cand("00-5", "Alvin Kamara", "NO")]}]},
    {"game_id": "2026_11_KC_DEN", "teams": [{"team": "KC", "candidates": [cand("00-6", "Travis Kelce", "KC")]}, {"team": "DEN", "candidates": []}]}]}
FIX = [{"fixtureId": "fxA", "startTime": "2026-11-22T18:00:00.000Z", "participant1Name": "New York Jets", "participant2Name": "Buffalo Bills"},
       {"fixtureId": "fxB", "startTime": "2026-11-22T18:00:00.000Z", "participant1Name": "New Orleans Saints", "participant2Name": "Carolina Panthers"},
       {"fixtureId": "fxC", "startTime": "2026-11-20T01:15:00.000Z", "participant1Name": "Denver Broncos", "participant2Name": "Kansas City Chiefs"},
       {"fixtureId": "fxZ", "startTime": "2026-11-22T18:00:00.000Z", "participant1Name": "Miami Dolphins", "participant2Name": "New York Giants"}]
CAT = [{"marketId": 141, "marketName": "Winner (incl. overtime)", "outcomes": [{"outcomeId": 142, "outcomeName": "2"}, {"outcomeId": 141, "outcomeName": "1"}]},
       {"marketId": 143, "marketName": "Regular Time Result", "outcomes": [{"outcomeId": 143, "outcomeName": "1"}, {"outcomeId": 144, "outcomeName": "X"}, {"outcomeId": 145, "outcomeName": "2"}]},
       {"marketId": 14388, "marketName": "Player To Score TD (incl. overtime)", "outcomes": [{"outcomeId": 1, "outcomeName": "Yes"}, {"outcomeId": 2, "outcomeName": "No"}]},
       {"marketId": 144637, "marketName": "Player To Score TD (incl. overtime)", "outcomes": [{"outcomeId": 11, "outcomeName": "1+"}, {"outcomeId": 12, "outcomeName": "2+"}, {"outcomeId": 13, "outcomeName": "3+"}]},
       {"marketId": 500, "marketName": "Player First TD Scorer", "outcomes": [{"outcomeId": 1, "outcomeName": "Yes"}]},
       {"marketId": 600, "marketName": "Player Receiving Yards", "handicap": 29.5, "outcomes": [{"outcomeId": 1, "outcomeName": "Over"}]}]
P = lambda name, dec, active=True: {"playerName": name, "price": dec, "active": active, "changedAt": "2026-11-17T10:00:00Z", "bookmakerChangedAt": "2026-11-17T09:58:00Z"}
def board(scale=1.0):
    return {"bookmakerOdds": {
        "fanduel": {"markets": {"141": {"marketActive": True, "outcomes": {"141": {"players": {"0": P("", 2.9 * scale)}}, "142": {"players": {"0": P("", 1.43)}}}},
                                "143": {"outcomes": {"143": {"players": {"0": P("", 3.1)}}, "144": {"players": {"0": P("", 15.0)}}, "145": {"players": {"0": P("", 1.5)}}}},
                                "14388": {"outcomes": {"1": {"players": {"0": P("", 1.9), "77": P("Cook, James", 1.8 * scale), "78": P("Harrison Jr., Marvin", 3.0), "79": P("Nobody, Joe", 5.0), "80": P("Hall, Breece", 2.5, active=False)}},
                                                        "2": {"players": {"77": P("Cook, James", 1.9)}}}},
                                "500": {"outcomes": {"1": {"players": {"77": P("Cook, James", 7.0)}}}},
                                "600": {"outcomes": {"1": {"players": {"77": P("Cook, James", 1.87)}}}}}},
        "draftkings": {"markets": {"141": {"outcomes": {"141": {"players": {"0": P("", 2.85)}}, "142": {"players": {"0": P("", 1.444, active=False)}}}},
                                   "144637": {"outcomes": {"11": {"players": {"77": P("Cook, James", 1.87), "81": P("Hall, Breece", 0)}},
                                                           "12": {"players": {"77": P("Cook, James", 6.5)}},
                                                           "13": {"players": {"77": P("Cook, James", 21.0)}}}}}},
        "betfirst.be": {"markets": {"14388": {"outcomes": {"1": {"players": {"77": P("Cook, James", 2.4)}}}}}},
        "caesars": {"suspended": True, "markets": {"14388": {"outcomes": {"1": {"players": {"77": P("Cook, James", 2.2)}}}}}}}}
calls = []
def make_get(odds_by_fx, fail=None, limit_first=False):
    state = {"limited": limit_first}
    def get(url, timeout=60):
        u = urllib.parse.urlparse(url); q = dict(urllib.parse.parse_qsl(u.query)); path = u.path.split("/v4/")[1]; calls.append((path, q))
        assert q.get("apiKey") == KEY
        if state["limited"]:
            state["limited"] = False; return 429, json.dumps({"error": {"retryMs": 10}})
        if fail and path == fail[0] and (len(fail) < 3 or q.get("fixtureId") == fail[2]):
            return fail[1], f'{{"error":"bad","url":"{url}"}}'
        if path == "fixtures": return 200, json.dumps(FIX)
        if path == "markets": return 200, json.dumps(CAT)
        if path == "odds": return 200, json.dumps(odds_by_fx.get(q["fixtureId"], {"bookmakerOdds": {}}))
        return 404, "{}"
    return get
NOW = datetime(2026, 11, 21, 15, 0, tzinfo=timezone.utc)   # Saturday: the Thursday game has been played
slept = []
api = OF.Api(KEY, get=make_get({"fxA": board(), "fxB": {"bookmakerOdds": {}}}, limit_first=True), sleep=slept.append)
doc = OF.pull(api, games, slate, None, NOW)
by = {(r["player"], r["book"], r["market"]): r for r in doc["rows"]}
check("FanDuel and DraftKings anytime prices, converted from decimal to American", by[("James Cook", "FanDuel", "anytime_td")]["american"] == -125 and by[("James Cook", "DraftKings", "anytime_td")]["american"] == -115 and by[("Marvin Harrison Jr.", "FanDuel", "anytime_td")]["american"] == 200,
      str({k: v["american"] for k, v in by.items()}))
check('outcome "2+" becomes the 2+ TDs market; "3+", "No", First TD and yardage markets are ignored', by[("James Cook", "DraftKings", "2plus_td")]["american"] == 550 and len(doc["rows"]) == 4, f"{len(doc['rows'])} rows")
check("other books (and a suspended book) are ignored", {r["book"] for r in doc["rows"]} == {"FanDuel", "DraftKings"})
check("inactive prices, zero prices and the game line (player 0) are skipped", not any(r["player"] == "Breece Hall" for r in doc["rows"]))
check('"Last, First" names with a suffix are matched to the app\'s player id', by[("Marvin Harrison Jr.", "FanDuel", "anytime_td")]["gsis_id"] == "00-2")
check("a name that matches no slate player is reported, not guessed", doc["unmatched"] == ["2026_11_BUF_NYJ: Joe Nobody (FanDuel)"], str(doc["unmatched"]))
check("each row is tied to its game, timed at the pull, and keeps the book's own change time", all(r["game_id"] == "2026_11_BUF_NYJ" and r["captured_at"] == NOW.isoformat(timespec="seconds") and r["changed_at"] == "2026-11-17T09:58:00Z" and r["time_source"] == "sportsbook feed" for r in doc["rows"]))
check("a game that has kicked off is not requested", not any(q.get("fixtureId") == "fxC" for p, q in calls) and doc["coverage"]["games_open"] == 2)
check("a 429 is retried after the wait the API names", slept and abs(slept[0] - 0.31) < 0.01, str(slept))
check("requests per pull: fixtures + markets + one per open game", doc["requests"] == 5, str(doc["requests"]))   # 1 limited + 4
# game moneylines (FIX[0]: participant 1 = New York Jets = home, participant 2 = Buffalo Bills = away)
ml = {m["book"]: m for m in doc["moneylines"]}
check("moneyline: the feed's outcome 1/2 is mapped to home/away by team name, converted to American", ml["FanDuel"]["home"] == "NYJ" and ml["FanDuel"]["home_american"] == 190 and ml["FanDuel"]["away"] == "BUF" and ml["FanDuel"]["away_american"] == -233 and ml["FanDuel"]["game_id"] == "2026_11_BUF_NYJ", json.dumps(ml["FanDuel"]))
check("moneyline: a book with only one side active is left out; the 3-way regular-time market is ignored", list(ml) == ["FanDuel"] and len(doc["moneylines"]) == 1)
# second pull: a price moved; the first price is kept as the opening price
later = datetime(2026, 11, 21, 16, 0, tzinfo=timezone.utc)
doc2 = OF.pull(OF.Api(KEY, get=make_get({"fxA": board(scale=1.1), "fxB": {"bookmakerOdds": {}}})), games, slate, doc, later)
r = next(x for x in doc2["rows"] if (x["player"], x["book"], x["market"]) == ("James Cook", "FanDuel", "anytime_td"))
check("a moved price keeps the first price as the opening price (line moves)", r["american"] == -102 and r["open_american"] == -125 and r["open_captured_at"] == doc["rows"][0]["captured_at"], json.dumps({k: r.get(k) for k in ("american", "open_american", "open_captured_at")}))
m2 = doc2["moneylines"][0]
check("moneyline: a move keeps the opening prices", m2["home_american"] == 219 and m2["open_home_american"] == 190 and m2["open_away_american"] == -233, json.dumps({k: m2[k] for k in m2 if "american" in k}))
# a price the book took down disappears; a game that could not be pulled keeps its last prices
b3 = board(); del b3["bookmakerOdds"]["draftkings"]
doc3 = OF.pull(OF.Api(KEY, get=make_get({"fxA": b3})), games, slate, doc2, later)
check("a price the book removed is no longer shown", not any(x["book"] == "DraftKings" for x in doc3["rows"]) and "DraftKings" in doc3.get("note", ""), doc3.get("note", ""))
doc4 = OF.pull(OF.Api(KEY, get=make_get({"fxB": {"bookmakerOdds": {}}}, fail=("odds", 500, "fxA"))), games, slate, doc2, later)
check("one game's failed request keeps that game's last prices and is reported", len(doc4["rows"]) == 4 and doc4["coverage"]["failed"] and "2026_11_BUF_NYJ" in doc4["coverage"]["failed"][0], str(doc4["coverage"]["failed"])[:120])
# after kickoff nothing is requested and the last pregame prices stay
calls.clear(); after = datetime(2026, 11, 22, 19, 0, tzinfo=timezone.utc)
doc5 = OF.pull(OF.Api(KEY, get=make_get({})), games, slate, doc2, after)
check("after the last kickoff no request is made and the pregame prices and moneylines are kept", calls == [] and len(doc5["rows"]) == 4 and len(doc5["moneylines"]) == 1)
check("a new week starts clean (last week's prices are not carried over)", OF.pull(OF.Api(KEY, get=make_get({})), games, {**slate, "week": 12, "games": []}, doc2, after)["rows"] == [])
# hasOdds: a game with no board yet costs no request, and its earlier prices (if any) are kept
calls.clear(); FIX[0]["hasOdds"] = False; FIX[1]["hasOdds"] = True
doc6 = OF.pull(OF.Api(KEY, get=make_get({"fxA": board(), "fxB": {"bookmakerOdds": {}}})), games, slate, doc2, later)
check("a game the feed marks hasOdds=false is not requested; its earlier prices stay", not any(q.get("fixtureId") == "fxA" for p, q in calls) and doc6["coverage"]["no_board"] == ["2026_11_BUF_NYJ"] and len(doc6["rows"]) == 4 and doc6["requests"] == 3, f"requests={doc6['requests']}")
FIX[1]["hasOdds"] = False
doc7 = OF.pull(OF.Api(KEY, get=make_get({})), games, slate, None, later)
check("no boards posted yet: two requests, a plain note, not an error", doc7["requests"] == 2 and doc7["ok"] and "haven't posted" in doc7["note"] and doc7["rows"] == [], doc7.get("note"))
del FIX[0]["hasOdds"]; del FIX[1]["hasOdds"]
# the key never reaches an error message, a file or the output
try:
    OF.Api(KEY, get=make_get({}, fail=("fixtures", 500))).call("fixtures", sportId=14); msg = ""
except OF.FeedError as e:
    msg = str(e)
check("an error message never contains the key", msg and KEY not in msg and "apiKey=***" in msg, msg[:120])
try:
    OF.Api(KEY, get=make_get({}, fail=("fixtures", 401))).call("fixtures"); msg = ""
except OF.FeedError as e:
    msg = str(e)
check("a refused key gives a clear message", "refused" in msg and KEY not in msg, msg)
import tempfile, os, io, contextlib
tmp = Path(tempfile.mkdtemp()); OF.OUT = tmp
(tmp / "games.json").write_text(json.dumps(games)); (tmp / "slate.json").write_text(json.dumps(slate)); OF.write(doc2)
kf = tmp / "key.json"; kf.write_text(json.dumps({"id": "oddspapi", "data": {"key": KEY, "saved_at": "x"}})); os.environ["ODDSPAPI_KEY_FILE"] = str(kf)
check("the key is read from the document the admin page saves", OF.read_key() == KEY)
real = OF.http_get; OF.http_get = make_get({}, fail=("fixtures", 500)); OF.Api.__init__.__defaults__ = (OF.http_get, OF.time.sleep)
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = OF.main(["pull"])
saved = json.loads((tmp / "odds_feed.json").read_text())
check("a failed pull keeps the previous prices, records the error and does not fail the refresh", rc == 0 and len(saved["rows"]) == 4 and saved["ok"] is False and saved["error"], saved.get("error", "")[:80])
check("the key is in neither the saved file nor the printed output", KEY not in (tmp / "odds_feed.json").read_text() and KEY not in buf.getvalue())
del os.environ["ODDSPAPI_KEY_FILE"]; buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = OF.main(["pull"])
check("no key: nothing is pulled, nothing is changed, the refresh carries on", rc == 0 and "no key" in buf.getvalue() and json.loads((tmp / "odds_feed.json").read_text()) == saved)
OF.archive({"week": 10, "rows": doc2["rows"]}, 11); OF.archive({"week": 10, "rows": doc2["rows"]}, 11); OF.archive({"week": 11, "rows": doc2["rows"]}, 11)
hist = json.loads((tmp / "odds_feed_history.json").read_text())["rows"]
check("when the week moves on, last week's final prices are archived once for grading", len(hist) == 4 and all(r["week"] == 10 for r in hist))
check("two teams sharing a city are told apart (Jets/Giants, Rams/Chargers)", OF.match_fixture(FIX[3], games) is None and OF.match_fixture(FIX[0], games)["game_id"] == "2026_11_BUF_NYJ")
print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed"); sys.exit(0 if all(res) else 1)
