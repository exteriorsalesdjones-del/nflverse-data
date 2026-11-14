// Shared state for the Family Board: season data files + the artifact database.
// A tiny external store so React views re-render on db snapshots.
import FB from "../../artifact/lib.js";
import { useSyncExternalStore } from "react";

export { FB };

const S = {
  meta: null, games: [], gameById: {}, tds: [], weekly: [], slate: null, validation: null, played: {}, recon: {},
  loadError: null,
  db: null, user: null, uid: null, canWrite: false, isAdmin: false, names: {},
  allPicks: {}, odds: {}, locks: {}, reviews: {}, dbState: "connecting", downloads: null, sample: null,
  version: 0,
};
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

export async function loadData() {
  try {
    const names = ["meta", "games", "touchdowns", "weekly", "slate", "validation", "played", "reconciliation"];
    const [meta, games, tds, weekly, slate, validation, played, recon] = await Promise.all(names.map((n) => loadJson(n + ".json")));
    Object.assign(S, { meta, games, tds, weekly, slate, validation, played, recon });
    S.defenders = await loadJson("defenders.json").catch(() => null);
    S.gameById = Object.fromEntries(games.map((g) => [g.game_id, g]));
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
  db.collection("reviews").onSnapshot((s) => { S.reviews = Object.fromEntries(s.docs.map((d) => [d.id.replace("~", ":"), d.data()])); emit(); }, fail);
  window.claude.use("downloads").then((d) => { S.downloads = d; });
  if (S.isAdmin) window.claude.use("sample").then((s) => { S.sample = s; emit(); });
  emit();
}

async function resolveNames() {
  if (!S.user) return;
  const ids = Object.keys(S.allPicks);
  if (S.uid) ids.push(S.uid);
  try { S.names = await S.user.profiles(ids); emit(); } catch (e) { /* names are optional */ }
}

export const nameOf = (uid) => (S.names[uid] && S.names[uid].name) || (uid === S.uid ? "You" : "Member");
export const effAttr = (t) => {
  const r = S.reviews[t.key];
  return r ? { ...t.attribution, status: r.status, defenders: r.defenders || [], missing: r.missing || t.attribution.missing, reviewed: r } : t.attribution;
};
export const slateCands = () => (S.slate ? S.slate.games.flatMap((g) => g.teams.flatMap((t) => t.candidates)) : []);
export const myItems = () => (S.allPicks[S.uid] && S.allPicks[S.uid].items) || {};
const liveOddsRows = (week) => { const d = S.odds["w" + week]; return d && d.status === "live" ? d.rows || [] : []; };
export function priceFor(c, week) {
  const rows = liveOddsRows(week).filter((r) => r.gsis_id === c.gsis_id && (r.market || "anytime_td") === "anytime_td");
  rows.sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
  return rows[0] || null;
}
export function settlePick(uid, p) {
  const g = S.gameById[p.game_id];
  const lock = S.locks[p.game_id] && S.locks[p.game_id].picks ? S.locks[p.game_id].picks[uid] || {} : undefined;
  return FB.settle(p, g, S.tds.filter((t) => t.game_id === p.game_id), S.played[p.game_id], lock, Date.now());
}

/* ---------- writes ---------- */
let toastFn = () => {};
export const setToast = (f) => { toastFn = f; };
export const toast = (m) => toastFn(m);
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
function priceSnapshot(pr, stage) {
  if (!pr) return { price: null, price_warning: `No live price at ${stage}.` };
  return { price: { american: pr.american, book: pr.book, market: "anytime_td", captured_at: pr.captured_at },
    price_warning: FB.priceFresh(pr, Date.now(), 120) ? null : `Price older than 2 hours at ${stage}.` };
}
export async function addPick(c) {
  const g = S.gameById[c.game_id]; const week = g.week;
  const items = structuredClone(myItems());
  const pick = { week, game_id: c.game_id, gsis_id: c.gsis_id, player: c.full_name || c.player, team: c.team, pos: c.pos, market: "anytime_td" };
  const errs = FB.validatePick(items, pick, g, Date.now());
  if (errs.length) { toast(errs[0]); return; }
  Object.assign(pick, { key: FB.pickKey(week, c.gsis_id), status: "draft", model_p: c.p, model_version: S.slate.model_version,
    saved_at: new Date().toISOString() }, priceSnapshot(priceFor(c, week), "save"));
  items[pick.key] = pick;
  if (await savePicks(items)) toast(`Saved ${pick.player}. Submit it from My Picks.`);
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
    if (S.locks[g.game_id]) continue;
    const picks = {};
    for (const [uid, d] of Object.entries(S.allPicks)) {
      const mine = Object.values(d.items || {}).filter((p) => p.game_id === g.game_id && p.status === "submitted");
      if (mine.length) picks[uid] = Object.fromEntries(mine.map((p) => [p.key, { gsis_id: p.gsis_id, status: p.status, price: p.price || null }]));
    }
    try { await S.db.doc("locks/" + g.game_id).set({ frozen_at: new Date().toISOString(), by: "admin page", picks }); }
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
