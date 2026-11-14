"""Game-time weather forecasts for upcoming games: US National Weather Service (api.weather.gov)
for US stadiums, Open-Meteo for international venues and as a fallback. Both are free and keyless.

Wind is the mean forecast sustained wind (10 m, mph) from the kickoff hour through
three hours after, matching how the historical wind study measured games. A game is
flagged windy at 15 mph or more, outdoors only. Domes are skipped; retractable roofs
are shown but not flagged (teams usually close them in bad weather).

Usage: python weather.py   (reads .data/cache/games.csv, writes .data/cache/weather_forecast.json)
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

SEASON = 2026
WINDY_MPH = 15
CACHE = Path(os.environ.get("FB_CACHE", Path(__file__).resolve().parents[1] / ".data" / "cache"))
API = "https://api.open-meteo.com/v1/forecast"
NWS = "https://api.weather.gov"
UA = {"User-Agent": "family-board-weather/1.0", "Accept": "application/geo+json"}


def _get(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.load(r)


def forecast_nws(lat: float, lon: float, kickoff_et: str) -> dict:
    pts_file = CACHE / "nws_points.json"
    pts = json.loads(pts_file.read_text()) if pts_file.exists() else {}
    key = f"{lat},{lon}"
    if key not in pts:
        pts[key] = _get(f"{NWS}/points/{lat},{lon}")["properties"]["forecastHourly"]
        pts_file.write_text(json.dumps(pts))
    periods = _get(pts[key])["properties"]["periods"]
    k = pd.Timestamp(kickoff_et).tz_localize("America/New_York")
    rows = []
    for x in periods:
        t = pd.Timestamp(x["startTime"])
        if k.floor("h") <= t <= k + pd.Timedelta(hours=3):
            mph = [float(v) for v in str(x["windSpeed"]).replace("mph", "").replace("to", " ").split()]
            rows.append((max(mph) if mph else None, x.get("temperature"), (x.get("probabilityOfPrecipitation") or {}).get("value") or 0, x.get("shortForecast")))
    if not rows or rows[0][0] is None:
        raise ValueError("no forecast hours for this kickoff yet")
    return {"wind_mph": round(sum(r[0] for r in rows) / len(rows), 1), "gust_mph": None,
            "temp_f": round(sum(r[1] for r in rows) / len(rows)), "precip_pct": int(max(r[2] for r in rows)),
            "sky": rows[0][3], "source": "National Weather Service hourly forecast"}

# stadium_id (nflverse) -> (latitude, longitude, roof kind). Roof kind is the building, not the
# nflverse game value, because nflverse leaves roof blank before kickoff for retractable roofs.
STADIUMS = {
    "ATL97": (33.7554, -84.4008, "retractable"), "BAL00": (39.2780, -76.6227, "outdoor"),
    "BOS00": (42.0909, -71.2643, "outdoor"), "BUF00": (42.7738, -78.7870, "outdoor"),
    "BUF01": (42.7738, -78.7870, "outdoor"),
    "CAR00": (35.2258, -80.8528, "outdoor"), "CHI98": (41.8623, -87.6167, "outdoor"),
    "CIN00": (39.0955, -84.5160, "outdoor"), "CLE00": (41.5061, -81.6995, "outdoor"),
    "DAL00": (32.7473, -97.0945, "retractable"), "DEN00": (39.7439, -105.0201, "outdoor"),
    "DET00": (42.3400, -83.0456, "dome"), "GNB00": (44.5013, -88.0622, "outdoor"),
    "HOU00": (29.6847, -95.4107, "retractable"), "IND00": (39.7601, -86.1639, "retractable"),
    "JAX00": (30.3239, -81.6373, "outdoor"), "KAN00": (39.0489, -94.4839, "outdoor"),
    "LAX01": (33.9535, -118.3392, "dome"), "MIA00": (25.9580, -80.2389, "outdoor"),
    "MIN01": (44.9737, -93.2581, "dome"), "NAS00": (36.1665, -86.7713, "outdoor"),
    "NOR00": (29.9511, -90.0812, "dome"), "NYC01": (40.8135, -74.0745, "outdoor"),
    "PHI00": (39.9008, -75.1675, "outdoor"), "PHO00": (33.5276, -112.2626, "retractable"),
    "PIT00": (40.4468, -80.0158, "outdoor"), "SEA00": (47.5952, -122.3316, "outdoor"),
    "SFO01": (37.4030, -121.9700, "outdoor"), "TAM00": (27.9759, -82.5033, "outdoor"),
    "VEG00": (36.0909, -115.1833, "dome"), "WAS00": (38.9076, -76.8645, "outdoor"),
    # international venues (open-air bowls; roofs cover the stands only, except the Bernabeu)
    "LON00": (51.5560, -0.2796, "outdoor"), "LON02": (51.6043, -0.0664, "outdoor"),
    "MAD01": (40.4531, -3.6883, "retractable"), "MEL00": (-37.8200, 144.9834, "outdoor"),
    "MEX00": (19.3029, -99.1505, "outdoor"), "MUN01": (48.2188, 11.6247, "outdoor"),
    "PAR00": (48.9245, 2.3602, "outdoor"), "RIO00": (-22.9122, -43.2302, "outdoor"),
}


def forecast(lat: float, lon: float, kickoff_et: str) -> dict:
    k = datetime.fromisoformat(kickoff_et)
    q = (f"{API}?latitude={lat}&longitude={lon}&hourly=wind_speed_10m,wind_gusts_10m,temperature_2m,precipitation_probability"
         f"&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=America/New_York"
         f"&start_date={k.date()}&end_date={(k + timedelta(hours=4)).date()}")
    with urllib.request.urlopen(q, timeout=30) as r:
        h = json.load(r)["hourly"]
    df = pd.DataFrame(h)
    df["time"] = pd.to_datetime(df.time)
    w = df[(df.time >= pd.Timestamp(k).floor("h")) & (df.time <= pd.Timestamp(k) + pd.Timedelta(hours=3))]
    if w.empty or w.wind_speed_10m.isna().all():
        raise ValueError("no forecast hours for this kickoff yet")
    return {"wind_mph": round(float(w.wind_speed_10m.mean()), 1), "gust_mph": round(float(w.wind_gusts_10m.max()), 1),
            "temp_f": round(float(w.temperature_2m.mean())), "precip_pct": int(w.precipitation_probability.max()), "source": "Open-Meteo forecast"}


def main() -> int:
    g = pd.read_csv(CACHE / "games.csv")
    g = g[(g.season == SEASON) & g.result.isna()]
    if g.empty:
        print(json.dumps({"games": 0})); return 0
    week = int(g.week.min())
    out, errs = {}, []
    now = datetime.now(timezone.utc)
    for r in g[g.week == week].itertuples():
        st = STADIUMS.get(r.stadium_id)
        kickoff = f"{r.gameday}T{r.gametime}"
        if st is None:
            out[r.game_id] = {"roof": "unknown", "note": f"stadium {r.stadium_id} not in the stadium list"}; errs.append(r.game_id); continue
        lat, lon, kind = st
        if kind == "dome":
            out[r.game_id] = {"roof": "dome"}; continue
        try:
            us = lat > 18 and lon < -60
            try:
                f = forecast_nws(lat, lon, kickoff) if us else forecast(lat, lon, kickoff)
            except Exception:
                f = forecast(lat, lon, kickoff) if us else forecast_nws(lat, lon, kickoff)
            out[r.game_id] = {"roof": kind, **f, "windy": kind == "outdoor" and f["wind_mph"] >= WINDY_MPH,
                              "fetched_at": now.isoformat(timespec="seconds")}
        except Exception as e:  # keep going; the page shows "no forecast"
            out[r.game_id] = {"roof": kind, "note": f"forecast unavailable ({type(e).__name__})"}; errs.append(r.game_id)
    (CACHE / "weather_forecast.json").write_text(json.dumps({"week": week, "fetched_at": now.isoformat(timespec="seconds"), "windy_mph": WINDY_MPH, "games": out}, indent=1))
    print(json.dumps({"week": week, "games": len(out), "windy": [k for k, v in out.items() if v.get("windy")], "errors": errs}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
