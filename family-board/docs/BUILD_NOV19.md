# Nov 19 build: parlay correlation, chance ranges, testing dashboard, exchange-fair trial

Four items from the six-model framework review. Each was tested before anything was switched on.

## 1. Same-team parlays (tested; maths NOT changed)
`research/parlay_corr.py` → `research/parlay_corr_results.json`.
- Teammates' touchdowns are slightly negatively linked (outcome correlation −0.024 in 2025, −0.021 in 2026).
- 2026 (well-calibrated chances): same-team pairs both scored 4.58% of the time vs 5.04% from multiplying (ratio 0.91).
  Shortfall −0.0046, 90% interval −0.0098 to +0.0010: not statistically firm.
- A competition model matched the rate but its log-loss gain was +0.24 ×1e-3 with interval [−0.31, +0.82]; leave-one-week-out −0.05.
- Opposite-team pairs in the same game matched independence (ratio 1.01).
- Decision (the app's adoption rule needs the whole 90% interval above zero): no change to `parlayChance`.
  The parlay builder shows a plain note for same-team legs; `parlayChance` now returns `sameTeam`.

## 2. Uncertainty range on each touchdown chance
- `grade.RANGE = {sd_logit: 0.36, z: 1.28}` → `slate.json` `range`. Range = logit(chance) ± 0.46.
- Sized from data: on 407 graded player-games (2026 weeks 2–4) 80% of model-vs-sportsbook gaps fell inside ±0.46 on
  the log-odds scale. `grades.json` `range_check` re-measures it on live results.
- It describes how far the model typically sits from the books. It is not a guarantee about the true chance.
- App: "Likely range" row in the player detail (narrower when the chance already includes the books' prices, by the
  blend's model weight). The "Above fair" marker now says "clears range" (purple) when even the low end beats the
  price, or "in range" (grey) when the price sits inside the range.
- Honest result: in the historical test the "clears range" rule went 0 for 9. A large disagreement with the books has
  so far meant the model was missing something, not that the price was wrong.

## 3. Testing dashboard (Research tab)
`grade.betting()` → `grades.json` `betting` (live) and `betting_backtest` (historical, from `research/betting_record.py`).
Flat one-unit bets at the best pregame price:

| Rule | Bets | Won | Units | Return | 90% range | Worst slide | Longest losing run |
|---|---|---|---|---|---|---|---|
| Every priced player | 407 | 113 | −19.5 | −4.8% | −15.7% to +6.9% | 52.4 | 20 |
| Above fair marker (model ≥ 3 pts over price) | 36 | 8 | −1.4 | −3.9% | −46.6% to +35.9% | 14.5 | 11 |
| Low end of range clears the price | 9 | 0 | −9.0 | −100% | n/a (9 bets) | 9.0 | 9 |

(2026 weeks 2–4, BetMGM and FanDuel workbook prices, rolling point-in-time forecasts.) No rule shows a proven edge.
The dashboard also shows calibration, week-by-week log loss, splits by price band / position / week, pregame price
movement, the blend's live check, the value-flag closing-price record and the range check. Live sections fill in as
graded games with feed prices accumulate.

## 4. Exchange fair prices as the blend's market input (trial only)
- Two-sided exchange TD prices exist only from the Nov 2026 feed, so this cannot be backtested.
- `odds_feed.archive` now keeps `fair_p` / `fair_n` in `odds_feed_history.json`; `grade.py` writes `blend_fair_live`
  (same blend, exchange fair chance instead of raw implied) beside `blend_live`, on the same player-games.
- Nothing in the app uses it. Switching would need the usual rule: clearly better on 300+ player-games.
