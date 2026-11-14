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
  assert.strictEqual(FB.settle(pick, fin, [], undefined, lock, now).state, "needs_review");
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
