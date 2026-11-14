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
  /* Price freshness policy (single source of truth). A price is "fresh" when it was OBSERVED (captured_at) within
     the last PRICE_FRESH_MIN minutes. 120 minutes was chosen when the board was first built (an assumption, not a
     product requirement): anytime-TD props move on injury and inactive news, so older prices are shown but labeled
     stale and are not used for EV. Timestamps more than FUTURE_SLACK_MIN ahead of now are treated as invalid. */
  var PRICE_FRESH_MIN = 120, FUTURE_SLACK_MIN = 10;
  function observedMs(price) {
    var t = price && price.captured_at ? Date.parse(price.captured_at) : NaN;
    return isFinite(t) ? t : NaN;
  }
  function priceFresh(price, nowMs, maxAgeMin) {
    var t = observedMs(price);
    if (!isFinite(t) || t > nowMs + FUTURE_SLACK_MIN * 60000) return false;
    return nowMs - t <= (maxAgeMin || PRICE_FRESH_MIN) * 60000;
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

  /* Eligibility of a submitted pick for a NEW kickoff snapshot. submitted_at is written by the member's device, so this
     is a consistency check, not proof of submission time. A pick with no timestamp, an unreadable one, one without a time
     zone, or one at/after kickoff is left out and settles as "needs review". Existing snapshots are never re-evaluated. */
  function snapshotEligibility(pick, game) {
    var t = pick && pick.submitted_at;
    if (!t) return { ok: false, why: "No submission time on record; needs review." };
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(String(t))) return { ok: false, why: "Submission time has no time zone; needs review." };
    var ms = Date.parse(t);
    if (!isFinite(ms)) return { ok: false, why: "Submission time is unreadable; needs review." };
    if (ms >= etToUtcMs(game.kickoff_et)) return { ok: false, why: "Submission time is at or after kickoff; needs review." };
    return { ok: true, why: null };
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
    var raw = String(m || "").toLowerCase();
    // full-game markets only: half, quarter, first/last TD and other period markets are not comparable
    if (/half|quarter|\b1h\b|\b2h\b|\b[1-4]q\b|\bq[1-4]\b|first|last|1st|2nd|3rd|4th|period/.test(raw)) return null;
    var x = raw.replace(/[^a-z0-9+]/g, "");
    if (!x || x.indexOf("any") !== -1) return "anytime_td";
    if (x.indexOf("2") !== -1 || x.indexOf("two") !== -1) return "2plus_td";
    return null; // other markets are ignored
  }
  /* Observation time from an upload. ISO with Z or an offset is used as is; a bare "YYYY-MM-DD HH:MM" is read as
     Eastern time (the app's time zone), never the browser's. Anything else -> NaN. */
  function parseObserved(s) {
    var t = String(s || "").trim();
    if (!t) return NaN;
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t) && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) return Date.parse(t.replace(" ", "T"));
    var m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(t);
    return m ? etToUtcMs(m[1] + "T" + m[2]) : NaN;
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
      var obs = when ? parseObserved(when) : NaN;
      if (when && !isFinite(obs)) return skipped.push({ line: l, why: "time must be like 2026-11-15T12:30:00Z or 2026-11-15 12:30 (Eastern)" });
      rows.push({ player: c[0], team: (c[1] || "").toUpperCase(), book: c[2] || "", market: market, american: american,
        captured_at: when ? new Date(obs).toISOString() : (nowIso || new Date().toISOString()), time_source: when ? "provided" : "upload time" });
    });
    return { rows: rows, skipped: skipped };
  }
  /* Is an uploaded price usable? game: the player's game (or null if unmatched). */
  function lineProblem(row, game, nowMs) {
    var t = Date.parse(row.captured_at);
    if (!isFinite(t)) return "no capture time";
    if (t > nowMs + 10 * 60000) return "capture time is in the future";
    if (nowMs - t > 7 * 864e5) return "older than 7 days";
    if (game && isLocked(game, nowMs)) return "game has started: prices can only be added before kickoff, even ones captured earlier";
    if (game && t >= etToUtcMs(game.kickoff_et)) return "captured after kickoff";
    return null;
  }
  /* Best price for one player and market across books: highest payout among fresh prices (latest per book);
     if none is fresh, the most recent price flagged stale. Returns null when there are no prices. */
  function bestPrice(rows, nowMs, maxAgeMin) {
    // only rows with a valid price and a valid, not-future observation time are considered
    var ok = (rows || []).filter(function (r) { var t = observedMs(r); return isFinite(parseAmerican(r.american)) && isFinite(t) && t <= nowMs + FUTURE_SLACK_MIN * 60000; });
    if (!ok.length) return null;
    var perBook = {};
    ok.forEach(function (r) { var k = r.book || "Unknown book"; if (!perBook[k] || observedMs(r) > observedMs(perBook[k])) perBook[k] = r; });
    var latest = Object.keys(perBook).map(function (k) { return perBook[k]; });
    var fresh = latest.filter(function (r) { return priceFresh(r, nowMs, maxAgeMin); });
    var pool = fresh.length ? fresh : latest;
    // fresh: best payout first (ties: newer observation, then book name); stale: newest observation first
    pool.sort(fresh.length ? function (a, b) { return americanToDecimal(b.american) - americanToDecimal(a.american) || observedMs(b) - observedMs(a) || String(a.book).localeCompare(String(b.book)); }
                           : function (a, b) { return observedMs(b) - observedMs(a) || String(a.book).localeCompare(String(b.book)); });
    var best = pool[0];
    return Object.assign({}, best, { stale: !fresh.length, books: fresh.length || latest.length,
      others: pool.slice(1).map(function (r) { return { book: r.book, american: r.american, captured_at: r.captured_at }; }) });
  }

  /* ================= Results dashboard (pure; tested in tests/lib.test.js) =================
     A row is one submitted pick: {season, week, game_id, kickoff_ms, uid, gsis_id, player, team, pos, market,
     p (probability saved at pick time, or null), state ("win"|"loss"|"void"|"pending"|"needs_review"), why,
     tds (qualifying TDs credited to the player in that game, or null when not final/known), game_final}. */
  var SMALL_N = 10;
  function outcomeOf(state) { return state === "win" ? "hit" : state === "loss" ? "miss" : state === "void" ? "void" : state === "needs_review" ? "review" : "pending"; }
  function rate(h, s) { return s > 0 ? h / s : null; }
  function wkKey(r) { return r.season * 100 + r.week; }
  var STATE_RANK = { hit: 5, miss: 5, review: 3, pending: 2, void: 1 };

  /* Filter, drop exact duplicates (same member, game, player, market), and optionally collapse to unique player-games. */
  function prepareRows(rows, f, unit) {
    f = f || {};
    var seen = {}, dupes = 0, out = [];
    (rows || []).forEach(function (r) {
      if (f.season != null && r.season !== f.season) return;
      if (f.weekFrom != null && r.week < f.weekFrom) return;
      if (f.weekTo != null && r.week > f.weekTo) return;
      if (f.uid && r.uid !== f.uid) return;
      if (f.pos && r.pos !== f.pos) return;
      if (f.team && r.team !== f.team) return;
      if (f.market && r.market !== f.market) return;
      var k = [r.uid, r.season, r.game_id, r.gsis_id, r.market].join("|");
      if (seen[k]) { dupes++; return; }
      seen[k] = 1;
      out.push(Object.assign({}, r, { outcome: outcomeOf(r.state) }));
    });
    if (unit === "unique") {
      var g = {};
      out.forEach(function (r) {
        var k = [r.season, r.game_id, r.gsis_id, r.market].join("|");
        if (!g[k]) { g[k] = Object.assign({}, r, { members: [r.uid], ps: r.p != null ? [r.p] : [] }); return; }
        var cur = g[k]; cur.members.push(r.uid); if (r.p != null) cur.ps.push(r.p);
        if (STATE_RANK[r.outcome] > STATE_RANK[cur.outcome]) { cur.outcome = r.outcome; cur.state = r.state; cur.why = r.why; }
      });
      out = Object.keys(g).map(function (k) { var r = g[k]; r.p = r.ps.length ? r.ps.reduce(function (a, b) { return a + b; }, 0) / r.ps.length : null; r.uid = r.members.length > 1 ? "(" + r.members.length + " members)" : r.members[0]; return r; });
    }
    return { rows: out, duplicates: dupes };
  }
  function tally(rs) {
    var t = { n: rs.length, hits: 0, misses: 0, void: 0, pending: 0, review: 0 };
    rs.forEach(function (r) { t[r.outcome === "hit" ? "hits" : r.outcome === "miss" ? "misses" : r.outcome]++; });
    t.settled = t.hits + t.misses; t.hitRate = rate(t.hits, t.settled); t.missRate = rate(t.misses, t.settled); t.small = t.settled < SMALL_N;
    return t;
  }
  function probBand(p) { return p == null || !(p >= 0 && p <= 1) ? null : p < 0.1 ? "0-10%" : p < 0.2 ? "10-20%" : p < 0.3 ? "20-30%" : p < 0.45 ? "30-45%" : "45-100%"; }
  function dashboard(rows, opts) {
    opts = opts || {};
    var prep = prepareRows(rows, opts.filters, opts.unit), rs = prep.rows;
    var settled = rs.filter(function (r) { return r.outcome === "hit" || r.outcome === "miss"; });
    var summary = tally(rs); summary.duplicates = prep.duplicates;
    // weeks (season-aware), gaps stay gaps
    var byW = {};
    rs.forEach(function (r) { (byW[wkKey(r)] = byW[wkKey(r)] || []).push(r); });
    var weeks = Object.keys(byW).map(Number).sort(function (a, b) { return a - b; }).map(function (k) {
      var w = byW[k], t = tally(w), sp = w.filter(function (r) { return (r.outcome === "hit" || r.outcome === "miss"); });
      var withP = sp.filter(function (r) { return r.p != null; });
      return Object.assign(t, { season: Math.floor(k / 100), week: k % 100, complete: t.pending === 0 && w.every(function (r) { return r.game_final; }),
        expected: withP.length === sp.length && sp.length ? withP.reduce(function (a, r) { return a + r.p; }, 0) : null,
        tds: sp.every(function (r) { return r.tds != null; }) ? sp.reduce(function (a, r) { return a + r.tds; }, 0) : null });
    });
    var ch = 0, cs = 0, ctd = 0, tdKnown = true;
    var cumulative = weeks.map(function (w) { ch += w.hits; cs += w.settled; if (w.tds == null) tdKnown = false; else ctd += w.tds;
      return { season: w.season, week: w.week, hits: ch, misses: cs - ch, settled: cs, hitRate: rate(ch, cs), tds: tdKnown ? ctd : null }; });
    // categories
    function by(fn) { var m = {}; rs.forEach(function (r) { var k = fn(r); if (k == null) return; (m[k] = m[k] || []).push(r); });
      return Object.keys(m).map(function (k) { return Object.assign({ key: k }, tally(m[k])); }).sort(function (a, b) { return b.settled - a.settled || (a.key < b.key ? -1 : 1); }); }
    var categories = { member: by(function (r) { return r.uid; }), position: by(function (r) { return r.pos || "Unknown"; }), team: by(function (r) { return r.team || "Unknown"; }),
      market: by(function (r) { return r.market; }), probability: by(function (r) { return probBand(r.p) || "Not recorded"; }) };
    // touchdowns (settled selections only)
    var known = settled.filter(function (r) { return r.tds != null; });
    var dist = { "0": 0, "1": 0, "2": 0, "3+": 0 };
    known.forEach(function (r) { dist[r.tds >= 3 ? "3+" : String(r.tds)]++; });
    var uniq = {}; known.forEach(function (r) { uniq[[r.season, r.game_id, r.gsis_id].join("|")] = r.tds; });
    var touchdowns = { selections: known.length, unknown: settled.length - known.length, perSelectionTotal: known.reduce(function (a, r) { return a + r.tds; }, 0),
      uniquePlayerGames: Object.keys(uniq).length, uniqueTotal: Object.keys(uniq).reduce(function (a, k) { return a + uniq[k]; }, 0), dist: dist };
    touchdowns.avgPerSelection = known.length ? touchdowns.perSelectionTotal / known.length : null;
    // calibration: only probabilities saved at pick time
    var cp = settled.filter(function (r) { return r.p != null && r.p >= 0 && r.p <= 1; });
    var calibration = null;
    if (cp.length) {
      var y = function (r) { return r.outcome === "hit" ? 1 : 0; };
      var bins = {}; cp.forEach(function (r) { (bins[probBand(r.p)] = bins[probBand(r.p)] || []).push(r); });
      calibration = { n: cp.length, missing: settled.length - cp.length, expected: cp.reduce(function (a, r) { return a + r.p; }, 0), observed: cp.filter(function (r) { return y(r); }).length,
        brier: cp.reduce(function (a, r) { return a + Math.pow(r.p - y(r), 2); }, 0) / cp.length,
        bins: ["0-10%", "10-20%", "20-30%", "30-45%", "45-100%"].filter(function (b) { return bins[b]; }).map(function (b) { var v = bins[b];
          return { band: b, n: v.length, avgP: v.reduce(function (a, r) { return a + r.p; }, 0) / v.length, observed: v.filter(y).length / v.length }; }) };
      calibration.diff = calibration.observed - calibration.expected;
    }
    // extremes: all tied weeks listed; small and incomplete weeks flagged
    var rated = weeks.filter(function (w) { return w.settled > 0; });
    var hiR = rated.length ? Math.max.apply(null, rated.map(function (w) { return w.hitRate; })) : null;
    var loR = rated.length ? Math.min.apply(null, rated.map(function (w) { return w.hitRate; })) : null;
    var extremes = { best: rated.filter(function (w) { return w.hitRate === hiR; }), worst: rated.filter(function (w) { return w.hitRate === loR; }) };
    // week streaks against an explicit benchmark: hits vs the model's expected hits (only weeks where every settled pick has a saved probability)
    var runs = { current: null, longestAbove: 0, longestBelow: 0, weeksCompared: 0 };
    var prevKey = null, cur = 0, curSign = 0;
    weeks.forEach(function (w) {
      var k = w.season * 100 + w.week;
      if (w.expected == null || !w.settled) { cur = 0; curSign = 0; prevKey = null; return; }
      runs.weeksCompared++;
      var sign = w.hits > w.expected ? 1 : w.hits < w.expected ? -1 : 0;
      var consecutive = prevKey != null && k === prevKey + 1;
      cur = sign !== 0 && sign === curSign && consecutive ? cur + 1 : sign !== 0 ? 1 : 0; curSign = sign; prevKey = k;
      if (sign > 0) runs.longestAbove = Math.max(runs.longestAbove, cur); if (sign < 0) runs.longestBelow = Math.max(runs.longestBelow, cur);
      runs.current = sign === 0 ? { dir: "even", n: 0 } : { dir: sign > 0 ? "above" : "below", n: cur };
    });
    return { rows: rs, summary: summary, weeks: weeks, cumulative: cumulative, categories: categories, touchdowns: touchdowns, calibration: calibration, extremes: extremes, weekRuns: runs, smallN: SMALL_N };
  }

  var api = { dashboard: dashboard, prepareRows: prepareRows, snapshotEligibility: snapshotEligibility, PRICE_FRESH_MIN: PRICE_FRESH_MIN, parseObserved: parseObserved, parseAmerican: parseAmerican, normMarket: normMarket, parseLines: parseLines, lineProblem: lineProblem, bestPrice: bestPrice, etToUtcMs: etToUtcMs, fmtEt: fmtEt, isLocked: isLocked, pickKey: pickKey, validatePick: validatePick,
    americanToProb: americanToProb, americanToDecimal: americanToDecimal, probToAmerican: probToAmerican, edge: edge,
    priceFresh: priceFresh, modelValidated: modelValidated, settle: settle, suggestSlate: suggestSlate, csv: csv,
    normName: normName, matchOdds: matchOdds, parlayLocked: parlayLocked, settleParlay: settleParlay, parlayChance: parlayChance };
  if (typeof module !== "undefined") module.exports = api; else root.FB = api;
})(this);
