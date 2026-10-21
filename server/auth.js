'use strict';

// Accounts and sessions: email + password, hashed with scrypt; sessions are
// random tokens in an HttpOnly cookie, stored server-side only as a SHA-256 hash.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./errors');
const { passwordResetEmail } = require('./email');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'tn_session';
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const RESET_MINUTES = 60;

const fail = (status, message) => {
  throw new HttpError(status, message);
};

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// Used when the email is unknown, so a failed login takes the same time.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex')));

const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function adminEmails() {
  return new Set((process.env.ADMIN_EMAILS || '').split(',').map(normalizeEmail).filter(Boolean));
}

function userView(row) {
  return { id: row.id, email: row.email, name: row.name, isAdmin: adminEmails().has(row.email) };
}

function checkPassword(password) {
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  if (password.length > 200) fail(400, 'Password is too long');
}

function createAuth(db, { mailer } = {}) {
  function sessionCookie(req, token, maxAgeSeconds) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL;
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  async function startSession(req, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [tokenHash(token), userId],
    );
    return sessionCookie(req, token, SESSION_DAYS * 86400);
  }

  async function signup(req, input = {}) {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    if (!name || name.length > 60) fail(400, 'Enter your name (up to 60 characters)');
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    checkPassword(password);
    let row;
    try {
      [row] = await db.query(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *',
        [email, name, await hashPassword(password)],
      );
    } catch (err) {
      if (err.code === '23505') fail(409, 'An account with this email already exists. Sign in instead.');
      throw err;
    }
    return { user: userView(row), cookie: await startSession(req, row.id) };
  }

  async function login(req, input = {}) {
    const email = normalizeEmail(input.email);
    const password = typeof input.password === 'string' ? input.password : '';
    const [row] = await db.query(
      'SELECT *, (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users WHERE email = $1',
      [email],
    );
    if (!row) {
      await verifyPassword(password, await getDummyHash());
      fail(401, 'Email or password is incorrect');
    }
    if (row.locked) fail(429, `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`);
    if (!(await verifyPassword(password, row.password_hash))) {
      await db.query(
        `UPDATE users SET
           failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
           locked_until  = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END
         WHERE id = $1`,
        [row.id, MAX_FAILED_LOGINS],
      );
      fail(401, 'Email or password is incorrect');
    }
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [row.id]);
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
    return { user: userView(row), cookie: await startSession(req, row.id) };
  }

  async function logout(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE id = $1', [tokenHash(token)]);
    return sessionCookie(req, '', 0);
  }

  // Emails a one-time reset link. Always succeeds from the caller's point of
  // view, so it can't be used to find out which emails have accounts.
  async function forgotPassword(input = {}, baseUrl) {
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    const [user] = await db.query('SELECT id, name, email FROM users WHERE email = $1', [email]);
    if (!user) return;
    const [recent] = await db.query(
      `SELECT 1 FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 minute'`,
      [user.id],
    );
    if (recent) return; // one email a minute per account
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO password_resets (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${RESET_MINUTES} minutes')`,
      [tokenHash(token), user.id],
    );
    // The token travels in the URL fragment, so it never reaches server logs.
    // The token stays after the #, so it's never sent to the server or logged.
    const url = `${baseUrl}/#/reset?token=${token}`;
    try {
      await mailer?.send({ to: user.email, ...passwordResetEmail({ name: user.name, url }) });
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
  }

  // Sets a new password from a reset link, signs out every other device and
  // signs this one in.
  async function resetPassword(req, input = {}) {
    const token = typeof input.token === 'string' ? input.token : '';
    const password = typeof input.password === 'string' ? input.password : '';
    checkPassword(password);
    const hash = await hashPassword(password);
    const row = await db.tx(async (q) => {
      const [reset] = await q(
        'SELECT * FROM password_resets WHERE id = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
        [tokenHash(token)],
      );
      if (!reset) fail(400, 'This reset link is invalid or has expired. Request a new one.');
      await q('UPDATE users SET password_hash = $1, failed_logins = 0, locked_until = NULL WHERE id = $2', [hash, reset.user_id]);
      await q('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
      await q('DELETE FROM sessions WHERE user_id = $1', [reset.user_id]);
      const [user] = await q('SELECT * FROM users WHERE id = $1', [reset.user_id]);
      return user;
    });
    return { user: userView(row), cookie: await startSession(req, row.id) };
  }

  async function userFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const [row] = await db.query(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()',
      [tokenHash(token)],
    );
    return row ? userView(row) : null;
  }

  async function listUsers(actor) {
    if (!actor.user?.isAdmin) fail(403, 'Site admins only');
    const rows = await db.query(`
      SELECT u.id, u.email, u.name, u.created_at AS "createdAt",
             (SELECT COUNT(*)::int FROM members m WHERE m.email = u.email AND m.role = 'owner') AS owned,
             (SELECT COUNT(*)::int FROM members m WHERE m.email = u.email AND m.role <> 'owner') AS helping
      FROM users u ORDER BY u.created_at DESC LIMIT 500`);
    const admins = adminEmails();
    return rows.map((r) => ({ ...r, isAdmin: admins.has(r.email) }));
  }

  return { signup, login, logout, forgotPassword, resetPassword, userFromRequest, listUsers };
}

module.exports = { createAuth, normalizeEmail, validEmail, hashPassword, verifyPassword, parseCookies };
