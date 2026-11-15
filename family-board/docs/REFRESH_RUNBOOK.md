# Refresh runbook

The scheduled refresh runs this in a fresh Claude Code session on this repository
(branch `claude/nfl-nerd-repo-j74hx3`). A person can run the same steps by hand.

Artifact: https://claude.ai/artifact/6vni4HxfKfykT45J3F5SoD

1. `cd family-board && python3 refresh/fetch_sources.py` (needs `refresh/matchup.py`, `refresh/enhance.py`, `refresh/weather.py` and `refresh/wind_study.json` beside `build_data.py`). This also fetches kickoff wind forecasts for the upcoming week (National Weather Service, Open-Meteo for international games; needs api.weather.gov and api.open-meteo.com allowed). A failed forecast is not an error: those games show "No forecast yet".
   Downloads the nflverse files. A failed download keeps the previous good copy.
2. Export uploaded lines for weekly grading (read only):
   `ArtifactData list collection=lines` gives one document per uploader id; for each id,
   `ArtifactData list collection=lines/<id>/weeks out_dir=<tmp>`.
   Then `FB_LINES_DIR=<tmp> python3 refresh/build_data.py`
   (needs `features.py`, `model_v03.py`, `v03_backtest.json`, `referee_index.py`, `grade.py` beside it, and the
   artifact's `data/predictions.json` saved to `artifact/data/predictions.json` first, so pregame chances accumulate).
   If there are no lines yet, run it without `FB_LINES_DIR`.
   Rebuilds `artifact/data/*.json` (including `predictions.json` and `grades.json`; publish both).
   `meta.json` → `health` lists any problem (failed download, model fallback, missing forecasts). Exit code 1 means a final game failed to
   reconcile with the official score: do **not** publish; report the game ids it printed (`unreconciled`). A game that is final on
   the schedule but has no plays in the play-by-play yet is listed under `awaiting_source`: it does not fail the build, its picks stay
   pending, and the next run picks it up. Before building, copy the published `data/meta.json` into the output folder so
   `results_changed_at` only moves when touchdowns, scorers or final scores actually change. `reconciliation.json` also carries
   `scorers_verified` (each scorer's TD count checked against official weekly player stats; picks settle only when it is true).
   `meta.json` is written last, so a crash leaves the old data and old timestamp in place.
3. `python3 -m pytest -q tests` is not needed; run `node --test tests/lib.test.js`
   only when `artifact/lib.js` changed.
4. Republish the data files to the artifact (same URL), with `files` mapping every
   `data/<name>.json` to `family-board/artifact/data/<name>.json`. Republish
   `artifact/dist/index.html` only if `python3 artifact/build_page.py` was rerun
   after a page change. Omit `capabilities` so the stored rules carry forward.
5. Kickoff snapshots:
   - `ArtifactData list collection=locks` and note the existing ids.
   - `ArtifactData list collection=picks out_dir=<tmp>` and `ArtifactData list collection=parlays out_dir=<tmp>`.
   - `python3 refresh/make_locks.py <tmp> <tmp>/out <existing ids...>`
   - For each file printed, `ArtifactData set collection=locks doc_id=<game_id> file_path=<file>`
     (create only; never overwrite an existing lock).
6. Report: final games, reconciled games, games awaiting the source, scorer-check mismatches, touchdowns, new snapshots, and any failure.

Never write to `picks`, `parlays`, `lines`, `refs`, `odds`, `overrides` or `reviews` from the refresh. Those belong to members and admins.
