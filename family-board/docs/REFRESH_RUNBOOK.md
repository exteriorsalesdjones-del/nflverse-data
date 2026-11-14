# Refresh runbook

The scheduled refresh runs this in a fresh Claude Code session on this repository
(branch `claude/nfl-nerd-repo-j74hx3`). A person can run the same steps by hand.

Artifact: https://claude.ai/artifact/6vni4HxfKfykT45J3F5SoD

1. `cd family-board && python3 refresh/fetch_sources.py` (needs `refresh/matchup.py` and `refresh/enhance.py` beside `build_data.py`)
   Downloads the nflverse files. A failed download keeps the previous good copy.
2. `python3 refresh/build_data.py`
   Rebuilds `artifact/data/*.json`. Exit code 1 means a final game failed to
   reconcile with the official score: do **not** publish; report the game ids it printed.
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
6. Report: final games, reconciled games, touchdowns, new snapshots, and any failure.

Never write to `picks`, `parlays`, `lines`, `odds`, `overrides` or `reviews` from the refresh. Those belong to members and admins.
