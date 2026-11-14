"""Point-in-time analysis of 2025 and 2026 Weeks 1-9 plus the Week 10 2026 forecast -> docs/ANALYSIS_W1_10.md

Inputs: .data/cache/season_games.parquet (research/season_games.py) and .data/cache/season_players.parquet
(research/season_players.py). Every signal is computed from information available before that game's kickoff; outcomes are
used only to grade. Run: python3 research/season_games.py && python3 research/season_players.py && python3 research/season_analysis.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
C = ROOT / ".data" / "cache"
PRELIM = 15
BREAK_EVEN = 0.5238  # win rate needed to profit at -110 on both sides


# ----------------------------------------------------------------------------- stats helpers
def binom_p(k, n):
    """Two-sided exact binomial test against 50%."""
    if n == 0:
        return float("nan")
    tail = sum(math.comb(n, i) for i in range(0, min(k, n - k) + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def wilson(k, n, z=1.645):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def corr_p(x, y):
    m = x.notna() & y.notna(); x, y = x[m], y[m]; n = len(x)
    if n < 4 or x.std() == 0:
        return float("nan"), n, float("nan")
    r = float(np.corrcoef(x, y)[0, 1]); z = abs(r) * math.sqrt(n - 2) / math.sqrt(max(1e-12, 1 - r * r))
    return r, n, math.erfc(z / math.sqrt(2))


def pct(k, n):
    return "–" if n == 0 else f"{k / n:.1%}"


def flag(n):
    return " ⚠" if n < PRELIM else ""


def rate(k, n, ci=True):
    if n == 0:
        return "– (n=0)"
    lo, hi = wilson(k, n)
    return f"{k / n:.1%} ({k}/{n}{', 90% CI ' + f'{lo:.0%}–{hi:.0%}' if ci else ''}){flag(n)}"


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return out


# ----------------------------------------------------------------------------- pick grading
def ats_record(df, side):
    """side: +1 pick home, -1 pick away (0/NaN = no pick). Returns wins, losses, pushes."""
    m = df.played & side.notna() & (side != 0)
    v = df.ats_home[m] * np.sign(side[m])
    return int((v > 0).sum()), int((v < 0).sum()), int((v == 0).sum())


def ou_record(df, side):
    m = df.played & side.notna() & (side != 0)
    v = df.ou_diff[m] * np.sign(side[m])
    return int((v > 0).sum()), int((v < 0).sum()), int((v == 0).sum())


def rec_cells(w, l, p):
    n = w + l
    lo, hi = wilson(w, n)
    return [f"{w}-{l}" + (f"-{p}" if p else ""), (f"{w / n:.1%}" if n else "–") + flag(n),
            f"{lo:.0%}–{hi:.0%}" if n else "–", f"{binom_p(w, n):.2f}" if n else "–"]


def leadback_by_slot():
    """Each team's lead back (most carries in earlier weeks of the same season), TD hit rate by prime time vs not.
    2025 Weeks 2-18 and 2026 Weeks 2-9; picks whose player had no carry, catch or TD in the game are void."""
    g = pd.read_csv(C / "games.csv"); res = {}
    for s, maxw in ((2025, 18), (2026, 9)):
        p = pd.read_parquet(C / f"play_by_play_{s}.parquet", columns=["game_id", "week", "posteam", "play_type", "rusher_player_id", "receiver_player_id",
                                                                     "touchdown", "two_point_attempt", "td_player_id", "season_type"])
        p = p[p.season_type == "REG"]
        car = p[p.play_type == "run"].groupby(["week", "posteam", "rusher_player_id"]).size().rename("n").reset_index()
        td = p[(p.touchdown == 1) & (p.two_point_attempt != 1)].groupby(["game_id", "td_player_id"]).size()
        played = set(zip(p.game_id, p.rusher_player_id)) | set(zip(p.game_id, p.receiver_player_id)) | set(zip(p.game_id, p.td_player_id))
        gs = g[(g.season == s) & (g.game_type == "REG")]
        rows = []
        for w in range(2, maxw + 1):
            prev = car[car.week < w].groupby(["posteam", "rusher_player_id"]).n.sum().reset_index()
            lead = prev.sort_values("n", ascending=False).groupby("posteam").head(1).set_index("posteam").rusher_player_id
            for r in gs[gs.week == w].itertuples():
                prime = r.weekday in ("Thursday", "Monday") or (r.weekday == "Sunday" and int(str(r.gametime)[:2]) >= 19)
                for t in (r.home_team, r.away_team):
                    pid = lead.get(t)
                    if pid is not None and (r.game_id, pid) in played:
                        rows.append((w, prime, int(td.get((r.game_id, pid), 0) > 0)))
        o = pd.DataFrame(rows, columns=["w", "prime", "hit"])
        for pr in (True, False):
            x = o[o.prime == pr]; res[(s, pr)] = (int(x.hit.sum()), len(x))
            if s == 2025:
                x = o[(o.prime == pr) & (o.w <= 9)]; res[("2025w9", pr)] = (int(x.hit.sum()), len(x))
    return res


def main():
    G = pd.read_parquet(C / "season_games.parquet")
    P = pd.read_parquet(C / "season_players.parquet")
    pbp_td = []
    for s in (2025, 2026):
        p = pd.read_parquet(C / f"play_by_play_{s}.parquet", columns=["game_id", "touchdown", "two_point_attempt", "td_team", "posteam"])
        t = p[(p.touchdown == 1) & (p.two_point_attempt != 1)]
        pbp_td.append(t.groupby("game_id").size().rename("tds"))
    G = G.join(pd.concat(pbp_td), on="game_id"); G["tds"] = G.tds.fillna(0)
    A = G[(G.week <= 9) & G.played].copy()          # the analysis sample: Weeks 1-9 of both seasons
    W10 = G[(G.season == 2026) & (G.week == 10)].copy()
    md = ["# Point-in-time analysis: 2025 and 2026 Weeks 1–9, and the Week 10 forecast", "",
          f"*Generated by `research/season_analysis.py` on {pd.Timestamp.now(tz='America/New_York'):%b %-d, %Y}. "
          "Every game and every player is evaluated as if its week hadn't been played: features use only the closing line, the "
          "schedule, results and play-by-play from **earlier weeks** (plus the previous season at quarter weight), and that "
          "week's pre-game injury report and roster. Outcomes are used only to grade.*", "",
          f"**Samples.** 2026 Weeks 1–9: {int((A.season == 2026).sum())} games. 2025 Weeks 1–9: {int((A.season == 2025).sum())} games "
          "(a second, independent sample used to check whether a 2026 finding repeats). Player-level picks: 2026 only (see §4).", "",
          f"**Reading the numbers.** Every rate shows its count. ⚠ marks a rate resting on fewer than {PRELIM} observations: treat it "
          f"as preliminary. Against the spread or a total, 50% is a coin flip and **{BREAK_EVEN:.1%}** is the break-even rate at "
          "standard −110 prices. The 90% interval (Wilson) and the two-sided p-value test against 50%. About 20 signal/slot "
          "combinations are tested here, so one or two will look 'significant' at p < 0.10 by chance alone.", ""]

    # ========================================================================= 1. SIGNALS
    md += ["## 1. Which data signals would have improved picks", "",
           "Each signal takes a side only when it has a real opinion (threshold in the table); otherwise it passes. "
           "*r* is the correlation between the signal's raw value and the result against the line across every game it covers "
           "(a scale-free check that doesn't depend on the threshold).", ""]
    A["fav_side"] = np.where(A.spread > 0, 1, np.where(A.spread < 0, -1, 0))
    div_dog = np.where(A["div"] == 1, -A.fav_side, 0)
    ats_signals = [
        ("Baseline: always the home team", "all games", pd.Series(1, index=A.index), None),
        ("Baseline: always the favorite", "all non-pick'em games", pd.Series(A.fav_side, index=A.index), None),
        ("Margin rating vs line (points)", "rating differs from line by 3+", np.sign(A.edge_margin).where(A.edge_margin.abs() >= 3), A.edge_margin),
        ("Team efficiency (net EPA per game) vs line", "rating differs from line by 3+", np.sign(A.edge_epa).where(A.edge_epa.abs() >= 3), A.edge_epa),
        ("Rest advantage", "3+ more days of rest", np.sign(A.rest_diff).where(A.rest_diff.abs() >= 3), A.rest_diff),
        ("Travel: back the team that travelled less", "1,500+ km difference", np.sign(A.travel_diff).where(A.travel_diff.abs() >= 1500), A.travel_diff),
        ("West-coast team in an early East game: fade it", "1 pm ET kickoff in the East", pd.Series(np.where(A.body_clock == 1, 1, np.nan), index=A.index), None),
        ("Starting QB out: fade that team", "season's main passer Out/Doubtful/inactive", np.sign(A.qb_out_diff).where(A.qb_out_diff != 0), A.qb_out_diff),
        ("Key skill player(s) out: fade that team", "15%+ carry/target share player out", np.sign(A.key_out_diff).where(A.key_out_diff != 0), A.key_out_diff),
        ("Recent ATS form: back the hotter team", "last-3 cover margin differs by 7+", np.sign(A.ats_form_diff).where(A.ats_form_diff.abs() >= 7), A.ats_form_diff),
        ("Division game: back the underdog", "division games", pd.Series(div_dog, index=A.index).replace(0, np.nan), None),
    ]
    rows = []; ranked = []
    for name, rule, side, raw in ats_signals:
        cells = []
        for s in (2026, 2025):
            sub = A.season == s
            w, l, p = ats_record(A[sub], side[sub]); cells.append(f"{w}-{l}" + (f"-{p}" if p else "") + f" ({pct(w, w + l)}){flag(w + l)}")
        w, l, p = ats_record(A, side)
        r, n, rp = corr_p(raw, A.ats_home) if raw is not None else (float("nan"), 0, float("nan"))
        rows.append([name, rule, *cells, *rec_cells(w, l, p), f"{r:+.2f} (n={n}, p={rp:.2f})" if raw is not None else "–"])
        ranked.append((name, w, l, r, rp, cells))
    md += ["### Against the spread", ""] + table(["Signal", "Takes a side when", "2026 W1–9", "2025 W1–9", "Both seasons", "Hit rate", "90% CI", "p vs 50%", "r with cover margin"], rows) + [""]

    # rest: the one signal whose correlation pointed the same way in both seasons
    rr = {s: corr_p(A[A.season == s].rest_diff, A[A.season == s].ats_home) for s in (2026, 2025)}
    rows = []
    for lab, m in (("Home team 7+ fewer days (opponent off a bye)", A.rest_diff <= -7), ("Home team 1–6 fewer days", (A.rest_diff < 0) & (A.rest_diff > -7)),
                   ("Same rest", A.rest_diff == 0), ("Home team 1–6 more days", (A.rest_diff > 0) & (A.rest_diff < 7)), ("Home team 7+ more days (off a bye)", A.rest_diff >= 7)):
        d = A[m]; k = int((d.ats_home > 0).sum()); n = int((d.ats_home != 0).sum())
        rows.append([lab, len(d), rate(k, n, False), f"{d.ats_home.mean():+.1f}"])
    md += ["### Rest, in more detail", "",
           f"Rest was the only game-level signal whose correlation with covering pointed the same way in both seasons "
           f"(2026 r = {rr[2026][0]:+.2f}, n = {rr[2026][1]}, p = {rr[2026][2]:.3f}; 2025 r = {rr[2025][0]:+.2f}, n = {rr[2025][1]}, p = {rr[2025][2]:.2f}). "
           "But the simple '3+ days' rule went 21-9 in 2026 and only 12-13 in 2025, and the effect is concentrated in a few bye-week games, "
           "so it is **promising but preliminary**, not a proven edge.", ""]
    md += table(["Home team's rest vs opponent", "Games", "Home covered", "Avg home result vs line"], rows) + [""]

    # straight-up winners
    fav_ok = (np.sign(A.spread) == np.sign(A.result)) & (A.spread != 0) & (A.result != 0)
    nfav = int(((A.spread != 0) & (A.result != 0)).sum())
    su = [["Closing-line favorite", rate(int(fav_ok.sum()), nfav)]]
    for name, col in (("Margin rating alone (+1.5 home field)", "edge_margin"), ("Net EPA rating alone (+1.5 home field)", "edge_epa")):
        pred = A[col] + A.spread
        ok = (np.sign(pred) == np.sign(A.result)) & (A.result != 0) & (pred != 0)
        n = int(((A.result != 0) & (pred != 0)).sum()); su.append([name, rate(int(ok.sum()), n)])
        flip = (np.sign(pred) != np.sign(A.spread)) & (A.spread != 0) & (A.result != 0)
        fk = int((flip & (np.sign(pred) == np.sign(A.result))).sum()); fn = int(flip.sum())
        su.append([f"… games where it disagreed with the line's favorite (picks the underdog to win)", rate(fk, fn)])
    md += ["### Straight-up winners", ""] + table(["Method", "Winners picked"], su) + [""]

    # totals
    wind15 = ((A.wind >= 15) & (A.indoor == 0))
    cold = ((A.temp <= 40) & (A.indoor == 0))
    tot_signals = [
        ("Baseline: always the over", "all games", pd.Series(1, index=A.index), None),
        ("Scoring rating vs total", "teams' average game total differs from line by 3+", np.sign(A.edge_pts_total).where(A.edge_pts_total.abs() >= 3), A.edge_pts_total),
        ("Recent over/under form: follow it", "last-3 games went over/under by 5+ on average", np.sign(A.ou_form).where(A.ou_form.abs() >= 5), A.ou_form),
        ("Wind 15+ mph (game-day reading): under", "outdoor games with a wind reading", pd.Series(np.where(wind15, -1, np.nan), index=A.index), None),
        ("Cold, 40°F or below (game-day reading): under", "outdoor games with a temperature reading", pd.Series(np.where(cold, -1, np.nan), index=A.index), None),
        ("Indoors (dome or closed roof): over", "indoor games", pd.Series(np.where(A.indoor == 1, 1, np.nan), index=A.index), None),
        ("Division game: under", "division games", pd.Series(np.where(A["div"] == 1, -1, np.nan), index=A.index), None),
        ("Prime time (TNF/SNF/MNF): under", "prime-time games", pd.Series(np.where(A.slot.isin(["TNF", "SNF", "MNF"]), -1, np.nan), index=A.index), None),
    ]
    rows = []
    for name, rule, side, raw in tot_signals:
        cells = []
        for s in (2026, 2025):
            sub = A.season == s
            w, l, p = ou_record(A[sub], side[sub]); cells.append(f"{w}-{l}" + (f"-{p}" if p else "") + f" ({pct(w, w + l)}){flag(w + l)}")
        w, l, p = ou_record(A, side)
        r, n, rp = corr_p(raw, A.ou_diff) if raw is not None else (float("nan"), 0, float("nan"))
        rows.append([name, rule, *cells, *rec_cells(w, l, p), f"{r:+.2f} (n={n}, p={rp:.2f})" if raw is not None else "–"])
        ranked.append(("Totals: " + name, w, l, r, rp, cells))
    wcov = A[A.indoor == 0].groupby("season").wind.apply(lambda s: f"{s.notna().sum()}/{len(s)}").to_dict()
    md += ["### Totals (over/under)", ""] + table(["Signal", "Takes a side when", "2026 W1–9", "2025 W1–9", "Both seasons", "Hit rate", "90% CI", "p vs 50%", "r with total vs line"], rows)
    md += ["", f"Weather readings exist for outdoor games in 2025 ({wcov.get(2025)}) but only some in 2026 ({wcov.get(2026)}); they are "
           "game-day observations standing in for a late forecast, which wasn't archived.", ""]

    # player-level signals (from the earlier TD backtest)
    md += ["### Player-level signals (anytime TD)", "",
           "These were ranked earlier with the same point-in-time method on every 2026 Week 1–9 player-game (n = 3,261) and "
           "re-checked on 2025 Weeks 10–18; the full table is in `docs/BACKTEST_W1_9.md` §3. Gain = how much the input improved "
           "the model's log loss (×10⁻³ per player-game, 90% interval). Higher is better; an interval that crosses 0 is not established.", ""]
    md += table(["Rank", "Input", "2026 W1–9 gain", "2025 W10–18 repeat", "Verdict"], [
        [1, "Team expected TDs (from spread + total) × player's carry/target share", "+46.0 [28.0, 64.7] vs TD history alone", "core", "**Strong, replicated**"],
        [2, "Pre-game depth-chart rank", "+2.8 [0.3, 5.4]", "+3.1 [0.9, 5.4]", "**Real, small** (mostly RBs)"],
        [3, "Goal-line rushing role (inside-5 and goal-to-go share, QB runs)", "+2.3 [0.4, 4.2]", "+2.4 [0.8, 3.9]", "**Real, small** (RBs, QBs)"],
        [4, "Player's own TD rate", "+1.6 [−0.2, 3.4]", "+1.8 [0.5, 3.1]", "Probably real, small"],
        [5, "Snap share and estimated routes", "+1.2 [−0.2, 2.7]", "+1.0 [−0.6, 2.5]", "Not established"],
        [6, "End-zone / red-zone targets, long-TD history", "+0.3 to +0.4", "≈ 0", "Noise"],
        [7, "Opponent matchup (TDs allowed by position)", "−0.3", "−1.2 [−2.1, −0.4]", "**Hurt** in both seasons"],
        [8, "Injuries beyond removing Out players; recent role change; efficiency", "−0.3 to −1.0", "≈ 0", "No help for the chance (still needed to remove Out players)"],
    ]) + [""]

    # ========================================================================= 2. PRIME TIME
    md += ["## 2. Prime-time games versus the rest of the schedule", "",
           "TNF = Thursday night, SNF = Sunday night, MNF = Monday night (including Monday doubleheaders). Both seasons, Weeks 1–9. "
           "Favorite/underdog records are against the spread; pushes listed separately.", ""]
    def slot_row(label, d):
        n = len(d)
        nf = int(((d.spread != 0) & (d.result != 0)).sum())
        fsu = int(((np.sign(d.spread) == np.sign(d.result)) & (d.spread != 0) & (d.result != 0)).sum())
        fv = d.ats_home * np.sign(d.spread); fv = fv[d.spread != 0]
        fw, fl, fp = int((fv > 0).sum()), int((fv < 0).sum()), int((fv == 0).sum())
        hw, hl = int((d.ats_home > 0).sum()), int((d.ats_home < 0).sum())
        ow, ol, op = int((d.ou_diff > 0).sum()), int((d.ou_diff < 0).sum()), int((d.ou_diff == 0).sum())
        pts = d.home_score + d.away_score
        return [label, f"{n}{flag(n)}", pct(fsu, nf), f"{fw}-{fl}" + (f"-{fp}" if fp else "") + f" ({pct(fw, fw + fl)})",
                f"{fl}-{fw}" + (f"-{fp}" if fp else "") + f" ({pct(fl, fw + fl)})", f"{hw}-{hl} ({pct(hw, hw + hl)})",
                f"{ow}-{ol}" + (f"-{op}" if op else "") + f" ({pct(ow, ow + ol)})", f"{pts.mean():.1f}", f"{d.total_line.mean():.1f}",
                f"{(pts - d.total_line).mean():+.1f}", f"{d.tds.mean():.2f}"]
    head = ["Slot", "Games", "Favorite won", "Favorite ATS", "Underdog ATS", "Home ATS", "Over-Under", "Avg points", "Avg total line",
            "Actual − line", "TDs per game"]
    order = ["TNF", "SNF", "MNF", "Intl (Sun morning)", "Sunday day", "Other (Fri/Sat/Wed)"]
    rows = [slot_row(s, A[A.slot == s]) for s in order if (A.slot == s).any()]
    rows.append(slot_row("**All prime time (TNF+SNF+MNF)**", A[A.slot.isin(["TNF", "SNF", "MNF"])]))
    rows.append(slot_row("**Everything else**", A[~A.slot.isin(["TNF", "SNF", "MNF"])]))
    rows.append(slot_row("**All games**", A))
    md += ["### Both seasons combined", ""] + table(head, rows) + [""]
    for s in (2026, 2025):
        B = A[A.season == s]
        rows = [slot_row(x, B[B.slot == x]) for x in ["TNF", "SNF", "MNF"] if (B.slot == x).any()]
        rows.append(slot_row("All prime time", B[B.slot.isin(["TNF", "SNF", "MNF"])])); rows.append(slot_row("Everything else", B[~B.slot.isin(["TNF", "SNF", "MNF"])]))
        md += [f"### {s} only", ""] + table(head, rows) + [""]
    pt = A.slot.isin(["TNF", "SNF", "MNF"])
    ow, ol = int((A[pt].ou_diff > 0).sum()), int((A[pt].ou_diff < 0).sum())
    pt_tot = (A[pt].home_score + A[pt].away_score - A[pt].total_line)
    rest_tot = (A[~pt].home_score + A[~pt].away_score - A[~pt].total_line)
    diff = pt_tot.mean() - rest_tot.mean(); se = math.sqrt(pt_tot.var() / len(pt_tot) + rest_tot.var() / len(rest_tot))
    fvp = (A[pt].ats_home * np.sign(A[pt].spread))[A[pt].spread != 0]
    prime_stats = dict(n=int(pt.sum()), over=ow, under=ol, diff=diff, se=se, p=math.erfc(abs(diff / se) / math.sqrt(2)),
                       fav=f"{int((fvp > 0).sum())}-{int((fvp < 0).sum())}")

    # anytime-TD picks by slot (2026)
    # (filled in after the player section computes top picks)

    # ========================================================================= 3. IMPLIED SCORES
    md += ["## 3. Implied scores from the spread and total versus final scores", "",
           "Implied points: favorite = (total + spread) ÷ 2, underdog = (total − spread) ÷ 2, from the closing line. "
           "MAE = average miss in points.", ""]
    T = pd.concat([pd.DataFrame({"season": A.season, "week": A.week, "slot": A.slot, "imp": A.home_imp, "pts": A.home_score, "tds_g": A.tds}),
                   pd.DataFrame({"season": A.season, "week": A.week, "slot": A.slot, "imp": A.away_imp, "pts": A.away_score, "tds_g": A.tds})])
    T["err"] = T.pts - T.imp
    rows = []
    for (s, w), d in A.groupby(["season", "week"]):
        tt = T[(T.season == s) & (T.week == w)]
        nf = int(((d.spread != 0) & (d.result != 0)).sum()); fsu = int(((np.sign(d.spread) == np.sign(d.result)) & (d.spread != 0) & (d.result != 0)).sum())
        fv = (d.ats_home * np.sign(d.spread))[d.spread != 0]
        rows.append([s, w, len(d), f"{tt.err.abs().mean():.1f}", f"{(d.ou_diff).abs().mean():.1f}", f"{(d.result - d.spread).abs().mean():.1f}",
                     f"{d.ou_diff.mean():+.1f}", f"{int((d.ou_diff > 0).sum())}-{int((d.ou_diff < 0).sum())}",
                     f"{fsu}/{nf}", f"{int((fv > 0).sum())}-{int((fv < 0).sum())}" + (f"-{int((fv == 0).sum())}" if (fv == 0).any() else "")])
    def total_row(label, d, tt):
        nf = int(((d.spread != 0) & (d.result != 0)).sum()); fsu = int(((np.sign(d.spread) == np.sign(d.result)) & (d.spread != 0) & (d.result != 0)).sum())
        fv = (d.ats_home * np.sign(d.spread))[d.spread != 0]
        return [f"**{label}**", "", len(d), f"{tt.err.abs().mean():.1f}", f"{d.ou_diff.abs().mean():.1f}", f"{(d.result - d.spread).abs().mean():.1f}",
                f"{d.ou_diff.mean():+.1f}", f"{int((d.ou_diff > 0).sum())}-{int((d.ou_diff < 0).sum())}", f"{fsu}/{nf} ({pct(fsu, nf)})",
                f"{int((fv > 0).sum())}-{int((fv < 0).sum())} ({pct(int((fv > 0).sum()), int((fv != 0).sum()))})"]
    for s in (2026, 2025):
        rows.append(total_row(f"{s} W1–9", A[A.season == s], T[T.season == s]))
    rows.append(total_row("Both", A, T))
    md += ["### Week by week", ""] + table(["Season", "Week", "Games", "MAE team points", "MAE game total", "MAE margin", "Avg actual − total",
                                            "Over-Under", "Favorite won", "Favorite ATS"], rows) + [""]
    r_imp, n_imp, _ = corr_p(T.imp, T.pts)
    w7 = int((T.err.abs() <= 7).sum()); w3 = int((T.err.abs() <= 3).sum())
    margin = (A.home_score - A.away_score).abs()
    md += [f"- Implied team points vs actual: correlation **{r_imp:.2f}** (n = {n_imp} team-games). A team's score landed within 3 points of its "
           f"implied total {rate(w3, n_imp, False)} of the time and within 7 points {rate(w7, n_imp, False)}. The average miss of "
           f"{T.err.abs().mean():.1f} points per team is about one and a half touchdowns: the line gets the *order* of teams right far more "
           "reliably than the exact score.",
           f"- Final margins of exactly 3: {rate(int((margin == 3).sum()), len(A), False)}; exactly 7: {rate(int((margin == 7).sum()), len(A), False)}; "
           f"3 or fewer: {rate(int((margin <= 3).sum()), len(A), False)}.", ""]
    # buckets by spread
    rows = []
    for lo, hi, lab in ((0, 2.5, "0–2.5"), (3, 6.5, "3–6.5"), (7, 9.5, "7–9.5"), (10, 99, "10+")):
        d = A[(A.spread.abs() >= lo) & (A.spread.abs() <= hi) & (A.spread != 0)]
        nf = int((d.result != 0).sum()); fsu = int(((np.sign(d.spread) == np.sign(d.result)) & (d.result != 0)).sum())
        fv = d.ats_home * np.sign(d.spread)
        imp_fav = np.where(d.spread > 0, d.home_imp, d.away_imp); act_fav = np.where(d.spread > 0, d.home_score, d.away_score)
        rows.append([lab, f"{len(d)}{flag(len(d))}", rate(fsu, nf, False), f"{int((fv > 0).sum())}-{int((fv < 0).sum())}" + (f"-{int((fv == 0).sum())}" if (fv == 0).any() else "") + f" ({pct(int((fv > 0).sum()), int((fv != 0).sum()))})",
                     f"{(d.result.abs() * np.sign(d.result) * np.sign(d.spread)).mean():+.1f} vs {d.spread.abs().mean():.1f}", f"{(act_fav - imp_fav).mean():+.1f}"])
    md += ["### By size of the spread", ""] + table(["Spread", "Games", "Favorite won", "Favorite ATS", "Favorite's avg margin vs avg spread", "Favorite pts vs implied"], rows) + [""]
    # buckets by total
    rows = []
    for lo, hi, lab in ((0, 40.5, "40.5 or less"), (41, 44.5, "41–44.5"), (45, 48.5, "45–48.5"), (49, 99, "49+")):
        d = A[(A.total_line >= lo) & (A.total_line <= hi)]
        rows.append([lab, f"{len(d)}{flag(len(d))}", f"{int((d.ou_diff > 0).sum())}-{int((d.ou_diff < 0).sum())} ({pct(int((d.ou_diff > 0).sum()), int((d.ou_diff != 0).sum()))})",
                     f"{d.total_line.mean():.1f}", f"{(d.home_score + d.away_score).mean():.1f}", f"{d.tds.mean():.2f}"])
    md += ["### By size of the total", ""] + table(["Total", "Games", "Over-Under", "Avg line", "Avg actual", "TDs per game"], rows) + [""]
    # team implied points -> touchdowns (what matters for anytime TD picks)
    ttd = []
    for s in (2025, 2026):
        p = pd.read_parquet(C / f"play_by_play_{s}.parquet", columns=["game_id", "week", "touchdown", "two_point_attempt", "td_team"])
        x = p[(p.touchdown == 1) & (p.two_point_attempt != 1)].groupby(["game_id", "td_team"]).size().rename("team_tds")
        ttd.append(x)
    ttd = pd.concat(ttd)
    TT = pd.concat([pd.DataFrame({"game_id": A.game_id, "team": A.home, "imp": A.home_imp, "pts": A.home_score}),
                    pd.DataFrame({"game_id": A.game_id, "team": A.away, "imp": A.away_imp, "pts": A.away_score})])
    TT = TT.join(ttd, on=["game_id", "team"]); TT["team_tds"] = TT.team_tds.fillna(0)
    rows = []
    for lo, hi, lab in ((0, 16.9, "under 17"), (17, 20.9, "17–20.5"), (21, 24.9, "21–24.5"), (25, 99, "25+")):
        d = TT[(TT.imp >= lo) & (TT.imp <= hi)]
        rows.append([lab, f"{len(d)}{flag(len(d))}", f"{d.imp.mean():.1f}", f"{d.pts.mean():.1f}", f"{d.team_tds.mean():.2f}", rate(int((d.team_tds >= 3).sum()), len(d), False), rate(int((d.team_tds == 0).sum()), len(d), False)])
    md += ["### Team implied points → touchdowns (what drives anytime-TD picks)", ""] + table(
        ["Team implied points", "Team-games", "Avg implied", "Avg scored", "Avg TDs", "3+ TDs", "Zero TDs"], rows) + [""]
    # did the gap between implied and actual predict anything?
    tg = pd.concat([pd.DataFrame({"season": A.season, "week": A.week, "team": A.home, "gap": A.home_score - A.home_imp, "covm": A.ats_home}),
                    pd.DataFrame({"season": A.season, "week": A.week, "team": A.away, "gap": A.away_score - A.away_imp, "covm": -A.ats_home})]).sort_values(["season", "team", "week"])
    tg["prev3_gap"] = tg.groupby(["season", "team"]).gap.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean())
    r1, n1, p1 = corr_p(tg.prev3_gap, tg.gap); r2, n2, p2 = corr_p(tg.prev3_gap, tg.covm)
    beat = tg[tg.covm != 0]; k = int(((beat.gap > 0) & (beat.covm > 0)).sum()); nb = int((beat.gap > 0).sum())
    md += ["### Did the gap between implied and actual scores predict anything?", "",
           f"- **Point-in-time test.** A team's average gap over its previous 3 games (scored minus implied) vs its next game: correlation "
           f"with the next gap **{r1:+.2f}** (n = {n1}, p = {p1:.2f}); with next week's cover margin **{r2:+.2f}** (n = {n2}, p = {p2:.2f}). "
           "Teams that had been beating their implied totals did not keep doing it at a rate the market missed.",
           f"- **Same-game (descriptive only, not a pick).** Teams that beat their implied points covered {rate(k, nb, False)}. This is close to "
           "automatic (scoring more than expected usually means covering) and can't be known before kickoff.", ""]

    # ========================================================================= 4. PLAYER-LEVEL HIT RATES
    md += ["## 4. Player-level hit rates: each team's highest-chance anytime-TD pick", "",
           "**Prop lines.** Historical player prop lines (yards, receptions, anytime-TD prices) are **not** in the data, apart from the "
           "family's own anytime-TD prices for Weeks 2–4, so 'players most likely to exceed a prop line' can't be graded. This section "
           "uses the app's market, anytime TD: for each team and week, the player with the highest pre-game chance from model "
           "usage-v0.3c refit on earlier weeks only, skipping players listed Out or Doubtful. A pick whose player didn't take a snap is "
           "**void** (as a sportsbook would treat it) and left out of the hit rate.", ""]
    P = P.merge(G[["game_id", "slot"]], on="game_id", how="left")
    cand = P[~P.inj_status.isin(["Out", "Doubtful"])].copy()
    top = cand.sort_values("p", ascending=False).groupby(["week", "team"]).head(1).copy()
    top["graded"] = top.game_final & top.played
    top["hit"] = top.graded & (top.tds > 0)
    top["void"] = top.game_final & ~top.played
    H = top[(top.week <= 9)]
    rows = []
    for w, d in H.groupby("week"):
        g = d[d.graded]
        rows.append([w, len(d), int(d.void.sum()), len(g), int(g.hit.sum()), rate(int(g.hit.sum()), len(g), False), f"{g.p.mean():.1%}", f"{g.p.sum():.1f}"])
    g = H[H.graded]; agg_k, agg_n = int(g.hit.sum()), len(g)
    rows.append(["**All**", len(H), int(H.void.sum()), agg_n, agg_k, f"**{rate(agg_k, agg_n)}**", f"{g.p.mean():.1%}", f"{g.p.sum():.1f}"])
    md += ["### By week (2026)", ""] + table(["Week", "Team picks", "Void", "Graded", "Scored", "Hit rate", "Avg model chance", "Expected hits"], rows) + [""]
    md += [f"**Aggregate:** the top pick per team scored {rate(agg_k, agg_n)}; the model expected {g.p.mean():.1%} "
           f"({g.p.sum():.1f} hits vs {agg_k} actual), so its chances were {'about right' if abs(g.p.sum() - agg_k) <= 2 * math.sqrt(g.p.mul(1 - g.p).sum()) else 'off'} "
           f"(within ±2 standard deviations = ±{2 * math.sqrt(g.p.mul(1 - g.p).sum()):.1f} hits). A typical anytime-TD price on these players "
           f"would need to be about {(1 / (agg_k / agg_n) - 1) * 100:+.0f} or longer to break even at this hit rate (≈ the American odds equal to the hit rate).", ""]
    # by team
    rows = []
    for team, d in H.groupby("team"):
        gg = d[d.graded]; most = gg.name.value_counts()
        rows.append([team, len(gg), int(gg.hit.sum()), (f"{gg.hit.mean():.0%}" if len(gg) else "–") + flag(len(gg)), f"{gg.p.mean():.0%}" if len(gg) else "–",
                     ", ".join(f"{n} ×{c}" for n, c in most.head(2).items())])
    rows.sort(key=lambda r: (-(r[2] / r[1] if r[1] else 0), r[0]))
    md += ["### By team (2026 Weeks 1–9; every team has under 15 picks, so every team rate is preliminary)", ""] + table(
        ["Team", "Graded", "Scored", "Hit rate", "Avg chance", "Most-picked players"], rows) + [""]
    # by position / chance bucket / slot
    rows = []
    for pos, d in H[H.graded].groupby("pos"):
        rows.append([pos, rate(int(d.hit.sum()), len(d)), f"{d.p.mean():.1%}"])
    md += ["### By position of the top pick", ""] + table(["Position", "Hit rate", "Avg model chance"], rows) + [""]
    rows = []
    for lo, hi, lab in ((0, .30, "under 30%"), (.30, .40, "30–40%"), (.40, .50, "40–50%"), (.50, 1, "50%+")):
        d = H[H.graded & (H.p >= lo) & (H.p < hi)]
        rows.append([lab, rate(int(d.hit.sum()), len(d)), f"{d.p.mean():.1%}" if len(d) else "–"])
    md += ["### By the model's chance for the top pick (calibration)", ""] + table(["Model chance", "Hit rate", "Avg model chance"], rows) + [""]
    rows = []
    for s in ["TNF", "SNF", "MNF", "Intl (Sun morning)", "Sunday day", "Other (Fri/Sat/Wed)"]:
        d = H[H.graded & (H.slot == s)]
        if len(d):
            rows.append([s, rate(int(d.hit.sum()), len(d)), f"{d.p.mean():.1%}"])
    md += ["### By kickoff slot", ""] + table(["Slot", "Hit rate", "Avg model chance"], rows) + [""]
    lb = leadback_by_slot()
    ptk = int(H[H.graded & H.slot.isin(["TNF", "SNF", "MNF"])].hit.sum()); ptn = int((H.graded & H.slot.isin(["TNF", "SNF", "MNF"])).sum())
    md += [f"**Prime-time check.** In 2026 the top pick scored far more often in prime time ({rate(ptk, ptn, False)}) than the model expected. "
           "To see whether that repeats, the same comparison was run on 2025 with a rule that needs no model: each team's lead back "
           "(most carries in earlier weeks of the season; void if he didn't play).", ""]
    md += table(["Season", "Prime time (TNF/SNF/MNF)", "All other games"], [
        [s, rate(*lb[(s, True)]), rate(*lb[(s, False)])] for s in (2026, 2025)] + [["2025, Weeks 2–9 only", rate(*lb[("2025w9", True)]), rate(*lb[("2025w9", False)])]])
    md += ["", "It **did not repeat** in 2025 (lead backs scored slightly *less* in prime time), so the 2026 prime-time jump is most likely "
           "a small-sample streak, not something to build picks on.", ""]
    # league-wide top 10 per week
    t10 = cand[cand.week <= 9].sort_values("p", ascending=False).groupby("week").head(10)
    t10 = t10[t10.game_final & t10.played]
    md += [f"**Top 10 chances league-wide each week:** scored {rate(int((t10.tds > 0).sum()), len(t10))}; model expected {t10.p.mean():.1%}.", ""]
    # alternative selection rules (same team-weeks, Weeks 2-9)
    hist = P[P.game_final].groupby(["pid", "week"]).tds.sum().reset_index()
    def prior_tds(row):
        return 0
    cand2 = cand[(cand.week >= 2) & (cand.week <= 9)].copy()
    tdcum = hist.sort_values("week")
    cum = {}
    for w in range(2, 10):
        prev = tdcum[tdcum.week < w].groupby("pid").tds.sum()
        cum[w] = prev
    cand2["prior_tds"] = [float(cum[w].get(pid, 0)) for w, pid in zip(cand2.week, cand2.pid)]
    rules = {"Model (usage-v0.3c)": "p", "Most TDs so far this season (tie → model)": None, "Biggest carry share (lead back)": "carry_share",
             "Biggest target share (top receiver)": "target_share"}
    rows = []; base_pick = None
    for name, col in rules.items():
        if col is None:
            pick = cand2.sort_values(["prior_tds", "p"], ascending=False).groupby(["week", "team"]).head(1)
        else:
            pick = cand2.sort_values(col, ascending=False).groupby(["week", "team"]).head(1)
        gpk = pick[pick.game_final & pick.played]
        rows.append([name, rate(int((gpk.tds > 0).sum()), len(gpk)), f"{gpk.p.mean():.1%}"])
    md += ["### Which selection rule picks the best player per team? (Weeks 2–9, same team-weeks for every rule)", ""] + table(
        ["Rule", "Hit rate", "Model's avg chance for those players"], rows) + [""]

    # ========================================================================= 5. WEEK 10 FORECAST
    md += ["## 5. Week 10 (2026) forecast: the same signals before kickoff", "",
           "Built exactly like the Weeks 1–9 rows: only the closing line as of this run, results through Week 9, and the Week 10 "
           "injury report and roster. **These are not recommendations**: §1 shows no game-level signal beat the line reliably, so "
           "they're context for your own picks. WAS at NYG was played on Thursday, Nov 12; it is shown pre-game only.", ""]
    try:
        fc = json.load(open(C / "weather_forecast.json"))["games"]
    except Exception:
        fc = {}
    rows = []
    for r in W10.sort_values(["gametime"]).sort_values("weekday", key=lambda s: s.map({"Thursday": 0, "Sunday": 1, "Monday": 2})).itertuples():
        fav = r.home if r.spread > 0 else r.away
        fcg = fc.get(r.game_id, {})
        wx = "indoors" if r.indoor or fcg.get("roof") in ("dome",) else (f"{fcg['wind_mph']:.0f} mph, {fcg.get('temp_f')}°F" if fcg.get("wind_mph") is not None else "forecast n/a")
        notes = []
        if abs(r.edge_epa) >= 3: notes.append(f"EPA rating {'+' if r.edge_epa > 0 else '−'}{abs(r.edge_epa):.1f} toward {r.home if r.edge_epa > 0 else r.away}")
        if abs(r.edge_margin) >= 3: notes.append(f"margin rating {'+' if r.edge_margin > 0 else '−'}{abs(r.edge_margin):.1f} toward {r.home if r.edge_margin > 0 else r.away}")
        if pd.notna(r.rest_diff) and abs(r.rest_diff) >= 3: notes.append(f"rest edge {r.home if r.rest_diff > 0 else r.away}")
        if r.qb_out_home == 1: notes.append(f"{r.home} main QB out")
        if r.qb_out_away == 1: notes.append(f"{r.away} main QB out")
        if r.body_clock: notes.append(f"{r.away} early body-clock game")
        rows.append([f"{r.away} at {r.home}", r.slot, f"{fav} −{abs(r.spread):g}", f"{r.total_line:g}", f"{r.away} {r.away_imp:.1f} – {r.home} {r.home_imp:.1f}",
                     wx, "; ".join(notes) or "–"])
    md += table(["Game", "Slot", "Line", "Total", "Implied score", "Weather (NWS forecast)", "Signals with an opinion (none proven)"], rows) + [""]
    w10 = top[top.week == 10].merge(W10[["game_id", "away", "home", "home_imp", "away_imp"]], on="game_id")
    w10["imp"] = np.where(w10.team == w10.home, w10.home_imp, w10.away_imp)
    w10 = w10.sort_values("p", ascending=False)
    rows = [[r.team, r.name, r.pos, f"{r.p:.0%}", f"{r.imp:.1f}", {"team": "team expectation", "workload": "workload", "goal_line": "goal-line role", "depth": "depth chart", "history": "TD history"}.get(r.main_driver, r.main_driver),
             r.inj_status if isinstance(r.inj_status, str) and r.inj_status else "–"] for r in w10.itertuples()]
    md += ["### Week 10 highest-chance anytime-TD player for each team", ""] + table(["Team", "Player", "Pos", "Model chance", "Team implied pts", "Main reason", "Injury status"], rows)
    md += ["", f"On Weeks 1–9 this exact rule hit {rate(agg_k, agg_n, False)}; expect roughly {w10.p.sum():.0f} of these {len(w10)} to score.", ""]

    # ========================================================================= SUMMARY
    md += ["## Summary: the strongest signals and how much to trust them", ""]
    md += ["| Signal | What the evidence shows | Confidence |", "|---|---|---|",
           f"| **Team implied points (from spread + total)** | Best single predictor of who scores: team TDs rise steadily with implied points (§3), and team expectation × player share is the core of the TD model (+46 log-loss gain, replicated). Implied team points vs actual: r = {r_imp:.2f}, n = {n_imp}. | **High** |",
           "| **Player workload + goal-line role + depth chart** | Each adds a small, real improvement to TD chances, repeated on 2025 data. | **Moderate–high** (small effects) |",
           f"| **Model's top pick per team** | Hit {rate(agg_k, agg_n, False)} in 2026 Weeks 1–9, close to what the model predicted ({g.p.mean():.0%}). Calibrated; at this hit rate the price has to be about {(1 / (agg_k / agg_n) - 1) * 100:+.0f} or longer to profit, so the pick is only as good as the price. Picks the model put at 50%+ hit {rate(int(H[H.graded & (H.p >= .5)].hit.sum()), int((H.graded & (H.p >= .5)).sum()), False)}. | **Moderate** (calibration fine; profit depends on price) |",
           f"| **Rest advantage** | Correlation with covering pointed the same way in both seasons (r = {rr[2026][0]:+.2f} and {rr[2025][0]:+.2f}), mostly from bye-week games; the 3+ day rule went 21-9 in 2026 but 12-13 in 2025. | **Low–moderate / preliminary**: the most promising game-level signal |",
           "| **Fading teams on a hot cover streak** | Backing the team with the better last-3 cover record went 49-77 (38.9%, p = 0.02), i.e. fading it won 61%, but almost all of that came from 2025 (23-46); 2026 was close to even (26-31). About 20 tests were run, so one result this strong is expected by chance. | **Low**: watch it, don't bet it |",
           "| **Ratings vs the line** (margin, EPA), travel, QB out, key injuries, division dogs | None beat the closing line in both seasons; the ratings did *worse* than a coin flip when they disagreed with the line, and the line's favorite won 69% of games vs 63–64% for either rating. The closing line already prices these. | **Low**: no evidence of an edge |",
           f"| **Prime time** | {prime_stats['n']} prime-time games went {prime_stats['over']}-{prime_stats['under']} over/under and favorites covered {prime_stats['fav']}; totals averaged {prime_stats['diff']:+.1f} points vs the rest relative to the line (p = {prime_stats['p']:.2f}). Favorites won straight up less often in prime time (56% vs 73%). The 2026 prime-time TD jump did not repeat in 2025. | **Low / preliminary** |",
           "| **Mid-size favorites (7–9.5)** | Covered only 16-29 (35.6%) across both seasons, while 3–6.5 favorites covered 57.8%. Not a pre-registered test; could easily be noise. | **Low / preliminary** |",
           "| **Weather (wind, cold)** | Too few windy or cold games in Weeks 1–9 to tell, and 2026 readings are incomplete. Earlier work (`refresh/wind_study.json`) is the better reference. | **Insufficient data** |", ""]
    md += ["### Data that wasn't available, and what it could change", "",
           "- **Line movement / opening lines.** Only closing lines are stored. Opening-to-closing movement is a well-known signal; with it, §1 could test whether following or fading the move beats the close.",
           "- **Player prop lines and historical anytime-TD prices** (except the family's Weeks 2–4 prices). With them, §4 could report hit rates *against the price* and actual return, which is what decides whether a pick is good.",
           "- **Archived weather forecasts.** Game-day readings were used instead, and 2026 coverage is partial; the weather rows would firm up with forecasts.",
           "- **2025 player picks.** The TD model needs a prior season to train on; 2024 player features weren't built, so §4 is 2026 only (n ≈ 270 team picks).",
           "- **Routes run in 2026, offensive-line and defensive injuries.** Not in the data; they could sharpen the injury signals.", ""]
    out = ROOT / "docs" / "ANALYSIS_W1_10.md"
    out.write_text("\n".join(md) + "\n")
    json.dump({"ats_and_totals": [dict(name=n, w=w, l=l, r=r, p=p, by_season=c) for n, w, l, r, p, c in ranked], "prime": prime_stats,
               "top_pick": {"hits": agg_k, "n": agg_n, "expected": float(g.p.sum())}, "implied_r": r_imp},
              open(ROOT / "research" / "season_analysis_results.json", "w"), indent=1, default=float)
    import analysis_to_json  # the app's copy (artifact/data/analysis.json) is rebuilt from the Markdown
    analysis_to_json.convert()
    print("wrote", out)


if __name__ == "__main__":
    main()
