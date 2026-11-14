import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppBar, Box, BottomNavigation, BottomNavigationAction, Button, ButtonBase, Container, CssBaseline, IconButton, Paper, Snackbar, Stack, ThemeProvider, Toolbar, Typography, createTheme, Alert } from "@mui/material";
import { FB, useStore, loadData, connect, setToast, myItems } from "./store.js";
import { Icon, P } from "./icons.jsx";
import { WeekView, TouchdownsView, BoardView, AdminView, ParlaysView, LinesView, DefenseView } from "./views.jsx";

const TABS = [["week", "Week", P.week], ["parlays", "Parlays", P.parlays], ["uploads", "Uploads", P.upload], ["defense", "Defense", P.defense], ["touchdowns", "TDs", P.tds], ["board", "Board", P.board]];
const ROUTES = ["week", "parlays", "uploads", "lines", "defense", "touchdowns", "board", "picks", "admin"];

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
      MuiButton: { styleOverrides: { root: { minHeight: 40, textTransform: "none", fontSize: 15, borderRadius: 10 }, sizeLarge: { minHeight: 48 } } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiBottomNavigationAction: { styleOverrides: { root: { minWidth: 0, padding: "6px 2px" }, label: { fontSize: 12, "&.Mui-selected": { fontSize: 12, fontWeight: 700 } } } },
    },
  });
}

const hashTab = () => { const t = (location.hash || "#week").slice(1); return ROUTES.includes(t) ? t : "week"; };

function SlateBar() {
  const S = useStore();
  if (!S.slate) return null;
  const mine = S.uid ? Object.values(myItems()).filter((p) => p.week === S.slate.week && p.status === "submitted") : [];
  const legs = S.draft.length;
  if (!mine.length && !legs) return null;
  const bar = { justifyContent: "space-between", px: 2, py: 1.25, borderRadius: 3, boxShadow: 3, minHeight: 48 };
  return (
    <Stack direction="row" sx={{ gap: 1 }}>
      {mine.length > 0 && <ButtonBase onClick={() => { location.hash = "picks"; }} sx={{ ...bar, flex: 1, minWidth: 0, bgcolor: "primary.main", color: "primary.contrastText" }}>
        <Typography sx={{ fontWeight: 700 }} noWrap>{legs ? "" : `My week ${S.slate.week} slate · `}{mine.length} pick{mine.length > 1 ? "s" : ""}</Typography>
        {!legs && <Typography variant="body2" noWrap sx={{ opacity: 0.9, ml: 1, maxWidth: "55%" }}>{mine.map((p) => p.player.split(" ").slice(-1)[0]).join(", ")}</Typography>}
      </ButtonBase>}
      {legs > 0 && <ButtonBase onClick={() => { location.hash = "parlays"; }} sx={{ ...bar, flex: 1, minWidth: 0, bgcolor: "secondary.main", color: "secondary.contrastText" }}>
        <Typography sx={{ fontWeight: 700 }} noWrap>Parlay · {legs} leg{legs > 1 ? "s" : ""}</Typography>
        {!mine.length && <Typography variant="body2" sx={{ opacity: 0.9, ml: 1 }}>Build ›</Typography>}
      </ButtonBase>}
    </Stack>
  );
}

function App() {
  const S = useStore(); const mode = useMode(); const theme = useMemo(() => makeTheme(mode), [mode]);
  const [tab, setTab] = useState(hashTab); const [msg, setMsg] = useState(null);
  useEffect(() => {
    setToast((text, action) => setMsg(text ? { text, action, k: Date.now() } : null));
    loadData().then(connect);
    const on = () => { setTab(hashTab()); setMsg(null); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on);
  }, []);
  const tabs = TABS; const navValue = tab === "lines" ? "uploads" : tab === "picks" ? "board" : tab === "admin" ? false : tab;
  const fresh = S.meta && `Updated ${FB.fmtEt(Date.parse(S.meta.refreshed_at), { month: "short", day: "numeric" })} ET${(Date.now() - Date.parse(S.meta.refreshed_at)) / 3600e3 > 36 ? " · may be out of date" : ""}`;
  const View = { week: WeekView, parlays: ParlaysView, uploads: LinesView, lines: LinesView, defense: DefenseView, touchdowns: TouchdownsView, board: BoardView, picks: () => <BoardView mine />, admin: AdminView }[tab];
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ minHeight: 52, px: "max(16px, env(safe-area-inset-left, 0px))", gap: 1 }}>
          <Typography component="h1" sx={{ fontFamily: '"Barlow Condensed", sans-serif', fontWeight: 700, fontSize: 22, textTransform: "uppercase", letterSpacing: "0.02em", flex: 1 }} noWrap>Anytime TD Family Board</Typography>
          <Typography variant="caption" sx={{ opacity: 0.85, display: { xs: "none", sm: "block" } }}>{fresh}</Typography>
          {S.isAdmin && <Button color="inherit" startIcon={<Icon d={P.admin} />} onClick={() => { location.hash = "admin"; }} sx={{ minHeight: 44 }}>Admin</Button>}
        </Toolbar>
      </AppBar>
      <Container maxWidth="md" sx={{ pt: 2, pb: "calc(150px + env(safe-area-inset-bottom, 0px))", px: "max(16px, env(safe-area-inset-left, 0px))" }}>
        {S.loadError ? <Alert severity="error">The season data didn't load. Reload the page; if it keeps failing, the last refresh may be incomplete.</Alert>
          : !S.meta ? <Box sx={{ p: 2, color: "text.secondary" }}>Loading the 2026 season…</Box>
          : <View />}
        {S.meta && <Typography variant="caption" color="text.secondary" sx={{ display: { xs: "block", sm: "none" }, mt: 3, textAlign: "center" }}>{fresh}</Typography>}
      </Container>
      <Box sx={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 1100 }}>
        {tab === "week" && <Box sx={{ px: "max(12px, env(safe-area-inset-left, 0px))", pb: 1, maxWidth: 900, mx: "auto" }}><SlateBar /></Box>}
        <Paper elevation={8} square sx={{ pb: "env(safe-area-inset-bottom, 0px)" }}>
          <BottomNavigation showLabels value={navValue} onChange={(e, v) => { location.hash = v; }} sx={{ height: 60, maxWidth: 900, mx: "auto" }}>
            {tabs.map(([k, l, d]) => <BottomNavigationAction key={k} value={k} label={l} icon={<Icon d={d} />} />)}
          </BottomNavigation>
        </Paper>
      </Box>
      <Snackbar key={msg && msg.k} open={!!msg} autoHideDuration={msg && msg.action ? 6000 : 3500} onClose={(e, r) => { if (r !== "clickaway") setMsg(null); }}
        message={msg ? msg.text : ""} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ bottom: "calc(140px + env(safe-area-inset-bottom, 0px)) !important" }}
        action={msg && msg.action ? <Button color="warning" size="small" onClick={() => { msg.action.run(); setMsg(null); }}>{msg.action.label}</Button> : null} />
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
