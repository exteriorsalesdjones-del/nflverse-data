import { useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, LinearProgress,
  Link, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from "@mui/material";
import {
  FB, useStore, effAttr, slateCands, myItems, priceFor, settlePick, nameOf, addPick, setPickStatus, exportCsv,
  parseOddsCsv, stageOdds, setOddsStatus, readShot, freeze, saveReview, toast,
} from "./store.js";

const pct = (p) => (p == null || isNaN(p) ? "—" : (p * 100).toFixed(1) + "%");
const am = (a) => (a == null || isNaN(a) ? "—" : (a > 0 ? "+" : "") + a);
export const STATUS = { verified_individual: "Verified individual", probable_individual: "Probable individual", shared: "Shared", team_unit: "Team or unit", unknown: "Unknown" };
const STATUS_COLOR = { verified_individual: "success", probable_individual: "primary", shared: "secondary", team_unit: "warning", unknown: "default" };
const TYPE = { passing: "Passing", rushing: "Rushing", interception_return: "Interception return", fumble_return: "Fumble return", fumble_recovery: "Fumble recovery", kickoff_return: "Kickoff return", punt_return: "Punt return", blocked_punt_return: "Blocked punt return", blocked_kick_return: "Blocked kick return", other_return: "Other return", other: "Other" };
const RESULT = { win: ["Win", "success"], loss: ["Loss", "error"], void: ["Void", "default"], pending: ["Pending", "warning"], needs_review: ["Needs review", "secondary"], draft: ["Draft", "default"] };

const Section = ({ title, action, children }) => (
  <Card variant="outlined">
    <CardContent sx={{ display: "grid", gap: 1.5 }}>
      {(title || action) && (
        <Stack direction="row" sx={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
          {title && <Typography variant="h5" component="h2">{title}</Typography>}{action}
        </Stack>
      )}
      {children}
    </CardContent>
  </Card>
);
const Num = ({ children, ...p }) => <Box component="span" sx={{ fontFamily: "var(--fb-mono)", fontVariantNumeric: "tabular-nums" }} {...p}>{children}</Box>;
const Result = ({ r }) => <Chip size="small" variant="outlined" color={RESULT[r.state][1]} label={RESULT[r.state][0]} title={r.why} />;
const StatusChip = ({ s }) => <Chip size="small" variant="outlined" color={STATUS_COLOR[s]} label={STATUS[s]} />;
const Empty = ({ children }) => <Box sx={{ p: 2, border: 1, borderStyle: "dashed", borderColor: "divider", borderRadius: 1, color: "text.secondary" }}>{children}</Box>;

export function DbNote() {
  const S = useStore();
  if (S.dbState === "ok") return null;
  const msg = { connecting: "Connecting to the shared picks…", slow: "Shared picks can't be reached yet. Research views still work.",
    off: "Sign in to Claude to save and see family picks. Research views work without it.", error: "Lost the connection to shared picks. Reload the page to reconnect." }[S.dbState];
  return <Alert severity={S.dbState === "error" ? "error" : "info"}>{msg}</Alert>;
}

/* ===================== This Week ===================== */
export function WeekView() {
  const S = useStore(); const s = S.slate; const gate = FB.modelValidated(S.validation); const now = Date.now();
  return (
    <Stack spacing={2}>
      <DbNote />
      <Alert severity="warning" variant="outlined">
        <Typography variant="subtitle2">Week {s.week} research slate · model {s.model_version} · research only</Typography>
        <Typography variant="body2">{gate.ok ? "Model meets the validation bar." : "No Value Plays: " + gate.reasons.join(" ")}</Typography>
        <Typography variant="body2" color="text.secondary">Missing: {s.missing.join("; ")}.</Typography>
      </Alert>
      <ModelCheck />
      <Matchups />
      <Slates />
      <Section title={`Week ${s.week} games`}>
        {s.games.map((g) => {
          const locked = FB.isLocked(g, now); const ko = FB.etToUtcMs(g.kickoff_et);
          return (
            <Box key={g.game_id} sx={{ borderTop: 1, borderColor: "divider", pt: 1.5, "&:first-of-type": { borderTop: 0, pt: 0 } }}>
              <Stack direction="row" sx={{ flexWrap: "wrap", gap: 1, alignItems: "baseline", mb: 1 }}>
                <Typography variant="h6" component="h3">{g.away} at {g.home}</Typography>
                <Num>{isNaN(ko) ? g.kickoff_et : FB.fmtEt(ko, { month: "short", day: "numeric" }) + " ET"}</Num>
                <Chip size="small" variant="outlined" color={g.status === "final" ? "default" : locked ? "warning" : "primary"}
                  label={g.status === "final" ? `Final ${g.away_score}-${g.home_score}` : locked ? "Locked" : g.status === "upcoming" ? "Open" : g.status.replace(/_/g, " ")} />
                {g.roof && <Typography variant="caption" color="text.secondary">{g.roof}</Typography>}
              </Stack>
              <Grid container spacing={2}>
                {g.teams.map((t) => <Grid key={t.team} size={{ xs: 12, md: 6 }}><TeamCol g={g} t={t} locked={locked} /></Grid>)}
              </Grid>
            </Box>
          );
        })}
      </Section>
    </Stack>
  );
}
function TeamCol({ g, t, locked }) {
  const S = useStore(); const now = Date.now(); const mine = myItems();
  const allowed = Object.entries(t.opp_td_allowed_by_pos).map(([k, v]) => v + " " + k).join(", ") || "no";
  return (
    <Box>
      <Typography variant="subtitle1" component="h4" sx={{ fontFamily: "var(--fb-display)", textTransform: "uppercase", fontWeight: 600 }}>{t.team} offense</Typography>
      <Typography variant="caption" color="text.secondary">
        {t.implied_points != null ? `Implied ${t.implied_points} pts · ${t.expected_off_tds} expected offensive TDs · ${t.opp} has allowed ${allowed} TDs in ${t.opp_games} games` : "No spread/total yet, so no projection."}
      </Typography>
      {!t.candidates.length && <Empty>No candidates with enough usage data.</Empty>}
      {t.candidates.map((c) => {
        const pr = priceFor(c, g.week); const e = pr ? FB.edge(c.p, pr.american) : null; const fresh = pr && FB.priceFresh(pr, now, 120);
        const picked = !!mine[FB.pickKey(g.week, c.gsis_id)];
        return (
          <Stack key={c.gsis_id} direction="row" sx={{ gap: 1, py: 1, borderTop: 1, borderColor: "divider", borderTopStyle: "dashed", alignItems: "flex-start" }}>
            <Box sx={{ flex: 1, minWidth: 0, display: "grid", gap: 0.5 }}>
              <Stack direction="row" sx={{ gap: 0.75, flexWrap: "wrap", alignItems: "center" }}>
                <Typography sx={{ fontWeight: 600 }}>{c.full_name || c.player}</Typography>
                <Typography variant="caption" color="text.secondary">{c.pos}</Typography>
                <Chip size="small" variant="outlined" color={c.quality === "ok" ? "primary" : c.quality === "limited" ? "warning" : "error"} label={c.quality === "ok" ? "data ok" : c.quality} />
                {c.injury && <Chip size="small" variant="outlined" color="warning" label={c.injury} />}
              </Stack>
              <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                <LinearProgress variant="determinate" value={Math.min(100, c.p * 100)} sx={{ width: 120, height: 6, borderRadius: 3 }} aria-label="Model probability" />
                <Num>Model {pct(c.p)}</Num><Num style={{ opacity: 0.7 }}>fair {am(c.fair_american)}</Num>
              </Stack>
              <Typography variant="body2">
                {pr ? <Num>{pr.book} anytime TD {am(pr.american)} ({pct(e.implied)}) · edge {e.edgePts.toFixed(1)} pts · EV {e.evPerDollar >= 0 ? "+" : ""}{e.evPerDollar.toFixed(2)}/$1{fresh ? "" : " · stale"}</Num>
                  : <Box component="span" sx={{ color: "text.secondary" }}>No live price</Box>}
              </Typography>
              {c.p_matchup != null && Math.abs(c.matchup_pct) >= 3 && (
                <Typography variant="body2" sx={{ color: c.matchup_pct > 0 ? "success.main" : "error.main" }}>
                  <b>Matchup {c.matchup_pct > 0 ? "+" : ""}{c.matchup_pct}%</b> → {pct(c.p_matchup)} <Box component="span" sx={{ color: "text.secondary" }}>(untested) · {c.matchup_why}</Box>
                </Typography>
              )}
              <Typography variant="body2"><b>Why:</b> {c.reason} <b>Risk:</b> {c.risk}</Typography>
            </Box>
            <Button size="small" variant={picked ? "outlined" : "contained"} onClick={() => addPick(c)}
              disabled={locked || picked || !S.uid || S.dbState === "off" || c.quality === "unavailable"}>{picked ? "Saved" : "Pick"}</Button>
          </Stack>
        );
      })}
    </Box>
  );
}
const VARIANT_LABEL = {
  baseline: "Usage share + betting total", recency: "+ recency weighting (half-life 4 weeks)", recency_skill: "+ Poisson-Gamma player skill",
  recency_skill_kalman: "+ Kalman team filter", full: "All enhancements + calibration", baseline_calibrated: "Usage share + calibration",
  matchup_pos: "+ position matchups", matchup_pos_cov: "+ position matchups and coverage",
};
function ModelCheck() {
  const S = useStore(); const v = S.validation; const [open, setOpen] = useState(false);
  if (!v.variants) return null;
  const rows = Object.entries(v.variants).sort((a, b) => a[1].log_loss - b[1].log_loss);
  return (
    <Section title="How the model was tested" action={<Button size="small" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} results</Button>}>
      <Typography variant="body2">
        Headline odds use <b>{VARIANT_LABEL[v.chosen] || v.chosen}</b>. Each candidate method predicted every week from earlier weeks only (weeks {v.weeks.join("–")}, {v.n} player-games). A method goes live only when its gain over the plain model is above zero across 90% of resampled games.
      </Typography>
      {open && (
        <TableContainer><Table size="small">
          <TableHead><TableRow>{["Method", "Log loss", "Gain ×1000 (90% range)", "Brier", "Worst calibration gap", "Status"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
          <TableBody>{rows.map(([k, x]) => (
            <TableRow key={k} selected={k === v.chosen}>
              <TableCell>{VARIANT_LABEL[k] || k}</TableCell><TableCell><Num>{x.log_loss.toFixed(4)}</Num></TableCell>
              <TableCell><Num>{x.ll_gain_ci90 ? `${(x.ll_gain * 1000).toFixed(1)} (${(x.ll_gain_ci90[0] * 1000).toFixed(1)} to ${(x.ll_gain_ci90[1] * 1000).toFixed(1)})` : "reference"}</Num></TableCell>
              <TableCell><Num>{x.brier.toFixed(4)}</Num></TableCell><TableCell><Num>{x.max_cal_gap != null ? (x.max_cal_gap * 100).toFixed(1) + " pts" : "—"}</Num></TableCell>
              <TableCell>{k === v.chosen ? <Chip size="small" color="success" label="live" /> : (v.passing || []).includes(k) ? <Chip size="small" variant="outlined" label="passes" />
                : k === "baseline" ? <Chip size="small" variant="outlined" label="reference" /> : <Chip size="small" variant="outlined" label="not proven" />}</TableCell>
            </TableRow>))}</TableBody>
        </Table></TableContainer>
      )}
    </Section>
  );
}
function Matchups() {
  const S = useStore(); const v = S.validation; const mv = v.variants || {};
  const open = S.slate.games.filter((g) => !FB.isLocked(g, Date.now()));
  const cands = open.flatMap((g) => g.teams.flatMap((t) => t.candidates)).filter((c) => c.quality !== "unavailable" && c.p_matchup != null && c.p >= 0.08);
  const up = cands.slice().sort((a, b) => b.matchup_pct - a.matchup_pct).slice(0, 8);
  const down = cands.slice().sort((a, b) => a.matchup_pct - b.matchup_pct).slice(0, 5);
  const gain = (k) => mv[k] && mv[k].ll_gain_ci90 ? `${(mv[k].ll_gain * 1000).toFixed(1)} (90% range ${(mv[k].ll_gain_ci90[0] * 1000).toFixed(1)} to ${(mv[k].ll_gain_ci90[1] * 1000).toFixed(1)})` : "—";
  const Row = ({ c }) => (
    <TableRow><TableCell>{c.full_name || c.player} <Typography component="span" variant="caption" color="text.secondary">{c.team} {c.pos}</Typography></TableCell>
      <TableCell><Num>{pct(c.p)}</Num></TableCell><TableCell><Num>{pct(c.p_matchup)}</Num></TableCell>
      <TableCell><Num style={{ color: c.matchup_pct > 0 ? "var(--fb-up)" : "var(--fb-down)" }}>{c.matchup_pct > 0 ? "+" : ""}{c.matchup_pct}%</Num></TableCell>
      <TableCell sx={{ minWidth: 220 }}><Typography variant="caption">{c.matchup_why}</Typography></TableCell></TableRow>
  );
  const T = ({ rows }) => (
    <TableContainer><Table size="small">
      <TableHead><TableRow>{["Player", "Usage model", "With matchup", "Change", "Why"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
      <TableBody>{rows.map((c) => <Row key={c.gsis_id} c={c} />)}</TableBody>
    </Table></TableContainer>
  );
  return (
    <Section title="Matchup boosts">
      <Typography variant="body2" color="text.secondary">
        How each opponent has allowed touchdowns this season, by position group, run or catch, and its charted coverage, moves touchdown chances between players on the same team. The team's total still comes from the betting line. Players with at least an 8% usage-model chance in open games.
      </Typography>
      <Alert severity={!String(v.chosen).startsWith("matchup") ? "info" : "success"} variant="outlined">
        {!String(v.chosen).startsWith("matchup")
          ? `Untested: in the week-by-week check (weeks ${v.weeks.join("–")}, ${v.n} player-games), matchup adjustments have not yet improved accuracy over usage alone. Log-loss gain ×1000: position matchup ${gain("matchup_pos")}, plus coverage ${gain("matchup_pos_cov")}. Headline probabilities and fair odds don't include matchups; this is rechecked every refresh.`
          : `The matchup model beat usage alone in the week-by-week check, so headline probabilities now include it (${v.chosen}).`}
      </Alert>
      <Typography variant="subtitle2">Biggest boosts</Typography><T rows={up} />
      <Typography variant="subtitle2">Biggest cuts</Typography><T rows={down} />
    </Section>
  );
}
function Slates() {
  const S = useStore();
  const open = S.slate.games.filter((g) => !FB.isLocked(g, Date.now()));
  const cands = open.flatMap((g) => g.teams.flatMap((t) => t.candidates));
  const defs = [[3, "game", "3-leg"], [5, "game", "5-leg"], [7, "game", "7-leg"], [10, "team", "10-leg (one per team)"], [open.length, "game", "Full week (one per open game)"]];
  return (
    <Section title="Suggested research slates">
      <Typography variant="body2" color="text.secondary">Built from open games only, highest model probability first. Combined odds are never quoted; the joint figure is a model estimate.</Typography>
      <Grid container spacing={1.5}>
        {defs.filter(([n]) => n).map(([n, rule, label]) => {
          const s = FB.suggestSlate(cands, n, rule);
          return (
            <Grid key={label} size={{ xs: 12, sm: 6, lg: 4 }}>
              <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, display: "grid", gap: 0.5, height: "100%" }}>
                <Typography variant="subtitle1" sx={{ fontFamily: "var(--fb-display)", textTransform: "uppercase", fontWeight: 600 }}>{label}</Typography>
                {s.short > 0 && <Typography variant="body2" color="error">Only {s.legs.length} of {n} legs available: {s.short} short.</Typography>}
                <Num>Joint {pct(s.jointP)} · covers {new Set(s.legs.map((l) => l.game_id)).size} of {open.length} open games</Num>
                <Typography variant="caption" color="text.secondary">{s.jointNote}</Typography>
                <Typography variant="body2">{s.legs.map((l) => `${l.full_name || l.player} (${l.team}, ${pct(l.p)})`).join(" · ") || "—"}</Typography>
              </Box>
            </Grid>
          );
        })}
      </Grid>
    </Section>
  );
}

/* ===================== Touchdowns ===================== */
export function TouchdownsView({ f, setF }) {
  const S = useStore(); const [play, setPlay] = useState(null); const [csvText, setCsvText] = useState(null);
  const teams = [...new Set(S.tds.map((t) => t.team))].sort();
  const weeks = [...new Set(S.tds.map((t) => t.week))].sort((a, b) => a - b);
  const q = (s) => String(s || "").toLowerCase();
  const rows = S.tds.filter((t) => {
    const a = effAttr(t);
    return (f.week === "all" || t.week === +f.week) && (!f.off || t.team === f.off) && (!f.def || t.opp === f.def) && (!f.type || t.type === f.type)
      && (!f.status || a.status === f.status) && (!f.scorer || q(t.scorer).includes(q(f.scorer)))
      && (!f.defender || (a.defenders || []).concat(a.candidates || []).some((d) => q(d.name).includes(q(f.defender))));
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const sel = (k, label, opts) => (
    <TextField select size="small" label={label} value={f[k]} onChange={set(k)} slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}>
      {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </TextField>
  );
  return (
    <Stack spacing={2}>
      <Coverage />
      <WeekGlance f={f} setF={setF} />
      <Leaderboard />
      <Defenders rows={rows} open={setPlay} />
      <Section title={`Play log · ${rows.length} touchdowns`} action={<Button variant="outlined" onClick={async () => setCsvText(await exportCsv(rows))}>Export CSV</Button>}>
        <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
          {sel("week", "Week", [["all", "All weeks"], ...weeks.map((w) => [String(w), "Week " + w])])}
          {sel("off", "Offense", [["", "All"], ...teams.map((t) => [t, t])])}
          {sel("def", "Defense", [["", "All"], ...teams.map((t) => [t, t])])}
          {sel("type", "Type", [["", "All"], ...Object.entries(TYPE)])}
          {sel("status", "Review status", [["", "All"], ...Object.entries(STATUS)])}
          <TextField size="small" label="Scorer" value={f.scorer} onChange={set("scorer")} />
          <TextField size="small" label="Defender" value={f.defender} onChange={set("defender")} />
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead><TableRow>{["Wk", "Game", "Time", "Scorer", "Type", "Yds", "Defender", "Status"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
            <TableBody>
              {rows.slice(0, 400).map((t) => {
                const a = effAttr(t);
                return (
                  <TableRow key={t.key} hover sx={{ cursor: "pointer" }} tabIndex={0} onClick={() => setPlay(t)} onKeyDown={(e) => e.key === "Enter" && setPlay(t)}>
                    <TableCell><Num>{t.week}</Num></TableCell><TableCell>{t.team} vs {t.opp}</TableCell>
                    <TableCell><Num>Q{t.qtr} {t.clock}</Num></TableCell><TableCell>{t.scorer || "—"}</TableCell>
                    <TableCell>{TYPE[t.type]}</TableCell><TableCell><Num>{t.yards ?? "—"}</Num></TableCell>
                    <TableCell>{(a.defenders || []).map((d) => d.name).join(", ") || "—"}</TableCell><TableCell><StatusChip s={a.status} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        {rows.length > 400 && <Typography variant="body2" color="text.secondary">Showing the first 400 of {rows.length}. Narrow the filters or export the CSV for all rows.</Typography>}
      </Section>
      {play && <PlayDialog t={play} onClose={() => setPlay(null)} />}
      <Dialog open={!!csvText} onClose={() => setCsvText(null)} fullWidth maxWidth="md">
        <DialogTitle>Export CSV</DialogTitle>
        <DialogContent><Typography variant="body2" sx={{ mb: 1 }}>Downloads aren't available here. Copy the rows below.</Typography>
          <TextField multiline minRows={8} fullWidth value={csvText || ""} slotProps={{ input: { readOnly: true, sx: { fontFamily: "var(--fb-mono)", fontSize: 12 } } }} /></DialogContent>
        <DialogActions>
          <Button onClick={() => navigator.clipboard.writeText(csvText).then(() => toast("Copied.")).catch(() => toast("Select the text and copy it."))}>Copy</Button>
          <Button onClick={() => setCsvText(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
function Coverage() {
  const S = useStore(); const keys = ["verified_individual", "probable_individual", "shared", "team_unit", "unknown"];
  return (
    <Section title="Season coverage">
      <Typography variant="body2" color="text.secondary">Reconciled = each team's touchdowns, kicks, conversions and safeties add up to the official final score. Attribution uses charting sources only; not connected: {S.meta.not_connected.join("; ")}.</Typography>
      <TableContainer>
        <Table size="small">
          <TableHead><TableRow>{["Wk", "Final", "Reconciled", "TDs", "Verified", "Probable", "Shared", "Team/unit", "Unknown"].map((h) => <TableCell key={h} align="right">{h}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {S.weekly.filter((w) => w.final > 0).map((w) => {
              const t = S.tds.filter((x) => x.week === w.week).map(effAttr);
              const c = (s) => t.filter((a) => a.status === s).length;
              return (
                <TableRow key={w.week}>
                  {[w.week, `${w.final}/${w.games}`, `${w.reconciled}/${w.final}`, w.td_plays, ...keys.map((s) => `${c(s)} (${w.td_plays ? Math.round(c(s) / w.td_plays * 100) : 0}%)`)]
                    .map((v, i) => <TableCell key={i} align="right"><Num>{v}</Num></TableCell>)}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Section>
  );
}
function WeekGlance({ f, setF }) {
  const S = useStore(); const w = f.week === "all" ? S.meta.latest_final_week : +f.week;
  const tds = S.tds.filter((t) => t.week === w); const games = S.games.filter((g) => g.week === w);
  const by = {}; tds.forEach((t) => { if (t.scorer_id) (by[t.scorer_id] ||= { n: 0, name: t.scorer, team: t.team }).n++; });
  const repeat = Object.values(by).filter((x) => x.n > 1).sort((a, b) => b.n - a.n);
  const tiles = [["Games final", `${games.filter((g) => g.status === "final").length}/${games.length}`], ["Touchdowns", tds.length], ["Repeat scorers", repeat.length],
    ...["probable_individual", "unknown"].map((s) => [STATUS[s], tds.filter((t) => effAttr(t).status === s).length])];
  return (
    <Section title={`Week ${w} at a glance`}>
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
        {tiles.map(([k, v]) => <Box key={k} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1 }}>
          <Typography sx={{ fontFamily: "var(--fb-display)", fontSize: 28, fontWeight: 700, lineHeight: 1 }}>{v}</Typography>
          <Typography variant="caption" color="text.secondary">{k}</Typography></Box>)}
      </Box>
      {repeat.length > 0 && <Typography variant="body2"><b>Multiple TDs:</b> {repeat.map((r) => `${r.name} (${r.team}) ${r.n}`).join(" · ")}</Typography>}
      <TableContainer>
        <Table size="small">
          <TableHead><TableRow>{["Game", "Score", "Official check", "Scorers"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {games.map((g) => {
              const gt = tds.filter((t) => t.game_id === g.game_id); const rc = S.recon[g.game_id];
              return (
                <TableRow key={g.game_id} hover onClick={() => setF({ week: String(w), off: "", def: "", type: "", status: "", scorer: "", defender: "" })} sx={{ cursor: gt.length ? "pointer" : "default" }}>
                  <TableCell>{g.away} at {g.home}</TableCell>
                  <TableCell><Num>{g.status === "final" ? `${g.away_score}-${g.home_score}` : g.status.replace(/_/g, " ")}</Num></TableCell>
                  <TableCell>{rc ? <Chip size="small" variant="outlined" color={rc.reconciled ? "success" : "error"} label={rc.reconciled ? "Matches official" : "Mismatch"} /> : "—"}</TableCell>
                  <TableCell>{gt.map((t) => `${t.scorer} (${t.team})`).join(", ") || "—"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Section>
  );
}
function Leaderboard() {
  const S = useStore(); const d = S.defenders; const [sort, setSort] = useState("td"); const [team, setTeam] = useState("");
  if (!d) return null;
  const rated = d.rows.filter((r) => r.td_per100 != null && (!team || r.team === team));
  const key = { td: (r) => -r.td || r.targets, rate: (r) => -r.td_per100, cmp: (r) => -r.cmp_pct, ypt: (r) => -r.yds_per_tgt }[sort];
  const rows = rated.slice().sort((a, b) => key(a) - key(b)).slice(0, 25);
  const teams = [...new Set(d.rows.map((r) => r.team))].sort();
  return (
    <Section title="Defender leaderboard · receiving TDs allowed">
      <Typography variant="body2" color="text.secondary">Season totals from {d.source}, through week {d.through_week}. Each defender is credited by the charter, not by assignment data. Rates appear only with {d.min_targets}+ targets; at that size one touchdown moves the per-100 rate by up to 4 points.</Typography>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        <TextField select size="small" label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)} sx={{ minWidth: 200 }}>
          <MenuItem value="td">TDs allowed</MenuItem><MenuItem value="rate">TDs per 100 targets</MenuItem><MenuItem value="cmp">Completion % allowed</MenuItem><MenuItem value="ypt">Yards per target</MenuItem>
        </TextField>
        <TextField select size="small" label="Team" value={team} onChange={(e) => setTeam(e.target.value)} sx={{ minWidth: 120 }}>
          <MenuItem value="">All</MenuItem>{teams.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
        </TextField>
      </Stack>
      <TableContainer><Table size="small">
        <TableHead><TableRow>{["Defender", "Team", "Games", "Targets", "TDs", "TD/100 tgt", "Cmp %", "Yds/tgt", "INT"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
        <TableBody>{rows.map((r) => <TableRow key={r.pfr_id}><TableCell>{r.name}</TableCell><TableCell>{r.team}</TableCell>
          {[r.games, r.targets, r.td, r.td_per100, r.cmp_pct, r.yds_per_tgt, r.ints].map((x, i) => <TableCell key={i}><Num>{x}</Num></TableCell>)}</TableRow>)}</TableBody>
      </Table></TableContainer>
    </Section>
  );
}
function Defenders({ rows, open }) {
  const agg = {};
  for (const t of rows) {
    const a = effAttr(t);
    for (const d of a.defenders || []) {
      const x = (agg[d.gsis_id || d.pfr_id || d.name] ||= { name: d.name, team: d.team, pos: d.position, verified: [], probable: [], shared: [] });
      (a.status === "verified_individual" ? x.verified : a.status === "shared" ? x.shared : x.probable).push(t);
    }
  }
  const list = Object.values(agg).sort((a, b) => (b.verified.length + b.probable.length) - (a.verified.length + a.probable.length)).slice(0, 25);
  return (
    <Section title="Defender involvement">
      <Typography variant="body2" color="text.secondary">Counts only touchdowns where a charting source points to an individual. Totals depend on how many of a defender's games PFR has charted. No target or snap rates are shown because play-level coverage snaps are not available from a permitted source.</Typography>
      {list.length ? (
        <TableContainer>
          <Table size="small">
            <TableHead><TableRow>{["Defender", "Team", "Verified", "Probable", "Shared", "Plays"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
            <TableBody>
              {list.map((x) => (
                <TableRow key={x.name + x.team}>
                  <TableCell>{x.name}</TableCell><TableCell>{x.team} {x.pos}</TableCell>
                  <TableCell><Num>{x.verified.length}</Num></TableCell><TableCell><Num>{x.probable.length}</Num></TableCell><TableCell><Num>{x.shared.length}</Num></TableCell>
                  <TableCell>{[...x.verified, ...x.probable, ...x.shared].slice(0, 6).map((t, i) => <span key={t.key}>{i ? " · " : ""}<Link component="button" type="button" onClick={() => open(t)}>W{t.week} {t.scorer}</Link></span>)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : <Empty>No attributed defenders in the current filter.</Empty>}
    </Section>
  );
}
export function PlayDialog({ t, onClose }) {
  const S = useStore(); const a = effAttr(t); const g = S.gameById[t.game_id];
  const kv = [["Game", `${g.away} at ${g.home}, Week ${t.week}`], ["Time", `Q${t.qtr} ${t.clock || ""}`], ["Scoring team", `${t.team} (${t.unit.replace("_", " ")})`], ["Opponent", t.opp],
    ["Scorer", `${t.scorer || "—"} ${t.scorer_pos ? "(" + t.scorer_pos + ")" : ""}`], ["Passer", t.passer || "—"], ["Yards", t.yards ?? "—"], ["Play ID", `${t.game_id} / ${t.play_id}`],
    ["Official check", t.reconciled ? "Game's touchdowns match the official final score" : "Not reconciled"], ["Source", t.source], ["Film or charting", t.film_ref || "None reviewed"], ["Last verified", t.verified_at]];
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" scroll="paper">
      <DialogTitle>{t.scorer || "Team"} · {TYPE[t.type]} TD</DialogTitle>
      <DialogContent dividers sx={{ display: "grid", gap: 1.5 }}>
        <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "max-content minmax(0,1fr)", gap: "4px 12px", m: 0 }}>
          {kv.map(([k, v]) => [<Typography key={k} component="dt" variant="body2" color="text.secondary">{k}</Typography>,
            <Typography key={k + "v"} component="dd" variant="body2" sx={{ m: 0, overflowWrap: "anywhere" }}>{String(v)}</Typography>])}
        </Box>
        <Typography variant="body2" sx={{ fontFamily: "var(--fb-mono)", color: "text.secondary" }}>{t.desc}</Typography>
        <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}><Typography variant="h6" component="h3">Defensive responsibility</Typography><StatusChip s={a.status} /></Stack>
        {a.reviewed && <Typography variant="body2" color="text.secondary">Reviewed by an admin on {new Date(a.reviewed.updated_at).toLocaleDateString()}. {a.reviewed.note}</Typography>}
        {(a.defenders || []).map((d, i) => (
          <Box key={i} sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, display: "grid", gap: 0.5 }}>
            <Typography sx={{ fontWeight: 600 }}>{d.name} · {d.team} {d.position || ""} · {String(d.role || "").replace(/_/g, " ")}</Typography>
            <Typography variant="body2"><b>Observed:</b> {d.observed || "—"}</Typography>
            <Typography variant="body2"><b>Inferred:</b> {d.inferred || "—"}</Typography>
            {(d.evidence || []).map((e, j) => <Typography key={j} variant="caption" color="text.secondary">Evidence: {e.source}{e.detail ? " · " + e.detail : ""}</Typography>)}
          </Box>
        ))}
        {(a.candidates || []).length > 0 && (
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5 }}>
            <Typography sx={{ fontWeight: 600 }}>Charted candidates (not attributed)</Typography>
            {a.candidates.map((c) => <Typography key={c.pfr_id || c.name} variant="body2">{c.name} ({c.position || "?"}): {c.td_allowed_in_game} receiving TD allowed in this game, {c.targets_in_game ?? "?"} targets</Typography>)}
          </Box>
        )}
        <Typography variant="body2"><b>What's missing:</b> {a.missing || "—"}</Typography>
        {S.isAdmin && <ReviewForm t={t} a={a} onDone={onClose} />}
        {a.reviewed && (a.reviewed.history || []).length > 0 && (
          <Box component="details"><summary>Change history</summary>
            {a.reviewed.history.map((x, i) => <Typography key={i} variant="caption" display="block" color="text.secondary">{x.at}: {STATUS[x.status] || x.status} · {x.note || ""}</Typography>)}
          </Box>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
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
    <Box sx={{ border: 1, borderColor: "primary.main", borderRadius: 1, p: 1.5, display: "grid", gap: 1 }}>
      <Typography variant="h6" component="h3">Admin review</Typography>
      <Box sx={{ display: "grid", gap: 1, gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
        <TextField select size="small" label="Status" value={v.status} onChange={set("status")}>{Object.entries(STATUS).map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}</TextField>
        <TextField select size="small" label="Role" value={v.role} onChange={set("role")}>{ROLES.map((r) => <MenuItem key={r} value={r}>{r.replace(/_/g, " ")}</MenuItem>)}</TextField>
        <TextField size="small" label="Defender(s), comma separated" value={v.names} onChange={set("names")} />
      </Box>
      <TextField size="small" multiline minRows={2} label="Observed: what the film or chart shows" value={v.obs} onChange={set("obs")} />
      <TextField size="small" multiline minRows={2} label="Inferred: the assignment you conclude, and why" value={v.inf} onChange={set("inf")} />
      <TextField size="small" label="Evidence: source, play, film timestamp" value={v.ev} onChange={set("ev")} />
      <TextField size="small" label="What is still missing or disputed" value={v.miss} onChange={set("miss")} />
      <Box><Button variant="contained" onClick={save}>Save review</Button></Box>
    </Box>
  );
}

/* ===================== My Picks & Family Board ===================== */
export function PicksView() {
  const S = useStore();
  if (!S.uid) return <Stack spacing={2}><DbNote /><Empty>Sign in to Claude to make picks.</Empty></Stack>;
  const items = Object.values(myItems()).sort((a, b) => b.week - a.week || a.game_id.localeCompare(b.game_id));
  return (
    <Stack spacing={2}>
      <DbNote />
      <Section title="My picks">
        <Typography variant="body2" color="text.secondary">Save players from This Week, then submit. Each game locks at kickoff (Eastern Time). These are research picks; nothing here places a bet.</Typography>
        {!items.length ? <Empty>No picks yet. Open This Week and tap Pick on a player.</Empty> : items.map((p) => {
          const r = settlePick(S.uid, p); const locked = FB.isLocked(S.gameById[p.game_id], Date.now());
          return (
            <Stack key={p.key} direction="row" sx={{ gap: 1, py: 1, borderTop: 1, borderColor: "divider", flexWrap: "wrap", alignItems: "center" }}>
              <Box sx={{ flex: 1, minWidth: 180 }}>
                <Typography sx={{ fontWeight: 600 }}>{p.player} <Typography component="span" variant="caption" color="text.secondary">{p.team} · Week {p.week}</Typography></Typography>
                <Typography variant="body2"><Num>{p.price ? `${p.price.book} ${am(p.price.american)}` : "No price saved"}</Num>{p.price_warning ? ` · ${p.price_warning}` : ""}</Typography>
              </Box>
              <Result r={r} />
              {locked ? <Typography variant="caption" color="text.secondary">Locked</Typography> : (
                <Stack direction="row" sx={{ gap: 1 }}>
                  {p.status === "draft" ? <Button size="small" variant="contained" onClick={() => setPickStatus(p.key, "submitted")}>Submit</Button>
                    : <Button size="small" variant="outlined" onClick={() => setPickStatus(p.key, "draft")}>Unsubmit</Button>}
                  <Button size="small" onClick={() => setPickStatus(p.key, "remove")}>Remove</Button>
                </Stack>
              )}
            </Stack>
          );
        })}
      </Section>
    </Stack>
  );
}
export function BoardView() {
  const S = useStore();
  const weeks = [...new Set(Object.values(S.allPicks).flatMap((d) => Object.values(d.items || {}).map((p) => p.week)))].sort((a, b) => b - a);
  const totals = {}; const byWeek = {};
  for (const w of weeks) for (const [uid, d] of Object.entries(S.allPicks)) for (const p of Object.values(d.items || {}).filter((p) => p.week === w && p.status === "submitted")) {
    const r = settlePick(uid, p); (totals[uid] ||= { win: 0, loss: 0, void: 0, pending: 0, needs_review: 0 })[r.state]++;
    (byWeek[w] ||= []).push({ uid, p, r });
  }
  return (
    <Stack spacing={2}>
      <DbNote />
      <Section title="Season standings">
        {Object.keys(totals).length ? (
          <TableContainer><Table size="small">
            <TableHead><TableRow>{["Member", "Wins", "Losses", "Void", "Pending", "Review"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
            <TableBody>{Object.entries(totals).map(([uid, t]) => <TableRow key={uid}><TableCell>{nameOf(uid)}</TableCell>
              {["win", "loss", "void", "pending", "needs_review"].map((k) => <TableCell key={k}><Num>{t[k]}</Num></TableCell>)}</TableRow>)}</TableBody>
          </Table></TableContainer>
        ) : <Empty>Standings start with the first submitted pick.</Empty>}
      </Section>
      <Section title="Family Board">
        {!weeks.length && <Empty>No submitted picks yet. Picks appear here once members submit them.</Empty>}
        {weeks.filter((w) => byWeek[w]).map((w) => (
          <Box key={w}>
            <Typography variant="h6" component="h3">Week {w}</Typography>
            <TableContainer><Table size="small">
              <TableHead><TableRow>{["Member", "Player", "Game", "Price", "Result"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
              <TableBody>{byWeek[w].map(({ uid, p, r }) => { const g = S.gameById[p.game_id]; return (
                <TableRow key={uid + p.key}><TableCell>{nameOf(uid)}</TableCell><TableCell>{p.player} ({p.team})</TableCell>
                  <TableCell>{g ? `${g.away} at ${g.home}` : p.game_id}</TableCell><TableCell><Num>{p.price ? `${p.price.book} ${am(p.price.american)}` : "research"}</Num></TableCell>
                  <TableCell><Result r={r} /></TableCell></TableRow>); })}</TableBody>
            </Table></TableContainer>
          </Box>
        ))}
      </Section>
    </Stack>
  );
}

/* ===================== Admin ===================== */
export function AdminView() {
  const S = useStore(); const [csv, setCsv] = useState(""); const [book, setBook] = useState(""); const [play, setPlay] = useState(null);
  if (!S.isAdmin) return <Empty>Admins only.</Empty>;
  const week = S.slate.week; const d = S.odds["w" + week]; const now = Date.now();
  const started = S.slate.games.filter((g) => FB.isLocked(g, now));
  const queue = S.tds.filter((t) => t.unit === "offense" && effAttr(t).status !== "verified_individual").slice(-30).reverse();
  const v = S.validation;
  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 7 }}>
          <Section title={`Odds import · Week ${week}`}>
            <Typography variant="body2" color="text.secondary">Anytime TD prices only. Paste CSV or read a sportsbook screenshot. Rows stay pending until you approve them.</Typography>
            <TextField multiline minRows={4} label="CSV rows" placeholder={"player,team,book,american,captured_at\nTrey McBride,ARI,FanDuel,+180,2026-11-15T10:05:00-05:00"} value={csv} onChange={(e) => setCsv(e.target.value)} slotProps={{ input: { sx: { fontFamily: "var(--fb-mono)", fontSize: 12 } } }} />
            <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
              <Button variant="contained" onClick={() => stageOdds(parseOddsCsv(csv), "csv")}>Stage CSV rows</Button>
              {S.sample ? <>
                <TextField size="small" label="Book for screenshot" value={book} onChange={(e) => setBook(e.target.value)} sx={{ width: 170 }} />
                <Button component="label" variant="outlined">Read screenshot<input hidden type="file" accept="image/*" onChange={(e) => readShot(e.target.files[0], book)} /></Button>
              </> : <Typography variant="caption" color="text.secondary">Screenshot reading isn't available in this view.</Typography>}
            </Stack>
            {d && <>
              <Stack direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                <Chip size="small" color={d.status === "live" ? "success" : "warning"} label={d.status} />
                <Typography variant="caption" color="text.secondary">{(d.rows || []).length} rows · {d.source} · imported {d.imported_at}</Typography>
                {d.status !== "live" ? <Button size="small" variant="contained" onClick={() => setOddsStatus("live")}>Approve and publish</Button>
                  : <Button size="small" variant="outlined" onClick={() => setOddsStatus("pending")}>Withdraw</Button>}
              </Stack>
              <TableContainer><Table size="small">
                <TableHead><TableRow>{["Player", "Team", "Book", "Price", "Captured", "Match"].map((h) => <TableCell key={h}>{h}</TableCell>)}</TableRow></TableHead>
                <TableBody>{(d.rows || []).map((r, i) => <TableRow key={i}><TableCell>{r.player}</TableCell><TableCell>{r.team}</TableCell><TableCell>{r.book}</TableCell>
                  <TableCell><Num>{am(r.american)}</Num></TableCell><TableCell>{r.captured_at}</TableCell>
                  <TableCell>{r.gsis_id ? "matched" : <Box component="span" sx={{ color: "error.main" }}>unmatched</Box>}</TableCell></TableRow>)}</TableBody>
              </Table></TableContainer>
            </>}
          </Section>
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          <Section title="Kickoff snapshots">
            <Typography variant="body2" color="text.secondary">Settlement only counts submitted picks found in a game's kickoff snapshot. The scheduled refresh takes them; you can take one here after kickoff.</Typography>
            {S.slate.games.map((g) => <Stack key={g.game_id} direction="row" sx={{ gap: 1, alignItems: "center" }}><Num>{g.away} at {g.home}</Num>
              {S.locks[g.game_id] ? <Chip size="small" color="success" variant="outlined" label={"frozen " + S.locks[g.game_id].frozen_at} />
                : FB.isLocked(g, now) ? <Chip size="small" color="secondary" variant="outlined" label="needs snapshot" /> : <Chip size="small" variant="outlined" label="open" />}</Stack>)}
            <Box><Button variant="contained" disabled={!started.length} onClick={() => freeze(started)}>Snapshot started games now</Button></Box>
          </Section>
        </Grid>
      </Grid>
      <Section title="Attribution review queue">
        <Typography variant="body2" color="text.secondary">Most recent offensive touchdowns without a verified individual. Every edit keeps the prior version in its history.</Typography>
        {queue.map((t) => <Stack key={t.key} direction="row" sx={{ gap: 1, alignItems: "center", flexWrap: "wrap" }}>
          <Button size="small" variant="outlined" onClick={() => setPlay(t)}>Review</Button>
          <Typography variant="body2">W{t.week} {t.scorer} ({t.team} vs {t.opp}) · {TYPE[t.type]}</Typography><StatusChip s={effAttr(t).status} /></Stack>)}
      </Section>
      <Section title="Data sources">
        {S.meta.sources.map((s) => <Typography key={s.name} variant="body2"><b>{s.name}</b>: {s.fields}{s.through_week ? ` (through week ${s.through_week})` : ""}</Typography>)}
        <Typography variant="body2" color="text.secondary">Not connected: {S.meta.not_connected.join("; ")}.</Typography>
        <Typography variant="body2" color="text.secondary">Model check (walk-forward weeks {v.weeks.join("–")}, {v.n} player-games): Brier {v.brier.toFixed(3)} vs {v.brier_constant.toFixed(3)} constant; log loss {v.log_loss.toFixed(3)} vs {v.log_loss_constant.toFixed(3)}.</Typography>
      </Section>
      {play && <PlayDialog t={play} onClose={() => setPlay(null)} />}
    </Stack>
  );
}
