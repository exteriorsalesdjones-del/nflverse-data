import { useEffect, useMemo, useState } from "react";
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Autocomplete, Box, Button, ButtonBase, Card, CardContent, Chip, Dialog,
  DialogActions, DialogContent, DialogTitle, Drawer, IconButton, LinearProgress, MenuItem, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography, useMediaQuery,
} from "@mui/material";
import {
  FB, useStore, effAttr, effCand, slateCands, myItems, priceFor, settlePick, nameOf, addPick, removePick, setPickStatus,
  rangeFor, exportCsv, freeze, saveReview, setOverride, toast, allLineRows, MARKETS, parseLinesCsv, uploadLines, deleteLines, readLinesShot, readLinesShots, MAX_SHOTS,
  addLeg, removeLeg, setDraft, toggleLeg, inDraft, refFor, crewIndex, setReferees, parseRefText, markInactive, matchLine, ensureExtras, setShotReview, confirmShot, clearSkipped, resetUploadScreen, ensurePregame, setWeekMarket, chanceFor, boardFor, weekMoves, weekRankings, refreshLines, allLineRows as allRows, manualRefresh, liveStatus, blendFor, state, clearFocusGame, saveFeedKey, removeFeedKey, saveParlay, deleteParlay, myParlays, settleParlayFor,
} from "./store.js";
import { visuallyHidden } from "@mui/utils";
import { Icon, P } from "./icons.jsx";
import { ResultsDashboard } from "./results.jsx";
import { LivePanel } from "./live.jsx";

/* ---------- shared bits ---------- */
const pct = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(0) + "%");
/* Every price time is reported by whoever uploaded it; none is verified against the sportsbook. */
const timeBasis = (src) => (src === "sportsbook feed" ? "time = when the feed last checked the book" : src === "upload time" ? "time = when it was uploaded (unverified)" : src === "screenshot file time" ? "time = screenshot file time (unverified)" : "time as reported by the uploader (unverified)");
const odds1 = (p) => (p == null || isNaN(p) ? "—" : p >= 0.01 ? (p * 100).toFixed(1) + "%" : p > 0 ? `1 in ${Math.round(1 / p).toLocaleString()}` : "0%");
const pct1 = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(1) + "%");
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
const et = (iso, opts) => (iso ? FB.fmtEt(Date.parse(iso), { month: "short", day: "numeric", ...opts }) + " ET" : "—");
const kick = (g) => { const k = FB.etToUtcMs(g.kickoff_et); return isNaN(k) ? g.kickoff_et : FB.fmtEt(k, {}) + " ET"; };
export const STATUS = { verified_individual: "Verified", probable_individual: "Probable", shared: "Shared", team_unit: "Team or unit", unknown: "Unknown" };
const STATUS_COLOR = { verified_individual: "success", probable_individual: "primary", shared: "secondary", team_unit: "warning", unknown: "default" };
const TYPE = { passing: "Passing", rushing: "Rushing", interception_return: "Interception return", fumble_return: "Fumble return", fumble_recovery: "Fumble recovery", kickoff_return: "Kickoff return", punt_return: "Punt return", blocked_punt_return: "Blocked punt return", blocked_kick_return: "Blocked kick return", other_return: "Other return", other: "Other" };
const RESULT = { win: ["Won", "success"], loss: ["Lost", "error"], void: ["Void", "default"], pending: ["Pending", "warning"], needs_review: ["Review", "secondary"], draft: ["Draft", "default"] };

const ageTxt = (m) => (m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`);
const RANK_COLOR = { best: "success.main", worst: "error.main" };
/* A line move since the first price of the week: green = pays more now, red = pays less. Text says so too (not colour only). */
export function MoveTag({ m, short }) {
  if (!m) return null; const up = m.dir === "longer";
  return (
    <Typography component="span" variant="caption" sx={{ color: up ? "success.main" : "error.main", fontWeight: m.big ? 700 : 500, whiteSpace: "nowrap" }}
      title={`Opened ${am(m.from)}, now ${am(m.to)}: ${up ? "pays more" : "pays less"}${m.big ? " (big move)" : ""}`}>
      {up ? "▲" : "▼"} {short ? `from ${am(m.from)}` : `${am(m.from)} → ${am(m.to)}`}{m.big ? " big" : ""}
      <Box component="span" sx={visuallyHidden}>{up ? " pays more" : " pays less"}</Box>
    </Typography>
  );
}
/* "Above fair" marker: purple when even the low end of the model's range beats the price, grey when the price sits
   inside the range (green already means "better of FD/DK"). Fresh anytime prices only. */
function AboveFair({ c, x, market }) {
  const m = x ? FB.aboveFair(c.p, x, Date.now(), market, rangeFor(c)) : null;
  if (!m) return null;
  const tail = m.firm == null ? "" : m.firm ? ` Even the low end of the model's range (${pct1(m.lo)}) beats this price. In past testing those bets did not win more often, so this is a research flag, not a tip.`
    : ` The price is inside the model's range (low end ${pct1(m.lo)}), so this gap is within normal model error.`;
  return <Box component="span" title={`Model ${pct1(c.p)} vs book ${pct1(m.implied)} (margin included).${tail} In testing, sportsbook prices predicted better than the model.`}
    sx={{ color: m.firm === false ? "text.secondary" : "secondary.main", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }}>Above fair +{m.pts.toFixed(1)}{m.firm == null ? "" : m.firm ? " · clears range" : " · in range"}</Box>;
}
/* Every book's latest price for one market: best in green, worst in red (labelled), each with its age and line move. */
function BookList({ c, g, market }) {
  useStore(); const b = boardFor(c, g.week, market);
  if (!b) return <Typography variant="body2" color="text.secondary">No {MARKETS[market]} prices yet (add them under TD Picks, Prices).</Typography>;
  return (
    <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 0.5 }} aria-label={`${MARKETS[market]} prices by sportsbook`}>
      {b.books.map((x) => (
        <Box component="li" key={x.book} sx={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 1, px: 1, py: 0.5, borderRadius: 1, border: 1,
          borderColor: RANK_COLOR[x.rank] || "divider", borderLeftWidth: RANK_COLOR[x.rank] ? 4 : 1 }}>
          <Typography sx={{ fontWeight: 700, minWidth: 56, color: RANK_COLOR[x.rank] || "text.primary" }}><Num>{am(x.american)}</Num></Typography>
          <Typography variant="body2" sx={{ flex: "1 1 112px" }}>{x.book}{x.rank === "best" ? " · Best" : x.rank === "worst" ? " · Worst" : ""}</Typography>
          <Typography variant="caption" color="text.secondary">{ageTxt(x.age_min)}{x.fresh ? "" : " · old"}</Typography>
          <MoveTag m={x.move} /><AboveFair c={c} x={x} market={market} />
        </Box>
      ))}
    </Box>
  );
}
/* Week-tab row: FanDuel and DraftKings side by side, the better payout highlighted green (a tie highlights neither).
   Prices over 2 hours old show their age; a small arrow shows a move since the week's first price. If another book
   beats both, a note says where; every book is listed in the player details. */
const isFD = (b) => /^(fd|fan\s*duel)\b/i.test(String(b || "").trim());
const isDK = (b) => /^(dk|draft\s*kings)\b/i.test(String(b || "").trim());
function FdDk({ c, g }) {
  const S = useStore(); const b = boardFor(c, g.week, S.weekMarket);
  const books = b ? b.books : []; const fd = books.find((x) => isFD(x.book)); const dk = books.find((x) => isDK(x.book));
  const dec = (x) => FB.americanToDecimal(x.american);
  const better = fd && dk && dec(fd) !== dec(dk) ? (dec(fd) > dec(dk) ? "FD" : "DK") : null;
  const top = Math.max(fd ? dec(fd) : 0, dk ? dec(dk) : 0);
  const other = books.find((x) => !isFD(x.book) && !isDK(x.book) && dec(x) > top);
  const Cell = ({ label, x }) => {
    const hi = better === label;
    return (
      <Box component="span" sx={{ display: "inline-flex", alignItems: "baseline", gap: 0.5, px: 0.75, py: 0.125, borderRadius: 1, border: 1,
        borderColor: hi ? "success.main" : "divider", bgcolor: hi ? "rgba(46,125,50,0.10)" : "transparent", whiteSpace: "nowrap" }}>
        <Box component="span" sx={{ color: "text.secondary", fontSize: 12, fontWeight: 600 }}>{label}</Box>
        {x ? <Num sx={{ fontWeight: 700, color: hi ? "success.main" : "text.primary" }}>{am(x.american)}</Num> : <Box component="span" sx={{ color: "text.secondary" }}>—</Box>}
        {x && !x.fresh && <Box component="span" sx={{ color: "text.secondary", fontSize: 12 }}>{ageTxt(x.age_min).replace(" ago", "")}</Box>}
        {x && x.move && <Box component="span" sx={{ fontSize: 12, color: x.move.dir === "longer" ? "success.main" : "error.main" }} title={`Opened ${am(x.move.from)}`}>{x.move.dir === "longer" ? "▲" : "▼"}</Box>}
        <AboveFair c={c} x={x} market={S.weekMarket} />
        {hi && <Box component="span" sx={visuallyHidden}> (better price)</Box>}
        {x && x.move && <Box component="span" sx={visuallyHidden}>{` moved from ${am(x.move.from)}, ${x.move.dir === "longer" ? "pays more" : "pays less"}`}</Box>}
      </Box>
    );
  };
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.75, mt: 0.25 }}>
      <Cell label="FD" x={fd} /><Cell label="DK" x={dk} />
      {other && <Typography variant="caption" color="text.secondary">better at {other.book} {am(other.american)} <AboveFair c={c} x={other} market={S.weekMarket} /></Typography>}
    </Box>
  );
}
/* Last Game Usage (slate.json candidates[].last_game, built by refresh/last_game.py). Verified 0 shows "0"; a stat
   that couldn't be verified shows "Unavailable"; QB handoffs are always unavailable in the current sources. */
const LG_LABEL = { targets: ["target", "targets"], rush_att: ["rushing attempt", "rushing attempts"], pass_att: ["pass attempt", "pass attempts"] };
const LG_FIELDS = { WR: ["targets"], TE: ["targets"], RB: ["rush_att", "targets"], FB: ["rush_att", "targets"], QB: ["pass_att", "handoffs"] };
export function lastGameText(c) {
  const lg = c && c.last_game;
  if (!lg) return { head: "Last Game", stats: "Unavailable", why: "Not in this data refresh yet." };
  if (lg.status === "none") return { head: "Last Game", stats: "No prior game played", why: lg.why };
  if (lg.status !== "ok") return { head: "Last Game", stats: "Unavailable", why: lg.why };
  const head = `Last Game · Week ${lg.week} ${lg.home ? "vs" : "at"} ${lg.opp_name || lg.opp}`;
  const stats = (LG_FIELDS[c.pos] || ["targets"]).map((k) => {
    if (k === "handoffs") return "Handoffs unavailable";
    const v = lg[k]; const [one, many] = LG_LABEL[k];
    return v == null ? `${many[0].toUpperCase() + many.slice(1)}: Unavailable` : `${v} ${v === 1 ? one : many}`;
  }).join(" · ");
  return { head, stats, why: c.pos === "QB" ? lg.handoffs_note : null };
}
function LastGame({ c, full }) {
  const t = lastGameText(c);
  if (!full) return <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.35 }}>{t.head}: <Box component="span" sx={{ color: "text.primary" }}>{t.stats}</Box></Typography>;
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, px: 1.25, py: 0.75 }}>
      <Typography variant="subtitle2" component="h3">{t.head}</Typography>
      <Typography variant="body2">{t.stats}</Typography>
      {t.why && <Typography variant="caption" color="text.secondary">{t.why}</Typography>}
    </Box>
  );
}
const Num = ({ children, sx }) => <Box component="span" sx={{ fontVariantNumeric: "tabular-nums", ...sx }}>{children}</Box>;
const Result = ({ r }) => <Chip size="small" variant="outlined" color={RESULT[r.state][1]} label={RESULT[r.state][0]} title={r.why} />;
const StatusChip = ({ s }) => <Chip size="small" variant="outlined" color={STATUS_COLOR[s]} label={STATUS[s]} />;
/* The results files (touchdowns, who played, the score check) didn't load: say so and offer another try. */
export const ExtrasError = () => (
  <Alert severity="error" sx={{ borderRadius: 2 }} action={<Button color="inherit" onClick={() => ensureExtras()} sx={{ minHeight: 44 }}>Try again</Button>}>
    The results didn't load. Check your connection and try again. Picks stay pending until they do.
  </Alert>
);
const Empty = ({ children }) => <Box sx={{ p: 2, border: 1, borderStyle: "dashed", borderColor: "divider", borderRadius: 2, color: "text.secondary" }}>{children}</Box>;
const H2 = ({ children, sx }) => <Typography variant="h5" component="h2" sx={sx}>{children}</Typography>;
function Fold({ title, summary, children, defaultExpanded = false, small = false, id }) {
  return (
    <Accordion disableGutters defaultExpanded={defaultExpanded} variant="outlined" sx={{ borderRadius: 2, "&:before": { display: "none" } }} data-testid={id}>
      <AccordionSummary expandIcon={<Icon d={P.expand} />} sx={{ minHeight: 56 }} aria-controls={id ? `${id}-body` : undefined} id={id ? `${id}-head` : undefined}>
        <Box><Typography variant={small ? "subtitle1" : "h6"} component="h3" sx={small ? { fontWeight: 700, lineHeight: 1.3 } : undefined}>{title}</Typography>{summary && <Typography variant="body2" color="text.secondary">{summary}</Typography>}</Box>
      </AccordionSummary>
      <AccordionDetails id={id ? `${id}-body` : undefined} sx={{ display: "grid", gap: 1.5, ...(small ? { px: 1.5 } : {}) }}>{children}</AccordionDetails>
    </Accordion>
  );
}
/* Bottom sheet. `top` (optional) stays in place above the scrolling part: the player sheet keeps its headline and its
   Pick / Parlay buttons there, so the decision never scrolls away. */
function Sheet({ open, onClose, title, children, actions, top }) {
  const pad = "max(16px, env(safe-area-inset-left, 0px))";
  return (
    <Drawer anchor="bottom" open={open} onClose={onClose} slotProps={{ paper: { sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "88vh", pb: "env(safe-area-inset-bottom, 0px)", ...(top ? { overflow: "hidden" } : {}) } } }}>
      <Box sx={{ width: 40, height: 4, borderRadius: 2, bgcolor: "divider", mx: "auto", mt: 1, flexShrink: 0 }} />
      {top && <Box data-testid="sheet-top" sx={{ px: pad, pt: 1, pb: 1.25, display: "grid", gap: 1, flexShrink: 0, maxWidth: 720, width: "100%", mx: "auto", borderBottom: 1, borderColor: "divider" }}>{top}</Box>}
      <Box data-testid="sheet-scroll" sx={{ px: pad, pt: top ? 1.5 : 1, pb: 2, display: "grid", gap: 1.5, alignContent: "start", overflowY: "auto", maxWidth: 720, width: "100%", mx: "auto", ...(top ? { flex: "1 1 auto", minHeight: 0 } : {}) }}>
        {title && <Typography variant="h6" component="h2">{title}</Typography>}
        {children}
        <Stack direction="row" sx={{ gap: 1, justifyContent: "flex-end" }}>{actions}<Button size="large" onClick={onClose}>Close</Button></Stack>
      </Box>
    </Drawer>
  );
}
export function DbNote() {
  const S = useStore();
  if (S.dbState === "ok") return null;
  const msg = { connecting: "Connecting to family picks…", slow: "Family picks can't be reached yet. Research still works.",
    off: "Sign in to Claude to make picks and see the family board.", error: "Lost the connection to the family database. Reconnecting… what you see may be out of date." }[S.dbState];
  return <Alert severity={S.dbState === "error" ? "error" : "info"} sx={{ borderRadius: 2 }}>{msg}</Alert>;
}

/* =========================== THIS WEEK =========================== */
export function WeekView() {
  const S = useStore(); const s = S.slate; const now = Date.now();
  const [how, setHow] = useState(false); const [sheet, setSheet] = useState(null); const [showLocked, setShowLocked] = useState(false);
  const games = s.games.slice().sort((a, b) => FB.etToUtcMs(a.kickoff_et) - FB.etToUtcMs(b.kickoff_et));
  const open = games.filter((g) => !FB.isLocked(g, now)); const locked = games.filter((g) => FB.isLocked(g, now));
  return (
    <Stack spacing={1.5}>
      <DbNote />
      <Box>
        <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 1 }}>
          <H2>TD Picks · Week {s.week}</H2>
          <Button size="large" startIcon={<Icon d={P.info} />} onClick={() => setHow(true)}>How this works</Button>
        </Stack>
        <Typography variant="body2" color="text.secondary">{open.length} open games · {locked.length} started or final · sportsbook prices come from {S.oddsFeed && (S.oddsFeed.rows || []).length && S.oddsFeed.week === S.slate.week ? "the FanDuel / DraftKings feed and family uploads" : "family uploads"}{S.slate.blend && S.slate.blend.enabled ? ` · ${S.slate.blend.positions.join("/")} chances combine the model with those prices when fresh` : ""}</Typography>
        <ToggleButtonGroup exclusive fullWidth size="small" value={S.weekMarket} onChange={(e, v) => v && setWeekMarket(v)} aria-label="Market" sx={{ mt: 1, "& .MuiToggleButton-root": { minHeight: 44, textTransform: "none", fontWeight: 600 } }}>
          <ToggleButton value="anytime_td">Anytime TD</ToggleButton><ToggleButton value="2plus_td">2+ TDs</ToggleButton>
        </ToggleButtonGroup>
        {S.weekMarket === "2plus_td" && <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>2+ TD chances are estimates from each player's anytime chance (checked on 2026 weeks 1–9: 90 two-TD games predicted, 98 happened). Picks you make here are 2+ TD picks.</Typography>}
      </Box>
      {open.length === 0 && <Empty>Every game this week has kicked off. The next slate appears after the Tuesday refresh.</Empty>}
      {S.uid && open.length > 0 && !Object.values(myItems()).some((p) => p.week === s.week && p.status === "submitted") && (
        <Alert severity="info" sx={{ borderRadius: 2 }}><b>No pick yet for week {s.week}.</b> Next kickoff {kick(open[0])}. Tap Pick on any player below.</Alert>
      )}
      {open.some(isWindy) && (
        <Alert severity="warning" sx={{ borderRadius: 2 }}>
          <b>Wind 15+ mph forecast:</b> {open.filter(isWindy).map((g) => `${g.away} at ${g.home} (${Math.round(g.weather.wind_mph)} mph)`).join(", ")}. Passing is harder in strong wind; pass-catchers there are tagged "Windy". The betting total usually drops with the forecast, so the chances already reflect part of it.
        </Alert>
      )}
      {open.length > 0 && <WeeklyRankings onOpen={setSheet} />}
      <Typography variant="caption" color="text.secondary">Tap a game to see every player.{s.weather_fetched_at ? ` Weather forecast as of ${et(s.weather_fetched_at, { hour: "numeric", minute: "2-digit" })}.` : ""}</Typography>
      {open.map((g) => <GameCard key={g.game_id} g={g} onOpen={setSheet} />)}
      {locked.length > 0 && (
        <Button variant="outlined" size="large" onClick={() => setShowLocked(!showLocked)}>{showLocked ? "Hide" : "Show"} {locked.length} started or final game{locked.length > 1 ? "s" : ""}</Button>
      )}
      {showLocked && locked.map((g) => <GameCard key={g.game_id} g={g} onOpen={setSheet} />)}
      <HowItWorks open={how} onClose={() => setHow(false)} />
      <PlayerSheet c={sheet} onClose={() => setSheet(null)} />
    </Stack>
  );
}

/* ---------- weather ---------- */
const isWindy = (g) => !!(g && g.weather && g.weather.windy);
const windHit = (c, g) => isWindy(g) && (c.rec_share ?? 0) >= 0.5; // mostly a pass-catcher in a 15+ mph game
function wxText(w) {
  if (!w) return null;
  if (w.roof === "dome") return "Dome";
  if (w.wind_mph == null) return w.roof === "retractable" ? "Retractable roof · no forecast yet" : "No forecast yet";
  const bits = [`Wind ${Math.round(w.wind_mph)} mph`, `${w.temp_f}°F`]; if (w.precip_pct >= 30) bits.push(`rain ${w.precip_pct}%`);
  return (w.roof === "retractable" ? "Retractable roof · " : "") + bits.join(" · ");
}
function CrewInfo({ g }) {
  const S = useStore(); const r = refFor(g); if (!r) return <Typography variant="caption" color="text.secondary" sx={{ display: "block", pb: 0.5 }}>Referee not assigned yet (admins can add it under TD Picks, Prices).</Typography>;
  const c = crewIndex(r.name); const L = S.slate.referees && S.slate.referees.league;
  const cmp = (v, l) => (v > l * 1.08 ? "above avg" : v < l * 0.92 ? "below avg" : "avg");
  return (
    <Box sx={{ pb: 0.75 }}>
      <Typography variant="caption" color="text.secondary">Referee <b>{r.name}</b>{r.source === "upload" ? ` · uploaded by ${nameOf(r.by)}` : " · NFL data"}{c ? ` · ${c.games} games since 2024` : " · no history"}</Typography>
      {c && L && <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap", mt: 0.25 }}>
        <Chip size="small" variant="outlined" label={`Flags ${c.flags.toFixed(1)}/game (${cmp(c.flags, L.flags)})`} sx={{ height: 22 }} />
        <Chip size="small" variant="outlined" label={`Holding ${c.off_holding} (${cmp(c.off_holding, L.off_holding)})`} sx={{ height: 22 }} />
        <Chip size="small" variant="outlined" label={`Coverage flags ${c.pass_coverage} (${cmp(c.pass_coverage, L.pass_coverage)})`} sx={{ height: 22 }} />
      </Stack>}
    </Box>
  );
}
function WindChip({ g }) {
  if (!isWindy(g)) return null;
  return <Chip size="small" color="warning" label={`Wind ${Math.round(g.weather.wind_mph)} mph`} sx={{ fontWeight: 700 }} />;
}

function GameCard({ g, onOpen }) {
  const focused = state.focusGame === g.game_id;                      // arrived from the Lines tab
  const [open, setOpen] = useState(focused);
  useEffect(() => { if (focused) { const el = document.querySelector(`[data-week-game="${g.game_id}"]`); if (el) setTimeout(() => el.scrollIntoView({ block: "start", behavior: "auto" }), 50); clearFocusGame(); } }, []);
  const locked = FB.isLocked(g, Date.now());
  const status = g.status === "final" ? `Final ${g.away_score}–${g.home_score}` : locked ? "Locked" : "Open";
  return (
    <Card variant="outlined" sx={{ borderRadius: 2, scrollMarginTop: 8 }} data-week-game={g.game_id}>
      <ButtonBase onClick={() => setOpen(!open)} aria-expanded={open} sx={{ display: "flex", width: "100%", textAlign: "left", px: 1.5, py: 1.25, gap: 1, minHeight: 56 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" component="h3">{g.away} at {g.home}</Typography>
          <Typography variant="body2" color="text.secondary">{kick(g)}{g.teams.every((t) => t.implied_points != null) ? ` · ${g.away} ${g.teams[0].implied_points}, ${g.home} ${g.teams[1].implied_points} pts` : ""}</Typography>
          {g.weather && <Stack direction="row" sx={{ alignItems: "center", gap: 0.75, mt: 0.25, flexWrap: "wrap" }}>
            <WindChip g={g} />
            {!isWindy(g) && <Typography variant="caption" color="text.secondary">{wxText(g.weather)}</Typography>}
            {isWindy(g) && <Typography variant="caption" color="text.secondary">{g.weather.temp_f}°F{g.weather.precip_pct >= 30 ? ` · rain ${g.weather.precip_pct}%` : ""}</Typography>}
          </Stack>}
        </Box>
        <Chip size="small" label={status} color={locked ? "default" : "primary"} variant={locked ? "outlined" : "filled"} />
        <Icon d={P.expand} sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s", color: "text.secondary" }} />
      </ButtonBase>
      <Box sx={{ px: 1.5, pb: 1.25 }}>
        {open && <CrewInfo g={g} />}
        {g.teams.map((t) => {
          const cands = t.candidates.map(effCand);
          const avail = cands.filter((c) => c.quality !== "unavailable"); const out = cands.filter((c) => c.quality === "unavailable");
          const shown = open ? avail : avail.slice(0, 1);
          return (
            <Box key={t.team} sx={{ borderTop: 1, borderColor: "divider", pt: 0.5 }}>
              {open && <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 2 }}>{t.team} · {t.implied_points != null ? `${t.implied_points} implied pts · ${t.expected_off_tds} expected TDs` : "no line yet"}</Typography>}
              {open && <OppAllowed t={t} />}
              {shown.map((c) => <PlayerRow key={c.gsis_id} c={c} g={g} locked={locked} onOpen={onOpen} team={!open} />)}
              {open && out.length > 0 && <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>Not available: {out.map((c) => `${c.full_name || c.player} (${c.injury})`).join(", ")}</Typography>}
              {open && (t.removed || []).length > 0 && <Typography variant="body2" color="text.secondary" sx={{ pb: 0.5 }}>Off the active roster: {t.removed.map((d) => `${d.player} (${d.why})`).join(", ")}</Typography>}
            </Box>
          );
        })}
      </Box>
    </Card>
  );
}

const POS_ORDER = ["RB", "WR", "TE", "QB", "FB"];
function OppAllowed({ t }) {
  const by = t.opp_td_allowed_by_pos || {}; const parts = POS_ORDER.filter((k) => by[k] > 0);
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  return (
    <Box sx={{ pb: 0.5 }}>
      <Typography variant="caption" color="text.secondary">{t.opp} defense has allowed {total} offensive TDs in {t.opp_games} games:</Typography>
      <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap", mt: 0.25 }}>
        {parts.map((k) => <Chip key={k} size="small" variant="outlined" label={`${by[k]} ${k}`} sx={{ height: 22, fontVariantNumeric: "tabular-nums" }} />)}
        {!parts.length && <Typography variant="caption" color="text.secondary">none yet</Typography>}
      </Stack>
    </Box>
  );
}

export function PickButton({ c, g, locked, size = "medium", market }) {
  const S = useStore(); const mk = market || S.weekMarket; const key = FB.pickKey(g.week, c.gsis_id, mk); const picked = !!myItems()[key]; const two = mk === "2plus_td";
  const disabled = locked || !S.uid || S.dbState === "off" || c.quality === "unavailable";
  return (
    <Button variant={picked ? "outlined" : "contained"} size={size} disabled={disabled && !picked}
      onClick={(e) => { e.stopPropagation(); picked ? (!locked && removePick(key)) : addPick(c, mk); }}
      sx={{ minWidth: 88, minHeight: 44, flexShrink: 0 }} aria-label={picked ? `Remove ${c.full_name || c.player}${two ? " 2+ TDs" : ""}` : `Pick ${c.full_name || c.player}${two ? " for 2+ TDs" : ""}`}>
      {picked ? (two ? "2+ ✓" : "Picked ✓") : two ? "Pick 2+" : "Pick"}
    </Button>
  );
}
function ParlayButton({ c, locked, size, msg }) {
  const S = useStore(); const mk = S.weekMarket; const on = inDraft(c.gsis_id, mk);
  return (
    <Button variant={on ? "contained" : "outlined"} color="secondary" disabled={(locked || c.quality === "unavailable") && !on}
      onClick={(e) => { e.stopPropagation(); toggleLeg({ ...c, game_id: c.game_id }, mk, msg); }}
      sx={{ minWidth: 0, minHeight: 44, px: 1, flexShrink: 0, fontSize: 13, lineHeight: 1.1 }} aria-label={on ? `Remove ${c.full_name || c.player} from parlay` : `Add ${c.full_name || c.player} to parlay`}>
      {on ? "✓ Parlay" : "+ Parlay"}
    </Button>
  );
}
function PlayerRow({ c, g, locked, onOpen, team }) {
  const S = useStore(); const two = S.weekMarket === "2plus_td"; const ch = chanceFor(c);
  return (
    <Stack direction="row" sx={{ alignItems: "center", gap: 1, py: 0.75 }}>
      <ButtonBase onClick={() => onOpen({ ...c, _g: g })} sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", textAlign: "left", borderRadius: 1, minHeight: 44, display: "block" }}>
        <Stack direction="row" sx={{ alignItems: "baseline", gap: 0.75, flexWrap: "wrap" }}>
          <Typography sx={{ fontWeight: 600, lineHeight: 1.25 }}>{c.full_name || c.player}</Typography>
          <Typography variant="caption" color="text.secondary">{team ? `${c.team} ` : ""}{c.pos}</Typography>
          {c.injury && <Chip size="small" color={c.quality === "unavailable" ? "error" : "warning"} variant="outlined" label={c.injury} sx={{ height: 20 }} />}
          {windHit(c, g) && <Chip size="small" color="warning" variant="outlined" label="Windy" sx={{ height: 20 }} />}
          {c.role_change && <Chip size="small" color={c.role_change.dir === "up" ? "success" : "default"} variant="outlined" label={c.role_change.dir === "up" ? "Role ↑" : "Role ↓"} sx={{ height: 20 }} />}
        </Stack>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <LinearProgress variant="determinate" value={Math.min(100, ch * 100 * (two ? 2 : 1))} sx={{ flex: 1, maxWidth: 160, height: 6, borderRadius: 3 }} aria-hidden />
          <Typography variant="body2" sx={{ fontWeight: 600 }}><Num>{pct(ch)}{two ? " est." : ""}</Num></Typography>
          <Typography variant="body2" color="text.secondary"><Num>fair {am(two || blendFor(c) ? FB.probToAmerican(ch) : c.fair_american)}</Num></Typography>
        </Stack>
        <FdDk c={c} g={g} />
        <LastGame c={c} />
      </ButtonBase>
      <ParlayButton c={c} locked={locked} />
      <PickButton c={c} g={g} locked={locked} />
    </Stack>
  );
}
function PlayerSheet({ c, onClose }) {
  const S = useStore();
  if (!c) return <Sheet open={false} onClose={onClose} />;
  const g = c._g; const locked = FB.isLocked(g, Date.now());
  const pr = priceFor(c, g.week); const e = pr ? FB.edge(c.p, pr.american) : null;
  const bl = blendFor(c); const ch = chanceFor(c, "anytime_td");
  const rows = [["Chance to score", bl ? `${pct1(ch)} · model ${pct1(bl.model)} combined with ${[...new Set(bl.books)].join(" and ")} (${pct1(bl.implied)} implied)` : pct1(ch)],
    ...(() => { const r = rangeFor(c, true); const cf = S.slate.range || {};
      return r ? [["Likely range", `${pct1(r.lo)} to ${pct1(r.hi)} (fair ${am(FB.probToAmerican(r.hi))} to ${am(FB.probToAmerican(r.lo))}) · about ${Math.round((cf.cover || 0.8) * 10)} in 10 times the sportsbooks' own chance for a player falls this close to ours${bl ? "; narrower here because the chance already includes the books' prices" : ""}. A price only beats the model clearly when its implied chance is under the low end.`]] : []; })(),
    ["Fair odds", am(bl ? FB.probToAmerican(ch) : c.fair_american)],
    ["2+ TD chance", `${pct1(FB.p2plus(ch))} (estimate from the anytime chance) · fair ${am(FB.probToAmerican(FB.p2plus(ch)))}`],
    ...(() => {   // the exchanges' no-margin chance for this player, and what each book's price costs against it
      const bd = boardFor(c, g.week, "anytime_td"); const rows = bd ? bd.books.filter((x) => x.fair_p) : [];
      if (!rows.length) return [];
      const fp = rows[0].fair_p; const n = Math.max(...rows.map((x) => x.fair_n || 1));
      return [["Fair price", `${pct1(fp)} (${am(FB.probToAmerican(fp))}) from ${n} exchange${n > 1 ? "s" : ""} that post both Yes and No, margin removed · ${rows.map((x) => { const v = FB.betValue(fp, x.american); return `${x.book} ${am(x.american)} ${v >= 0 ? `is worth +${(v * 100).toFixed(1)}%` : `costs ${Math.abs(v * 100).toFixed(1)}%`}`; }).join(" · ")} of the stake`]];
    })(),
    ["Value check price", pr ? `${pr.stale ? "Latest (over 2 h old)" : "Best fresh"}: ${pr.book} ${am(pr.american)} (implied ${pct1(e.implied)}) · ${et(pr.captured_at, { hour: "numeric", minute: "2-digit" })} · from ${nameOf(pr.uploaded_by)} · ${timeBasis(pr.time_source)}` : "No anytime price yet (add one under TD Picks, Prices)"],
    ...(e ? [["Model vs price", pr.stale
      ? `Price is over ${FB.PRICE_FRESH_MIN / 60} hours old and may no longer be available, so no EV is shown.`
      : `Model ${pct1(c.p)} vs implied ${pct1(e.implied)} (book margin included): ${e.edgePts >= 0 ? "+" : ""}${e.edgePts.toFixed(1)} percentage points. Conditional EV ${e.evPerDollar >= 0 ? "+" : "-"}$${Math.abs(e.evPerDollar).toFixed(2)} per $1 staked, only if the model's chance is right and this price is still available (its time is unverified). Unproven: in testing (weeks 3-4) sportsbook prices predicted better than the model.`]] : []),
    ["Usage", `${Math.round(c.share * 100)}% of ${c.team}'s scoring chances · ${c.i10} touches inside the 10 · ${c.games} games`],
    ...(c.team_games_2026 != null ? [
      ...(["RB", "QB"].includes(c.pos) || c.i5_carries ? [["Carries inside the 5", c.team_i5_carries ? `${c.i5_carries} of ${c.team}'s ${c.team_i5_carries} (${Math.round(100 * c.i5_carries / c.team_i5_carries)}%) · ${c.team_games_2026} games` : `None yet (${c.team} has no carries inside the 5 in 2026)`]] : []),
      ...(c.pos !== "QB" ? [["End-zone targets", c.team_ez_targets ? `${c.ez_targets} of ${c.team}'s ${c.team_ez_targets} (${Math.round(100 * c.ez_targets / c.team_ez_targets)}%)` : `None yet (${c.team} has no end-zone targets in 2026)`]] : []),
      ...(c.depth_rank ? [["Depth chart", `#${c.depth_rank} at ${c.pos} (last update before kickoff)`]] : []),
      ...(c.role_change ? [["Role change", `${c.role_change.dir === "up" ? "Up" : "Down"}: ${Math.round(c.role_change.recent * 100)}% of team carries+targets in the last 3 games vs ${Math.round(c.role_change.season * 100)}% overall`]] : []),
    ] : []),
    ...(c.proj ? [["Projection", [c.proj.rush_yds != null && `${Math.round(c.proj.rush_yds)} rush yds`, c.proj.receptions != null && `${c.proj.receptions} catches on ${c.proj.targets} targets`,
      c.proj.rec_yds != null && `${Math.round(c.proj.rec_yds)} rec yds`, c.proj.pass_yds != null && `${Math.round(c.proj.pass_yds)} pass yds`].filter(Boolean).join(" · ") + " (targets use est. routes)"]] : []),
    ["Scores by", c.rec_share != null ? `${Math.round(c.rec_share * 100)}% catching, ${Math.round((1 - c.rec_share) * 100)}% running` : "—"],
    ["Weather", wxText(g.weather) || "No forecast"]];
  // ---- headline for the market being picked (the Anytime / 2+ switch on TD Picks)
  const mk = S.weekMarket; const two = mk === "2plus_td"; const head = two ? FB.p2plus(ch) : ch; const rng = two ? null : rangeFor(c, true);
  const hp = priceFor(c, g.week, mk); const name = c.full_name || c.player;
  const boards = { anytime_td: boardFor(c, g.week, "anytime_td"), "2plus_td": boardFor(c, g.week, "2plus_td") };
  const nBooks = (boards[mk] ? boards[mk].books : []).length;
  const group = (keys) => rows.filter(([k]) => keys.includes(k));
  const DL = ({ items }) => (
    <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "minmax(110px, max-content) minmax(0,1fr)", gap: "6px 12px", m: 0 }}>
      {items.map(([k, v]) => [<Typography key={k} component="dt" variant="body2" color="text.secondary">{k}</Typography>,
        <Typography key={k + "v"} component="dd" variant="body2" sx={{ m: 0 }}>{v}</Typography>])}
    </Box>);
  return (
    <Sheet open onClose={onClose}
      actions={S.isAdmin && !locked && c.injury !== "Inactive" && <Button size="large" color="error" onClick={() => markInactive(c)}>Mark inactive</Button>}
      top={<>
        <Stack direction="row" sx={{ alignItems: "flex-start", gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h6" component="h2">{name} · {c.pos || ""} {c.team}</Typography>
            <Typography variant="body2" color="text.secondary">{g.away} at {g.home} · {kick(g)}</Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="Close player details" sx={{ width: 44, height: 44, mt: -0.5, mr: -1 }}><Icon d={P.close} /></IconButton>
        </Stack>
        <Box data-testid="sheet-headline" sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          <Box sx={{ p: 1, borderRadius: 2, bgcolor: "action.hover" }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{two ? "Chance of 2+ TDs (est.)" : "Chance to score"}</Typography>
            <Typography sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1.15 }}><Num>{pct(head)}</Num></Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}><Num>{rng ? `likely ${pct(rng.lo)} to ${pct(rng.hi)}` : `fair ${am(FB.probToAmerican(head))}`}</Num></Typography>
          </Box>
          <Box sx={{ p: 1, borderRadius: 2, bgcolor: "action.hover" }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{hp ? (hp.stale ? "Latest price (over 2 h old)" : "Best price") : "Best price"}</Typography>
            <Typography sx={{ fontSize: 26, fontWeight: 700, lineHeight: 1.15 }}><Num>{hp ? am(hp.american) : "—"}</Num></Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{hp ? `${hp.book}${nBooks > 1 ? ` · best of ${nBooks}` : ""}` : "No price yet"}</Typography>
          </Box>
        </Box>
        {locked ? <Typography variant="body2" color="text.secondary">This game has kicked off. Picks are locked.</Typography>
          : c.quality === "unavailable" ? <Typography variant="body2" color="text.secondary">Not available to pick this week.</Typography>
          : <Stack direction="row" sx={{ gap: 1 }}>
              <Button size="large" variant="outlined" color="secondary" onClick={() => addLeg({ ...c, game_id: g.game_id }, mk)} sx={{ flex: 1, px: 1 }}>Add to parlay{two ? " (2+)" : ""}</Button>
              <Box sx={{ flex: 1, display: "flex", "& > button": { flex: 1 } }}><PickButton c={c} g={g} locked={locked} size="large" /></Box>
            </Stack>}
        {!S.uid && !locked && <Typography variant="caption" color="text.secondary">Sign in to Claude to pick.</Typography>}
      </>}>
      {windHit(c, g) && <Alert severity="warning" sx={{ borderRadius: 2 }}>Wind {Math.round(g.weather.wind_mph)} mph forecast. Most of {name}'s touchdown chances come from catches, and passing is harder in strong wind.</Alert>}
      {c.injury && <Alert severity={c.quality === "unavailable" ? "error" : "warning"} sx={{ borderRadius: 2 }}>{c.injury}{c.override ? ` (set by an admin${c.override.note ? `: ${c.override.note}` : ""})` : " on the injury report"}</Alert>}
      <Typography variant="body2" data-testid="sheet-why"><b>Why:</b> {c.main_reason || c.reason}</Typography>
      <Fold small id="ps-prices" title="Prices by sportsbook" defaultExpanded summary={boards.anytime_td ? `${boards.anytime_td.books.length} book${boards.anytime_td.books.length > 1 ? "s" : ""} for anytime TD${boards["2plus_td"] ? `, ${boards["2plus_td"].books.length} for 2+ TDs` : ""}` : "No prices yet"}>
        {["anytime_td", "2plus_td"].map((m) => (
          <Box key={m} sx={{ display: "grid", gap: 0.5 }}>
            <Typography variant="subtitle2" component="h4">{MARKETS[m]} prices by sportsbook</Typography>
            <BookList c={c} g={g} market={m} />
          </Box>
        ))}
        <Typography variant="caption" color="text.secondary">Green = best price, red = worst. ▲ the price pays more than its first price this week, ▼ it pays less ("big" = 2+ points of implied chance). Value math uses only prices under 2 hours old. <Box component="span" sx={{ color: "secondary.main", fontWeight: 700 }}>Above fair</Box> = an anytime price under 2 hours old whose implied chance is {FB.ABOVE_FAIR_PTS}+ points below the model's chance (the book pays clearly more than fair odds). It's the model's view, not a proven edge: in testing, sportsbook prices predicted better than the model.</Typography>
      </Fold>
      <Fold small id="ps-chance" title="Chance and value" summary={`Fair odds ${am(bl ? FB.probToAmerican(ch) : c.fair_american)}${bl ? " · model and prices combined" : " · model only"}`}>
        <DL items={group(["Chance to score", "Likely range", "Fair odds", "2+ TD chance", "Fair price", "Value check price", "Model vs price"])} />
      </Fold>
      <Fold small id="ps-usage" title="Usage and role" summary={`${Math.round(c.share * 100)}% of ${c.team}'s scoring chances · ${c.i10} touches inside the 10`}>
        <LastGame c={c} full />
        <DL items={group(["Usage", "Carries inside the 5", "End-zone targets", "Depth chart", "Role change", "Projection", "Scores by"])} />
      </Fold>
      <Fold small id="ps-matchup" title="Matchup and risks" summary={wxText(g.weather) || "No forecast"}>
        <Typography variant="body2"><b>Biggest uncertainty:</b> {c.uncertainty || c.risk}</Typography>
        {c.matchup_why && <Typography variant="body2"><b>Matchup:</b> {c.matchup_why}</Typography>}
        <DL items={group(["Weather"])} />
      </Fold>
    </Sheet>
  );
}

function Slates() {
  const S = useStore(); const [by, setBy] = useState("chance");
  const open = S.slate.games.filter((g) => !FB.isLocked(g, Date.now()));
  const cands = open.flatMap((g) => g.teams.flatMap((t) => t.candidates)).map(effCand);
  const defs = [[3, "game", "3-leg"], [5, "game", "5-leg"], [7, "game", "7-leg"], [10, "team", "10-leg (one per team)"], [open.length, "game", "Full week"]];
  const m = by === "matchup";
  const gmap = Object.fromEntries(open.map((g) => [g.game_id, g]));
  const legTxt = (l) => (m ? `${l.full_name || l.player} ${pct(l.p)}→${pct(l.p_matchup)}` : `${l.full_name || l.player} ${pct(l.p)}`) + (windHit(l, gmap[l.game_id]) ? " (windy)" : "");
  return (
    <>
      <ToggleButtonGroup exclusive fullWidth size="small" value={by} onChange={(e, v) => v && setBy(v)} sx={{ "& .MuiToggleButton-root": { minHeight: 44, textTransform: "none" } }}>
        <ToggleButton value="chance">Highest chance</ToggleButton><ToggleButton value="matchup">Best matchup</ToggleButton>
      </ToggleButtonGroup>
      <Typography variant="body2" color="text.secondary">{m
        ? "Players whose chance goes up most against this week's defense (by position allowed and charted coverage), counting only players at 15% or better after the matchup. One per game (10-leg: one per team). Matchup boosts haven't beaten the main odds in testing yet, so treat these as research."
        : "Highest chances first, one player per game (10-leg: one per team)."} The combined chance is a model estimate; sportsbook parlay odds are never quoted.</Typography>
      {defs.filter(([n]) => n).map(([n, rule, label]) => {
        const s = FB.suggestSlate(cands, n, rule, { by });
        if (m && label === "Full week" && s.legs.length < 2) return null;
        return (
          <Box key={label} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, display: "grid", gap: 0.5 }}>
            <Stack direction="row" sx={{ justifyContent: "space-between", gap: 1 }}><Typography sx={{ fontWeight: 600 }}>{label}</Typography>
              <Num>all hit: {m ? `${odds1(s.jointP)} → ${odds1(s.jointMatchupP)}` : odds1(s.jointP)}</Num></Stack>
            {s.short > 0 && <Typography variant="body2" color="error">Only {s.legs.length} of {n} legs {m ? "have a matchup boost" : "available"}.</Typography>}
            <Typography variant="body2">{s.legs.map(legTxt).join(" · ") || "—"}</Typography>
            {m && s.legs.length > 0 && <Typography variant="caption" color="text.secondary">Boosts: {s.legs.map((l) => `+${Math.round(l.matchup_pct)}%`).join(", ")}</Typography>}
            {rule === "team" && <Typography variant="caption" color="text.secondary">{s.jointNote}</Typography>}
            {s.legs.length >= 2 && <Box><Button variant="outlined" onClick={() => { setDraft(s.legs); toast(`Loaded ${s.legs.length} legs into your builder.`); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Use in my builder</Button></Box>}
          </Box>
        );
      })}
    </>
  );
}
function Matchups({ onOpen }) {
  const S = useStore();
  const open = S.slate.games.filter((g) => !FB.isLocked(g, Date.now()));
  const cands = open.flatMap((g) => g.teams.flatMap((t) => t.candidates.map((c) => ({ ...effCand(c), _g: g }))))
    .filter((c) => c.quality !== "unavailable" && c.p_matchup != null && c.p >= 0.08);
  const up = cands.slice().sort((a, b) => b.matchup_pct - a.matchup_pct).slice(0, 6);
  const down = cands.slice().sort((a, b) => a.matchup_pct - b.matchup_pct).slice(0, 4);
  const Row = ({ c }) => (
    <ButtonBase onClick={() => onOpen(c)} sx={{ display: "flex", justifyContent: "space-between", textAlign: "left", gap: 1, py: 1, minHeight: 44, borderBottom: 1, borderColor: "divider", width: "100%" }}>
      <Box sx={{ minWidth: 0 }}><Typography sx={{ fontWeight: 600 }}>{c.full_name || c.player} <Typography component="span" variant="caption" color="text.secondary">{c.team} {c.pos}</Typography></Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{c.matchup_why}</Typography></Box>
      <Num sx={{ fontWeight: 600, color: c.matchup_pct > 0 ? "success.main" : "error.main", whiteSpace: "nowrap" }}>{pct(c.p)} → {pct(c.p_matchup)}</Num>
    </ButtonBase>
  );
  return (
    <>
      <Typography variant="body2" color="text.secondary">How each opponent has allowed touchdowns by position and its charted coverage. In testing this hasn't beaten the main odds yet, so it is shown for research only.</Typography>
      <Typography variant="subtitle2">Biggest boosts</Typography>{up.map((c) => <Row key={c.gsis_id} c={c} />)}
      <Typography variant="subtitle2" sx={{ mt: 1 }}>Biggest cuts</Typography>{down.map((c) => <Row key={c.gsis_id} c={c} />)}
    </>
  );
}
const VARIANT_LABEL = { usage_v03c: "v0.3c: team TDs x workload + goal-line + depth chart + TD rate", baseline: "Usage share + betting total", recency: "+ recency weighting", recency_skill: "+ player skill (Poisson-Gamma)", recency_skill_kalman: "+ Kalman team filter",
  full: "All enhancements + calibration", baseline_calibrated: "Usage share + calibration", matchup_pos: "+ position matchups", matchup_pos_cov: "+ position matchups and coverage" };
function HowItWorks({ open, onClose }) {
  const S = useStore(); const v = S.validation; const s = S.slate; const gate = FB.modelValidated(v);
  const full = useMediaQuery("(max-width:600px)");
  return (
    <Dialog open={open} onClose={onClose} fullScreen={full} fullWidth maxWidth="md" scroll="paper">
      <DialogTitle>How this works</DialogTitle>
      <DialogContent dividers sx={{ display: "grid", gap: 1.5 }}>
        <Typography variant="body2">Each player's chance to score starts from the touchdowns the betting line expects from his team, then his share of the team's carries and targets (2026, with 2025 at half weight), his goal-line role (RBs and QBs: carries inside the 5, goal-to-go carries, QB designed runs and sneaks), his depth-chart spot before kickoff, and his own touchdown rate. The weights are refit every refresh on every game already played. Players must be on their team's active roster. "Fair odds" is that chance written as American odds.</Typography>
        {v.v03 && <Alert severity="info" sx={{ borderRadius: 2 }}>Model {v.v03.model}, adopted after a week-by-week test on 2026 weeks 1–9 ({v.v03.n.toLocaleString()} player-games). Against the previous model on weeks {v.v03.vs_previous.weeks} it improved log loss by {(v.v03.vs_previous.ll_gain * 1000).toFixed(1)}×10⁻³ per player-game (90% range {(v.v03.vs_previous.ci90[0] * 1000).toFixed(1)}–{(v.v03.vs_previous.ci90[1] * 1000).toFixed(1)}), better for every position. Against {v.v03.market.book} prices on weeks {v.v03.market.weeks} ({v.v03.market.n} player-games), the sportsbook's own implied chances (margin included) predicted better than the model{v.v03.market.log_loss_market_raw != null ? `: log loss ${v.v03.market.log_loss_market_raw.toFixed(3)} vs ${v.v03.market.log_loss_model.toFixed(3)}` : ""}. A profitable edge has not been shown.</Alert>}
        <Alert severity="warning" sx={{ borderRadius: 2 }}>Research only. "Value Play" stays off until the model passes its checks{gate.ok ? "" : ` (${gate.reasons.length} still open)`} and real sportsbook prices are imported. A week with no value plays is normal.</Alert>
        <LiveRecord />
        {s.wind_study && <>
          <Typography variant="subtitle2">Wind</Typography>
          <Typography variant="body2" color="text.secondary">Outdoor games with a 15+ mph kickoff forecast are flagged, and pass-catchers there are tagged "Windy". We checked {s.wind_study.outdoor_team_games.toLocaleString()} outdoor team-games ({s.wind_study.seasons}). Passing touchdowns do drop in strong wind, but the betting total drops with the forecast too, and the model builds every team's touchdowns from that total. Shifting chances further from passing to rushing made predictions worse when tested on seasons it wasn't fitted to, so chances are not changed for wind.</Typography>
          <TableContainer><Table size="small">
            <TableHead><TableRow>{["Wind", "Team-games", "Pass TDs", "Rush TDs", "Line (pts)"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
            <TableBody>{s.wind_study.bands.map((b) => <TableRow key={b.band}><TableCell>{b.band} mph</TableCell><TableCell><Num>{b.team_games}</Num></TableCell><TableCell><Num>{b.pass_td}</Num></TableCell><TableCell><Num>{b.rush_td}</Num></TableCell><TableCell><Num>{b.implied_pts}</Num></TableCell></TableRow>)}</TableBody>
          </Table></TableContainer>
        </>}
        <Typography variant="subtitle2">Not connected yet</Typography>
        <Typography variant="body2" color="text.secondary">{s.missing.join("; ")}.</Typography>
        <Typography variant="subtitle2">How the model was tested</Typography>
        <Typography variant="body2" color="text.secondary">Every method predicts each past week using only earlier weeks. A method goes live only when it beats the current model across 90% of resampled games and is no worse for any position. The table below is the earlier round of add-ons (2026-only history, weeks 4 on); none of them beat the plain usage model. Live now: <b>{VARIANT_LABEL[v.chosen] || v.chosen}</b>.</Typography>
        {v.variants && (
          <TableContainer><Table size="small">
            <TableHead><TableRow>{["Method", "Gain ×1000 (90% range)", "Status"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
            <TableBody>{Object.entries(v.variants).sort((a, b) => a[1].log_loss - b[1].log_loss).map(([k, x]) => (
              <TableRow key={k} selected={k === v.chosen}><TableCell>{VARIANT_LABEL[k] || k}</TableCell>
                <TableCell><Num>{x.ll_gain_ci90 ? `${(x.ll_gain * 1000).toFixed(1)} (${(x.ll_gain_ci90[0] * 1000).toFixed(1)} to ${(x.ll_gain_ci90[1] * 1000).toFixed(1)})` : "reference"}</Num></TableCell>
                <TableCell>{k === v.chosen ? "Live" : k === "baseline" ? "Reference" : "Not proven"}</TableCell></TableRow>))}</TableBody>
          </Table></TableContainer>
        )}
        {!gate.ok && <Typography variant="caption" color="text.secondary">Open checks: {gate.reasons.join(" ")}</Typography>}
      </DialogContent>
      <DialogActions><Button size="large" onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

/* =========================== TOUCHDOWNS =========================== */
const blankF = { week: "latest", team: "", def: "", type: "", status: "", scorer: "", defender: "", game: "" };
export function TouchdownsView() {
  const S = useStore(); const [f, setF] = useState(blankF); const [filters, setFilters] = useState(false); const [play, setPlay] = useState(null);
  const [limit, setLimit] = useState(30); const [csvText, setCsvText] = useState(null);
  if (!S.extrasLoaded) return S.extrasError ? <ExtrasError /> : <Empty>Loading the season's touchdowns…</Empty>;
  const weeks = [...new Set(S.tds.map((t) => t.week))].sort((a, b) => a - b);
  const settled = weeks.filter((w) => { const g = S.games.filter((x) => x.week === w); return g.length && g.filter((x) => x.status === "final").length * 2 >= g.length; });
  const wk = f.week === "latest" ? (settled.length ? settled[settled.length - 1] : S.meta.latest_final_week) : f.week;
  const q = (s) => String(s || "").toLowerCase();
  const rows = S.tds.filter((t) => {
    const a = effAttr(t);
    return (wk === "all" || t.week === +wk) && (!f.game || t.game_id === f.game) && (!f.team || t.team === f.team) && (!f.def || t.opp === f.def)
      && (!f.type || t.type === f.type) && (!f.status || a.status === f.status) && (!f.scorer || q(t.scorer).includes(q(f.scorer)))
      && (!f.defender || (a.defenders || []).concat(a.candidates || []).some((d) => q(d.name).includes(q(f.defender))));
  });
  const active = ["team", "def", "type", "status", "scorer", "defender", "game"].filter((k) => f[k]).length;
  return (
    <Stack spacing={1.5}>
      <H2>TD Log</H2>
      <ResultsStatus />
      <LivePanel />
      <Box sx={{ overflowX: "auto", mx: -0.5, px: 0.5, pb: 0.5 }}>
        <ToggleButtonGroup exclusive size="small" value={String(wk)} onChange={(e, v) => { if (v) { setF({ ...f, week: v === "all" ? "all" : +v, game: "" }); setLimit(30); } }}
          sx={{ "& .MuiToggleButton-root": { minWidth: 48, minHeight: 44, px: 1.5 } }}>
          {weeks.slice().reverse().map((w) => <ToggleButton key={w} value={String(w)}>Wk {w}</ToggleButton>)}
          <ToggleButton value="all">All</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      {wk !== "all" && <WeekGlance w={+wk} pickGame={(gid) => setF({ ...f, game: f.game === gid ? "" : gid })} game={f.game} />}
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Typography variant="h6" component="h3" sx={{ flex: 1 }}>{rows.length} touchdown{rows.length === 1 ? "" : "s"}</Typography>
        {active > 0 && <Button onClick={() => setF({ ...blankF, week: f.week })}>Clear</Button>}
        <Button variant="outlined" size="large" startIcon={<Icon d={P.filter} />} onClick={() => setFilters(true)}>Filter{active ? ` (${active})` : ""}</Button>
      </Stack>
      {rows.slice(0, limit).map((t) => <PlayCard key={t.key} t={t} onOpen={() => setPlay(t)} />)}
      {rows.length > limit && <Button variant="outlined" size="large" onClick={() => setLimit(limit + 50)}>Show more ({rows.length - limit} left)</Button>}
      {rows.length === 0 && <Empty>No touchdowns match these filters.</Empty>}
      <Fold title="Pre-game reads, weeks 1-10" summary="Each game as it looked before kickoff (results not shown)"><PregameReads /></Fold>
      <Fold title="Defender leaderboard" summary="Receiving TDs allowed, from Pro Football Reference charting"><Leaderboard /></Fold>
      <Fold title="Defender credits on these plays" summary="Only where charting points to one defender"><Defenders rows={rows} open={setPlay} /></Fold>
      <Fold title="About this data" summary="Checks against official scores, and attribution coverage by week"><Coverage /></Fold>
      <FilterSheet open={filters} onClose={() => setFilters(false)} f={f} setF={setF} onExport={async () => setCsvText(await exportCsv(rows))} />
      {play && <PlayDialog t={play} onClose={() => setPlay(null)} />}
      <Dialog open={!!csvText} onClose={() => setCsvText(null)} fullWidth maxWidth="md">
        <DialogTitle>Copy CSV</DialogTitle>
        <DialogContent><Typography variant="body2" sx={{ mb: 1 }}>Downloads aren't available here. Copy the rows below.</Typography>
          <TextField multiline minRows={8} fullWidth value={csvText || ""} slotProps={{ input: { readOnly: true, sx: { fontFamily: "var(--fb-mono)", fontSize: 12 } } }} /></DialogContent>
        <DialogActions>
          <Button size="large" onClick={() => navigator.clipboard.writeText(csvText).then(() => toast("Copied.")).catch(() => toast("Select the text and copy it."))}>Copy</Button>
          <Button size="large" onClick={() => setCsvText(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
/* "Postgame results": the last successful source check and the last time results changed, both in ET, with a
   Refresh results button that runs the same backend refresh as the hourly job. Current results stay on screen. */
function ResultsStatus() {
  const S = useStore(); const m = S.meta; if (!m) return null;
  const now = Date.now(); const last = Date.parse(m.refreshed_at); const ago = Math.round((now - last) / 60000);
  const inWindow = S.games.some((g) => { const k = FB.etToUtcMs(g.kickoff_et); return now >= k && now - k <= 9 * 3600e3; });
  const live = S.games.filter((g) => g.status !== "final" && FB.isLocked(g, now)).length;
  const liveOn = liveStatus(now).active;
  const busy = !!(S.refresh && S.refresh.busy); const t = { weekday: "short", hour: "numeric", minute: "2-digit" };
  return (
    <Alert severity={inWindow && ago > 75 ? "warning" : "info"} icon={false} sx={{ borderRadius: 2 }}>
      <Typography variant="subtitle2" component="h3">{m.feed || "Postgame results"}</Typography>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap", mt: 0.25 }}>
        <Typography variant="body2" sx={{ flex: 1, minWidth: 180 }}>
          Last successful check: <b>{et(m.refreshed_at, t)}</b> ({ago < 1 ? "just now" : ageTxt(ago)})<br />
          Results last changed: <b>{m.results_changed_at ? et(m.results_changed_at, t) : "Unavailable until the next check"}</b>
        </Typography>
        <Button variant="outlined" size="small" disabled={busy} onClick={() => manualRefresh()} sx={{ minHeight: 40, flexShrink: 0 }}>{busy ? "Checking…" : "Refresh results"}</Button>
      </Stack>
      {S.refresh && S.refresh.msg && <Typography variant="body2" role="status" sx={{ mt: 0.5, fontWeight: 600 }}>{S.refresh.msg}</Typography>}
      <Typography variant="caption" sx={{ display: "block", mt: 0.5 }}>
        Source: {m.td_source || "nflverse play-by-play, published after each game ends"}.
        {live > 0 && (liveOn
          ? ` ${live} game${live > 1 ? "s are" : " is"} in progress: live touchdowns appear below as the live feed publishes them; final results are verified after each game.`
          : ` ${live} game${live > 1 ? "s are" : " is"} in progress: touchdowns appear after the game ends and the source publishes them.`)}
        {inWindow && ago > 75 && " Results may be delayed: the latest check hasn't come through. These are the last successful results."}
        {" "}Picks and parlay legs settle only after a final game's touchdowns match the official score and each scorer matches the weekly player stats.
      </Typography>
    </Alert>
  );
}
function WeekGlance({ w, pickGame, game }) {
  const S = useStore();
  const tds = S.tds.filter((t) => t.week === w); const games = S.games.filter((g) => g.week === w);
  const finals = games.filter((g) => g.status === "final");
  const by = {}; tds.forEach((t) => { if (t.scorer_id) (by[t.scorer_id] ||= { n: 0, name: t.scorer, team: t.team }).n++; });
  const repeat = Object.values(by).filter((x) => x.n > 1).sort((a, b) => b.n - a.n);
  const recOk = finals.filter((g) => S.recon[g.game_id] && S.recon[g.game_id].reconciled).length;
  const tiles = [["Touchdowns", tds.length], ["Games final", `${finals.length}/${games.length}`], ["Match official scores", `${recOk}/${finals.length}`], ["Defender known", tds.filter((t) => ["verified_individual", "probable_individual"].includes(effAttr(t).status)).length]];
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ display: "grid", gap: 1.25, p: 1.5, "&:last-child": { pb: 1.5 } }}>
      <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
        {tiles.map(([k, v]) => <Box key={k}><Typography sx={{ fontFamily: "var(--fb-display)", fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}><Num>{v}</Num></Typography><Typography variant="caption" color="text.secondary">{k}</Typography></Box>)}
      </Box>
      {repeat.length > 0 && <Typography variant="body2"><b>Multiple TDs:</b> {repeat.map((r) => `${r.name} ${r.n}`).join(" · ")}</Typography>}
      <Typography variant="caption" color="text.secondary">Tap a final game to see only its touchdowns.</Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
        {games.slice().sort((a, b) => FB.etToUtcMs(a.kickoff_et) - FB.etToUtcMs(b.kickoff_et)).map((g) => {
          if (g.status !== "final") {
            const started = FB.isLocked(g, Date.now()); const lv = S.live.games[g.game_id];
            if (started && lv) return <Chip key={g.game_id} variant="outlined" color="error" label={`${g.away} ${lv.away_score ?? "–"} · ${g.home} ${lv.home_score ?? "–"} · Live (provisional)`} sx={{ height: 40 }} />;
            return <Chip key={g.game_id} variant="outlined" label={`${g.away} at ${g.home} · ${started ? "In progress: results after the game" : kick(g)}`} sx={{ height: 40, color: "text.secondary" }} />;
          }
          const rec = S.recon[g.game_id]; const waiting = rec && rec.awaiting_source;
          const held = rec && !waiting && (!rec.reconciled || rec.scorers_verified === false);
          const note = waiting ? " · touchdowns not published yet" : held ? " · held for review" : !rec ? " · reconciling" : rec.scorers_verified !== true ? " · verifying scorers" : "";
          return <Chip key={g.game_id} clickable onClick={() => pickGame(g.game_id)} color={game === g.game_id ? "primary" : held ? "warning" : "default"} variant={game === g.game_id ? "filled" : "outlined"}
            label={`${g.away} ${g.away_score} · ${g.home} ${g.home_score} · Final${note}`} sx={{ height: 40 }} />;
        })}
      </Box>
    </CardContent></Card>
  );
}
function PlayCard({ t, onOpen }) {
  const S = useStore(); const a = effAttr(t);
  const nGame = t.scorer_id ? S.tds.filter((x) => x.game_id === t.game_id && x.scorer_id === t.scorer_id).length : 1;
  return (
    <ButtonBase onClick={onOpen} sx={{ display: "block", textAlign: "left", border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, bgcolor: "background.paper" }}>
      <Stack direction="row" sx={{ alignItems: "baseline", gap: 1 }}>
        <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>{t.scorer || "Team"} <Typography component="span" variant="caption" color="text.secondary">{t.scorer_pos} {t.team}</Typography></Typography>
        <Typography variant="body2" color="text.secondary"><Num>Wk {t.week} · Q{t.qtr} {t.clock}</Num></Typography>
      </Stack>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 0.5, flexWrap: "wrap" }}>
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{TYPE[t.type]}{t.yards != null ? `, ${t.yards} yds` : ""} vs {t.opp}{(a.defenders || []).length ? ` · on ${a.defenders.map((d) => d.name).join(", ")}` : ""}</Typography>
        {nGame > 1 && <Chip size="small" color="secondary" label={`${nGame} TDs this game`} />}
        <StatusChip s={a.status} />
      </Stack>
    </ButtonBase>
  );
}
function FilterSheet({ open, onClose, f, setF, onExport }) {
  const S = useStore(); const teams = [...new Set(S.tds.map((t) => t.team))].sort();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const sel = (k, label, opts) => <TextField select fullWidth label={label} value={f[k]} onChange={set(k)}>{opts.map(([v, l]) => <MenuItem key={v} value={v} sx={{ minHeight: 44 }}>{l}</MenuItem>)}</TextField>;
  return (
    <Sheet open={open} onClose={onClose} title="Filter touchdowns" actions={<Button size="large" onClick={onExport}>Export CSV</Button>}>
      <Box sx={{ display: "grid", gap: 1.5, gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(3, 1fr)" } }}>
        {sel("team", "Scoring team", [["", "Any"], ...teams.map((t) => [t, t])])}
        {sel("def", "Against", [["", "Any"], ...teams.map((t) => [t, t])])}
        {sel("type", "Type", [["", "Any"], ...Object.entries(TYPE)])}
        {sel("status", "Defender credit", [["", "Any"], ...Object.entries(STATUS)])}
        <TextField label="Scorer" value={f.scorer} onChange={set("scorer")} />
        <TextField label="Defender" value={f.defender} onChange={set("defender")} />
      </Box>
      <Button onClick={() => setF({ ...blankF, week: f.week })}>Clear filters</Button>
    </Sheet>
  );
}
function Leaderboard() {
  const S = useStore(); const d = S.defenders; const [sort, setSort] = useState("td"); const [team, setTeam] = useState("");
  if (!d) return <Empty>Not available.</Empty>;
  const rated = d.rows.filter((r) => r.td_per100 != null && (!team || r.team === team));
  const key = { td: (r) => -r.td || r.targets, rate: (r) => -r.td_per100, cmp: (r) => -r.cmp_pct, ypt: (r) => -r.yds_per_tgt }[sort];
  const rows = rated.slice().sort((a, b) => key(a) - key(b)).slice(0, 20);
  const teams = [...new Set(d.rows.map((r) => r.team))].sort();
  return (
    <>
      <Typography variant="body2" color="text.secondary">Through week {d.through_week}. Credit is the charter's call, not assignment data. Only defenders with {d.min_targets}+ targets.</Typography>
      <Stack direction="row" sx={{ gap: 1 }}>
        <TextField select size="small" label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)} sx={{ flex: 1 }}>
          <MenuItem value="td">TDs allowed</MenuItem><MenuItem value="rate">TDs per 100 targets</MenuItem><MenuItem value="cmp">Catch rate allowed</MenuItem><MenuItem value="ypt">Yards per target</MenuItem>
        </TextField>
        <TextField select size="small" label="Team" value={team} onChange={(e) => setTeam(e.target.value)} sx={{ width: 110 }}>
          <MenuItem value="">All</MenuItem>{teams.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
        </TextField>
      </Stack>
      {rows.map((r, i) => (
        <Stack key={r.pfr_id} direction="row" sx={{ gap: 1, alignItems: "center", py: 0.75, borderBottom: 1, borderColor: "divider" }}>
          <Typography variant="body2" color="text.secondary" sx={{ width: 22 }}><Num>{i + 1}</Num></Typography>
          <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontWeight: 600 }} noWrap>{r.name} <Typography component="span" variant="caption" color="text.secondary">{r.team}</Typography></Typography>
            <Typography variant="caption" color="text.secondary"><Num>{r.targets} targets · {r.cmp_pct}% caught · {r.yds_per_tgt} yds/tgt · {r.ints} INT</Num></Typography></Box>
          <Box sx={{ textAlign: "right" }}><Typography sx={{ fontWeight: 700 }}><Num>{r.td} TD</Num></Typography><Typography variant="caption" color="text.secondary"><Num>{r.td_per100}/100</Num></Typography></Box>
        </Stack>
      ))}
    </>
  );
}
function Defenders({ rows, open }) {
  const agg = {};
  for (const t of rows) { const a = effAttr(t);
    for (const d of a.defenders || []) { const x = (agg[d.gsis_id || d.pfr_id || d.name] ||= { name: d.name, team: d.team, pos: d.position, plays: [] }); x.plays.push(t); } }
  const list = Object.values(agg).sort((a, b) => b.plays.length - a.plays.length).slice(0, 20);
  if (!list.length) return <Empty>No credited defenders in this view.</Empty>;
  return list.map((x) => (
    <Box key={x.name + x.team} sx={{ py: 0.75, borderBottom: 1, borderColor: "divider" }}>
      <Typography sx={{ fontWeight: 600 }}>{x.name} <Typography component="span" variant="caption" color="text.secondary">{x.team} {x.pos} · {x.plays.length} TD</Typography></Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>{x.plays.slice(0, 6).map((t) => <Chip key={t.key} size="small" clickable onClick={() => open(t)} label={`Wk ${t.week} ${t.scorer}`} sx={{ height: 32 }} />)}</Box>
    </Box>
  ));
}
function Coverage() {
  const S = useStore(); const keys = ["verified_individual", "probable_individual", "shared", "team_unit", "unknown"];
  return (
    <>
      <Typography variant="body2" color="text.secondary">"Matches official" means each team's touchdowns, kicks, conversions and safeties add up to the official final score. Defender credit uses charting only. Not connected: {S.meta.not_connected.join("; ")}.</Typography>
      {S.weekly.filter((w) => w.final > 0).map((w) => {
        const t = S.tds.filter((x) => x.week === w.week).map(effAttr);
        return (
          <Box key={w.week} sx={{ py: 0.75, borderBottom: 1, borderColor: "divider" }}>
            <Typography sx={{ fontWeight: 600 }}>Week {w.week} <Typography component="span" variant="body2" color="text.secondary"><Num>· {w.td_plays} TDs · {w.reconciled}/{w.final} games match official</Num></Typography></Typography>
            <Typography variant="caption" color="text.secondary"><Num>{keys.map((s) => `${STATUS[s]} ${t.filter((a) => a.status === s).length}`).join(" · ")}</Num></Typography>
          </Box>
        );
      })}
    </>
  );
}
export function PlayDialog({ t, onClose }) {
  const S = useStore(); const a = effAttr(t); const g = S.gameById[t.game_id]; const full = useMediaQuery("(max-width:600px)");
  return (
    <Dialog open onClose={onClose} fullScreen={full} fullWidth maxWidth="md" scroll="paper">
      <DialogTitle>{t.scorer || "Team"} · {TYPE[t.type]} TD</DialogTitle>
      <DialogContent dividers sx={{ display: "grid", gap: 1.5 }}>
        <Typography variant="body2">{g.away} at {g.home}, week {t.week} · Q{t.qtr} {t.clock} · {t.team} vs {t.opp}{t.passer ? ` · thrown by ${t.passer}` : ""}{t.yards != null ? ` · ${t.yards} yards` : ""}</Typography>
        <Typography variant="body2" sx={{ fontFamily: "var(--fb-mono)", color: "text.secondary" }}>{t.desc}</Typography>
        <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}><Typography variant="h6" component="h3">Who was responsible</Typography><StatusChip s={a.status} /></Stack>
        {(a.defenders || []).map((d, i) => (
          <Box key={i} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, display: "grid", gap: 0.5 }}>
            <Typography sx={{ fontWeight: 600 }}>{d.name} · {d.team} {d.position || ""} · {String(d.role || "").replace(/_/g, " ")}</Typography>
            <Typography variant="body2"><b>Observed:</b> {d.observed || "—"}</Typography>
            <Typography variant="body2"><b>Inferred:</b> {d.inferred || "—"}</Typography>
            {(d.evidence || []).map((e, j) => <Typography key={j} variant="caption" color="text.secondary">Evidence: {e.source}{e.detail ? " · " + e.detail : ""}</Typography>)}
          </Box>
        ))}
        {(a.candidates || []).length > 0 && (
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5 }}>
            <Typography sx={{ fontWeight: 600 }}>Charted that game (not tied to this play)</Typography>
            {a.candidates.map((c) => <Typography key={c.pfr_id || c.name} variant="body2">{c.name} ({c.position || "?"}): {c.td_allowed_in_game} TD allowed, {c.targets_in_game ?? "?"} targets</Typography>)}
          </Box>
        )}
        <Typography variant="body2"><b>What's missing:</b> {a.missing || "—"}</Typography>
        {a.reviewed && <Typography variant="body2" color="text.secondary">Reviewed by an admin {et(a.reviewed.updated_at)}. {a.reviewed.note}</Typography>}
        {S.isAdmin && <ReviewForm t={t} a={a} onDone={onClose} />}
        <Accordion disableGutters variant="outlined" sx={{ borderRadius: 2, "&:before": { display: "none" } }}>
          <AccordionSummary expandIcon={<Icon d={P.expand} />}><Typography variant="body2">Source and checks</Typography></AccordionSummary>
          <AccordionDetails sx={{ display: "grid", gap: 0.5 }}>
            <Typography variant="body2">{t.reconciled ? "This game's touchdowns match the official final score." : "Not yet matched to the official score."}</Typography>
            <Typography variant="body2" color="text.secondary">Source: {t.source} · play {t.game_id} / {t.play_id} · checked {et(t.verified_at, { hour: "numeric", minute: "2-digit" })}</Typography>
            {a.reviewed && (a.reviewed.history || []).map((x, i) => <Typography key={i} variant="caption" color="text.secondary">{et(x.at)}: {STATUS[x.status] || x.status} · {x.note || ""}</Typography>)}
          </AccordionDetails>
        </Accordion>
      </DialogContent>
      <DialogActions><Button size="large" onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
const ROLES = ["primary_coverage", "zone_responsibility", "safety_help", "missed_tackle_after_catch", "missed_tackle", "lost_edge", "run_fit", "return_coverage", "other"];
function ReviewForm({ t, a, onDone }) {
  const [v, setV] = useState({ status: a.status, role: (a.defenders && a.defenders[0] && a.defenders[0].role) || "primary_coverage",
    names: (a.defenders || []).map((d) => d.name).join(", "), obs: "", inf: "", ev: "", miss: a.missing || "" });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  async function save() {
    const names = v.names.split(",").map((s) => s.trim()).filter(Boolean);
    if (["verified_individual", "probable_individual", "shared"].includes(v.status) && !names.length) { toast("Name at least one defender for that status."); return; }
    if (v.status === "verified_individual" && !v.ev.trim()) { toast("Verified needs a cited chart or film timestamp."); return; }
    const ok = await saveReview(t, { status: v.status, missing: v.miss, note: v.obs.slice(0, 140),
      defenders: names.map((n) => ({ name: n, team: t.opp, role: v.role, observed: v.obs, inferred: v.inf, evidence: v.ev ? [{ source: "admin review", detail: v.ev }] : [] })) });
    if (ok) onDone();
  }
  return (
    <Box sx={{ border: 1, borderColor: "primary.main", borderRadius: 2, p: 1.5, display: "grid", gap: 1.25 }}>
      <Typography variant="h6" component="h3">Admin review</Typography>
      <TextField select label="Status" value={v.status} onChange={set("status")}>{Object.entries(STATUS).map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}</TextField>
      <TextField select label="Role" value={v.role} onChange={set("role")}>{ROLES.map((r) => <MenuItem key={r} value={r}>{r.replace(/_/g, " ")}</MenuItem>)}</TextField>
      <TextField label="Defender(s), comma separated" value={v.names} onChange={set("names")} />
      <TextField multiline minRows={2} label="Observed: what the film or chart shows" value={v.obs} onChange={set("obs")} />
      <TextField multiline minRows={2} label="Inferred: the assignment, and why" value={v.inf} onChange={set("inf")} />
      <TextField label="Evidence: source, play, film timestamp" value={v.ev} onChange={set("ev")} />
      <TextField label="Still missing or disputed" value={v.miss} onChange={set("miss")} />
      <Button variant="contained" size="large" onClick={save}>Save review</Button>
    </Box>
  );
}

/* =========================== MY PICKS =========================== */
function MyPicks() {
  const S = useStore();
  if (!S.uid) return <DbNote />;
  const items = Object.values(myItems()).sort((a, b) => b.week - a.week || FB.etToUtcMs((S.gameById[a.game_id] || {}).kickoff_et) - FB.etToUtcMs((S.gameById[b.game_id] || {}).kickoff_et));
  const weeks = [...new Set(items.map((p) => p.week))];
  return (
    <Stack spacing={1.5}>
      {!items.length && <Empty>No picks yet. Open TD Picks and tap Pick on a player. You can change picks until each game kicks off.</Empty>}
      {weeks.map((w) => {
        const list = items.filter((p) => p.week === w); const rs = list.map((p) => settlePick(S.uid, p));
        const wins = rs.filter((r) => r.state === "win").length;
        return (
          <Box key={w}>
            <Typography variant="overline" color="text.secondary">Week {w} · {list.length} pick{list.length > 1 ? "s" : ""}{rs.some((r) => ["win", "loss"].includes(r.state)) ? ` · ${wins} won` : ""}</Typography>
            <Stack spacing={1}>
              {list.map((p, i) => {
                const g = S.gameById[p.game_id] || {}; const locked = FB.isLocked(g, Date.now()); const r = rs[i];
                return (
                  <Card key={p.key} variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gap: 0.5 }}>
                    <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
                      <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>{p.player} <Typography component="span" variant="caption" color="text.secondary">{p.pos} {p.team}{p.market === "2plus_td" ? " · 2+ TDs" : ""}</Typography></Typography>
                      <Result r={r} />
                    </Stack>
                    <Typography variant="body2" color="text.secondary">{g.away} at {g.home} · {g.kickoff_et ? kick(g) : ""}</Typography>
                    <Typography variant="body2" color="text.secondary">{p.price ? <Num>{p.price.book} {am(p.price.american)} when picked{p.price.stale || p.price_warning ? " (stale price)" : ""} · price time unverified</Num> : "No sportsbook price when picked"}{p.model_p ? ` · model ${pct(p.model_p)}` : ""}</Typography>
                    {!locked && (
                      <Stack direction="row" sx={{ gap: 1, mt: 0.5 }}>
                        {p.status === "draft" && <Button variant="contained" size="large" onClick={() => setPickStatus(p.key, "submitted")}>Submit</Button>}
                        <Button size="large" onClick={() => removePick(p.key)}>Remove</Button>
                      </Stack>
                    )}
                    {locked && <Typography variant="caption" color="text.secondary">Locked at kickoff. {r.why}</Typography>}
                  </CardContent></Card>
                );
              })}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

/* =========================== FAMILY BOARD =========================== */
function FamilyBoard() {
  const S = useStore();
  const all = Object.entries(S.allPicks).flatMap(([uid, d]) => Object.values(d.items || {}).filter((p) => p.status === "submitted").map((p) => ({ uid, p, r: settlePick(uid, p) })));
  const weeks = [...new Set(all.map((x) => x.p.week))].sort((a, b) => b - a);
  const totals = {}; all.forEach(({ uid, r }) => { const t = (totals[uid] ||= { win: 0, loss: 0, void: 0, pending: 0, needs_review: 0 }); t[r.state] = (t[r.state] || 0) + 1; });
  const standings = Object.entries(totals).sort((a, b) => b[1].win - a[1].win || a[1].loss - b[1].loss);
  // per member: hit rate, streak, wins vs model expectation, best pick, parlay record
  const stats = {};
  all.filter((x) => x.r.state === "win" || x.r.state === "loss").sort((a, b) => String(a.p.submitted_at).localeCompare(String(b.p.submitted_at))).forEach(({ uid, p, r }) => {
    const t = (stats[uid] ||= { n: 0, win: 0, exp: 0, streak: 0, sdir: null, best: null });
    t.n++; t.win += r.state === "win"; t.exp += p.model_p || 0;
    const d = r.state === "win" ? "W" : "L"; t.streak = t.sdir === d ? t.streak + 1 : 1; t.sdir = d;
    if (r.state === "win" && p.model_p && (!t.best || p.model_p < t.best.model_p)) t.best = p;
  });
  const parl = Object.entries(S.parlaysAll).flatMap(([uid, d]) => Object.values(d.items || {}).map((par) => ({ uid, par, r: settleParlayFor(uid, par) })))
    .sort((a, b) => b.par.week - a.par.week || String(b.par.created_at).localeCompare(String(a.par.created_at)));
  const precs = {}; parl.forEach(({ uid, r }) => { const t = (precs[uid] ||= { win: 0, loss: 0 }); if (r.state === "win") t.win++; if (r.state === "loss") t.loss++; });
  return (
    <Stack spacing={1.5}>
      {!all.length && !parl.length && <Empty>No picks yet. Picks show up here as soon as anyone makes one.</Empty>}
      <WeekRecap all={all} parl={parl} />
      {standings.length > 0 && (
        <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Typography variant="overline" color="text.secondary">Season standings</Typography>
          {standings.map(([uid, t], i) => (
            <Stack key={uid} direction="row" sx={{ alignItems: "center", gap: 1, py: 0.75, borderTop: i ? 1 : 0, borderColor: "divider", flexWrap: "wrap" }}>
              <Typography sx={{ fontWeight: 600, flex: 1 }}>{i + 1}. {nameOf(uid)}</Typography>
              <Num sx={{ fontWeight: 600 }}>{t.win}–{t.loss}</Num>
              {t.pending > 0 && <Chip size="small" variant="outlined" color="warning" label={`${t.pending} pending`} />}
              {t.void > 0 && <Chip size="small" variant="outlined" label={`${t.void} void`} />}
              {stats[uid] && <Typography variant="caption" color="text.secondary" sx={{ width: "100%" }}>
                {Math.round(100 * stats[uid].win / stats[uid].n)}% hit · {stats[uid].sdir}{stats[uid].streak} streak · {stats[uid].win - stats[uid].exp >= 0 ? "+" : ""}{(stats[uid].win - stats[uid].exp).toFixed(1)} wins vs the model's chances
                {stats[uid].best ? ` · best: ${stats[uid].best.player} at ${pct(stats[uid].best.model_p)}` : ""}{precs[uid] ? ` · parlays ${precs[uid].win}–${precs[uid].loss}` : ""}</Typography>}
            </Stack>
          ))}
        </CardContent></Card>
      )}
      {parl.length > 0 && (
        <Box>
          <Typography variant="overline" color="text.secondary">Parlays</Typography>
          <Stack spacing={1}>{parl.slice(0, 30).map(({ uid, par, r }) => <ParlayCard key={uid + par.id} uid={uid} par={par} r={r} />)}</Stack>
        </Box>
      )}
      {weeks.map((w) => {
        const wk = all.filter((x) => x.p.week === w); const members = [...new Set(wk.map((x) => x.uid))];
        return (
          <Box key={w}>
            <Typography variant="overline" color="text.secondary">Week {w}</Typography>
            <Stack spacing={1}>
              {members.map((uid) => (
                <Card key={uid} variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                  <Typography sx={{ fontWeight: 700, mb: 0.5 }}>{nameOf(uid)}</Typography>
                  {wk.filter((x) => x.uid === uid).map(({ p, r }) => {
                    const g = S.gameById[p.game_id] || {};
                    return (
                      <Stack key={p.key} direction="row" sx={{ alignItems: "center", gap: 1, py: 0.5 }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}><Typography noWrap>{p.player} <Typography component="span" variant="caption" color="text.secondary">{p.team}{p.market === "2plus_td" ? " · 2+ TDs" : ""}</Typography></Typography>
                          <Typography variant="caption" color="text.secondary">{g.away} at {g.home}{p.model_p ? ` · model ${pct(p.model_p)}` : ""}{p.price ? ` · ${p.price.book} ${am(p.price.american)}${p.price.stale || p.price_warning ? " (stale)" : ""}, price time unverified` : ""}</Typography></Box>
                        <Result r={r} />
                      </Stack>
                    );
                  })}
                </CardContent></Card>
              ))}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}

/* =========================== ADMIN =========================== */
export function AdminView() {
  const S = useStore(); const [play, setPlay] = useState(null);
  const [who, setWho] = useState(null); const [st, setSt] = useState("Out"); const [note, setNote] = useState("");
  const cands = useMemo(() => slateCands().map((c) => ({ ...c, label: `${c.full_name || c.player} · ${c.pos || ""} ${c.team}` })), [S.slate]);
  if (!S.isAdmin) return <Empty>Admins only.</Empty>;
  const week = S.slate.week; const now = Date.now();
  const started = S.slate.games.filter((g) => FB.isLocked(g, now));
  const ov = (S.overrides["w" + week] || {}).players || {};
  const queue = S.extrasLoaded ? S.tds.filter((t) => t.unit === "offense" && effAttr(t).status !== "verified_individual").slice(-20).reverse() : [];
  return (
    <Stack spacing={1.5}>
      {S.meta && S.meta.health && <Alert severity={S.meta.health.ok ? (S.meta.health.problems.length ? "info" : "success") : "warning"} sx={{ borderRadius: 2 }}>
        <b>Last refresh:</b> model {S.meta.health.model} · {S.meta.health.predictions_saved} pregame chances saved{S.meta.health.problems.length ? ". " + S.meta.health.problems.join(" ") : ". No problems."}</Alert>}
      <H2>Admin</H2>
      <Fold title="Player status" summary="Mark players Out or off the roster before the data catches up" defaultExpanded>
        <Autocomplete options={cands} value={who} onChange={(e, v) => setWho(v)} getOptionLabel={(o) => o.label} isOptionEqualToValue={(a, b) => a.gsis_id === b.gsis_id}
          renderInput={(p) => <TextField {...p} label={`Player (week ${week})`} />} />
        <TextField select label="Status" value={st} onChange={(e) => setSt(e.target.value)}>
          {["Out", "Doubtful", "Questionable", "Not on roster", "Clear"].map((x) => <MenuItem key={x} value={x}>{x === "Clear" ? "Clear (use the data)" : x}</MenuItem>)}
        </TextField>
        <TextField label="Note (source, e.g. team announcement)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="contained" size="large" disabled={!who} onClick={() => { setOverride(who.gsis_id, who.full_name || who.player, who.team, st, note); setWho(null); setNote(""); }}>Save status</Button>
        {Object.entries(ov).length > 0 && <Typography variant="subtitle2">Set this week</Typography>}
        {Object.entries(ov).map(([gid, o]) => (
          <Stack key={gid} direction="row" sx={{ alignItems: "center", gap: 1 }}>
            <Typography sx={{ flex: 1 }}>{o.player} <Typography component="span" variant="caption" color="text.secondary">{o.team} · {o.status}{o.note ? ` · ${o.note}` : ""}</Typography></Typography>
            <Button onClick={() => setOverride(gid, o.player, o.team, "Clear")} sx={{ minHeight: 44 }}>Clear</Button>
          </Stack>
        ))}
      </Fold>
      <Fold title="Kickoff snapshots" summary="Settlement only counts picks frozen at kickoff">
        {S.slate.games.map((g) => <Stack key={g.game_id} direction="row" sx={{ gap: 1, alignItems: "center" }}><Typography sx={{ flex: 1 }}>{g.away} at {g.home}</Typography>
          {S.locks[g.game_id] ? <Chip size="small" color="success" variant="outlined" label={"frozen " + et(S.locks[g.game_id].frozen_at, { hour: "numeric", minute: "2-digit" })} />
            : FB.isLocked(g, now) ? <Chip size="small" color="secondary" variant="outlined" label="needs snapshot" /> : <Chip size="small" variant="outlined" label="open" />}</Stack>)}
        <Button variant="contained" size="large" disabled={!started.length} onClick={() => freeze(started)}>Snapshot started games now</Button>
      </Fold>
      <Fold title="Attribution review queue" summary="Recent offensive TDs without a verified defender">
        {queue.map((t) => <Stack key={t.key} direction="row" sx={{ gap: 1, alignItems: "center" }}>
          <Typography variant="body2" sx={{ flex: 1 }}>Wk {t.week} {t.scorer} ({t.team} vs {t.opp}) · {TYPE[t.type]}</Typography>
          <Button variant="outlined" onClick={() => setPlay(t)} sx={{ minHeight: 44 }}>Review</Button></Stack>)}
      </Fold>
      <FeedAdmin />
      <Fold title="Data sources">
        {S.meta.sources.map((s) => <Typography key={s.name} variant="body2"><b>{s.name}</b>: {s.fields}{s.through_week ? ` (through week ${s.through_week})` : ""}</Typography>)}
        <Typography variant="body2" color="text.secondary">Not connected: {S.meta.not_connected.join("; ")}.</Typography>
        <Typography variant="body2" color="text.secondary">Roster check: players must be on their team's active roster (week {S.slate.roster_week}).</Typography>
      </Fold>
      {play && <PlayDialog t={play} onClose={() => setPlay(null)} />}
    </Stack>
  );
}

/* Admin: the sportsbook feed (FanDuel and DraftKings prices from OddsPapi, pulled by the scheduled refresh). The key is
   entered here by the app owner and kept in the owner's private part of the database; it is never shown again in full. */
function FeedAdmin() {
  const S = useStore(); const [key, setKey] = useState(""); const [busy, setBusy] = useState(false);
  const f = S.oddsFeed; const cov = (f && f.coverage) || {};
  const when = (t) => et(t, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <Fold title="Sportsbook feed" summary="FanDuel and DraftKings prices, updated automatically">
      {!f || (!f.pulled_at && f.ok !== false) ? <Alert severity="info" sx={{ borderRadius: 2 }}>Not running yet. Once a key is saved, prices arrive with the next scheduled check and show on the TD's tab for everyone.</Alert>
        : f.ok === false ? <Alert severity="warning" sx={{ borderRadius: 2 }} data-testid="feed-status">The last pull failed{f.failed_at ? ` (${when(f.failed_at)})` : ""}: {f.error} {f.pulled_at ? `Showing prices from ${when(f.pulled_at)}.` : "No prices yet."}</Alert>
        : <Alert severity={(f.rows || []).length ? "success" : "info"} sx={{ borderRadius: 2 }} data-testid="feed-status">
            Last pull: <b>{when(f.pulled_at)}</b> · week {f.week} · {(f.rows || []).length} prices{cov.players ? ` for ${cov.players} players` : ""}{(f.moneylines || []).length ? ` · ${f.moneylines.length} game moneyline${f.moneylines.length > 1 ? "s" : ""}` : ""}{cov.books && cov.books.length ? ` · ${cov.books.join(", ")}` : ""}
            {cov.games_open != null ? ` · ${cov.games_with_prices || 0} of ${cov.games_open} open games` : ""}.{f.note ? ` ${f.note}` : ""}
            {(f.unmatched || []).length ? ` ${f.unmatched.length} price${f.unmatched.length > 1 ? "s were" : " was"} for players not on the app's list this week (left out).` : ""}
          </Alert>}
      {f && (f.unmatched || []).length > 0 && <Typography variant="caption" color="text.secondary">Left out (defenders, deep reserves or a name the app doesn't list): {f.unmatched.slice(0, 12).join("; ")}{f.unmatched.length > 12 ? "…" : ""}</Typography>}
      {!S.isOwner ? <Typography variant="body2" color="text.secondary">Only the app owner can enter or change the feed's API key.</Typography> : (
        <>
          <Typography variant="body2" data-testid="feed-key-state">
            {!S.feedKeyLoaded ? "Checking for a saved key…" : S.feedKey ? <>API key saved{S.feedKey.saved_at ? ` ${when(S.feedKey.saved_at)}` : ""} (ends in <b>{S.feedKey.tail}</b>).</> : "No API key saved."}
          </Typography>
          <TextField label={S.feedKey ? "Replace the OddsPapi API key" : "OddsPapi API key"} type="password" value={key} onChange={(e) => setKey(e.target.value)}
            autoComplete="off" slotProps={{ htmlInput: { autoCapitalize: "off", autoCorrect: "off", spellCheck: false, "data-1p-ignore": true } }}
            helperText="Kept in your private part of the app's database: other family members, editors and viewers can't read it, and it is never published. Only your scheduled refresh reads it." />
          <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
            <Button variant="contained" size="large" disabled={!key.trim() || busy} onClick={async () => { setBusy(true); if (await saveFeedKey(key)) setKey(""); setBusy(false); }}>Save key</Button>
            {S.feedKey && <Button size="large" color="error" onClick={removeFeedKey}>Remove key</Button>}
            {S.feedKey && <Button size="large" variant="outlined" disabled={!!(S.refresh && S.refresh.busy)} onClick={manualRefresh}>{S.refresh && S.refresh.busy ? "Checking…" : "Pull prices now"}</Button>}
          </Stack>
          {S.refresh && S.refresh.msg && <Typography variant="body2" role="status">{S.refresh.msg}</Typography>}
          <Typography variant="caption" color="text.secondary">Prices are pulled by the scheduled refresh (hourly at most), only for games that haven't kicked off, and count as fresh for {FB.PRICE_FRESH_MIN / 60} hours. Family uploads keep working alongside.</Typography>
        </>
      )}
    </Fold>
  );
}

/* =========================== BOARD (Mine | Family) =========================== */
export function BoardView({ mine: startMine }) {
  const [view, setView] = useState(startMine ? "mine" : "family");
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <H2 sx={{ flex: 1 }}>{view === "mine" ? "My picks" : view === "results" ? "Results" : "Family board"}</H2>
        <ToggleButtonGroup exclusive size="small" value={view} onChange={(e, v) => v && setView(v)} sx={{ "& .MuiToggleButton-root": { minHeight: 44, px: 2, textTransform: "none" } }}>
          <ToggleButton value="family">Family</ToggleButton><ToggleButton value="mine">Mine</ToggleButton><ToggleButton value="results">Results</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <DbNote />
      {view === "mine" ? <><MyPicks /><MyParlays /></> : view === "results" ? <ResultsDashboard /> : <FamilyBoard />}
    </Stack>
  );
}
function ParlayCard({ uid, par, r, onDelete }) {
  const S = useStore(); const ch = FB.parlayChance(par.legs);
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gap: 0.5 }}>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Typography sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>{uid ? `${nameOf(uid)} · ` : ""}{par.name}</Typography>
        <Result r={r} />
      </Stack>
      <Typography variant="caption" color="text.secondary">Week {par.week} · {par.legs.length} legs · model chance all score {odds1(ch.p)}{ch.sameTeam ? " (has same-team legs: slightly high)" : ch.sameGame ? " (has same-game legs)" : ""}</Typography>
      {par.legs.map((l, i) => {
        const st = r.legStates ? r.legStates[i] : "pending"; const g = S.gameById[l.game_id] || {};
        return (
          <Stack key={l.gsis_id} direction="row" sx={{ alignItems: "center", gap: 1 }}>
            <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{l.player} <Typography component="span" variant="caption" color="text.secondary">{l.team} · {g.away} at {g.home}{l.market === "2plus_td" ? " · 2+ TDs" : ""}</Typography></Typography>
            <Chip size="small" variant="outlined" color={RESULT[st] ? RESULT[st][1] : "default"} label={RESULT[st] ? RESULT[st][0] : st} />
          </Stack>
        );
      })}
      {onDelete && <Box><Button onClick={onDelete}>Delete parlay</Button></Box>}
    </CardContent></Card>
  );
}
function MyParlays() {
  const S = useStore(); if (!S.uid) return null;
  const list = Object.values(myParlays()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (!list.length) return null;
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">My parlays</Typography>
      <Stack spacing={1}>{list.map((par) => <ParlayCard key={par.id} par={par} r={settleParlayFor(S.uid, par)}
        onDelete={FB.parlayLocked(par.legs, S.gameById, Date.now()) ? null : () => deleteParlay(par.id)} />)}</Stack>
    </Box>
  );
}

/* =========================== PARLAYS =========================== */
export function ParlaysView() {
  const S = useStore(); const [name, setName] = useState(""); const [pick, setPick] = useState(null);
  const now = Date.now();
  const openGames = S.slate.games.filter((g) => !FB.isLocked(g, now));
  const options = openGames.flatMap((g) => g.teams.flatMap((t) => t.candidates.map(effCand))).filter((c) => c.quality !== "unavailable")
    .sort((a, b) => b.p - a.p).map((c) => ({ ...c, label: `${c.full_name || c.player} · ${c.pos || ""} ${c.team} · ${pct(c.p)}` }));
  const legs = S.draft; const ch = FB.parlayChance(legs);
  const stale = legs.filter((l) => FB.isLocked(S.gameById[l.game_id], now));
  return (
    <Stack spacing={1.5}>
      <H2>Parlays</H2>
      <DbNote />
      <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ display: "grid", gap: 1.25, p: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Typography variant="h6" component="h3">Build a parlay</Typography>
        <Autocomplete options={options} value={pick} onChange={(e, v) => { if (v) { addLeg(v); setPick(null); } }} getOptionLabel={(o) => o.label}
          isOptionEqualToValue={(a, b) => a.gsis_id === b.gsis_id} renderInput={(p) => <TextField {...p} label="Add a player (open games)" />} />
        {!legs.length && <Typography variant="body2" color="text.secondary">Add players here, from a player's row or details on TD Picks, or load a suggested slate below.</Typography>}
        {legs.map((l) => { const g = S.gameById[l.game_id] || {}; return (
          <Stack key={l.gsis_id} direction="row" sx={{ alignItems: "center", gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}><Typography sx={{ fontWeight: 600 }} noWrap>{l.player} <Typography component="span" variant="caption" color="text.secondary">{l.pos} {l.team}</Typography></Typography>
              <Typography variant="caption" color="text.secondary">{g.away} at {g.home} · {l.market === "2plus_td" ? <b>2+ TDs</b> : "Anytime TD"} · {pct(l.p)}{l.market === "2plus_td" ? " est." : ""}{l.p_matchup != null && l.matchup_pct >= 8 ? ` → ${pct(l.p_matchup)} matchup` : ""}{FB.isLocked(g, now) ? " · started" : ""}</Typography>
              {isWindy(g) && <Chip size="small" color="warning" variant="outlined" label={`Wind ${Math.round(g.weather.wind_mph)} mph`} sx={{ height: 20, ml: 0.5 }} />}</Box>
            <Button onClick={() => removeLeg(l.gsis_id)} sx={{ minHeight: 44 }}>Remove</Button>
          </Stack>); })}
        {legs.length > 0 && <>
          <Typography variant="body2"><b>Chance every leg scores:</b> {odds1(ch.p)}{ch.p ? ` · fair odds ${am(FB.probToAmerican(ch.p))}` : ""}</Typography>
          {legs.some((l) => l.p_matchup != null) && Math.abs(ch.pMatchup - ch.p) > 1e-4 && <Typography variant="body2" color="text.secondary">With matchups: {odds1(ch.pMatchup)} · fair odds {am(FB.probToAmerican(ch.pMatchup))} (research only)</Typography>}
          {ch.sameTeam ? <Alert severity="info" sx={{ borderRadius: 2 }}>Two legs are on the same team. Teammates share their team's touchdowns, so both scoring happens a little less often than this estimate: about 9% less often in 2026 games (4.6% of pairs vs 5.0% expected). That gap was too small to be sure of, so the number above is not adjusted.</Alert>
            : ch.sameGame && <Alert severity="info" sx={{ borderRadius: 2 }}>Two legs are in the same game on opposite teams. In testing those pairs scored together about as often as this estimate says.</Alert>}
          {stale.length > 0 && <Alert severity="warning" sx={{ borderRadius: 2 }}>{stale.map((l) => l.player).join(", ")} {stale.length > 1 ? "are" : "is"} in a game that has started. Remove to save.</Alert>}
          <Typography variant="caption" color="text.secondary">Locks when its first game kicks off. If a player doesn't play, that leg is dropped and the rest still count. Sportsbook parlay odds are never quoted here.</Typography>
          <TextField label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <Stack direction="row" sx={{ gap: 1 }}>
            <Button variant="contained" size="large" sx={{ flex: 1 }} disabled={legs.length < 2 || !S.uid || stale.length > 0} onClick={async () => { if (await saveParlay(name)) setName(""); }}>Save parlay ({legs.length} legs)</Button>
            <Button size="large" onClick={() => setDraft([])}>Clear</Button>
          </Stack>
        </>}
      </CardContent></Card>
      <Fold title="Suggested slates" summary="Highest chance or best matchup" defaultExpanded><Slates /></Fold>
      <MyParlays />
    </Stack>
  );
}

/* =========================== LINES =========================== */
export function LinesView() {
  const S = useStore(); const week = S.slate.week;
  const [bookChoice, setBookChoice] = useState("FanDuel"); const [otherBook, setOtherBook] = useState("");
  const book = bookChoice === "Other" ? (otherBook.trim() || "Other") : bookChoice; const [text, setText] = useState(""); const [market, setMarket] = useState("anytime_td");
  const [who, setWho] = useState(null); const [mPrice, setMPrice] = useState(""); const [mMarket, setMMarket] = useState("anytime_td");
  const cands = useMemo(() => slateCands().map(effCand).map((c) => ({ ...c, label: `${c.full_name || c.player} · ${c.pos || ""} ${c.team}` })), [S.slate, S.overrides]);
  const byId = Object.fromEntries(cands.map((c) => [c.gsis_id, c]));
  const rows = allLineRows(week).filter((r) => (r.market || "anytime_td") === market);
  const latest = {}; rows.forEach((r) => { const k = `${r.gsis_id || r.player}|${r.book}`; if (!latest[k] || Date.parse(r.captured_at) > Date.parse(latest[k].captured_at)) latest[k] = r; });
  const list = Object.values(latest).sort((a, b) => FB.americanToProb(b.american) - FB.americanToProb(a.american));
  // the list is hundreds of prices long: show ten, and let a search or "Show all" bring up the rest
  const [q, setQ] = useState(""); const [showAll, setShowAll] = useState(false); const qq = q.trim().toLowerCase();
  const found = qq ? list.filter((r) => `${r.player} ${r.team} ${r.book}`.toLowerCase().includes(qq)) : list;
  const PRICE_PAGE = 10; const shown = showAll || qq ? found.slice(0, qq && !showAll ? 40 : found.length) : found.slice(0, PRICE_PAGE);
  const canWrite = !!S.uid && S.dbState === "ok";
  async function fromFile(f) {
    if (!f) return;
    if (f.type.startsWith("image/")) return readLinesShots([f], book);
    const t = await f.text(); const raw = parseLinesCsv(t); const parsed = Object.assign(raw.map((r) => ({ ...r, book: r.book || book || "Upload" })), { skipped: raw.skipped });
    await uploadLines(parsed, "file");
  }
  const mine = (S.lines[S.uid] || []).length;
  return (
    <Stack spacing={1.5}>
      <H2>Prices · Week {week}</H2>
      <RefereeUploads />
      <DbNote />
      <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ display: "grid", gap: 1.25, p: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <Typography variant="h6" component="h3" sx={{ flex: 1 }}>Add prices</Typography>
          <Button onClick={() => { resetUploadScreen(); setBookChoice("FanDuel"); setOtherBook(""); setText(""); setWho(null); setMPrice(""); setMMarket("anytime_td"); setMarket("anytime_td"); toast("Upload screen reset. Saved prices weren't changed."); }}
            aria-label="Reset the upload screen (saved prices are not deleted)" sx={{ minHeight: 44 }}>Reset</Button>
        </Stack>
        <Typography variant="body2" color="text.secondary">Anytime TD and 2+ TDs only. Prices go live for everyone right away, labeled with your name and the time.</Typography>
        <Box>
          <Typography variant="caption" color="text.secondary">Sportsbook</Typography>
          <ToggleButtonGroup exclusive fullWidth color="primary" value={bookChoice} onChange={(e, v) => v && setBookChoice(v)} aria-label="Sportsbook"
            sx={{ mt: 0.5, "& .MuiToggleButton-root": { minHeight: 48, textTransform: "none", fontSize: 15, fontWeight: 600 } }}>
            <ToggleButton value="FanDuel">FanDuel</ToggleButton><ToggleButton value="DraftKings">DraftKings</ToggleButton><ToggleButton value="Other">Other</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        {bookChoice === "Other" && <TextField label="Which sportsbook?" placeholder="e.g. BetMGM, Caesars" value={otherBook} onChange={(e) => setOtherBook(e.target.value)} />}
        <Stack direction="row" sx={{ gap: 1 }}>
          <Button component="label" variant="contained" size="large" disabled={!canWrite} startIcon={<Icon d={P.upload} />} sx={{ flex: 1 }}>
            Screenshots<input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-label={`Choose up to ${MAX_SHOTS} screenshots`} onChange={(e) => { readLinesShots(e.target.files, book); e.target.value = ""; }} /></Button>
          <Button component="label" variant="outlined" size="large" disabled={!canWrite} sx={{ flex: 1 }}>
            CSV file<input hidden type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => { fromFile(e.target.files[0]); e.target.value = ""; }} /></Button>
        </Stack>
        <Accordion disableGutters variant="outlined" sx={{ borderRadius: 2, "&:before": { display: "none" } }}>
          <AccordionSummary expandIcon={<Icon d={P.expand} />} sx={{ minHeight: 48 }}><Typography>Type or paste prices</Typography></AccordionSummary>
          <AccordionDetails sx={{ display: "grid", gap: 1.25 }}>
            <Autocomplete options={cands} value={who} onChange={(e, v) => setWho(v)} getOptionLabel={(o) => o.label} isOptionEqualToValue={(a, b) => a.gsis_id === b.gsis_id} renderInput={(p) => <TextField {...p} label="Player" />} />
            <Stack direction="row" sx={{ gap: 1 }}>
              <TextField select label="Market" value={mMarket} onChange={(e) => setMMarket(e.target.value)} sx={{ flex: 1 }}>{Object.entries(MARKETS).map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}</TextField>
              <TextField label="Price" placeholder="+180" value={mPrice} onChange={(e) => setMPrice(e.target.value)} sx={{ width: 110 }} slotProps={{ htmlInput: { inputMode: "numeric" } }} />
            </Stack>
            <Button variant="contained" size="large" disabled={!canWrite || !who || !mPrice} onClick={async () => {
              const ok = await uploadLines([{ player: who.full_name || who.player, team: who.team, market: mMarket, american: Number(String(mPrice).replace("+", "")), book: book || "Manual", captured_at: new Date().toISOString(), time_source: "upload time" }], "manual");
              if (ok) { setWho(null); setMPrice(""); } }}>Add price</Button>
            <TextField multiline minRows={3} label="Or paste rows" placeholder={"player,team,book,market,price\nTrey McBride,ARI,FanDuel,anytime,+180"} value={text} onChange={(e) => setText(e.target.value)} slotProps={{ input: { sx: { fontFamily: "var(--fb-mono)", fontSize: 12 } } }} />
            <Button variant="outlined" size="large" disabled={!canWrite || !text.trim()} onClick={async () => { const raw = parseLinesCsv(text); if (await uploadLines(Object.assign(raw.map((r) => ({ ...r, book: r.book || book || "Paste" })), { skipped: raw.skipped }), "paste")) setText(""); }}>Add pasted rows</Button>
          </AccordionDetails>
        </Accordion>
        {S.shotReview && <ShotReview />}
        {S.lastSkipped && S.lastSkipped.length > 0 && <Alert severity="warning" sx={{ borderRadius: 2 }} onClose={clearSkipped}>
          <b>Skipped {S.lastSkipped.length}:</b> {S.lastSkipped.slice(0, 6).map((x) => `${x.line} (${x.why})`).join(" · ")}{S.lastSkipped.length > 6 ? " …" : ""}</Alert>}
        {mine > 0 && <Button onClick={() => deleteLines(S.uid, () => true)}>Remove all {mine} of my week {week} prices</Button>}
      </CardContent></Card>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
        <Typography variant="h6" component="h3" sx={{ flex: 1 }}>{list.length} price{list.length === 1 ? "" : "s"}</Typography>
        <ToggleButtonGroup exclusive size="small" value={market} onChange={(e, v) => { if (v) { setMarket(v); setShowAll(false); } }} aria-label="Market" sx={{ "& .MuiToggleButton-root": { minHeight: 44, px: 1.5, textTransform: "none" } }}>
          {Object.entries(MARKETS).map(([k, l]) => <ToggleButton key={k} value={k}>{l}</ToggleButton>)}
        </ToggleButtonGroup>
      </Stack>
      {list.length > 0 && <TextField label="Find a player, team or sportsbook" value={q} onChange={(e) => { setQ(e.target.value); setShowAll(false); }} slotProps={{ htmlInput: { inputMode: "search", "data-testid": "price-search" } }} />}
      {list.length > 0 && <Typography variant="caption" color="text.secondary" role="status" data-testid="price-count">
        {qq ? (found.length ? `${found.length} of ${list.length} prices match "${q.trim()}"${shown.length < found.length ? `; showing the first ${shown.length}` : ""}.` : `No price matches "${q.trim()}".`)
          : shown.length < list.length ? `Showing the ${shown.length} likeliest scorers by price, of ${list.length}. Search above or show all.` : `All ${list.length} prices, likeliest scorers first.`}</Typography>}
      {!list.length && <Empty>No {MARKETS[market]} prices yet this week. Upload a sportsbook screenshot above.</Empty>}
      {shown.map((r) => {
        const c = byId[r.gsis_id]; const imp = FB.americanToProb(r.american); const e = c && market === "anytime_td" ? FB.edge(c.p, r.american) : null;
        const canDel = r.uploaded_by === S.uid || S.isAdmin;
        return (
          <Card key={`${r.gsis_id || r.player}|${r.book}|${r.uploaded_by}`} variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gap: 0.25 }}>
            <Stack direction="row" sx={{ alignItems: "baseline", gap: 1 }}>
              <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>{r.player} <Typography component="span" variant="caption" color="text.secondary">{r.team}</Typography></Typography>
              <Typography sx={{ fontWeight: 700 }}><Num>{am(r.american)}</Num></Typography>
            </Stack>
            {!r.gsis_id && r.uploaded_by === S.uid && <Autocomplete size="small" options={cands} getOptionLabel={(o) => o.label} onChange={(e, v) => v && matchLine(r, v)} renderInput={(p) => <TextField {...p} label={`Match "${r.player}" to a player`} />} />}
            <Typography variant="body2" color="text.secondary">{r.book} · implied {pct1(imp)}{e ? ` · model ${pct1(c.p)} (${e.edgePts >= 0 ? "+" : ""}${e.edgePts.toFixed(1)} pts vs price; model unproven vs sportsbooks)` : ""}{!r.gsis_id ? " · not matched to a player" : ""}</Typography>
            <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{nameOf(r.uploaded_by)} · {r.source || "upload"} · observed {et(r.captured_at, { hour: "numeric", minute: "2-digit" })}{` (${timeBasis(r.time_source)})`}{FB.priceFresh(r, Date.now()) ? "" : ` · stale (over ${FB.PRICE_FRESH_MIN / 60} h)`}</Typography>
              {canDel && r.uploaded_by && S.lines[r.uploaded_by] && <Button size="small" onClick={() => deleteLines(r.uploaded_by, (x) => (x.gsis_id && r.gsis_id && !r.matched_on_read ? x.gsis_id === r.gsis_id : x.player === (r.stored_player || r.player)) && x.book === r.book && (x.market || "anytime_td") === market)}>Remove</Button>}
            </Stack>
          </CardContent></Card>
        );
      })}
      {shown.length < found.length && <Button variant="outlined" size="large" onClick={() => setShowAll(true)}>Show all {found.length}{qq ? " matches" : " prices"}</Button>}
      {showAll && found.length > PRICE_PAGE && <Button size="large" onClick={() => { setShowAll(false); window.scrollTo(0, 0); }}>Show fewer</Button>}
      <LineMoves week={week} market={market} />
    </Stack>
  );
}

/* =========================== DEFENSE (TDs allowed by position) =========================== */
const DPOS = ["RB", "WR", "TE", "QB"];
function defenseTable(S, lastN) {
  const finals = S.games.filter((g) => g.status === "final");
  const maxW = Math.max(0, ...finals.map((g) => g.week)); const minW = lastN ? maxW - lastN + 1 : 0;
  const games = {}; finals.filter((g) => g.week >= minW).forEach((g) => { [g.home, g.away].forEach((t) => { games[t] = (games[t] || 0) + 1; }); });
  const rows = Object.fromEntries(Object.keys(games).map((t) => [t, { team: t, games: games[t], total: 0, rush: 0, rec: 0, ...Object.fromEntries(DPOS.map((k) => [k, 0])) }]));
  S.tds.filter((t) => t.unit === "offense" && t.week >= minW && rows[t.opp]).forEach((t) => {
    const r = rows[t.opp]; const pos = DPOS.includes(t.scorer_pos) ? t.scorer_pos : t.scorer_pos === "FB" ? "RB" : null;
    r.total++; if (pos) r[pos]++; if (t.type === "rushing") r.rush++; else if (t.type === "passing") r.rec++;
  });
  return rows;
}
function AllowedChips({ r, hi }) {
  return (
    <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap" }}>
      {DPOS.map((k) => <Chip key={k} size="small" variant={hi === k ? "filled" : "outlined"} color={hi === k ? "primary" : "default"} label={`${r[k]} ${k}`} sx={{ height: 24, fontVariantNumeric: "tabular-nums" }} />)}
    </Stack>
  );
}
export function DefenseView() {
  const S = useStore(); const [sortBy, setSortBy] = useState("total"); const [span, setSpan] = useState("season");
  if (!S.extrasLoaded) return <Stack spacing={1.5}><H2>Defense</H2>{S.extrasError ? <ExtrasError /> : <LinearProgress aria-label="Loading" />}</Stack>;
  const rows = defenseTable(S, span === "last4" ? 4 : 0);
  const per = (r, k) => (r.games ? r[k] / r.games : 0);
  const list = Object.values(rows).sort((a, b) => per(b, sortBy) - per(a, sortBy) || b[sortBy] - a[sortBy]);
  const rank = Object.fromEntries(list.map((r, i) => [r.team, i + 1]));
  const open = S.slate.games;
  return (
    <Stack spacing={1.5}>
      <H2>Defense · TDs allowed</H2>
      <Typography variant="body2" color="text.secondary">Offensive touchdowns each defense has allowed, by the scorer's position. Rushing and receiving touchdowns both count. Research only: on its own this hasn't beaten the main odds in testing.</Typography>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        <ToggleButtonGroup exclusive size="small" value={span} onChange={(e, v) => v && setSpan(v)} sx={{ "& .MuiToggleButton-root": { minHeight: 44, px: 1.5, textTransform: "none" } }}>
          <ToggleButton value="season">Season</ToggleButton><ToggleButton value="last4">Last 4 weeks</ToggleButton>
        </ToggleButtonGroup>
        <TextField select size="small" label="Sort by" value={sortBy} onChange={(e) => setSortBy(e.target.value)} sx={{ minWidth: 140 }}>
          <MenuItem value="total">Most TDs allowed</MenuItem>{DPOS.map((k) => <MenuItem key={k} value={k}>Most {k} TDs</MenuItem>)}
          <MenuItem value="rush">Most rushing TDs</MenuItem><MenuItem value="rec">Most receiving TDs</MenuItem>
        </TextField>
      </Stack>
      <Fold title={`Week ${S.slate.week} matchups`} summary="Each offense against the defense it faces" defaultExpanded>
        <Stack spacing={1}>
          {open.map((g) => (
            <Box key={g.game_id} sx={{ borderBottom: 1, borderColor: "divider", pb: 1 }}>
              <Typography sx={{ fontWeight: 700 }}>{g.away} at {g.home} <Typography component="span" variant="caption" color="text.secondary">{kick(g)}</Typography></Typography>
              {g.teams.map((t) => { const r = rows[t.opp]; if (!r) return null; return (
                <Box key={t.team} sx={{ mt: 0.5 }}>
                  <Typography variant="body2">{t.team} offense vs <b>{t.opp}</b> defense <Typography component="span" variant="caption" color="text.secondary">· {r.total} allowed in {r.games} games · #{rank[t.opp]} of {list.length}</Typography></Typography>
                  <AllowedChips r={r} hi={DPOS.includes(sortBy) ? sortBy : null} />
                </Box>); })}
            </Box>
          ))}
        </Stack>
      </Fold>
      <Typography variant="h6" component="h3">All defenses</Typography>
      {list.map((r, i) => (
        <Card key={r.team} variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gap: 0.5 }}>
          <Stack direction="row" sx={{ alignItems: "baseline", gap: 1 }}>
            <Typography sx={{ fontWeight: 700, flex: 1 }}>{i + 1}. {r.team}</Typography>
            <Typography variant="body2"><Num>{r.total} TDs · {(r.total / (r.games || 1)).toFixed(1)}/game</Num></Typography>
          </Stack>
          <AllowedChips r={r} hi={DPOS.includes(sortBy) ? sortBy : null} />
          <Typography variant="caption" color="text.secondary">{r.rush} rushing · {r.rec} receiving · {r.games} games</Typography>
        </CardContent></Card>
      ))}
    </Stack>
  );
}

/* =========================== REFEREE UPLOADS =========================== */
function RefereeUploads() {
  const S = useStore(); const [edit, setEdit] = useState({}); const [text, setText] = useState(""); const [miss, setMiss] = useState([]);
  const games = S.slate.games.filter((g) => !FB.isLocked(g, Date.now()));
  const names = Object.entries((S.slate.referees && S.slate.referees.crews) || {}).filter(([, c]) => c.last_season >= 2025).map(([n]) => n).sort();
  const known = games.filter((g) => refFor(g)).length;
  return (
    <Fold title="Referee assignments" summary={`${known} of ${games.length} open games assigned`}>
      <Typography variant="body2" color="text.secondary">The NFL announces crews midweek; nflverse often fills them in only after the game. Crews differ in how many flags they throw (holding especially), but in testing on 2024–2026 they did not change player touchdown chances, so they are shown as information.</Typography>
      {!S.isAdmin && <Alert severity="info" sx={{ borderRadius: 2 }}>Only admins can set referees. Assignments appear on each game card.</Alert>}
      {games.map((g) => { const r = refFor(g); return (
        <Stack key={g.game_id} direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <Typography sx={{ width: 96, flexShrink: 0, fontWeight: 600 }}>{g.away} at {g.home}</Typography>
          {S.isAdmin ? <Autocomplete freeSolo size="small" sx={{ flex: 1 }} options={names} value={edit[g.game_id] ?? (r ? r.name : "")}
              onInputChange={(e, v, why) => { if (why === "input" || why === "clear") setEdit((x) => ({ ...x, [g.game_id]: v })); }}
              onChange={(e, v) => setEdit((x) => ({ ...x, [g.game_id]: v || "" }))} renderInput={(p) => <TextField {...p} label="Referee" />} />
            : <Typography variant="body2" sx={{ flex: 1 }}>{r ? r.name : "Not assigned"}</Typography>}
        </Stack>); })}
      {S.isAdmin && <>
        <Button variant="contained" size="large" disabled={!Object.keys(edit).length} onClick={async () => { if (await setReferees(edit)) setEdit({}); }}>Save referees</Button>
        <TextField multiline minRows={3} label="Or paste the week's assignments" placeholder={"BUF at NYJ: Shawn Hochuli\nSF@DAL Clete Blakeman"} value={text} onChange={(e) => setText(e.target.value)} />
        <Button variant="outlined" size="large" disabled={!text.trim()} onClick={async () => { const r = parseRefText(text, games); setMiss(r.miss); if (Object.keys(r.map).length && await setReferees(r.map)) setText(""); }}>Add pasted assignments</Button>
        {miss.length > 0 && <Alert severity="warning" sx={{ borderRadius: 2 }}>Couldn't match: {miss.join(" · ")}</Alert>}
      </>}
    </Fold>
  );
}

/* =========================== WEEK RECAP =========================== */
function WeekRecap({ all, parl }) {
  const settled = all.filter((x) => ["win", "loss", "void"].includes(x.r.state));
  if (!settled.length) return null;
  const w = Math.max(...settled.map((x) => x.p.week)); const wk = all.filter((x) => x.p.week === w);
  if (wk.some((x) => x.r.state === "pending")) return null; // recap once the week is done
  const by = {}; wk.forEach(({ uid, r }) => { const t = (by[uid] ||= { win: 0, loss: 0 }); if (r.state === "win") t.win++; if (r.state === "loss") t.loss++; });
  const wins = wk.filter((x) => x.r.state === "win" && x.p.model_p).sort((a, b) => a.p.model_p - b.p.model_p);
  const pw = parl.filter((x) => x.par.week === w && x.r.state === "win").map((x) => ({ ...x, ch: FB.parlayChance(x.par.legs).p })).sort((a, b) => a.ch - b.ch);
  return (
    <Card variant="outlined" sx={{ borderRadius: 2, borderColor: "primary.main" }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gap: 0.5 }}>
      <Typography variant="overline" color="primary">Week {w} recap</Typography>
      <Typography variant="body2">{Object.entries(by).sort((a, b) => b[1].win - a[1].win).map(([uid, t]) => `${nameOf(uid)} ${t.win}–${t.loss}`).join(" · ")}</Typography>
      {wins[0] && <Typography variant="body2"><b>Best pick:</b> {nameOf(wins[0].uid)} took {wins[0].p.player} at {pct(wins[0].p.model_p)} — and he scored.</Typography>}
      {pw[0] && <Typography variant="body2"><b>Parlay of the week:</b> {nameOf(pw[0].uid)}'s {pw[0].par.legs.length}-leg "{pw[0].par.name}" hit ({odds1(pw[0].ch)} chance).</Typography>}
    </CardContent></Card>
  );
}
function LiveRecord() {
  const S = useStore(); const gr = S.grades; if (!gr) return null; const live = gr.model || {}; const bt = gr.backtest || {}; const k = gr.market;
  const m = live.n ? live : bt; if (!m.n) return null;
  return <>
    <Typography variant="subtitle2">Live record</Typography>
    <Typography variant="body2" color="text.secondary">{live.n
      ? `Chances published before kickoff, graded after each game: ${live.n.toLocaleString()} player-games, weeks ${live.weeks.join(", ")}. Log loss ${live.log_loss.toFixed(3)} vs ${live.log_loss_constant.toFixed(3)} for a flat rate (lower is better).`
      : "No live week has been graded yet; the first one appears after this week's games."}
      {bt.n ? ` Backtest (weeks ${bt.weeks[0]}–${bt.weeks[bt.weeks.length - 1]}, every player who took a snap, graded separately): log loss ${bt.log_loss.toFixed(3)} vs ${bt.log_loss_constant.toFixed(3)}.` : ""}</Typography>
    <Typography variant="caption" color="text.secondary">Calibration below: {live.n ? "live" : "backtest"}.</Typography>
    <TableContainer><Table size="small">
      <TableHead><TableRow>{["Chance band", "Players", "Forecast", "Scored"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
      <TableBody>{m.calibration.map((b) => <TableRow key={b.bin}><TableCell>{b.bin}</TableCell><TableCell><Num>{b.n}</Num></TableCell><TableCell><Num>{pct(b.pred)}</Num></TableCell><TableCell><Num>{pct(b.actual)}</Num></TableCell></TableRow>)}</TableBody>
    </Table></TableContainer>
    <Typography variant="body2" color="text.secondary">{k && k.n && k.log_loss_market_raw == null ? "The market record is in an older format; it will update at the next data refresh." : k && k.n ? `Against uploaded sportsbook prices (${k.n} player-games, weeks ${k.weeks.join(", ")}): model log loss ${k.log_loss_model} vs the books' raw implied chances ${k.log_loss_market_raw} (margin included; lower is better)${k.log_loss_model < k.log_loss_market_raw ? ", model ahead on this sample" : ", books ahead"}. Value Play stays off until 200+ priced player-games show the model ahead.` : "No uploaded prices have been graded yet. Add prices before kickoff under TD Picks, Prices to build the model-vs-market record (200+ priced player-games needed before Value Play can switch on)."}</Typography>
  </>;
}

/* Review AI-read screenshot prices before they go live */
function ShotReview() {
  const S = useStore(); const rows = S.shotReview || [];
  const upd = (id, patch) => setShotReview(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const multi = new Set(rows.map((r) => r.shot || 1)).size > 1;
  return (
    <Box sx={{ border: 2, borderColor: "warning.main", borderRadius: 2, p: 1.25, display: "grid", gap: 1 }} role="region" aria-label="Review screenshot prices">
      <Typography sx={{ fontWeight: 700 }}>Check {rows.length} prices read from {new Set(rows.map((r) => r.shot || 1)).size > 1 ? `${new Set(rows.map((r) => r.shot || 1)).size} screenshots` : "the screenshot"}</Typography>
      <Typography variant="body2" color="text.secondary">Screenshot reading can misread numbers. Fix or remove anything wrong; nothing is shared until you confirm. Book: {rows[0] ? rows[0].book : ""}.</Typography>
      {rows.map((r) => (
        <Stack key={r.id} direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <TextField size="small" label={multi ? `Player · shot ${r.shot}` : "Player"} value={r.player} onChange={(e) => upd(r.id, { player: e.target.value })} sx={{ flex: 1, minWidth: 0 }} />
          <TextField size="small" label={r.market === "2plus_td" ? "2+ TDs" : "Anytime"} value={r.raw ?? (isFinite(r.american) ? (r.american > 0 ? "+" + r.american : String(r.american)) : "")}
            error={!isFinite(FB.parseAmerican(r.raw ?? r.american))} onChange={(e) => upd(r.id, { raw: e.target.value })} sx={{ width: 92 }} slotProps={{ htmlInput: { inputMode: "numeric" } }} />
          <Button aria-label={`Remove ${r.player}`} onClick={() => { setShotReview(rows.filter((x) => x.id !== r.id)); setTimeout(() => { const el = document.getElementById("shot-confirm"); if (el) el.focus(); }, 0); }} sx={{ minWidth: 44, minHeight: 44 }}>✕</Button>
        </Stack>
      ))}
      <Stack direction="row" sx={{ gap: 1 }}>
        <Button id="shot-confirm" variant="contained" size="large" sx={{ flex: 1 }} disabled={!rows.length} onClick={confirmShot}>Confirm and share {rows.length}</Button>
        <Button size="large" onClick={() => setShotReview(null)}>Discard</Button>
      </Stack>
    </Box>
  );
}

/* =========================== BLIND PRE-GAME READS =========================== */
function PregameReads() {
  const S = useStore(); const [pick, setW] = useState(null); const [open, setOpen] = useState(null);
  useEffect(() => { ensurePregame(); }, []);
  if (S.pregame === undefined) return <LinearProgress aria-label="Loading pre-game reads" />;
  if (!S.pregame) return <Typography variant="body2" color="text.secondary">The pre-game reads couldn't be loaded. Try again after the next refresh.</Typography>;
  const weeks = Object.keys(S.pregame.weeks).sort((a, b) => a - b);
  const w = pick && S.pregame.weeks[pick] ? pick : weeks[weeks.length - 1];  // opens on the latest week
  const games = S.pregame.weeks[w] || [];
  const fav = (g) => { const m = /^(\S+) (-[\d.]+)/.exec(g.line || ""); return m ? `${m[1]} ${m[2].replace("-", "−")}` : null; };
  return (
    <Stack spacing={1}>
      <Typography variant="body2" color="text.secondary">
        How each game read before kickoff, using only what was known then: the closing line, earlier results, the final pre-game injury report, the
        pre-kickoff depth chart and the model's touchdown chances refit on earlier games. Results are deliberately left out. A "lean" means a simple
        margin rating disagreed with the line by 3+ points; it hasn't been tested and isn't a proven edge.
      </Typography>
      <ToggleButtonGroup exclusive size="small" value={w} onChange={(e, v) => { if (v) { setW(v); setOpen(null); } }} aria-label="Week"
        sx={{ flexWrap: "wrap", "& .MuiToggleButton-root": { minWidth: 44, minHeight: 44 } }}>
        {weeks.map((k) => <ToggleButton key={k} value={k} aria-label={`Week ${k}`}>{k}</ToggleButton>)}
      </ToggleButtonGroup>
      <Typography variant="caption" color="text.secondary">Week {w}: {games.length} games · {games.filter((g) => g.close).length} close · {games.filter((g) => g.lean).length} with a lean</Typography>
      {games.map((g, i) => {
        const id = `${w}-${g.away}-${g.home}`; const isOpen = open === id;
        return (
          <Card key={id} variant="outlined" sx={{ borderRadius: 2 }}>
            <ButtonBase onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen} aria-controls={`pg-${id}`}
              sx={{ display: "flex", width: "100%", textAlign: "left", px: 1.5, py: 1.25, gap: 1, minHeight: 56, justifyContent: "flex-start" }}>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700 }}>{g.away} at {g.home}{g.division ? <Typography component="span" variant="caption" color="text.secondary"> · division</Typography> : null}</Typography>
                <Typography variant="caption" color="text.secondary">{g.kickoff}</Typography>
              </Box>
              <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "55%" }}>
                {fav(g) && <Chip size="small" variant="outlined" label={fav(g)} />}
                {g.close && <Chip size="small" color="warning" variant="outlined" label="Close" />}
                {g.lean && <Chip size="small" color="secondary" variant="outlined" label={`Lean ${g.lean}`} />}
              </Stack>
              <Icon d={P.expand} sx={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s", color: "text.secondary" }} />
            </ButtonBase>
            {isOpen && (
              <Box id={`pg-${id}`} sx={{ px: 1.5, pb: 1.5, display: "grid", gap: 0.75 }}>
                <Typography variant="caption" color="text.secondary">{g.stadium}</Typography>
                {[["Line", g.line], ["Call", g.call], ["Context", g.context], ["Lineup", g.lineup], ["Anytime TD read", g.td]].filter(([, v]) => v).map(([k, v]) => (
                  <Typography key={k} variant="body2"><b>{k}:</b> {v}</Typography>
                ))}
              </Box>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}

/* =========================== LINE MOVES (Uploads tab) =========================== */
function LineMoves({ week, market }) {
  useStore(); const [all, setAll] = useState(false);
  const moves = weekMoves(week).filter((m) => m.market === market);
  if (!moves.length) return <Typography variant="body2" color="text.secondary">Line moves: none yet. A move shows when a book's price for a player changes from the first price uploaded this week.</Typography>;
  const big = moves.filter((m) => m.move.big).length; const shown = all ? moves : moves.slice(0, 8);
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ display: "grid", gap: 0.75 }}>
      <Typography variant="h6" component="h3">Line moves · {moves.length}{big ? ` (${big} big)` : ""}</Typography>
      <Typography variant="caption" color="text.secondary">Since the first price uploaded this week for each book. ▲ green = pays more now, ▼ red = pays less. Big = 2+ points of implied chance.</Typography>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "grid", gap: 0.5 }}>
        {shown.map((m) => (
          <Box component="li" key={`${m.gsis_id}|${m.book}`} sx={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
            <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 140 }}>{m.player} <Typography component="span" variant="caption" color="text.secondary">{m.team} · {m.book}</Typography></Typography>
            <MoveTag m={m.move} />
            <Typography variant="caption" color="text.secondary"><Num>{m.move.pts > 0 ? "+" : ""}{m.move.pts.toFixed(1)} pts</Num> · {et(m.captured_at, { weekday: "short", hour: "numeric", minute: "2-digit" })}</Typography>
          </Box>
        ))}
      </Box>
      {moves.length > 8 && <Box><Button onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${moves.length}`}</Button></Box>}
    </CardContent></Card>
  );
}

/* =========================== WEEKLY RANKINGS (Week tab) =========================== */
const RANK_VIEWS = [["chance", "Highest TD Chance"], ["value", "Best Value"], ["combined", "Combined"]];
const edgeTxt = (e) => (e < 0.05 ? "+<0.1" : `+${e.toFixed(1)}`) + " pts";
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* unavailable */ } } };
/* Price used for a ranked row: book, odds and the time of the ODDS (captured, or upload time when that's all there is), in ET. */
function PriceUsed({ b }) {
  const when = et(b.captured_at, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return <>{b.book} {am(b.american)} · {b.time_source === "upload time" ? "uploaded" : "captured"} {when}</>;
}
const StaleTag = ({ children = "Stale odds" }) => <Box component="span" sx={{ color: "warning.main", fontWeight: 700, whiteSpace: "nowrap" }}>{children}</Box>;
/* Newest sportsbook price time loaded for this market (the odds' own time, never the model's "Updated" time). */
function OddsThrough({ market }) {
  const S = useStore(); const [busy, setBusy] = useState(false);
  const ts = allRows(S.slate.week).filter((r) => (r.market || "anytime_td") === market).map((r) => Date.parse(r.captured_at)).filter((t) => isFinite(t));
  const newest = ts.length ? new Date(Math.max(...ts)).toISOString() : null;
  return (
    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 1 }}>
      <Typography variant="caption" color="text.secondary">{newest ? `Odds through ${et(newest, { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "No odds uploaded yet for this market"}</Typography>
      <Button size="small" disabled={busy || !S.db} onClick={async () => { setBusy(true); const ok = await refreshLines(); setBusy(false); toast(ok ? "Odds refreshed." : "Couldn't refresh the odds. Try again in a moment."); }}
        sx={{ minHeight: 36, flexShrink: 0 }}>{busy ? "Refreshing…" : "Refresh odds"}</Button>
    </Stack>
  );
}
function WeeklyRankings({ onOpen }) {
  const S = useStore(); const [all, setAll] = useState(false); const [, tick] = useState(0);
  const [open, setOpen] = useState(() => store.get("fb_rank_open") === "1");          // collapsed on the first visit
  const [chosen, setChosen] = useState(() => store.get("fb_rank_view"));               // null until the user picks a view
  useEffect(() => { const iv = setInterval(() => tick((n) => n + 1), 60000); return () => clearInterval(iv); }, []); // kickoff + stale ages
  // opens on the plain "who is likeliest to score" list; the model-vs-price views are a choice (and say how they have done)
  const view = RANK_VIEWS.some(([k]) => k === chosen) ? chosen : "chance";
  useEffect(() => { if (open && view !== "chance") ensureExtras(); }, [open, view]);   // the track record comes with the results data
  const r = weekRankings(S.weekMarket); if (!r) return null;
  const rec = (() => { const gr = S.grades || {}; const m = (b) => b && (b.rules || []).find((x) => x.key === "marker" && x.n);
    const h = m(gr.betting_backtest), l = m(gr.betting); const one = (x) => `${x.wins} of ${x.n} won, ${x.roi >= 0 ? "+" : "−"}${Math.abs(x.roi * 100).toFixed(1)}% return per unit staked`;
    return { text: [h && `${one(h)} in the historical test${gr.betting_backtest.weeks ? ` (weeks ${gr.betting_backtest.weeks.join(", ")})` : ""}`, l && `${one(l)} live so far`].filter(Boolean).join("; "), any: !!(h || l) }; })();
  const pick = (v) => { if (!v) return; setChosen(v); store.set("fb_rank_view", v); setAll(false); };
  const toggle = () => { const n = !open; setOpen(n); store.set("fb_rank_open", n ? "1" : "0"); };
  const two = S.weekMarket === "2plus_td"; const est = two ? " est." : "";
  const list = r[view]; const shown = all ? list : list.slice(0, 10);
  const mk = two ? "2+ TDs" : "Anytime TD";
  const NOTE = {
    value: `Model ${two ? "2+ TD chance (estimate)" : "TD chance"} minus the chance implied by the best ${mk} price (book margin included): the best price under 2 hours old, or the best last-known price when every price is older. Only players above the model's fair odds are listed.`,
    chance: `Every available player in games still open, by the model's ${two ? "estimated 2+ TD chance" : "TD chance"}, priced or not.`,
    combined: "Players from Best Value, ranked by the average of their value rank and their TD-chance rank within that group (lower is better). Ties: higher chance, then higher edge.",
  };
  const Row = ({ x, i }) => {
    const g = x.g; const c = x.c; const locked = FB.isLocked(g, Date.now());
    const rank = view === "value" ? x.valueRank : i + 1;
    const right = view === "chance" ? null : view === "value" ? edgeTxt(x.edgePts) : x.score.toFixed(1);
    return (
      <Box component="li" sx={{ display: "flex", gap: 1, py: 0.75, borderBottom: 1, borderColor: "divider", alignItems: "flex-start" }}>
        <Typography sx={{ fontWeight: 700, minWidth: 28, pt: 0.25, color: "text.secondary" }}><Num>{rank}</Num></Typography>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <ButtonBase onClick={() => onOpen({ ...c, _g: g })} aria-label={`${x.name}, rank ${rank}. Open player details`}
            sx={{ display: "block", width: "100%", textAlign: "left", borderRadius: 1, minHeight: 44 }}>
            <Typography sx={{ fontWeight: 600, lineHeight: 1.3 }}>{x.name} <Typography component="span" variant="caption" color="text.secondary">{c.pos} · {c.team}</Typography></Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>{g.away} at {g.home} · {kick(g)}</Typography>
            <Typography variant="body2"><Num>{view === "combined" ? `Value #${x.valueRank} · Chance #${x.chanceRank} · Model ${pct(x.chance)}${est} · Edge ${edgeTxt(x.edgePts)}` : `Model ${pct(x.chance)}${est} · fair ${am(x.fair)}`}</Num></Typography>
            {view !== "chance" && <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}><PriceUsed b={x.best} />{x.stale && <> · <StaleTag /></>}</Typography>}
          </ButtonBase>
          <Stack direction="row" sx={{ gap: 1, mt: 0.5 }}>
            <ParlayButton c={c} locked={locked} msg="Added to parlay." />
            <PickButton c={c} g={g} locked={locked} />
          </Stack>
        </Box>
        {right && <Box sx={{ textAlign: "right", flexShrink: 0, maxWidth: 96, pt: 0.25 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>{view === "value" ? "Edge" : "Score"}</Typography>
          <Typography sx={{ fontWeight: 700, color: "text.primary" }}><Num>{right}</Num></Typography>
          {x.stale && <Typography variant="caption" sx={{ display: "block", lineHeight: 1.15, color: "warning.main" }}>Based on stale odds</Typography>}
        </Box>}
      </Box>
    );
  };
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <ButtonBase onClick={toggle} aria-expanded={open} aria-controls="weekly-rankings"
        sx={{ display: "flex", width: "100%", textAlign: "left", px: 1.5, py: 1, gap: 1, minHeight: 52, justifyContent: "flex-start" }}>
        <Typography variant="h6" component="h3" sx={{ flex: 1 }}>Weekly Rankings · {mk}</Typography>
        {!open && r.chance.length > 0 && <Typography variant="caption" color="text.secondary">{r.chance.length} players</Typography>}
        <Icon d={P.expand} sx={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .2s", color: "text.secondary" }} />
      </ButtonBase>
      {open && (
        <CardContent id="weekly-rankings" sx={{ display: "grid", gap: 1, pt: 0, pb: "12px !important" }}>
          <OddsThrough market={S.weekMarket} />
          <ToggleButtonGroup exclusive fullWidth size="small" value={view} onChange={(e, v) => pick(v)} aria-label="Ranking view"
            sx={{ "& .MuiToggleButton-root": { minHeight: 44, textTransform: "none", fontWeight: 600, px: 0.5, lineHeight: 1.15 } }}>
            {RANK_VIEWS.map(([k, l]) => <ToggleButton key={k} value={k}>{l}</ToggleButton>)}
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">{NOTE[view]}</Typography>
          {view !== "chance" && !two && <Alert severity="info" icon={false} sx={{ borderRadius: 2, py: 0.25 }} data-testid="rank-record">
            <b>How this has done:</b> {rec.any ? `bets where the model was at least ${FB.ABOVE_FAIR_PTS} points over the price: ${rec.text}. ` : ""}No rule tested so far has made money after the sportsbooks' margin, and prices have predicted better than the model. Use this list to see where the model and the books disagree, not as a tip sheet.</Alert>}
          {view !== "chance" && r.staleNote && list.length > 0 && <Alert severity="warning" sx={{ borderRadius: 2, py: 0 }}>{r.staleNote}</Alert>}
          {!list.length ? <Empty>{view === "chance" ? "No open games with model chances." : r.valueEmpty}</Empty> : (
            <Box component="ol" sx={{ m: 0, p: 0, listStyle: "none" }} aria-label={`${RANK_VIEWS.find((v) => v[0] === view)[1]} ranking`}>
              {shown.map((x, i) => <Row key={x.key} x={x} i={i} />)}
            </Box>
          )}
          {list.length > 10 && <Box><Button onClick={() => setAll(!all)}>{all ? "Show top 10" : `Show all ${list.length}`}</Button></Box>}
        </CardContent>
      )}
    </Card>
  );
}
