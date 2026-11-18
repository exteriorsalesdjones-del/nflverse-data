import { Alert, Box, Card, CardContent, Chip, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { FB, useStore } from "./store.js";

/* Lines tab: each game's main spread, total and moneyline at FanDuel and DraftKings, from the sportsbook feed
   (data/odds_feed.json: game_lines + moneylines). Display only: nothing here is a pick or a model output.
   After kickoff the last pregame lines stay, and a final game shows how it finished against them. */
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
const ln = (x) => (x == null ? "—" : (x > 0 ? "+" : "") + (Number.isInteger(x) ? x : x.toFixed(1)));
const tot = (x) => (x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(1));
const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET";
const kick = (g) => { const k = FB.etToUtcMs(g.kickoff_et); return isNaN(k) ? g.kickoff_et : FB.fmtEt(k, {}) + " ET"; };

/* How a final score finished against one book's lines. */
export function lineResult(g, m) {
  if (g.away_score == null || g.home_score == null) return null;
  const out = []; const margin = g.home_score - g.away_score;      // home minus away
  if (m.spread) { const v = margin + m.spread.home_line; out.push(v === 0 ? `Spread push (${g.home} ${ln(m.spread.home_line)})` : v > 0 ? `${g.home} covered ${ln(m.spread.home_line)}` : `${g.away} covered ${ln(-m.spread.home_line)}`); }
  if (m.total) { const t = g.home_score + g.away_score; out.push(t === m.total.line ? `Total push (${tot(m.total.line)})` : `${t > m.total.line ? "Over" : "Under"} ${tot(m.total.line)}`); }
  return out.length ? out.join(" · ") : null;
}

function moved(m) {
  const out = [];
  if (m.open_spread && m.spread && m.open_spread.home_line !== m.spread.home_line) out.push(`spread opened ${m.home} ${ln(m.open_spread.home_line)}`);
  if (m.open_total && m.total && m.open_total.line !== m.total.line) out.push(`total opened ${tot(m.open_total.line)}`);
  if (m.ml && m.ml.open_home_american != null && (m.ml.open_home_american !== m.ml.home_american || m.ml.open_away_american !== m.ml.away_american)) out.push(`moneyline opened ${m.away} ${am(m.ml.open_away_american)} / ${m.home} ${am(m.ml.open_home_american)}`);
  return out;
}

/* A line and its price: side by side when there is room, the price underneath on a narrow phone. Never cut off. */
const Pair = ({ a, b }) => (
  <Box component="span" sx={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 0.5, whiteSpace: "nowrap" }}>
    <span>{a}</span><Box component="span" sx={{ color: "text.secondary" }}>{b}</Box>
  </Box>
);
function GameCard({ g, books }) {
  const final = g.status === "final"; const started = FB.isLocked(g, Date.now());
  const cell = { py: 0.5, px: 0.5 }; const num = { ...cell, fontVariantNumeric: "tabular-nums" };
  const result = final && books.length ? lineResult(g, books[0]) : null;
  const moves = books.flatMap((m) => moved(m).map((t) => `${m.book}: ${t}`));
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }} data-game={g.game_id}>
      <CardContent sx={{ display: "grid", gap: 0.75, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography variant="h6" component="h3" sx={{ flex: 1 }}>{g.away} at {g.home}</Typography>
          <Chip size="small" variant="outlined" color={final ? "default" : started ? "warning" : "success"}
            label={final ? `Final · ${g.away} ${g.away_score}, ${g.home} ${g.home_score}` : started ? "Started" : "Open"} />
        </Stack>
        <Typography variant="body2" color="text.secondary">{kick(g)}</Typography>
        {!books.length ? <Typography variant="body2" color="text.secondary">No lines from the feed for this game yet.</Typography> : (
          <Table size="small" sx={{ tableLayout: "fixed", width: "100%" }} aria-label={`${g.away} at ${g.home}: spread, total and moneyline by sportsbook`}>
            <colgroup><col style={{ width: "17%" }} /><col style={{ width: "29%" }} /><col style={{ width: "31%" }} /><col style={{ width: "23%" }} /></colgroup>
            <TableHead><TableRow>
              <TableCell sx={cell}>Team</TableCell><TableCell sx={cell} align="right">Spread</TableCell>
              <TableCell sx={cell} align="right">Total</TableCell><TableCell sx={cell} align="right"><Box component="span" sx={{ display: { xs: "none", sm: "inline" }, "@media (min-width:360px)": { display: "inline" } }}>Moneyline</Box><Box component="abbr" title="Moneyline" sx={{ textDecoration: "none", "@media (min-width:360px)": { display: "none" } }}>ML</Box></TableCell>
            </TableRow></TableHead>
            <TableBody>
              {books.map((m) => [
                <TableRow key={m.book}><TableCell component="th" scope="rowgroup" colSpan={4} sx={{ ...cell, pt: 1, pb: 0.25, fontWeight: 700, borderBottom: 0 }}>{m.book}</TableCell></TableRow>,
                ...[["away", g.away], ["home", g.home]].map(([side, team], i) => (
                  <TableRow key={m.book + side} sx={i === 1 ? {} : { "& td, & th": { borderBottom: 0 } }}>
                    <TableCell component="th" scope="row" sx={cell}>{team}</TableCell>
                    <TableCell sx={num} align="right">{m.spread ? <Pair a={ln(side === "home" ? m.spread.home_line : -m.spread.home_line)} b={am(m.spread[side + "_american"])} /> : "—"}</TableCell>
                    <TableCell sx={num} align="right">{m.total ? <Pair a={`${side === "away" ? "O" : "U"} ${tot(m.total.line)}`} b={am(side === "away" ? m.total.over_american : m.total.under_american)} /> : "—"}</TableCell>
                    <TableCell sx={num} align="right">{m.ml ? am(m.ml[side + "_american"]) : "—"}</TableCell>
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        )}
        {result && <Typography variant="body2"><b>Result vs the {books[0].book} line:</b> {result}</Typography>}
        {moves.length > 0 && <Typography variant="caption" color="text.secondary">Moved this week · {moves.join(" · ")}</Typography>}
        {books.length > 0 && <Typography variant="caption" color="text.secondary">{started ? "Last lines before kickoff" : "Lines"} as of {when(books[0].captured_at)}</Typography>}
      </CardContent>
    </Card>
  );
}

export function GameLinesView() {
  const S = useStore(); const f = S.oddsFeed; const week = S.slate.week;
  const mine = f && f.week === week;
  const ml = Object.fromEntries((mine ? f.moneylines || [] : []).map((m) => [`${m.game_id}|${m.book}`, m]));
  const by = {};
  (mine ? f.game_lines || [] : []).forEach((m) => { (by[m.game_id] ||= {})[m.book] = { ...m, ml: ml[`${m.game_id}|${m.book}`] || null }; });
  Object.values(ml).forEach((m) => { by[m.game_id] ||= {}; if (!by[m.game_id][m.book]) by[m.game_id][m.book] = { game_id: m.game_id, book: m.book, away: m.away, home: m.home, spread: null, total: null, ml: m, captured_at: m.captured_at }; });
  // every game of the week, in kickoff order, with its latest status and score
  const games = S.games.filter((g) => g.week === week).sort((a, b) => String(a.kickoff_et).localeCompare(String(b.kickoff_et)) || a.game_id.localeCompare(b.game_id));
  const any = Object.keys(by).length > 0;
  return (
    <Stack spacing={1.5}>
      <Typography variant="h5" component="h2">Game lines · Week {week}</Typography>
      <Typography variant="body2" color="text.secondary">
        Each game's main point spread, total and moneyline at FanDuel and DraftKings, from the sportsbook feed. The smaller number beside each line is its price in American odds. For reference only: the app doesn't make picks on these.
      </Typography>
      {!any && <Alert severity="info" sx={{ borderRadius: 2 }}>{f && f.pulled_at ? "No game lines for this week yet. They arrive with the next sportsbook feed pull." : "Game lines come from the sportsbook feed, which isn't running yet (Admin → Sportsbook feed)."}</Alert>}
      {games.map((g) => <GameCard key={g.game_id} g={g} books={Object.values(by[g.game_id] || {}).sort((a, b) => a.book.localeCompare(b.book))} />)}
    </Stack>
  );
}
