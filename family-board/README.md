# Anytime TD Family Board

A private Claude artifact for a family group: research the NFL slate, save anytime-TD picks, track results,
and browse every 2026 touchdown with evidence-based defender responsibility.

- **App:** https://claude.ai/artifact/6vni4HxfKfykT45J3F5SoD (private; share from the page's Share menu)
- `artifact/index.template.html` + `artifact/lib.js` → `python3 artifact/build_page.py` → `artifact/dist/index.html` (published page)
- `artifact/data/*.json` — season data files published beside the page
- `refresh/` — `fetch_sources.py`, `build_data.py`, `make_locks.py`
- `tests/lib.test.js` — pick, lock, settlement, odds and slate rules (`node --test tests/lib.test.js`)
- `docs/ADMIN_SETUP.md`, `docs/METHOD.md`, `docs/REFRESH_RUNBOOK.md`

Nothing here places wagers or takes payments. Workbook exports and login logs are not stored in this repo.

## Shared data (artifact database)
| Path | Who writes | Contents |
|---|---|---|
| `picks/<member id>` | that member (and admins) | `{items: {pickKey: pick}}` |
| `odds/w<week>` | admins | imported Anytime TD prices, `pending` or `live` |
| `locks/<game_id>` | admins and the refresh | kickoff snapshot of submitted picks |
| `reviews/<game_id>~<play_id>` | admins | attribution override with change history |

Refresh data never touches these paths, so a refresh cannot overwrite picks or reviews.

## Importing a legacy submission file later
Convert each row to a pick `{week, game_id, gsis_id, player, team, market:"anytime_td", status:"submitted", price, submitted_at}`
under key `w<week>_anytime_td_<gsis_id>` and merge it into `picks/<member id>.items`. The key makes a re-import a no-op for picks that already exist.
