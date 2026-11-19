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
  function americanToDecimal(a) {
    a = Number(a); if (!isFinite(a) || Math.abs(a) < 100) return NaN; // not an American price
    return a > 0 ? 1 + a / 100 : 1 + 100 / -a; }
  function probToAmerican(p) {
    if (!(p > 0 && p < 1)) return null;
    return p > 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p); // exactly 50% = +100 (even money)
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
    var need = pick.market === "2plus_td" ? 2 : 1;
    var count = (tds || []).filter(function (t) { return t.scorer_id === pick.gsis_id; }).length;
    if (count >= need) return { state: "win", why: need === 2 ? "Scored " + count + " touchdowns." : "Scored a touchdown." };
    if (!played) return { state: "pending", why: "Final, waiting for the snap counts that show who played." };
    if (played.indexOf(pick.gsis_id) === -1) return { state: "void", why: "Did not play (house rule: void)." };
    return { state: "loss", why: need === 2 && count === 1 ? "Played, one touchdown (2+ needed)." : "Played, no touchdown." };
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
  /* Model chance that every leg scores. Legs are multiplied as independent; same-game and same-team legs are flagged.
     (Tested Nov 2026, research/parlay_corr.py: teammates both scored a little less often than multiplying says, about
     9% less in 2026, but the gap was not statistically firm, so the maths is unchanged and the app shows a note.) */
  function parlayChance(legs) {
    var p = 1, pm = 1, games = {}, teams = {}, same = false, team = false;
    (legs || []).forEach(function (l) {
      p *= l.p || 0; pm *= (l.p_matchup != null ? l.p_matchup : l.p) || 0;
      if (games[l.game_id]) same = true; games[l.game_id] = 1;
      var tk = l.team ? l.game_id + "|" + l.team : null; if (tk) { if (teams[tk]) team = true; teams[tk] = 1; }
    });
    return { p: (legs || []).length ? p : null, pMatchup: (legs || []).length ? pm : null, sameGame: same, sameTeam: team };
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
  /* Sportsbook / screenshot team codes -> the nflverse codes the slate uses (books write the Rams as "LAR", nflverse "LA"). */
  var TEAM_ALIAS = { LAR: "LA", STL: "LA", JAC: "JAX", WSH: "WAS", LVR: "LV", OAK: "LV", SD: "LAC", KAN: "KC", GNB: "GB", NWE: "NE",
    NOR: "NO", SFO: "SF", TAM: "TB", ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU" };
  function normTeam(t) { var u = String(t || "").trim().toUpperCase(); return TEAM_ALIAS[u] || u; }
  function matchOdds(row, candidates) {
    var n = normName(row.player);
    var hits = candidates.filter(function (c) {
      var full = normName(c.full_name || c.player), abbr = normName(c.player);
      return full === n || abbr === n || (c.player && n.length > 3 && full.endsWith(n.slice(1)) && n[0] === abbr[0]);
    });
    if (row.team) { var tm = normTeam(row.team); hits = hits.filter(function (c) { return normTeam(c.team) === tm; }); }
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
    // "Anytime 2+ TD", "2+ Anytime Touchdowns", "to score 2 or more": the count decides before the word "anytime"
    if (/2\+|2ormore|twoormore|\btwo\b|2tds?\b|2plus|atleast2|multi/.test(x) || /\b(2|two)\s*(\+|or more|plus)|\b(2|two)\s*(td|touchdown)/.test(raw)) return "2plus_td";
    if (/3\+|3ormore|three/.test(x)) return null; // 3+ TDs is not a market the app tracks
    if (!x || x.indexOf("any") !== -1 || /^atds?$/.test(x)) return "anytime_td";
    if (x.indexOf("2") !== -1) return "2plus_td";
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

  /* ================= Book comparison and line moves (pure; tested in tests/lib.test.js) =================
     rows: price rows for ONE player and ONE market, from any member's uploads. A row may carry open_american /
     open_captured_at: the first price its uploader saw from that book this week (kept when a newer price replaced it). */
  var BIG_MOVE_PTS = 2; // a move of 2+ percentage points of implied chance is flagged as big
  function validRows(rows, nowMs) {
    return (rows || []).filter(function (r) { var t = observedMs(r); return isFinite(parseAmerican(r.american)) && isFinite(t) && t <= nowMs + FUTURE_SLACK_MIN * 60000; });
  }
  function bookOpen(rows, book) {
    // earliest observation of this book's price across every uploader (open_* when present, else the row itself)
    var best = null;
    rows.forEach(function (r) {
      if ((r.book || "Unknown book") !== book) return;
      var oa = r.open_american != null ? r.open_american : r.american, ot = r.open_captured_at || r.captured_at, ms = parseObserved(ot);
      if (!isFinite(parseAmerican(oa)) || !isFinite(ms)) return;
      if (!best || ms < best.ms) best = { american: parseAmerican(oa), captured_at: ot, ms: ms };
    });
    return best;
  }
  function moveOf(open, cur) {
    if (!open || open.american === cur.american) return null;
    var pts = (americanToProb(cur.american) - americanToProb(open.american)) * 100;
    return { from: open.american, from_at: open.captured_at, to: cur.american, pts: pts,
      dir: americanToDecimal(cur.american) > americanToDecimal(open.american) ? "longer" : "shorter", big: Math.abs(pts) >= BIG_MOVE_PTS };
  }
  /* Every book's latest price, best payout first. best/worst are set only when 2+ books differ in price. Age is shown,
     never used to drop a book; `fresh` (under PRICE_FRESH_MIN) is what value/EV math may use. */
  function bookBoard(rows, nowMs, maxAgeMin) {
    var ok = validRows(rows, nowMs); if (!ok.length) return null;
    var perBook = {};
    ok.forEach(function (r) { var k = r.book || "Unknown book"; if (!perBook[k] || observedMs(r) > observedMs(perBook[k])) perBook[k] = r; });
    var books = Object.keys(perBook).map(function (k) {
      var r = perBook[k], am = parseAmerican(r.american);
      return Object.assign({}, r, { book: k, american: am, age_min: Math.max(0, Math.round((nowMs - observedMs(r)) / 60000)),
        fresh: priceFresh(r, nowMs, maxAgeMin), move: moveOf(bookOpen(ok, k), { american: am }) });
    });
    books.sort(function (a, b) { return americanToDecimal(b.american) - americanToDecimal(a.american) || observedMs(b) - observedMs(a) || String(a.book).localeCompare(String(b.book)); });
    var spread = books.length > 1 && books[0].american !== books[books.length - 1].american;
    books.forEach(function (b, i) { b.rank = !spread ? "only" : americanToDecimal(b.american) === americanToDecimal(books[0].american) ? "best" : americanToDecimal(b.american) === americanToDecimal(books[books.length - 1].american) ? "worst" : "mid"; });
    return { best: books[0], books: books, n: books.length, stale: !books[0].fresh };
  }
  /* Every price change this week across players, books and markets: one entry per player/book/market whose latest price
     differs from the first price seen. Big moves first, then by size. */
  function lineMoves(rows, nowMs) {
    var ok = validRows(rows, nowMs), groups = {};
    ok.forEach(function (r) { if (!r.gsis_id) return; var k = [r.gsis_id, r.market || "anytime_td"].join("|"); (groups[k] = groups[k] || []).push(r); });
    var out = [];
    Object.keys(groups).forEach(function (k) {
      var b = bookBoard(groups[k], nowMs); if (!b) return;
      b.books.forEach(function (x) { if (x.move) out.push({ gsis_id: x.gsis_id, player: x.player, team: x.team, game_id: x.game_id, market: x.market || "anytime_td",
        book: x.book, captured_at: x.captured_at, move: x.move }); });
    });
    out.sort(function (a, b) { return (b.move.big - a.move.big) || Math.abs(b.move.pts) - Math.abs(a.move.pts) || String(a.player).localeCompare(String(b.player)); });
    return out;
  }
  /* "Above fair": a FRESH anytime-TD price whose implied chance (book margin included) is at least ABOVE_FAIR_PTS percentage
     points below the model's chance, i.e. the book pays clearly more than the model's fair odds. A research marker only:
     in testing the sportsbooks' own prices predicted better than the model. Returns {pts, implied} or null. */
  var ABOVE_FAIR_PTS = 3;
  function aboveFair(modelP, priceRow, nowMs, market, range) {
    if ((market || (priceRow && priceRow.market) || "anytime_td") !== "anytime_td") return null;
    if (!priceRow || !(modelP > 0 && modelP < 1) || !priceFresh(priceRow, nowMs)) return null;
    var imp = americanToProb(priceRow.american); if (!isFinite(imp)) return null;
    var pts = Math.round((modelP - imp) * 1000) / 10; // one decimal, as shown
    if (pts < ABOVE_FAIR_PTS) return null;
    // firm = even the LOW end of the chance range beats the price (null when no range is known)
    return { pts: pts, implied: imp, firm: range && range.lo != null ? range.lo > imp : null, lo: range ? range.lo : null };
  }
  /* Uncertainty range around a touchdown chance: logit(p) +/- z*sd. sd is how far the model's chance typically sits
     from the sportsbooks' (measured on graded player-games, in logit units); cfg = slate.range {sd_logit, z}.
     scale shrinks it for a chance already combined with the market (the blend's model weight). A range, not a guarantee. */
  function chanceRange(p, cfg, scale) {
    if (!(p > 0 && p < 1) || !cfg || !(cfg.sd_logit > 0)) return null;
    var w = cfg.sd_logit * (typeof cfg.z === "number" ? cfg.z : 1.28) * (typeof scale === "number" ? scale : 1);
    var lg = Math.log(p / (1 - p)), f = function (x) { return 1 / (1 + Math.exp(-x)); };
    return { lo: f(lg - w), hi: f(lg + w) };
  }
  /* ================= Weekly Rankings (pure; tested in tests/lib.test.js) =================
     items: one per player in a game still open, for ONE market: {key, name, chance (model probability for that market),
     prices: [uploaded price rows for that player and market]}. Each book contributes its latest valid price (valid
     American odds, not future-dated; a newer observation replaces the older one). The price used is the best payout
     among FRESH prices (under PRICE_FRESH_MIN) when any exist; otherwise the best last-known price, flagged stale.
     Age always comes from the price's own captured/upload time, never from when the model was refreshed.
     Edge = chance - implied probability of that price, in points (book margin included). Ranks use standard
     competition ranking (ties share the best rank: 1, 2, 2, 4). */
  function bestEligiblePrice(rows, nowMs) {
    var b = bookBoard(rows, nowMs); if (!b) return null;
    for (var i = 0; i < b.books.length; i++) if (b.books[i].fresh) return Object.assign({}, b.books[i], { stale: false });
    return Object.assign({}, b.books[0], { stale: true }); // all stale: best last-known price
  }
  function competitionRanks(list, cmp) {
    var ranks = [];
    list.forEach(function (x, i) { ranks[i] = i > 0 && cmp(list[i - 1], x) === 0 ? ranks[i - 1] : i + 1; });
    return ranks;
  }
  /* Model + market: equal parts, on the log-odds scale, of the model's chance and the sportsbooks' implied chance (the
     average across books of the raw implied chance, margin included). Adopted for RB / WR / TE after the Weeks 2-4 2026
     test (research/improvements.py): 407 player-games, log loss 0.563 vs 0.575 for the model alone. Returns the model's
     chance unchanged when there is no usable price. */
  function blendChance(pModel, implieds, weight) {
    var ps = (implieds || []).filter(function (x) { return typeof x === "number" && x > 0 && x < 1; });
    if (!(pModel > 0 && pModel < 1) || !ps.length) return pModel;
    var w = typeof weight === "number" ? weight : 0.5;
    var lg = function (p) { p = Math.min(0.999, Math.max(0.001, p)); return Math.log(p / (1 - p)); };
    var imp = ps.reduce(function (a, b) { return a + b; }, 0) / ps.length;
    return 1 / (1 + Math.exp(-(w * lg(pModel) + (1 - w) * lg(imp))));
  }
  /* ---------- game lines (Lines tab) ---------- */
  /* Win chances from a two-sided moneyline with the book's margin removed: each side's implied chance divided by the
     two sides' total. Both sides are posted, so this is a true no-margin number (unlike a one-sided TD price). */
  function noVig(awayAmerican, homeAmerican) {
    var a = americanToProb(awayAmerican), h = americanToProb(homeAmerican);
    if (!(a > 0 && a < 1 && h > 0 && h < 1)) return null;
    return { away: a / (a + h), home: h / (a + h), margin: a + h - 1 };
  }
  /* What a bet is worth against a fair (no-margin) chance: expected return per 1 staked. -0.045 = the bet costs 4.5%
     of the stake on average; above 0 the price beats the fair price. null when either input is missing. */
  function betValue(fairP, american) {
    var d = americanToDecimal(american);
    if (!(fairP > 0 && fairP < 1) || !isFinite(d)) return null;
    return fairP * d - 1;
  }
  var VALUE_MIN_EV = 0.01, VALUE_MIN_REFS = 2;   // same thresholds as refresh/odds_feed.py
  function isValue(fairP, american, refs) { var v = betValue(fairP, american); return v != null && v >= VALUE_MIN_EV && (refs || 0) >= VALUE_MIN_REFS; }
  /* Every side of one book's game lines with its cost: [{market, side, team/label, line, american, fair, refs, value}]. */
  function lineCosts(m, away, home) {
    var out = [], f = m.fair || {};
    var add = function (market, side, label, line, american, rec) {
      if (american == null || !rec || rec[side] == null) return;
      out.push({ book: m.book, market: market, side: side, label: label, line: line, american: american, fair: rec[side], refs: rec.n || 0, value: betValue(rec[side], american) });
    };
    if (m.spread) { add("spread", "home", home, m.spread.home_line, m.spread.home_american, f.spread); add("spread", "away", away, -m.spread.home_line, m.spread.away_american, f.spread); }
    if (m.total) { add("total", "over", "Over", m.total.line, m.total.over_american, f.total); add("total", "under", "Under", m.total.line, m.total.under_american, f.total); }
    if (m.ml) { add("ml", "home", home, null, m.ml.home_american, m.ml.fair); add("ml", "away", away, null, m.ml.away_american, m.ml.fair); }
    return out;
  }
  /* ---------- game picks (spread, total, moneyline) ---------- */
  function gamePickKey(week, gameId, market) { return "g" + week + "_" + gameId + "_" + market; }
  /* The best offer for each side among the books (the better number first, then the better price): what a pick records.
     {spread_home: {book, line, american}, spread_away, total_over, total_under, ml_home, ml_away} */
  function gamePickOffers(books) {
    var out = {}, dec = function (a) { var d = americanToDecimal(a); return isFinite(d) ? d : -1; };
    var put = function (key, book, rank, line, american) {
      if (american == null || !isFinite(dec(american)) || dec(american) <= 1 || rank == null || !isFinite(rank)) return;
      var cur = out[key];
      if (!cur || rank > cur._rank || (rank === cur._rank && dec(american) > dec(cur.american))) out[key] = { book: book, line: line, american: american, _rank: rank };
    };
    (books || []).forEach(function (m) {
      if (m.spread) { put("spread_home", m.book, m.spread.home_line, m.spread.home_line, m.spread.home_american); put("spread_away", m.book, -m.spread.home_line, -m.spread.home_line, m.spread.away_american); }
      if (m.total) { put("total_over", m.book, -m.total.line, m.total.line, m.total.over_american); put("total_under", m.book, m.total.line, m.total.line, m.total.under_american); }
      if (m.ml) { put("ml_home", m.book, 0, null, m.ml.home_american); put("ml_away", m.book, 0, null, m.ml.away_american); }
    });
    Object.keys(out).forEach(function (k) { delete out[k]._rank; });
    return out;
  }
  /* A game pick against the final score. `line` is the picked side's own line for a spread, the total for over/under.
     pending until the game is final; win pays the recorded price, loss costs 1 unit, push returns the stake. */
  function gradeGamePick(pick, game) {
    if (!pick || !game || game.status !== "final" || game.away_score == null || game.home_score == null) return { state: "pending", units: 0 };
    var hs = game.home_score, as = game.away_score, res;
    if (pick.market === "ml") res = hs === as ? "push" : (hs > as) === (pick.side === "home") ? "win" : "loss";
    else if (pick.market === "spread") { var v = (pick.side === "home" ? hs - as : as - hs) + pick.line; res = v === 0 ? "push" : v > 0 ? "win" : "loss"; }
    else if (pick.market === "total") { var t = hs + as; res = t === pick.line ? "push" : (t > pick.line) === (pick.side === "over") ? "win" : "loss"; }
    else return { state: "pending", units: 0 };
    var d = americanToDecimal(pick.american);
    return { state: res, units: res === "win" ? (isFinite(d) ? d - 1 : 0) : res === "loss" ? -1 : 0 };
  }
  /* Was this pick in place at kickoff? A pick made at or after kickoff never counts. Where a kickoff snapshot recorded
     game picks, the pick must match it (same market, side and line), so it can't be changed afterwards. */
  function gamePickValid(pick, game, lock, uid) {
    var k = etToUtcMs(game && game.kickoff_et), t = Date.parse(pick && pick.picked_at);
    if (!isFinite(k) || !isFinite(t) || t >= k) return { ok: false, why: "Made at or after kickoff." };
    if (lock && lock.game_picks) {
      var f = (lock.game_picks[uid] || {})[pick.key];
      if (!f || f.side !== pick.side || f.market !== pick.market || (f.line == null ? null : f.line) !== (pick.line == null ? null : pick.line)) return { ok: false, why: "Not in the kickoff snapshot: added or changed after kickoff." };
    }
    return { ok: true };
  }
  /* Record over a list of {pick, grade}: wins, losses, pushes, pending and units at 1 unit a pick. */
  function gamePickRecord(graded) {
    var r = { w: 0, l: 0, p: 0, pending: 0, not_counted: 0, units: 0, n: 0 };
    (graded || []).forEach(function (x) { r.n++; if (x.state === "win") r.w++; else if (x.state === "loss") r.l++; else if (x.state === "push") r.p++; else if (x.state === "void") r.not_counted++; else r.pending++; r.units += x.units || 0; });
    return r;
  }
  /* The value tracker's record: how many flags, how they compared with the closing fair price, and how they finished. */
  function valueSummary(log) {
    log = log || []; var closed = log.filter(function (e) { return typeof e.clv_pts === "number"; }), done = log.filter(function (e) { return e.result; });
    var sum = function (xs, k) { return xs.reduce(function (a, e) { return a + (e[k] || 0); }, 0); };
    var cnt = function (r) { return done.filter(function (e) { return e.result === r; }).length; };
    return { flagged: log.length, with_close: closed.length, avg_clv: closed.length ? sum(closed, "clv_pts") / closed.length : null,
      beat_close: closed.length ? closed.filter(function (e) { return e.clv_pts > 0; }).length / closed.length : null,
      graded: done.length, wins: cnt("win"), losses: cnt("loss"), pushes: cnt("push"), units: done.length ? sum(done, "units") : null,
      avg_ev: log.length ? sum(log, "ev_pct") / log.length : null };
  }
  /* One line for a game from its books: average spread and total, the score they imply, and the no-margin win chance. */
  function lineSummary(books) {
    var avg = function (xs) { xs = xs.filter(function (x) { return typeof x === "number" && isFinite(x); }); return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : null; };
    var sp = avg((books || []).map(function (m) { return m.spread ? m.spread.home_line : null; }));
    var tot = avg((books || []).map(function (m) { return m.total ? m.total.line : null; }));
    var wins = (books || []).map(function (m) { return m.ml ? noVig(m.ml.away_american, m.ml.home_american) : null; }).filter(Boolean);
    var out = { home_line: sp, total: tot, home_pts: null, away_pts: null, home_win: avg(wins.map(function (w) { return w.home; })), books: (books || []).length };
    if (sp != null && tot != null) { out.home_pts = tot / 2 - sp / 2; out.away_pts = tot / 2 + sp / 2; }
    return out;
  }
  /* Which book is better for the bettor on each side of each market. Returned only where the books differ.
     Spread: the larger number for that team (+16.5 beats +15.5; -15.5 beats -16.5), then the better price.
     Total: Over wants the lower line, Under the higher, then the better price. Moneyline: the better price. */
  function bestLines(books) {
    var out = {}; if (!books || books.length < 2) return out;
    var dec = function (a) { var d = americanToDecimal(a); return isFinite(d) ? d : -1; };
    var pick = function (key, cands) {       // cands: [{book, line, price}], larger line is better
      cands = cands.filter(function (c) { return c.line != null && isFinite(c.line) && c.price != null; });
      if (cands.length < 2) return;
      cands.sort(function (x, y) { return y.line - x.line || dec(y.price) - dec(x.price); });
      var top = cands[0], next = cands[1];
      if (top.line !== next.line || dec(top.price) !== dec(next.price)) out[key] = top.book;
    };
    pick("spread_home", books.map(function (m) { return { book: m.book, line: m.spread ? m.spread.home_line : null, price: m.spread && m.spread.home_american }; }));
    pick("spread_away", books.map(function (m) { return { book: m.book, line: m.spread ? -m.spread.home_line : null, price: m.spread && m.spread.away_american }; }));
    pick("total_over", books.map(function (m) { return { book: m.book, line: m.total ? -m.total.line : null, price: m.total && m.total.over_american }; }));
    pick("total_under", books.map(function (m) { return { book: m.book, line: m.total ? m.total.line : null, price: m.total && m.total.under_american }; }));
    pick("ml_home", books.map(function (m) { return { book: m.book, line: 0, price: m.ml && m.ml.home_american }; }));
    pick("ml_away", books.map(function (m) { return { book: m.book, line: 0, price: m.ml && m.ml.away_american }; }));
    return out;
  }
  /* A final score against a spread (the HOME team's line) and a total. */
  function gradeLine(game, homeLine, total) {
    if (!game || game.away_score == null || game.home_score == null) return null;
    var out = { ats: null, ou: null };
    if (homeLine != null && isFinite(homeLine)) { var v = game.home_score - game.away_score + homeLine; out.ats = v === 0 ? "push" : v > 0 ? "home" : "away"; }
    if (total != null && isFinite(total)) { var t = game.home_score + game.away_score; out.ou = t === total ? "push" : t > total ? "over" : "under"; }
    return out;
  }
  /* Season record per team from final games: points for/against per game, and results against the schedule file's
     closing spread and total (nflverse spread_line = points the HOME team is favoured by, so its line is -spread_line). */
  function teamRecords(games, beforeWeek) {
    var T = {};
    var get = function (k) { return T[k] || (T[k] = { games: 0, pf: 0, pa: 0, w: 0, l: 0, t: 0, ats_w: 0, ats_l: 0, ats_p: 0, over: 0, under: 0, ou_p: 0 }); };
    (games || []).forEach(function (g) {
      if (g.status !== "final" || g.away_score == null || g.home_score == null || (beforeWeek != null && g.week >= beforeWeek)) return;
      var h = get(g.home), a = get(g.away);
      h.games++; a.games++; h.pf += g.home_score; h.pa += g.away_score; a.pf += g.away_score; a.pa += g.home_score;
      if (g.home_score === g.away_score) { h.t++; a.t++; } else if (g.home_score > g.away_score) { h.w++; a.l++; } else { a.w++; h.l++; }
      var r = gradeLine(g, typeof g.spread_line === "number" ? -g.spread_line : null, typeof g.total_line === "number" ? g.total_line : null);
      if (r && r.ats) { if (r.ats === "push") { h.ats_p++; a.ats_p++; } else if (r.ats === "home") { h.ats_w++; a.ats_l++; } else { a.ats_w++; h.ats_l++; } }
      if (r && r.ou) { [h, a].forEach(function (x) { if (r.ou === "push") x.ou_p++; else if (r.ou === "over") x.over++; else x.under++; }); }
    });
    return T;
  }
  function weeklyRankings(items, nowMs) {
    var ok = (items || []).filter(function (it) { return typeof it.chance === "number" && it.chance > 0 && it.chance < 1; });
    var byName = function (a, b) { return String(a.name).localeCompare(String(b.name)); };
    var chance = ok.map(function (it) { return Object.assign({}, it, { fair: probToAmerican(it.chance) }); })
      .sort(function (a, b) { return b.chance - a.chance || byName(a, b); });
    var priced = ok.map(function (it) {
      var best = bestEligiblePrice(it.prices, nowMs); if (!best) return null;
      var implied = americanToProb(best.american);
      // value is judged on the MODEL's own chance (valueChance) when the headline chance already includes the price
      var vc = typeof it.valueChance === "number" ? it.valueChance : it.chance;
      return Object.assign({}, it, { fair: probToAmerican(it.chance), best: best, stale: best.stale, implied: implied, edgePts: (vc - implied) * 100 });
    }).filter(Boolean);
    var value = priced.filter(function (x) { return x.edgePts > 0; })
      .sort(function (a, b) { return b.edgePts - a.edgePts || b.chance - a.chance || byName(a, b); });
    var vr = competitionRanks(value, function (a, b) { return a.edgePts === b.edgePts ? 0 : 1; });
    value.forEach(function (x, i) { x.valueRank = vr[i]; });
    var byChance = value.slice().sort(function (a, b) { return b.chance - a.chance || byName(a, b); });
    var cr = competitionRanks(byChance, function (a, b) { return a.chance === b.chance ? 0 : 1; });
    byChance.forEach(function (x, i) { x.chanceRank = cr[i]; });
    var combined = value.map(function (x) { return Object.assign({}, x, { score: (x.valueRank + x.chanceRank) / 2 }); })
      .sort(function (a, b) { return a.score - b.score || b.chance - a.chance || b.edgePts - a.edgePts || byName(a, b); });
    var empty = value.length ? null : priced.length ? "No players above model fair value" : "No sportsbook prices uploaded for this market";
    var staleRows = value.filter(function (x) { return x.stale; }).length;
    return { chance: chance, value: value, combined: combined, valueEmpty: empty, eligiblePriced: priced.length,
      staleNote: !value.length || !staleRows ? null : staleRows === value.length ? "Showing last-known odds. All displayed prices are 2+ hours old." : "Some odds are 2+ hours old." };
  }

  /* Chance of 2+ TDs from the anytime chance, treating a player's TDs as Poisson: P(1+) = p gives rate L = -ln(1-p);
     P(2+) = 1 - (1-p)(1+L). An estimate: on 2026 Weeks 1-9 (3,566 player-games) it predicted 89.9 two-TD games; 98 happened. */
  function p2plus(p) {
    p = Number(p); if (!isFinite(p) || p <= 0) return 0; if (p >= 0.999) return 0.99;
    var L = -Math.log(1 - p); return Math.max(0, 1 - (1 - p) * (1 + L));
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
      market: by(function (r) { return r.market; }), probability: by(function (r) { return probBand(r.p) || "Not recorded"; }),
      above_fair: by(function (r) { return r.above_fair === true ? "Above fair" : r.above_fair === false ? "Not above fair" : "Not checked (no fresh price, 2+ TDs, or older pick)"; }) };
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

  var api = { dashboard: dashboard, prepareRows: prepareRows, snapshotEligibility: snapshotEligibility, PRICE_FRESH_MIN: PRICE_FRESH_MIN, parseObserved: parseObserved, parseAmerican: parseAmerican, normMarket: normMarket, parseLines: parseLines, lineProblem: lineProblem, bestPrice: bestPrice, bookBoard: bookBoard, lineMoves: lineMoves, p2plus: p2plus, weeklyRankings: weeklyRankings, blendChance: blendChance, gamePickKey: gamePickKey, gamePickOffers: gamePickOffers, gradeGamePick: gradeGamePick, gamePickValid: gamePickValid, gamePickRecord: gamePickRecord, noVig: noVig, betValue: betValue, isValue: isValue, lineCosts: lineCosts, valueSummary: valueSummary, lineSummary: lineSummary, bestLines: bestLines, gradeLine: gradeLine, teamRecords: teamRecords, bestEligiblePrice: bestEligiblePrice, aboveFair: aboveFair, ABOVE_FAIR_PTS: ABOVE_FAIR_PTS, BIG_MOVE_PTS: BIG_MOVE_PTS, etToUtcMs: etToUtcMs, fmtEt: fmtEt, isLocked: isLocked, pickKey: pickKey, validatePick: validatePick,
    americanToProb: americanToProb, americanToDecimal: americanToDecimal, probToAmerican: probToAmerican, edge: edge,
    priceFresh: priceFresh, modelValidated: modelValidated, settle: settle, suggestSlate: suggestSlate, csv: csv,
    normName: normName, normTeam: normTeam, matchOdds: matchOdds, parlayLocked: parlayLocked, settleParlay: settleParlay, parlayChance: parlayChance, chanceRange: chanceRange };
  if (typeof module !== "undefined") module.exports = api; else root.FB = api;
})(this);
