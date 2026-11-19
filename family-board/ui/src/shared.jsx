import { Box, Button, Chip, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { FB, useStore, myItems, myGamePicks, myParlays, settlePick, settleParlayFor, gamePickRows } from "./store.js";

/* Pieces more than one tab uses: the week picker, the "jump to a day" links, and the list of my picks for the week. */

/* One week picker for every tab that has past weeks (Lines, TD Log, Research): newest week first, 44px buttons,
   scrolls sideways. `extra` adds a last button (TD Log's "All"). The chosen week is shared between tabs (store.viewWeek). */
export function WeekPicker({ weeks, value, onChange, current, extra }) {
  return (
    <Box sx={{ overflowX: "auto", maxWidth: "100%", pb: 0.5 }} data-testid="week-picker">
      <ToggleButtonGroup exclusive size="small" value={String(value)} onChange={(e, v) => { if (v) onChange(v === "all" ? "all" : +v); }} aria-label="Week"
        sx={{ "& .MuiToggleButton-root": { minHeight: 44, minWidth: 56, px: 1.25, flexShrink: 0, textTransform: "none", whiteSpace: "nowrap" } }}>
        {weeks.map((w) => <ToggleButton key={w} value={String(w)} aria-label={`Week ${w}${w === current ? " (this week)" : ""}`}>Wk {w}</ToggleButton>)}
        {extra ? <ToggleButton value={extra[0]}>{extra[1]}</ToggleButton> : null}
      </ToggleButtonGroup>
    </Box>
  );
}
/* The week a tab shows: the shared choice when that tab has it, otherwise the tab's own default. */
export const pickWeek = (weeks, shared, fallback) => (weeks.includes(shared) ? shared : fallback);

/* Thursday / Sunday early / Sunday late / Sunday night / Monday ... from the Eastern kickoff time. */
export function windowOf(g) {
  const d = new Date(g.kickoff_et.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const h = Number(g.kickoff_et.slice(11, 13));
  if (d !== "Sunday") return d;
  return h < 12 ? "Sunday morning" : h < 15 ? "Sunday early" : h < 19 ? "Sunday late" : "Sunday night";
}
export function byDay(games) {
  const groups = []; games.forEach((g) => { const w = windowOf(g); if (!groups.length || groups[groups.length - 1][0] !== w) groups.push([w, []]); groups[groups.length - 1][1].push(g); });
  return groups;
}
const SHORT = (label) => label.replace("Sunday ", "Sun ").replace("Thursday", "Thu").replace("Monday", "Mon").replace("Saturday", "Sat").replace("Friday", "Fri").replace("Tuesday", "Tue").replace("Wednesday", "Wed");
/* Links that jump to a day's games and stay at the top of the screen while the list scrolls. Each day's section has
   the id `${prefix}-${index}` and an h3 that takes focus (so a keyboard or screen reader lands on it). */
export function DayJump({ groups, prefix, end }) {
  const jump = (i) => { const el = document.getElementById(`${prefix}-${i}`); if (!el) return;
    el.scrollIntoView({ block: "start", behavior: window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const h = el.querySelector("h3"); if (h) h.focus({ preventScroll: true }); };
  if (groups.length < 2 && !end) return null;
  return (
    <Box component="nav" aria-label="Jump to a day" data-testid="day-jump" sx={{ position: "sticky", top: 0, zIndex: 3, bgcolor: "background.default", py: 0.75, display: "flex", alignItems: "center", gap: 1 }}>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", gap: 0.75, overflowX: "auto", py: 0.25 }}>
        {groups.length > 1 && groups.map(([label, gs], i) => (
          <Button key={label} variant="outlined" onClick={() => jump(i)} aria-label={`Jump to ${label}, ${gs.length} game${gs.length > 1 ? "s" : ""}`}
            sx={{ minHeight: 44, flexShrink: 0, px: 1.25, borderRadius: 6, bgcolor: "background.paper", whiteSpace: "nowrap", fontSize: 14 }}>{SHORT(label)} · {gs.length}</Button>))}
      </Box>
      {end}
    </Box>
  );
}
export const dayHeadingSx = { lineHeight: 1.6, fontWeight: 700, outline: "none" };

/* ---------- my picks for one week: touchdown picks, game picks and parlays in one list, in kickoff order ---------- */
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
export const gamePickText = (p) => (p.market === "ml" ? `${p.side === "home" ? p.home : p.away} to win` : p.market === "total" ? `${p.side === "over" ? "Over" : "Under"} ${p.line}` : `${p.side === "home" ? p.home : p.away} ${p.line > 0 ? "+" : ""}${p.line}`);
const STATE = { win: ["Won", "success"], loss: ["Lost", "error"], void: ["Void", "default"], push: ["Push", "default"], needs_review: ["In review", "warning"] };
export function useMyWeek(wk) {
  const S = useStore(); const now = Date.now();
  if (!S.uid) return { tdPicks: [], gPicks: [], parlays: [], rows: [] };
  const when = (g) => (g && g.kickoff_et ? ` · ${FB.fmtEt(FB.etToUtcMs(g.kickoff_et), { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "");
  const chip = (state, g) => (state && STATE[state] ? STATE[state] : g && g.kickoff_et && FB.isLocked(g, now) ? ["Locked", "default"] : ["Open", "primary"]);
  const tdPicks = Object.values(myItems()).filter((p) => p.week === wk && p.status === "submitted");
  const gPicks = Object.values(myGamePicks()).filter((p) => p.week === wk);
  const parlays = Object.values(myParlays()).filter((p) => p.week === wk);
  const graded = Object.fromEntries(gamePickRows(now).filter((r) => r.uid === S.uid).map((r) => [r.pick.key, r]));
  const rows = [
    ...tdPicks.map((p) => { const g = S.gameById[p.game_id] || {}; const r = settlePick(S.uid, p);
      return { key: p.key, kind: "td", k: FB.etToUtcMs(g.kickoff_et), text: p.player, sub: `${(p.market || "anytime_td") === "2plus_td" ? "2+ TDs" : "Anytime TD"}${g.away ? ` · ${g.away} at ${g.home}` : ""}${when(g)}`, chip: chip(r.state, g) }; }),
    ...gPicks.map((p) => { const g = S.gameById[p.game_id] || {}; const r = graded[p.key]; const st = r && r.started ? (r.state === "void" ? "void" : r.state) : null;
      return { key: p.key, kind: "game", k: FB.etToUtcMs(g.kickoff_et), text: gamePickText(p), sub: `Game pick · ${p.away} at ${p.home} · ${am(p.american)} ${p.book || ""}${when(g)}`, chip: st === "void" ? ["Not counted", "warning"] : chip(st, g) }; }),
    ...parlays.map((par) => { const ks = (par.legs || []).map((l) => FB.etToUtcMs((S.gameById[l.game_id] || {}).kickoff_et)).filter((x) => isFinite(x)); const first = ks.length ? Math.min(...ks) : Infinity;
      const r = settleParlayFor(S.uid, par); const locked = FB.parlayLocked(par.legs || [], S.gameById, now);
      return { key: "parlay_" + par.id, kind: "parlay", k: first, text: par.name || `${(par.legs || []).length}-leg parlay`, sub: `Parlay · ${(par.legs || []).length} legs${isFinite(first) ? ` · first game ${FB.fmtEt(first, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}`,
        chip: STATE[r.state] || (locked ? ["Locked", "default"] : ["Open", "primary"]) }; }),
  ].sort((a, b) => a.k - b.k);
  return { tdPicks, gPicks, parlays, rows };
}
export function MyWeekList({ rows, max = 99, label = "My picks this week" }) {
  const rowSx = { display: "flex", alignItems: "center", gap: 1, py: 0.75, borderTop: 1, borderColor: "divider", minHeight: 56 };
  return (
    <Box component="ul" aria-label={label} sx={{ m: 0, p: 0, listStyle: "none" }}>
      {rows.slice(0, max).map((m) => (
        <Box component="li" key={m.key} sx={rowSx} data-kind={m.kind}>
          <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontWeight: 600 }}>{m.text}</Typography><Typography variant="body2" color="text.secondary">{m.sub}</Typography></Box>
          <Chip size="small" color={m.chip[1]} variant={m.chip[0] === "Open" ? "outlined" : "filled"} label={m.chip[0]} title={m.chip[0] === "Open" ? "You can change this until kickoff" : undefined} />
        </Box>))}
      {rows.length > max && <Box component="li" sx={{ pt: 0.5 }}><Typography variant="body2" color="text.secondary">and {rows.length - max} more on My picks.</Typography></Box>}
    </Box>
  );
}
