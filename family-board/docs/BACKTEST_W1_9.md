# 2026 Weeks 1–9 backtest: which data should drive Anytime TD projections

Decisions used (from the review Q&A): 2025 is the prior season for every week (2025 games at half weight);
routes are an estimate from snaps, labeled "est. routes"; market comparison uses prices found in the owner's
Drive workbooks (read-only); an input goes live only if it beats the current model in 90% of resampled games and
no position gets worse.

Code: `research/inventory.py`, `refresh/features.py` (pregame features), `research/backtest.py`, `research/variants.py`,
`research/check2025.py`, `research/candidates.py`, `research/secondary.py`. Results: `research/*_results.json`.
Live model: `refresh/model_v03.py` (summary frozen in `refresh/v03_backtest.json`).

## 1. Executive summary

- **Scope.** All 136 games of Weeks 1–9 and 3,261 player-games (QB 323, RB 757, WR 1,286, TE 895): skill players
  who took an offensive snap (a pick on an inactive player is void). 557 scored. Every week was forecast from earlier games only.
- **The simple structure wins.** Team TD expectation from the closing line × the player's share of carries and
  targets (2025 at half weight) beat a player's own historical TD rate by 0.046 log loss per player-game
  (90% interval 0.028–0.065) and beat the app's previous model (usage-v0.2) by 0.022 (0.013–0.030).
- **What added value on unseen weeks:** goal-line rushing work for RBs and QBs (share of team carries inside the 5,
  goal-to-go share, QB designed runs and sneaks) and the pregame depth-chart rank. Both also helped in an
  independent 2025 check. The player's own TD rate helped in 2025 and slightly in 2026.
- **Adopted: usage-v0.3c**: team expectation + workload + goal-line rushing + depth rank + player TD rate.
  It beats the previous model by 0.025 log loss per player-game (0.017–0.034), and is better for every
  position (QB +33, RB +14, WR +29, TE +27, ×10⁻³). Calibration is close in every band
  (e.g. predicted 47% → scored 49% in the 40–60% band). The previous model was overconfident at the top:
  60%+ picks scored 48%.
- **What did not help:** opponent matchup (worse in both seasons), game script/projected plays, injuries and
  vacated touches, efficiency (YPC, catch rate over expected, aDOT, YAC), end-zone target share, recent-3-game
  role change, long-TD indicators (helped only the long-TD outcome itself).
- **Market.** On 378 Week 3–4 player-games with FanDuel prices captured before kickoff, the de-vigged market
  was more accurate than the model (log loss 0.548 vs 0.560; gap not significant, 90% −0.024 to +0.003).
  Correlation 0.87. **No evidence of an edge**, so "Value Play" stays off.
- **Secondary stats.** The volume × rate formulas beat each player's average: rushing yards MAE 19.1 vs 21.2,
  receptions 1.22 vs 1.33, receiving yards 16.9 vs 18.6. For QB passing yards the formula ties the average;
  only the depth chart (starter vs backup) helped (−5.2 yards MAE).
- **Needs more data:** true routes run (no 2026 source), end-zone target share (no signal yet), historical player
  odds beyond Weeks 3–4, game-day inactives timing, weather (only 44 of 96 outdoor games have recorded wind).

## 2. Data inventory (Weeks 1–9 2026; 2025 used as prior)

| Dataset (nflverse release) | Games covered | Key fields | Missing | Available before kickoff? | Join |
|---|---|---|---|---|---|
| Play-by-play `pbp` | 136/136 | yardline_100, goal_to_go, air_yards, qb_scramble, rusher/receiver ids, cp, xyac | air_yards 0.6% of targets; xyac 4.2% of catches | Earlier games only | game_id + play_id; gsis ids |
| Schedules `games.csv` | 136/136 | spread_line, total_line (closing, no timestamp), roof, wind, referee | wind on 52 of 96 outdoor games; referee 71 | Lines: closing number only | game_id |
| Snap counts | 136/136 | offense_snaps, offense_pct | 0.2% pfr→gsis unmatched (16 player-games) | Earlier games only | pfr_id → gsis via players |
| Injuries (weekly report) | Weeks 1–9 | report_status (Out 588, Doubtful 43, Questionable 590) | no publish timestamp; game-day inactives absent | Yes (Friday final report) | gsis + week |
| Weekly rosters | Weeks 1–9 | status ACT/INA/RES/DEV/CUT… | — | Yes | gsis + week |
| FTN charting | 136/136 | is_qb_sneak (202), n_defense_box, blitzers, catchable/drop | 0% box nulls | Earlier games only | 100% play match to pbp |
| Depth charts | 296 dated snapshots (Mar–Nov) | pos_rank by team | 3% rows without gsis; 0.7% of player-games unranked | Yes (last snapshot before kickoff) | gsis + team |
| NGS receiving | Weeks 1–9, ~71 receivers/week | separation, intended air yards, xYAC | qualifying receivers only | Earlier games only | gsis |
| PFR defensive charting | 136/136 | targets/TDs allowed per defender | — | Earlier games only | pfr ids |
| 2025 pbp / snaps / injuries / rosters / FTN / depth / participation | 272 games | as above; participation has on-field players per play | — | n/a (prior season) | same keys |
| Drive workbooks (owner, read-only) | Weeks 2–4 | FanDuel/BetMGM anytime prices with capture time | names only (matched by name+week: 378 player-games) | Yes (captured before kickoff) | name + week |

**True zero vs unknown.** For active skill players: 3,322 player-games with offensive snaps (stats computed; no
carry/target = true zero), 246 with a snap row showing 0 offensive snaps (true zero, not eligible), 257 with no snap
row (unknown: did not play or feed gap; not eligible). Shares use the player's team's games when he was active; a
team with no carries inside the 5 shows "none yet", never 0%.

**Not available:** routes run in 2026 (participation stops at 2025); historical player odds beyond the workbooks;
pregame line snapshots with timestamps; offensive-line and defender injury impact beyond the report itself.

**Definitions** were checked against the nflverse data dictionaries:
[play-by-play](https://nflreadr.nflverse.com/articles/dictionary_pbp.html),
[FTN charting](https://nflreadr.nflverse.com/articles/dictionary_ftn_charting.html),
[snap counts](https://nflreadr.nflverse.com/articles/dictionary_snap_counts.html),
[injuries](https://nflreadr.nflverse.com/articles/dictionary_injuries.html),
[depth charts](https://nflreadr.nflverse.com/articles/dictionary_depth_charts.html),
[participation](https://nflreadr.nflverse.com/articles/dictionary_participation.html).
Proxies, all labeled: **end-zone target** = target with air_yards ≥ yardline_100; **est. routes** = offensive snaps ×
team dropback rate; **designed QB run** = QB carry with qb_scramble = 0; **sneak** = FTN is_qb_sneak.

## 3. Ranked inputs (Anytime TD; gain = log-loss improvement ×10⁻³ per player-game, 90% interval)

| Rank | Input | Source | Coverage | Positions | 2026 W1–9 gain | 2025 W10–18 check | Status |
|---|---|---|---|---|---|---|---|
| 1 | Team expectation × carry/target share | closing line + pbp | 100% | all | +46.0 vs own TD rate [28.0, 64.7]; +21.7 vs v0.2 [13.5, 30.4] | — | **Live (core)** |
| 2 | Goal-line rushing (inside-5 share, goal-to-go share, designed runs, sneaks) | pbp + FTN | 100% | RB, QB | +2.3 [0.4, 4.2] (RB +8.9, QB +5.7) | +2.4 [0.8, 3.9], no position worse | **Live** |
| 3 | Pregame depth-chart rank | depth charts | 99.3% | all (mostly RB) | +2.8 [0.3, 5.4] (RB +10.4) | +3.1 [0.9, 5.4] | **Live** |
| 4 | Player TD rate / goal-line TD rate | pbp | 100% (rookies: position mean) | all | +1.6 [−0.2, 3.4] | +1.8 [0.5, 3.1] | **Live** (as part of v0.3c) |
| 5 | Snap share, est. routes, targets per est. route | snaps + pbp | 100% | all | +1.2 [−0.2, 2.7] | +1.0 [−0.6, 2.5] | Research |
| 6 | Long-TD potential (20+ yd plays per touch, long-TD rate) | pbp | 100% | all | +0.4 [−0.1, 0.9]; long-TD outcome +0.9 [0.0, 1.9] | +0.0 | Research (shown in details only) |
| 7 | End-zone / red-zone target share | pbp (proxy) | 100% | WR/TE/RB | +0.3 [−0.1, 0.7] | −0.1 | Research (displayed with denominator) |
| 8 | Game script (spread, plays, neutral pass rate, team TD history) | lines + pbp | 100% | all | −0.1 | −0.2 | Not used |
| 9 | Efficiency (YPC, catch over expected, aDOT, YAC) | pbp | ~95% | all | −0.3 | +0.2 | Not used |
| 10 | Injuries / lineup (questionable, QB out, vacated touches) | injury report, rosters | 100% of reports | all | −0.6 | −0.5 | Not used for TD; **operationally essential** (removes Out/IR players) |
| 11 | Opponent matchup (TDs allowed by position, YPC allowed, pressure) | pbp | 100% | all | −0.3 [−0.6, 0.0] | −1.2 [−2.1, −0.4] | Not used |
| 12 | Recent 3-game role change | snaps + pbp | 97% | all | −1.0 | −0.1 | Not used in the chance; **shown as a flag** |

**Operationally useful despite small predictive value:** injury report and weekly roster (keeps inactive/IR players
off the board and voids picks correctly); role-change flag (explains why a chance moved); end-zone targets and
inside-5 carries (explain the chance; the inside-5 part is in the model for RB/QB).

**Explanation vs prediction.** Same-game usage explains far more than anything known before kickoff: a model using
the game's actual carries inside the 5, end-zone targets, carries, targets and team TDs has McFadden R² 0.35 on
Weeks 1–9 (largest weights: end-zone targets, carries, inside-5 carries, team TDs). The best pregame model reaches
R² 0.12 on unseen weeks. The gap is the unpredictable part: who gets the goal-line touches *that day*.

**Secondary outcomes (MAE on 2026 W1–9; lower is better).**

| Outcome | Player-games | Player average | Volume × rate formula | Best blend | Inputs that helped on top (MAE gain, 90%) |
|---|---|---|---|---|---|
| RB rushing yards | 757 | 21.15 | 19.12 | 18.92 | recent role 0.26 [0.05, 0.48]; depth 0.08 |
| WR/TE receptions | 2,181 | 1.33 | 1.22 | 1.23 | depth 0.013 [0.007, 0.019] |
| WR/TE receiving yards | 2,181 | 18.59 | 16.89 | 16.59 | depth 0.11, injuries/vacated 0.11, snap/est. routes 0.08 |
| QB passing yards | 280 | 68.39 | 68.22 | 69.18 | depth (starter vs backup) 5.2 [3.2, 7.2] |

Matchup, game script and efficiency did not help any secondary outcome.

## 4. Weeks 1–9 scorecard (usage-v0.3c, each week forecast from earlier weeks)

| Week | Games | Player-games | Scored | Log loss v0.3c | Base (team × workload) | Previous app model | Top-10 picks that scored (expected) |
|---|---|---|---|---|---|---|---|
| 1 | 16 | 382 | 70 | 0.412 | 0.425 | n/a (no 2026 history) | 7 (5.5) |
| 2 | 16 | 390 | 51 | 0.351 | 0.363 | 0.476 | 6 (5.9) |
| 3 | 16 | 384 | 69 | 0.448 | 0.448 | 0.547 | 7 (5.7) |
| 4 | 16 | 380 | 66 | 0.394 | 0.398 | 0.458 | 7 (5.7) |
| 5 | 15 | 359 | 65 | 0.403 | 0.413 | 0.448 | 6 (5.6) |
| 6 | 14 | 330 | 51 | 0.371 | 0.370 | 0.420 | 7 (5.8) |
| 7 | 14 | 334 | 61 | 0.394 | 0.406 | 0.434 | 6 (5.7) |
| 8 | 14 | 338 | 65 | 0.411 | 0.412 | 0.442 | 5 (5.7) |
| 9 | 15 | 364 | 59 | 0.393 | 0.388 | 0.454 | 5 (6.0) |

Weekly top-10 picks scored 56 times against 51.6 expected. Players at 50%+ scored 58.5% (94 player-games, mean
forecast 57.2%). No week drives the result: the gain over the previous model holds in every week.
Missing feeds by week: market prices only Weeks 2–4; wind missing for 52 outdoor games; routes never available.

**Where it worked:** v0.3c raised goal-line backs the previous model under-rated, and they scored:
Josh Jacobs W8 (58% vs 19%), McCaffrey W4 (64% vs 32%) and W6 (68% vs 40%), Gibbs W4 (65% vs 36%).
It cut Week 2 receivers the old model over-rated off one game, and they did not score: Shakir (32% vs 75%),
Raridon (13% vs 53%), Ayomanor (8% vs 46%).
**Where it failed:** top backs who did not score (K. Walker W2 74%, D. Montgomery W2 70%, Gibbs W7 68%), and
deep-roster surprises with no usage history (A. Tyus W7, J. Metchie W3, R. Miller W2, all ~2%). This is the
irreducible part: one touch decides a TD.

## 5. Prioritized app changes

| # | Change | Screen / workflow | Data and calculation | What the user sees | How to verify | Status |
|---|---|---|---|---|---|---|
| 1 | Adopt usage-v0.3c as the headline chance | Refresh → slate.json → This week, Parlays | `refresh/model_v03.py`: logistic model refit each refresh on 2025 W3–18 + played 2026 weeks; inputs above | Same "Chance to score"; better ordering of backs | Weekly rolling score in `validation.json`; gate re-run each 4 weeks | **Done (v13)** |
| 2 | Goal-line and end-zone counts with denominators | Player details | 2026 pbp: player carries inside the 5 ÷ team carries inside the 5; end-zone targets ÷ team end-zone targets; "None yet" when the team has 0 | "11 of BUF's 22 (50%) · 8 games" | Totals match pbp; denominators never 0 | **Done** |
| 3 | Main reason + biggest uncertainty | Player details | Largest positive model contribution → text; uncertainty from no history, team change, questionable, role change, QB out, vacated touches | One sentence each | Spot-check 20 players weekly | **Done** |
| 4 | Role-change flag | Main board row + details | Last-3-game carry+target share vs season (≥8 points, ≥4 games) | "Role ↑" / "Role ↓" chip | 41 of 245 candidates flagged in Week 10; review against depth chart | **Done** |
| 5 | Pregame depth chart in the refresh | Data pipeline | nflverse depth charts; last snapshot before kickoff | "#1 at RB (last update before kickoff)" | Snapshot time < kickoff for every row | **Done** |
| 6 | 2025 as last-season history | Data pipeline | 2025 pbp, snaps, injuries, rosters, FTN, depth charts at half weight | Week 1 projections next season | Week 1 2026 log loss 0.412 with last-season history (team × workload base 0.425) | **Done** |
| 7 | Market capture going forward | Lines tab + refresh | Store each uploaded price with captured_at; compare at a fixed cutoff (latest price before kickoff) | Model vs market report after each week | ≥200 priced player-games before revisiting Value Play | Next |
| 8 | Secondary stat projections (rush yds, receptions, rec yds) | Player details | Formulas in §3 (est. routes labeled) + depth rank | "Proj. 64 rush yds" with the formula's inputs | MAE vs player average each week | Next (formula validated, not yet displayed) |
| 9 | Game-day inactives | Refresh 90 min before kickoff | Inactive list (not in nflverse injuries) | Players marked Inactive before lock | Count of voided picks drops | Needs a source |
| 10 | Matchup boosts | This week (Matchups fold) | — | Keep labeled "untested", or remove | Failed in both seasons | Consider removing |

## 6. Updated Anytime TD board specification

**Main board (game card, one row per player):** name, position, team; **estimated TD chance** (v0.3c) with fair
odds; Pick and + Parlay; chips only when they change a decision: injury status, **Role ↑/↓**, Windy.
The expanded game shows each team's **projected offensive TDs** (implied points × TDs per point, e.g. "3.16 expected
TDs") and the opponent's TDs allowed by position (context only).

**Player details:**
- Chance to score, fair odds, uploaded prices (anytime and 2+), edge only when a fresh price exists.
- **Carries inside the 5:** player ÷ team, 2026 games only, with the game count. Denominator = all team carries
  (designed runs + scrambles) starting at the opponent's 5 or closer, excluding 2-point tries.
  Team total 0 → "None yet", never "0%".
- **End-zone targets:** player ÷ team targets whose air yards reach the goal line (proxy, labeled).
  Same zero rule. Shown for RB/WR/TE, not QB.
- Depth chart rank (last snapshot before kickoff), role-change detail (last 3 games vs season).
- **Main reason** (largest contributor) and **biggest uncertainty** (one line each).
- Usage share, scoring split (catching vs running), weather, matchup (labeled untested).

**Unknowns are shown, not hidden:** no history → "estimate leans on position averages"; team change → "usage
comes from his old team"; no forecast → "No forecast yet"; no price → "Not uploaded".
