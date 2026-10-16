# Tonament

Tournament management with live scoring for **tonament.com**. Starts with badminton, and new sports can be added as plug-in modules.

## Features

- **Formats:** League + Knockout (the standard one), League only, and Knockout only.
- **Draw:** seeds are spread across groups with a snake draw. Each group plays a round-robin made with the circle method.
- **Standings:** ranked by matches won, then head-to-head (for a two-way tie), then game difference, then point difference.
- **Knockout bracket:** standard seeding. Byes go to the top seeds, and two players from the same group don't meet in the first round. Winners move to the next round automatically.
- **Live scoring:** the umpire taps the side that won each rally, on a phone or with the keyboard. Spectators' screens update within about 2 seconds.
- **Badminton rules:** BWF rally scoring to 21, win by 2, capped at 30. The app tracks the server and which court they serve from, and flags game point and match point. Match length (1, 3 or 5 games), points per game and the cap can be changed for club formats.
- **Undo:** works on any point, including the one that won a match. It's blocked once the next match has started.
- **Accounts and roles:** sign up with email and password. Whoever creates a tournament is its **owner** and can add **organisers** (manage everything) and **umpires** (score matches only) by email. Someone without an account yet gets access as soon as they sign up with that email. Spectators don't need an account.
- **Share links:** each tournament also has a *scorer link* (scoring only) and an *organiser link* (full control) for people without an account, such as a volunteer on a borrowed phone. Tournaments created before accounts existed can be added to your account from the organiser link.
- **Site admins:** anyone whose email is listed in `ADMIN_EMAILS` can manage every tournament and see all users at `/#/admin`.

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
- **Scoring feels instant.** The umpire's screen applies each tap straight away, using the same rules file as the server (`public/sports/badminton.js`), then saves it in the background. Each request says which rally count it applies to (`at`), so retries can't double-count and two devices can't overwrite each other. If the connection drops, points are kept and sent automatically when it returns.
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
  email.js            Resend sender and email templates
  formats.js          round-robin, snake groups, bracket seeding, standings (works for any sport)
  db.js               Postgres (pg) or embedded PGlite, plus the schema
  sports/badminton.js re-exports public/sports/badminton.js (the scoring rules, shared with the browser)
  sports/index.js     sport registry
public/               single-page front end (plain JS, no build step)
test/                 unit and integration tests
vercel.json           Vercel config: static output and API rewrite
```

### Adding a sport

Create `server/sports/<sport>.js` with the same exports as `badminton.js` (`id`, `name`, `defaults`, `fields`, `normalizeConfig`, `compute(rallies, config, firstServer)` and `summary`), then register it in `sports/index.js`. Rally-scored sports such as table tennis, volleyball, squash and pickleball fit the same model directly.

## API

All endpoints are under `/api`. Permission comes from the signed-in session cookie, or from a share link sent in the `X-Admin-Key` header. Add `?me=1` to `GET /tournaments/:id` to get your role, permissions and share links.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | Accounts (session cookie) |
| POST | `/auth/forgot` `{ email }`, `/auth/reset` `{ token, password }` | Password reset by email |
| GET | `/auth/me`, `/me/tournaments` | Current user; tournaments you're on the team of |
| GET | `/admin/users` | All users (site admins only) |
| GET | `/sports` | Sports and their scoring options |
| GET/POST | `/tournaments` | List tournaments / create one (returns `adminKey`) |
| GET/PATCH/DELETE | `/tournaments/:id` | View / change settings (during setup) / delete |
| GET/POST | `/tournaments/:id/members` | Team list / add or change a member `{ email, role }` |
| DELETE | `/tournaments/:id/members/:memberId` | Remove a team member |
| POST | `/tournaments/:id/claim` | Add an ownerless tournament to your account (needs the organiser link) |
| POST | `/tournaments/:id/entries` | `{ names: [...] }` |
| PUT | `/tournaments/:id/entries/order` | `{ ids: [...] }` sets the seeding |
| DELETE | `/tournaments/:id/entries/:entryId` | Remove an entry |
| POST | `/tournaments/:id/start` | Make the draw and fixtures |
| POST | `/tournaments/:id/knockout` | Draw the bracket from the group standings |
| POST | `/tournaments/:id/matches/:mid/rally` | `{ side: "a" \| "b" }` |
| POST | `/tournaments/:id/matches/:mid/undo` | Remove the last rally |
| PATCH | `/tournaments/:id/matches/:mid` | `{ court, firstServer, status: "live" }` |
