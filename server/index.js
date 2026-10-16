'use strict';

const http = require('node:http');
const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'tonament.db');

const db = openDb(DB_FILE);
const { handle } = createApp(db);
const server = http.createServer(handle);

server.listen(PORT, HOST, () => {
  console.log(`Tonament running on http://localhost:${PORT} (db: ${DB_FILE})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  server.closeAllConnections(); // drop open live-score streams
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
