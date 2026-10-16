# Tonament

Tournament management with live scoring for **tonament.com**. Starts with badminton, and new sports can be added as plug-in modules.

## Features

- **Formats:** League + Knockout (the standard one), League only, and Knockout only.
- **Draw:** seeds are spread across groups with a snake draw. Each group plays a round-robin made with the circle method.
- **Standings:** ranked by matches won, then head-to-head (for a two-way tie), then game difference, then point difference.
- **Knockout bracket:** standard seeding. Byes go to the top seeds, and two players from the same group don't meet in the first round. Winners move to the next round automatically.
- **Live scoring:** the umpire taps the side that won each rally, on a phone or with the keyboard. Everyone else's screen updates straight away over Server-Sent Events.
- **Badminton rules:** BWF rally scoring to 21, win by 2, capped at 30. The app tracks the server and which court they serve from, and flags game point and match point. Match length (1, 3 or 5 games), points per game and the cap can be changed for club formats.
- **Undo:** works on any point, including the one that won a match. It's blocked once the next match has started.
- **Organiser access:** creating a tournament gives you a secret organiser key. Sharing the organiser link lets umpires score matches. Anyone with the public link can watch.

## Run it

You need Node.js 22.13 or later. There are no npm dependencies: the app uses Node's built-in `http`, `node:sqlite` and `node:test`.

```bash
npm start          # http://localhost:3000
npm run dev        # restarts on file changes
npm test
```

Environment variables: `PORT` (default 3000), `HOST` (default 0.0.0.0), `DB_FILE` (default `data/tonament.db`).

## Deploying to tonament.com

```bash
docker build -t tonament .
docker run -d -p 3000:3000 -v tonament-data:/data tonament
```

Put a TLS reverse proxy in front, such as Caddy (`tonament.com { reverse_proxy localhost:3000 }`) or nginx. With nginx, turn off buffering for `/api/tournaments/*/stream`. The server already sends `X-Accel-Buffering: no`, so live updates aren't held back.

The app runs as a single process with one SQLite file, which is plenty for club and district events. To run several instances you would need a shared database and a pub/sub layer (for example Postgres with LISTEN/NOTIFY, or Redis) to pass live updates between them.

## Code layout

```
server/
  index.js            HTTP server entry point
  app.js              routes, static files, SSE live stream
  service.js          tournament lifecycle: entries, draw, scoring, advancement
  formats.js          round-robin, snake groups, bracket seeding, standings (works for any sport)
  db.js               SQLite schema
  sports/badminton.js scoring rules (score = replay of the rally log)
  sports/index.js     sport registry
public/               single-page front end (plain JS, no build step)
test/                 unit and integration tests
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
| GET | `/tournaments/:id/stream` | Server-Sent Events: `match`, `tournament`, `deleted` |
