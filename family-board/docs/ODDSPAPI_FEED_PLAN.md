# OddsPapi sportsbook feed: plan (not built yet)

Status: waiting on the key. Nothing below is built or deployed.

## Why it works this way
- The user's OddsPapi key is for the **v4 API** (`https://api.oddspapi.io/v4`), which only accepts the key as the
  `apiKey` **query parameter**. Tested: sending it as an `X-API-Key` header returns 401 `MISSING_API_KEY`.
  The secure credential form can only inject headers, so it can't be used for v4. (A v5 key at `v5.oddspapi.io` would
  work with the header; a header credential for both hosts is already saved on the environment but is unused for v4.)
- The published app (an Artifact page) cannot call outside APIs, and anything it stores is readable by the family,
  so the key must never go into the page or the database.

## What the user does
1. Environment settings (cloud environment menu → Edit) → add environment variable **`ODDSPAPI_KEY`** = the newest key.
2. Start a **new session** (variables reach new sessions only) and say "build the OddsPapi feed".
Never paste the key into chat or commit it.

## What to build (next session)
1. `refresh/odds_feed.py`: reads `ODDSPAPI_KEY` from the environment (skip with a clear health note if missing);
   network host `api.oddspapi.io` must be reachable (saving the header credential already allowed it; verify).
   - `call(path, **params)`: adds `apiKey`, honours `error.retryMs` on 429 (up to 5 tries), raises on other errors.
   - Fixtures: `call("fixtures", sportId=14, tournamentId=31, from=..., to=...)` for the current week
     (`fixtureId`, `startTime`, team names to map to nflverse `game_id`).
   - Market catalog (cache it): `call("markets", sportId=14)` →
     `market_name[marketId]`, `handicap[marketId]`, `outcome_name[(marketId, outcomeId)]`.
     Find the anytime-TD market (and 2+ TDs) **by name** from the catalog, not by a hard-coded id: anytime TD is
     market name **"Player To Score TD (incl. overtime)"**, outcome **"Yes"** (overtime counts, as in the app's
     grading). Several market ids can share that name (`TD_IDS` is a set). 2+ TDs: find its exact name in the catalog.
   - Odds per fixture: `call("odds", fixtureId=...)` → `odds["bookmakerOdds"][book_slug]["markets"][marketId]
     ["outcomes"][outcomeId]["players"][player_id]` = a price object with at least `active`. Skip books whose slug
     starts with `pinnacle+` or equals `demo` (internal test feeds), skip `suspended` books, skip inactive prices, and
     skip `player_id == "0"` (the game line). The price object carries `playerName`, `price` (**decimal odds**, confirmed by
     the user's yardage example: 1.87 ≈ −115; convert to American) and `active`. Still unconfirmed: the timestamp field name — read one real
     response first. Match `playerName` to gsis ids with the Uploads tab's player matcher; names come
     as **"Last, First"** ("Kupp, Cooper"), so flip them first and handle suffixes ("Jr.", "III").
   - **Duplicate books.** Many books are skins of one feed: the user's sample found 99 prop books but only 39
     independent price sets (one group of 21 sites, one of 10, one of 9). Group books whose full set of
     (market, outcome, player, price) is identical (the user's `sig` code below) and count each group once in any
     market average or "consensus" price; show one representative book per group.
   - **Books the family can use.** In the user's sample the best anytime-TD prices were often at books the family
     can't bet (betfirst.be, betano, superbet.bet.br); best-to-worst gaps were 31-46% (e.g. Kupp 4.37 at betfirst.be vs
     3.0 at FanDuel). Keep an allow-list of US books the family uses (FanDuel, DraftKings, BetMGM US — check the exact
     slugs, e.g. `betmgm.co.uk` is the UK site — Caesars, etc.; Kalshi is a prediction market, ask before including)
     and compute "best price" only within it. Other books may appear only in a clearly labeled market-average figure
     (one vote per independent feed group).
   - **Fair price vs raw implied.** Remove the book's margin only when the same book quotes both sides of the same
     line (Yes/No for anytime TD, Over/Under for yardage): fair = (1/side) / (1/Over + 1/Under), as in the user's
     receiving-yards example (31 two-sided quotes; tightest book 6.95% margin → 50.0% / 50.0%). Most books post anytime
     TD as Yes only: show the raw implied chance there, labeled raw, as the app already does (never call it de-vigged).
   - **Yardage and reception lines (optional, later).** Over/Under prop lines are the "prop lines" missing from
     docs/ANALYSIS_W1_10.md §4. Saving them weekly (pre-kickoff) would let the analysis grade "beat the line" hit rates
     from Week 11 on. The `rungs[player][line][book] = {"Over": price, "Under": price}` structure in the user's
     example is built from prop_prices() grouped by player, line (from the market catalog's `handicap`) and book.
     The user's sample saw 8,508 prop prices (5,391 active) from 259 books on one fixture: filter to the anytime-TD
     market and to the books the family uses (FanDuel, DraftKings, etc.) to keep the file small.
     Keep only pre-kickoff prices; keep each book's own timestamp.
   - Map outcome names to gsis ids with the same player matcher the Uploads tab uses; report unmatched names.
   - Write `artifact/data/odds_feed.json`: `{pulled_at, week, source:"oddspapi v4", rows:[{game_id, gsis_id, player,
     book, market, american, captured_at, time_source:"book feed"}], unmatched:[...], coverage:{games, books, players}}`.
2. Admin page "Sportsbook feed" section: last pull time and coverage; price table; **"Add to my prices"** button that
   writes the rows into the admin's own `lines/{self}` doc (same path as a manual upload, with the book timestamps);
   optional "Pull now" button (fires the refresh scheduled task through the Claude Code Remote connector, admin only).
3. Rules that stay: the refresh never writes to picks, parlays, lines, refs, odds, overrides or reviews; no database
   rule changes; push and publish only on the user's explicit "push and publish".

## User's reference code (v4)
```python
import requests, time
from collections import defaultdict

API_KEY = "YOUR_API_KEY"          # read from os.environ["ODDSPAPI_KEY"] instead
BASE_URL = "https://api.oddspapi.io/v4"

def call(path, **params):
    """apiKey is a query parameter. Honour retryMs on a 429."""
    params["apiKey"] = API_KEY
    for _ in range(5):
        r = requests.get(f"{BASE_URL}/{path}", params=params, timeout=600)
        if r.status_code == 429:
            time.sleep(r.json()["error"]["retryMs"] / 1000 + 0.3)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("rate limited")

fixtures = call("fixtures", sportId=14, tournamentId=31,
                **{"from": "2026-09-09", "to": "2026-09-13"})
opener = sorted(fixtures, key=lambda f: f["startTime"])[0]
print(opener["fixtureId"], opener["startTime"])
# id1400003171515752 2026-09-10T00:20:00.000Z

catalog = call("markets", sportId=14)
market_name  = {m["marketId"]: m["marketName"] for m in catalog}
handicap     = {m["marketId"]: m.get("handicap") for m in catalog}
outcome_name = {(m["marketId"], o["outcomeId"]): o["outcomeName"]
                for m in catalog for o in m.get("outcomes", [])}

odds  = call("odds", fixtureId=opener["fixtureId"])
board = odds["bookmakerOdds"]

def prop_prices(board):
    for slug, book in board.items():
        if slug.startswith("pinnacle+") or slug == "demo":
            continue                      # internal test feeds
        if book.get("suspended"):
            continue                      # book pulled the market
        for mid, market in book["markets"].items():
            for oid, outcome in market["outcomes"].items():
                for player_id, price in outcome["players"].items():
                    if player_id == "0":
                        continue          # "0" is the game line
                    yield slug, int(mid), int(oid), price

rows   = list(prop_prices(board))
active = [r for r in rows if r[3]["active"]]
print(f"{len(rows)} prop prices, {len(active)} active, {len(board)} books on the fixture")
# 8508 prop prices, 5391 active, 259 books on the fixture

# books that are copies of the same feed
sig = defaultdict(list)
for slug in board:
    tup = tuple(sorted((m, o, p["playerName"], p["price"])
                       for s, m, o, p in prop_prices({slug: board[slug]})))
    if tup:
        sig[tup].append(slug)

print(f"{sum(len(g) for g in sig.values())} prop books -> {len(sig)} independent")
for g in sorted(sig.values(), key=len, reverse=True)[:3]:
    print(f"  {len(g)}x {sorted(g)[:5]}")
# 99 prop books -> 39 independent
#   21x ['7bet.co.uk', '7bet.lt', 'allbritishcasino', 'alphawin', 'betinia.dk']
#   10x ['leovegas.es', 'paf.es', 'prolineplus', 'scooore.be', 'unibet.be']
#    9x ['betcity.nl', 'betmgm.co.uk', 'betparx', 'betplay', 'betuk']

# margin-free price for a two-sided prop line (rungs: player -> line -> book -> {"Over": dec, "Under": dec})
line   = 29.5
quotes = {s: v for s, v in rungs[player][line].items()
          if "Over" in v and "Under" in v}
scored = sorted(((1/v["Over"] + 1/v["Under"]), s, v) for s, v in quotes.items())
overround, book, v = scored[0]

print(f"{player} {line} receiving yards, {len(quotes)} two-sided quotes")
print(f"  tightest {book}: Over {v['Over']} / Under {v['Under']} = {100*(overround-1):.2f}% margin")
print(f"  fair Over  {1/(1/v['Over']/overround):.3f}  ({100/v['Over']/overround:.1f}%)")
print(f"  fair Under {1/(1/v['Under']/overround):.3f}  ({100/v['Under']/overround:.1f}%)")
# Kupp, Cooper 29.5 receiving yards, 31 two-sided quotes
#   tightest apuestatotal: Over 1.87 / Under 1.87 = 6.95% margin
#   fair Over  2.000  (50.0%)
#   fair Under 2.000  (50.0%)

# anytime TD ("Yes") prices per player across books
TD_IDS = {mid for mid, n in market_name.items()
          if n == "Player To Score TD (incl. overtime)"}

td = defaultdict(dict)
for slug, mid, oid, price in prop_prices(board):
    if mid in TD_IDS and outcome_name.get((mid, oid)) == "Yes" and price["active"]:
        td[price["playerName"]][slug] = price["price"]

for name, books in sorted(td.items(), key=lambda x: -len(x[1]))[:5]:
    hi = max(books.items(), key=lambda x: x[1])
    lo = min(books.items(), key=lambda x: x[1])
    print(f"  {name:<22} {len(books):>2} books  best {hi[1]:>5} ({hi[0]})"
          f"  worst {lo[1]:>5} ({lo[0]})  +{100*(hi[1]/lo[1]-1):.1f}%")
#   Shaheed, Rashid        25 books  best  4.36 (betfirst.be)  worst  3.25 (betano)  +34.2%
#   Maye, Drake            25 books  best  5.51 (betfirst.be)  worst   4.2 (superbet.bet.br)  +31.2%
#   Henry, Hunter          25 books  best 4.545 (kalshi)  worst   3.4 (betano)  +33.7%
#   Holani, George         25 books  best  3.66 (betfirst.be)  worst   2.5 (betano)  +46.4%
#   Kupp, Cooper           25 books  best  4.37 (betfirst.be)  worst   3.0 (fanduel)  +45.7%
```
