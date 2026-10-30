# Strategy: Tonament Court Kit — the standard way venues run their courts

Status: **strategy, not built.** Builds on the tap-in station and wrist
remote in [clicker-nfc.md](clicker-nfc.md) (design, parts and costs).

The idea: the hardware that makes group games effortless — tap a tag to join
a side, press a wrist button to score — is also what every venue with courts
is missing. If a player's tag works at every venue, Tonament becomes the
standard way courts are run, not just one more app.

## 1. Why venues would care: their problems, not ours
- **Idle and mis-used courts.** Venues see bookings, not actual play. Booked-but-empty courts and walk-in peaks are invisible.
- **Pay-and-play leakage.** Who actually played, for how long, and did they pay? Staff count heads by hand.
- **Members drift away.** Casual players stop coming when there's nothing to come back for: no ladder, no rating, no community.
- **Running events takes staff time.** Tournaments and leagues mean paper draws and WhatsApp chaos.
- **Their TV screens earn nothing.** Screens show cricket; they could show live courts and sponsors.

## 2. The offer: the "Tonament Court Kit"
For each court: the tap-in station and the wrist remote. For the venue: a TV display and a venue dashboard. For the players: tags.

What the venue gets:
- **Live courts:** who is on which court, the score and time played, on the TV and on members' phones ("Court 3 is free").
- **Automatic attendance and pay-per-play:** a tap means someone played. Billing can follow taps (per game or per hour), with no headcounts.
- **A venue ladder and ratings:** every game a member plays counts, so members come back. Venue leaderboards on the TV.
- **One-tap events:** the tournament and league features they already have, with the courts already wired in.
- **A utilisation dashboard:** busy hours, idle courts, regulars and lapsed members. This is data venues have never had.

## 3. How it becomes a standard: the moat
- **One tag, every venue.** A player's tag (and rating) works at every Tonament venue. Players start asking venues for it, which pulls new venues in. That's the network effect.
- **City rankings across venues.** These already exist in Tonament (rankings by city and sport); the hardware feeds them with real play, not just tournaments.
- **Inter-venue leagues.** Venue against venue, which only works when everyone is on the same system.
- **Branded tags.** Wristbands and stickers with the venue's and Tonament's logos. Players keep them, and they're cheap.

## 4. How it makes money
Ranges in the doc are starting points for the founder to test.
- **Venue subscription, hardware included:** about Rs 499–999 per court per month (versus a station's parts cost of about Rs 3,000–4,700 at prototype). Hardware is lent, not sold, so there's a low upfront cost for the venue and recurring revenue for Tonament.
- **Tag sales:** venues resell tags or wristbands to players at Rs 49–149; parts cost Rs 10–120. The venue keeps a margin, so it's motivated to push tags.
- **Screen sponsorship:** sponsor slots on the venue TV (local brands, sports shops), shared with the venue.
- **Existing revenue continues:** tournament plans, AI credits, academy pages.

## 5. Partners, not rivals
- Booking apps (Playo, Hudle and others) own court bookings. Tonament owns **what happens on the court**.
- Position it as a complement. Later, the bookings could sync, so a booked court lights up on the station.
- Don't build bookings.

## 6. Test it cheaply first, before any hardware money
- **Phase 0, 2–4 weeks: phone stand-in.** An Android phone or tablet at the court acts as the station (Web NFC plus big A and B buttons). Use Rs 15 stickers and off-the-shelf Rs 200 selfie remotes for scoring. Run it in the founder's own group, then at 1–2 friendly venues.
  - Measure: the share of games tapped in, the share scored to the end, and whether players keep doing it after week 2.
- **Phase 1, about 8 weeks: pilot.** 3 venues in Chennai, 2–4 courts each, with hand-built stations (about Rs 10–15k per venue in parts).
  - Measure: games recorded per court per day, staff time saved, member return rate, and whether the venue would pay.
- **Phase 2: case study and pricing.** One page per pilot venue with real numbers. Then set the price, and find a contract manufacturer for a batch of 50–100 stations.
- **Decision gates.** Phase 0 → 1 only if more than 60% of games get tapped in without reminders. Phase 1 → 2 only if at least 2 of 3 venues agree to pay.

## 7. Avoiding drift
- Keep the core focus: hardware is a front end for what Tonament already does (games, ratings, events).
- Don't build manufacturing, logistics or repairs in-house. Partner for those.
- Software comes first: build the phone stand-in, the venue dashboard and the venue ladder before buying any custom hardware.

## 8. Risks
- **Hardware operations:** damage, theft and dead batteries. Mitigate with fixed mains-powered stations, cheap swappable parts and a spare per venue.
- **Adoption:** players forget tags. The "open spot, claim later" fallback handles it, and venues hand out wristbands at the desk.
- **Price sensitivity in Indian venues:** the subscription must pay for itself through pay-per-play leakage saved, or members kept.
- **Booking apps** adding similar features: move fast on the network effect (one tag everywhere).
- **Founder bandwidth:** this is a second product. Phases 0–1 must stay small.

## 9. Next steps for the founder
1. Pick 3 friendly venues in Chennai.
2. Approve building the phone stand-in (a software-only first step, which I can build).
3. Order 50 NTAG213 stickers and 2 selfie remotes (about Rs 1,000) to run Phase 0 in the founder's group.
