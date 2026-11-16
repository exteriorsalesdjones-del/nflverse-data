import { useEffect, useMemo, useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Chip, LinearProgress, MenuItem, Stack, Table, TableBody, TableCell, TableHead, TableRow,
  TextField, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { FB, useStore, ensureResearch, effAttr, effCand, chanceFor, boardFor } from "./store.js";
import { Icon, P } from "./icons.jsx";
import { AnalysisReports } from "./analysis.jsx";
import { lastGameText, ExtrasError } from "./views.jsx";

/* Research: one place to browse the data the app already has, with the Analysis reports at the bottom.
   Kinds of data are labelled: completed-game stats, live/provisional results, pregame model estimates, uploaded prices. */

const POS = ["All", "QB", "RB", "WR", "TE"];
const pct = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(0) + "%");
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
const et = (iso, opts) => (iso ? FB.fmtEt(Date.parse(iso), { month: "short", day: "numeric", ...opts }) + " ET" : "—");
const kick = (g) => { const k = FB.etToUtcMs(g.kickoff_et); return isNaN(k) ? g.kickoff_et : FB.fmtEt(k, {}) + " ET"; };
const TYPE = { rushing: "Rushing", receiving: "Receiving", passing: "Passing", return: "Return", fumble_recovery: "Fumble recovery", defensive: "Defensive" };
const KIND = { done: ["Completed games", "success"], live: ["Live / provisional", "warning"], model: ["Pregame model estimate", "info"], price: ["Uploaded sportsbook prices", "secondary"] };
const Kind = ({ k }) => <Chip size="small" variant="outlined" color={KIND[k][1]} label={KIND[k][0]} sx={{ height: 22 }} />;
const implied = (g) => (g.spread_line == null || g.total_line == null ? null : { home: g.total_line / 2 + g.spread_line / 2, away: g.total_line / 2 - g.spread_line / 2 });

function Sec({ id, title, summary, kinds, children, open }) {
  return (
    <Accordion disableGutters defaultExpanded={!!open} variant="outlined" slotProps={{ transition: { unmountOnExit: true } }} sx={{ borderRadius: 2, "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<Icon d={P.expand} />} aria-controls={`${id}-body`} id={`${id}-head`} sx={{ minHeight: 56 }}>
        <Box><Typography variant="h6" component="h3">{title}</Typography>
          <Typography variant="body2" color="text.secondary">{summary}</Typography>
          <Stack direction="row" sx={{ gap: 0.5, mt: 0.5, flexWrap: "wrap" }}>{kinds.map((k) => <Kind key={k} k={k} />)}</Stack></Box>
      </AccordionSummary>
      <AccordionDetails sx={{ display: "grid", gap: 1.25, minWidth: 0 }}>{children}</AccordionDetails>
    </Accordion>
  );
}
function Grid({ head, rows, label, max = 40 }) {
  const [all, setAll] = useState(false); const shown = all ? rows : rows.slice(0, max);
  if (!rows.length) return <Typography variant="body2" color="text.secondary">Nothing matches these filters.</Typography>;
  return (
    <>
      <Box role="region" aria-label={`${label} (table, scrolls sideways)`} tabIndex={0} sx={{ overflowX: "auto", border: 1, borderColor: "divider", borderRadius: 2 }}>
        <Table size="small" sx={{ minWidth: head.length * 78, "& td, & th": { px: 1, py: 0.6, fontSize: 13, whiteSpace: "nowrap" } }}>
          <TableHead><TableRow>{head.map((h, i) => <TableCell key={i} sx={{ fontWeight: 700, ...(i === 0 ? { position: "sticky", left: 0, bgcolor: "background.paper", zIndex: 1 } : {}) }}>{h}</TableCell>)}</TableRow></TableHead>
          <TableBody>{shown.map((r, j) => <TableRow key={j}>{r.map((c, i) => <TableCell key={i} sx={i === 0 ? { position: "sticky", left: 0, bgcolor: "background.paper", zIndex: 1, fontWeight: 600 } : {}}>{c}</TableCell>)}</TableRow>)}</TableBody>
        </Table>
      </Box>
      {rows.length > max && <Box><Button onClick={() => setAll(!all)}>{all ? `Show first ${max}` : `Show all ${rows.length}`}</Button></Box>}
    </>
  );
}

export function ResearchView() {
  const S = useStore();
  useEffect(() => { ensureResearch(); }, []);
  const weeks = useMemo(() => [...new Set(S.games.map((g) => g.week))].sort((a, b) => a - b), [S.games]);
  const slateWeek = S.slate ? S.slate.week : null;
  const [week, setWeek] = useState(slateWeek || weeks[weeks.length - 1]);
  const [game, setGame] = useState("all"); const [q, setQ] = useState(""); const [pos, setPos] = useState("All"); const [mk, setMk] = useState(S.weekMarket || "anytime_td");
  if (!S.extrasLoaded) return S.extrasError ? <ExtrasError /> : <LinearProgress aria-label="Loading research data" />;
  const games = S.games.filter((g) => g.week === week).sort((a, b) => FB.etToUtcMs(a.kickoff_et) - FB.etToUtcMs(b.kickoff_et));
  const inGame = (gid) => game === "all" || gid === game;
  const qq = q.trim().toLowerCase();
  const matchQ = (...xs) => !qq || xs.some((x) => String(x || "").toLowerCase().includes(qq));
  const posOk = (p) => pos === "All" || p === pos;
  const two = mk === "2plus_td"; const isSlate = week === slateWeek;
  const name = (() => { const m = {}; (S.usage ? S.usage.rows : []).forEach((r) => { m[r[4]] = r[5]; }); S.tds.forEach((t) => { if (t.scorer_id && !m[t.scorer_id]) m[t.scorer_id] = t.scorer; });
    if (S.slate) S.slate.games.forEach((g) => g.teams.forEach((t) => t.candidates.forEach((c) => { m[c.gsis_id] = c.full_name || c.player; }))); return m; })();

  // teams of the players a search matches (so a player search also brings in his team's games and defense numbers)
  const searchTeams = new Set(!qq ? [] : [
    ...(S.usage ? S.usage.rows.filter((r) => String(r[5]).toLowerCase().includes(qq)).map((r) => r[2]) : []),
    ...S.tds.filter((t) => String(t.scorer || "").toLowerCase().includes(qq)).map((t) => t.team),
    ...(S.slate ? S.slate.games.flatMap((g) => g.teams.flatMap((t) => t.candidates.filter((c) => String(c.full_name || c.player).toLowerCase().includes(qq)).map(() => t.team))) : []),
  ]);
  const gameMatch = (g) => matchQ(g.away, g.home) || searchTeams.has(g.away) || searchTeams.has(g.home);
  // ---------- touchdowns in the selection
  const tds = S.tds.filter((t) => t.week === week && inGame(t.game_id) && matchQ(t.scorer, t.team, t.opp) && posOk(t.scorer_pos));
  const byScorer = {}; tds.forEach((t) => { if (t.scorer_id) (byScorer[t.scorer_id] ||= { n: 0, name: t.scorer, team: t.team, pos: t.scorer_pos }).n++; });
  const multi = Object.values(byScorer).filter((x) => x.n > 1).sort((a, b) => b.n - a.n);
  const attrKnown = tds.filter((t) => ["verified_individual", "probable_individual"].includes(effAttr(t).status)).length;

  // ---------- usage
  const U = S.usage; const ucol = U ? Object.fromEntries(U.cols.map((c, i) => [c, i])) : {};
  const usage = U ? U.rows.filter((r) => r[ucol.week] === week && inGame(r[ucol.game_id]) && matchQ(r[ucol.name], r[ucol.team], r[ucol.opp]) && posOk(r[ucol.pos])) : [];
  usage.sort((a, b) => (b[ucol.tgt] + b[ucol.car] + b[ucol.att]) - (a[ucol.tgt] + a[ucol.car] + a[ucol.att]));
  const slateCands = isSlate && S.slate ? S.slate.games.filter((g) => inGame(g.game_id)).flatMap((g) => g.teams.flatMap((t) => t.candidates.map((c) => ({ c: effCand(c), g }))))
    .filter(({ c }) => matchQ(c.full_name || c.player, c.team) && posOk(c.pos)) : [];

  // ---------- defense: TDs allowed by scorer position, season through the selected week
  const teamsSel = new Set(games.filter((g) => inGame(g.game_id) && gameMatch(g)).flatMap((g) => [g.away, g.home]));
  const allowed = {}; S.tds.filter((t) => t.week <= week && t.unit === "offense").forEach((t) => { const d = (allowed[t.opp] ||= { total: 0 }); d.total++; d[t.scorer_pos || "?"] = (d[t.scorer_pos || "?"] || 0) + 1; });
  const gamesPlayed = (team) => S.games.filter((g) => g.week <= week && g.status === "final" && (g.away === team || g.home === team)).length;

  // ---------- model + prices
  const preds = S.predictions || {};
  const modelRows = isSlate ? slateCands.map(({ c, g }) => {
    const ch = chanceFor(c, mk); const b = boardFor(c, week, mk); const best = b ? (b.books.find((x) => x.fresh) || b.books[0]) : null;
    const e = best ? FB.edge(ch, best.american) : null; const stale = best && !best.fresh;
    return { sort: ch, row: [`${c.full_name || c.player} (${c.pos} ${c.team})`, `${g.away} at ${g.home}`, `${pct(ch)}${two ? " est." : ""}`, am(FB.probToAmerican(ch)),
      best ? `${best.book} ${am(best.american)}` : "No price uploaded", best ? `${best.time_source === "upload time" ? "uploaded" : "captured"} ${et(best.captured_at, { hour: "numeric", minute: "2-digit" })}${stale ? " · Stale odds" : ""}` : "—",
      e ? `${e.edgePts >= 0 ? "+" : ""}${e.edgePts.toFixed(1)} pts${stale ? " (stale odds)" : ""}` : "—"] };
  }) : Object.entries(preds).filter(([gid]) => gid.startsWith(`2026_${String(week).padStart(2, "0")}_`) && inGame(gid)).flatMap(([gid, ps]) => {
    const g = S.gameById[gid] || {}; return Object.entries(ps).map(([pid, v]) => ({ pid, v, g }));
  }).filter(({ pid, g }) => matchQ(name[pid], g.away, g.home)).map(({ pid, v, g }) => {
    const ch = two ? FB.p2plus(v.p) : v.p;
    return { sort: ch, row: [name[pid] || pid, `${g.away} at ${g.home}`, `${pct(ch)}${two ? " est." : ""}`, am(FB.probToAmerican(ch)), "Unavailable (past week)", "—", "—"] };
  });
  modelRows.sort((a, b) => b.sort - a.sort);

  return (
    <Stack spacing={1.5}>
      <Typography variant="h5" component="h2">Research</Typography>
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" } }}>
        <TextField select size="small" label="Season" value={2026} slotProps={{ select: { native: false } }}><MenuItem value={2026}>2026</MenuItem></TextField>
        <TextField select size="small" label="Week" value={week} onChange={(e) => { setWeek(+e.target.value); setGame("all"); }}>
          {weeks.map((w) => <MenuItem key={w} value={w}>Week {w}{w === slateWeek ? " (this week)" : ""}</MenuItem>)}</TextField>
        <TextField select size="small" label="Game" value={game} onChange={(e) => setGame(e.target.value)} sx={{ gridColumn: { xs: "1 / -1", sm: "auto" } }}>
          <MenuItem value="all">All games</MenuItem>
          {games.map((g) => <MenuItem key={g.game_id} value={g.game_id}>{g.away} at {g.home}</MenuItem>)}</TextField>
        <TextField size="small" label="Search player or team" value={q} onChange={(e) => setQ(e.target.value)} sx={{ gridColumn: { xs: "1 / -1", sm: "auto" } }} />
      </Box>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        <ToggleButtonGroup exclusive size="small" value={pos} onChange={(e, v) => v && setPos(v)} aria-label="Position" sx={{ "& .MuiToggleButton-root": { minHeight: 40, px: 1.25 } }}>
          {POS.map((p) => <ToggleButton key={p} value={p}>{p}</ToggleButton>)}</ToggleButtonGroup>
        <ToggleButtonGroup exclusive size="small" value={mk} onChange={(e, v) => v && setMk(v)} aria-label="TD market" sx={{ "& .MuiToggleButton-root": { minHeight: 40, px: 1.25, textTransform: "none" } }}>
          <ToggleButton value="anytime_td">Anytime TD</ToggleButton><ToggleButton value="2plus_td">2+ TDs</ToggleButton></ToggleButtonGroup>
      </Stack>
      <Typography variant="caption" color="text.secondary">Model updated {et(S.meta.refreshed_at, { weekday: "short", hour: "numeric", minute: "2-digit" })} · sportsbook prices keep their own capture times · "Unavailable" = no source record; 0 = confirmed zero.</Typography>

      <Sec id="usage" title="Player usage" summary={`Week ${week} game-by-game usage${isSlate ? " and Last Game Usage for this week's players" : ""}`} kinds={["done"]} open>
        {!U ? <Typography variant="body2" color="text.secondary">Game-by-game usage: Unavailable (not in this data refresh yet).</Typography> : <>
          <Grid label="Game-by-game usage" head={["Player", "Wk · opp", "Targets", "Rush att", "Pass att", "GL carries", "EZ targets"]}
            rows={usage.map((r) => [`${r[ucol.name]} (${r[ucol.pos]} ${r[ucol.team]})`, `${r[ucol.week]} · ${r[ucol.opp]}`, r[ucol.tgt], r[ucol.car], r[ucol.att], r[ucol.gl], r[ucol.ez]])} />
          <Typography variant="caption" color="text.secondary">From play-by-play (matches nflverse's official weekly stats). GL carries: rushing attempts from inside the 5. EZ targets: targets thrown into the end zone (air-yards proxy). Players who appeared without a target, carry or pass attempt aren't listed (all 0). QB handoffs: Unavailable, because no source records who handed off.</Typography>
        </>}
        {isSlate && <>
          <Typography variant="subtitle2" component="h4">Last Game Usage (this week's players)</Typography>
          <Grid label="Last Game Usage" head={["Player", "Last game", "Usage"]} rows={slateCands.map(({ c }) => { const t = lastGameText(c); return [`${c.full_name || c.player} (${c.pos} ${c.team})`, t.head.replace("Last Game · ", "").replace("Last Game", "—"), t.stats]; })} />
        </>}
      </Sec>

      <Sec id="teams" title="Team and matchup data" summary="Implied points, results, weather, injuries, and touchdowns allowed by position" kinds={["done", "model"]}>
        <Grid label="Games" head={["Game", "Kickoff / status", "Score", "Line", "Implied pts"]} rows={games.filter((g) => inGame(g.game_id) && gameMatch(g)).map((g) => {
          const ip = implied(g);
          return [`${g.away} at ${g.home}`, g.status === "final" ? "Final" : FB.isLocked(g, Date.now()) ? "In progress (live results after the game)" : kick(g),
            g.status === "final" ? `${g.away} ${g.away_score} – ${g.home} ${g.home_score}` : "—",
            g.spread_line == null ? "Unavailable" : `${g.spread_line > 0 ? g.home : g.away} −${Math.abs(g.spread_line)} · O/U ${g.total_line}`,
            ip ? `${g.away} ${ip.away.toFixed(1)} · ${g.home} ${ip.home.toFixed(1)}` : "Unavailable"]; })} />
        {isSlate && S.slate ? <Grid label="Weather, injuries and depth" head={["Game", "Weather", "Injury report", "Depth-chart notes"]} rows={S.slate.games.filter((g) => inGame(g.game_id) && gameMatch(g)).map((g) => {
          const w = g.weather; const c = g.teams.flatMap((t) => t.candidates.map(effCand));
          return [`${g.away} at ${g.home}`, !w ? "Unavailable" : w.roof === "dome" ? "Dome" : w.wind_mph == null ? "No forecast yet" : `Wind ${Math.round(w.wind_mph)} mph · ${w.temp_f}°F`,
            c.filter((x) => x.injury).map((x) => `${x.full_name || x.player} (${x.injury})`).join(", ") || "None listed",
            c.filter((x) => x.role_change).map((x) => `${x.full_name || x.player} role ${x.role_change.dir === "up" ? "↑" : "↓"}`).join(", ") || "—"]; })} />
          : <Typography variant="body2" color="text.secondary">Weather, injury and depth-chart context: Unavailable for past weeks (the app keeps them for this week's slate only).</Typography>}
        <Grid label="Touchdowns allowed by scorer position" head={["Defense", "Games", "Total", "RB", "WR", "TE", "QB"]} rows={[...teamsSel].sort().map((t) => {
          const d = allowed[t] || { total: 0 }; return [t, gamesPlayed(t), d.total, d.RB || 0, d.WR || 0, d.TE || 0, d.QB || 0]; })} />
        <Typography variant="body2"><b>Defender attribution:</b> {attrKnown} of {tds.length} touchdowns in this selection have an identified defender (charting-based; the rest need film review).</Typography>
      </Sec>

      <Sec id="tds" title="Touchdown history" summary={`${tds.length} touchdown${tds.length === 1 ? "" : "s"} in week ${week}${game !== "all" ? " for this game" : ""}`} kinds={["done", "live"]}>
        {multi.length > 0 && <Typography variant="body2"><b>Scored more than once:</b> {multi.map((m) => `${m.name} (${m.team}) ×${m.n}`).join(" · ")}</Typography>}
        <Grid label="Touchdowns" head={["Scorer", "Type", "Quarter · clock", "Game", "Times scored this game", "Status"]} rows={tds.map((t) => {
          const n = S.tds.filter((x) => x.game_id === t.game_id && x.scorer_id && x.scorer_id === t.scorer_id).length; const rec = S.recon[t.game_id];
          return [`${t.scorer || "Team"} (${t.scorer_pos || "?"} ${t.team})`, `${TYPE[t.type] || t.type}${t.yards != null ? `, ${t.yards} yds` : ""}`, `Q${t.qtr} ${t.clock || ""}`, `vs ${t.opp}`, n || 1,
            rec ? (rec.reconciled ? "Reconciled with final" : "Held for review") : "Provisional"]; })} />
      </Sec>

      <Sec id="model" title="Model and sportsbook data" summary={isSlate ? "This week's model chances, fair odds, uploaded prices and value edge" : `Week ${week}: the model's saved pregame chances`} kinds={isSlate ? ["model", "price"] : ["model"]}>
        <Typography variant="caption" color="text.secondary">{isSlate ? `Model chances as of the ${et(S.meta.refreshed_at, { weekday: "short", hour: "numeric", minute: "2-digit" })} refresh. Each price shows its own capture time; prices over 2 hours old are marked stale and never shown as current.` : "Saved before each game kicked off (pregame only). Sportsbook prices are kept per week and only this week's are loaded, so past prices show as Unavailable."}{two ? " 2+ TD chances are estimates from the anytime chance." : ""}</Typography>
        <Grid label="Model and prices" head={["Player", "Game", two ? "2+ chance" : "TD chance", "Fair odds", "Best price", "Price time", "Value edge"]} rows={modelRows.map((x) => x.row)} />
      </Sec>

      <Sec id="findings" title="Backtesting and findings" summary="Weeks 1–9 point-in-time study, Week 10 forecast, sample sizes and small-sample flags" kinds={["done", "model"]}>
        <AnalysisReports />
      </Sec>
    </Stack>
  );
}
