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
    if (!played) return { state: "needs_review", why: "Participation not published yet." };
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
  function aboveFair(modelP, priceRow, nowMs, market) {
    if ((market || (priceRow && priceRow.market) || "anytime_td") !== "anytime_td") return null;
    if (!priceRow || !(modelP > 0 && modelP < 1) || !priceFresh(priceRow, nowMs)) return null;
    var imp = americanToProb(priceRow.american); if (!isFinite(imp)) return null;
    var pts = Math.round((modelP - imp) * 1000) / 10; // one decimal, as shown
    return pts >= ABOVE_FAIR_PTS ? { pts: pts, implied: imp } : null;
  }
  /* ================= Weekly Rankings (pure; tested in tests/lib.test.js) =================
     items: one per player in a game still open, for ONE market: {key, name, chance (model probability for that market),
     prices: [uploaded price rows for that player and market]}. A price is eligible under the app's existing rules:
     valid American odds, not future-dated, and fresh (under PRICE_FRESH_MIN); the best eligible price is the highest
     payout among each book's latest fresh price. Edge = chance - implied probability of that price, in points
     (book margin included). Ranks use standard competition ranking (ties share the best rank: 1, 2, 2, 4). */
  function bestEligiblePrice(rows, nowMs) {
    var b = bookBoard(rows, nowMs); if (!b) return null;
    for (var i = 0; i < b.books.length; i++) if (b.books[i].fresh) return b.books[i];
    return null;
  }
  function competitionRanks(list, cmp) {
    var ranks = [];
    list.forEach(function (x, i) { ranks[i] = i > 0 && cmp(list[i - 1], x) === 0 ? ranks[i - 1] : i + 1; });
    return ranks;
  }
  function weeklyRankings(items, nowMs) {
    var ok = (items || []).filter(function (it) { return typeof it.chance === "number" && it.chance > 0 && it.chance < 1; });
    var byName = function (a, b) { return String(a.name).localeCompare(String(b.name)); };
    var chance = ok.map(function (it) { return Object.assign({}, it, { fair: probToAmerican(it.chance) }); })
      .sort(function (a, b) { return b.chance - a.chance || byName(a, b); });
    var priced = ok.map(function (it) {
      var best = bestEligiblePrice(it.prices, nowMs); if (!best) return null;
      var implied = americanToProb(best.american);
      return Object.assign({}, it, { fair: probToAmerican(it.chance), best: best, implied: implied, edgePts: (it.chance - implied) * 100 });
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
    var empty = value.length ? null : priced.length ? "No players above model fair value" : "No eligible sportsbook prices available";
    return { chance: chance, value: value, combined: combined, valueEmpty: empty, eligiblePriced: priced.length };
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

  var api = { dashboard: dashboard, prepareRows: prepareRows, snapshotEligibility: snapshotEligibility, PRICE_FRESH_MIN: PRICE_FRESH_MIN, parseObserved: parseObserved, parseAmerican: parseAmerican, normMarket: normMarket, parseLines: parseLines, lineProblem: lineProblem, bestPrice: bestPrice, bookBoard: bookBoard, lineMoves: lineMoves, p2plus: p2plus, weeklyRankings: weeklyRankings, bestEligiblePrice: bestEligiblePrice, aboveFair: aboveFair, ABOVE_FAIR_PTS: ABOVE_FAIR_PTS, BIG_MOVE_PTS: BIG_MOVE_PTS, etToUtcMs: etToUtcMs, fmtEt: fmtEt, isLocked: isLocked, pickKey: pickKey, validatePick: validatePick,
    americanToProb: americanToProb, americanToDecimal: americanToDecimal, probToAmerican: probToAmerican, edge: edge,
    priceFresh: priceFresh, modelValidated: modelValidated, settle: settle, suggestSlate: suggestSlate, csv: csv,
    normName: normName, normTeam: normTeam, matchOdds: matchOdds, parlayLocked: parlayLocked, settleParlay: settleParlay, parlayChance: parlayChance };
  if (typeof module !== "undefined") module.exports = api; else root.FB = api;
})(this);
