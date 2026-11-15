/* Results dashboard: submitted picks vs verified outcomes. All numbers come from FB.dashboard (artifact/lib.js, tested). */
import { useMemo, useState } from "react";
import { Alert, Box, Button, Card, CardContent, Chip, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, ToggleButton, ToggleButtonGroup, Typography, useTheme } from "@mui/material";
import { FB, useStore, nameOf, resultRows, toast } from "./store.js";

const pct1 = (x) => (x == null || isNaN(x) ? "—" : (x * 100).toFixed(1) + "%");
const OUT = { hit: "Hit", miss: "Miss", void: "Void", pending: "Pending", review: "Needs review" };
const CAT = { member: "Member", position: "Position", team: "Team", market: "Market", probability: "Saved probability", above_fair: "Above fair at pick" };
const MKT = { anytime_td: "Anytime TD" };
const wkLabel = (w, multiSeason) => (multiSeason ? `${w.season} W${w.week}` : `W${w.week}`);

function Section({ title, children, note }) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }} component="section" aria-label={title}>
      <CardContent sx={{ p: 1.5, "&:last-child": { pb: 1.5 }, display: "grid", gap: 1 }}>
        <Typography variant="h6" component="h3">{title}</Typography>
        {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
        {children}
      </CardContent>
    </Card>
  );
}
function Stat({ label, value, sub }) {
  return (
    <Box sx={{ border: 1, borderColor: "divider", borderRadius: 2, p: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" component="div">{label}</Typography>
      <Typography sx={{ fontWeight: 700, fontSize: 20, fontVariantNumeric: "tabular-nums" }}>{value}</Typography>
      {sub && <Typography variant="caption" color="text.secondary" component="div">{sub}</Typography>}
    </Box>
  );
}
function SimpleTable({ head, rows, caption }) {
  return (
    <TableContainer sx={{ maxWidth: "100%", overflowX: "auto" }}>
      <Table size="small" aria-label={caption}>
        <TableHead><TableRow>{head.map((h) => <TableCell key={h} sx={{ fontWeight: 700, whiteSpace: "nowrap" }}>{h}</TableCell>)}</TableRow></TableHead>
        <TableBody>{rows.map((r, i) => <TableRow key={i}>{r.map((c, j) => <TableCell key={j} sx={{ fontVariantNumeric: "tabular-nums", whiteSpace: j ? "nowrap" : "normal" }}>{c}</TableCell>)}</TableRow>)}</TableBody>
      </Table>
    </TableContainer>
  );
}

/* Bar chart of rates on a fixed 0-100% axis. value null = no settled picks (drawn as a gap, never as 0%). */
function RateBars({ items, label }) {
  const th = useTheme(); const W = 320, H = 150, L = 30, B = 34, n = Math.max(items.length, 1), bw = (W - L) / n;
  const y = (v) => 8 + (H - 8 - B) * (1 - v);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ maxWidth: 640, display: "block" }}>
      {[0, 0.5, 1].map((t) => <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke={th.palette.divider} /><text x={L - 4} y={y(t) + 3} fontSize="9" textAnchor="end" fill={th.palette.text.secondary}>{t * 100}%</text></g>)}
      {items.map((it, i) => {
        const x = L + i * bw + bw * 0.15, w = bw * 0.7;
        return (
          <g key={i}>
            {it.value == null
              ? <text x={x + w / 2} y={y(0) - 4} fontSize="9" textAnchor="middle" fill={th.palette.text.secondary}>—</text>
              : <rect x={x} y={y(it.value)} width={w} height={y(0) - y(it.value)} fill={th.palette.primary.main} opacity={it.flag ? 0.45 : 0.9}
                  stroke={it.flag ? th.palette.text.primary : "none"} strokeDasharray={it.flag ? "3 2" : undefined} />}
            <text x={x + w / 2} y={H - B + 12} fontSize="9" textAnchor="middle" fill={th.palette.text.primary}>{it.label}</text>
            <text x={x + w / 2} y={H - B + 24} fontSize="8" textAnchor="middle" fill={th.palette.text.secondary}>n={it.n}{it.flag ? "*" : ""}</text>
          </g>
        );
      })}
    </svg>
  );
}
function RateLine({ points, label }) {
  const th = useTheme(); const W = 320, H = 130, L = 30, B = 20;
  const x = (i) => L + (points.length > 1 ? (i * (W - L - 10)) / (points.length - 1) : (W - L) / 2);
  const y = (v) => 8 + (H - 8 - B) * (1 - v);
  const d = points.map((p, i) => (p.value == null ? null : `${x(i)},${y(p.value)}`)).filter(Boolean).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ maxWidth: 640, display: "block" }}>
      {[0, 0.5, 1].map((t) => <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke={th.palette.divider} /><text x={L - 4} y={y(t) + 3} fontSize="9" textAnchor="end" fill={th.palette.text.secondary}>{t * 100}%</text></g>)}
      <polyline points={d} fill="none" stroke={th.palette.primary.main} strokeWidth="2" />
      {points.map((p, i) => p.value != null && <circle key={i} cx={x(i)} cy={y(p.value)} r="3" fill={th.palette.primary.main} />)}
      {points.map((p, i) => <text key={"t" + i} x={x(i)} y={H - 6} fontSize="9" textAnchor="middle" fill={th.palette.text.secondary}>{p.label}</text>)}
    </svg>
  );
}
function CalibrationPlot({ bins }) {
  const th = useTheme(); const S = 200, P = 26;
  const sc = (v) => P + v * (S - 2 * P);
  return (
    <svg viewBox={`0 0 ${S} ${S}`} width="100%" role="img" aria-label="Calibration: average saved probability (across) against observed hit rate (up), by probability band" style={{ maxWidth: 320, display: "block" }}>
      <rect x={P} y={P} width={S - 2 * P} height={S - 2 * P} fill="none" stroke={th.palette.divider} />
      <line x1={sc(0)} y1={S - sc(0)} x2={sc(1)} y2={S - sc(1)} stroke={th.palette.text.secondary} strokeDasharray="4 3" />
      {[0, 0.5, 1].map((t) => <g key={t}><text x={sc(t)} y={S - 8} fontSize="8" textAnchor="middle" fill={th.palette.text.secondary}>{t * 100}%</text><text x={8} y={S - sc(t) + 3} fontSize="8" fill={th.palette.text.secondary}>{t * 100}%</text></g>)}
      {bins.map((b) => <g key={b.band}><circle cx={sc(b.avgP)} cy={S - sc(b.observed)} r={3 + Math.min(6, Math.sqrt(b.n))} fill={th.palette.primary.main} opacity="0.75" />
        <text x={sc(b.avgP) + 6} y={S - sc(b.observed) - 6} fontSize="8" fill={th.palette.text.primary}>n={b.n}</text></g>)}
    </svg>
  );
}

export function ResultsDashboard() {
  const S = useStore();
  const { rows: all, drafts } = useMemo(() => resultRows(), [S.allPicks, S.tds, S.played, S.locks, S.extrasLoaded, S.gameById]);
  const seasons = [...new Set(all.map((r) => r.season))].sort();
  const [f, setF] = useState({ season: "", weekFrom: "", weekTo: "", uid: "", pos: "", team: "", market: "" });
  const [unit, setUnit] = useState("selection"); const [dim, setDim] = useState("member");
  const [outFilter, setOutFilter] = useState(""); const [sort, setSort] = useState("week");
  const num = (v) => (v === "" ? null : +v);
  const filters = { season: num(f.season), weekFrom: num(f.weekFrom), weekTo: num(f.weekTo), uid: f.uid || null, pos: f.pos || null, team: f.team || null, market: f.market || null };
  const d = useMemo(() => FB.dashboard(all, { filters, unit }), [all, JSON.stringify(filters), unit]);
  const multiSeason = new Set(d.weeks.map((w) => w.season)).size > 1;
  const opts = (k) => [...new Set(all.map((r) => r[k]).filter(Boolean))].sort();
  const weeksAll = [...new Set(all.map((r) => r.week))].sort((a, b) => a - b);
  const sel = (key, label, values, fmt = (v) => v) => (
    <TextField select size="small" label={label} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} sx={{ minWidth: 112, flex: "1 1 112px" }}>
      <MenuItem value="">All</MenuItem>{values.map((v) => <MenuItem key={v} value={String(v)}>{fmt(v)}</MenuItem>)}
    </TextField>
  );
  const s = d.summary; const unitWord = unit === "unique" ? "player-games" : "selections";
  const latest = d.weeks.length ? d.weeks[d.weeks.length - 1] : null;

  // week series with gaps for missing weeks inside each season
  const series = [];
  d.weeks.forEach((w, i) => {
    const prev = d.weeks[i - 1];
    if (prev && prev.season === w.season) for (let k = prev.week + 1; k < w.week; k++) series.push({ label: wkLabel({ season: w.season, week: k }, multiSeason), value: null, n: 0, gap: true });
    series.push({ label: wkLabel(w, multiSeason), value: w.hitRate, n: w.settled, flag: !w.complete || w.small, w });
  });
  const shown = d.rows.filter((r) => !outFilter || r.outcome === outFilter).slice().sort((a, b) => sort === "p" ? (b.p ?? -1) - (a.p ?? -1)
    : sort === "player" ? String(a.player).localeCompare(String(b.player)) : (b.season - a.season) || (b.week - a.week) || String(a.player).localeCompare(String(b.player)));
  async function exportPicks() {
    const cols = [["season", (r) => r.season], ["week", (r) => r.week], ["game_id", (r) => r.game_id], ["member", (r) => (unit === "unique" ? r.uid : nameOf(r.uid))],
      ["player", (r) => r.player], ["gsis_id", (r) => r.gsis_id], ["team", (r) => r.team], ["pos", (r) => r.pos], ["market", (r) => r.market], ["predicted", () => "scores 1+ TD"],
      ["saved_probability", (r) => (r.p == null ? "" : r.p)], ["qualifying_tds", (r) => (r.tds == null ? "" : r.tds)], ["result", (r) => OUT[r.outcome]], ["reason", (r) => r.why || ""]]
      .map(([label, get]) => ({ label, get }));
    const text = FB.csv(d.rows, cols);
    if (S.downloads) { try { await S.downloads.save({ filename: "pick-results.csv", data: new Blob([text], { type: "text/csv" }) }); return; } catch (e) { toast("Download was declined."); return; } }
    try { await navigator.clipboard.writeText(text); toast("CSV copied to the clipboard."); } catch (e) { toast("Couldn't export the CSV here."); }
  }

  if (!all.length) {
    return (
      <Stack spacing={1.5}>
        <Alert severity="info" sx={{ borderRadius: 2 }}>
          <b>No submitted picks yet.</b> The results dashboard fills in as picks are made and games are graded.{drafts ? ` ${drafts} draft pick${drafts > 1 ? "s are" : " is"} saved but not submitted, so not counted.` : ""} Model backtest results are on the TDs tab ("How this works"), kept separate from family picks.
        </Alert>
      </Stack>
    );
  }
  return (
    <Stack spacing={1.5}>
      {/* 1. scope, filters, freshness */}
      <Section title="Scope" note={`Submitted family picks only (drafts, parlays and the model backtest are not included). Outcomes from the reconciled touchdown log, refreshed ${S.meta ? FB.fmtEt(Date.parse(S.meta.refreshed_at), { month: "short", day: "numeric" }) + " ET" : "—"}${latest ? `; latest week in this view: ${wkLabel(latest, multiSeason)}` : ""}.`}>
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
          {seasons.length > 1 && sel("season", "Season", seasons)}
          {sel("weekFrom", "From week", weeksAll)}{sel("weekTo", "To week", weeksAll)}
          {sel("uid", "Member", opts("uid"), (u) => nameOf(u))}{sel("pos", "Position", opts("pos"))}{sel("team", "Team", opts("team"))}{sel("market", "Market", opts("market"), (m) => MKT[m] || m)}
        </Stack>
        <ToggleButtonGroup exclusive size="small" value={unit} onChange={(e, v) => v && setUnit(v)} aria-label="Counting unit" sx={{ "& .MuiToggleButton-root": { minHeight: 44, textTransform: "none" } }}>
          <ToggleButton value="selection">Each member's pick</ToggleButton><ToggleButton value="unique">Each player-game once</ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary">Counting {unitWord}. {unit === "unique" ? "If several members picked the same player in the same game, it counts once." : "If several members picked the same player in the same game, each pick counts."} Every number below uses these filters.</Typography>
      </Section>

      {/* 2. summary */}
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 1 }}>
        <Stat label={`Recorded ${unitWord}`} value={s.n} sub={drafts ? `${drafts} drafts not counted` : null} />
        <Stat label="Settled (hit or miss)" value={s.settled} sub="the hit-rate denominator" />
        <Stat label="Hits" value={s.hits} />
        <Stat label="Misses" value={s.misses} />
        <Stat label="Hit rate" value={pct1(s.hitRate)} sub={s.settled ? `${s.hits} of ${s.settled}` : "no settled picks"} />
        <Stat label="Miss rate" value={pct1(s.missRate)} sub={s.settled ? `${s.misses} of ${s.settled}` : "no settled picks"} />
        <Stat label="Pending" value={s.pending} sub="game not final" />
        <Stat label="Void" value={s.void} sub="player didn't play" />
        <Stat label="Needs review" value={s.review} sub="not counted until resolved" />
        {s.duplicates > 0 && <Stat label="Duplicate records skipped" value={s.duplicates} sub="same member, game, player, market" />}
      </Box>
      {s.settled > 0 && s.small && <Alert severity="info" sx={{ borderRadius: 2 }}>Only {s.settled} settled {unitWord}: too few to read much into the rate.</Alert>}

      {/* 3. weekly + cumulative */}
      <Section title="Week by week" note={`Bars: hit rate on a fixed 0–100% scale; n = settled ${unitWord}. Faded, dashed bars marked * are incomplete weeks (games pending) or small samples (under ${d.smallN}). "—" means no settled picks that week: a gap, not 0%.`}>
        <RateBars items={series} label={`Weekly hit rate. ${series.filter((x) => !x.gap).map((x) => `${x.label}: ${x.value == null ? "no settled picks" : pct1(x.value)} of ${x.n}`).join("; ")}`} />
        <SimpleTable caption="Weekly results" head={["Week", "Hits", "Misses", "Settled", "Hit rate", "Pending", "Void", "Review", "Status"]}
          rows={d.weeks.map((w) => [wkLabel(w, multiSeason), w.hits, w.misses, w.settled, pct1(w.hitRate), w.pending, w.void, w.review, w.complete ? (w.small ? "small sample" : "complete") : "incomplete"])} />
      </Section>
      <Section title="Cumulative" note="Running totals: cumulative hit rate = all hits so far ÷ all settled picks so far (not an average of weekly rates).">
        <RateLine points={d.cumulative.map((c) => ({ label: wkLabel(c, multiSeason), value: c.hitRate }))} label={`Cumulative hit rate. ${d.cumulative.map((c) => `${wkLabel(c, multiSeason)}: ${c.hits} of ${c.settled}, ${pct1(c.hitRate)}`).join("; ")}`} />
        <SimpleTable caption="Cumulative results" head={["Through", "Hits", "Misses", "Settled", "Hit rate", "TDs (selections)"]}
          rows={d.cumulative.map((c) => [wkLabel(c, multiSeason), c.hits, c.misses, c.settled, pct1(c.hitRate), c.tds ?? "—"])} />
      </Section>

      {/* 4. categories and touchdowns */}
      <Section title="By category" note={`Observed rates only; categories under ${d.smallN} settled picks are marked small, and a higher rate is not proof of a strength. Picks in the same game or shared across members move together, so these are not independent samples.`}>
        <ToggleButtonGroup exclusive size="small" value={dim} onChange={(e, v) => v && setDim(v)} aria-label="Category" sx={{ flexWrap: "wrap", "& .MuiToggleButton-root": { minHeight: 44, textTransform: "none" } }}>
          {Object.entries(CAT).map(([k, l]) => <ToggleButton key={k} value={k}>{l}</ToggleButton>)}
        </ToggleButtonGroup>
        <SimpleTable caption={`Results by ${CAT[dim]}`} head={[CAT[dim], "Hits", "Misses", "Settled", "Hit rate", ""]}
          rows={d.categories[dim].map((c) => [dim === "member" && unit === "selection" ? nameOf(c.key) : dim === "market" ? (MKT[c.key] || c.key) : c.key, c.hits, c.misses, c.settled, pct1(c.hitRate), c.settled === 0 ? "none settled" : c.small ? "small sample" : ""])} />
        {dim === "probability" && <Typography variant="caption" color="text.secondary">Bands use the model chance saved when each pick was made, not today's model. "Not recorded" = no saved chance.</Typography>}
      </Section>
      <Section title="Touchdowns scored by picked players" note="An anytime pick predicts at least one TD, not exactly one; a 2-TD game is still one hit. Counts cover settled hits and misses with a known TD total.">
        {d.touchdowns.selections ? <>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 1 }}>
            <Stat label="TDs across selections" value={d.touchdowns.perSelectionTotal} sub={`${d.touchdowns.selections} selections; shared picks repeat`} />
            <Stat label="TDs, unique player-games" value={d.touchdowns.uniqueTotal} sub={`${d.touchdowns.uniquePlayerGames} player-games`} />
            <Stat label="Average per selection" value={d.touchdowns.avgPerSelection.toFixed(2)} />
          </Box>
          <SimpleTable caption="Touchdowns per selection" head={["TDs in the game", "0", "1", "2", "3+"]} rows={[["Selections", d.touchdowns.dist["0"], d.touchdowns.dist["1"], d.touchdowns.dist["2"], d.touchdowns.dist["3+"]]]} />
          {d.touchdowns.unknown > 0 && <Typography variant="caption" color="text.secondary">{d.touchdowns.unknown} settled picks have no TD count yet (touchdown log still loading).</Typography>}
        </> : <Typography variant="body2" color="text.secondary">No settled picks with a known touchdown count in this view.</Typography>}
      </Section>

      {/* 5. calibration */}
      <Section title="Saved probability vs outcome">
        {d.calibration ? <>
          <Typography variant="body2">Using the model chance <b>saved when each pick was made</b> ({d.calibration.n} settled picks{d.calibration.missing ? `; ${d.calibration.missing} without a saved chance left out` : ""}).</Typography>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 1 }}>
            <Stat label="Expected hits" value={d.calibration.expected.toFixed(1)} sub="sum of saved chances" />
            <Stat label="Observed hits" value={d.calibration.observed} />
            <Stat label="Observed − expected" value={(d.calibration.diff >= 0 ? "+" : "") + d.calibration.diff.toFixed(1)} />
            <Stat label="Brier score" value={d.calibration.brier.toFixed(3)} sub="0 is perfect; lower is better" />
          </Box>
          <CalibrationPlot bins={d.calibration.bins} />
          <SimpleTable caption="Calibration by probability band" head={["Band", "Picks", "Avg saved chance", "Observed hit rate"]} rows={d.calibration.bins.map((b) => [b.band, b.n, pct1(b.avgP), pct1(b.observed)])} />
          <Typography variant="caption" color="text.secondary">The dashed line is perfect calibration. Expected hits estimates how many picks should score at least once; it is not a touchdown total. Small bands swing a lot.</Typography>
        </> : <Typography variant="body2" color="text.secondary">Not available: none of the settled picks in this view has a model chance saved at pick time. New picks save it automatically.</Typography>}
      </Section>

      {/* 6. extremes */}
      <Section title="Best and worst weeks" note={`By weekly hit rate; ties are all listed. * = incomplete week or fewer than ${d.smallN} settled picks.`}>
        {d.extremes.best.length ? [["Best", d.extremes.best], ["Worst", d.extremes.worst]].map(([lbl, ws]) => (
          <Box key={lbl}>
            <Typography variant="body2"><b>{lbl}:</b> {ws.map((w) => `${wkLabel(w, multiSeason)} ${pct1(w.hitRate)} (${w.hits} of ${w.settled})${!w.complete || w.small ? "*" : ""}`).join(", ")}</Typography>
            {ws.slice(0, 2).map((w) => <Typography key={w.season * 100 + w.week} variant="caption" color="text.secondary" component="div">
              {wkLabel(w, multiSeason)}: {d.rows.filter((r) => r.season === w.season && r.week === w.week && (r.outcome === "hit" || r.outcome === "miss")).map((r) => `${r.player} ${OUT[r.outcome].toLowerCase()}`).join(", ")}</Typography>)}
          </Box>)) : <Typography variant="body2" color="text.secondary">No settled weeks yet.</Typography>}
        <Typography variant="body2">
          {d.weekRuns.weeksCompared ? <>Weeks above the model's expected hits, longest run: <b>{d.weekRuns.longestAbove}</b>; below: <b>{d.weekRuns.longestBelow}</b> ({d.weekRuns.weeksCompared} weeks compared; weeks with a pick lacking a saved chance are skipped and break a run).</>
            : "Week runs need saved chances for every settled pick in a week; none qualify yet."}
        </Typography>
        <Typography variant="caption" color="text.secondary">Pick-by-pick streaks aren't shown: many picks share a kickoff time, so there's no honest order within a slate.</Typography>
      </Section>

      {/* 7. auditable table */}
      <Section title="Every pick" note="The records behind every number above, with the same filters.">
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <TextField select size="small" label="Result" value={outFilter} onChange={(e) => setOutFilter(e.target.value)} sx={{ minWidth: 130 }}>
            <MenuItem value="">All</MenuItem>{Object.entries(OUT).map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="week">Newest week first</MenuItem><MenuItem value="player">Player</MenuItem><MenuItem value="p">Saved chance</MenuItem>
          </TextField>
          <Button onClick={exportPicks} sx={{ minHeight: 44 }}>Export CSV</Button>
        </Stack>
        <SimpleTable caption="Pick-level results" head={["Week", unit === "unique" ? "Members" : "Member", "Player", "Market", "Pick", "Saved chance", "TDs", "Result", "Reason"]}
          rows={shown.map((r) => [wkLabel(r, multiSeason), unit === "unique" ? r.uid : nameOf(r.uid), `${r.player} (${r.pos || "?"} ${r.team || ""})`, MKT[r.market] || r.market, "1+ TD",
            r.p == null ? "not saved" : pct1(r.p), r.tds == null ? "—" : r.tds,
            <Chip key="c" size="small" variant="outlined" color={r.outcome === "hit" ? "success" : r.outcome === "miss" ? "error" : "default"} label={OUT[r.outcome]} />,
            r.outcome === "hit" || r.outcome === "miss" ? "" : r.why || ""])} />
      </Section>
    </Stack>
  );
}
