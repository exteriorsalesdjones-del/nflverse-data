import { useEffect, useState } from "react";
import { Box, Button, ButtonBase, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { FB, useStore, myItems, myGamePicks, myParlays, effCand, chanceFor, boardFor, weekMoves, settlePick, nameOf, focusGame } from "./store.js";
import { Icon, P } from "./icons.jsx";
import { PickButton, MoveTag, DbNote } from "./views.jsx";

/* Home: the week at a glance. Everything here is a summary of another page and links to it; nothing is decided here
   that isn't decided there (same chances, same prices, same settlement). */

const pct = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(0) + "%");
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
const kick = (g) => { const k = FB.etToUtcMs(g.kickoff_et); return isNaN(k) ? g.kickoff_et : FB.fmtEt(k, {}) + " ET"; };
const et = (iso, opts) => (iso ? FB.fmtEt(Date.parse(iso), { month: "short", day: "numeric", ...opts }) + " ET" : "—");
const go = (hash) => () => { location.hash = hash; };
const half = (x) => { const v = Math.round(Math.abs(x) * 2) / 2; return Number.isInteger(v) ? String(v) : v.toFixed(1); };
/* "1 day 3 h", "3 h 20 min", "12 min" */
export function until(ms) {
  if (!(ms > 0)) return "now"; const m = Math.max(1, Math.round(ms / 60000)); const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d} day${d > 1 ? "s" : ""}${h ? ` ${h} h` : ""}` : h ? `${h} h${mm ? ` ${mm} min` : ""}` : `${mm} min`;
}
const ago = (iso) => { const ms = Date.now() - Date.parse(iso); return isNaN(ms) ? null : ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60000))} min ago` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)} h ago` : `${Math.round(ms / 864e5)} days ago`; };
const gamePickText = (p) => (p.market === "ml" ? `${p.side === "home" ? p.home : p.away} to win` : p.market === "total" ? `${p.side === "over" ? "Over" : "Under"} ${p.line}` : `${p.side === "home" ? p.home : p.away} ${p.line > 0 ? "+" : ""}${p.line}`);
const STATE = { win: ["Won", "success"], loss: ["Lost", "error"], void: ["Void", "default"], needs_review: ["In review", "warning"] };

function Section({ id, title, more, onMore, children }) {
  return (
    <Card component="section" aria-labelledby={`${id}-h`} data-testid={`home-${id}`} sx={{ borderRadius: 3 }}>
      <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 1 }}>
        <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 1, minHeight: 44 }}>
          <Typography id={`${id}-h`} variant="h6" component="h3">{title}</Typography>
          {more && <Button onClick={onMore} endIcon={<Icon d={P.chevron} />} sx={{ minHeight: 44, mr: -1, whiteSpace: "nowrap" }}>{more}</Button>}
        </Stack>
        {children}
      </CardContent>
    </Card>
  );
}
const Note = ({ children }) => <Typography variant="body2" color="text.secondary">{children}</Typography>;
const rowSx = { display: "flex", alignItems: "center", gap: 1, py: 0.75, borderTop: 1, borderColor: "divider", minHeight: 56 };
const List = ({ children, label }) => <Box component="ul" aria-label={label} sx={{ m: 0, p: 0, listStyle: "none" }}>{children}</Box>;

function Tile({ n, label, onClick }) {
  return (
    <ButtonBase onClick={onClick} aria-label={`${n} ${label}`} sx={{ flex: 1, minWidth: 0, minHeight: 64, p: 1, borderRadius: 2.5, border: 1, borderColor: "divider", display: "grid", justifyItems: "start", textAlign: "left",
      "&:focus-visible": { outline: 2, outlineColor: "primary.main" } }}>
      <Typography sx={{ fontSize: 24, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>{n}</Typography>
      <Typography color="text.secondary" sx={{ fontSize: 13, lineHeight: 1.25 }}>{label}</Typography>
    </ButtonBase>
  );
}

export function HomeView() {
  const S = useStore(); const s = S.slate; const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(t); }, []);   // keeps the countdown current
  if (!s) return <Note>This week's games haven't loaded yet.</Note>;
  const now = Date.now(); const wk = s.week;
  const games = s.games.slice().sort((a, b) => FB.etToUtcMs(a.kickoff_et) - FB.etToUtcMs(b.kickoff_et));
  const open = games.filter((g) => !FB.isLocked(g, now));
  const final = games.filter((g) => (S.gameById[g.game_id] || g).status === "final").length; const live = games.length - open.length - final;
  const next = open[0];

  // ---------- my week
  const tdPicks = S.uid ? Object.values(myItems()).filter((p) => p.week === wk && p.status === "submitted") : [];
  const gPicks = S.uid ? Object.values(myGamePicks()).filter((p) => p.week === wk) : [];
  const parlays = S.uid ? Object.values(myParlays()).filter((p) => p.week === wk) : [];
  const when = (g) => (g.kickoff_et ? ` · ${FB.fmtEt(FB.etToUtcMs(g.kickoff_et), { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "");
  const mine = [
    ...tdPicks.map((p) => { const g = S.gameById[p.game_id] || {}; const r = settlePick(S.uid, p);
      return { key: p.key, k: FB.etToUtcMs(g.kickoff_et), text: p.player, sub: `${(p.market || "anytime_td") === "2plus_td" ? "2+ TDs" : "Anytime TD"}${g.away ? ` · ${g.away} at ${g.home}` : ""}${when(g)}`, g, state: r.state }; }),
    ...gPicks.map((p) => { const g = S.gameById[p.game_id] || {};
      return { key: p.key, k: FB.etToUtcMs(g.kickoff_et), text: gamePickText(p), sub: `Game pick · ${p.away} at ${p.home} · ${am(p.american)} ${p.book || ""}${when(g)}`, g, state: null }; }),
  ].sort((a, b) => a.k - b.k);
  const status = (m) => (m.state && STATE[m.state] ? STATE[m.state] : m.g.kickoff_et && FB.isLocked(m.g, now) ? ["Locked", "default"] : ["Open", "primary"]);

  // ---------- top chances (anytime, open games, available players)
  const top = open.flatMap((g) => g.teams.flatMap((t) => t.candidates.map((c) => ({ c: effCand(c), g })))).filter(({ c }) => c.quality !== "unavailable")
    .map((x) => ({ ...x, ch: chanceFor(x.c, "anytime_td") })).sort((a, b) => b.ch - a.ch).slice(0, 5);
  const bestPrice = (c) => { const b = boardFor(c, wk, "anytime_td"); const x = b && b.books.find((y) => y.fresh); return x ? `${x.book}\u00a0${am(x.american)}` : null; };   // book and price stay on one line

  // ---------- next games, with the books' average line (the schedule's line when the feed has none)
  const lineOf = (g) => {
    const books = ((S.oddsFeed && S.oddsFeed.week === wk && S.oddsFeed.game_lines) || []).filter((m) => m.game_id === g.game_id);
    const sm = books.length ? FB.lineSummary(books) : null; const g0 = S.gameById[g.game_id] || g;
    const hl = sm && sm.home_line != null ? sm.home_line : typeof g0.spread_line === "number" ? -g0.spread_line : null;
    const tot = sm && sm.total != null ? sm.total : typeof g0.total_line === "number" ? g0.total_line : null;
    return [hl == null ? null : hl === 0 ? "Even" : `${hl < 0 ? g.home : g.away} −${half(hl)}`, tot == null ? null : `total ${half(tot)}`].filter(Boolean).join(" · ");
  };

  // ---------- price moves on open games
  const openIds = new Set(open.map((g) => g.game_id));
  const allMoves = weekMoves(wk).filter((m) => m.market === "anytime_td" && openIds.has(m.game_id));   // biggest first
  const moves = []; const seen = {};   // one row per player: his biggest move, and how many books moved
  allMoves.forEach((m) => { if (seen[m.gsis_id]) { seen[m.gsis_id].books++; return; } moves.push(seen[m.gsis_id] = { ...m, books: 1 }); });
  const bigMoves = moves.filter((m) => m.move.big).length;

  // ---------- family: who has picked this week, and the last week that has results
  const all = Object.entries(S.allPicks).flatMap(([uid, d]) => Object.values((d && d.items) || {}).filter((p) => p.status === "submitted").map((p) => ({ uid, p })));
  const thisWeek = {}; all.filter((x) => x.p.week === wk).forEach(({ uid }) => { thisWeek[uid] = (thisWeek[uid] || 0) + 1; });
  const pastWeeks = [...new Set(all.filter((x) => x.p.week < wk).map((x) => x.p.week))].sort((a, b) => b - a);
  const lastWk = pastWeeks[0]; const last = {}; let unsettled = 0;
  if (lastWk != null && S.extrasLoaded) all.filter((x) => x.p.week === lastWk).forEach(({ uid, p }) => { const r = settlePick(uid, p); const t = (last[uid] ||= { win: 0, n: 0 });
    if (r.state === "win" || r.state === "loss") { t.n++; t.win += r.state === "win"; } else if (r.state !== "void") unsettled++; });
  const lastRows = Object.entries(last).filter(([, t]) => t.n).sort((a, b) => b[1].win - a[1].win || a[1].n - b[1].n);

  return (
    <Stack spacing={1.5}>
      <DbNote />
      <Box>
        <Typography variant="h5" component="h2">Home · Week {wk}</Typography>
        <Typography data-testid="home-next" sx={{ fontWeight: 600, mt: 0.5 }}>
          {next ? <>Next kickoff: {next.away} at {next.home}, {kick(next)}. <Box component="span" sx={{ color: "primary.main" }}>Locks in {until(FB.etToUtcMs(next.kickoff_et) - now)}.</Box></>
            : "Every game this week has kicked off. The next week's games appear after the Tuesday refresh."}
        </Typography>
        <Typography variant="body2" color="text.secondary">{open.length} game{open.length === 1 ? "" : "s"} open{live > 0 ? ` · ${live} in progress` : ""}{final > 0 ? ` · ${final} final` : ""}
          {S.meta && S.meta.refreshed_at ? ` · data updated ${et(S.meta.refreshed_at, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : ""}
          {S.oddsFeed && S.oddsFeed.week === wk && S.oddsFeed.pulled_at && ago(S.oddsFeed.pulled_at) ? ` · prices checked ${ago(S.oddsFeed.pulled_at)}` : ""}</Typography>
      </Box>

      <Section id="mine" title="My week" more={mine.length || parlays.length ? "My picks" : null} onMore={go("picks")}>
        {!S.uid ? <Note>{S.dbState === "connecting" ? "Loading your picks…" : "Your picks will show here once you're signed in."}</Note> : <>
          <Stack direction="row" sx={{ gap: 1 }}>
            <Tile n={tdPicks.length} label={`TD pick${tdPicks.length === 1 ? "" : "s"}`} onClick={go(tdPicks.length ? "picks" : "week")} />
            <Tile n={gPicks.length} label={`Game pick${gPicks.length === 1 ? "" : "s"}`} onClick={go("gamelines")} />
            <Tile n={parlays.length} label={`Parlay${parlays.length === 1 ? "" : "s"}`} onClick={go("parlays")} />
          </Stack>
          {S.draft.length > 0 && <ButtonBase onClick={go("parlays")} sx={{ justifyContent: "space-between", px: 1.5, minHeight: 48, borderRadius: 2.5, bgcolor: "secondary.main", color: "secondary.contrastText", fontSize: 15, fontWeight: 700 }}>
            <span>Parlay in progress · {S.draft.length} leg{S.draft.length > 1 ? "s" : ""}</span><span>Finish it ›</span></ButtonBase>}
          {mine.length > 0 ? (
            <List label="My picks this week">
              {mine.slice(0, 6).map((m) => { const st = status(m); return (
                <Box component="li" key={m.key} sx={rowSx}>
                  <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontWeight: 600 }}>{m.text}</Typography><Typography variant="body2" color="text.secondary">{m.sub}</Typography></Box>
                  <Chip size="small" color={st[1]} variant={st[0] === "Open" ? "outlined" : "filled"} label={st[0]} title={st[0] === "Open" ? "You can change this until kickoff" : undefined} />
                </Box>); })}
              {mine.length > 6 && <Box component="li" sx={{ pt: 0.5 }}><Note>and {mine.length - 6} more on My picks.</Note></Box>}
            </List>
          ) : open.length > 0 ? (
            <>
              <Note>Nothing picked yet for week {wk}.</Note>
              <Stack direction="row" sx={{ gap: 1 }}>
                <Button variant="contained" size="large" onClick={go("week")} sx={{ flex: 1, px: 1, whiteSpace: "nowrap" }}>Pick players</Button>
                <Button variant="outlined" size="large" onClick={go("gamelines")} sx={{ flex: 1, px: 1, whiteSpace: "nowrap" }}>Game lines</Button>
              </Stack>
            </>
          ) : <Note>No picks this week.</Note>}
        </>}
      </Section>

      {top.length > 0 && (
        <Section id="top" title="Top TD chances" more="All players" onMore={go("week")}>
          <Note>Highest chance to score among games still open (anytime TD).</Note>
          <List label="Top touchdown chances">
            {top.map(({ c, g, ch }, i) => { const bp = bestPrice(c); return (
              <Box component="li" key={c.gsis_id} sx={rowSx}>
                <Typography color="text.secondary" sx={{ width: 16, fontVariantNumeric: "tabular-nums" }} aria-hidden>{i + 1}</Typography>
                <ButtonBase onClick={() => focusGame(g.game_id)} aria-label={`${c.full_name || c.player}, ${pct(ch)} to score. Open ${g.away} at ${g.home}`}
                  sx={{ flex: 1, minWidth: 0, minHeight: 48, display: "block", textAlign: "left", borderRadius: 1.5, "&:focus-visible": { outline: 2, outlineColor: "primary.main" } }}>
                  <Typography sx={{ fontWeight: 600 }}>{c.full_name || c.player} <Typography component="span" variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>{c.pos} · {g.away} at {g.home}</Typography></Typography>
                  <Typography variant="body2" color="text.secondary"><Box component="span" sx={{ color: "text.primary", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{pct(ch)}</Box> to score{bp ? ` · ${bp}` : ""}</Typography>
                </ButtonBase>
                <PickButton c={c} g={g} locked={false} market="anytime_td" />
              </Box>); })}
          </List>
        </Section>
      )}

      {open.length > 0 && (
        <Section id="games" title="Next games" more="All game lines" onMore={go("gamelines")}>
          <List label="Next games">
            {open.slice(0, 3).map((g) => { const ln = lineOf(g); return (
              <Box component="li" key={g.game_id} sx={{ ...rowSx, py: 0 }}>
                <ButtonBase onClick={go("gamelines")} aria-label={`${g.away} at ${g.home}, ${kick(g)}${ln ? `, ${ln.replace("−", "minus ")}` : ""}. Open game lines`}
                  sx={{ flex: 1, minWidth: 0, minHeight: 56, display: "flex", justifyContent: "space-between", gap: 1, textAlign: "left", borderRadius: 1.5, "&:focus-visible": { outline: 2, outlineColor: "primary.main" } }}>
                  <Box sx={{ minWidth: 0 }}><Typography sx={{ fontWeight: 600 }} noWrap>{g.away} at {g.home}</Typography><Typography variant="body2" color="text.secondary" noWrap>{kick(g)}</Typography></Box>
                  <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums", textAlign: "right", flexShrink: 0 }}>{ln || "No line yet"}</Typography>
                </ButtonBase>
              </Box>); })}
          </List>
          {open.length > 3 && <Note>{open.length - 3} more game{open.length - 3 > 1 ? "s" : ""} this week.</Note>}
        </Section>
      )}

      <Section id="moves" title="Price moves" more="All prices" onMore={go("uploads")}>
        {moves.length ? <>
          <Note>{moves.length} player{moves.length > 1 ? "s'" : "'s"} anytime TD price{moves.length > 1 ? "s have" : " has"} moved since first seen this week{bigMoves ? ` (${bigMoves} by a lot)` : ""}. ▲ pays more now, ▼ pays less.</Note>
          <List label="Biggest price moves">
            {moves.slice(0, 5).map((m) => (
              <Box component="li" key={m.gsis_id} sx={{ ...rowSx, py: 0 }}>
                <ButtonBase onClick={() => focusGame(m.game_id)} sx={{ flex: 1, minWidth: 0, minHeight: 56, display: "flex", justifyContent: "space-between", gap: 1, textAlign: "left", borderRadius: 1.5, "&:focus-visible": { outline: 2, outlineColor: "primary.main" } }}>
                  <Box sx={{ minWidth: 0 }}><Typography sx={{ fontWeight: 600 }} noWrap>{m.player}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{m.team} · {m.book}{m.books > 1 ? ` and ${m.books - 1} more` : ""}</Typography></Box>
                  <Box sx={{ flexShrink: 0 }}><MoveTag m={m.move} /></Box>
                </ButtonBase>
              </Box>))}
          </List>
        </> : <Note>No anytime TD price has moved yet this week. A move shows when a sportsbook changes a player's price after it is first seen.</Note>}
      </Section>

      <Section id="family" title="Family" more="Family board" onMore={go("board")}>
        {Object.keys(thisWeek).length ? <Typography variant="body2"><b>Week {wk}:</b> {Object.entries(thisWeek).sort((a, b) => b[1] - a[1]).map(([uid, n]) => `${nameOf(uid)} ${n} pick${n > 1 ? "s" : ""}`).join(" · ")}</Typography>
          : <Note>No one has made a touchdown pick for week {wk} yet.</Note>}
        {lastWk != null && (!S.extrasLoaded ? <Note>{S.extrasError ? `Week ${lastWk} results didn't load. Check your connection and reopen the app.` : `Loading week ${lastWk} results…`}</Note>
          : lastRows.length ? <Typography variant="body2"><b>Week {lastWk} results:</b> {lastRows.map(([uid, t]) => `${nameOf(uid)} ${t.win} of ${t.n}`).join(" · ")}{unsettled ? ` · ${unsettled} not settled yet` : ""}</Typography>
          : <Note>Week {lastWk} picks aren't settled yet.</Note>)}
      </Section>

      <Box component="nav" aria-label="More pages">
        <Typography variant="overline" color="text.secondary" component="h3" sx={{ display: "block", px: 0.5 }}>More</Typography>
        <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(3, 1fr)" } }}>
          {[["parlays", "Parlays"], ["uploads", "Prices"], ["picks", "My picks"], ["touchdowns", "TD Log"], ["defense", "Defense"], ["research", "Stats & tests"]].map(([h, l]) =>
            <Button key={h} variant="outlined" size="large" href={`#${h}`} sx={{ justifyContent: "space-between", bgcolor: "background.paper" }} endIcon={<Icon d={P.chevron} />}>{l}</Button>)}
        </Box>
      </Box>
    </Stack>
  );
}
