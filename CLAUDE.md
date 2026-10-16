# Tonament

Tournament management with live scoring (tonament.com). Node 20+ with no build step: `server/` (HTTP + Postgres), `public/` (plain-JS single-page app), `api/index.js` (Vercel entry). See README.md.

- **Brand:** follow `docs/BRAND.md` for all UI, email and asset work. Use the CSS variables in `public/styles.css`, never raw colours. Lime is a fill (with navy text), not a text colour on light backgrounds. Font is Outfit (self-hosted).
- **Scoring rules** live in `public/sports/badminton.js` and are shared by the server and the browser. Change them in one place only.
- **Tests:** `npm test` (embedded Postgres; set `TEST_DATABASE_URL` to use a real server).
- **Run locally:** `npm start`; `EMAIL_LOG=1 npm start` prints emails to the terminal instead of sending them.
