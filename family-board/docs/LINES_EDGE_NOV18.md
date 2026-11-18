# Is there an edge on game totals or spreads? (Nov 18 2026)

Script: `research/lines_edge.py`; numbers: `research/lines_edge_results.json`. A bet at -110 needs 52.4% to break even.

## Method
* **Models**: the points-per-play formula (team plays per game x the average of its own points per play and the
  opponent's points per play allowed), with every option: shrinking rates toward the league average, last season at
  reduced weight, recent games weighted more, offensive points only, and opponent-adjusted ratings (points, offensive
  points, or points per play x expected plays). 138 settings in all.
* **Tuned on 2025** (weeks 3-18, ratings starting from 2024), then **frozen and scored once on 2026** (weeks 3-10).
* **Situational angles** (weather, prime time, division, rest, underdogs): counted on 2015-2023, checked on 2024-2026.

## Results
| | 2025 (tuning) | 2026 (held out) |
|---|---|---|
| Closing total: average miss | 9.94 | 10.05 |
| Original formula: average miss | 10.66 | 10.75 |
| Best formula variant: average miss | 10.52 | 10.68 |
| Best opponent-adjusted model: average miss | 10.35 | 10.70 |
| Best model, over/under when 3+ points from the line | 39-34 (53.4%) | 20-25 (44.4%) |
| Best model, against the spread when 3+ points from the line | 49-52 (48.5%) | 24-18 (57.1%) |

* No model beat the closing total or the closing spread in either season. The "information beyond the line" slope was
  never reliably above zero (largest t = 0.31 on 2025; negative on 2026).
* **Selection check**: 17 of the 138 settings showed 55%+ over/under on 2025. The same 17 went 375-432 (46.5%) on 2026.
  Looking good on one season was chance.
* The best model's 24-18 against the spread on 2026 is 42 bets with no support on 2025 (49-52); it is not evidence.

## Situational angles
| Angle | 2015-2023 | 2024-2026 |
|---|---|---|
| Wind 15+ mph outdoors: under | 102-78 (56.7%) | 16-18 (47.1%) |
| Cold (32F or less) outdoors: under | 49-32 (60.5%) | 10-17 (37.0%) |
| Prime time: under | 262-211 (55.4%) | 69-77 (47.3%) |
| Division game: under | 447-407 (52.3%) | 113-128 (46.9%) |
| Road underdog | 750-668 (52.9%) | 202-199 (50.4%) |
| Underdog of 10+ | 154-139 (52.6%) | 25-37 (40.3%) |
| Division underdog | 436-407 (51.7%) | 131-108 (54.8%) |

Several angles paid for years and then stopped: the books adjusted. None clears break-even in both periods.

## Conclusion
With public box-score and play-by-play data there is no usable edge on NFL totals or spreads. What remains real:
shopping for the best line and price, and acting on news before the line moves (which an hourly pull cannot do).
