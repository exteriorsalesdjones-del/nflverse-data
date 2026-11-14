# Admin setup

1. **Open the app:** https://claude.ai/artifact/6vni4HxfKfykT45J3F5SoD. You are the owner and admin.
2. **Invite people** from the page's Share menu. Access levels:
   - **Contributor** — can save and submit their own picks. Available to members of your Claude organization.
   - **Viewer** — can browse research and the board, cannot pick.
   - **Editor** — admin: odds import, attribution reviews, kickoff snapshots, and can change anyone's data.
   - People **outside your Claude organization** (for example friends on their own personal accounts) get view-only access when invited by email, whatever level you pick, unless you make them an Editor and the artifact is not shared by public link. See "Open decision" in the handoff.
3. **Odds:** Admin → Odds import. Paste CSV (`player,team,book,american,captured_at`) or upload a sportsbook screenshot; rows stay pending until you press Approve and publish. Unmatched names are flagged.
4. **Kickoff snapshots:** the scheduled refresh freezes picks after each kickoff window. You can also press "Snapshot started games now" in Admin.
5. **Attribution reviews:** Admin → review queue, or open any touchdown. Record observed actions, inferred assignment, role, and evidence (chart source or film timestamp). Verified requires evidence.
6. **Refresh:** scheduled tasks run `docs/REFRESH_RUNBOOK.md`. To run one by hand, ask Claude in this repository to "run the Family Board refresh runbook".
7. **PropLine:** to switch on automatic prices, create a PropLine key and tell Claude; it will be stored as a network credential for the refresh environment, never in the page or repo.
8. **Player status:** Admin → Player status. Mark a player Out, Doubtful, Questionable or Not on roster when news breaks before the data updates; add the source as a note. "Clear" goes back to the data. Statuses are per week and only admins can set them.
9. **Roster check:** each refresh lists only players on their team's current active roster (nflverse weekly rosters). Players on injured reserve, practice squads, released or traded show under "Off the active roster" when you tap "Show all players".
