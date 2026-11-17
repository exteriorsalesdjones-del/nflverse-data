# Three proposed improvements, tested (Nov 16 2026)

Question: do these beat usage-v0.3c on weeks it has not seen? Script: `research/improvements.py`
(inputs in `research/features_plus.py`); numbers: `research/improvements_results.json`.

Rule (unchanged from the Weeks 1-9 backtest): every 2026 week is forecast from 2025 + earlier 2026 weeks only. An input
is adopted only if the 90% interval of its log-loss gain (resampling games) is above zero **and** no position gets worse.
Each input is also run on 2025 alone (train weeks < w, test weeks 10-18). Gains are log loss per player-game x1000;
positive = better than v0.3c. Test set: 3581 player-games, 2026 Weeks 1-10 (v0.3c log loss 0.40029).

## 1. Sportsbook prices: adopted for RB / WR / TE

Prices: FanDuel (and 12 BetMGM) captured before kickoff, 2026 Weeks 2-4: 407 player-games in 43 games
({'WR': 174, 'RB': 112, 'TE': 77, 'QB': 44}). Model log loss on these rows: 0.5749.

| Variant | Log loss | Gain vs model (90% interval) | By position | Rule |
|---|---|---|---|---|
| `market_raw` | 0.5617 | +13.16 (+0.42 to +26.96) | {'QB': -38.45, 'RB': 19.66, 'TE': 2.24, 'WR': 26.85} | fail |
| `blend_fitted` | 0.5677 | +7.23 (-2.76 to +17.97) | {'QB': -46.44, 'RB': 16.3, 'TE': -7.83, 'WR': 21.64} | fail |
| `blend_equal_raw` | 0.5644 | +10.53 (+4.08 to +17.67) | {'QB': -13.15, 'RB': 15.58, 'TE': 3.57, 'WR': 16.35} | fail |
| `blend_equal_raw_no_qb` | 0.5629 | +11.95 (+5.04 to +19.45) | {'QB': 0.0, 'RB': 15.58, 'TE': 3.57, 'WR': 16.35} | pass |
| `blend_30_70_raw` | 0.5623 | +12.65 (+3.71 to +22.56) | {'QB': -21.54, 'RB': 18.74, 'TE': 3.68, 'WR': 21.34} | fail |

* `blend_equal_raw` = equal parts, on the log-odds scale, of the model's chance and the price's raw implied chance. No fitted
  weights, so nothing is tuned on the test rows.
* It beats the model for RB, WR and TE in all three weeks. It is **worse for QBs** (44 rows), so QBs keep the model's
  chance (`blend_equal_raw_no_qb`). Leaving QBs out was decided after seeing this test, which makes the result look a
  little better than a clean test would.
* Limits: two full weeks of prices from mostly one book; the ten players who gained most account for more than the
  whole gain (the rest net to slightly negative), so the size of the gain is uncertain even though its sign is consistent.
* In the app: `refresh/blend.json` -> `slate.json` `blend` -> the chance shown for RB/WR/TE when a fresh FanDuel/DraftKings
  (or uploaded) price exists. "Model vs price", "Above fair" and Best Value still use the model's own chance.
* Live check: `grade.py` scores the blend against the saved pregame model chance every refresh (`grades.json`
  `blend_live`). The refresh turns the blend off when that has 300+ player-games and its whole 90% interval is below zero.

## 2. Defense inputs split by how the TD is scored, opponent-adjusted: not adopted

| Input | 2026 gain (90% interval) | 2025 gain (90% interval) | Result |
|---|---|---|---|
| `def_epa` | -0.15 (-0.40 to +0.08) | -0.15 (-0.41 to +0.11) | not adopted |
| `def_td_split` | -0.10 (-0.34 to +0.13) | -0.52 (-0.96 to -0.09) | not adopted |
| `def_pos_share` | -0.11 (-0.38 to +0.14) | -0.09 (-0.35 to +0.17) | not adopted |
| `defense_all` | -0.27 (-0.69 to +0.13) | -0.90 (-1.45 to -0.36) | not adopted |

Every version is slightly worse than v0.3c in both seasons. The team's expected touchdowns already come from the closing
spread and total, which price the opposing defense; what is left after that (run vs pass, by position) did not predict.

## 3. Role changes (recent goal-line work, vacated work, next man up, depth-chart promotion): not adopted

| Input | 2026 gain (90% interval) | 2025 gain (90% interval) | Result |
|---|---|---|---|
| `role_goal_line` | -0.08 (-0.44 to +0.29) | -0.52 (-0.89 to -0.15) | not adopted |
| `role_workload` | -0.29 (-1.85 to +1.27) | +1.69 (+0.33 to +3.10) | not adopted |
| `role_vacated` | -0.24 (-1.37 to +0.85) | +0.17 (-1.02 to +1.35) | not adopted |
| `role_depth` | -0.06 (-0.14 to +0.02) | -0.37 (-0.70 to -0.04) | not adopted |
| `role_all` | -0.62 (-2.51 to +1.25) | +0.57 (-1.29 to +2.46) | not adopted |

Recent workload change helped in 2025 (+1.7) but not in 2026 (-0.3, wide interval), so it fails the rule. The others are
flat or negative. The sportsbook price is the practical way these late changes reach the app: books move on injury and
depth-chart news the same day, and the blend passes that through.
