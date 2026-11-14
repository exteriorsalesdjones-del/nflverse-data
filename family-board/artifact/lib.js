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

  /* Parlay: locks at the first leg's kickoff. legs: [{game_id, gsis_id}], gameById: {id: game} */
  function parlayLocked(legs, gameById, nowMs) {
    return (legs || []).some(function (l) { return isLocked(gameById[l.game_id], nowMs); });
  }
  /* Settle a parlay. legResults: list of settle()-style states for each leg ("win","loss","void","pending","needs_review").
     House rule: a void leg (player didn't play) is dropped; the rest must all score. */
  function settleParlay(legResults) {
    var s = legResults || [];
    if (!s.length) return { state: "needs_review", why: "No legs." };
    if (s.indexOf("loss") !== -1) return { state: "loss", why: "A leg didn't score." };
    if (s.indexOf("draft") !== -1) return { state: "draft", why: "Not submitted." };
    if (s.indexOf("needs_review") !== -1) return { state: "needs_review", why: "A leg needs review." };
    if (s.indexOf("pending") !== -1) return { state: "pending", why: "Games still to play." };
    var live = s.filter(function (x) { return x !== "void"; });
    if (!live.length) return { state: "void", why: "No leg's player played." };
    return { state: "win", why: live.length === s.length ? "Every leg scored." : "Every leg that played scored (" + (s.length - live.length) + " void leg dropped)." };
  }
  /* Model chance that every leg scores. Legs in the same game are treated as independent; flagged. */
  function parlayChance(legs) {
    var p = 1, pm = 1, games = {}, same = false;
    (legs || []).forEach(function (l) { p *= l.p || 0; pm *= (l.p_matchup != null ? l.p_matchup : l.p) || 0; if (games[l.game_id]) same = true; games[l.game_id] = 1; });
    return { p: (legs || []).length ? p : null, pMatchup: (legs || []).length ? pm : null, sameGame: same };
  }

  /* Suggested research slates. candidates: [{gsis_id, player, team, game_id, p, quality}] */
  /* opts.by: "chance" (default, highest model chance first) or "matchup" (biggest matchup boost first,
     only players whose chance after the matchup is at least opts.floor, default 15%). */
  function suggestSlate(candidates, legs, rule, opts) {
    opts = opts || {};
    var byMatchup = opts.by === "matchup", floor = opts.floor == null ? 0.15 : opts.floor;
    var pool = candidates.filter(function (c) {
      if (c.quality === "unavailable" || !(c.p > 0)) return false;
      return byMatchup ? (c.p_matchup >= floor && c.matchup_pct > 0) : true;
    }).slice().sort(byMatchup ? function (a, b) { return b.matchup_pct - a.matchup_pct || b.p_matchup - a.p_matchup; } : function (a, b) { return b.p - a.p; });
    var used = {}, out = [];
    pool.forEach(function (c) {
      var k = rule === "team" ? c.team : c.game_id;
      if (out.length < legs && !used[k]) { used[k] = 1; out.push(c); }
    });
    var joint = out.reduce(function (acc, c) { return acc * c.p; }, 1);
    var jointM = out.reduce(function (acc, c) { return acc * (c.p_matchup != null ? c.p_matchup : c.p); }, 1);
    return {
      legs: out, wanted: legs, short: Math.max(0, legs - out.length),
      jointP: out.length ? joint : null, jointMatchupP: out.length ? jointM : null,
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

  /* ---------- uploaded lines ---------- */
  /* "+180", "-120", "180", "EVEN"/"EV" -> number; anything else (incl. -99..+99) -> NaN */
  function parseAmerican(x) {
    var t = String(x == null ? "" : x).trim().toUpperCase();
    if (t === "EVEN" || t === "EV" || t === "EVS") return 100;
    if (!/^[+-]?\d+(\.0+)?$/.test(t)) return NaN;
    var n = Number(t.replace("+", ""));
    return Math.abs(n) >= 100 ? n : NaN;
  }
  function normMarket(m) {
    var x = String(m || "").toLowerCase().replace(/[^a-z0-9+]/g, "");
    if (!x || x.indexOf("any") !== -1) return "anytime_td";
    if (x.indexOf("2") !== -1 || x.indexOf("two") !== -1) return "2plus_td";
    return null; // other markets are ignored
  }
  /* CSV/paste: player,team,book,market,price[,captured_at] or player,team,book,price[,captured_at].
     Returns {rows, skipped:[{line, why}]} so nothing is dropped silently. */
  function parseLines(text, nowIso) {
    var rows = [], skipped = [];
    String(text || "").split(/\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l && !/^player\s*,/i.test(l); }).forEach(function (l) {
      var c = l.split(",").map(function (x) { return x.trim(); });
      var hasMarket = c.length >= 5 && isFinite(parseAmerican(c[4])) && !isFinite(parseAmerican(c[3]));
      var market = normMarket(hasMarket ? c[3] : ""), american = parseAmerican(hasMarket ? c[4] : c[3]), when = hasMarket ? c[5] : c[4];
      if (!c[0]) return skipped.push({ line: l, why: "no player" });
      if (!market) return skipped.push({ line: l, why: "market isn't Anytime TD or 2+ TDs" });
      if (!isFinite(american)) return skipped.push({ line: l, why: "price isn't valid American odds (e.g. +180, -120, EVEN)" });
      if (when && !isFinite(Date.parse(when))) return skipped.push({ line: l, why: "time isn't a date" });
      rows.push({ player: c[0], team: (c[1] || "").toUpperCase(), book: c[2] || "", market: market, american: american, captured_at: when ? new Date(Date.parse(when)).toISOString() : (nowIso || new Date().toISOString()) });
    });
    return { rows: rows, skipped: skipped };
  }
  /* Is an uploaded price usable? game: the player's game (or null if unmatched). */
  function lineProblem(row, game, nowMs) {
    var t = Date.parse(row.captured_at);
    if (!isFinite(t)) return "no capture time";
    if (t > nowMs + 10 * 60000) return "capture time is in the future";
    if (nowMs - t > 7 * 864e5) return "older than 7 days";
    if (game && isLocked(game, nowMs)) return "game has started (pre-kickoff prices are kept)";
    if (game && t >= etToUtcMs(game.kickoff_et)) return "captured after kickoff";
    return null;
  }
  /* Best price for one player and market across books: highest payout among fresh prices (latest per book);
     if none is fresh, the most recent price flagged stale. Returns null when there are no prices. */
  function bestPrice(rows, nowMs, maxAgeMin) {
    if (!rows || !rows.length) return null;
    var perBook = {};
    rows.forEach(function (r) { var k = r.book || "?"; if (!perBook[k] || Date.parse(r.captured_at) > Date.parse(perBook[k].captured_at)) perBook[k] = r; });
    var latest = Object.keys(perBook).map(function (k) { return perBook[k]; });
    var fresh = latest.filter(function (r) { return priceFresh(r, nowMs, maxAgeMin); });
    var pool = fresh.length ? fresh : latest;
    pool.sort(fresh.length ? function (a, b) { return americanToDecimal(b.american) - americanToDecimal(a.american); }
                           : function (a, b) { return Date.parse(b.captured_at) - Date.parse(a.captured_at); });
    var best = pool[0];
    return Object.assign({}, best, { stale: !fresh.length, books: fresh.length || latest.length,
      others: pool.slice(1).map(function (r) { return { book: r.book, american: r.american, captured_at: r.captured_at }; }) });
  }

  var api = { parseAmerican: parseAmerican, normMarket: normMarket, parseLines: parseLines, lineProblem: lineProblem, bestPrice: bestPrice, etToUtcMs: etToUtcMs, fmtEt: fmtEt, isLocked: isLocked, pickKey: pickKey, validatePick: validatePick,
    americanToProb: americanToProb, americanToDecimal: americanToDecimal, probToAmerican: probToAmerican, edge: edge,
    priceFresh: priceFresh, modelValidated: modelValidated, settle: settle, suggestSlate: suggestSlate, csv: csv,
    normName: normName, matchOdds: matchOdds, parlayLocked: parlayLocked, settleParlay: settleParlay, parlayChance: parlayChance };
  if (typeof module !== "undefined") module.exports = api; else root.FB = api;
})(this);
