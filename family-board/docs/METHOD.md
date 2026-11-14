# Method

## Touchdowns
- Source: nflverse 2026 play-by-play, built from the NFL's Game Statistics & Information System feed.
- A touchdown is a play with `touchdown == 1` that is not a two-point try. Nullified plays carry no touchdown flag.
- The scorer is `td_player`: the receiver on passing TDs, the ball carrier on rushing TDs (including quarterbacks), the returner on returns.
- Types: passing, rushing, interception return, fumble return, fumble recovery, kickoff return, punt return, blocked punt or kick return.
  Unit is special teams for kicking plays, otherwise offense when the scoring team had the ball and defense when it did not.
- **Reconciliation:** for each final game, each team's 6 × touchdowns + extra points + 3 × field goals + 2 × two-point conversions + 2 × safeties (and defensive conversion returns) must equal the official final score. 137 of 137 final games through Week 10 Thursday reconcile.
  NFL.com game books were not reachable from the build environment, so the official final score is the reconciliation target.
- Records are keyed by `game_id:play_id`, so a rerun replaces corrected plays without duplicates.

## Defender responsibility
Statuses: Verified individual, Probable individual, Shared, Team or unit, Unknown.
- Proximity, depth chart, or appearing in the play text never establishes responsibility.
- The only automated source is PFR's per-game defensive charting (`def_receiving_td_allowed`). It is per game, not per play, so it is mapped to a play only when **one** charted defender accounts for **every** receiving TD the team allowed in that game. That gives a **Probable individual** (primary coverage). It stays Probable, not Verified, because coverage type, safety help and post-catch tackles are not charted.
- When several defenders were charted, the play stays **Unknown** and lists them as candidates.
- Rushing, return and recovery touchdowns stay **Unknown**: no permitted public source charts missed tackles, run fits or lane assignments by play.
- Admins can record film or charting evidence in the review queue. Observed actions and inferred assignments are separate fields; Verified requires a cited source or film timestamp; every edit keeps the prior version.

## Baseline anytime-TD model (`baseline-usage-v0.1`, research only)
1. Team implied points from the closing spread and total.
2. Expected offensive TDs = implied points × the season's offensive TDs per point.
3. Each player's share = their season expected-TD opportunity (carries and targets weighted by league TD rates inside the 10, inside the 20, and elsewhere) ÷ the team's.
4. λ = team TDs × share; P(≥1 TD) = 1 − e^(−λ). Fair odds are the American price at P.
Walk-forward test (each week predicted from earlier weeks only, players who took an offensive snap): Brier 0.138 vs 0.154 for a constant forecast; log loss 0.452 vs 0.487. It underrates low-usage players (predicted 1.6%, actual 6.4% in the lowest band), so it is not calibrated.

### Value Play gate
A candidate can be labelled Value Play only when all hold: at least 2,000 graded player-games; Brier better than constant; every calibration band with 50+ cases within 3 points; at least 200 picks with a closing price to measure closing-line value; and a live, reviewed price under 2 hours old. Today the gate fails, so the app shows research only. A week with zero Value Plays is a valid result.

### Suggested slates
3, 5 and 7 legs and the full week use one player per open game; 10 legs use one per team. The joint figure multiplies leg probabilities, which assumes independence; one-per-team slates can share a game, and the page says so. Combined sportsbook odds are never quoted.

## Picks and settlement
- Picks are keyed by week + market + player, so a member cannot pick the same player twice in a week.
- The page blocks changes after kickoff (Eastern Time). The shared store has no server clock, so the authoritative lock is the **kickoff snapshot**: after kickoff the refresh (or an admin) freezes every submitted pick for that game. Settlement counts only picks that match the snapshot; anything else is Needs review.
- Win: the player is credited with a touchdown in that game. Void: the player took no snap (house rule). Loss: played, no touchdown. Needs review: participation not yet published, or not in the snapshot.
- The price and its timestamp at submission are saved with the pick. Picks without a live or fresh price can still be submitted and carry a warning.

## Matchup adjustments (`matchup.py`) — shown, not yet adopted
- **Position factor:** touchdowns a defence has allowed to RBs, WRs, TEs and QBs, split into rushing and receiving, per game against the league rate, shrunk toward average with 16 games of prior weight.
- **Coverage factor:** the defence's charted coverage players' receiving TDs per target (PFR), shrunk with 600 targets of prior weight.
- Each player's expected touchdowns are split into rushing and receiving parts, multiplied by the factors, then scaled so the team total still equals the betting-implied total.
- **Walk-forward result (weeks 4–10, 1,899 player-games):** log loss 0.4521 usage only; 0.4524 with position factors; 0.4532 with position and coverage. With lighter shrinkage (4 games / 120 targets) both were significantly worse; heavier shrinkage converges to usage only. No setting beat usage alone.
- **Rule:** headline probabilities switch to a matchup variant only when the 90% bootstrap interval (resampling games) of its log-loss gain is above zero. The check reruns on every refresh. Until then the app shows the matchup boost as "untested".

## Defender leaderboard (`defenders.json`)
Season sums of PFR defensive charting per defender: targets, completions, yards, receiving TDs allowed, interceptions, missed tackles. Rates are shown only with 25+ targets.
