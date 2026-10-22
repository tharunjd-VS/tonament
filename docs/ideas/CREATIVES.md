# Auto-generated promo creatives (idea, not built yet)

> **Status:** concept, for discussion. Nothing here is built.
> **Started:** 22 Oct 2026.

## The idea

Tonament already holds everything a promo needs: the tournament name, dates, venue, events, entry fee, prizes, entries, the draw, the order of play, live scores, results, champions, player photos, organiser logo and sponsors. Groups and academies will add sessions, ratings and leaderboards.

So every moment can produce a **ready-to-post image or short video for WhatsApp Status, Instagram and Facebook, in one tap**, with no Canva and no designer. The organiser, venue or group gets better promotion. Tonament gets its brand on every post.

## Is there potential? Yes, for three reasons

1. **Organisers spend real time on this today.** A typical tournament means 5–10 posters:
   - announcement;
   - "last few slots";
   - fixtures and the order of play;
   - semi-finals;
   - winners;
   - sponsor thank-yous.

   Each one is made by hand in Canva, re-typing details from a spreadsheet, usually late at night, and with typos.
2. **The data is already structured and correct.** Generic tools (Canva, Instagram templates) need every detail typed in. Sports apps handle bookings, not tournament-moment creatives (as far as I know). Generation from live data is the gap.
3. **It's free distribution.** Every shared card carries "tonament.com". Players share "I'm in the semi-final", "Champion" and "#1 in Chennai" cards, and each share reaches people who play. This is the strongest growth loop in the whole product.

## Risk of over-complicating, and how to avoid it

- **Videos come later.** Start with images: they're 80% of the value at 20% of the effort. Short videos (scores and winners animating) come after the image templates prove used.
- **No AI image generation at first.** Brand-quality templates filled with real data look professional and are always accurate. AI backgrounds can come later as an option.
- **Templates, not an editor.** Offer a few great layouts per moment with the organiser's colours, logo and sponsors, plus photo and text tweaks. A full design editor is a trap.
- **Render in the phone's browser** (canvas, then PNG; later MediaRecorder for video). This needs no heavy servers, Vercel's serverless functions can't run video rendering well anyway, and it costs nothing per creative.

## The moments (each one gets a one-tap "Share" card)

### Tournaments (organisers, academies, venues)

| Moment | Card |
|---|---|
| Entries open | Poster: name, date, venue, events, fee, prizes, "Enter at tonament.com/t/…" + QR |
| Countdown / filling up | "3 days to go", "Only 6 places left in Men's Doubles" |
| Draw made | The fixtures / group tables for an event |
| Match day | Today's order of play by court |
| Live | "Match point on Court 2", "Semi-final now live" (+ live link) |
| Results | Results of the day; a semi-final line-up |
| Champions | A winner poster per event: player photos, score, trophy, sponsor logos |
| Thank you | Sponsors and venue; "See you next year" |

### Players (personal, the viral loop)
- **Before and during:** "I'm entered in …", "Through to the quarter-finals".
- **Wins:** "Champion — Men's Doubles", "Best of 2026 · 4 titles".
- **Standings:** "#3 in Chennai, Women's Singles", "New rating high: 1,184".

### Groups (when Groups are built)
- **Sessions:** a session summary ("24 games today · Asha unbeaten · best partnership Ravi & Kiran"), "Tomorrow 6 am · 4 courts · RSVP".
- **Weekly:** the leaderboard, player of the week, a group-vs-group result.

### Academies and venues
- **Academies:** admissions open, new batch timings, coaching programmes, student achievements ("3 of our players in the district final").
- **Venues:** open-play slots this week, upcoming tournaments here, the hall of champions.

## Formats
- **Images:** Story (1080×1920), Square (1080×1080) and Landscape (1200×630, which is also the link preview).
- **Later, videos:** 10–20 s of motion templates, e.g. a score ticker, a winners reveal, "this week at the venue". Rendered in the browser to MP4 or WebM, with music added by the user in Instagram or WhatsApp.

## Revenue: yes, it makes Tonament a revenue platform for organisers

- **For organisers, venues and academies:**
  - **Sponsor inventory:** sponsor logos on every creative (announcement, fixtures, live, winners) give organisers something concrete to sell to sponsors ("your logo on 15 posts and the venue screen").
  - **Fuller tournaments:** better promotion means more entries, which means more entry-fee revenue.
  - **Academies:** admissions and achievement posts bring in students.
- **For Tonament:**

  | Tier | Creatives |
  |---|---|
  | Free | All creatives with Tonament branding and a QR code |
  | Open / Championship plans and academy / venue pages | Their own logo, colours and sponsor logos; Tonament shrinks to a small "Powered by" |
  | Possible add-on (later) | A "Promo pack" per tournament, e.g. ₹299: video creatives, a sponsor slide, scheduled posting reminders |

  This strengthens the paid plans rather than needing a new product.

## What's already built that this reuses
- **Link previews:** the tournament share image, 1200×630 from the cover (`prepareImage(…, 'preview')`).
- **Branding:** plans with branding (logo, colours, sponsors), the white-label venue display and the brand assets (`docs/BRAND.md`).
- **Data:** live tournament data (`GET /api/tournaments/:id`), profiles, ranking points and the DUPR rating.
- **Earlier experiments:** the hand-made promo images and the 30 s video from 22 Oct 2026 show the look. They were made with the same approach (HTML templates rendered in a browser).

## Suggested order
1. **Image cards for organisers (5 templates):**
   - Entries open;
   - Filling up;
   - Order of play;
   - Results / semi-finals;
   - Champions.

   Each gets a "Share" button on the right tab, three sizes, organiser branding on paid plans, and a QR code.
2. **Player cards:** entered, through to round X, champion, ranking. This is the viral loop.
3. **Groups, academy and venue cards** (with Groups).
4. **Short video templates** (winners reveal, live score ticker).
5. **Optional:** a promo pack add-on and scheduled reminders ("post the fixtures today").

## Open questions
- Should creatives be free for everyone with Tonament branding, or locked behind a plan?
- Do players need consent before their photo is used in a winners poster? (Probably: use profile photos only if the profile is public.)
- Do we need regional languages (Tamil, Hindi, …) for poster text?
- Should we add AI-generated backgrounds or captions later?
