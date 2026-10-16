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
- **Organiser access:** creating a tournament gives you a secret organiser key. Sharing the organiser link lets umpires score matches. Anyone with the public link can watch.

## Run it locally

You need Node.js 20 or later.

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test
```

You don't need to install a database to run it locally. Without `DATABASE_URL`, the app uses an embedded Postgres ([PGlite](https://pglite.dev)) and stores its files in `data/pglite`; delete that folder to start fresh. To use a real Postgres server instead, set `DATABASE_URL=postgres://…`. To run the tests against a real server, set `TEST_DATABASE_URL`.

## Deploying to Vercel

1. **Import the project.** In Vercel, choose *Add New → Project*, import `tharunjd-VS/tonament`, and keep the defaults. No build step is needed; `vercel.json` sets everything up.
2. **Add a database.** In the project, open *Storage → Create Database → Neon (Postgres)* and connect it to the project. This sets `DATABASE_URL` for you. The tables are created automatically on the first request.
3. **Redeploy** so the new environment variable is picked up.
4. **Add the domain.** Under *Settings → Domains*, add `tonament.com` and `www.tonament.com`, then follow the DNS instructions Vercel shows.

How it works on Vercel:
- `public/` is served as static files from Vercel's CDN.
- Every `/api/*` request is rewritten to a single function, `api/index.js`, which shares its request handler with the local server.
- **Live updates use polling.** Every viewer re-fetches the tournament every 2 seconds while a match is live (every 5 seconds otherwise). Public responses carry `s-maxage=1`, so Vercel's CDN answers most of those requests. Hundreds of spectators cost roughly one database read per second for each tournament. Organiser requests use a separate URL (`?admin=1`) and are never cached.
- **Concurrent writes are safe.** Every change locks its tournament row (`SELECT … FOR UPDATE`), so two taps arriving at once on different function instances are applied one after the other.

## Code layout

```
api/index.js          Vercel function entry point
server/
  index.js            local / self-hosted HTTP server
  app.js              routing, caching headers, static files
  service.js          tournament lifecycle: entries, draw, scoring, advancement
  formats.js          round-robin, snake groups, bracket seeding, standings (works for any sport)
  db.js               Postgres (pg) or embedded PGlite, plus the schema
  sports/badminton.js scoring rules (score = replay of the rally log)
  sports/index.js     sport registry
public/               single-page front end (plain JS, no build step)
test/                 unit and integration tests
vercel.json           Vercel config: static output and API rewrite
```

### Adding a sport

Create `server/sports/<sport>.js` with the same exports as `badminton.js` (`id`, `name`, `defaults`, `fields`, `normalizeConfig`, `compute(rallies, config, firstServer)` and `summary`), then register it in `sports/index.js`. Rally-scored sports such as table tennis, volleyball, squash and pickleball fit the same model directly.

## API

All endpoints are under `/api`. Write endpoints need the `X-Admin-Key` header.

| Method | Path | Purpose |
|---|---|---|
| GET | `/sports` | Sports and their scoring options |
| GET/POST | `/tournaments` | List tournaments / create one (returns `adminKey`) |
| GET/PATCH/DELETE | `/tournaments/:id` | View / change settings (during setup) / delete |
| POST | `/tournaments/:id/entries` | `{ names: [...] }` |
| PUT | `/tournaments/:id/entries/order` | `{ ids: [...] }` sets the seeding |
| DELETE | `/tournaments/:id/entries/:entryId` | Remove an entry |
| POST | `/tournaments/:id/start` | Make the draw and fixtures |
| POST | `/tournaments/:id/knockout` | Draw the bracket from the group standings |
| POST | `/tournaments/:id/matches/:mid/rally` | `{ side: "a" \| "b" }` |
| POST | `/tournaments/:id/matches/:mid/undo` | Remove the last rally |
| PATCH | `/tournaments/:id/matches/:mid` | `{ court, firstServer, status: "live" }` |
