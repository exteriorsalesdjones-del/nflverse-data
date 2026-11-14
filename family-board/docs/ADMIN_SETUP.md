# Admin setup

1. **Open the app:** https://claude.ai/artifact/6vni4HxfKfykT45J3F5SoD. You are the owner and admin.
2. **Invite people** from the page's Share menu. Access levels:
   - **Contributor** — can save and submit their own picks. Available to members of your Claude organization.
   - **Viewer** — can browse research and the board, cannot pick.
   - **Editor** — admin: odds import, attribution reviews, kickoff snapshots, and can change anyone's data.
   - People **outside your Claude organization** (for example friends on their own personal accounts) get view-only access when invited by email, whatever level you pick, unless you make them an Editor and the artifact is not shared by public link. See "Open decision" in the handoff.
3. **Uploads (lines):** anyone who can pick can upload prices on the Uploads tab (screenshot, CSV `player,team,book,market,price`, paste, or one at a time). Anytime TD and 2+ TDs only. Prices go live at once, labeled with the uploader and time. Uploaders remove their own; admins can remove anyone's.
3a. **Parlays:** members build parlays on the Parlays tab and save them to the board. A parlay locks at its first leg's kickoff; a leg whose player doesn't play is dropped and the rest still count.
4. **Kickoff snapshots:** the scheduled refresh freezes picks after each kickoff window. You can also press "Snapshot started games now" in Admin.
5. **Attribution reviews:** Admin → review queue, or open any touchdown. Record observed actions, inferred assignment, role, and evidence (chart source or film timestamp). Verified requires evidence.
6. **Refresh:** scheduled tasks run `docs/REFRESH_RUNBOOK.md`. To run one by hand, ask Claude in this repository to "run the Family Board refresh runbook".
7. **PropLine:** to switch on automatic prices, create a PropLine key and tell Claude; it will be stored as a network credential for the refresh environment, never in the page or repo.
8. **Player status:** Admin → Player status. Mark a player Out, Doubtful, Questionable or Not on roster when news breaks before the data updates; add the source as a note. "Clear" goes back to the data. Statuses are per week and only admins can set them.
9. **Roster check:** each refresh lists only players on their team's current active roster (nflverse weekly rosters). Players on injured reserve, practice squads, released or traded show under "Off the active roster" when you tap "Show all players".
10. **Referee assignments:** Uploads → Referee assignments (admins only). Pick each game's referee or paste lines like `BUF at NYJ: Shawn Hochuli`. Uploaded names override the NFL data; nflverse usually fills referees only after the game. Crew tendencies (flags, holding, pass-coverage flags vs league) show on each game card. They are information only: in testing they did not change player touchdown chances (docs/METHOD.md, Referees).
11. **Game-day inactives:** teams post inactives about 90 minutes before kickoff, and nflverse does not have them in time. Open the player on This week and press **Mark inactive** (admins only). He drops off the board, can't be picked, and existing picks on him settle as void.
12. **Refresh health:** Admin shows what the last refresh did (model used, pregame chances saved, any problem). If the model falls back or a download fails, everyone sees a warning banner.
13. **Friends outside your Claude organization:** today they can view but not pick, build parlays or upload. Options, in order of preference:
    - Invite them into your Claude organization (if you have a Team/Enterprise plan), then share the page with them as **Contributor**.
    - Share with them as **Editor**. Editors can pick, but they are also admins in this app (they can set player status, referees and snapshots), so only do this for people you trust.
    - Leave them as viewers: they see the board, slates and results, and you enter picks for them in your own name.
