'use strict';

// Accounts and sessions: email + password, hashed with scrypt; sessions are
// random tokens in an HttpOnly cookie, stored server-side only as a SHA-256 hash.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HttpError } = require('./errors');
const { passwordResetEmail, signInLinkEmail } = require('./email');
const { normalizePhone, maskPhone } = require('./messaging');
const { cleanSource } = require('./sources');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'tn_session';
const SESSION_DAYS = 180; // phones stay signed in ("remember this device")
const LINK_MINUTES = 30;
const LINK_USES = 5; // a scanner's visit and the person's own tap (or two)
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 15;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const RESET_MINUTES = 60;
// Codes by WhatsApp or SMS (once one is switched on): 6 digits, 10 minutes,
// 5 tries; 3 codes a number per 10 minutes, 10 an address per hour.
const OTP_MINUTES = 10;
const OTP_TRIES = 5;
const OTP_PURPOSES = ['login', 'reset', 'verify'];

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

// Site admins: listed in ADMIN_EMAILS (can't be removed in the app) or made admin in the app.
function userView(row) {
  return { id: row.id, email: row.email, name: row.name, isAdmin: adminEmails().has(row.email) || Boolean(row.is_admin) };
}

function checkPassword(password) {
  if (password.length < 8) fail(400, 'Password must be at least 8 characters');
  if (password.length > 200) fail(400, 'Password is too long');
}

function createAuth(db, { mailer, messaging = null, onSignup = null } = {}) {
  // onSignup(q, user, ref): a new account (referrals.attach), in the same transaction.
  const joined = (q, row, ref) => (onSignup && ref ? onSignup(q, row, String(ref).slice(0, 40)) : null);
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
    const hash = await hashPassword(password);
    try {
      row = await db.tx(async (q) => {
        const [created] = await q('INSERT INTO users (email, name, password_hash, source) VALUES ($1, $2, $3, $4::jsonb) RETURNING *', [email, name, hash, JSON.stringify(cleanSource(input.source, input.ref))]);
        await joined(q, created, input.ref);
        return created;
      });
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
    if (row.disabled_at) fail(403, 'This account is disabled. Contact support if you think this is a mistake.');
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

  // ---------- sign in with an emailed link (no password)

  // Emails a one-time link that signs in (or creates the account). Like the
  // reset email, it never says whether the email has an account. The check
  // code is shown on screen and in the email, so people know it's theirs.
  async function requestLink(input = {}, baseUrl) {
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    const next = typeof input.next === 'string' && input.next.startsWith('/') && !input.next.startsWith('//') ? input.next.slice(0, 300) : '/';
    const [{ minute, hour }] = await db.query(
      `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS minute,
              COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour
       FROM sign_in_links WHERE email = $1`,
      [email],
    );
    if (minute >= 1 || hour >= 6) fail(429, 'We just sent you a link — check your email (and spam). You can ask again in a minute.');
    const [disabled] = await db.query('SELECT 1 FROM users WHERE email = $1 AND disabled_at IS NOT NULL', [email]);
    const code = String(crypto.randomInt(1000, 10000));
    if (disabled) return { code };
    const token = crypto.randomBytes(32).toString('base64url');
    // poll: kept by the tab that asked. When the link is opened anywhere (say,
    // in the mail app's own browser), that tab signs in too.
    const poll = crypto.randomBytes(24).toString('base64url');
    const ref = typeof input.ref === 'string' && /^[a-z0-9]{4,24}$/.test(input.ref) ? input.ref : null;
    await db.query(
      `INSERT INTO sign_in_links (id, email, next, expires_at, poll_hash, ref, source) VALUES ($1, $2, $3, now() + interval '${LINK_MINUTES} minutes', $4, $5, $6::jsonb)`,
      [tokenHash(token), email, next, tokenHash(poll), ref, input.source && typeof input.source === 'object' ? JSON.stringify(input.source) : null],
    );
    // The token stays after the #, so it's never sent to the server or logged.
    const url = `${baseUrl}/#/link?token=${token}&code=${code}`;
    try {
      if (mailer) await mailer.send({ to: email, ...signInLinkEmail({ url, code }) });
    } catch (err) {
      console.error('Sign-in link email failed:', err.message);
      fail(502, 'Couldn\'t send the email — try again, or use your password');
    }
    return { code, poll };
  }

  // The tab that asked for a link: signed in yet? Once the link has been
  // opened (on any device or browser), this tab gets its own session — once.
  async function pollLink(req, input = {}) {
    const poll = typeof input.poll === 'string' ? input.poll : '';
    if (!poll) return { waiting: true };
    const claimed = await db.tx(async (q) => {
      const [link] = await q(
        `SELECT * FROM sign_in_links WHERE poll_hash = $1 AND user_id IS NOT NULL AND claimed_at IS NULL
           AND expires_at > now() - interval '10 minutes' FOR UPDATE`, [tokenHash(poll)]);
      if (!link) return null;
      const [row] = await q('SELECT * FROM users WHERE id = $1 AND disabled_at IS NULL', [link.user_id]);
      if (!row) return null;
      await q('UPDATE sign_in_links SET claimed_at = now() WHERE id = $1', [link.id]);
      return { row, next: link.next || '/' };
    });
    if (!claimed) return { waiting: true };
    return { user: userView(claimed.row), next: claimed.next, cookie: await startSession(req, claimed.row.id) };
  }

  // Opens a link: signs in, or for a new email asks for a name first
  // ({ needsName }) and then creates the account. A link works a few times
  // until it expires: mail scanners (Outlook's Safe Links) and mail apps
  // often open it before the person taps it, and that mustn't use it up.
  async function useLink(req, input = {}) {
    const token = typeof input.token === 'string' ? input.token : '';
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    const result = await db.tx(async (q) => {
      const [link] = await q(`SELECT * FROM sign_in_links WHERE id = $1 AND uses < ${LINK_USES} AND expires_at > now() FOR UPDATE`, [tokenHash(token)]);
      if (!link) fail(400, 'This sign-in link has expired — ask for a new one');
      let [row] = await q('SELECT * FROM users WHERE email = $1', [link.email]);
      if (row && row.disabled_at) fail(403, 'This account is disabled. Contact support if you think this is a mistake.');
      if (!row) {
        if (!name) return { needsName: true, email: link.email };
        if (name.length > 60) fail(400, 'Enter your name (up to 60 characters)');
        // No password yet ("link" never matches one); they can set one with "Forgot password".
        const ref = input.ref || link.ref;
        [row] = await q('INSERT INTO users (email, name, password_hash, source) VALUES ($1, $2, $3, $4::jsonb) RETURNING *', [link.email, name, 'link', JSON.stringify(cleanSource(link.source || input.source, ref))]);
        await joined(q, row, ref);
      }
      await q('UPDATE sign_in_links SET used_at = COALESCE(used_at, now()), uses = uses + 1, user_id = $2 WHERE id = $1', [link.id, row.id]);
      await q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [row.id]);
      return { row, next: link.next || '/' };
    });
    if (result.needsName) return result;
    return { user: userView(result.row), next: result.next, cookie: await startSession(req, result.row.id) };
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
    await sendReset(user, baseUrl);
  }

  // A one-time reset link, emailed (when email is set up) and returned.
  async function sendReset(user, baseUrl) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO password_resets (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${RESET_MINUTES} minutes')`,
      [tokenHash(token), user.id],
    );
    // The token stays after the #, so it's never sent to the server or logged.
    const url = `${baseUrl}/#/reset?token=${token}`;
    let emailed = false;
    try {
      if (mailer) {
        await mailer.send({ to: user.email, ...passwordResetEmail({ name: user.name, url }) });
        emailed = Boolean(mailer.enabled);
      }
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
    return { url, emailed };
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
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now() AND u.disabled_at IS NULL',
      [tokenHash(token)],
    );
    return row ? userView(row) : null;
  }


  // ---------- codes by WhatsApp or SMS (off until a channel is switched on)

  const ipOf = (req) => String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64) || null;
  const otpHash = (target, purpose, code) => tokenHash(`${target}:${purpose}:${code}`);
  function phoneReady() {
    if (!messaging?.phoneEnabled()) fail(503, 'Phone sign-in isn\'t available yet — use your email');
  }

  // Sends a code to a phone. login and reset: only to a confirmed number, but
  // the answer is the same either way (so it can't find out whose number is
  // whose). verify: the signed-in person confirming their number.
  async function requestOtp(req, input = {}, actor = null) {
    phoneReady();
    const purpose = OTP_PURPOSES.includes(input.purpose) ? input.purpose : 'login';
    const phone = normalizePhone(input.phone);
    if (!phone) fail(400, 'Enter a mobile number, like 98765 43210');
    if (purpose === 'verify' && !actor?.user) fail(401, 'Sign in first');
    const ip = ipOf(req);
    const [{ recent, fromIp }] = await db.query(
      `SELECT COUNT(*) FILTER (WHERE target = $1 AND created_at > now() - interval '10 minutes')::int AS recent,
              COUNT(*) FILTER (WHERE ip = $2 AND created_at > now() - interval '1 hour')::int AS "fromIp"
       FROM otp_codes WHERE (target = $1 OR ip = $2) AND created_at > now() - interval '1 hour'`,
      [phone, ip],
    );
    if (recent >= 3 || (ip && fromIp >= 10)) fail(429, 'Too many codes — wait a few minutes and try again');
    const sent = { sent: true, to: maskPhone(phone), minutes: OTP_MINUTES };
    if (purpose !== 'verify') {
      const [owner] = await db.query('SELECT id FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND disabled_at IS NULL', [phone]);
      if (!owner) {
        // Recorded (with a hash no code matches) so it counts toward the limits.
        await db.query(`INSERT INTO otp_codes (target, purpose, code_hash, ip, expires_at, used_at) VALUES ($1, $2, '-', $3, now(), now())`, [phone, purpose, ip]);
        return sent;
      }
    } else {
      const [taken] = await db.query('SELECT 1 FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL AND id <> $2', [phone, actor.user.id]);
      if (taken) fail(409, 'That number is already on another account');
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.query(
      `INSERT INTO otp_codes (target, purpose, code_hash, ip, expires_at) VALUES ($1, $2, $3, $4, now() + interval '${OTP_MINUTES} minutes')`,
      [phone, purpose, otpHash(phone, purpose, code), ip],
    );
    const out = await messaging.send(db.query, {
      user: actor?.user?.id ?? null, to: { phone }, template: `otp.${purpose}`, data: { code, minutes: OTP_MINUTES },
      channels: input.channel === 'sms' ? ['sms', 'whatsapp'] : ['whatsapp', 'sms'], first: true,
    });
    if (!out.some((x) => x.status === 'sent')) fail(502, 'Couldn\'t send the code — try again in a minute');
    return { ...sent, by: out.find((x) => x.status === 'sent').channel };
  }

  // Checks a code. login: signs in. reset: a one-time reset link's token.
  // verify: the number is confirmed on the signed-in account (and, if they
  // ticked it, WhatsApp messages are turned on).
  async function verifyOtp(req, input = {}, actor = null) {
    phoneReady();
    const purpose = OTP_PURPOSES.includes(input.purpose) ? input.purpose : 'login';
    const phone = normalizePhone(input.phone);
    const code = String(input.code || '').replace(/\D/g, '');
    if (!phone || code.length !== 6) fail(400, 'Enter the 6-digit code');
    if (purpose === 'verify' && !actor?.user) fail(401, 'Sign in first');
    const ok = await db.tx(async (q) => {
      const [row] = await q(
        `SELECT * FROM otp_codes WHERE target = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() AND attempts < ${OTP_TRIES}
         ORDER BY id DESC LIMIT 1 FOR UPDATE`, [phone, purpose]);
      if (!row) return false;
      const match = crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(otpHash(phone, purpose, code)));
      await q(`UPDATE otp_codes SET attempts = attempts + 1${match ? ', used_at = now()' : ''} WHERE id = $1`, [row.id]);
      return match;
    });
    if (!ok) fail(400, 'That code isn\'t right, or it has expired — ask for a new one');
    if (purpose === 'verify') {
      await db.query(
        `UPDATE users SET phone = $2, phone_verified_at = now(), whatsapp_opt_in_at = CASE WHEN $3 THEN COALESCE(whatsapp_opt_in_at, now()) ELSE whatsapp_opt_in_at END WHERE id = $1`,
        [actor.user.id, phone, Boolean(input.whatsapp)],
      );
      return { phone: maskPhone(phone), whatsapp: Boolean(input.whatsapp) };
    }
    const [row] = await db.query('SELECT * FROM users WHERE phone = $1 AND phone_verified_at IS NOT NULL', [phone]);
    if (!row) fail(400, 'That code isn\'t right, or it has expired — ask for a new one');
    if (row.disabled_at) fail(403, 'This account is disabled. Contact support if you think this is a mistake.');
    if (purpose === 'reset') {
      const token = crypto.randomBytes(32).toString('base64url');
      await db.query(`INSERT INTO password_resets (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${RESET_MINUTES} minutes')`, [tokenHash(token), row.id]);
      return { resetToken: token };
    }
    await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [row.id]);
    return { user: userView(row), cookie: await startSession(req, row.id) };
  }

  // The signed-in person's number and WhatsApp consent.
  async function phoneSettings(actor, input = null) {
    if (!actor?.user) fail(401, 'Sign in first');
    if (input && 'whatsapp' in input) {
      await db.query(`UPDATE users SET whatsapp_opt_in_at = ${input.whatsapp ? 'COALESCE(whatsapp_opt_in_at, now())' : 'NULL'} WHERE id = $1 AND phone_verified_at IS NOT NULL`, [actor.user.id]);
    }
    if (input && input.remove) await db.query('UPDATE users SET phone = NULL, phone_verified_at = NULL, whatsapp_opt_in_at = NULL WHERE id = $1', [actor.user.id]);
    const [u] = await db.query('SELECT phone, phone_verified_at, whatsapp_opt_in_at FROM users WHERE id = $1', [actor.user.id]);
    return {
      available: Boolean(messaging?.phoneEnabled()), channels: messaging ? messaging.channels() : {},
      phone: u.phone_verified_at ? maskPhone(u.phone) : null, whatsapp: Boolean(u.whatsapp_opt_in_at),
    };
  }

  // ---------- site admin: users

  function requireAdmin(actor) {
    if (!actor.user?.isAdmin) fail(actor.user ? 403 : 401, 'Site admins only');
  }
  const log = (actor, action, target, detail) => db.query(
    'INSERT INTO admin_log (admin_email, action, target, detail) VALUES ($1, $2, $3, $4::jsonb)',
    [actor.user.email, action, target, JSON.stringify(detail || {})],
  );
  const adminRow = (r) => {
    const env = adminEmails().has(r.email);
    return { ...r, isAdmin: env || Boolean(r.isAdmin), envAdmin: env, disabled: Boolean(r.disabledAt) };
  };

  // Search by name or email, newest first, 50 at a time.
  async function listUsers(actor, { q = '', offset = 0 } = {}) {
    requireAdmin(actor);
    const term = typeof q === 'string' ? q.trim().slice(0, 80) : '';
    const rows = await db.query(`
      SELECT u.id, u.email, u.name, u.created_at AS "createdAt", u.is_admin AS "isAdmin", u.disabled_at AS "disabledAt",
             (SELECT COUNT(*)::int FROM members m WHERE m.email = u.email AND m.role = 'owner') AS owned,
             (SELECT COUNT(*)::int FROM members m WHERE m.email = u.email AND m.role <> 'owner') AS helping,
             (SELECT COUNT(*)::int FROM entries e WHERE e.user_id = u.id) AS entries,
             COUNT(*) OVER ()::int AS total
      FROM users u
      WHERE NOT u.guest AND ($1 = '' OR u.email ILIKE $2 OR u.name ILIKE $2)
      ORDER BY u.created_at DESC, u.id DESC LIMIT 50 OFFSET $3`,
    [term, `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, Math.max(0, Number(offset) || 0)]);
    return { users: rows.map(({ total, ...r }) => adminRow(r)), total: rows[0]?.total ?? 0 };
  }

  async function userById(id) {
    const [row] = await db.query('SELECT id, email, name, created_at AS "createdAt", is_admin AS "isAdmin", disabled_at AS "disabledAt" FROM users WHERE id = $1', [Number(id) || 0]);
    if (!row) fail(404, 'User not found');
    return adminRow(row);
  }

  async function setAdmin(actor, id, on) {
    requireAdmin(actor);
    const u = await userById(id);
    if (u.envAdmin) fail(409, `${u.email} is an admin through the ADMIN_EMAILS setting — remove them there`);
    if (u.id === actor.user.id && !on) fail(409, 'You can\'t remove your own admin access');
    await db.query('UPDATE users SET is_admin = $1 WHERE id = $2', [Boolean(on), u.id]);
    await log(actor, on ? 'user.admin' : 'user.unadmin', u.email);
    return userById(u.id);
  }

  // Disabling signs the person out everywhere; they can't sign in until enabled.
  async function setDisabled(actor, id, on) {
    requireAdmin(actor);
    const u = await userById(id);
    if (u.id === actor.user.id) fail(409, 'You can\'t disable your own account');
    await db.query(`UPDATE users SET disabled_at = ${on ? 'now()' : 'NULL'} WHERE id = $1`, [u.id]);
    if (on) await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    await log(actor, on ? 'user.disable' : 'user.enable', u.email);
    return userById(u.id);
  }

  async function adminResetLink(actor, id, baseUrl) {
    requireAdmin(actor);
    const u = await userById(id);
    const { url, emailed } = await sendReset(u, baseUrl);
    await log(actor, 'user.reset', u.email, { emailed });
    return { url, emailed };
  }

  // Accounts that own tournaments can't be deleted (their tournaments would be left without an owner).
  async function deleteUser(actor, id) {
    requireAdmin(actor);
    const u = await userById(id);
    if (u.id === actor.user.id) fail(409, 'You can\'t delete your own account here');
    const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM members WHERE email = $1 AND role = 'owner'`, [u.email]);
    if (n) fail(409, `${u.email} owns ${n} tournament${n === 1 ? '' : 's'} — delete or hand ${n === 1 ? 'it' : 'them'} over first`);
    await db.query('DELETE FROM users WHERE id = $1', [u.id]);
    await db.query('DELETE FROM members WHERE email = $1', [u.email]);
    await log(actor, 'user.delete', u.email, { name: u.name });
    return { ok: true };
  }

  return { signup, login, logout, requestLink, useLink, pollLink, requestOtp, verifyOtp, phoneSettings, forgotPassword, resetPassword, userFromRequest, listUsers, userById, setAdmin, setDisabled, adminResetLink, deleteUser };
}

module.exports = { createAuth, normalizeEmail, validEmail, hashPassword, verifyPassword, parseCookies };
