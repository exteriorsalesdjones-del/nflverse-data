"""Live poller scenarios on SIMULATED events (tests/sim_live.py), mapped onto the real Week 10 schedule and players.
Run: python3 tests/test_live_feed.py"""
import json, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "refresh")); sys.path.insert(0, str(ROOT / "tests"))
import live_feed as LF  # noqa: E402
import sim_live  # noqa: E402

res = []
def check(n, ok, d=""):
    res.append(ok); print(("PASS " if ok else "FAIL ") + n + (f" — {d}" if d else ""))

tmp = Path(tempfile.mkdtemp()); script = sim_live.write(tmp / "sim.json")
prov = LF.Sim(script); M = LF.Matcher(); state = {}; out = tmp / "out"; out.mkdir()
def at(t):
    prov.t0 = time.time() - t
    return [json.loads(p.read_text()) for p in LF.poll_once(prov, M, state, out, 10)]
def ev(docs, gid):
    return next((d for d in docs if d["game_id"] == gid), None)
B, C = "2026_10_BUF_NYJ", "2026_10_CAR_NO"

d0 = at(0)
check("kickoff: both simultaneous games appear, no touchdowns", {d["game_id"] for d in d0} == {B, C} and all(not d["events"] for d in d0))
d2 = at(2); b = ev(d2, B)
check("first TD: James Cook, matched to the app's player id, provisional", b and len(b["events"]) == 1 and b["events"][0]["scorer"] == "James Cook"
      and b["events"][0]["gsis_id"] == "00-0037248" and b["events"][0]["provisional"] and b["counts"] == {"00-0037248": 1}, json.dumps(b and b["events"][0])[:200])
d4 = at(4)
check("repeated event: the same play again writes nothing and never duplicates", d4 == [] and len(state[B]["events"]) == 1)
d6 = at(6)
check("two simultaneous games update in the same poll", {d["game_id"] for d in d6} == {B, C}, f"{len(d6)} documents")
check("passer listed with a receiver: the receiver is the scorer", ev(d6, B)["events"][1]["scorer"] == "Josh Allen")
d8 = at(8); b = ev(d8, B)
check("second TD by the same player: Cook's in-game count is 2", b["counts"].get("00-0037248") == 2, json.dumps(b["counts"]))
d10 = at(10); b = ev(d10, B); e = next(x for x in b["events"] if x["key"] == "1002")
check("scorer correction: same play key, credited to DJ Moore, Allen's count removed",
      e["scorer"] == "DJ Moore" and e["gsis_id"] == "00-0034827" and b["counts"].get("00-0034857") is None and b["counts"].get("00-0034827") == 1
      and e["history"][-1]["change"] == "scorer" and len(b["events"]) == 3, json.dumps(e["history"]))
d12 = at(12); c = ev(d12, C)
check("overturned TD: kept as overturned, not counted, game score follows the source",
      c["events"][0]["state"] == "overturned" and c["counts"] == {} and c["home_score"] == 0 and c["away_score"] == 0, json.dumps(c["events"][0]["history"]))
check("the other game is untouched by the overturn", ev(d12, B) is None)
check("every document is create-only (unique id per change)", len({p.name for p in out.glob('*.json')}) == len(list(out.glob('*.json'))))
check("nothing settles: every live event is provisional", all(x["provisional"] for p in out.glob('2026*.json') for x in json.loads(p.read_text())["events"]))
# restored after overturn
prov.steps.append({"t": 14, "game": sim_live.game(9002, "CAR", "NO", 7, 0), "plays": [sim_live.H1]})
d14 = at(14); c = ev(d14, C)
check("overturned play restored by the source counts again", c["events"][0]["state"] == "active" and c["counts"] == {"00-0036555": 1})
# text fallback when the participant id has no name
t = LF.td_from_play({"id": "7", "scoring_play": True, "type_slug": "passing-touchdown", "text": "T.Shough pass short left to A.Kamara for 4 yards, TOUCHDOWN.",
                     "participants": [], "team": {"abbreviation": "NO"}, "period": 4, "clock_display": "3:49"}, {})
check("scorer read from the play text when no participant is given (matched: Alvin Kamara)", t["scorer_name"] == "A.Kamara" and M.player("NO", t["scorer_name"])[0] == "00-0033906")
check("two-point tries and non-scoring plays are ignored", LF.td_from_play({"id": "8", "scoring_play": True, "type_slug": "two-point-conversion", "text": "TWO-POINT CONVERSION ATTEMPT ... TOUCHDOWN", "participants": []}, {}) is None)
print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed"); sys.exit(0 if all(res) else 1)
