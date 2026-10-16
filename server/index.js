'use strict';

// Local / self-hosted server. On Vercel, api/index.js is used instead.

const http = require('node:http');
const { createDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

(async () => {
  const db = await createDb();
  const { handle } = createApp(db);
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    const where = process.env.DATABASE_URL ? 'Postgres (DATABASE_URL)' : 'embedded Postgres (local files)';
    console.log(`Tonament running on http://localhost:${PORT} — database: ${where}`);
  });

  const shutdown = () => server.close(async () => {
    await db.close();
    process.exit(0);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
