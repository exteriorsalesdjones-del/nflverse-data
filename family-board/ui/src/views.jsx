import { useMemo, useState } from "react";
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Autocomplete, Box, Button, ButtonBase, Card, CardContent, Chip, Dialog,
  DialogActions, DialogContent, DialogTitle, Drawer, LinearProgress, MenuItem, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Typography, useMediaQuery,
} from "@mui/material";
import {
  FB, useStore, effAttr, effCand, slateCands, myItems, priceFor, settlePick, nameOf, addPick, removePick, setPickStatus,
  exportCsv, parseOddsCsv, stageOdds, setOddsStatus, readShot, freeze, saveReview, setOverride, toast,
} from "./store.js";
import { Icon, P } from "./icons.jsx";

/* ---------- shared bits ---------- */
const pct = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(0) + "%");
const pct1 = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(1) + "%");
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
const et = (iso, opts) => (iso ? FB.fmtEt(Date.parse(iso), { month: "short", day: "numeric", ...opts }) + " ET" : "—");
const kick = (g) => { const k = FB.etToUtcMs(g.kickoff_et); return isNaN(k) ? g.kickoff_et : FB.fmtEt(k, {}) + " ET"; };
export const STATUS = { verified_individual: "Verified", probable_individual: "Probable", shared: "Shared", team_unit: "Team or unit", unknown: "Unknown" };
const STATUS_COLOR = { verified_individual: "success", probable_individual: "primary", shared: "secondary", team_unit: "warning", unknown: "default" };
const TYPE = { passing: "Passing", rushing: "Rushing", interception_return: "Interception return", fumble_return: "Fumble return", fumble_recovery: "Fumble recovery", kickoff_return: "Kickoff return", punt_return: "Punt return", blocked_punt_return: "Blocked punt return", blocked_kick_return: "Blocked kick return", other_return: "Other return", other: "Other" };
const RESULT = { win: ["Won", "success"], loss: ["Lost", "error"], void: ["Void", "default"], pending: ["Pending", "warning"], needs_review: ["Review", "secondary"], draft: ["Draft", "default"] };

const Num = ({ children, sx }) => <Box component="span" sx={{ fontVariantNumeric: "tabular-nums", ...sx }}>{children}</Box>;
const Result = ({ r }) => <Chip size="small" variant="outlined" color={RESULT[r.state][1]} label={RESULT[r.state][0]} title={r.why} />;
const StatusChip = ({ s }) => <Chip size="small" variant="outlined" color={STATUS_COLOR[s]} label={STATUS[s]} />;
const Empty = ({ children }) => <Box sx={{ p: 2, border: 1, borderStyle: "dashed", borderColor: "divider", borderRadius: 2, color: "text.secondary" }}>{children}</Box>;
const H2 = ({ children, sx }) => <Typography variant="h5" component="h2" sx={sx}>{children}</Typography>;
function Fold({ title, summary, children, defaultExpanded = false }) {
  return (
    <Accordion disableGutters defaultExpanded={defaultExpanded} variant="outlined" sx={{ borderRadius: 2, "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<Icon d={P.expand} />} sx={{ minHeight: 56 }}>
        <Box><Typography variant="h6" component="h3">{title}</Typography>{summary && <Typography variant="body2" color="text.secondary">{summary}</Typography>}</Box>
      </AccordionSummary>
      <AccordionDetails sx={{ display: "grid", gap: 1.5 }}>{children}</AccordionDetails>
    </Accordion>
  );
}
function Sheet({ open, onClose, title, children, actions }) {
  return (
    <Drawer anchor="bottom" open={open} onClose={onClose} slotProps={{ paper: { sx: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "88vh", pb: "env(safe-area-inset-bottom, 0px)" } } }}>
      <Box sx={{ width: 40, height: 4, borderRadius: 2, bgcolor: "divider", mx: "auto", mt: 1 }} />
      <Box sx={{ px: "max(16px, env(safe-area-inset-left, 0px))", pt: 1, pb: 2, display: "grid", gap: 1.5, overflowY: "auto", maxWidth: 720, width: "100%", mx: "auto" }}>
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
    off: "Sign in to Claude to make picks and see the family board.", error: "Lost the connection to family picks. Reload to reconnect." }[S.dbState];
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
          <H2>Week {s.week}</H2>
          <Button size="large" startIcon={<Icon d={P.info} />} onClick={() => setHow(true)}>How this works</Button>
        </Stack>
        <Typography variant="body2" color="text.secondary">{open.length} open games · {locked.length} started or final · research odds, no sportsbook prices yet</Typography>
      </Box>
      {open.length === 0 && <Empty>Every game this week has kicked off. The next slate appears after the Tuesday refresh.</Empty>}
      {open.map((g) => <GameCard key={g.game_id} g={g} onOpen={setSheet} />)}
      {locked.length > 0 && (
        <Button variant="outlined" size="large" onClick={() => setShowLocked(!showLocked)}>{showLocked ? "Hide" : "Show"} {locked.length} started or final game{locked.length > 1 ? "s" : ""}</Button>
      )}
      {showLocked && locked.map((g) => <GameCard key={g.game_id} g={g} onOpen={setSheet} />)}
      <Fold title="Suggested slates" summary="3, 5, 7, 10-leg and full-week ideas from open games"><Slates /></Fold>
      <Fold title="Matchup boosts" summary="Who the opponent's defense helps or hurts (untested)"><Matchups onOpen={setSheet} /></Fold>
      <HowItWorks open={how} onClose={() => setHow(false)} />
      <PlayerSheet c={sheet} onClose={() => setSheet(null)} />
    </Stack>
  );
}

function GameCard({ g, onOpen }) {
  const [all, setAll] = useState(false);
  const locked = FB.isLocked(g, Date.now());
  const status = g.status === "final" ? `Final ${g.away_score}–${g.home_score}` : locked ? "Locked" : "Open";
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent sx={{ display: "grid", gap: 1, p: 1.5, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <Typography variant="h6" component="h3" sx={{ flex: 1 }}>{g.away} at {g.home}</Typography>
          <Chip size="small" label={status} color={locked ? "default" : "primary"} variant={locked ? "outlined" : "filled"} />
        </Stack>
        <Typography variant="body2" color="text.secondary">{kick(g)}{g.roof ? ` · ${g.roof}` : ""}</Typography>
        {g.teams.map((t) => {
          const cands = t.candidates.map(effCand);
          const avail = cands.filter((c) => c.quality !== "unavailable"); const out = cands.filter((c) => c.quality === "unavailable");
          const shown = all ? avail : avail.slice(0, 3);
          return (
            <Box key={t.team} sx={{ borderTop: 1, borderColor: "divider", pt: 1 }}>
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 2 }}>
                {t.team} · {t.implied_points != null ? `${t.implied_points} implied pts` : "no line yet"}
              </Typography>
              {shown.map((c) => <PlayerRow key={c.gsis_id} c={c} g={g} locked={locked} onOpen={onOpen} />)}
              {all && out.length > 0 && <Typography variant="body2" color="text.secondary" sx={{ py: 0.5 }}>Not available: {out.map((c) => `${c.full_name || c.player} (${c.injury})`).join(", ")}</Typography>}
              {all && (t.removed || []).length > 0 && <Typography variant="body2" color="text.secondary" sx={{ pb: 0.5 }}>Off the active roster: {t.removed.map((d) => `${d.player} (${d.why})`).join(", ")}</Typography>}
            </Box>
          );
        })}
        <Button onClick={() => setAll(!all)} sx={{ minHeight: 44 }}>{all ? "Show top 3 per team" : "Show all players"}</Button>
      </CardContent>
    </Card>
  );
}

function PickButton({ c, g, locked, size = "medium" }) {
  const S = useStore(); const key = FB.pickKey(g.week, c.gsis_id); const picked = !!myItems()[key];
  const disabled = locked || !S.uid || S.dbState === "off" || c.quality === "unavailable";
  return (
    <Button variant={picked ? "outlined" : "contained"} size={size} disabled={disabled && !picked}
      onClick={(e) => { e.stopPropagation(); picked ? (!locked && removePick(key)) : addPick(c); }}
      sx={{ minWidth: 88, minHeight: 44, flexShrink: 0 }} aria-label={picked ? `Remove ${c.full_name || c.player}` : `Pick ${c.full_name || c.player}`}>
      {picked ? "Picked ✓" : "Pick"}
    </Button>
  );
}
function PlayerRow({ c, g, locked, onOpen }) {
  const mu = c.p_matchup != null && Math.abs(c.matchup_pct) >= 8 ? c.matchup_pct : null;
  return (
    <Stack direction="row" sx={{ alignItems: "center", gap: 1, py: 0.75 }}>
      <ButtonBase onClick={() => onOpen({ ...c, _g: g })} sx={{ flex: 1, minWidth: 0, justifyContent: "flex-start", textAlign: "left", borderRadius: 1, minHeight: 44, display: "block" }}>
        <Stack direction="row" sx={{ alignItems: "baseline", gap: 0.75, flexWrap: "wrap" }}>
          <Typography sx={{ fontWeight: 600 }} noWrap>{c.full_name || c.player}</Typography>
          <Typography variant="caption" color="text.secondary">{c.pos}</Typography>
          {c.injury && <Chip size="small" color={c.quality === "unavailable" ? "error" : "warning"} variant="outlined" label={c.injury} sx={{ height: 20 }} />}
          {mu != null && <Typography variant="caption" sx={{ color: mu > 0 ? "success.main" : "error.main", fontWeight: 600 }}>matchup {mu > 0 ? "+" : ""}{Math.round(mu)}%</Typography>}
        </Stack>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1 }}>
          <LinearProgress variant="determinate" value={Math.min(100, c.p * 100)} sx={{ flex: 1, maxWidth: 160, height: 6, borderRadius: 3 }} aria-hidden />
          <Typography variant="body2" sx={{ fontWeight: 600 }}><Num>{pct(c.p)}</Num></Typography>
          <Typography variant="body2" color="text.secondary"><Num>fair {am(c.fair_american)}</Num></Typography>
        </Stack>
      </ButtonBase>
      <PickButton c={c} g={g} locked={locked} />
    </Stack>
  );
}
function PlayerSheet({ c, onClose }) {
  const S = useStore();
  if (!c) return <Sheet open={false} onClose={onClose} />;
  const g = c._g; const locked = FB.isLocked(g, Date.now());
  const pr = priceFor(c, g.week); const e = pr ? FB.edge(c.p, pr.american) : null;
  const rows = [["Chance to score", pct1(c.p)], ["Fair odds", am(c.fair_american)],
    ["Sportsbook price", pr ? `${pr.book} ${am(pr.american)} (${pct1(e.implied)}) · ${et(pr.captured_at, { hour: "numeric", minute: "2-digit" })}` : "Not imported yet"],
    ...(e ? [["Edge", `${e.edgePts.toFixed(1)} pts · EV ${e.evPerDollar >= 0 ? "+" : ""}${e.evPerDollar.toFixed(2)} per $1${FB.priceFresh(pr, Date.now(), 120) ? "" : " · price is stale"}`]] : []),
    ["With matchup (untested)", c.p_matchup != null ? `${pct1(c.p_matchup)} (${c.matchup_pct > 0 ? "+" : ""}${c.matchup_pct}%)` : "—"],
    ["Usage", `${Math.round(c.share * 100)}% of ${c.team}'s scoring chances · ${c.i10} touches inside the 10 · ${c.games} games`]];
  return (
    <Sheet open onClose={onClose} title={`${c.full_name || c.player} · ${c.pos || ""} ${c.team}`} actions={<PickButton c={c} g={g} locked={locked} size="large" />}>
      <Typography variant="body2" color="text.secondary">{g.away} at {g.home} · {kick(g)}</Typography>
      {c.injury && <Alert severity={c.quality === "unavailable" ? "error" : "warning"} sx={{ borderRadius: 2 }}>{c.injury}{c.override ? ` (set by an admin${c.override.note ? `: ${c.override.note}` : ""})` : " on the injury report"}</Alert>}
      <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "minmax(110px, max-content) minmax(0,1fr)", gap: "6px 12px", m: 0 }}>
        {rows.map(([k, v]) => [<Typography key={k} component="dt" variant="body2" color="text.secondary">{k}</Typography>,
          <Typography key={k + "v"} component="dd" variant="body2" sx={{ m: 0 }}>{v}</Typography>])}
      </Box>
      <Typography variant="body2"><b>Why:</b> {c.reason}</Typography>
      <Typography variant="body2"><b>Risk:</b> {c.risk}</Typography>
      {c.matchup_why && <Typography variant="body2" color="text.secondary"><b>Matchup:</b> {c.matchup_why}</Typography>}
      {!S.uid && <Typography variant="body2" color="text.secondary">Sign in to Claude to pick.</Typography>}
    </Sheet>
  );
}

function Slates() {
  const S = useStore();
  const open = S.slate.games.filter((g) => !FB.isLocked(g, Date.now()));
  const cands = open.flatMap((g) => g.teams.flatMap((t) => t.candidates)).map(effCand);
  const defs = [[3, "game", "3-leg"], [5, "game", "5-leg"], [7, "game", "7-leg"], [10, "team", "10-leg (one per team)"], [open.length, "game", "Full week"]];
  return (
    <>
      <Typography variant="body2" color="text.secondary">Highest chances first, one player per game (10-leg: one per team). The combined chance is a model estimate; sportsbook parlay odds are never quoted.</Typography>
      {defs.filter(([n]) => n).map(([n, rule, label]) => {
        const s = FB.suggestSlate(cands, n, rule);
        return (
          <Box key={label} sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, display: "grid", gap: 0.5 }}>
            <Stack direction="row" sx={{ justifyContent: "space-between", gap: 1 }}><Typography sx={{ fontWeight: 600 }}>{label}</Typography><Num>all hit: {pct1(s.jointP)}</Num></Stack>
            {s.short > 0 && <Typography variant="body2" color="error">Only {s.legs.length} of {n} legs available.</Typography>}
            <Typography variant="body2">{s.legs.map((l) => `${l.full_name || l.player} ${pct(l.p)}`).join(" · ") || "—"}</Typography>
            {rule === "team" && <Typography variant="caption" color="text.secondary">{s.jointNote}</Typography>}
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
const VARIANT_LABEL = { baseline: "Usage share + betting total", recency: "+ recency weighting", recency_skill: "+ player skill (Poisson-Gamma)", recency_skill_kalman: "+ Kalman team filter",
  full: "All enhancements + calibration", baseline_calibrated: "Usage share + calibration", matchup_pos: "+ position matchups", matchup_pos_cov: "+ position matchups and coverage" };
function HowItWorks({ open, onClose }) {
  const S = useStore(); const v = S.validation; const s = S.slate; const gate = FB.modelValidated(v);
  const full = useMediaQuery("(max-width:600px)");
  return (
    <Dialog open={open} onClose={onClose} fullScreen={full} fullWidth maxWidth="md" scroll="paper">
      <DialogTitle>How this works</DialogTitle>
      <DialogContent dividers sx={{ display: "grid", gap: 1.5 }}>
        <Typography variant="body2">Each player's chance to score comes from his share of his team's scoring chances this season (carries and targets, weighted toward the goal line), times the touchdowns the betting line expects from his team, then calibrated against earlier weeks. Players must be on their team's active roster. "Fair odds" is that chance written as American odds.</Typography>
        <Alert severity="warning" sx={{ borderRadius: 2 }}>Research only. "Value Play" stays off until the model passes its checks{gate.ok ? "" : ` (${gate.reasons.length} still open)`} and real sportsbook prices are imported. A week with no value plays is normal.</Alert>
        <Typography variant="subtitle2">Not connected yet</Typography>
        <Typography variant="body2" color="text.secondary">{s.missing.join("; ")}.</Typography>
        <Typography variant="subtitle2">How the model was tested</Typography>
        <Typography variant="body2" color="text.secondary">Every method predicted each past week using only earlier weeks (weeks {v.weeks.join("–")}, {v.n} player-games). A method goes live only when it beats the plain model across 90% of resampled games. Live now: <b>{VARIANT_LABEL[v.chosen] || v.chosen}</b>.</Typography>
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
  if (!S.extrasLoaded) return <Empty>Loading the season's touchdowns…</Empty>;
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
      <H2>Touchdowns</H2>
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
      <Typography variant="caption" color="text.secondary">Tap a game to see only its touchdowns.</Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
        {finals.map((g) => <Chip key={g.game_id} clickable onClick={() => pickGame(g.game_id)} color={game === g.game_id ? "primary" : "default"} variant={game === g.game_id ? "filled" : "outlined"}
          label={`${g.away} ${g.away_score} · ${g.home} ${g.home_score}`} sx={{ height: 40 }} />)}
      </Box>
    </CardContent></Card>
  );
}
function PlayCard({ t, onOpen }) {
  const a = effAttr(t);
  return (
    <ButtonBase onClick={onOpen} sx={{ display: "block", textAlign: "left", border: 1, borderColor: "divider", borderRadius: 2, p: 1.5, bgcolor: "background.paper" }}>
      <Stack direction="row" sx={{ alignItems: "baseline", gap: 1 }}>
        <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>{t.scorer || "Team"} <Typography component="span" variant="caption" color="text.secondary">{t.scorer_pos} {t.team}</Typography></Typography>
        <Typography variant="body2" color="text.secondary"><Num>Wk {t.week} · Q{t.qtr} {t.clock}</Num></Typography>
      </Stack>
      <Stack direction="row" sx={{ alignItems: "center", gap: 1, mt: 0.5, flexWrap: "wrap" }}>
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{TYPE[t.type]}{t.yards != null ? `, ${t.yards} yds` : ""} vs {t.opp}{(a.defenders || []).length ? ` · on ${a.defenders.map((d) => d.name).join(", ")}` : ""}</Typography>
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
export function PicksView() {
  const S = useStore();
  if (!S.uid) return <Stack spacing={1.5}><H2>My picks</H2><DbNote /></Stack>;
  const items = Object.values(myItems()).sort((a, b) => b.week - a.week || FB.etToUtcMs((S.gameById[a.game_id] || {}).kickoff_et) - FB.etToUtcMs((S.gameById[b.game_id] || {}).kickoff_et));
  const weeks = [...new Set(items.map((p) => p.week))];
  return (
    <Stack spacing={1.5}>
      <H2>My picks</H2>
      <DbNote />
      {!items.length && <Empty>No picks yet. Open This Week and tap Pick on a player. You can change picks until each game kicks off.</Empty>}
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
                      <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>{p.player} <Typography component="span" variant="caption" color="text.secondary">{p.pos} {p.team}</Typography></Typography>
                      <Result r={r} />
                    </Stack>
                    <Typography variant="body2" color="text.secondary">{g.away} at {g.home} · {g.kickoff_et ? kick(g) : ""}</Typography>
                    <Typography variant="body2" color="text.secondary">{p.price ? <Num>{p.price.book} {am(p.price.american)} when picked</Num> : "No sportsbook price when picked"}{p.model_p ? ` · model ${pct(p.model_p)}` : ""}</Typography>
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
export function BoardView() {
  const S = useStore();
  const all = Object.entries(S.allPicks).flatMap(([uid, d]) => Object.values(d.items || {}).filter((p) => p.status === "submitted").map((p) => ({ uid, p, r: settlePick(uid, p) })));
  const weeks = [...new Set(all.map((x) => x.p.week))].sort((a, b) => b - a);
  const totals = {}; all.forEach(({ uid, r }) => { const t = (totals[uid] ||= { win: 0, loss: 0, void: 0, pending: 0, needs_review: 0 }); t[r.state] = (t[r.state] || 0) + 1; });
  const standings = Object.entries(totals).sort((a, b) => b[1].win - a[1].win || a[1].loss - b[1].loss);
  return (
    <Stack spacing={1.5}>
      <H2>Family board</H2>
      <DbNote />
      {!all.length && <Empty>No picks yet. Picks show up here as soon as anyone makes one.</Empty>}
      {standings.length > 0 && (
        <Card variant="outlined" sx={{ borderRadius: 2 }}><CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Typography variant="overline" color="text.secondary">Season standings</Typography>
          {standings.map(([uid, t], i) => (
            <Stack key={uid} direction="row" sx={{ alignItems: "center", gap: 1, py: 0.75, borderTop: i ? 1 : 0, borderColor: "divider", flexWrap: "wrap" }}>
              <Typography sx={{ fontWeight: 600, flex: 1 }}>{i + 1}. {nameOf(uid)}</Typography>
              <Num sx={{ fontWeight: 600 }}>{t.win}–{t.loss}</Num>
              {t.pending > 0 && <Chip size="small" variant="outlined" color="warning" label={`${t.pending} pending`} />}
              {t.void > 0 && <Chip size="small" variant="outlined" label={`${t.void} void`} />}
            </Stack>
          ))}
        </CardContent></Card>
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
                        <Box sx={{ flex: 1, minWidth: 0 }}><Typography noWrap>{p.player} <Typography component="span" variant="caption" color="text.secondary">{p.team}</Typography></Typography>
                          <Typography variant="caption" color="text.secondary">{g.away} at {g.home}{p.price ? ` · ${p.price.book} ${am(p.price.american)}` : ""}</Typography></Box>
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
  const S = useStore(); const [csv, setCsv] = useState(""); const [book, setBook] = useState(""); const [play, setPlay] = useState(null);
  const [who, setWho] = useState(null); const [st, setSt] = useState("Out"); const [note, setNote] = useState("");
  const cands = useMemo(() => slateCands().map((c) => ({ ...c, label: `${c.full_name || c.player} · ${c.pos || ""} ${c.team}` })), [S.slate]);
  if (!S.isAdmin) return <Empty>Admins only.</Empty>;
  const week = S.slate.week; const d = S.odds["w" + week]; const now = Date.now();
  const started = S.slate.games.filter((g) => FB.isLocked(g, now));
  const ov = (S.overrides["w" + week] || {}).players || {};
  const queue = S.extrasLoaded ? S.tds.filter((t) => t.unit === "offense" && effAttr(t).status !== "verified_individual").slice(-20).reverse() : [];
  return (
    <Stack spacing={1.5}>
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
      <Fold title={`Odds import · week ${week}`} summary="Paste CSV or read a screenshot; prices stay pending until you approve">
        <TextField multiline minRows={4} label="CSV rows" placeholder={"player,team,book,american,captured_at\nTrey McBride,ARI,FanDuel,+180,2026-11-15T10:05:00-05:00"} value={csv} onChange={(e) => setCsv(e.target.value)} slotProps={{ input: { sx: { fontFamily: "var(--fb-mono)", fontSize: 12 } } }} />
        <Button variant="contained" size="large" onClick={() => stageOdds(parseOddsCsv(csv), "csv")}>Stage CSV rows</Button>
        {S.sample ? <Stack direction="row" sx={{ gap: 1 }}>
          <TextField label="Book" value={book} onChange={(e) => setBook(e.target.value)} sx={{ flex: 1 }} />
          <Button component="label" variant="outlined" size="large">Read screenshot<input hidden type="file" accept="image/*" onChange={(e) => readShot(e.target.files[0], book)} /></Button>
        </Stack> : <Typography variant="caption" color="text.secondary">Screenshot reading isn't available in this view.</Typography>}
        {d && <>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
            <Chip color={d.status === "live" ? "success" : "warning"} label={d.status} />
            <Typography variant="caption" color="text.secondary">{(d.rows || []).length} rows · {d.source} · {et(d.imported_at, { hour: "numeric", minute: "2-digit" })}</Typography>
          </Stack>
          {d.status !== "live" ? <Button variant="contained" size="large" onClick={() => setOddsStatus("live")}>Approve and publish</Button> : <Button variant="outlined" size="large" onClick={() => setOddsStatus("pending")}>Withdraw</Button>}
          {(d.rows || []).map((r, i) => <Typography key={i} variant="body2">{r.player} {r.team} · {r.book} <Num>{am(r.american)}</Num> {r.gsis_id ? "" : <Box component="span" sx={{ color: "error.main" }}>· unmatched</Box>}</Typography>)}
        </>}
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
      <Fold title="Data sources">
        {S.meta.sources.map((s) => <Typography key={s.name} variant="body2"><b>{s.name}</b>: {s.fields}{s.through_week ? ` (through week ${s.through_week})` : ""}</Typography>)}
        <Typography variant="body2" color="text.secondary">Not connected: {S.meta.not_connected.join("; ")}.</Typography>
        <Typography variant="body2" color="text.secondary">Roster check: players must be on their team's active roster (week {S.slate.roster_week}).</Typography>
      </Fold>
      {play && <PlayDialog t={play} onClose={() => setPlay(null)} />}
    </Stack>
  );
}
