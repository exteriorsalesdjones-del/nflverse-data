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
check("a touchdown whose text mentions the failed two-point try still counts", LF.td_from_play({"id": "9", "scoring_play": True, "type_slug": "rushing-touchdown", "text": "J.Cook up the middle for 2 yards, TOUCHDOWN. (Two-Point Conversion Failed)", "participants": [], "team": {"abbreviation": "BUF"}}, {}) is not None)
t = LF.td_from_play({"id": "10", "scoring_play": True, "type_slug": "fumble-return-touchdown", "text": "TOUCHDOWN", "participants": [{"type": "passer", "player_id": 1}, {"type": "receiver", "player_id": 2}, {"type": "recoverer", "player_id": 3}], "team": {"abbreviation": "BUF"}}, {1: "QB One", 2: "WR Two", 3: "LB Three"})
check("fumble-return touchdown is credited to the recoverer, not the intended receiver", t["scorer_name"] == "LB Three", t["scorer_name"])
t = LF.td_from_play({"id": "11", "scoring_play": True, "type_slug": "passing-touchdown", "text": "pass, TOUCHDOWN", "participants": [{"type": "passer", "player_id": 1}, {"type": "blocker", "player_id": 2}], "team": {"abbreviation": "BUF"}}, {1: "QB One", 2: "OL Two"})
check("a passer is never credited when no scorer is listed with him", t["scorer_name"] is None, str(t["scorer_name"]))
check("in-game status wording (Halftime, 3rd Quarter, Final/OT) is recognised", [LF.game_from_bdl({"id": 1, "status": s})["status"] for s in ("Halftime", "3rd Quarter", "Final/OT", "Final", "Scheduled", "in")] == ["in_progress", "in_progress", "final", "final", "scheduled", "in_progress"],
      str([LF.game_from_bdl({"id": 1, "status": s})["status"] for s in ("Halftime", "3rd Quarter", "Final/OT", "Final", "Scheduled", "in")]))
class Flaky:
    name = "flaky"
    def games(self): return [LF.game_from_bdl(sim_live.game(9001, "BUF", "NYJ", 7, 0)), LF.game_from_bdl(sim_live.game(9002, "CAR", "NO", 7, 0))]
    def touchdowns(self, g):
        if g["source_game_id"] == 9002: raise TimeoutError("slow")
        return [LF.td_from_play({"id": "5001", "scoring_play": True, "type_slug": "rushing-touchdown", "text": "J.Cook up the middle for 2 yards, TOUCHDOWN.", "participants": [], "team": {"abbreviation": "BUF"}, "period": 1, "clock_display": "9:00"}, {})]
st2 = {}; o2 = tmp / "o2"; o2.mkdir()
w = LF.poll_once(Flaky(), M, st2, o2, 10)
check("one game's failed fetch doesn't lose the other game's update, and the error is reported", len(w) == 1 and B in w[0].name and st2["_errors"] and C in st2["_errors"][0], f"{[p.name for p in w]} {st2.get('_errors')}")
print(f"\n{sum(res)} passed, {len(res) - sum(res)} failed"); sys.exit(0 if all(res) else 1)
