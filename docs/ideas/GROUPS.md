# Groups: the everyday layer of Tonament (idea, not built yet)

> **Status:** concept, for discussion. Nothing here is built.
> **Started:** 22 Oct 2026, from a real problem in a daily badminton group.
>
> **Decided so far:**
> - The feature is called **Groups**.
> - Login: **email magic link + remembered device**.
> - Groups are free and private by default.
> - The next game: fair rotation with balanced teams.
> - Ranking: rating-based.
> - Scoring: any player in the game scores, and the losing side confirms.
> - Groups are created from player profiles, with invites and join requests.
> - The first version: sessions + RSVP, game queue + live scoring, leaderboard + head-to-head, and group tournaments.

## 1. The problem

Most competitive play isn't tournaments. It's the same people at the same venue every morning. Today that runs on WhatsApp and memory:

- **RSVP:** a WhatsApp poll or "+1" messages half an hour before. Someone counts, and someone forgets.
- **At the venue:** no system for who plays next. Strong players stick together, some people wait too long, and the pace drops, so "people just pair up and play".
- **Scores:** kept in heads and argued about. Nobody trusts them, so nobody records them.
- **Bragging rights:** everyone has an opinion on who's best, and no record settles it.
- **Money:** court fees and shuttles are split by hand, with "who hasn't paid?" messages.
- **Playing other groups:** friendlies with another group or club are arranged over calls, lineups on paper, results lost.

No tournament app solves this daily loop. Tournaments happen a few times a year; this happens every day. **If Tonament owns the daily loop, players open it every day, and tournaments, rankings and academy pages follow.**

## 2. The core idea: one "Group", many kinds

A **Group** is any set of people who play together. It's one building block with a kind:

| Kind | Examples | What's emphasised |
|---|---|---|
| Player group | "Velachery Morning Smashers" | Daily sessions, rotation, ladder |
| Club | A residential or members' club | Members, internal leagues, club championships |
| Academy | Coaching academy | Batches, students, coaches, progress, fees |
| Venue | Sports arena / court owner | Courts, open-play sessions, hosting groups and tournaments |
| Organisation | Company, college, apartment complex | Internal leagues, inter-department play |

- Everything a Group can do is the same underneath (members, sessions, games, ratings, tournaments, challenges). The kind only changes the defaults and which tabs show first.
- **Academy pages** (`/@slug`) become the public, paid face of a Group of kind Academy or Venue. Today's `orgs` table migrates into groups later.

People can belong to many groups: their morning group, their club and their academy batch. One login, one profile, one rating per sport.

## 3. Design principles: "easy and seamless"

1. **WhatsApp is the front door.** Every action has a link that opens straight to that action: join, RSVP, check in, score. Links preview nicely in WhatsApp. Nobody has to "open the app and find the thing".
2. **One tap per moment.** RSVP is one tap. Check-in is one tap, or a QR scan at the court. Starting the next game is one tap on a suggestion. Scoring is tapping who won the rally. Confirming is one tap, or nothing: the result confirms itself.
3. **The app does the organising.** Sessions are created from the schedule automatically. RSVP opens and closes by itself, and the waitlist moves people up by itself. The next game is suggested fairly. Ratings update by themselves.
4. **No arguments by design.** The score is live on every phone and on the court screen. The losing side confirms. Disputes go to a group admin with the full point-by-point log.
5. **Works without setup and without perfect data.** Guests and walk-ins can join a session, and point-by-point scoring is optional ("21–17" is enough).
6. **Never slower than WhatsApp.** If any flow takes longer than typing "+1" in WhatsApp, it's wrong.
7. **Privacy first.** Groups are private by default; phone numbers and emails are never shown. Junior academy members are hidden from public pages.

### The login problem (the biggest friction point)

Email + password is too slow for "tap the RSVP link at 5:30 am". Options:

| Option | Friction | Cost | Notes |
|---|---|---|---|
| Email magic link | Medium | Free | Still means switching to email |
| **Phone OTP (SMS / WhatsApp)** | **Low** | ~₹0.15–0.25 per OTP | What Indian users expect |
| **Remembered device** | **None after first time** | Free | A long-lived session on the phone; links just work |
| Guest RSVP (name only) | None | Free | Upgrade to an account later; results attach by phone |

**Decided:** an email magic link plus a long-lived remembered-device session. It's free, and after the first sign-in on a phone, links just work. Phone OTP can come later if email proves too slow. Guest RSVP is still open.

## 4. A day in a player group

| Time | What happens | Taps |
|---|---|---|
| 8 pm the evening before | Tomorrow's session (6 am, 4 courts, SDAT) opens automatically. The admin (or anyone) taps **Share on WhatsApp**. | 1 |
| Members read it | They tap the link, then **I'm in** (or **Can't make it**). After 16 (4 courts × 4) a waitlist forms; dropping out promotes the next person. | 1 |
| 5:30 am | RSVP closes (optional). "16 in, 2 on the waitlist." | 0 |
| Arriving at the venue | Players tap **I'm here**, or scan the QR code on the court post. | 1 |
| 6:00 | Courts show **Up next**: four players, teams balanced. Anyone taps **Start on Court 2**. | 1 |
| During the game | Any of the four score on their phone; everyone sees the score live. | 1 per rally |
| Game over | The losing side gets **Confirm 21–17**; it confirms itself after 10 min. Ratings move. The next four are called to the court. | 0–1 |
| Late arrival or early exit | Tap **I'm here** to join the queue; tap **Leaving** to come off it. | 1 |
| 7:30 | Session summary goes to the group: games played, top movers, best partnership, "Asha unbeaten today". It's shareable to WhatsApp. | 0 |
| Monthly | Court and shuttle cost split among the players who came, with UPI links; the admin sees who's paid. | 0–1 |

### Next-game suggestion: fair and fast

- **Who plays next:** the people who've played the fewest games this session, then whoever has waited longest. Late arrivals slot in fairly.
- **Teams:** of the three ways to split four players, take the one with the smallest rating gap, and avoid repeating today's partners.
- **Modes**, set per group:
  - balanced (default);
  - random partners;
  - winners stay on (king of the court, maximum 2 in a row);
  - fixed pairs (for a group of regular partners);
  - level courts (court 1 for the strongest).
- **Singles:** fills a court when only 2–3 people are free, if the group allows it.
- **Anyone can swap** a suggested player before starting (e.g. "Ravi's still drinking water").

## 5. Ratings: one Tonament rating, many leaderboards

- **One rating per player per sport**, split into singles and doubles. Start at 1000.
- **How it moves:** an Elo / Glicko-style calculation from every confirmed game, whether a group game, a challenge or a tournament match.
- **Glicko's advantage:** it tracks how certain a rating is. New and rarely seen players move fast; regulars move slowly.
- **Doubles:** each team is rated as the average of its two players, and both players get the change.
- **Why one global rating, not one per group:** when groups play each other (section 6), ratings must be comparable. A group's leaderboard is simply its members, ranked by the global rating.
  - Each group can also show its own view: this week, this month, wins, win % and streak.
- **The other existing systems:**
  - tournament ranking points (built) stay as they are, for "rankings";
  - the rating answers a different question: "how good are you right now?";
  - DUPR stays for pickleball players who want it.
- **Guarding against abuse:**
  - ratings only count from confirmed games;
  - results between the same few players are discounted if they're repeated very heavily;
  - admins can void a game;
  - a provisional badge shows until 10 games.

### Inside a group
- **Leaderboard:** the rating, plus this week and this month.
- **Each member's page:** form (the last 10 results), best partners, toughest rivals, head-to-head against anyone.
- **Fun stats:** longest winning streak, comeback of the week, iron player (most games played).

## 6. Groups playing groups

This is where it grows beyond a single group.

### 6a. Friendly challenge (group vs group)
- **The challenge:** Group A's admin challenges Group B with a date, venue (one side hosts), sport and format, e.g.:
  - "5 doubles rubbers, first to 3";
  - "everyone plays 2 games, total games won".
- **Captains:** B accepts. Each captain picks a lineup from their RSVP'd members; the app can suggest a balanced order.
- **On the day:** rubbers are scored live like group games. The tie score ("A leads 2–1") is on every phone and the court screen.
- **Afterwards:** the result goes on both groups' pages, and players' ratings update across groups.
- **Rematches** are one tap, and the series record is kept (e.g. "Smashers lead the series 3–2").

### 6b. Inter-group leagues
- **Setup:** a venue, academy or federation creates a league and invites groups.
- **Season:** a fixture list of ties over weeks (home and away), a standings table, captains submitting lineups, and playoffs.
- **The model:** this is the "team tie" format that corporate, college and apartment leagues already run on paper.

### 6c. Tournaments, with groups as the entry channel
- **Inviting groups:** an academy or venue running a tournament invites groups. A group admin enters players **from the roster in one tap**: names, linked accounts and partners. This fixes the re-entry problem raised about Turf Town: players are already on Tonament through their groups.
- **Group tournaments:** a group can run its own tournament in one tap from tonight's session (league or knockout, balanced pairs), using the existing tournament engine.
- **Team events:** inter-group team events in tournaments use the same team-tie format as 6b.

### 6d. Venues as hosts
- **Hosting groups:** a venue group sees which groups play there and when. Sessions at the venue appear on its page.
- **Open play:** pay-and-play sessions anyone can RSVP to. A good fit for venues and for new players looking for a group; fees by UPI or online, with Tonament's fee where online.
- **Court booking:** out of scope at first. Link to the venue's booking or WhatsApp.

## 7. Group kinds: what each one adds

| Kind | Extra on top of the core |
|---|---|
| Player group | Ladder and fun stats; session cost splitting |
| Club | Membership list, internal leagues, club championship each year, notice board |
| Academy | Batches (sessions with a coach), attendance, student progress (rating trend), parents can follow juniors, fee reminders, a public academy page (paid) |
| Venue | Courts, open-play sessions, a host calendar, the groups that play there, hosting tournaments and leagues, a public venue page (paid) |
| Organisation | Departments or teams as sub-groups, internal league, an inter-department championship |

## 8. Money (Tonament)
- **Free:**
  - groups, sessions, RSVP, scoring and ratings for player groups;
  - challenges between groups.
- **Already paid:**
  - tournaments over 16 entries (plans);
  - academy and venue public pages (₹2,999/yr).
- **New paid ideas:**
  - venue open-play with online payment (a fee per booking);
  - hosting an inter-group league (a per-season fee);
  - academy tools (batches, fees, progress) bundled with the academy page;
  - group "Pro" (custom branding on the court screen, long history exports) — later, maybe.
- **Cost splitting** is free (UPI direct to the admin), since it drives daily use.

## 9. What to build first (suggested order)

| Phase | What | Why first |
|---|---|---|
| 0 | **Email magic link + remembered device** (guest RSVP to be decided) | Without it nothing feels seamless |
| 1 | Groups (any kind), invite link and requests, schedule → sessions, RSVP and waitlist, Share on WhatsApp, check-in | Replaces the WhatsApp RSVP: a habit every day |
| 2 | Next-game suggestions, start game, live scoring by players, quick "21–17" entry, confirm/dispute, global rating, group leaderboard | Pace and no arguments: the core value |
| 3 | Court screen + QR check-in, session summary card for WhatsApp, head-to-head and stats, cost splitting | Delight and sharing (growth) |
| 4 | Group tournaments from a session; groups entering tournaments from their roster | Joins the daily loop to tournaments |
| 5 | Group vs group challenges (team ties) | Network effects between groups |
| 6 | Inter-group leagues; venue open play; academies and venues migrated into groups | Monetisation, and venues and academies as hubs |

## 10. Open questions
- **Rating:** go global from day one (recommended), or start per group?
- **Who can start games:** any checked-in member (recommended), or admins only?
- **Point-by-point vs quick result:** default per group?
- **Guests:** do guests' games count towards ratings (only once they claim an account)?
- **Group size limits:** free for any size?
- **Minors:** academy juniors' visibility and parental consent.
- **Venue tie-ins:** court booking (build or integrate)?

## 11. What's already built that this reuses
- **Scoring rules for 10 sports:** `public/sports/*.js`, `league.score`, used by server and browser. Point-by-point live scoring with an offline queue.
- **Accounts and profiles:** player profiles, handles, photos; DUPR; tournament ranking points.
- **Tournaments:** formats, team events, court scheduling, the venue display, entries linked to accounts by email.
- **Academy and venue pages:** `/@slug`, yearly payment, admin controls.
- **Payments:** Razorpay; UPI direct-to-organiser flows.
