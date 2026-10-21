# Tonament

Tournament management with live scoring for **tonament.com**. Badminton, pickleball, table tennis, squash, volleyball, beach volleyball, throwball and sepak takraw today; new sports are plug-in modules.

## Features

- **Formats:** League + Knockout (the standard one), League only, and Knockout only.
- **Draw:** seeds are spread across groups with a snake draw. Each group plays a round-robin made with the circle method.
- **Standings:** ranked by matches won, then head-to-head (for a two-way tie), then game difference, then point difference.
- **Knockout bracket:** standard seeding. Byes go to the top seeds, and two players from the same group don't meet in the first round. Winners move to the next round automatically.
- **Live scoring:** the umpire taps the side that won each rally, on a phone or with the keyboard. Spectators' screens update within about 2 seconds.
- **Badminton rules:** BWF rally scoring to 21, win by 2, capped at 30. The app tracks the server and which court they serve from, and flags game point and match point. Match length (1, 3 or 5 games), points per game and the cap can be changed for club formats.
- **Pickleball rules:** traditional side-out scoring by default — only the serving side scores; in doubles both partners serve before a side-out (the first serving team starts on "0-0-2") and the scoreboard shows the score call ("4-2-1"). Organisers can switch an event to rally scoring. Games to 11 (or 15/21), win by 2, single game or best of 3/5. Level and age suggestions use skill ratings (3.0–5.0+) and 50+/60+/65+.
- **Table tennis rules:** games to 11, win by 2, best of 5 (1/3/7 too); the serve changes every 2 points and every point from 10-10.
- **Squash rules:** PAR scoring to 11 (or 15), win by 2, best of 5 (or 3); the rally winner serves.
- **Set sports** (rally scoring, win by 2, the rally winner serves, first serve alternates each set; screens say "Set"):
  - **Volleyball:** best of 5 sets to 25, deciding set to 15.
  - **Beach volleyball:** pairs; best of 3 sets to 21, deciding set to 15; "switch sides" every 7 points (5 in the deciding set).
  - **Throwball:** best of 3 sets to 25 (15/21 too).
  - **Sepak takraw:** best of 3 sets to 21, deciding set to 15.
- **Team events** (volleyball, throwball, sepak takraw): Men's / Women's / Mixed / Open Team. Entries are team names; self-entry asks for the team name, the captain's phone or email and, optionally, the players (organisers only). Each sport offers only its own event types.
- **Undo:** works on any point, including the one that won a match. It's blocked once the next match has started.
- **Entries and the event day:**
  - Players can enter themselves on the public page (name, partner, phone or email, no account needed) until a closing date/time or the draw.
  - On the day, organisers tick players as they arrive; only ticked players go into the draw, and walk-ins are added already checked in.
  - Groups are sized "about N per group" from the final head-count.
  - **Redraw** works until the first point is played.
  - Optional **late entries** after the start: a latecomer joins the smallest group with catch-up matches, or takes a bye in a knockout.
  - **Withdraw** turns a player's remaining matches into walkovers. These count as wins but not towards games or points, and a withdrawn player can't qualify for the knockout.
- **Accounts and roles:** sign up with email and password. Whoever creates a tournament is its **owner** and can add **organisers** (manage everything) and **umpires** (score matches only) by email. Someone without an account yet gets access as soon as they sign up with that email. Spectators don't need an account.
- **Venue and dates:** start date (and an optional end date), venue name, address, city, state, postcode and country. Countries and states come from a fixed list in `public/regions.js`, so filters group cleanly; there's also "Other" for any country. Players get an "Open in Google Maps" link. Venue and dates stay editable after the start.
- **Find a tournament:** the home page searches public tournaments by name or venue, sport, country → state → city, date (upcoming & live, next 7 or 30 days, past) and "open for entries". Filters live in the URL, so a search can be shared.
- **Doubles without a partner:** players can enter a doubles event alone ("find me a partner"; mixed doubles asks man or woman), and organisers pair them by hand, at random, or balanced (top seed with the lowest). An event can instead be set to **partners drawn**: everyone enters alone and pairs are drawn when it starts. In paid events a solo player pays half the pair fee.
- **Public page:** every tournament can have an About text, links (website, Instagram, WhatsApp group), a cover image and 3 photos. Any paid plan allows up to 30 photos. The Open and Championship plans (and the original Event Pass and tournaments organised by Tonament) also add organiser branding: logo, name and brand colour on the public pages, with "Powered by TONAMENT" at the bottom, plus up to 8 sponsor logos. Images are resized in the browser and stored in Postgres (`media` table), then served from `/api/media/:id` with long caching.
- **Visibility:** the owner chooses who can see a tournament. **Private** (the default for new tournaments): only the team. **Link only**: anyone with the link can view and enter, but it isn't listed. **Public**: also listed on the home page. Tournaments created before this setting existed are Public.
- **Share links:** each tournament also has a *scorer link* (scoring only) and an *organiser link* (full control) for people without an account, such as a volunteer on a borrowed phone. Tournaments created before accounts existed can be added to your account from the organiser link.
- **Site admins:** anyone whose email is listed in `ADMIN_EMAILS` can manage every tournament and see all users at `/#/admin`.

## Pricing and payments (Razorpay)

**Free** for tournaments up to 16 entries, counted across all events. Bigger tournaments buy a one-time plan for that tournament: **Club** (up to 64 entries, ₹499), **Open** (150, ₹999) or **Championship** (400, ₹1,999). Upgrading pays only the difference; tournaments that bought the original unlimited **Event Pass** keep it. Tiers live in `server/billing.js`. Payment uses Razorpay Standard Checkout (UPI, cards, netbanking, wallets):
1. The server creates an order; the amount is always set by the server.
2. Razorpay Checkout opens in the page.
3. The server verifies the payment signature, double-checks the payment with Razorpay's API, and activates the plan.
4. A receipt is emailed.
5. A webhook does the same for payments whose tab was closed early.

The limit applies only once Razorpay keys are set.

**Entry fees (tournaments organised by Tonament only).** A site admin can mark a tournament "Organised by Tonament" (Team tab, or `POST /api/admin/tournaments/:id/official`). Its events can then set an entry fee. Players pay through the same Razorpay checkout when they enter; the money goes to Tonament's account.
- **While paying,** the entry is saved as pending and holds its place for 30 minutes. It's confirmed (with an emailed receipt) by the payment check or the webhook.
- **Full paid events** don't take payments, so there's no waitlist for them.
- **Organisers** can mark walk-ins as "paid in person" or "waived".
- **Other organisers' tournaments** can't charge fees.

Players are never shown the free limit. Past it, self-entries are still accepted but saved as **unconfirmed**: the player sees "Entry received — the organiser will confirm your place", and the owner is emailed once. Unconfirmed entries aren't drawn. Moving up a plan confirms them automatically, or the organiser can confirm or remove them one by one. Organisers can also set their own **maximum entries**: players then see "N of M places left", and once it's reached new entries join a waitlist (the same unconfirmed state). A maximum above the plan's limit needs a bigger plan.

**Environment variables (Vercel → Settings → Environment Variables):**

| Name | Example | Notes |
|---|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_…` | Test keys first, live keys after activation |
| `RAZORPAY_KEY_SECRET` | | Never exposed to the browser |
| `RAZORPAY_WEBHOOK_SECRET` | | The secret you choose when adding the webhook |
| `FREE_ENTRY_LIMIT` | `16` | |
| `BUSINESS_NAME`, `BUSINESS_ADDRESS`, `BUSINESS_EMAIL`, `BUSINESS_PHONE`, `BUSINESS_GSTIN` | | Shown on /contact, the footer and receipts |

**Razorpay activation checklist:**
1. Fill in the business details above. Check `/pricing`, `/contact`, `/terms`, `/privacy`, `/refunds` and `/delivery`, and **have the policy text reviewed** (it's a starting draft).
2. Add test keys in Vercel and redeploy.
3. In the Razorpay dashboard → Webhooks, add `https://tonament.com/api/billing/razorpay/webhook` with events `payment.captured`, `order.paid` and `payment.failed`, and the same secret as `RAZORPAY_WEBHOOK_SECRET`.
4. Make a test payment. The Pass should activate, a receipt should arrive, and the webhook should show as delivered (HTTP 200) in the dashboard.
5. Submit the website for activation; once approved, switch to live keys.
6. Move Vercel to the Pro plan before taking real payments (the Hobby plan is non-commercial).

Site admins see all payments and revenue on the admin page, and can switch a tournament's Pass on or off by hand (refunds, promotions).

## Brand

The look follows the Tonament brand: Deep Navy, Electric Lime, Slate and Mist, the Outfit typeface, and the T mark with its lime dot. Dark theme is the default, with a light theme and an Auto/Dark/Light switch. The full rules are in [docs/BRAND.md](docs/BRAND.md). Logos and icons are in `public/brand/`; to rebuild them, run `python3 scripts/brand/generate_logos.py && node scripts/brand/render.js`.

## Run it locally

You need Node.js 20 or later.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test
```

To test emails locally without sending anything, run `EMAIL_LOG=1 npm start`; emails are printed in the terminal instead. You don't need to install a database to run it locally. Without `DATABASE_URL`, the app uses an embedded Postgres ([PGlite](https://pglite.dev)) and stores its files in `data/pglite`; delete that folder to start fresh. To use a real Postgres server instead, set `DATABASE_URL=postgres://…`. To run the tests against a real server, set `TEST_DATABASE_URL`.

## Deploying to Vercel

1. **Import the project.** In Vercel, choose *Add New → Project*, import `tharunjd-VS/tonament`, and keep the defaults. No build step is needed; `vercel.json` sets everything up.
2. **Add a database.** In the project, open *Storage → Create Database → Neon (Postgres)* and connect it to the project. This sets `DATABASE_URL` for you. The tables are created automatically on the first request.
3. **Make yourself site admin.** Under *Settings → Environment Variables*, add `ADMIN_EMAILS` with your email address. For several admins, separate the addresses with commas.
4. **Redeploy** so the new environment variables are picked up.
5. **Optional: turn on email** (password reset and team invites) with [Resend](https://resend.com). Verify `tonament.com` in Resend by adding its DNS records at your domain registrar, then set:
   - `RESEND_API_KEY`: a key with sending access
   - `EMAIL_FROM`: e.g. `Tonament <noreply@tonament.com>`
   - `APP_URL`: `https://tonament.com` (the base for links in emails)

   Without these the app works normally; it just doesn't send email.
6. **Add the domain.** Under *Settings → Domains*, add `tonament.com` and `www.tonament.com`, then follow the DNS instructions Vercel shows.

How it works on Vercel:
- `public/` is served as static files from Vercel's CDN.
- Every `/api/*` request is rewritten to a single function, `api/index.js`, which shares its request handler with the local server.
- **Live updates use polling.** Every viewer re-fetches the tournament every 2 seconds while a match is live (every 5 seconds otherwise). Public responses carry `s-maxage=1`, so Vercel's CDN answers most of those requests. Hundreds of spectators cost roughly one database read per second for each tournament. Organiser requests use a separate URL (`?admin=1`) and are never cached.
- **Concurrent writes are safe.** Every change locks its tournament row (`SELECT … FOR UPDATE`), so two taps arriving at once on different function instances are applied one after the other.

### Security notes
- Passwords are hashed with scrypt. Sessions are random tokens held in an `HttpOnly`, `SameSite=Lax` cookie (plus `Secure` over HTTPS), and only a SHA-256 hash of each token is stored. Sessions last 30 days.
- After 10 wrong passwords, an account is locked for 15 minutes.
- Write requests whose `Origin` is another site are rejected.
- Public tournament responses never depend on who is asking, so the CDN can't serve one person's data to someone else. Personal views use `?me=1` and are never cached.
- **Password reset:** the emailed link works once and expires after 1 hour. Only a hash of the token is stored, and the token sits in the URL fragment so it never reaches server logs. Using the link signs the account out on every other device. The "forgot password" form always gives the same reply, so it doesn't reveal which emails have accounts, and it sends at most one email per minute per account.
- Links in emails use `APP_URL` (or the project's production domain on Vercel), never the request's Host header.

### Speed
- **Scoring feels instant.** The umpire's screen applies each tap straight away, using the same rules file as the server (`public/sports/<sport>.js`), then saves it in the background. Each request says which rally count it applies to (`at`), so retries can't double-count and two devices can't overwrite each other. If the connection drops, points are kept and sent automatically when it returns.
- **Put the server next to the database.** Each saved point is one request that makes about 8 database round trips, so the Vercel function region should match the Neon region. Check it in Vercel under *Settings → Functions → Function Region*, and in Neon on the project dashboard. To pin the function region, add `"regions": ["sin1"]` (for example) to `vercel.json`. For players in India, Singapore is a good region for both (`sin1` on Vercel, `aws-ap-southeast-1` on Neon).
- **Server-Timing.** Every API response includes a `Server-Timing: app;dur=…` header. In DevTools (Network → Timing), a large gap between that number and the total request time means the time is going on the network, not on the server.
- **Neon's free plan pauses an idle database** after about 5 minutes, so the first request after a quiet spell takes about a second longer.

## Code layout

```
api/index.js          Vercel function entry point
server/
  index.js            local / self-hosted HTTP server
  app.js              routing, caching headers, static files
  service.js          tournament lifecycle and role checks: entries, draw, scoring, team
  auth.js             sign up / sign in, password hashing, sessions, password reset
  email.js            Resend sender and email templates (invites, resets, receipts)
  billing.js          Razorpay orders, signature checks, billing settings
  formats.js          round-robin, snake groups, bracket seeding, standings (works for any sport)
  db.js               Postgres (pg) or embedded PGlite, plus the schema
  sports/<sport>.js   re-exports public/sports/<sport>.js (the scoring rules, shared with the browser)
  sports/index.js     sport registry
public/               single-page front end (plain JS, no build step)
  brand/              logos, app icons, email logo, link-preview image
  fonts/              Outfit (self-hosted)
docs/BRAND.md         brand guidelines
scripts/brand/        logo generator and PNG renderer
test/                 unit and integration tests
vercel.json           Vercel config: static output and API rewrite
```

### Sports roadmap
Badminton, pickleball, table tennis, squash and the volleyball family are playable today. `server/sports/index.js` also lists the sports on the way, shown on the home page as "Soon"/"Later" chips that signed-in users can tap to request. Site admins see the totals on the admin page. Next: tennis and padel (points, games, sets and tie-breaks), then football, futsal, hockey, kabaddi and basketball (goal/point scoring with draws). Cricket comes later.

### Adding a sport

Create `public/sports/<sport>.js` with the same exports as `badminton.js` (`id`, `name`, `defaults`, `fields`, `normalizeConfig`, `compute(rallies, config, firstServer)` and `summary`), wrapped the same way so both the server and the browser can load it. Rally-scored sports can use `public/sports/rally.js`, which runs games, win-by-2 and best-of: the sport supplies only whether a rally scores and how the serve moves (see `squash.js`); set sports are a few lines with `setSport` (see `volleyball.js`). A sport's event types (singles/doubles/team) are set in `SPORT_LISTS` in `public/sports/events.js`. Add a one-line `server/sports/<sport>.js` re-export, add the id to `MODULES` in `server/sports/index.js`, set its catalogue status to `live`, and add its `<script>` tag to `public/index.html` (after `rally.js`).

## API

All endpoints are under `/api`. Permission comes from the signed-in session cookie, or from a share link sent in the `X-Admin-Key` header. Add `?me=1` to `GET /tournaments/:id` to get your role, permissions and share links.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | Accounts (session cookie) |
| POST | `/auth/forgot` `{ email }`, `/auth/reset` `{ token, password }` | Password reset by email |
| GET | `/auth/me`, `/me/tournaments` | Current user; tournaments you're on the team of |
| GET | `/admin/users` | All users (site admins only) |
| GET | `/billing/config` | Public payment settings (price, free limit, Razorpay key id, business details) |
| POST | `/tournaments/:id/checkout` `{ tier }` | Create a Razorpay order for a plan or upgrade (organisers; defaults to the next plan up) |
| POST | `/billing/razorpay/verify` | Verify a completed checkout and activate the Pass |
| POST | `/billing/razorpay/webhook` | Razorpay webhook (signature-checked against the raw body) |
| GET | `/admin/payments`; POST `/admin/tournaments/:id/plan` `{ plan }` | Payments and revenue; manual Pass on/off (site admins) |
| GET | `/sports` | Sport catalogue: playable sports (with scoring options) and upcoming ones (`status: soon / later`) |
| GET | `/sports/interest` | Request counts per upcoming sport, plus the sports you requested |
| POST | `/sports/:id/interest` `{ want }` | Request (or withdraw a request for) an upcoming sport; signed-in users, one vote each |
| GET/POST | `/tournaments` | Find public tournaments (`?q&sport&country&region&city&when=upcoming\|week\|month\|past\|any&open=1&today=YYYY-MM-DD`) / create one |
| GET | `/tournaments/places` | Countries, states and cities that have public tournaments (for the filters) |
| GET/PATCH/DELETE | `/tournaments/:id` | View / change settings (during setup) / delete |
| GET/POST | `/tournaments/:id/members` | Team list / add or change a member `{ email, role }` |
| DELETE | `/tournaments/:id/members/:memberId` | Remove a team member |
| POST | `/tournaments/:id/claim` | Add an ownerless tournament to your account (needs the organiser link) |
| POST | `/tournaments/:id/entries` | `{ names: [...], walkIn }` |
| POST | `/tournaments/:id/visibility` `{ visibility }` | `private`, `link` or `public` (owner only) |
| POST/PATCH/DELETE | `/tournaments/:id/events`, `/tournaments/:id/events/:eventId` | Add events (`{ events: [...] }`), change one (type, age, level, name, format, scoring, places, `fee`), delete one (before it starts) |
| PUT | `/tournaments/:id/events/order` `{ ids }` | Reorder events |
| POST | `/tournaments/:id/register` | Public self-entry `{ name, partner?, contact }` while entries are open; returns `confirmed: false` past the tournament's capacity |
| POST | `/tournaments/:id/entries/:entryId/fee` `{ status }` | Record an entry fee as `cash` (paid in person), `waived`, or `null` (official tournaments) |
| POST/DELETE | `/tournaments/:id/pairs` `{ a, b }`, `/tournaments/:id/pairs/draw` `{ event, balance }`, `/tournaments/:id/pairs/:entryId` | Pair two solo players, draw pairs for everyone waiting, or split a drawn pair |
| POST | `/tournaments/:id/entries/:entryId/confirm` | Confirm a waiting self-entry (within the plan's limit) |
| POST | `/tournaments/:id/entries/:entryId/check-in` `{ here }`, `/tournaments/:id/check-in-all` | Event-day check-in |
| POST | `/tournaments/:id/redraw` | Undo the draw (only before the first point) |
| POST | `/tournaments/:id/late-entry` `{ name }` | Add a player after the start (when late entries are allowed) |
| POST | `/tournaments/:id/entries/:entryId/withdraw` | Withdraw a player; remaining matches become walkovers |
| PUT | `/tournaments/:id/entries/order` | `{ ids: [...] }` sets the seeding |
| DELETE | `/tournaments/:id/entries/:entryId` | Remove an entry |
| POST | `/tournaments/:id/start` `{ skipUnconfirmed }` | Make the draw and fixtures (unconfirmed entries must be confirmed, removed, or skipped explicitly) |
| POST | `/tournaments/:id/knockout` | Draw the bracket from the group standings |
| POST | `/tournaments/:id/matches/:mid/rally` | `{ side: "a" \| "b" }` |
| POST | `/tournaments/:id/matches/:mid/undo` | Remove the last rally |
| PATCH | `/tournaments/:id/matches/:mid` | `{ court, firstServer, status: "live" }` |
