# Live touchdowns runbook (in-game, provisional)

Status: built and tested with SIMULATED events only. Not connected to a provider and not scheduled. Turning it on
needs: a provider key (BALLDONTLIE GOAT, see below), one database rule, and the owner's go-ahead ("push and publish").

## How it works

```
provider (BALLDONTLIE /nfl/v1/games + /plays, every 15 s)
   -> refresh/live_feed.py (background job in a cloud session; rebuilds each game's TDs; diff; writes only on change)
   -> outbox/<game_id>~<ms>.json            (one create-only document per change; heartbeats every 10 min)
   -> the session saves each file into the app's shared database, collection "live" (ArtifactData batch, op "set")
   -> every open app listens to "live" and redraws the TDs tab (no reload, no Refresh results tap)
```

* The provider key never reaches the app: it is a network secret on the cloud environment, injected by the proxy.
* Live touchdowns are provisional and never settle a pick. Picks and parlay legs settle only from the hourly postgame
  job (touchdowns match the official final score AND each scorer matches the weekly player stats).
* Each game is its own document, so a problem in one game never holds up the others.
* Corrections: every poll rebuilds the game from the source by play id. Repeats never duplicate; a dropped play is
  marked overturned (struck through, not counted); a re-credited play keeps its key and records the change.

## Database rule (needs the owner's approval before publishing)

Add to the page's `db.rules` (only the backend, acting as the owner, may write; everyone who can open the app may read):

```json
{"path": "live", "read": "view", "write": "admin"}
```

## Session procedure (what the scheduled live session does)

1. Read `data/games.json` and `data/slate.json` from the artifact into `family-board/artifact/data/`, and
   `src/refresh/live_feed.py.txt` into `family-board/refresh/live_feed.py`.
2. If no game is within 10 minutes before kickoff to 5 hours after, stop: "No live window".
3. Start the poller as a background job:
   `python3 family-board/refresh/live_feed.py poll --provider balldontlie --outbox live_out --interval 15 --heartbeat 600 --until-idle --max-seconds 7000`
4. Watch its output with Monitor (`tail -F` of the job output, filtered to `^LIVE_`), re-arming when the monitor expires.
   * `LIVE_UPDATE <file>` / `LIVE_HEARTBEAT <file>`: save that file with ArtifactData `batch`, entry
     `{op: "set", collection: "live", doc_id: <file name without .json>, file_path: <file>}`. Several lines that arrive
     together go in one batch. Document ids are unique, so no version is needed.
   * `LIVE_ERROR`: nothing to save; after three in a row the poller writes a failing heartbeat and the app shows
     "Live feed delayed".
   * `LIVE_DONE`: if games are still in their window (time limit reached), start the poller again; else finish.
5. Never write to picks, parlays, lines, refs, odds, overrides, reviews or locks. Never publish the page.
6. Finish with: documents saved, touchdowns seen, corrections, overturns, errors, and the median time from
   `received_at` to saved.

## Draft scheduled task (NOT created)

Fresh session per firing, `CRON_TZ=America/New_York 50 8,12,15,19 * * 0,1,4,6` (Sun/Mon/Thu/Sat, 10 minutes before each
kickoff window), prompt: "Run docs/LIVE_RUNBOOK.md 'Session procedure' for https://claude.ai/artifact/6vni4HxfKfykT45J3F5SoD."
A window already being covered is detected in step 2 by a heartbeat newer than 2 minutes in "live", in which case the
new session stops.

## Limits and numbers

| Item | Value | Status |
|---|---|---|
| Provider poll interval | 15 s (fastest supported by the plan: ~3 s; 600 requests/min ÷ ~29 requests per full-slate poll) | docs |
| Provider in-game freshness | "Game data is updated in real-time for games currently in progress" (games, stats); not stated for plays | unverified |
| Write step (session turn + database save) | 20 s assumed in the test | unverified |
| End to end, simulated | 20–30 s with a 15 s poll and 20 s write; 0.5 s with an instant write | tested (simulated) |
| Writes | only on a touchdown change, a correction, a game start/final, plus a heartbeat every 10 min; the score shows "as of" its time | design |
| Session cost | about $0.04 per session turn (today's scheduled runs: ~$0.80 for ~20 turns); a full Sunday is roughly 100-150 turns, about $4-6 | estimate |
