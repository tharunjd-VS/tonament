# Review of every idea, and how to simplify it (22 Oct 2026)

**The test:** for each person involved, is it easy to start, easy to use every time, and obviously worth it?

**Who's involved:**
- players;
- hosts (group admins, organisers);
- venues;
- academies and coaches;
- brands;
- **Tonament itself** (a tiny team: everything must be cheap to build, run and support).

---

## Part 1: what's built today

| Feature | Verdict | Problem | Simplify to |
|---|---|---|---|
| Tournaments (formats, 10 sports, live scoring, courts, venue display) | **Keep, it's strong** | None for players. For organisers there are many settings, already tamed by the setup checklist | Keep. Add "Start from a previous tournament" (copy everything) |
| Plans: Free / Club / Open / Championship (+ the old Event Pass) | **Simplify** | Four tiers + branding rules + a legacy pass = decisions and support questions | **Free up to 16 entries; then one "Pro" price per tournament that scales with entries.** All paid tournaments get branding. Event Pass stays honoured, never shown |
| Branding switch + per-academy override (admin) | **Simplify** | Three ways to get branding | Branding comes with **any paid plan or a paid group page**. Remove the switch once groups exist |
| Academy / venue pages (`/@slug`, ₹2,999/yr) | **Merge** | A separate concept from groups, so two places to manage people and tournaments | **Becomes a Group with a paid public page** (section 2). Existing pages migrate automatically |
| Tournament ranking points | **Replace** | A second number next to a rating confuses people; points only come from tournaments, so they're empty for most players | **One Tonament Rating** (below). Keep **titles** (champion, runner-up) as badges. Rankings = rating leaderboards |
| DUPR (ID, self-reported ratings, CSV, API ready) | **Keep, small** | None, it's a checkbox | Leave as is; it shows only for pickleball |
| Profiles `/p/handle` | **Keep** | Thin until people have results | Fill them with daily games (Groups) |
| Entry fees: UPI-direct or online | **Keep for now** | Two modes to explain | Later the Wallet makes "online" the easy default, and UPI-direct stays as the free option |
| Admin dashboard | **Keep** | — | — |

## Part 2: the new ideas

| Idea | Verdict | Simplify to |
|---|---|---|
| **Groups** (sessions, RSVP, rotation, live scoring, rating) | **Core**: the daily habit | A Group = people + a schedule. The kind (player group / club / academy / venue) is just a label that changes defaults. No sub-groups, no roles beyond admin/member |
| Group kinds with different tabs | **Cut** | Same screens for all kinds. Venues and academies just tend to switch on the paid public page |
| **Open games near you** | **Merge** | Not a separate thing: **a session marked "Open"** (anyone at the right level can join), shown under "Near you" |
| **Coaching** | **Merge** | **A session hosted by a player with "Coaching" ticked**, a price and one or a few spots. No separate booking system |
| **Paid to play / hitting partner / fill-in** | **Merge** | **A session hosted by a player with a price and 1 spot** ("Hit with me, ₹300/hr"). Friendly: it doesn't change ratings. "Fill this spot" = an open session that's one short |
| **Rating leagues** (UTR-style) | **Simplify** | No league admin at all: an **automatic monthly ladder** per city and sport from the rating. Real leagues = the existing tournament engine with a "League over weeks" schedule, later |
| **Group vs group challenges** | **Simplify** | **A joint session**: two groups, one session, games mix players from both sides; the score counts games won per side. No lineups or captains in v1 |
| **Inter-group leagues** | **Later** | Built from challenges + the tournament engine once there are many groups |
| **Social feed / posts / chat** | **Cut** | **Results-only:** follow, an activity strip, one-tap "Nice!". Chat stays on WhatsApp |
| **Fame** (rankings, badges, spotlights, share cards) | **Keep, make automatic** | All generated from data; nobody has to post anything |
| **AI creatives with credits** | **Keep, later** | Free auto share cards first (needed for growth); AI posters with credits after the daily loop works |
| **Wallet + earning** (prizes, coaching, hosting, sponsorship, paid play) | **Simplify to one primitive** | **Every money flow is "pay for a spot"** in a session or competition; the host gets paid. Prizes and sponsorship are the only special cases (below) |
| **Sponsorship marketplace** | **Simplify a lot** | v1: an **"Open to sponsors" button** that sends the brand's enquiry to the player, group or organiser (no escrow or deliverables tracking). Sponsor logos on pages, cards and displays (already built). A marketplace only if demand shows up |
| **Prize payouts via Tonament** | **Later, carefully** | Holding prize money adds tax and compliance work (TDS and GST on payouts: get a CA's advice). v1: organisers pay prizes themselves; Tonament just shows the winners and prizes (built) |
| Court booking | **Cut** | Link to the venue or Playo |
| Betting, staking, fantasy, tipping | **Never** | Illegal or risky under the Online Gaming Act 2025 |
| Native mobile app | **Not yet** | The web app + "Add to home screen" + WhatsApp links. A native app only when the habit is proven |

## Part 3: the simplification
Everything above collapses into **three things**:

1. **Players:** one profile and one rating per sport. Any player can host.
2. **Groups:** people who play together (a player group, club, academy or venue).
3. **Play:**
   - **Sessions** (casual and repeatable: a group's daily play, an open game, coaching, a hit with a strong player);
   - **Competitions** (structured: tournament, league, challenge).

**Money:** a session or competition can have a **price per spot**. It's paid in the app and goes to the host's Wallet, minus a small fee (or is paid by UPI directly to the host, free).

**Fame:** all automatic from results: the rating, city ladders, titles, badges, share cards, spotlights.

**Easy for everyone** (the target number of taps, the value, the cost):

| Who | Does | Gets | Pays |
|---|---|---|---|
| Player | Tap a link → I'm in → I'm here → tap points | A rating, rankings, a profile, games at their level, earnings if they host or coach | Nothing (spot prices set by hosts) |
| Group admin | Create a group once (schedule, courts); share the link | No more counting RSVPs, fair games, no score fights, fees collected | Nothing |
| Organiser | Create a tournament in 3 steps (or copy last year's) | Entries, draws, live scores, display, promotion | Free ≤16; Pro per tournament |
| Venue / academy | Make a group, switch on the public page | Filled courts, students, a page that ranks on Google, branding | The yearly page fee |
| Coach / strong player | Tick "Coaching" or "Hit with me", set a price | Bookings + payouts; their rating is their credential | A small fee per paid spot |
| Brand | Tap "Open to sponsors" | Reach by city, sport and level | Deals off-platform at first |
| Tonament | Builds 3 objects + 1 payment flow | Revenue from Pro tournaments, pages, spot fees, credits | — |

## Part 4: how easy it is for Tonament to build and run

**Reuse what exists:**
- the scoring engine, live updates, offline queue;
- profiles, payments, the admin dashboard, the pages system.

**Avoid what's expensive to run:**
- moderating user posts;
- chat;
- native apps;
- court-booking integrations;
- holding prize money;
- a sponsorship escrow.

**Money:**
- **Razorpay Route** (linked accounts; Razorpay does the KYC) for paying hosts.
- **One flow:** pay for a spot → hold until the session → release.
- **Refunds:** one rule (cancel ≥ 6 h before) and the existing admin refunds screen.

**Notifications:**
- WhatsApp share links (free) + email.
- Web push later (iPhone needs the app added to the home screen).
- The WhatsApp Business API only when revenue justifies its cost.

## Part 5: what to change in the current app (when we build)
1. **Plans:** Free ≤16 / Pro (one tier, price by entries). Hide the Event Pass.
2. **Rankings:**
   - switch to the rating (once Groups produce games);
   - keep titles as badges;
   - migrate ranking points into a "Titles & results" section of the profile.
3. **Academy pages → Groups with a public page;** keep the `/@slug` URLs.
4. **The branding switch and per-academy override:** remove after the merge.
