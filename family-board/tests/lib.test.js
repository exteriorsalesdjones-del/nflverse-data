// Run: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const FB = require("../artifact/lib.js");

test("Eastern kickoff converts to UTC across DST", () => {
  assert.strictEqual(new Date(FB.etToUtcMs("2026-09-13T13:00")).toISOString(), "2026-09-13T17:00:00.000Z"); // EDT
  assert.strictEqual(new Date(FB.etToUtcMs("2026-11-15T13:00")).toISOString(), "2026-11-15T18:00:00.000Z"); // EST
  assert.strictEqual(new Date(FB.etToUtcMs("2026-11-15T09:30")).toISOString(), "2026-11-15T14:30:00.000Z");
});

const game = { game_id: "2026_10_KC_ATL", week: 10, kickoff_et: "2026-11-15T13:00", status: "upcoming" };
const before = Date.parse("2026-11-15T17:59:00Z"), after = Date.parse("2026-11-15T18:00:00Z");

test("kickoff lock", () => {
  assert.strictEqual(FB.isLocked(game, before), false);
  assert.strictEqual(FB.isLocked(game, after), true);
  assert.strictEqual(FB.isLocked({ ...game, status: "final" }, before), true);
});

test("duplicate and lock validation", () => {
  const pick = { week: 10, gsis_id: "00-1", market: "anytime_td" };
  assert.deepStrictEqual(FB.validatePick({}, pick, game, before), []);
  const items = { [FB.pickKey(10, "00-1")]: pick };
  assert.match(FB.validatePick(items, pick, game, before).join(), /already picked/);
  assert.match(FB.validatePick({}, pick, game, after).join(), /locked/);
});

test("odds maths", () => {
  assert.ok(Math.abs(FB.americanToProb(-150) - 0.6) < 1e-9);
  assert.ok(Math.abs(FB.americanToProb(+300) - 0.25) < 1e-9);
  assert.strictEqual(FB.probToAmerican(0.25), 300);
  const e = FB.edge(0.3, 300);
  assert.ok(Math.abs(e.edgePts - 5) < 1e-9 && Math.abs(e.evPerDollar - 0.2) < 1e-9);
  assert.strictEqual(FB.edge(0.3, null), null);
});

test("settlement states", () => {
  const key = FB.pickKey(10, "00-1");
  const pick = { key, week: 10, gsis_id: "00-1", status: "submitted" };
  const fin = { ...game, status: "final" };
  const lock = { [key]: { gsis_id: "00-1", status: "submitted" } };
  const now = after + 5 * 3600e3;
  assert.strictEqual(FB.settle(pick, game, [], undefined, undefined, before).state, "pending");
  assert.strictEqual(FB.settle(pick, fin, [{ scorer_id: "00-1" }], ["00-1"], lock, now).state, "win");
  assert.strictEqual(FB.settle(pick, fin, [], ["00-1"], lock, now).state, "loss");
  assert.strictEqual(FB.settle(pick, fin, [], ["00-2"], lock, now).state, "void");
  assert.strictEqual(FB.settle(pick, fin, [], undefined, lock, now).state, "pending"); // who played isn't published yet: waiting, not a review
  assert.strictEqual(FB.settle(pick, fin, [{ scorer_id: pick.gsis_id }], undefined, lock, now).state, "win"); // a scorer played
  assert.strictEqual(FB.settle(pick, fin, [], ["00-1"], {}, now).state, "needs_review"); // added after kickoff
  assert.strictEqual(FB.settle(pick, fin, [], ["00-1"], undefined, now).state, "needs_review"); // no snapshot
  assert.strictEqual(FB.settle({ ...pick, status: "draft" }, fin, [], [], lock, now).state, "draft");
});

test("suggested slates respect one-per-game and report gaps", () => {
  const c = [
    { gsis_id: "a", game_id: "g1", team: "A", p: 0.5 }, { gsis_id: "b", game_id: "g1", team: "B", p: 0.4 },
    { gsis_id: "c", game_id: "g2", team: "C", p: 0.3 }, { gsis_id: "d", game_id: "g3", team: "D", p: 0.2, quality: "unavailable" },
  ];
  const s3 = FB.suggestSlate(c, 3, "game");
  assert.deepStrictEqual(s3.legs.map((x) => x.gsis_id), ["a", "c"]);
  assert.strictEqual(s3.short, 1);
  assert.ok(Math.abs(s3.jointP - 0.15) < 1e-9);
  assert.strictEqual(FB.suggestSlate(c, 3, "team").legs.length, 3);
});

test("model gate blocks Value Play until validated", () => {
  const v = { n: 1899, brier: 0.137, brier_constant: 0.154, calibration: [{ bin: "x", n: 595, pred: 0.016, actual: 0.064 }] };
  const g = FB.modelValidated(v);
  assert.strictEqual(g.ok, false);
  assert.ok(g.reasons.length >= 2);
});

test("odds rows match candidates by name and team", () => {
  const cands = [{ player: "T.McBride", full_name: "Trey McBride", team: "ARI", gsis_id: "x" }, { player: "T.Hill", full_name: "Tyreek Hill", team: "MIA" }];
  assert.strictEqual(FB.matchOdds({ player: "Trey McBride", team: "ARI" }, cands).gsis_id, "x");
  assert.strictEqual(FB.matchOdds({ player: "Nobody" }, cands), null);
});

test("csv escaping", () => {
  assert.strictEqual(FB.csv([{ a: 'x,"y"' }], [{ label: "A", get: (r) => r.a }]), 'A\n"x,""y"""');
});

test("parlay settlement: void legs dropped, any loss loses", () => {
  assert.strictEqual(FB.settleParlay(["win", "win"]).state, "win");
  assert.strictEqual(FB.settleParlay(["win", "void"]).state, "win");
  assert.strictEqual(FB.settleParlay(["void", "void"]).state, "void");
  assert.strictEqual(FB.settleParlay(["win", "pending"]).state, "pending");
  assert.strictEqual(FB.settleParlay(["loss", "pending"]).state, "loss");
  assert.strictEqual(FB.settleParlay(["win", "needs_review"]).state, "needs_review");
});

test("parlay locks at the first leg's kickoff", () => {
  const games = { a: { kickoff_et: "2026-11-15T13:00", status: "upcoming" }, b: { kickoff_et: "2026-11-15T16:25", status: "upcoming" } };
  const legs = [{ game_id: "a" }, { game_id: "b" }];
  assert.strictEqual(FB.parlayLocked(legs, games, Date.parse("2026-11-15T17:59:00Z")), false);
  assert.strictEqual(FB.parlayLocked(legs, games, Date.parse("2026-11-15T18:00:00Z")), true);
  const c = FB.parlayChance([{ p: 0.5, game_id: "a" }, { p: 0.4, game_id: "a" }]);
  assert.ok(Math.abs(c.p - 0.2) < 1e-9 && c.sameGame);
});

test("matchup slates rank by boost with a 15% floor, one per game", () => {
  const c = [
    { gsis_id: "a", game_id: "g1", p: 0.50, p_matchup: 0.52, matchup_pct: 4 },
    { gsis_id: "b", game_id: "g1", p: 0.25, p_matchup: 0.32, matchup_pct: 28 },
    { gsis_id: "c", game_id: "g2", p: 0.06, p_matchup: 0.10, matchup_pct: 66 },   // below floor
    { gsis_id: "d", game_id: "g2", p: 0.30, p_matchup: 0.27, matchup_pct: -10 },  // a cut, never suggested
    { gsis_id: "e", game_id: "g3", p: 0.20, p_matchup: 0.24, matchup_pct: 20 },
  ];
  const s = FB.suggestSlate(c, 3, "game", { by: "matchup" });
  assert.deepStrictEqual(s.legs.map((x) => x.gsis_id), ["b", "e"]);
  assert.strictEqual(s.short, 1);
  assert.ok(Math.abs(s.jointMatchupP - 0.32 * 0.24) < 1e-9 && Math.abs(s.jointP - 0.25 * 0.2) < 1e-9);
  assert.deepStrictEqual(FB.suggestSlate(c, 2, "game").legs.map((x) => x.gsis_id), ["a", "d"]);
});

test("American odds parsing: EVEN, signs, invalid values", () => {
  assert.strictEqual(FB.parseAmerican("+180"), 180);
  assert.strictEqual(FB.parseAmerican("-120"), -120);
  assert.strictEqual(FB.parseAmerican("EVEN"), 100);
  assert.ok(isNaN(FB.parseAmerican("+90")));
  assert.ok(isNaN(FB.parseAmerican("1.85")));
  assert.ok(isNaN(FB.parseAmerican("")));
  assert.ok(Math.abs(FB.americanToProb(-110) - 110 / 210) < 1e-12);
  assert.ok(Math.abs(FB.americanToDecimal(180) - 2.8) < 1e-12 && Math.abs(FB.americanToDecimal(-125) - 1.8) < 1e-12);
});

test("line parsing reports skipped rows instead of dropping them", () => {
  const r = FB.parseLines("player,team,book,market,price\nTrey McBride,ARI,FanDuel,anytime,+180\nTrey McBride,ARI,FanDuel,2+,EVEN\nX,ARI,FD,first td,+500\nY,ARI,FD,anytime,+90\nZ,ARI,FD,+150", "2026-11-15T15:00:00.000Z");
  assert.deepStrictEqual(r.rows.map((x) => [x.player, x.market, x.american]), [["Trey McBride", "anytime_td", 180], ["Trey McBride", "2plus_td", 100], ["Z", "anytime_td", 150]]);
  assert.strictEqual(r.skipped.length, 2);
  assert.match(r.skipped[0].why, /market/); assert.match(r.skipped[1].why, /price/);
});

test("best price: highest payout among fresh prices, latest per book, stale fallback", () => {
  const now = Date.parse("2026-11-15T17:00:00Z");
  const rows = [
    { book: "FanDuel", american: 150, captured_at: "2026-11-15T16:30:00Z" },
    { book: "FanDuel", american: 200, captured_at: "2026-11-15T12:00:00Z" },   // older FanDuel price ignored
    { book: "DraftKings", american: 170, captured_at: "2026-11-15T16:00:00Z" },
    { book: "BetMGM", american: 250, captured_at: "2026-11-14T16:00:00Z" },    // stale (>2h)
  ];
  const b = FB.bestPrice(rows, now, 120);
  assert.strictEqual(b.book, "DraftKings"); assert.strictEqual(b.american, 170); assert.strictEqual(b.stale, false); assert.strictEqual(b.books, 2);
  const s = FB.bestPrice([{ book: "BetMGM", american: 250, captured_at: "2026-11-14T16:00:00Z" }], now, 120);
  assert.strictEqual(s.stale, true);
  assert.strictEqual(FB.bestPrice([], now, 120), null);
  assert.strictEqual(FB.bestPrice([{ book: "A", american: -150, captured_at: "2026-11-15T16:50:00Z" }, { book: "B", american: -130, captured_at: "2026-11-15T16:50:00Z" }], now, 120).book, "B");
});

test("uploaded prices: started games, future and old timestamps are rejected", () => {
  const g = { kickoff_et: "2026-11-15T13:00", status: "upcoming" };
  const before = Date.parse("2026-11-15T17:30:00Z"), after = Date.parse("2026-11-15T18:30:00Z");
  assert.strictEqual(FB.lineProblem({ captured_at: "2026-11-15T17:20:00Z" }, g, before), null);
  assert.match(FB.lineProblem({ captured_at: "2026-11-15T18:20:00Z" }, g, after), /started/);
  assert.match(FB.lineProblem({ captured_at: "2026-11-15T19:00:00Z" }, g, before), /future/);
  assert.match(FB.lineProblem({ captured_at: "2026-11-01T17:20:00Z" }, g, before), /7 days/);
  assert.strictEqual(FB.lineProblem({ captured_at: "2026-11-15T17:20:00Z" }, null, before), null); // unmatched rows still allowed
});

test("freshness policy: boundary at 120 minutes, future-dated and invalid times are not fresh", () => {
  const now = Date.parse("2026-11-15T17:00:00Z");
  assert.strictEqual(FB.PRICE_FRESH_MIN, 120);
  assert.strictEqual(FB.priceFresh({ captured_at: "2026-11-15T15:00:00Z" }, now), true);   // exactly 120 min
  assert.strictEqual(FB.priceFresh({ captured_at: "2026-11-15T14:59:00Z" }, now), false);  // 121 min
  assert.strictEqual(FB.priceFresh({ captured_at: "2026-11-15T17:05:00Z" }, now), true);   // 5 min ahead: clock slack
  assert.strictEqual(FB.priceFresh({ captured_at: "2026-11-15T17:11:00Z" }, now), false);  // 11 min ahead: invalid
  assert.strictEqual(FB.priceFresh({ captured_at: "not a time" }, now), false);
  assert.strictEqual(FB.priceFresh({}, now), false);
});

test("best price: worked cases (newest per book first, then best payout among fresh only)", () => {
  const now = Date.parse("2026-11-15T17:00:00Z");
  // FanDuel's older +300 is superseded by its newer +150; BetMGM +400 is stale; DraftKings +170 fresh -> DraftKings wins
  const b = FB.bestPrice([
    { book: "FanDuel", american: 300, captured_at: "2026-11-15T15:30:00Z" },
    { book: "FanDuel", american: 150, captured_at: "2026-11-15T16:40:00Z" },
    { book: "DraftKings", american: 170, captured_at: "2026-11-15T16:00:00Z" },
    { book: "BetMGM", american: 400, captured_at: "2026-11-15T10:00:00Z" },
    { book: "Caesars", american: 900, captured_at: "2026-11-15T18:30:00Z" },   // future-dated: ignored
    { book: "BetRivers", american: 800, captured_at: "garbage" },              // invalid time: ignored
    { book: "PointsBet", american: "abc", captured_at: "2026-11-15T16:50:00Z" } // invalid price: ignored
  ], now);
  assert.deepStrictEqual([b.book, b.american, b.stale, b.books], ["DraftKings", 170, false, 2]);
  assert.deepStrictEqual(b.others.map((o) => [o.book, o.american]), [["FanDuel", 150]]);
  // negative odds: -105 pays 1.952 per $1, -110 pays 1.909 -> -105 is better
  assert.strictEqual(FB.bestPrice([{ book: "A", american: -110, captured_at: "2026-11-15T16:50:00Z" }, { book: "B", american: -105, captured_at: "2026-11-15T16:50:00Z" }], now).american, -105);
  // +100 (2.00) beats -105 (1.952)
  assert.strictEqual(FB.bestPrice([{ book: "A", american: 100, captured_at: "2026-11-15T16:50:00Z" }, { book: "B", american: -105, captured_at: "2026-11-15T16:50:00Z" }], now).book, "A");
  // tie on price: the newer observation is shown
  assert.strictEqual(FB.bestPrice([{ book: "A", american: 150, captured_at: "2026-11-15T16:10:00Z" }, { book: "B", american: 150, captured_at: "2026-11-15T16:40:00Z" }], now).book, "B");
  // only stale prices: newest observation, flagged stale
  const s = FB.bestPrice([{ book: "A", american: 400, captured_at: "2026-11-15T09:00:00Z" }, { book: "B", american: 200, captured_at: "2026-11-15T11:00:00Z" }], now);
  assert.deepStrictEqual([s.book, s.stale], ["B", true]);
  // nothing valid -> null (never a default price)
  assert.strictEqual(FB.bestPrice([{ book: "A", american: 150, captured_at: "" }], now), null);
});

test("observation times: zone-less times are Eastern, not the browser's zone", () => {
  assert.strictEqual(new Date(FB.parseObserved("2026-11-15 12:30")).toISOString(), "2026-11-15T17:30:00.000Z"); // EST = UTC-5
  assert.strictEqual(new Date(FB.parseObserved("2026-09-13T12:30")).toISOString(), "2026-09-13T16:30:00.000Z"); // EDT = UTC-4
  assert.strictEqual(new Date(FB.parseObserved("2026-11-15T12:30:00-05:00")).toISOString(), "2026-11-15T17:30:00.000Z");
  assert.strictEqual(new Date(FB.parseObserved("2026-11-15T17:30:00.000Z")).toISOString(), "2026-11-15T17:30:00.000Z");
  assert.ok(isNaN(FB.parseObserved("11/15 12:30pm")));
  const r = FB.parseLines("A,ARI,FD,anytime,+150,2026-11-15 12:30\nB,ARI,FD,anytime,+150", "2026-11-15T17:45:00.000Z");
  assert.deepStrictEqual(r.rows.map((x) => [x.captured_at, x.time_source]), [["2026-11-15T17:30:00.000Z", "provided"], ["2026-11-15T17:45:00.000Z", "upload time"]]);
});

test("only full-game anytime and 2+ markets are comparable", () => {
  for (const m of ["1st Half Anytime TD", "2nd half anytime", "1Q anytime TD", "First TD Scorer", "Last TD", "1H Anytime"]) assert.strictEqual(FB.normMarket(m), null, m);
  assert.strictEqual(FB.normMarket("Anytime TD Scorer"), "anytime_td");
  assert.strictEqual(FB.normMarket("To Score 2+ Touchdowns"), "2plus_td");
  // the count decides before the word "anytime": a +900 two-TD price must never be stored as an anytime price
  for (const m of ["Anytime 2+ TD", "2+ Anytime Touchdowns", "Anytime TD Scorer (2 or more)", "Two or more touchdowns", "Player to score 2 touchdowns", "2+ TDs"]) assert.strictEqual(FB.normMarket(m), "2plus_td", m);
  for (const m of ["Anytime TD", "anytime", "", "ATD", "Anytime Touchdown Scorer"]) assert.strictEqual(FB.normMarket(m), "anytime_td", m);
  assert.strictEqual(FB.normMarket("3+ TDs"), null);
  assert.ok(Number.isNaN(FB.americanToDecimal(0)) && Number.isNaN(FB.americanToDecimal(50)));
  // model + market blend: equal parts on the log-odds scale; no usable price -> the model's chance unchanged
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(FB.blendChance(0.2, [0.2]), 0.2) && close(FB.blendChance(0.5, [0.5, 0.5]), 0.5));
  assert.ok(close(FB.blendChance(0.2, [0.5]), 1 / 3), String(FB.blendChance(0.2, [0.5])));   // logit(.2) = -ln4, logit(.5) = 0 -> -ln2 -> 1/3
  assert.ok(FB.blendChance(0.3, [0.4, 0.5]) > 0.3 && FB.blendChance(0.3, [0.4, 0.5]) < 0.45);
  assert.strictEqual(FB.blendChance(0.3, []), 0.3); assert.strictEqual(FB.blendChance(0.3, [NaN, 0, 1]), 0.3); assert.strictEqual(FB.blendChance(0.3, null), 0.3);
  assert.ok(close(FB.blendChance(0.2, [0.5], 1), 0.2) && close(FB.blendChance(0.2, [0.5], 0), 0.5));
  // rankings: the headline chance can include the price, but value is judged on the model's own chance
  const rk = FB.weeklyRankings([{ key: "a", name: "A", chance: 0.30, valueChance: 0.20, prices: [{ american: 300, book: "FD", captured_at: new Date(Date.now() - 6e5).toISOString() }] }], Date.now());
  assert.strictEqual(rk.value.length, 0); assert.strictEqual(rk.chance[0].chance, 0.30);
});

test("model vs price: percentage points and EV per $1, worked by hand", () => {
  // p = 0.50 at -150: implied 150/250 = 0.60; diff -10 pts; decimal 1 + 100/150 = 1.6667; EV = 0.5*0.6667 - 0.5 = -0.1667
  const e = FB.edge(0.5, -150);
  assert.ok(Math.abs(e.implied - 0.6) < 1e-12 && Math.abs(e.edgePts + 10) < 1e-9 && Math.abs(e.evPerDollar + 1 / 6) < 1e-9);
  // p = 0.40 at +200: implied 1/3; +6.67 pts; EV = 0.4*2 - 0.6 = +0.20
  const f = FB.edge(0.4, 200);
  assert.ok(Math.abs(f.edgePts - 6.6667) < 1e-3 && Math.abs(f.evPerDollar - 0.2) < 1e-9);
  assert.strictEqual(FB.edge(0.4, NaN), null);
  assert.strictEqual(FB.edge(null, 200), null);
});

test("new-snapshot eligibility: missing, zone-less, unreadable, at and after kickoff all go to review", () => {
  const g = { kickoff_et: "2026-11-15T13:00", status: "upcoming" }; // 18:00Z
  const el = (t) => FB.snapshotEligibility(t === undefined ? {} : { submitted_at: t }, g);
  assert.strictEqual(el("2026-11-15T17:59:59Z").ok, true);
  assert.strictEqual(el("2026-11-15T12:59:00-05:00").ok, true);
  for (const [t, re] of [[undefined, /No submission time/], ["2026-11-15T17:00:00", /time zone/], ["soon", /time zone|unreadable/],
                         ["2026-11-15T18:00:00Z", /at or after/], ["2026-11-15T18:00:01Z", /at or after/]]) {
    const r = el(t); assert.strictEqual(r.ok, false, String(t)); assert.match(r.why, re);
  }
});

test("historical compatibility vs eligibility: an existing snapshot keeps a legacy pick's result", () => {
  const key = FB.pickKey(10, "00-1");
  const legacy = { key, week: 10, gsis_id: "00-1", status: "submitted" }; // predates submitted_at
  const fin = { kickoff_et: "2026-11-15T13:00", status: "final" };
  const later = Date.parse("2026-11-16T12:00:00Z");
  // already frozen (existing snapshot): settles normally, never re-evaluated
  assert.strictEqual(FB.settle(legacy, fin, [{ scorer_id: "00-1" }], ["00-1"], { [key]: { gsis_id: "00-1", status: "submitted" } }, later).state, "win");
  // new snapshot under the current rule: held out, so the same pick settles as needs_review
  assert.strictEqual(FB.snapshotEligibility(legacy, fin).ok, false);
  assert.strictEqual(FB.settle(legacy, fin, [{ scorer_id: "00-1" }], ["00-1"], {}, later).state, "needs_review");
});

/* ---------------- Results dashboard: hand-worked fixture ----------------
   2026 W1: A picks P1 (2 TDs, hit, p .5); B picks the same P1 (hit, p .4); A picks P2 (0 TDs, miss, p .2); A picks P3 (void)
            plus an exact duplicate of A's P1 record (dropped, counted as duplicate)
   2026 W2: A P4 hit (1 TD, p .3); A P5 miss (p .1); A P6 needs review
   2026 W3: no picks (a gap, not 0%)
   2026 W4: A P7 miss (p .6); B P8 miss (no saved probability)
   2025 W1: A P9 hit (3 TDs, p .5)                                                                                  */
const R = (season, week, uid, pid, state, tds, p, extra = {}) => ({ season, week, game_id: `${season}_${String(week).padStart(2, "0")}_G${pid}`, kickoff_ms: 0, uid, gsis_id: pid,
  player: pid, team: pid === "P2" ? "BUF" : "KC", pos: pid === "P4" ? "WR" : "RB", market: "anytime_td", p, state, why: "", tds, game_final: true, ...extra });
const FIX = [
  R(2026, 1, "A", "P1", "win", 2, 0.5), { ...R(2026, 1, "B", "P1", "win", 2, 0.4) }, R(2026, 1, "A", "P2", "loss", 0, 0.2), R(2026, 1, "A", "P3", "void", 0, 0.3),
  R(2026, 1, "A", "P1", "win", 2, 0.5),
  R(2026, 2, "A", "P4", "win", 1, 0.3), R(2026, 2, "A", "P5", "loss", 0, 0.1), R(2026, 2, "A", "P6", "needs_review", null, 0.25),
  R(2026, 4, "A", "P7", "loss", 0, 0.6), R(2026, 4, "B", "P8", "loss", 0, null),
  R(2025, 1, "A", "P9", "win", 3, 0.5),
];
FIX[1].game_id = FIX[0].game_id; // B picked the same player-game as A

test("dashboard summary: hits/misses only from settled picks; void, review, pending separate; duplicates dropped", () => {
  const d = FB.dashboard(FIX, {});
  // 10 records after dropping 1 duplicate: hits P1(A), P1(B), P4, P9 = 4; misses P2, P5, P7, P8 = 4
  assert.deepStrictEqual([d.summary.n, d.summary.hits, d.summary.misses, d.summary.settled, d.summary.void, d.summary.review, d.summary.pending, d.summary.duplicates], [10, 4, 4, 8, 1, 1, 0, 1]);
  assert.strictEqual(d.summary.hitRate, 0.5); assert.strictEqual(d.summary.missRate, 0.5);
});

test("dashboard weeks are season-aware, gaps stay gaps, cumulative rate uses running counts", () => {
  const d = FB.dashboard(FIX, {});
  assert.deepStrictEqual(d.weeks.map((w) => [w.season, w.week, w.hits, w.settled]), [[2025, 1, 1, 1], [2026, 1, 2, 3], [2026, 2, 1, 2], [2026, 4, 0, 2]]);
  assert.ok(!d.weeks.some((w) => w.week === 3)); // no picks in week 3: absent, not 0%
  // cumulative: 1/1, 3/4, 4/6, 4/8 -> final 0.5; the mean of weekly rates would be (1 + 2/3 + 1/2 + 0)/4 = 0.5417
  assert.deepStrictEqual(d.cumulative.map((c) => [c.hits, c.settled]), [[1, 1], [3, 4], [4, 6], [4, 8]]);
  assert.strictEqual(d.cumulative[3].hitRate, 0.5);
});

test("dashboard filters apply to every section consistently", () => {
  const d = FB.dashboard(FIX, { filters: { season: 2026, pos: "RB" } });
  const s = d.summary.settled;
  assert.strictEqual(s, 6); // 2026 RB settled: P1(A), P1(B), P2, P5, P7, P8
  assert.strictEqual(d.weeks.reduce((a, w) => a + w.settled, 0), s);
  for (const k of ["member", "position", "team", "market", "probability"]) assert.strictEqual(d.categories[k].reduce((a, c) => a + c.settled, 0), s, k);
  assert.strictEqual(d.touchdowns.selections + d.touchdowns.unknown, s);
  assert.ok(d.rows.every((r) => r.season === 2026 && r.pos === "RB"));
  assert.strictEqual(FB.dashboard(FIX, { filters: { weekFrom: 2, weekTo: 2, season: 2026 } }).summary.settled, 2);
});

test("touchdowns: per-selection totals repeat shared picks; unique player-game totals do not", () => {
  const t = FB.dashboard(FIX, { filters: { season: 2026 } }).touchdowns;
  // settled selections with known TDs: P1(A) 2, P1(B) 2, P2 0, P4 1, P5 0, P7 0, P8 0 -> 7 selections, 5 TDs
  assert.deepStrictEqual([t.selections, t.perSelectionTotal, t.uniquePlayerGames, t.uniqueTotal], [7, 5, 6, 3]);
  assert.deepStrictEqual(t.dist, { "0": 4, "1": 1, "2": 2, "3+": 0 });
  assert.ok(Math.abs(t.avgPerSelection - 5 / 7) < 1e-12);
  const u = FB.dashboard(FIX, { filters: { season: 2026 }, unit: "unique" });
  assert.deepStrictEqual([u.summary.n, u.summary.hits, u.summary.settled], [8, 2, 6]); // P1 counted once
});

test("calibration uses only probabilities saved at pick time; worked Brier score", () => {
  const c = FB.dashboard(FIX, { filters: { season: 2026 } }).calibration;
  // p: .5 hit, .4 hit, .2 miss, .3 hit, .1 miss, .6 miss; P8 has none
  assert.strictEqual(c.n, 6); assert.strictEqual(c.missing, 1); assert.strictEqual(c.observed, 3);
  assert.ok(Math.abs(c.expected - 2.1) < 1e-12 && Math.abs(c.diff - 0.9) < 1e-12);
  // Brier = (.25 + .36 + .04 + .49 + .01 + .36) / 6 = 1.51 / 6
  assert.ok(Math.abs(c.brier - 1.51 / 6) < 1e-12);
  assert.strictEqual(FB.dashboard(FIX.map((r) => ({ ...r, p: null })), {}).calibration, null);
  assert.strictEqual(FB.dashboard(FIX.map((r) => ({ ...r, p: null })), {}).categories.probability[0].key, "Not recorded");
});

test("extremes list every tied week; week runs use the explicit expected-hits benchmark", () => {
  const d = FB.dashboard(FIX, { filters: { season: 2026 } });
  assert.deepStrictEqual(d.extremes.best.map((w) => w.week), [1]); assert.deepStrictEqual(d.extremes.worst.map((w) => w.week), [4]);
  // W1: 2 hits vs expected 1.1 (above); W2: 1 vs 0.4 (above); W4 has a pick without a saved probability -> not compared
  assert.deepStrictEqual([d.weekRuns.longestAbove, d.weekRuns.longestBelow, d.weekRuns.weeksCompared], [2, 0, 2]);
  const tie = FB.dashboard([R(2026, 1, "A", "X", "win", 1, 0.5), R(2026, 2, "A", "Y", "win", 1, 0.5)], {});
  assert.deepStrictEqual(tie.extremes.best.map((w) => w.week), [1, 2]);
});

test("empty and unsettled datasets never divide by zero or show 0% as a rate", () => {
  const e = FB.dashboard([], {});
  assert.deepStrictEqual([e.summary.n, e.summary.hitRate, e.weeks.length, e.calibration, e.touchdowns.avgPerSelection, e.extremes.best.length], [0, null, 0, null, null, 0]);
  const p = FB.dashboard([R(2026, 10, "A", "Z", "pending", null, 0.3, { game_final: false })], {});
  assert.deepStrictEqual([p.summary.pending, p.summary.settled, p.summary.hitRate, p.weeks[0].complete, p.weeks[0].hitRate], [1, 0, null, false, null]);
});

/* ---------- book comparison, line moves, 2+ TDs ---------- */
const NOW = Date.parse("2026-11-15T16:00:00Z");
const row = (book, american, minAgo, extra = {}) => ({ gsis_id: "00-0039898", player: "Jahmyr Gibbs", team: "DET", game_id: "2026_10_NE_DET", market: "anytime_td",
  book, american, captured_at: new Date(NOW - minAgo * 60000).toISOString(), time_source: "provided", ...extra });

test("bookBoard: best payout first with its book; best/worst only when books differ; age shown, never dropped", () => {
  // the user's example: FanDuel -245, DraftKings -220 -> DraftKings is the better line
  const b = FB.bookBoard([row("FanDuel", -245, 30), row("DraftKings", -220, 300)], NOW);
  assert.deepStrictEqual([b.best.book, b.best.american, b.n], ["DraftKings", -220, 2]);
  assert.deepStrictEqual(b.books.map((x) => [x.book, x.rank]), [["DraftKings", "best"], ["FanDuel", "worst"]]);
  assert.deepStrictEqual([b.best.age_min, b.best.fresh, b.books[1].fresh, b.stale], [300, false, true, true]); // 5 h old still counts, flagged not fresh
  // one book, or every book on the same price: no best/worst colours
  assert.strictEqual(FB.bookBoard([row("FanDuel", 150, 10)], NOW).best.rank, "only");
  assert.deepStrictEqual(FB.bookBoard([row("FanDuel", 150, 10), row("BetMGM", 150, 5)], NOW).books.map((x) => x.rank), ["only", "only"]);
  // a book's newest observation wins; invalid prices, unreadable or future times are ignored
  const c = FB.bookBoard([row("FanDuel", 120, 90), row("FanDuel", 140, 20), row("BetMGM", "abc", 5), row("Caesars", 300, -60)], NOW);
  assert.deepStrictEqual(c.books.map((x) => [x.book, x.american]), [["FanDuel", 140]]);
  assert.strictEqual(FB.bookBoard([], NOW), null);
});

test("line moves are measured from the first price of the week, across uploaders", () => {
  // member A saw FanDuel open +200 (kept as open_*), now +160; member B's older upload had +210 -> the opening is +210 (earliest)
  const a = row("FanDuel", 160, 10, { open_american: 200, open_captured_at: new Date(NOW - 600 * 60000).toISOString() });
  const b2 = row("FanDuel", 210, 900);
  const m = FB.bookBoard([a, b2], NOW).best.move;
  assert.deepStrictEqual([m.from, m.to, m.dir, m.big], [210, 160, "shorter", true]);
  // implied 100/310 = 32.26% -> 100/260 = 38.46%: +6.2 points
  assert.ok(Math.abs(m.pts - 6.2) < 0.05, m.pts);
  // a small lengthening (-245 -> -240) is a move but not big; same price both times is no move
  const s = FB.bookBoard([row("FanDuel", -240, 5, { open_american: -245, open_captured_at: new Date(NOW - 400 * 60000).toISOString() })], NOW).best.move;
  assert.deepStrictEqual([s.dir, s.big], ["longer", false]);
  assert.strictEqual(FB.bookBoard([row("FanDuel", 150, 5, { open_american: 150, open_captured_at: new Date(NOW - 400 * 60000).toISOString() })], NOW).best.move, null);
  // lineMoves lists every changed book, big moves first; unmatched rows (no gsis_id) are left out
  const list = FB.lineMoves([a, b2, row("DraftKings", -240, 5, { open_american: -245, open_captured_at: new Date(NOW - 400 * 60000).toISOString() }),
    { ...row("BetMGM", 300, 5, { open_american: 400, open_captured_at: new Date(NOW - 400 * 60000).toISOString() }), gsis_id: null }], NOW);
  assert.deepStrictEqual(list.map((x) => [x.book, x.move.big]), [["FanDuel", true], ["DraftKings", false]]);
});

test("2+ TDs: Poisson estimate from the anytime chance, and settlement needs two TDs", () => {
  // p = 0.5: L = ln 2 = 0.6931; P(2+) = 1 - 0.5 x 1.6931 = 0.1534
  assert.ok(Math.abs(FB.p2plus(0.5) - 0.1534) < 1e-4);
  assert.ok(Math.abs(FB.p2plus(0.3) - 0.0503) < 1e-4);
  assert.deepStrictEqual([FB.p2plus(0), FB.p2plus(-1), FB.p2plus(NaN)], [0, 0, 0]);
  assert.ok(FB.p2plus(0.999) < 1);
  const g = { ...game, status: "final", kickoff_et: "2026-11-15T13:00" }; const later = Date.parse("2026-11-16T12:00:00Z");
  const pk = { key: "w10_2plus_td_00-1", gsis_id: "00-1", status: "submitted", market: "2plus_td" };
  const lock = { [pk.key]: { gsis_id: "00-1", status: "submitted" } };
  const td = (n) => Array.from({ length: n }, () => ({ scorer_id: "00-1" }));
  assert.deepStrictEqual(FB.settle(pk, g, td(2), ["00-1"], lock, later), { state: "win", why: "Scored 2 touchdowns." });
  assert.deepStrictEqual(FB.settle(pk, g, td(1), ["00-1"], lock, later), { state: "loss", why: "Played, one touchdown (2+ needed)." });
  // anytime picks unchanged: one TD wins
  const any = { ...pk, key: "w10_anytime_td_00-1", market: "anytime_td" };
  assert.strictEqual(FB.settle(any, g, td(1), ["00-1"], { [any.key]: lock[pk.key] }, later).state, "win");
  // a 2+ pick and an anytime pick on the same player have different keys
  assert.notStrictEqual(FB.pickKey(10, "00-1", "2plus_td"), FB.pickKey(10, "00-1"));
});

test("sportsbook team codes match the slate's codes (Rams LAR -> LA)", () => {
  const cands = [{ gsis_id: "00-0037254", player: "K.Williams", full_name: "Kyren Williams", team: "LA" },
    { gsis_id: "00-1", player: "J.Williams", full_name: "Javonte Williams", team: "DAL" }, { gsis_id: "00-2", player: "T.McBride", full_name: "Trey McBride", team: "ARI" }];
  assert.strictEqual(FB.matchOdds({ player: "Kyren Williams", team: "LAR" }, cands).gsis_id, "00-0037254");
  assert.strictEqual(FB.matchOdds({ player: "Kyren Williams", team: "LA" }, cands).gsis_id, "00-0037254");
  assert.strictEqual(FB.matchOdds({ player: "Kyren Williams", team: "lar " }, cands).gsis_id, "00-0037254");
  assert.strictEqual(FB.matchOdds({ player: "Trey McBride", team: "ARZ" }, cands).gsis_id, "00-2");
  assert.strictEqual(FB.matchOdds({ player: "Kyren Williams", team: "LAC" }, cands), null); // a different team still doesn't match
  assert.deepStrictEqual(["LAR", "JAC", "WSH", "LVR", "KC", ""].map(FB.normTeam), ["LA", "JAX", "WAS", "LV", "KC", ""]);
});

test("Above fair: fresh anytime price whose implied chance is 3+ points below the model's chance", () => {
  const now = Date.parse("2026-11-15T16:00:00Z"); const at = (m) => new Date(now - m * 60000).toISOString();
  // model 44% (fair +127). +150 -> implied 40.0% -> 4.0 points below: flagged
  assert.deepStrictEqual(FB.aboveFair(0.44, { american: 150, captured_at: at(10) }, now), { pts: 4, implied: 0.4, firm: null, lo: null });
  // +135 -> implied 42.6% -> 1.4 points: better than fair but inside the threshold, not flagged
  assert.strictEqual(FB.aboveFair(0.44, { american: 135, captured_at: at(10) }, now), null);
  // exactly 3.0 points is flagged: model 43%, +150 (40%)
  assert.strictEqual(FB.aboveFair(0.43, { american: 150, captured_at: at(10) }, now).pts, 3);
  // stale price (over 2 h), 2+ TDs market, missing or invalid inputs: never flagged
  assert.strictEqual(FB.aboveFair(0.44, { american: 200, captured_at: at(180) }, now), null);
  assert.strictEqual(FB.aboveFair(0.2, { american: 900, captured_at: at(10), market: "2plus_td" }, now), null);
  assert.strictEqual(FB.aboveFair(0.44, { american: 200, captured_at: at(10) }, now, "2plus_td"), null);
  assert.strictEqual(FB.aboveFair(null, { american: 200, captured_at: at(10) }, now), null);
  assert.strictEqual(FB.aboveFair(0.44, { american: "abc", captured_at: at(10) }, now), null);
  // dashboard groups picks by the marker saved at pick time
  const d = FB.dashboard([{ season: 2026, week: 10, game_id: "g", uid: "A", gsis_id: "1", market: "anytime_td", state: "win", above_fair: true, game_final: true, tds: 1 },
    { season: 2026, week: 10, game_id: "g", uid: "A", gsis_id: "2", market: "anytime_td", state: "loss", above_fair: false, game_final: true, tds: 0 },
    { season: 2026, week: 10, game_id: "g", uid: "A", gsis_id: "3", market: "anytime_td", state: "loss", game_final: true, tds: 0 }], {});
  assert.deepStrictEqual(d.categories.above_fair.map((c) => [c.key, c.hits, c.misses]).sort(),
    [["Above fair", 1, 0], ["Not above fair", 0, 1], ["Not checked (no fresh price, 2+ TDs, or older pick)", 0, 1]]);
});

/* ---------- Weekly Rankings ---------- */
const RNOW = Date.parse("2026-11-15T16:00:00Z"); const rat = (m) => new Date(RNOW - m * 60000).toISOString();
const px = (book, american, minAgo = 10) => ({ book, american, captured_at: rat(minAgo) });
const it = (name, chance, prices = []) => ({ key: name, name, chance, prices });

test("Best Value: the worked example (50% vs +120 = +4.5 points) and fair odds +100", () => {
  const r = FB.weeklyRankings([it("A", 0.5, [px("FanDuel", 120)])], RNOW);
  assert.strictEqual(r.value.length, 1);
  assert.strictEqual(r.value[0].fair, 100);                            // 50% -> +100
  assert.ok(Math.abs(r.value[0].implied - 100 / 220) < 1e-9);          // +120 -> 45.45%
  assert.strictEqual(r.value[0].edgePts.toFixed(1), "4.5");
  assert.strictEqual(FB.probToAmerican(0.5), 100);
});

test("Best Value: only positive edges, largest first; zero and negative excluded; best fresh book used", () => {
  const r = FB.weeklyRankings([
    it("Pos big", 0.40, [px("FanDuel", 200), px("DraftKings", 230)]),   // best fresh = DK +230 -> 30.3% -> +9.7
    it("Pos small", 0.40, [px("FanDuel", 140)]),                        // 41.7% -> -1.7: negative, excluded
    it("Zero", 0.5, [px("FanDuel", 100)]),                              // exactly 50% -> 0.0: excluded
    it("Neg", 0.30, [px("FanDuel", 100)]),                              // -20: excluded
    it("Small pos", 0.45, [px("FanDuel", 125)]),                        // 44.4% -> +0.6
  ], RNOW);
  assert.deepStrictEqual(r.value.map((x) => x.name), ["Pos big", "Small pos"]);
  assert.deepStrictEqual([r.value[0].best.book, r.value[0].best.american], ["DraftKings", 230]);
  assert.ok(r.value.every((x) => x.edgePts > 0));
});

test("Best Value: fresh first, else the best last-known (stale) price; empty messages depend on the data", () => {
  // a stale price paying more is passed over while a FRESH price exists
  const r = FB.weeklyRankings([it("A", 0.4, [px("BetMGM", 400, 180), px("FanDuel", 160)])], RNOW);
  assert.deepStrictEqual([r.value[0].best.book, r.value[0].best.american, r.value[0].stale, r.staleNote], ["FanDuel", 160, false, null]);
  // all prices stale: the best last-known price is used, flagged stale, same edge formula
  const s = FB.weeklyRankings([it("A", 0.4, [px("BetMGM", 400, 180), px("FanDuel", 160, 150)])], RNOW);
  assert.deepStrictEqual([s.value[0].best.book, s.value[0].best.american, s.value[0].stale], ["BetMGM", 400, true]);
  assert.strictEqual(s.value[0].edgePts.toFixed(1), "20.0"); // 40% - 20%
  assert.strictEqual(s.staleNote, "Showing last-known odds. All displayed prices are 2+ hours old.");
  // a price crossing the 2-hour mark stays and turns stale
  const before = FB.weeklyRankings([it("A", 0.4, [px("FanDuel", 200, 119)])], RNOW); const after = FB.weeklyRankings([it("A", 0.4, [px("FanDuel", 200, 121)])], RNOW);
  assert.deepStrictEqual([before.value.length, before.value[0].stale, after.value.length, after.value[0].stale], [1, false, 1, true]);
  // mixed: some rows fresh, some stale
  assert.strictEqual(FB.weeklyRankings([it("A", 0.4, [px("FanDuel", 200)]), it("B", 0.4, [px("FanDuel", 200, 300)])], RNOW).staleNote, "Some odds are 2+ hours old.");
  // no prices at all for this market
  assert.strictEqual(FB.weeklyRankings([it("A", 0.4), it("B", 0.3)], RNOW).valueEmpty, "No sportsbook prices uploaded for this market");
  // prices exist (fresh or stale) but none beats the model
  assert.strictEqual(FB.weeklyRankings([it("A", 0.3, [px("FanDuel", 100)])], RNOW).valueEmpty, "No players above model fair value");
  assert.strictEqual(FB.weeklyRankings([it("A", 0.3, [px("FanDuel", 100, 300)])], RNOW).valueEmpty, "No players above model fair value");
  // future-dated or invalid prices never count
  assert.strictEqual(FB.weeklyRankings([it("A", 0.4, [px("FanDuel", 200, -60), px("DraftKings", "abc")])], RNOW).valueEmpty, "No sportsbook prices uploaded for this market");
  // a newer price from the same book replaces its older one (even when the older one paid more)
  const n = FB.weeklyRankings([it("A", 0.4, [px("FanDuel", 300, 30), px("FanDuel", 180, 5)])], RNOW);
  assert.deepStrictEqual([n.value[0].best.american, n.value[0].stale], [180, false]);
});

test("Highest TD Chance: every valid chance, with or without prices; invalid chances left out", () => {
  const r = FB.weeklyRankings([it("C", 0.2), it("A", 0.6, [px("FanDuel", -200)]), it("B", 0.4), it("Bad", null), it("Zero", 0), it("One", 1)], RNOW);
  assert.deepStrictEqual(r.chance.map((x) => [x.name, x.fair]), [["A", -150], ["B", 150], ["C", 400]]);
  // no sportsbook prices at all: Highest TD Chance still fills, Best Value says so
  const none = FB.weeklyRankings([it("A", 0.6), it("B", 0.4)], RNOW);
  assert.deepStrictEqual([none.chance.length, none.value.length, none.combined.length, none.valueEmpty], [2, 0, 0, "No sportsbook prices uploaded for this market"]);
});

test("Combined: average of value rank and chance rank within the Best Value group; ties by chance, then edge", () => {
  // value order (edge): V1 +10, V2 +8, V3 +6, V4 +4; chance order: V4 .60, V3 .50, V2 .40, V1 .30
  const r = FB.weeklyRankings([
    it("V1", 0.30, [px("FanDuel", Math.round(100 / 0.20 - 100))]),   // implied 20% -> +10
    it("V2", 0.40, [px("FanDuel", Math.round(100 / 0.32 - 100))]),   // ~32% -> ~+8
    it("V3", 0.50, [px("FanDuel", Math.round(100 / 0.44 - 100))]),   // ~44% -> ~+6
    it("V4", 0.60, [px("FanDuel", -127)]),                          // 55.9% -> ~+4.1
  ], RNOW);
  const c = Object.fromEntries(r.combined.map((x) => [x.name, [x.valueRank, x.chanceRank, x.score]]));
  assert.deepStrictEqual(c, { V1: [1, 4, 2.5], V2: [2, 3, 2.5], V3: [3, 2, 2.5], V4: [4, 1, 2.5] });
  // all tied at 2.5 -> higher model chance first
  assert.deepStrictEqual(r.combined.map((x) => x.name), ["V4", "V3", "V2", "V1"]);
  // the spec's example: #2 in value and #6 in chance -> 4.0
  assert.strictEqual((2 + 6) / 2, 4.0);
  // equal chance AND equal score -> higher value edge first; equal edges share a value rank (1, 1, 3)
  const t = FB.weeklyRankings([it("E1", 0.4, [px("FanDuel", 200)]), it("E2", 0.4, [px("DraftKings", 200)]), it("E3", 0.35, [px("FanDuel", 200)])], RNOW);
  assert.deepStrictEqual(t.value.map((x) => [x.name, x.valueRank]), [["E1", 1], ["E2", 1], ["E3", 3]]);
  assert.deepStrictEqual(t.combined.map((x) => [x.name, x.valueRank, x.chanceRank, x.score]), [["E1", 1, 1, 1], ["E2", 1, 1, 1], ["E3", 3, 3, 3]]);
});

test("game lines: no-margin win chance, summary, best book, results against the line, team records", () => {
  const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
  const nv = FB.noVig(-110, -110); assert.ok(near(nv.away, 0.5) && near(nv.home, 0.5) && near(nv.margin, 2 * (110 / 210) - 1));
  const nv2 = FB.noVig(190, -233); assert.ok(near(nv2.away + nv2.home, 1) && nv2.home > 0.66 && nv2.home < 0.68, String(nv2.home));
  assert.strictEqual(FB.noVig(null, -110), null);
  const fd = { book: "FanDuel", spread: { home_line: -15.5, home_american: -115, away_american: -105 }, total: { line: 40.5, over_american: -115, under_american: -111 }, ml: { away_american: 870, home_american: -1429 } };
  const dk = { book: "DraftKings", spread: { home_line: -16.5, home_american: -105, away_american: -115 }, total: { line: 41.5, over_american: -108, under_american: -112 }, ml: { away_american: 800, home_american: -1351 } };
  const s = FB.lineSummary([fd, dk]);
  assert.ok(near(s.home_line, -16) && near(s.total, 41) && near(s.home_pts, 28.5) && near(s.away_pts, 12.5) && s.home_win > 0.88 && s.home_win < 0.92, JSON.stringify(s));
  // best book per side: the underdog wants +16.5 (DraftKings), the favourite -15.5 (FanDuel); Over wants 40.5, Under 41.5
  assert.deepStrictEqual(FB.bestLines([fd, dk]), { spread_home: "FanDuel", spread_away: "DraftKings", total_over: "FanDuel", total_under: "DraftKings", ml_home: "DraftKings", ml_away: "FanDuel" });
  // same line: the better price wins; identical everywhere: nothing is highlighted; one book: nothing to compare
  const a = { book: "A", spread: { home_line: -3, home_american: -110, away_american: -110 }, total: null, ml: null }, b2 = { book: "B", spread: { home_line: -3, home_american: -105, away_american: -115 }, total: null, ml: null };
  assert.deepStrictEqual(FB.bestLines([a, b2]), { spread_home: "B", spread_away: "A" });
  assert.deepStrictEqual(FB.bestLines([a, { ...a, book: "C" }]), {}); assert.deepStrictEqual(FB.bestLines([a]), {});
  // results against the line (home line -3): home wins by 7 covers, by 3 pushes, by 1 doesn't
  const g = (hs, as) => ({ status: "final", home_score: hs, away_score: as });
  assert.deepStrictEqual(FB.gradeLine(g(27, 20), -3, 44.5), { ats: "home", ou: "over" });
  assert.deepStrictEqual(FB.gradeLine(g(23, 20), -3, 43), { ats: "push", ou: "push" });
  assert.deepStrictEqual(FB.gradeLine(g(21, 20), -3, 44.5), { ats: "away", ou: "under" });
  assert.strictEqual(FB.gradeLine({ home_score: null, away_score: null }, -3, 44), null);
  // team records: nflverse spread_line is points the HOME team is favoured by
  const G = [{ week: 1, status: "final", home: "KC", away: "ARI", home_score: 30, away_score: 10, spread_line: 7, total_line: 45 },      // KC covers, under
             { week: 2, status: "final", home: "ARI", away: "KC", home_score: 24, away_score: 27, spread_line: -6.5, total_line: 44.5 },   // KC -6.5 wins by 3: ARI covers, over
             { week: 3, status: "upcoming", home: "KC", away: "ARI", home_score: null, away_score: null, spread_line: 3, total_line: 40 }];
  const R = FB.teamRecords(G);
  assert.deepStrictEqual([R.KC.games, R.KC.w, R.KC.l, R.KC.ats_w, R.KC.ats_l, R.KC.over, R.KC.under, R.KC.pf, R.KC.pa], [2, 2, 0, 1, 1, 1, 1, 57, 34]);
  assert.deepStrictEqual([R.ARI.w, R.ARI.l, R.ARI.ats_w, R.ARI.ats_l], [0, 2, 1, 1]);
  assert.strictEqual(FB.teamRecords(G, 2).KC.games, 1);   // only games before week 2
});

test("fair price: what a bet costs, when it counts as value, and the tracker's record", () => {
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
  assert.ok(near(FB.betValue(0.5, -110), 0.5 * (1 + 100 / 110) - 1) && FB.betValue(0.5, -110) < 0);   // a 50% bet at -110 costs 4.5%
  assert.ok(near(FB.betValue(0.5, 100), 0) && FB.betValue(0.4, 190) > 0.15);
  assert.strictEqual(FB.betValue(null, -110), null); assert.strictEqual(FB.betValue(0.5, null), null);
  assert.strictEqual(FB.isValue(0.4, 190, 2), true);
  assert.strictEqual(FB.isValue(0.4, 190, 1), false);      // one reference is not enough
  assert.strictEqual(FB.isValue(0.5, 101, 3), false);      // +0.5% is under the 1% threshold
  const m = { book: "FanDuel", spread: { home_line: -3.5, home_american: -110, away_american: -110 }, total: { line: 44.5, over_american: -115, under_american: -105 },
    ml: { home_american: 190, away_american: -233, fair: { home: 0.39, away: 0.61, n: 2 } }, fair: { spread: { home: 0.5, away: 0.5, n: 3 }, total: null } };
  const c = FB.lineCosts(m, "BUF", "NYJ");
  assert.deepStrictEqual(c.map((x) => `${x.market}:${x.side}:${x.label}:${x.line}`), ["spread:home:NYJ:-3.5", "spread:away:BUF:3.5", "ml:home:NYJ:null", "ml:away:BUF:null"]);   // no fair total -> no total rows
  assert.ok(c[0].value < 0 && c[2].value > 0.1 && c[2].refs === 2);
  const s = FB.valueSummary([{ ev_pct: 2, clv_pts: 1.5, result: "win", units: 0.9 }, { ev_pct: 4, clv_pts: -0.5, result: "loss", units: -1 }, { ev_pct: 3 }, { ev_pct: 3, clv_pts: 0.2, result: "push", units: 0 }]);
  assert.deepStrictEqual([s.flagged, s.with_close, s.graded, s.wins, s.losses, s.pushes], [4, 3, 3, 1, 1, 1]);
  assert.ok(near(s.avg_clv, 0.4) && near(s.beat_close, 2 / 3) && near(s.units, -0.1) && near(s.avg_ev, 3));
  assert.deepStrictEqual(FB.valueSummary([]).flagged, 0); assert.strictEqual(FB.valueSummary(null).avg_clv, null);
});

test("game picks: best offer per side, grading, kickoff rule and record", () => {
  const fd = { book: "FanDuel", spread: { home_line: -15.5, home_american: -115, away_american: -105 }, total: { line: 40.5, over_american: -115, under_american: -111 }, ml: { away_american: 870, home_american: -1429 } };
  const dk = { book: "DraftKings", spread: { home_line: -16.5, home_american: -105, away_american: -115 }, total: { line: 41.5, over_american: -108, under_american: -112 }, ml: { away_american: 800, home_american: -1351 } };
  const o = FB.gamePickOffers([fd, dk]);
  // the favourite wants -15.5 (FanDuel), the underdog +16.5 (DraftKings); Over the lower total, Under the higher; the better moneyline price
  assert.deepStrictEqual(o.spread_home, { book: "FanDuel", line: -15.5, american: -115 }); assert.deepStrictEqual(o.spread_away, { book: "DraftKings", line: 16.5, american: -115 });
  assert.deepStrictEqual(o.total_over, { book: "FanDuel", line: 40.5, american: -115 }); assert.deepStrictEqual(o.total_under, { book: "DraftKings", line: 41.5, american: -112 });
  assert.deepStrictEqual(o.ml_home, { book: "DraftKings", line: null, american: -1351 }); assert.deepStrictEqual(o.ml_away, { book: "FanDuel", line: null, american: 870 });
  assert.deepStrictEqual(FB.gamePickOffers([{ book: "A", spread: null, total: null, ml: null }]), {});
  assert.strictEqual(FB.gamePickKey(11, "2026_11_ARI_KC", "spread"), "g11_2026_11_ARI_KC_spread");
  const fin = { status: "final", home_score: 27, away_score: 20, kickoff_et: "2026-11-22T13:00" };
  const g = (market, side, line, american = -110) => FB.gradeGamePick({ market, side, line, american }, fin);
  assert.deepStrictEqual([g("spread", "home", -6.5).state, g("spread", "home", -7).state, g("spread", "home", -7.5).state, g("spread", "away", 7.5).state], ["win", "push", "loss", "win"]);
  assert.deepStrictEqual([g("total", "over", 46.5).state, g("total", "under", 47).state, g("total", "under", 47.5).state], ["win", "push", "win"]);
  assert.deepStrictEqual([g("ml", "home", null, -200).state, g("ml", "away", null, 170).state], ["win", "loss"]);
  assert.ok(Math.abs(g("spread", "home", -6.5, -110).units - 100 / 110) < 1e-9 && g("ml", "away", null, 170).units === -1 && g("spread", "home", -7).units === 0 && Math.abs(g("total", "over", 46.5, 150).units - 1.5) < 1e-9);
  assert.strictEqual(FB.gradeGamePick({ market: "spread", side: "home", line: -3, american: -110 }, { status: "upcoming", kickoff_et: "2026-11-22T13:00" }).state, "pending");
  // kickoff rule (13:00 ET = 18:00Z)
  const pk = { key: "k", market: "spread", side: "home", line: -3, picked_at: "2026-11-22T17:59:00Z" };
  assert.strictEqual(FB.gamePickValid(pk, fin, undefined, "u").ok, true);
  assert.strictEqual(FB.gamePickValid({ ...pk, picked_at: "2026-11-22T18:00:00Z" }, fin, undefined, "u").ok, false);
  assert.strictEqual(FB.gamePickValid({ ...pk, picked_at: null }, fin, undefined, "u").ok, false);
  assert.strictEqual(FB.gamePickValid(pk, fin, { game_picks: { u: { k: { market: "spread", side: "home", line: -3 } } } }, "u").ok, true);
  assert.strictEqual(FB.gamePickValid(pk, fin, { game_picks: { u: { k: { market: "spread", side: "away", line: 3 } } } }, "u").ok, false);   // switched sides after the snapshot
  assert.strictEqual(FB.gamePickValid(pk, fin, { game_picks: {} }, "u").ok, false);                                                      // not in the snapshot at all
  assert.strictEqual(FB.gamePickValid(pk, fin, { picks: {} }, "u").ok, true);                                                            // an older snapshot without game picks: time rule only
  const rec = FB.gamePickRecord([{ state: "win", units: 0.91 }, { state: "loss", units: -1 }, { state: "push", units: 0 }, { state: "pending", units: 0 }, { state: "void", units: 0 }]);
  assert.deepStrictEqual([rec.w, rec.l, rec.p, rec.pending, rec.not_counted, rec.n], [1, 1, 1, 1, 1, 5]); assert.ok(Math.abs(rec.units + 0.09) < 1e-9);
});


test("chance range: logit band, shrinks with scale, and the firm-edge check uses its low end", () => {
  const cfg = { sd_logit: 0.3, z: 1.28 };
  const r = FB.chanceRange(0.25, cfg);
  assert.ok(Math.abs(r.lo - 0.185) < 0.003 && Math.abs(r.hi - 0.329) < 0.003, JSON.stringify(r));
  const half = FB.chanceRange(0.25, cfg, 0.5);
  assert.ok(half.lo > r.lo && half.hi < r.hi);
  assert.strictEqual(FB.chanceRange(0.25, null), null);
  assert.strictEqual(FB.chanceRange(0, cfg), null);
  const now = Date.parse("2026-11-19T18:00:00Z"); const row = { american: 400, captured_at: new Date(now - 6e5).toISOString() }; // implied 20%
  assert.strictEqual(FB.aboveFair(0.25, row, now, "anytime_td", r).firm, false);          // low end 18.5% is under the 20% price
  assert.strictEqual(FB.aboveFair(0.25, { ...row, american: 500 }, now, "anytime_td", r).firm, true);  // 16.7% price: low end clears it
});
test("parlay chance flags same-team legs separately from same-game legs", () => {
  const a = FB.parlayChance([{ p: 0.5, game_id: "g", team: "KC" }, { p: 0.4, game_id: "g", team: "BUF" }]);
  assert.strictEqual(a.sameGame, true); assert.strictEqual(a.sameTeam, false);
  const b = FB.parlayChance([{ p: 0.5, game_id: "g", team: "KC" }, { p: 0.4, game_id: "g", team: "KC" }]);
  assert.strictEqual(b.sameTeam, true); assert.ok(Math.abs(b.p - 0.2) < 1e-9);
});
