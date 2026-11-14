import { useEffect } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from "@mui/material";
import { useStore, ensureAnalysis } from "./store.js";
import { Icon, P } from "./icons.jsx";

/* Analysis tab: the point-in-time study of 2025/2026 Weeks 1-9 and the Week 10 forecast (docs/ANALYSIS_W1_10.md).
   Read-only research; nothing here writes to the database. */

const SUMMARY_LINE = {
  "Summary: the strongest signals and how much to trust them": "Start here: what helped, what didn't, and how sure we are",
  "1. Which data signals would have improved picks": "Spread, totals and player signals, tested week by week",
  "2. Prime-time games versus the rest of the schedule": "Thursday, Sunday and Monday nights vs everything else",
  "3. Implied scores from the spread and total versus final scores": "How close the betting line's scores came",
  "4. Player-level hit rates: each team's highest-chance anytime-TD pick": "Top pick per team, by week, team, position and slot",
  "5. Week 10 (2026) forecast: the same signals before kickoff": "This week's games and each team's top TD chance",
};

/* **bold**, *italic*, `code` -> elements; everything else is plain text (no HTML is ever injected). */
function Rich({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).filter(Boolean);
  return parts.map((t, i) => {
    if (t.startsWith("**") && t.endsWith("**")) return <b key={i}>{t.slice(2, -2)}</b>;
    if (t.startsWith("`") && t.endsWith("`")) return <Box key={i} component="code" sx={{ fontSize: "0.9em", bgcolor: "action.hover", px: 0.5, borderRadius: 0.5, wordBreak: "break-word" }}>{t.slice(1, -1)}</Box>;
    if (t.length > 2 && t.startsWith("*") && t.endsWith("*")) return <i key={i}>{t.slice(1, -1)}</i>;
    return <span key={i}>{t}</span>;
  });
}

function DataTable({ head, rows, label }) {
  return (
    <Box role="region" aria-label={label} tabIndex={0}
      sx={{ overflowX: "auto", border: 1, borderColor: "divider", borderRadius: 2, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" } }}>
      <Table size="small" sx={{ minWidth: head.length > 4 ? head.length * 96 : "auto", "& td, & th": { px: 1, py: 0.75, fontSize: 13, verticalAlign: "top" } }}>
        <TableHead>
          <TableRow>{head.map((h, i) => (
            <TableCell key={i} scope="col" sx={{ fontWeight: 700, whiteSpace: "nowrap", ...(i === 0 ? { position: "sticky", left: 0, bgcolor: "background.paper", zIndex: 1 } : {}) }}><Rich text={h} /></TableCell>
          ))}</TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r, j) => (
            <TableRow key={j}>{r.map((c, i) => (i === 0
              ? <TableCell key={i} component="th" scope="row" sx={{ position: "sticky", left: 0, bgcolor: "background.paper", zIndex: 1, fontWeight: 600, minWidth: 96 }}><Rich text={c} /></TableCell>
              : <TableCell key={i} sx={{ minWidth: c.length > 40 ? 220 : undefined }}><Rich text={c} /></TableCell>))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function Blocks({ blocks, section }) {
  let heading = section;
  return blocks.map((b, i) => {
    if (b.type === "h") { heading = b.text; return <Typography key={i} variant="subtitle1" component="h4" sx={{ fontWeight: 700, mt: 1 }}><Rich text={b.text} /></Typography>; }
    if (b.type === "p") return <Typography key={i} variant="body2"><Rich text={b.text} /></Typography>;
    if (b.type === "list") return <Box key={i} component="ul" sx={{ m: 0, pl: 2.5, display: "grid", gap: 0.5 }}>{b.items.map((t, k) => <Typography key={k} component="li" variant="body2"><Rich text={t} /></Typography>)}</Box>;
    if (b.type === "table") return <DataTable key={i} head={b.head} rows={b.rows} label={`${heading} (table, scrolls sideways)`} />;
    return null;
  });
}

function Section({ s, open }) {
  return (
    <Accordion disableGutters defaultExpanded={open} variant="outlined" slotProps={{ transition: { unmountOnExit: true } }} sx={{ borderRadius: 2, "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<Icon d={P.expand} />} sx={{ minHeight: 56 }}>
        <Box>
          <Typography variant="h6" component="h3">{s.title.replace(/^Summary: /, "Summary: ")}</Typography>
          {SUMMARY_LINE[s.title] && <Typography variant="body2" color="text.secondary">{SUMMARY_LINE[s.title]}</Typography>}
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ display: "grid", gap: 1.25, minWidth: 0 }}><Blocks blocks={s.blocks} section={s.title} /></AccordionDetails>
    </Accordion>
  );
}

export function AnalysisView() {
  const S = useStore();
  useEffect(() => { ensureAnalysis(); }, []);
  if (S.analysis === undefined) return <LinearProgress aria-label="Loading the analysis" />;
  if (!S.analysis) return <Alert severity="warning">The analysis couldn't be loaded. Try again after the next refresh.</Alert>;
  const A = S.analysis;
  const summary = A.sections.filter((s) => s.title.startsWith("Summary"));
  const rest = A.sections.filter((s) => !s.title.startsWith("Summary"));
  return (
    <Stack spacing={1.5}>
      <Typography variant="h5" component="h2">Analysis</Typography>
      <Typography variant="body2" color="text.secondary">
        Weeks 1–9 of 2025 and 2026 replayed as if they hadn't been played yet: every signal uses only what was known before that game's kickoff,
        and results are used only to grade. Research, not betting advice.
      </Typography>
      <Alert severity="info" sx={{ borderRadius: 2 }}>
        Every rate shows its count. ⚠ marks fewer than 15 games or picks: treat it as preliminary. Against the spread or a total, 52.4% is break-even at
        standard −110 prices. Wide tables scroll sideways.
      </Alert>
      {summary.map((s) => <Section key={s.title} s={s} open />)}
      {rest.map((s) => <Section key={s.title} s={s} />)}
      {A.intro.length > 0 && (
        <Box sx={{ display: "grid", gap: 1, color: "text.secondary" }}>
          <Typography variant="subtitle2" component="h3">About this study</Typography>
          <Blocks blocks={A.intro} section="About this study" />
        </Box>
      )}
    </Stack>
  );
}
