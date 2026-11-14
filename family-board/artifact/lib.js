/* Family Board core rules. Pure functions, shared by the page and the Node tests.
   Everything time-related is America/New_York. */
(function (root) {
  "use strict";
  var TZ = "America/New_York";

  /* "2026-11-15T13:00" (Eastern wall clock) -> UTC milliseconds */
  function etToUtcMs(et) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(et || "");
    if (!m) return NaN;
    var guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    // offset of New York at that instant, found by formatting the guess there
    for (var i = 0; i < 2; i++) {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(guess));
      var o = {}; parts.forEach(function (p) { o[p.type] = p.value; });
      var asNy = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute);
      var target = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
      guess += target - asNy;
    }
    return guess;
  }

  function fmtEt(ms, opts) {
    return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }, opts || {})).format(new Date(ms));
  }

  function isLocked(game, nowMs) {
    if (!game) return true;
    if (game.status && game.status !== "upcoming") return true;
    var k = etToUtcMs(game.kickoff_et);
    return !(k > nowMs);
  }

  function pickKey(week, gsisId, market) {
    return "w" + week + "_" + (market || "anytime_td") + "_" + gsisId;
  }

  /* Validate adding one pick to a member's existing items. Returns [] or a list of reasons. */
  function validatePick(items, pick, game, nowMs) {
    var errs = [];
    if (!pick || !pick.gsis_id) errs.push("Choose a player.");
    if (isLocked(game, nowMs)) errs.push("This game has kicked off. Picks for it are locked.");
    var key = pickKey(pick.week, pick.gsis_id, pick.market);
    if (items && items[key]) errs.push("You already picked this player for this week.");
    return errs;
  }

  /* Odds */
  function americanToProb(a) {
    a = Number(a);
    if (!isFinite(a) || a === 0 || (a > -100 && a < 100)) return NaN;
    return a > 0 ? 100 / (a + 100) : -a / (-a + 100);
  }
  function americanToDecimal(a) { a = Number(a); return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function probToAmerican(p) {
    if (!(p > 0 && p < 1)) return null;
    return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
  }
  /* Edge in percentage points and EV per $1 at the posted price; null when inputs are missing. */
  function edge(modelP, american) {
    var imp = americanToProb(american);
    if (!(modelP > 0) || !isFinite(imp)) return null;
    var dec = americanToDecimal(american);
    return { implied: imp, edgePts: (modelP - imp) * 100, evPerDollar: modelP * (dec - 1) - (1 - modelP) };
  }
  function priceFresh(price, nowMs, maxAgeMin) {
    if (!price || !price.captured_at) return false;
    var t = Date.parse(price.captured_at);
    return isFinite(t) && nowMs - t <= (maxAgeMin || 120) * 60000;
  }

  /* Model gate for "Value Play". Documented in docs/METHOD.md. */
  function modelValidated(v) {
    var reasons = [];
    if (!v || !v.n) return { ok: false, reasons: ["No validation run yet."] };
    if (v.n < 2000) reasons.push("Fewer than 2,000 graded player-games (" + v.n + ").");
    if (!(v.brier < v.brier_constant)) reasons.push("Brier score does not beat a constant forecast.");
    (v.calibration || []).forEach(function (b) {
      if (b.n >= 50 && Math.abs(b.pred - b.actual) > 0.03) reasons.push("Calibration off by " + Math.round(Math.abs(b.pred - b.actual) * 100) + " pts in the " + b.bin + " band.");
    });
    if (!v.clv_n || v.clv_n < 200) reasons.push("Fewer than 200 picks with a closing price, so closing-line value is untested.");
    return { ok: reasons.length === 0, reasons: reasons };
  }

  /* Settlement of one pick.
     tds: list of touchdown records for the pick's game; played: array of gsis ids with a snap (or undefined if not loaded yet);
     lock: frozen snapshot of this member's items for the game (or undefined if not frozen yet). */
  function settle(pick, game, tds, played, lock, nowMs) {
    if (!game) return { state: "needs_review", why: "Game not found in the schedule." };
    if (pick.status !== "submitted") return { state: "draft", why: "Saved but not submitted." };
    var started = isLocked(game, nowMs);
    if (started) {
      if (!lock) return { state: game.status === "final" ? "needs_review" : "pending", why: "Waiting for the kickoff snapshot." };
      var frozen = lock[pick.key];
      if (!frozen || frozen.gsis_id !== pick.gsis_id || frozen.status !== "submitted") {
        return { state: "needs_review", why: "Not in the kickoff snapshot: added or changed after kickoff." };
      }
    }
    if (game.status !== "final") return { state: "pending", why: started ? "Game in progress." : "Game not started." };
    var scored = (tds || []).some(function (t) { return t.scorer_id === pick.gsis_id; });
    if (scored) return { state: "win", why: "Scored a touchdown." };
    if (!played) return { state: "needs_review", why: "Participation not published yet." };
    if (played.indexOf(pick.gsis_id) === -1) return { state: "void", why: "Did not play (house rule: void)." };
    return { state: "loss", why: "Played, no touchdown." };
  }

  /* Suggested research slates. candidates: [{gsis_id, player, team, game_id, p, quality}] */
  function suggestSlate(candidates, legs, rule) {
    var pool = candidates.filter(function (c) { return c.quality !== "unavailable" && c.p > 0; })
      .slice().sort(function (a, b) { return b.p - a.p; });
    var used = {}, out = [];
    pool.forEach(function (c) {
      var k = rule === "team" ? c.team : c.game_id;
      if (out.length < legs && !used[k]) { used[k] = 1; out.push(c); }
    });
    var joint = out.reduce(function (acc, c) { return acc * c.p; }, 1);
    return {
      legs: out, wanted: legs, short: Math.max(0, legs - out.length),
      jointP: out.length ? joint : null,
      jointNote: rule === "team"
        ? "Independence assumed. Two legs may share a game (one per team), so same-game scoring can make this joint figure wrong."
        : "One player per game, combined assuming games are independent."
    };
  }

  function csv(rows, cols) {
    function esc(v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    return [cols.map(function (c) { return esc(c.label); }).join(",")]
      .concat(rows.map(function (r) { return cols.map(function (c) { return esc(c.get(r)); }).join(","); })).join("\n");
  }

  /* Match an imported odds row to a slate candidate by normalized name and team. */
  function normName(s) { return String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z]/g, ""); }
  function matchOdds(row, candidates) {
    var n = normName(row.player);
    var hits = candidates.filter(function (c) {
      var full = normName(c.full_name || c.player), abbr = normName(c.player);
      return full === n || abbr === n || (c.player && n.length > 3 && full.endsWith(n.slice(1)) && n[0] === abbr[0]);
    });
    if (row.team) hits = hits.filter(function (c) { return c.team === row.team; });
    return hits.length === 1 ? hits[0] : null;
  }

  var api = { etToUtcMs: etToUtcMs, fmtEt: fmtEt, isLocked: isLocked, pickKey: pickKey, validatePick: validatePick,
    americanToProb: americanToProb, americanToDecimal: americanToDecimal, probToAmerican: probToAmerican, edge: edge,
    priceFresh: priceFresh, modelValidated: modelValidated, settle: settle, suggestSlate: suggestSlate, csv: csv,
    normName: normName, matchOdds: matchOdds };
  if (typeof module !== "undefined") module.exports = api; else root.FB = api;
})(this);
