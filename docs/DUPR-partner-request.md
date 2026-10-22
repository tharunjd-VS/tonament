# DUPR partner API request

Send to DUPR's partnerships team (ask your DUPR club account manager for the
right address, or use the contact form on dupr.com/club-resources).

---

**Subject:** Partner API access for Tonament — tournament software in India

Hello DUPR team,

I run **Tonament** (https://tonament.com), tournament software for racket and
court sports in India. Organisers use it to take entries online, make draws
(league, knockout, league + knockout), run the order of play across courts
and score every point live from umpires' phones. Players follow live scores
and have profiles with their results and rankings.

Pickleball is one of our core sports: side-out and rally scoring are built in,
and events can be split by DUPR level (3.0, 3.5, 4.0 …).

**What we'd like to do with the DUPR API**

1. **Verify players** — a player connects their DUPR ID in their Tonament
   profile; we read their doubles and singles ratings to show on entry lists,
   to seed draws and to check rating limits for level events.
2. **Submit results** — when a match finishes on Tonament, send the score
   (game by game) to DUPR, only when every player in the match has connected
   a verified DUPR ID. Organisers can switch this off per tournament.

**Where we are today**

- Players already add their DUPR ID and ratings (marked "self-reported").
- Organisers can require DUPR IDs, set rating limits, seed by DUPR and
  download results in your club match-upload format.
- The API integration is built and tested against a mock, switched off until
  we have partner credentials.

**Data handling**

- We send only what a match needs: DUPR IDs, the event name, date, venue and
  game scores.
- Players opt in by connecting their own DUPR ID; they can disconnect at any
  time.
- Results are sent once per match (idempotent by our match id), with retries
  and an admin log of every submission.

**Volume** — <fill in: tournaments a month, pickleball matches a month, cities>.

Could you share the partner onboarding steps, API documentation and sandbox
credentials? Happy to do a call or demo.

Thanks,
<your name>
Tonament — https://tonament.com
<phone> · <email>
