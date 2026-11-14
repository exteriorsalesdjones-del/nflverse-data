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
