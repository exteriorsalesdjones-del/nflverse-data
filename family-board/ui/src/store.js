// Shared state for the Family Board: season data files + the artifact database.
// A tiny external store so React views re-render on db snapshots.
import FB from "../../artifact/lib.js";
import { useSyncExternalStore } from "react";

export { FB };

const S = {
  meta: null, games: [], gameById: {}, tds: [], weekly: [], slate: null, validation: null, played: {}, recon: {},
  loadError: null,
  db: null, user: null, uid: null, canWrite: false, isAdmin: false, names: {},
  allPicks: {}, odds: {}, locks: {}, reviews: {}, overrides: {}, refs: {}, extrasLoaded: false, lines: {}, parlaysAll: {}, draft: [], dbState: "connecting", downloads: null, sample: null,
  version: 0,
  weekMarket: (() => { try { return localStorage.getItem("fb_week_market") === "2plus_td" ? "2plus_td" : "anytime_td"; } catch (e) { return "anytime_td"; } })(),
};
/* Week tab: Anytime TD or 2+ TDs. Remembered on this device only. */
export function setWeekMarket(m) { S.weekMarket = m === "2plus_td" ? "2plus_td" : "anytime_td"; try { localStorage.setItem("fb_week_market", S.weekMarket); } catch (e) { /* storage unavailable */ } emit(); }
/* Chance shown for a market: the model's anytime chance, or the labeled Poisson estimate for 2+ TDs. */
export const chanceFor = (c, market = S.weekMarket) => (market === "2plus_td" ? FB.p2plus(c.p) : c.p);
const subs = new Set();
function emit() { S.version++; subs.forEach((f) => f()); }
export function useStore() {
  useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => S.version);
  return S;
}
export const state = S;

async function loadJson(n) {
  const r = await fetch("data/" + n, { cache: "no-cache" });
  if (!r.ok) throw new Error(n + " " + r.status);
  return r.json();
}

/* Blind pre-game reads (weeks 1-9): loaded only when the TDs tab section is opened. undefined = not loaded, null = unavailable. */
let pregamePromise = null;
export function ensurePregame() {
  if (!pregamePromise) pregamePromise = loadJson("pregame_reads.json").then((d) => { S.pregame = d; emit(); }).catch(() => { S.pregame = null; emit(); });
  return pregamePromise;
}
/* Analysis tab (docs/ANALYSIS_W1_10.md): loaded only when the tab is opened. undefined = not loaded, null = unavailable. */
let analysisPromise = null;
export function ensureAnalysis() {
  if (!analysisPromise) analysisPromise = loadJson("analysis.json").then((d) => { S.analysis = d; emit(); }).catch(() => { S.analysis = null; analysisPromise = null; emit(); });
  return analysisPromise;
}
let extrasPromise = null;
export function ensureExtras() {
  if (!extrasPromise) extrasPromise = (async () => {
    const [tds, weekly, played, recon, defenders, grades] = await Promise.all(
      ["touchdowns", "weekly", "played", "reconciliation", "defenders", "grades"].map((n) => loadJson(n + ".json").catch(() => null)));
    Object.assign(S, { tds: tds || [], weekly: weekly || [], played: played || {}, recon: recon || {}, defenders, grades, extrasLoaded: true });
    if (grades && grades.market && S.validation) S.validation = { ...S.validation, clv_n: grades.market.n };
    emit();
  })();
  return extrasPromise;
}
export async function loadData() {
  try {
    // what This Week needs first; the touchdown history loads right after, in the background
    const [meta, games, slate, validation] = await Promise.all(["meta", "games", "slate", "validation"].map((n) => loadJson(n + ".json")));
    Object.assign(S, { meta, games, slate, validation });
    S.gameById = Object.fromEntries(games.map((g) => [g.game_id, g]));
    emit();
    // the touchdown history, results and grades load once a screen needs them, or after the first screen settles
    setTimeout(ensureExtras, 2500);
  } catch (e) {
    S.loadError = String(e);
  }
  emit();
}

export async function connect() {
  if (!window.claude || !window.claude.use) { S.dbState = "off"; emit(); return; }
  const timer = setTimeout(() => { if (S.dbState === "connecting") { S.dbState = "slow"; emit(); } }, 10000);
  const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
  S.db = db; S.user = user;
  if (user) {
    S.uid = await user.id();
    S.isAdmin = (await user.canEdit()) === true;
    S.canWrite = (await user.can("data.write")) !== false;
  }
  if (!db) { clearTimeout(timer); S.dbState = "off"; emit(); return; }
  const ok = () => { clearTimeout(timer); S.dbState = "ok"; };
  const fail = (e) => { clearTimeout(timer); S.dbState = "error"; console.warn(e); emit(); };
  db.collection("picks").onSnapshot((s) => {
    S.allPicks = Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
    if (!s.metadata.fromCache) ok();
    resolveNames(); emit();
  }, fail);
  db.collection("odds").onSnapshot((s) => { S.odds = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); emit(); }, fail);
  db.collection("locks").onSnapshot((s) => { S.locks = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); emit(); }, fail);
  // shared lines: one marker doc per uploader, their rows for each week in a subcollection
  // A week is stored in up to LINE_PARTS documents (w10, w10_p2, ...) because one document holds at most 256 KB.
  const lineSubs = {}; const parts = {};
  db.collection("lines").onSnapshot((s) => {
    s.docs.forEach((d) => {
      if (lineSubs[d.id] || !S.slate) return;
      lineSubs[d.id] = true; parts[d.id] = [];
      for (let i = 0; i < LINE_PARTS; i++) {
        db.doc(`lines/${d.id}/weeks/${linePartId(S.slate.week, i)}`).onSnapshot((w) => {
          parts[d.id][i] = w.exists ? (w.data().rows || []) : [];
          S.lines[d.id] = dedupeLines(parts[d.id].flat()); emit();
        }, () => {});
      }
    });
  }, fail);
  db.collection("parlays").onSnapshot((s) => { S.parlaysAll = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); resolveNames(); emit(); }, fail);
  db.collection("refs").onSnapshot((s) => { S.refs = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); resolveNames(); emit(); }, fail);
  db.collection("overrides").onSnapshot((s) => { S.overrides = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); emit(); }, fail);
  db.collection("reviews").onSnapshot((s) => { S.reviews = Object.fromEntries(s.docs.map((d) => [d.id.replace("~", ":"), d.data()])); emit(); }, fail);
  window.claude.use("downloads").then((d) => { S.downloads = d; });
  if (S.isAdmin) window.claude.use("sample").then((s) => { S.sample = s; emit(); });
  emit();
}

async function resolveNames() {
  if (!S.user) return;
  const ids = [...new Set([...Object.keys(S.allPicks), ...Object.keys(S.parlaysAll), ...Object.keys(S.lines)])];
  if (S.uid) ids.push(S.uid);
  try { S.names = await S.user.profiles(ids); emit(); } catch (e) { /* names are optional */ }
}

export const nameOf = (uid) => (S.names[uid] && S.names[uid].name) || (uid === S.uid ? "You" : "Member");
export const effAttr = (t) => {
  const r = S.reviews[t.key];
  return r ? { ...t.attribution, status: r.status, defenders: r.defenders || [], missing: r.missing || t.attribution.missing, reviewed: r } : t.attribution;
};
/* Referee assignments: admin uploads per week {games: {game_id: {referee, by, at}}}; falls back to the NFL data. */
export function refFor(g) {
  const w = S.slate && S.refs["w" + S.slate.week]; const up = w && w.games && w.games[g.game_id];
  if (up && up.referee) return { name: up.referee, source: "upload", by: up.by, at: up.at };
  return g.referee ? { name: g.referee, source: "nflverse" } : null;
}
export function crewIndex(name) { const R = S.slate && S.slate.referees; return (R && name && R.crews[name]) || null; }
export async function setReferees(map) {
  if (!S.isAdmin) { toast("Only admins can set referee assignments."); return false; }
  const id = "w" + S.slate.week; const cur = structuredClone(S.refs[id] || { games: {} }); const at = new Date().toISOString();
  Object.entries(map).forEach(([gid, name]) => { if (name) cur.games[gid] = { referee: name.trim(), by: S.uid, at }; else delete cur.games[gid]; });
  try { await S.db.doc("refs/" + id).set(cur); toast(`Saved ${Object.keys(map).length} referee assignment${Object.keys(map).length > 1 ? "s" : ""}.`); return true; }
  catch (e) { toast("Couldn't save the referee assignments."); return false; }
}
/* "BUF at NYJ: Shawn Hochuli", "BUF@NYJ Shawn Hochuli", or "NYJ - Shawn Hochuli" (either team) */
export function parseRefText(text, games) {
  const out = {}; const miss = [];
  text.split(/\n/).map((l) => l.trim()).filter(Boolean).forEach((l) => {
    const teams = (l.toUpperCase().match(/\b[A-Z]{2,3}\b/g) || []);
    const g = games.find((x) => teams.includes(x.away) || teams.includes(x.home));
    const name = l.replace(/\b[A-Z]{2,3}\b/g, " ").replace(/\b(at|vs\.?)\b/gi, " ").replace(/[@:\-–|,]/g, " ").replace(/\s+/g, " ").trim();
    if (g && name.length > 3) out[g.game_id] = name; else miss.push(l);
  });
  return { map: out, miss };
}

/* Admin player-status overrides for the slate week: {gsis_id: {status, note, at}} */
export const overrideFor = (gsis) => { const w = S.slate && S.overrides["w" + S.slate.week]; return (w && w.players && w.players[gsis]) || null; };
export function effCand(c) {
  const o = overrideFor(c.gsis_id);
  if (!o) return c;
  const out = o.status === "Clear" ? {} : { injury: o.status, quality: ["Out", "Doubtful", "Not on roster", "Inactive"].includes(o.status) ? "unavailable" : c.quality };
  return { ...c, ...out, override: o };
}
export const slateCands = () => (S.slate ? S.slate.games.flatMap((g) => g.teams.flatMap((t) => t.candidates)) : []);
export const myItems = () => (S.allPicks[S.uid] && S.allPicks[S.uid].items) || {};
const liveOddsRows = (week) => { const d = S.odds["w" + week]; return d && d.status === "live" ? (d.rows || []).map((r) => ({ ...r, uploaded_by: d.reviewed_by || d.imported_by })) : []; };
/* Every live price row for the slate week: admin imports plus everyone's uploads. */
/* A row saved without a player match (e.g. a screenshot that wrote the Rams as "LAR" before team codes were translated)
   is matched again when read, using the current rules. Nothing is written back; a row only matches a game it was
   captured before the kickoff of. */
let rematchCache = { key: null, map: new Map() };
function rematch(r) {
  if (r.gsis_id || !S.slate) return r;
  if (rematchCache.key !== S.slate) rematchCache = { key: S.slate, map: new Map() };
  const k = `${r.player}|${r.team}`; let m = rematchCache.map.get(k);
  if (m === undefined) { m = FB.matchOdds(r, slateCands()) || null; rematchCache.map.set(k, m); }
  if (!m) return r;
  const g = S.gameById[m.game_id]; const t = Date.parse(r.captured_at);
  if (!g || !isFinite(t) || t >= FB.etToUtcMs(g.kickoff_et)) return r;
  return { ...r, gsis_id: m.gsis_id, game_id: m.game_id, team: m.team, player: m.full_name || m.player, matched_on_read: true };
}
export function allLineRows(week) {
  const up = S.slate && week === S.slate.week ? Object.entries(S.lines).flatMap(([uid, rows]) => rows.map((r) => rematch({ ...r, uploaded_by: uid }))) : [];
  return liveOddsRows(week).concat(up);
}
/* Best price across books (fresh = captured in the last 2 hours); stale fallback is flagged. */
export function priceFor(c, week, market = "anytime_td") {
  const rows = allLineRows(week).filter((r) => r.gsis_id === c.gsis_id && (r.market || "anytime_td") === market);
  return FB.bestPrice(rows, Date.now());
}
/* Weekly Rankings for the selected market: every available player in games still open (Out/inactive players are left
   out, as on the matchup list), with that market's model chance and that player's uploaded prices. */
export function weekRankings(market = S.weekMarket, nowMs = Date.now()) {
  if (!S.slate) return null;
  const byPid = {};
  allLineRows(S.slate.week).forEach((r) => { if (r.gsis_id && (r.market || "anytime_td") === market) (byPid[r.gsis_id] = byPid[r.gsis_id] || []).push(r); });
  const items = [];
  for (const g of S.slate.games) {
    if (FB.isLocked(g, nowMs)) continue;
    for (const t of g.teams) for (const c0 of t.candidates) {
      const c = effCand(c0); if (c.quality === "unavailable") continue;
      items.push({ key: c.gsis_id, name: c.full_name || c.player, chance: chanceFor(c, market), prices: byPid[c.gsis_id] || [], c, g });
    }
  }
  return FB.weeklyRankings(items, nowMs);
}
/* Every book's latest price for a player and market (best payout first, ages shown), and this week's line moves. */
export function boardFor(c, week, market = "anytime_td") {
  return FB.bookBoard(allLineRows(week).filter((r) => r.gsis_id === c.gsis_id && (r.market || "anytime_td") === market), Date.now());
}
export function weekMoves(week) { return FB.lineMoves(allLineRows(week), Date.now()); }
/* Results dashboard rows: one per SUBMITTED pick (drafts are counted separately, parlays and backtests are not included).
   state = the app's own settlement (settlePick); tds = qualifying TDs credited to the player in that game from the reconciled
   touchdown log (rushing, receiving and return TDs; a QB's TD passes are credited to the receiver); null until final and loaded. */
export function resultRows() {
  const rows = []; let drafts = 0;
  for (const [uid, d] of Object.entries(S.allPicks)) {
    for (const p of Object.values(d.items || {})) {
      if (p.status !== "submitted") { drafts++; continue; }
      const g = S.gameById[p.game_id] || {};
      const final = g.status === "final";
      const r = settlePick(uid, p);
      const tds = final && S.extrasLoaded ? S.tds.filter((t) => t.game_id === p.game_id && t.scorer_id === p.gsis_id).length : null;
      rows.push({ season: +String(p.game_id).slice(0, 4) || (S.meta && S.meta.season), week: p.week, game_id: p.game_id, kickoff_ms: FB.etToUtcMs(g.kickoff_et),
        matchup: g.away ? `${g.away} at ${g.home}` : p.game_id, uid, gsis_id: p.gsis_id, player: p.player, team: p.team, pos: p.pos, market: p.market || "anytime_td",
        p: typeof p.model_p === "number" ? p.model_p : null, model_version: p.model_version || null, submitted_at: p.submitted_at || null,
        price: p.price || null, above_fair: typeof p.above_fair === "boolean" ? p.above_fair : null, state: r.state, why: r.why, tds, game_final: final });
    }
  }
  return { rows, drafts };
}
export function settlePick(uid, p) {
  const g = S.gameById[p.game_id];
  const lock = S.locks[p.game_id] && S.locks[p.game_id].picks ? S.locks[p.game_id].picks[uid] || {} : undefined;
  const r = FB.settle(p, g, S.tds.filter((t) => t.game_id === p.game_id), S.played[p.game_id], lock, Date.now());
  const held = S.locks[p.game_id] && S.locks[p.game_id].review && S.locks[p.game_id].review[uid] && S.locks[p.game_id].review[uid][p.key];
  return held && r.state === "needs_review" ? { ...r, why: held } : r;
}

/* ---------- writes ---------- */
let toastFn = () => {};
export const setToast = (f) => { toastFn = f; };
export const toast = (m, action) => toastFn(m, action);
let writing = false;

async function savePicks(items) {
  if (writing) { toast("Still saving the last change. Try again in a moment."); return false; }
  writing = true;
  try { await S.db.doc("picks/" + S.uid).set({ items, updated_at: new Date().toISOString() }); return true; }
  catch (e) {
    toast(e && e.code === "invalid_argument" ? "You can view the board but not save picks. Ask the owner for access." : "Couldn't save. Check your connection and try again.");
    return false;
  } finally { writing = false; }
}
/* What a pick or parlay leg records about the price at the moment it was made. A copy, so later uploads never change it. */
export function priceRecord(pr, market = "anytime_td") {
  if (!pr) return null;
  return { american: pr.american, book: pr.book, market, captured_at: pr.captured_at, time_source: pr.time_source || null,
    stale: !FB.priceFresh(pr, Date.now()), recorded_at: new Date().toISOString() };
}
function priceSnapshot(pr, stage, market = "anytime_td") {
  if (!pr) return { price: null, price_warning: `No uploaded price at ${stage}.` };
  const rec = priceRecord(pr, market);
  return { price: rec, price_warning: rec.stale ? `Price was over ${FB.PRICE_FRESH_MIN / 60} hours old at ${stage}; it may not have been available.` : null };
}
export async function addPick(c, market = S.weekMarket) {
  const g = S.gameById[c.game_id]; const week = g.week;
  const items = structuredClone(myItems());
  const pick = { week, game_id: c.game_id, gsis_id: c.gsis_id, player: c.full_name || c.player, team: c.team, pos: c.pos, market };
  const errs = FB.validatePick(items, pick, g, Date.now());
  if (errs.length) { toast(errs[0]); return; }
  const now = new Date().toISOString();
  const two = market === "2plus_td"; const board = boardFor(c, week, market);
  Object.assign(pick, { key: FB.pickKey(week, c.gsis_id, market), status: "submitted", model_p: chanceFor(c, market), model_version: S.slate.model_version,
    ...(two ? { model_p_note: "2+ TD chance estimated from the anytime chance (Poisson)" } : {}),
    // the "Above fair" marker as it stood at pick time, judged on the best FRESH anytime price (the one the marker uses):
    // true / false when a fresh price existed, null otherwise (2+ TDs, or no price under 2 hours old)
    ...(() => {
      const fresh = !two && board ? board.books.find((x) => x.fresh) : null;
      if (!fresh) return { above_fair: null };
      const m = FB.aboveFair(c.p, fresh, Date.now());
      return { above_fair: !!m, above_fair_price: { book: fresh.book, american: fresh.american, captured_at: fresh.captured_at, pts: m ? m.pts : null } };
    })(),
    saved_at: now, submitted_at: now }, priceSnapshot(board && board.best, "submission", market));
  items[pick.key] = pick;
  if (await savePicks(items)) toast(`Picked ${pick.player}${two ? " for 2+ TDs" : ""}. Locks at kickoff.`, { label: "Undo", run: () => removePick(pick.key) });
}
export async function removePick(key) {
  const items = structuredClone(myItems()); const p = items[key]; if (!p) return;
  if (FB.isLocked(S.gameById[p.game_id], Date.now())) { toast("This game has kicked off. The pick is locked."); return; }
  delete items[key];
  if (await savePicks(items)) toast(`Removed ${p.player}.`);
}
export const markInactive = (c) => setOverride(c.gsis_id, c.full_name || c.player, c.team, "Inactive", "Game-day inactive");
/* Match one of my uploaded rows that no player matched */
export async function matchLine(row, c) {
  const why = FB.lineProblem(row, S.gameById[c.game_id], Date.now());
  if (why) { toast(`Can't match: ${why}.`); return; }
  const week = S.slate.week; const rows = (S.lines[S.uid] || []).map((r) => (r === row || (r.player === row.player && r.book === row.book && r.market === row.market && !r.gsis_id))
    ? { ...r, gsis_id: c.gsis_id, player: c.full_name || c.player, team: c.team, matched_by_hand: true } : r);
  try { await saveLineRows(S.uid, rows); toast(`Matched to ${c.full_name || c.player}.`); }
  catch (e) { toast("Couldn't save the match."); }
}
export async function setOverride(gsis, name, team, status, note) {
  const id = "w" + S.slate.week; const cur = structuredClone(S.overrides[id] || { players: {} });
  if (status === "Clear") delete cur.players[gsis];
  else cur.players[gsis] = { status, note: note || "", player: name, team, at: new Date().toISOString(), by: S.uid };
  try { await S.db.doc("overrides/" + id).set(cur); toast(status === "Clear" ? `Cleared ${name}.` : `${name} marked ${status}.`); }
  catch (e) { toast("Couldn't save the player status."); }
}
export async function setPickStatus(key, status) {
  const items = structuredClone(myItems()); const p = items[key]; if (!p) return;
  if (FB.isLocked(S.gameById[p.game_id], Date.now())) { toast("This game has kicked off. The pick is locked."); return; }
  if (status === "remove") delete items[key];
  else {
    p.status = status;
    if (status === "submitted") {
      p.submitted_at = new Date().toISOString();
      const c = slateCands().find((x) => x.gsis_id === p.gsis_id);
      Object.assign(p, priceSnapshot(c && priceFor(c, p.week), "submission"));
    }
  }
  if (await savePicks(items)) toast(status === "remove" ? "Removed." : status === "submitted" ? "Submitted. It locks at kickoff." : "Moved back to draft.");
}

/* ---------- admin ---------- */
export function parseOddsCsv(text) {
  return text.split(/\n/).map((l) => l.trim()).filter((l) => l && !/^player\s*,/i.test(l)).map((l) => {
    const [player, team, book, american, captured_at] = l.split(",").map((s) => s.trim());
    return { player, team: (team || "").toUpperCase(), book, american: Number(String(american).replace("+", "")),
      captured_at: captured_at || new Date().toISOString(), market: "anytime_td" };
  }).filter((r) => r.player && isFinite(r.american) && Math.abs(r.american) >= 100);
}
export async function stageOdds(rows, source) {
  if (!rows.length) { toast("No valid rows. Each needs a player and an American price like +180."); return; }
  const cands = slateCands();
  rows.forEach((r) => { const m = FB.matchOdds(r, cands); r.gsis_id = m ? m.gsis_id : null; if (m && !r.team) r.team = m.team; });
  try {
    await S.db.doc("odds/w" + S.slate.week).set({ rows, status: "pending", source, imported_at: new Date().toISOString(), imported_by: S.uid });
    toast(`Staged ${rows.length} rows for review.`);
  } catch (e) { toast("Couldn't stage the rows."); }
}
export async function setOddsStatus(status) {
  const d = structuredClone(S.odds["w" + S.slate.week]);
  Object.assign(d, { status, reviewed_at: new Date().toISOString(), reviewed_by: S.uid });
  try { await S.db.doc("odds/w" + S.slate.week).set(d); toast(status === "live" ? "Prices are live." : "Prices withdrawn."); }
  catch (e) { toast("Couldn't update."); }
}
export async function readShot(file, book) {
  if (!file || !S.sample) return;
  toast("Reading the screenshot…");
  try {
    const rows = await S.sample.json(
      "Read this sportsbook screenshot of NFL Anytime Touchdown Scorer odds. Return a JSON array of objects {player, team, american} for every Anytime TD price visible. team is the NFL abbreviation if shown, else empty. american is a number like 180 or -120. Skip First TD, 2+ TD and any other market. Return only the array.",
      { images: [file] });
    stageOdds((rows || []).map((r) => ({ player: r.player, team: (r.team || "").toUpperCase(), american: Number(r.american), book: book || "Screenshot",
      captured_at: new Date(file.lastModified || Date.now()).toISOString(), market: "anytime_td" })).filter((r) => r.player && isFinite(r.american)), "screenshot");
  } catch (e) { toast(e && e.code === "not_granted" ? "Screenshot reading was declined." : "Couldn't read that screenshot. Paste CSV instead."); }
}
export async function freeze(games) {
  for (const g of games) {
    if (S.locks[g.game_id]) continue; // existing snapshots are never rewritten
    const picks = {}; const review = {};
    for (const [uid, d] of Object.entries(S.allPicks)) {
      const sub = Object.values(d.items || {}).filter((p) => p.game_id === g.game_id && p.status === "submitted");
      const ok = sub.filter((p) => FB.snapshotEligibility(p, g).ok);
      if (ok.length) picks[uid] = Object.fromEntries(ok.map((p) => [p.key, { gsis_id: p.gsis_id, status: p.status, price: p.price || null }]));
      const held = sub.filter((p) => !FB.snapshotEligibility(p, g).ok);
      if (held.length) review[uid] = Object.fromEntries(held.map((p) => [p.key, FB.snapshotEligibility(p, g).why]));
    }
    const parlays = {};
    for (const [uid, d] of Object.entries(S.parlaysAll)) {
      for (const par of Object.values(d.items || {})) {
        const first = par.legs.map((l) => S.gameById[l.game_id]).filter(Boolean).sort((a, b) => FB.etToUtcMs(a.kickoff_et) - FB.etToUtcMs(b.kickoff_et))[0];
        if (first && first.game_id === g.game_id) (parlays[uid] ||= {})[par.id] = par.legs.map((l) => l.gsis_id);
      }
    }
    try { await S.db.doc("locks/" + g.game_id).set({ frozen_at: new Date().toISOString(), by: "admin page", picks, review, parlays }); }
    catch (e) { toast("Couldn't snapshot " + g.game_id); return; }
  }
  toast("Snapshots saved.");
}
export async function saveReview(t, body) {
  const prev = S.reviews[t.key];
  const history = prev && prev.history ? prev.history.slice() : [];
  history.push({ at: new Date().toISOString(), by: S.uid, status: prev ? prev.status : t.attribution.status, note: prev ? prev.note : "original automated attribution" });
  try {
    await S.db.doc("reviews/" + t.key.replace(":", "~")).set({ ...body, updated_at: new Date().toISOString(), by: S.uid, history: history.slice(-50) });
    toast("Saved the review."); return true;
  } catch (e) { toast("Couldn't save the review."); return false; }
}
export async function exportCsv(rows) {
  const text = FB.csv(rows, [
    { label: "week", get: (t) => t.week }, { label: "game_id", get: (t) => t.game_id }, { label: "play_id", get: (t) => t.play_id },
    { label: "quarter", get: (t) => t.qtr }, { label: "clock", get: (t) => t.clock }, { label: "scoring_team", get: (t) => t.team },
    { label: "opponent", get: (t) => t.opp }, { label: "scorer", get: (t) => t.scorer }, { label: "scorer_id", get: (t) => t.scorer_id },
    { label: "passer", get: (t) => t.passer }, { label: "type", get: (t) => t.type }, { label: "unit", get: (t) => t.unit },
    { label: "yards", get: (t) => t.yards }, { label: "review_status", get: (t) => effAttr(t).status },
    { label: "defenders", get: (t) => (effAttr(t).defenders || []).map((d) => `${d.name} (${d.role})`).join("; ") },
    { label: "missing_evidence", get: (t) => effAttr(t).missing }, { label: "source", get: (t) => t.source },
    { label: "reconciled", get: (t) => t.reconciled }, { label: "last_verified", get: (t) => t.verified_at }, { label: "description", get: (t) => t.desc },
  ]);
  if (S.downloads) {
    try { await S.downloads.save({ filename: "touchdowns-2026.csv", data: new Blob([text], { type: "text/csv" }) }); return null; }
    catch (e) { if (e && e.code === "declined") return null; }
  }
  return text; // caller shows a copy dialog
}

/* ---------- lines (anyone signed in can upload) ---------- */
export const MARKETS = { anytime_td: "Anytime TD", "2plus_td": "2+ TDs" };
export const normMarket = FB.normMarket;
/* rows plus .skipped [{line, why}] so the upload message can say what was left out */
export function parseLinesCsv(text) { const r = FB.parseLines(text); const rows = r.rows; rows.skipped = r.skipped; return rows; }
/* ---------- saved prices: split across documents ---------- */
export const LINE_PARTS = 6, LINE_PART_ROWS = 400, LINE_MAX_ROWS = LINE_PARTS * LINE_PART_ROWS; // 400 rows ≈ 160 KB per document
export const linePartId = (week, i) => (i === 0 ? `w${week}` : `w${week}_p${i + 1}`);
const lineKey = (r) => `${r.gsis_id || r.player}|${r.book}|${r.market}`;
function dedupeLines(rows) {
  const m = new Map();
  rows.forEach((r) => { const k = lineKey(r); const cur = m.get(k); if (!cur || Date.parse(r.captured_at) > Date.parse(cur.captured_at)) m.set(k, r); });
  return [...m.values()];
}
/* Write one uploader's week across the part documents. Over the limit, prices for games that have started go first
   (oldest first), then unmatched rows; prices for games still to come are never dropped: the save is refused instead. */
async function saveLineRows(uid, rows) {
  const week = S.slate.week; let all = dedupeLines(rows); let dropped = 0;
  if (all.length > LINE_MAX_ROWS) {
    const started = (r) => r.game_id && S.gameById[r.game_id] && FB.isLocked(S.gameById[r.game_id], Date.now());
    const rank = (r) => (started(r) ? 0 : !r.gsis_id ? 1 : 2);
    const order = all.map((r, i) => [rank(r), Date.parse(r.captured_at) || 0, i]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const need = all.length - LINE_MAX_ROWS; const removable = order.filter((o) => o[0] < 2).slice(0, need).map((o) => o[2]);
    if (removable.length < need) throw Object.assign(new Error("too_many"), { code: "too_many" });
    const gone = new Set(removable); all = all.filter((_, i) => !gone.has(i)); dropped = gone.size;
  }
  const now = new Date().toISOString();
  for (let i = 0; i < LINE_PARTS; i++) {
    const chunk = all.slice(i * LINE_PART_ROWS, (i + 1) * LINE_PART_ROWS);
    const had = i === 0 || ((S.lines[uid] || []).length > i * LINE_PART_ROWS) || chunk.length;
    if (had) await S.db.doc(`lines/${uid}/weeks/${linePartId(week, i)}`).set({ rows: chunk, part: i + 1, updated_at: now });
  }
  return dropped;
}
export async function uploadLines(rows, source) {
  if (!S.uid || !S.db) { toast("Sign in to Claude to upload lines."); return false; }
  const skipped = [...(rows.skipped || [])];
  rows = rows.filter((r) => { const ok = r.player && r.market && isFinite(r.american) && Math.abs(r.american) >= 100; if (!ok) skipped.push({ line: `${r.player || "?"} ${r.american}`, why: "missing player, market or valid price" }); return ok; });
  if (!rows.length) { S.lastSkipped = skipped; emit(); toast(skipped.length ? `Nothing saved: ${skipped.length} row(s) skipped (see list).` : "No usable prices found. Each needs a player and a price like +180."); return false; }
  const cands = slateCands(); const now = new Date().toISOString();
  rows = rows.map((r) => { const m = FB.matchOdds(r, cands); return { ...r, gsis_id: m ? m.gsis_id : null, game_id: m ? m.game_id : null, team: m ? m.team : FB.normTeam(r.team), player: m ? (m.full_name || m.player) : r.player, source, uploaded_at: now }; });
  rows = rows.filter((r) => { const why = FB.lineProblem(r, r.game_id ? S.gameById[r.game_id] : null, Date.now()); if (why) skipped.push({ line: `${r.player} ${r.book} ${r.american}`, why }); return !why; });
  if (!rows.length) { toast(skipped.length ? `Nothing saved. ${skipped.length} skipped: ${skipped[0].why}.` : "No usable prices found."); return false; }
  const week = S.slate.week; const key = (r) => `${r.gsis_id || r.player}|${r.book}|${r.market}`;
  const merged = Object.fromEntries((S.lines[S.uid] || []).map((r) => [key(r), r]));
  // keep the newer OBSERVATION per player/book/market; an older screenshot never replaces a newer price
  let older = 0;
  rows.forEach((r) => {
    const cur = merged[key(r)];
    if (cur && Date.parse(cur.captured_at) > Date.parse(r.captured_at)) {
      older++; // an older screenshot never replaces a newer price, but it can be an earlier opening price
      const openMs = Date.parse(cur.open_captured_at || cur.captured_at);
      if (Date.parse(r.captured_at) < openMs) merged[key(r)] = { ...cur, open_american: r.american, open_captured_at: r.captured_at };
      return;
    }
    // keep the first price seen from this book this week, so line moves can be shown after it is replaced
    merged[key(r)] = cur ? { ...r, open_american: cur.open_american ?? cur.american, open_captured_at: cur.open_captured_at || cur.captured_at } : r;
  });
  if (older) skipped.push({ line: `${older} price(s)`, why: "a newer price from the same book was already uploaded" });
  try {
    await S.db.doc(`lines/${S.uid}`).set({ updated_at: now });
    const dropped = await saveLineRows(S.uid, Object.values(merged));
    if (dropped) skipped.push({ line: `${dropped} older price(s)`, why: "removed to make room: games already started or unmatched rows" });
    const un = rows.filter((r) => !r.gsis_id).length;
    S.lastSkipped = skipped; emit();
    toast(`Added ${rows.length} price${rows.length > 1 ? "s" : ""}${un ? ` (${un} couldn't be matched to a player)` : ""}${skipped.length ? `; skipped ${skipped.length} (see list)` : ""}. Live for everyone now.`);
    return true;
  } catch (e) { toast(e && e.code === "too_many" ? `Not saved: over ${LINE_MAX_ROWS.toLocaleString()} prices this week for games that haven't started. Remove some on the Uploads tab first.` : e && e.code === "invalid_argument" ? "Your access is view-only, so lines can't be saved." : "Couldn't save the lines."); return false; }
}
export async function deleteLines(uid, filter) {
  const week = S.slate.week; const rows = (S.lines[uid] || []).filter((r) => !filter(r));
  try { await saveLineRows(uid, rows); toast("Removed."); }
  catch (e) { toast("Couldn't remove those lines."); }
}
export function setShotReview(rows) { S.shotReview = rows; emit(); }
export function clearSkipped() { S.lastSkipped = null; emit(); }
/* Reset the Uploads screen: drops an unconfirmed screenshot review and messages. Saved prices are not touched. */
export function resetUploadScreen() { S.shotReview = null; S.lastSkipped = null; S.shotProgress = null; emit(); }
export async function confirmShot() {
  const rows = (S.shotReview || []).map((r) => ({ ...r, american: FB.parseAmerican(r.raw ?? r.american) })).filter((r) => r.player && isFinite(r.american));
  const bad = (S.shotReview || []).length - rows.length;
  const r2 = rows.map(({ id, raw, shot, shot_name, ...r }) => r); r2.skipped = bad ? [{ line: `${bad} row(s)`, why: "missing player or invalid price" }] : [];
  if (await uploadLines(r2, "screenshot")) { S.shotReview = null; emit(); }
}
export const MAX_SHOTS = 10;
const SHOT_PROMPT = "Read this sportsbook screenshot of NFL player touchdown odds. Return a JSON array of objects {player, team, market, american} for every price visible in these markets only: Anytime Touchdown Scorer (market \"anytime\") and 2+ Touchdowns / To Score 2 or More (market \"2+\"). team is the NFL abbreviation if shown, else empty. american is a number like 180 or -120. Skip First TD, Last TD and every other market. Return only the array.";
/* The reader is asked for a JSON array, but accept an object that wraps one (e.g. {"prices": [...]}) instead of failing. */
export function pricesFromJson(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const k of ["prices", "rows", "odds", "players", "data", "results"]) if (Array.isArray(v[k])) return v[k];
    const arr = Object.values(v).find(Array.isArray);
    if (arr) return arr;
    if (v.player) return [v];
  }
  return [];
}
/* Plain-language reason for each failure code from the screenshot reader (code shown for troubleshooting). */
export function shotErrorMessage(e, name) {
  const code = (e && e.code) || "error";
  const m = {
    image_rejected: `${name} wasn't accepted: use a PNG or JPEG screenshot under 20 MB (iPhone camera photos saved as HEIC aren't supported)`,
    images_unavailable: "image reading isn't enabled for you on this page. Reload the app and allow it to send images to Claude when asked",
    not_declared: "image reading isn't enabled for this page",
    sampling_disabled: "Claude features are turned off for this account or organization",
    capability_disabled: "screenshot reading is turned off for this page",
    capability_removed: "screenshot reading was removed from this page; reload",
    session_expired: "your session expired; reload the page and try again",
    rate_limited: "too many requests right now; wait a minute and try again",
    queue_overflow: "too many requests right now; wait a minute and try again",
    not_granted: "screenshot reading was declined",
  }[code];
  return m || `couldn't read prices from ${name}`;
}

/* Read one or more screenshots (one at a time) and stage every price for review; nothing goes live until confirmed.
   Rows from additional screenshots are added to any review already open. */
export async function readLinesShots(files, book) {
  files = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith("image/"));
  if (!files.length) return;
  if (files.length > MAX_SHOTS) { toast(`Up to ${MAX_SHOTS} screenshots at a time; reading the first ${MAX_SHOTS}.`); files = files.slice(0, MAX_SHOTS); }
  const sample = S.sample || (window.claude && (await window.claude.use("sample")));
  if (!sample) { toast("Screenshot reading isn't available for your account on this page (people outside the owner's organization can't use it). Paste the prices instead."); return; }
  S.sample = sample;
  const lim = sample.limits ? await sample.limits().catch(() => null) : null;
  if (lim && !lim.images) { toast("Image reading isn't enabled for you on this page. Reload the app and allow it to send images to Claude when asked, or paste the prices."); return; }
  const types = (lim && lim.images && lim.images.mediaTypes) || ["image/jpeg", "image/png", "image/webp", "image/gif"];
  const maxBytes = (lim && lim.images && lim.images.maxInputBytes) || 20 * 1024 * 1024;
  const bad = files.filter((f) => (f.type && !types.includes(f.type)) || f.size > maxBytes); // empty type: let the reader decide
  files = files.filter((f) => !bad.includes(f));
  if (!files.length) { toast(`${bad.map((f) => f.name || "That image").join(", ")} can't be read: use a PNG or JPEG screenshot under ${Math.round(maxBytes / 1048576)} MB (HEIC photos aren't supported).`); return; }
  const staged = [...(S.shotReview || [])]; let nextId = staged.reduce((m, r) => Math.max(m, r.id + 1), 0);
  const shotBase = staged.reduce((m, r) => Math.max(m, r.shot || 0), 0); // keep numbering across batches added to one review
  const failed = []; let read = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    S.shotProgress = { done: i, total: files.length }; emit();
    toast(files.length > 1 ? `Reading screenshot ${i + 1} of ${files.length}…` : "Reading the screenshot…");
    try {
      const rows = pricesFromJson(await sample.json(SHOT_PROMPT, { images: [file] }));
      rows.filter((r) => r && typeof r === "object").forEach((r) => {
        staged.push({ id: nextId++, shot: shotBase + i + 1, shot_name: file.name || `Screenshot ${i + 1}`, player: String(r.player || ""), team: (r.team || "").toUpperCase(),
          market: normMarket(r.market) || "anytime_td", american: FB.parseAmerican(r.american), book: book || "Screenshot",
          captured_at: new Date(file.lastModified || Date.now()).toISOString(), time_source: file.lastModified ? "screenshot file time" : "upload time" });
        read++;
      });
    } catch (e) {
      const name = file.name || `Screenshot ${i + 1}`;
      const stop = ["not_granted", "images_unavailable", "not_declared", "sampling_disabled", "capability_disabled", "capability_removed", "session_expired", "rate_limited", "queue_overflow"].includes(e && e.code);
      if (stop) { S.shotProgress = null; S.shotReview = staged.length ? staged : null; emit(); toast(`Stopped: ${shotErrorMessage(e, name)}.${e && e.code ? ` (${e.code})` : ""}`); return; }
      failed.push(`${name} (${shotErrorMessage(e, name)}${e && e.code ? `; ${e.code}` : ""})`);
    }
  }
  // overlapping screenshots show the same price twice: keep one copy (the later file time)
  const byKey = {};
  staged.forEach((r) => { const k = `${r.player.toLowerCase()}|${r.market}|${r.american}|${r.book}`; if (!byKey[k] || Date.parse(r.captured_at) > Date.parse(byKey[k].captured_at)) byKey[k] = r; });
  const dupes = staged.length - Object.keys(byKey).length;
  S.shotReview = Object.values(byKey).sort((a, b) => a.id - b.id); S.shotProgress = null;
  if (!S.shotReview.length) S.shotReview = null;
  emit();
  const okShots = files.length - failed.length;
  const msg = okShots ? [`Read ${read} price${read === 1 ? "" : "s"} from ${okShots} screenshot${okShots === 1 ? "" : "s"}`] : ["Nothing was read"];
  if (dupes) msg.push(`${dupes} duplicate${dupes === 1 ? "" : "s"} merged`);
  if (failed.length) msg.push(`not read: ${failed.join("; ")}`);
  if (bad.length) msg.push(`skipped ${bad.map((f) => f.name || "an image").join(", ")} (use PNG or JPEG under ${Math.round(maxBytes / 1048576)} MB)`);
  toast(msg.join("; ") + (S.shotReview ? ". Check them below, then confirm." : "."));
}
export const readLinesShot = (file, book) => readLinesShots([file], book);

/* ---------- parlays ---------- */
const draftKey = "fb_parlay_draft";
try { S.draft = JSON.parse(localStorage.getItem(draftKey) || "[]"); } catch (e) { S.draft = []; }
const saveDraft = () => { try { localStorage.setItem(draftKey, JSON.stringify(S.draft)); } catch (e) {} emit(); };
export const myParlays = () => (S.parlaysAll[S.uid] && S.parlaysAll[S.uid].items) || {};
export function addLeg(c) {
  if (S.draft.some((l) => l.gsis_id === c.gsis_id)) { toast(`${c.full_name || c.player} is already in your parlay.`); return; }
  S.draft = S.draft.concat([{ gsis_id: c.gsis_id, player: c.full_name || c.player, team: c.team, pos: c.pos, game_id: c.game_id, p: c.p, p_matchup: c.p_matchup ?? null, matchup_pct: c.matchup_pct ?? null }]);
  saveDraft(); toast(`Added ${c.full_name || c.player} to your parlay (${S.draft.length} leg${S.draft.length > 1 ? "s" : ""}).`);
}
export const inDraft = (gsis) => S.draft.some((l) => l.gsis_id === gsis);
export function toggleLeg(c) { if (inDraft(c.gsis_id)) { removeLeg(c.gsis_id); toast(`Removed ${c.full_name || c.player} from your parlay.`); } else addLeg(c); }
export function removeLeg(gsis) { S.draft = S.draft.filter((l) => l.gsis_id !== gsis); saveDraft(); }
export function setDraft(legs) { S.draft = legs.map((c) => ({ gsis_id: c.gsis_id, player: c.full_name || c.player, team: c.team, pos: c.pos, game_id: c.game_id, p: c.p, p_matchup: c.p_matchup ?? null, matchup_pct: c.matchup_pct ?? null })); saveDraft(); }
export async function saveParlay(name) {
  if (!S.uid || !S.db) { toast("Sign in to Claude to save parlays."); return false; }
  const legs = S.draft.filter((l) => S.gameById[l.game_id]);
  if (legs.length < 2) { toast("A parlay needs at least 2 legs."); return false; }
  if (FB.parlayLocked(legs, S.gameById, Date.now())) { toast("One of these games has started. Remove it to save."); return false; }
  const id = "p" + Date.now().toString(36); const now = new Date().toISOString();
  const items = structuredClone(myParlays());
  items[id] = { id, name: name || `${legs.length}-leg parlay`, week: S.slate.week, status: "submitted", created_at: now,
    legs: legs.map((l) => ({ ...l, price: priceRecord(priceFor(l, S.slate.week)) })),
    model_p: FB.parlayChance(legs).p };
  try { await S.db.doc("parlays/" + S.uid).set({ items, updated_at: now }); S.draft = []; saveDraft(); toast("Parlay saved. It locks when its first game kicks off."); return true; }
  catch (e) { toast(e && e.code === "invalid_argument" ? "Your access is view-only, so parlays can't be saved." : "Couldn't save the parlay."); return false; }
}
export async function deleteParlay(id) {
  const items = structuredClone(myParlays()); const p = items[id]; if (!p) return;
  if (FB.parlayLocked(p.legs, S.gameById, Date.now())) { toast("This parlay is locked."); return; }
  delete items[id];
  try { await S.db.doc("parlays/" + S.uid).set({ items, updated_at: new Date().toISOString() }); toast("Parlay removed."); } catch (e) { toast("Couldn't remove it."); }
}
export function settleParlayFor(uid, par) {
  const legStates = par.legs.map((l) => {
    const g = S.gameById[l.game_id];
    return FB.settle({ key: "leg", gsis_id: l.gsis_id, status: "submitted" }, g, S.tds.filter((t) => t.game_id === l.game_id), S.played[l.game_id], { leg: { gsis_id: l.gsis_id, status: "submitted" } }, Date.now()).state;
  });
  const res = FB.settleParlay(legStates);
  if (FB.parlayLocked(par.legs, S.gameById, Date.now())) {
    const first = par.legs.map((l) => S.gameById[l.game_id]).filter(Boolean).sort((a, b) => FB.etToUtcMs(a.kickoff_et) - FB.etToUtcMs(b.kickoff_et))[0];
    const lock = first && S.locks[first.game_id];
    if (!lock) return { ...res, state: res.state === "pending" ? "pending" : "needs_review", why: "Waiting for the kickoff snapshot.", legStates };
    const frozen = lock.parlays && lock.parlays[uid] && lock.parlays[uid][par.id];
    if (!frozen || frozen.join(",") !== par.legs.map((l) => l.gsis_id).join(",")) return { state: "needs_review", why: "Not in the kickoff snapshot: changed after the first game started.", legStates };
  }
  return { ...res, legStates };
}
