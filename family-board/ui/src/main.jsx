import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppBar, Box, Container, CssBaseline, Snackbar, Stack, Tab, Tabs, ThemeProvider, Toolbar, Typography, createTheme, Alert } from "@mui/material";
import { FB, useStore, loadData, connect, setToast, nameOf } from "./store.js";
import { WeekView, TouchdownsView, PicksView, BoardView, AdminView } from "./views.jsx";

const TABS = [["week", "This Week"], ["touchdowns", "Touchdowns"], ["picks", "My Picks"], ["board", "Family Board"], ["admin", "Admin"]];

/* Follows the viewer's theme: an explicit data-theme on <html>, otherwise the OS setting. */
function useMode() {
  const read = () => {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const [mode, setMode] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setMode(read());
    mq.addEventListener("change", on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { mq.removeEventListener("change", on); mo.disconnect(); };
  }, []);
  return mode;
}

function makeTheme(mode) {
  const dark = mode === "dark";
  return createTheme({
    palette: {
      mode,
      primary: { main: dark ? "#3a9d68" : "#1d6b43", contrastText: dark ? "#06110b" : "#ffffff" },
      secondary: { main: dark ? "#c88ee6" : "#8d3fb0" },
      warning: { main: dark ? "#e3a83a" : "#b9790b" },
      background: { default: dark ? "#101512" : "#f3f4ef", paper: dark ? "#171e1a" : "#ffffff" },
      text: { primary: dark ? "#e7ece6" : "#18211b", secondary: dark ? "#9aa79f" : "#5d6a61" },
      divider: dark ? "#2b352f" : "#d9ddd3",
    },
    shape: { borderRadius: 6 },
    typography: {
      fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
      h5: { fontFamily: '"Barlow Condensed", "Arial Narrow", sans-serif', fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" },
      h6: { fontFamily: '"Barlow Condensed", "Arial Narrow", sans-serif', fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" },
      button: { fontWeight: 600 },
    },
    components: {
      MuiTableCell: { styleOverrides: { head: { fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" } } },
      MuiTab: { styleOverrides: { root: { fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 600, fontSize: 16, letterSpacing: "0.04em" } } },
      MuiCard: { defaultProps: { variant: "outlined" } },
    },
  });
}

const blank = { week: "all", off: "", def: "", scorer: "", defender: "", type: "", status: "" };
const hashTab = () => { const t = (location.hash || "#week").slice(1); return TABS.some(([k]) => k === t) ? t : "week"; };

function App() {
  const S = useStore(); const mode = useMode(); const theme = useMemo(() => makeTheme(mode), [mode]);
  const [tab, setTab] = useState(hashTab); const [f, setF] = useState(blank); const [msg, setMsg] = useState(null);
  useEffect(() => { setToast(setMsg); loadData().then(connect); const on = () => setTab(hashTab()); window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on); }, []);
  const tabs = TABS.filter(([k]) => k !== "admin" || S.isAdmin);
  const fresh = S.meta && `2026 season · final games through Week ${S.meta.latest_final_week} · refreshed ${FB.fmtEt(Date.parse(S.meta.refreshed_at), { month: "short", day: "numeric" })} ET${(Date.now() - Date.parse(S.meta.refreshed_at)) / 3600e3 > 36 ? " · stale" : ""}`;
  const me = S.uid && S.names[S.uid] && S.names[S.uid].name;
  const View = { week: WeekView, touchdowns: TouchdownsView, picks: PicksView, board: BoardView, admin: AdminView }[tab];
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="sticky" elevation={0} sx={{ top: "env(safe-area-inset-top, 0px)" }}>
        <Toolbar sx={{ flexDirection: "column", alignItems: "stretch", gap: 0.5, pt: 1, px: "max(16px, env(safe-area-inset-left, 0px))" }}>
          <Stack direction="row" sx={{ flexWrap: "wrap", alignItems: "baseline", columnGap: 1.5 }}>
            <Typography component="h1" sx={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 26, textTransform: "uppercase", letterSpacing: "0.02em" }}>Anytime TD Family Board</Typography>
            <Typography variant="caption" sx={{ opacity: 0.9 }}>{fresh || "Loading data…"}{me ? ` · signed in as ${me}` : ""}</Typography>
          </Stack>
          <Tabs value={tab} onChange={(e, v) => { location.hash = v; }} variant="scrollable" scrollButtons="auto" textColor="inherit"
            slotProps={{ indicator: { sx: { bgcolor: "warning.main", height: 3 } } }} aria-label="Sections">
            {tabs.map(([k, l]) => <Tab key={k} value={k} label={l} />)}
          </Tabs>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 2, pb: 6, px: "max(16px, env(safe-area-inset-left, 0px))" }}>
        {S.loadError ? <Alert severity="error">The season data didn't load. Reload the page; if it keeps failing, the last refresh may be incomplete.</Alert>
          : !S.meta ? <Box sx={{ p: 2, color: "text.secondary" }}>Loading the 2026 season…</Box>
          : <View f={f} setF={setF} />}
      </Container>
      <Snackbar open={!!msg} autoHideDuration={3500} onClose={() => setMsg(null)} message={msg || ""} anchorOrigin={{ vertical: "bottom", horizontal: "center" }} />
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
