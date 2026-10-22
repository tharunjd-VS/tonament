# Tonament: the simple, complete ecosystem (v4, 22 Oct 2026)

> The idea refined over several rounds:
> 1. everything;
> 2. sport-specific only;
> 3. four tabs;
> 4. one money primitive;
> 5. the full review in `REVIEW.md`.
>
> This file is the current answer.

## One line
**Play. Get rated. Get known. Get paid.** For every racket and court sport.

## Three things
1. **Players:** a profile and one **Tonament Rating** per sport (singles and doubles). Any player can host.
2. **Groups:** people who play together: a player group, club, academy or venue. Free; an optional paid public page (`/@slug`).
3. **Play:**
   - **Sessions** (casual, repeatable): group play, open games, coaching, "hit with me";
   - **Competitions** (structured): tournaments (built), leagues, group vs group.

## Four tabs
| Tab | What's in it |
|---|---|
| **Play** | Your sessions today (RSVP, check in, courts, up next, live score); open sessions near you at your level; your groups |
| **Compete** | Tournaments near you; leagues; challenges between groups |
| **Rankings** | Your rating and form; city / state / India ladders per sport (monthly ladder); top movers |
| **You** | Profile (rating, record, titles, badges, partners, rivals); hosting and coaching settings; **Wallet**; share cards |

## How a session works (covers 5 earlier ideas)
**A session has:**
- a host (player, group or venue);
- a time and place;
- spots;
- a level range;
- open or members-only;
- a price per spot (optional);
- rated or friendly.

| What people call it | It's a session that is… |
|---|---|
| Daily group play | members-only, repeating, rated |
| Open game | open, level range, rated |
| Coaching | hosted by a coach, "Coaching", price, few spots, friendly |
| Hit with a strong player / paid fill-in | hosted by a player, price, 1 spot, friendly (never rated) |
| Group vs group | two groups invited, rated, score by side |

**At the venue:** check in → fair next-game suggestions → any player scores live → the losing side confirms → ratings move.

## Fame (automatic)
- **The rating:** one number, verified by live scoring or opponent confirmation; provisional for the first 10 games.
- **Monthly city ladders;** titles and badges (champion, giant-killer, unbeaten month, 100 games).
- **Share cards** (free, branded) for every milestone, plus Tonament's weekly "Players to watch" on Instagram.
- **Social:** results-only. Follow, an activity strip, one-tap "Nice!". No posts, no chat (WhatsApp does that).

## Money (one primitive: pay for a spot)
- **The flow:** pay in the app (UPI / card) → held until the session or competition → released to the host's **Wallet** minus a small fee → withdraw to the bank. Built on Razorpay Route.
- **Or:** pay the host directly by UPI (free; no protection).
- **Ways to earn:**
  - hosting;
  - coaching;
  - "hit with me";
  - organising (entry fees);
  - venues and academies (sessions, pages).
- **Prizes:** shown in Tonament; paid by organisers directly in v1 (payouts via Tonament later, after tax advice).
- **Sponsorship:** an "Open to sponsors" enquiry button + sponsor logos on pages, cards and displays. A marketplace only if demand appears.
- **Never:** betting, staking, fantasy, tipping.

## How Tonament earns
| What | Price (example) |
|---|---|
| Tournaments over 16 entries | One "Pro" price per tournament (scaled by entries) |
| Group public page (academies, venues, clubs) | ₹2,999 / year (built) |
| Paid spots (sessions, coaching, hit-with-me, online entry fees) | Small % per payment |
| AI promo creatives | Credits |
| Later: brand placements on ladders and leagues | — |

## Build order (each step shippable and useful alone)
1. **Faster sign-in:** an email magic link + a remembered phone.
2. **Groups + sessions + live games + the Tonament Rating.** Dogfood with your own group every day.
3. **Fame:** monthly city ladders on the rating, titles and badges, free share cards, follow + "Nice!".
4. **Open sessions near you** (level range) + "fill this spot".
5. **Wallet:** pay for a spot (Razorpay Route), then coaching and "hit with me" as session types.
6. **Group vs group** joint sessions; leagues on the tournament engine.
7. **Simplify plans** (Free / Pro); migrate academy pages into groups.
8. **AI creatives with credits.**

**Measure:**
- weekly active players;
- rated games per week;
- share cards shared;
- open-session fill rate;
- money moved through Wallets;
- paying hosts.
