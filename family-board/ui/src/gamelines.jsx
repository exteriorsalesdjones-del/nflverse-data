import { useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, ButtonBase, Card, CardContent, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { FB, useStore, ensureLineHistory, focusGame } from "./store.js";

/* Lines tab: each game's main spread, total and moneyline at FanDuel and DraftKings (sportsbook feed), with a one-line
   read of what they imply, the better book on each side, movement this week, weather, each team's season scoring and
   record against the line, and past weeks. Display only: nothing here is a pick or a model output. */
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
const ln = (x) => (x == null ? "—" : x === 0 ? "PK" : (x > 0 ? "+" : "") + (Number.isInteger(x) ? x : x.toFixed(1)));
const num1 = (x) => (x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(1));
const half = (x) => Math.round(x * 2) / 2;
const pct = (p) => (p == null ? "—" : Math.round(p * 100) + "%");
const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
const kick = (g) => { const k = FB.etToUtcMs(g.kickoff_et); return isNaN(k) ? g.kickoff_et : FB.fmtEt(k, {}) + " ET"; };

/* Thursday / Sunday early / Sunday late / Sunday night / Monday ... from the Eastern kickoff time. */
export function windowOf(g) {
  const d = new Date(g.kickoff_et.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const h = Number(g.kickoff_et.slice(11, 13));
  if (d !== "Sunday") return d;
  return h < 12 ? "Sunday morning" : h < 15 ? "Sunday early" : h < 19 ? "Sunday late" : "Sunday night";
}
const INDOOR = ["dome", "closed"];
function weatherText(g) {
  const w = g.weather; const roof = (w && w.roof) || g.roof;
  if (INDOOR.includes(roof)) return "Indoors";
  if (!w || w.wind_mph == null) return roof === "retractable" ? "Retractable roof" : null;
  return [w.temp_f != null ? `${Math.round(w.temp_f)}°F` : null, `wind ${Math.round(w.wind_mph)} mph${w.windy ? " (windy)" : ""}`, w.precip_pct ? `${w.precip_pct}% rain` : null, roof === "retractable" ? "retractable roof" : null].filter(Boolean).join(" · ");
}
/* "KC favoured by 16 · total 41 · implied score KC 28.5, ARI 12.5 · KC 90% to win" */
function summaryText(g, s) {
  if (s.home_line == null && s.total == null && s.home_win == null) return null;
  const out = []; const hl = s.home_line == null ? null : half(s.home_line);
  if (hl != null) out.push(hl === 0 ? "Pick'em" : `${hl < 0 ? g.home : g.away} favoured by ${num1(Math.abs(hl))}`);
  if (s.total != null) out.push(`total ${num1(half(s.total))}`);
  if (s.home_pts != null) out.push(`implied score ${g.away} ${num1(half(s.away_pts))}, ${g.home} ${num1(half(s.home_pts))}`);
  if (s.home_win != null) out.push(`${s.home_win >= 0.5 ? g.home : g.away} ${pct(Math.max(s.home_win, 1 - s.home_win))} to win`);
  return out.join(" · ");
}
function resultText(g, homeLine, total) {
  const r = FB.gradeLine(g, homeLine, total); if (!r) return null; const out = [];
  if (r.ats) out.push(r.ats === "push" ? `spread push (${g.home} ${ln(homeLine)})` : r.ats === "home" ? `${g.home} covered ${ln(homeLine)}` : `${g.away} covered ${ln(-homeLine)}`);
  if (r.ou) out.push(r.ou === "push" ? `total push (${num1(total)})` : `${r.ou === "over" ? "Over" : "Under"} ${num1(total)}`);
  return out.join(" · ");
}
/* "−14.5 → −15.5 → −16.5" from the saved history, without repeats. */
function steps(hist, key, fmt) {
  const xs = []; (hist || []).forEach((h) => { const v = h[key]; if (v != null && (!xs.length || xs[xs.length - 1] !== v)) xs.push(v); });
  return xs.length > 1 ? xs.map(fmt).join(" → ") : null;
}
function movement(g, m) {
  const out = []; const h = m.history;
  const sp = steps(h, "home_line", (v) => `${g.home} ${ln(v)}`) || (m.open_spread && m.spread && m.open_spread.home_line !== m.spread.home_line ? `${g.home} ${ln(m.open_spread.home_line)} → ${g.home} ${ln(m.spread.home_line)}` : null);
  const tt = steps(h, "total", num1) || (m.open_total && m.total && m.open_total.line !== m.total.line ? `${num1(m.open_total.line)} → ${num1(m.total.line)}` : null);
  const ml = steps(h, "ml_home", (v) => `${g.home} ${am(v)}`) || (m.ml && m.ml.open_home_american != null && m.ml.open_home_american !== m.ml.home_american ? `${g.home} ${am(m.ml.open_home_american)} → ${g.home} ${am(m.ml.home_american)}` : null);
  if (sp) out.push(`spread ${sp}`); if (tt) out.push(`total ${tt}`); if (ml) out.push(`moneyline ${ml}`);
  return out.length ? `${m.book}: ${out.join("; ")}` : null;
}
const recordText = (team, r) => (!r || !r.games ? `${team}: no games yet` :
  `${team} ${r.w}-${r.l}${r.t ? `-${r.t}` : ""} · scores ${(r.pf / r.games).toFixed(1)}, allows ${(r.pa / r.games).toFixed(1)} · vs spread ${r.ats_w}-${r.ats_l}${r.ats_p ? `-${r.ats_p}` : ""} · over/under ${r.over}-${r.under}${r.ou_p ? `-${r.ou_p}` : ""}`);

/* A line and its price: side by side when there is room, the price underneath on a narrow phone. `best` marks the
   better book for that side (bold, with a check mark so it isn't colour alone). */
const Pair = ({ a, b, best }) => (
  <Box component="span" sx={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 0.5, whiteSpace: "nowrap", fontWeight: best ? 700 : 400, color: best ? "success.main" : "inherit" }}>
    <span>{best && <Box component="span" aria-label="best price" role="img" sx={{ fontSize: "0.75em", mr: 0.25 }}>✓</Box>}{a}</span>{b != null && <Box component="span" sx={{ color: best ? "success.main" : "text.secondary" }}>{b}</Box>}
  </Box>
);

function LinesTable({ g, books }) {
  const cell = { py: 0.5, px: 0.5 }; const num = { ...cell, fontVariantNumeric: "tabular-nums" };
  const best = FB.bestLines(books);
  return (
    <Table size="small" sx={{ tableLayout: "fixed", width: "100%", "@media (max-width:359px)": { "& td, & th": { fontSize: 12, px: 0.25 } } }} aria-label={`${g.away} at ${g.home}: spread, total and moneyline by sportsbook`}>
      <colgroup><col style={{ width: "17%" }} /><col style={{ width: "29%" }} /><col style={{ width: "31%" }} /><col style={{ width: "23%" }} /></colgroup>
      <TableHead><TableRow>
        <TableCell sx={cell}>Team</TableCell><TableCell sx={cell} align="right">Spread</TableCell><TableCell sx={cell} align="right">Total</TableCell>
        <TableCell sx={cell} align="right"><Box component="span" sx={{ display: "none", "@media (min-width:360px)": { display: "inline" } }}>Moneyline</Box><Box component="abbr" title="Moneyline" sx={{ textDecoration: "none", "@media (min-width:360px)": { display: "none" } }}>ML</Box></TableCell>
      </TableRow></TableHead>
      <TableBody>
        {books.map((m) => [
          <TableRow key={m.book}><TableCell component="th" scope="rowgroup" colSpan={4} sx={{ ...cell, pt: 1, pb: 0.25, fontWeight: 700, borderBottom: 0 }}>{m.book}</TableCell></TableRow>,
          ...[["away", g.away], ["home", g.home]].map(([side, team], i) => (
            <TableRow key={m.book + side} sx={i === 1 ? {} : { "& td, & th": { borderBottom: 0 } }}>
              <TableCell component="th" scope="row" sx={cell}>{team}</TableCell>
              <TableCell sx={num} align="right">{m.spread ? <Pair best={best["spread_" + side] === m.book} a={ln(side === "home" ? m.spread.home_line : -m.spread.home_line)} b={am(m.spread[side + "_american"])} /> : "—"}</TableCell>
              <TableCell sx={num} align="right">{m.total ? <Pair best={best[side === "away" ? "total_over" : "total_under"] === m.book} a={`${side === "away" ? "O" : "U"} ${num1(m.total.line)}`} b={am(side === "away" ? m.total.over_american : m.total.under_american)} /> : "—"}</TableCell>
              <TableCell sx={num} align="right">{m.ml && m.ml[side + "_american"] != null ? <Pair best={best["ml_" + side] === m.book} a={am(m.ml[side + "_american"])} /> : "—"}</TableCell>
            </TableRow>
          )),
        ])}
      </TableBody>
    </Table>
  );
}

function GameCard({ g, books, rec, current }) {
  const final = g.status === "final"; const started = FB.isLocked(g, Date.now());
  const [open, setOpen] = useState(!final);                                   // finished games start collapsed
  const sched = typeof g.spread_line === "number" || typeof g.total_line === "number";
  const s = books.length ? FB.lineSummary(books) : sched ? FB.lineSummary([{ spread: typeof g.spread_line === "number" ? { home_line: -g.spread_line } : null, total: typeof g.total_line === "number" ? { line: g.total_line } : null }]) : null;
  const summary = s && summaryText(g, s);
  const moves = books.map((m) => movement(g, m)).filter(Boolean);
  // a final game is graded against each book's line, or the schedule file's closing line when no book line was saved
  const results = !final ? [] : books.length ? books.map((m) => [m.book, resultText(g, m.spread ? m.spread.home_line : null, m.total ? m.total.line : null)]).filter((x) => x[1])
    : sched ? [["closing line", resultText(g, typeof g.spread_line === "number" ? -g.spread_line : null, typeof g.total_line === "number" ? g.total_line : null)]].filter((x) => x[1]) : [];
  const sameResult = results.length > 1 && results.every((x) => x[1] === results[0][1]);
  const wx = weatherText(g); const venue = [g.stadium, wx].filter(Boolean).join(" · ");
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }} data-game={g.game_id}>
      <ButtonBase onClick={() => setOpen(!open)} aria-expanded={open} sx={{ display: "block", width: "100%", textAlign: "left", px: 2, pt: 1.5, pb: open ? 0.5 : 1.5 }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography variant="h6" component="h4" sx={{ flex: 1 }}>{g.away} at {g.home}</Typography>
          <Chip size="small" variant="outlined" color={final ? "default" : started ? "warning" : "success"}
            label={final ? `Final · ${g.away} ${g.away_score}, ${g.home} ${g.home_score}` : started ? "Started" : "Open"} />
        </Stack>
        <Typography variant="body2" color="text.secondary">{kick(g)}{venue ? ` · ${venue}` : ""}</Typography>
        {summary && <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 600 }} data-testid="line-summary">{summary}{!books.length && sched ? " (closing line from the schedule file)" : ""}</Typography>}
        {final && results.length > 0 && <Typography variant="body2" sx={{ mt: 0.25 }} data-testid="line-result">
          <b>Result:</b> {sameResult ? results[0][1] : results.map(([b, r]) => `${b}: ${r}`).join(" · ")}</Typography>}
      </ButtonBase>
      {open && (
        <CardContent sx={{ display: "grid", gap: 0.75, pt: 0.5, "&:last-child": { pb: 1.5 } }}>
          {books.length ? <LinesTable g={g} books={books} />
            : <Typography variant="body2" color="text.secondary">{current ? "No lines from the feed for this game yet." : "No sportsbook lines were saved for this game (the feed started in Week 11)."}</Typography>}
          {books.length > 1 && Object.keys(FB.bestLines(books)).length > 0 && <Typography variant="caption" color="text.secondary">✓ = the better book for that side (a better number first, then a better price).</Typography>}
          {s && s.home_win != null && <Typography variant="caption" color="text.secondary">Win chance is the moneyline with the book's margin removed ({g.away} {pct(1 - s.home_win)}, {g.home} {pct(s.home_win)}).</Typography>}
          {moves.length > 0 && <Typography variant="caption" color="text.secondary" data-testid="line-moves">Moved this week · {moves.join(" · ")}</Typography>}
          <Box data-testid="team-records">
            <Typography variant="caption" color="text.secondary" component="div">{recordText(g.away, rec[g.away])}</Typography>
            <Typography variant="caption" color="text.secondary" component="div">{recordText(g.home, rec[g.home])}</Typography>
          </Box>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            {books.length > 0 && <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{started ? "Last lines before kickoff" : "Lines"} as of {when(books[0].captured_at)}</Typography>}
            {current && !final && <Button size="small" onClick={() => focusGame(g.game_id)} sx={{ minHeight: 44, ml: "auto" }}>Touchdown picks ›</Button>}
          </Stack>
        </CardContent>
      )}
    </Card>
  );
}

export function GameLinesView() {
  const S = useStore(); const f = S.oddsFeed; const cur = S.slate.week;
  const [week, setWeek] = useState(cur);
  useEffect(() => { ensureLineHistory(); }, []);
  const weeks = useMemo(() => [...new Set(S.games.map((g) => g.week))].filter((w) => w <= cur).sort((a, b) => b - a), [S.games, cur]);
  const by = useMemo(() => {
    const out = {};
    if (week === cur && f && f.week === cur) {
      const ml = Object.fromEntries((f.moneylines || []).map((m) => [`${m.game_id}|${m.book}`, m]));
      (f.game_lines || []).forEach((m) => { (out[m.game_id] ||= {})[m.book] = { ...m, ml: ml[`${m.game_id}|${m.book}`] || null }; });
      Object.values(ml).forEach((m) => { out[m.game_id] ||= {}; if (!out[m.game_id][m.book]) out[m.game_id][m.book] = { game_id: m.game_id, book: m.book, spread: null, total: null, ml: m, captured_at: m.captured_at }; });
    } else if (week !== cur && S.lineHistory) {
      (S.lineHistory.games || []).filter((m) => m.week === week).forEach((m) => { (out[m.game_id] ||= {})[m.book] = m; });
    }
    return out;
  }, [week, cur, f, S.lineHistory]);
  // records going INTO the week shown, so a past week doesn't include its own results
  const rec = useMemo(() => FB.teamRecords(S.games, week), [S.games, week]);
  const games = S.slate && week === cur
    ? S.games.filter((g) => g.week === week).map((g) => ({ ...(S.slate.games.find((x) => x.game_id === g.game_id) || {}), ...g }))
    : S.games.filter((g) => g.week === week);
  games.sort((a, b) => String(a.kickoff_et).localeCompare(String(b.kickoff_et)) || a.game_id.localeCompare(b.game_id));
  const groups = []; games.forEach((g) => { const w = windowOf(g); if (!groups.length || groups[groups.length - 1][0] !== w) groups.push([w, []]); groups[groups.length - 1][1].push(g); });
  const any = Object.keys(by).length > 0;
  return (
    <Stack spacing={1.5}>
      <Typography variant="h5" component="h2">Game lines · Week {week}</Typography>
      <ToggleButtonGroup exclusive size="small" value={week} onChange={(e, v) => v && setWeek(v)} aria-label="Week"
        sx={{ overflowX: "auto", maxWidth: "100%", "& .MuiToggleButton-root": { minHeight: 44, minWidth: 52, px: 1, flexShrink: 0, textTransform: "none" } }}>
        {weeks.map((w) => <ToggleButton key={w} value={w} aria-label={`Week ${w}`}>Wk {w}</ToggleButton>)}
      </ToggleButtonGroup>
      <Typography variant="body2" color="text.secondary">
        {week === cur ? "Main point spread, total and moneyline at FanDuel and DraftKings, from the sportsbook feed. The smaller number beside each line is its price in American odds."
          : "Past week: final scores against the line. Sportsbook lines are shown where they were saved (from Week 11); otherwise the schedule file's closing spread and total."} For reference only: the app doesn't make picks on these.
      </Typography>
      {week === cur && !any && <Alert severity="info" sx={{ borderRadius: 2 }}>{f && f.pulled_at ? "No game lines for this week yet. They arrive with the next sportsbook feed pull." : "Game lines come from the sportsbook feed, which isn't running yet (Admin → Sportsbook feed)."}</Alert>}
      {groups.map(([label, gs]) => (
        <Stack key={label} spacing={1} component="section" aria-label={label}>
          <Typography variant="overline" component="h3" color="text.secondary" sx={{ lineHeight: 1.6, fontWeight: 700 }}>{label} · {gs.length} game{gs.length > 1 ? "s" : ""}</Typography>
          {gs.map((g) => <GameCard key={g.game_id} g={g} rec={rec} current={week === cur} books={Object.values(by[g.game_id] || {}).sort((a, b) => a.book.localeCompare(b.book))} />)}
        </Stack>
      ))}
    </Stack>
  );
}
