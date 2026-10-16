'use strict';

// Vercel serverless entry point. vercel.json rewrites every /api/* request
// here; the database connection is reused across invocations of a warm
// instance.

const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let appPromise;

module.exports = async function handler(req, res) {
  appPromise ??= createDb().then(createApp).catch((err) => {
    appPromise = undefined; // retry on the next request
    throw err;
  });
  let app;
  try {
    app = await appPromise;
  } catch (err) {
    console.error(err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Database unavailable. Check DATABASE_URL in the Vercel project settings.' }));
    return;
  }
  return app.handle(req, res);
};
