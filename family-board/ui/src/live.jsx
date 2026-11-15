import { useEffect, useState } from "react";
import { Alert, Box, Card, CardContent, Chip, Stack, Typography } from "@mui/material";
import { useStore, liveStatus } from "./store.js";

/* Live touchdowns on the TDs tab: provisional, from the shared "live" collection the backend poller writes. Updates
   arrive through the database listener, so every viewer sees them without tapping Refresh results or reloading.
   A game leaves this panel once the postgame check has verified it (then it is in the regular list below). */
const etTime = (ms, sec) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) }) + " ET";
const KIND = { rushing: "rush", receiving: "rec", return: "return" };

export function LivePanel() {
  const S = useStore(); const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(t); }, []);
  const st = liveStatus();
  const verified = (gid) => { const r = S.recon[gid]; return r && r.reconciled && r.scorers_verified === true && S.tds.some((t) => t.game_id === gid); };
  const games = Object.values(S.live.games).filter((g) => !verified(g.game_id))
    .sort((a, b) => String(S.gameById[a.game_id] && S.gameById[a.game_id].kickoff_et).localeCompare(String(S.gameById[b.game_id] && S.gameById[b.game_id].kickoff_et)) || a.game_id.localeCompare(b.game_id));
  if (!games.length && !st.playing) return null;
  if (!games.length && !st.last) return null;            // live feed not running: the Postgame results panel explains the wait
  return (
    <Box component="section" aria-labelledby="live-h" sx={{ display: "grid", gap: 1 }}>
      <Stack direction="row" sx={{ alignItems: "baseline", gap: 1, flexWrap: "wrap" }}>
        <Typography id="live-h" variant="h6" component="h3" sx={{ flex: 1 }}>Live touchdowns</Typography>
        <Typography variant="body2" color="text.secondary" data-testid="live-check">
          {st.last ? <>Last live check: <b>{etTime(st.last, true)}</b></> : "Waiting for the first live check"}
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Provisional, from the live feed. Picks and parlay legs stay pending until the postgame check matches the final score and each player's touchdowns.
      </Typography>
      {st.delayed && (
        <Alert severity="warning" sx={{ borderRadius: 2 }} data-testid="live-delayed">
          Live feed delayed{st.last ? ` since ${etTime(st.last)}` : ""}{st.error ? ` (${st.error})` : ""}. Showing the last known touchdowns.
        </Alert>
      )}
      <Box aria-live="polite" sx={{ display: "grid", gap: 1 }}>
        {games.map((g) => <LiveGame key={g.game_id} g={g} />)}
      </Box>
    </Box>
  );
}

function LiveGame({ g }) {
  const S = useStore(); const sched = S.gameById[g.game_id];
  const final = g.status === "final" || (sched && sched.status === "final");
  const n = (e) => (e.gsis_id ? g.counts[e.gsis_id] : g.counts[`name:${e.scorer}`]) || 0;
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }} data-game={g.game_id}>
      <CardContent sx={{ display: "grid", gap: 0.75, "&:last-child": { pb: 1.5 } }}>
        <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 700, flex: 1 }}>{g.away} {g.away_score ?? "–"} · {g.home} {g.home_score ?? "–"}</Typography>
          <Chip size="small" color={final ? "default" : "error"} variant={final ? "outlined" : "filled"}
            label={final ? "Final · waiting for the postgame check" : "Live"} />
        </Stack>
        <Typography variant="caption" color="text.secondary">Score as of {etTime(Date.parse(g.checked_at))}{g.period ? ` (Q${g.period}${g.clock ? ` ${g.clock}` : ""})` : ""}</Typography>
        {(g.events || []).length === 0 && <Typography variant="body2" color="text.secondary">No touchdowns yet.</Typography>}
        {(g.events || []).map((e) => {
          const over = e.state === "overturned"; const fix = [...(e.history || [])].reverse().find((h) => h.change === "scorer");
          return (
            <Box key={e.key} data-key={e.key} data-state={e.state} sx={{ display: "grid", gap: 0.25, borderTop: 1, borderColor: "divider", pt: 0.75 }}>
              <Stack direction="row" sx={{ alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
                <Typography variant="body2" sx={{ fontWeight: 600, textDecoration: over ? "line-through" : "none", color: over ? "text.secondary" : "text.primary" }}>
                  {e.scorer || "Scorer not listed yet"} · {e.team} · {KIND[e.kind] || "TD"} TD
                </Typography>
                <Typography variant="caption" color="text.secondary">Q{e.qtr} {e.clock}</Typography>
                {over ? <Chip size="small" label="Overturned" /> : <Chip size="small" variant="outlined" label="Provisional" />}
                {!over && n(e) >= 2 && <Chip size="small" color="primary" label={`${n(e)} TDs this game`} />}
              </Stack>
              {fix && <Typography variant="caption">Corrected: credited to {fix.to} (was {fix.from}).</Typography>}
              {over && <Typography variant="caption" color="text.secondary">The source removed this touchdown; it no longer counts.</Typography>}
            </Box>
          );
        })}
      </CardContent>
    </Card>
  );
}
