'use strict';

// Messages to people, by channel: email (Resend, server/email.js), WhatsApp
// and SMS. Every message is a named template (server/message-templates.js),
// so a channel can be switched on later without touching the code that sends.
//
// WhatsApp and SMS are off until their environment variables are set:
//   WHATSAPP_PROVIDER=meta     WHATSAPP_TOKEN, WHATSAPP_PHONE_ID (Meta Cloud API)
//   WHATSAPP_PROVIDER=gupshup  WHATSAPP_TOKEN (API key), WHATSAPP_SENDER, WHATSAPP_APP
//   WHATSAPP_LANG              the templates' language code (default en)
//   SMS_PROVIDER=msg91         SMS_KEY (auth key), SMS_SENDER, SMS_TEMPLATES
//                              (JSON: template name to DLT template id)
//   SMS_PROVIDER=twilio        SMS_KEY ("account SID:auth token"), SMS_SENDER
//   MESSAGING_DAILY_CAP        WhatsApp and SMS messages a day, each (default 500)
//   MESSAGING_LOG=1            print WhatsApp and SMS instead of sending (not on Vercel)
//
// The rules: WhatsApp only to people who opted in (codes they asked for
// aside), SMS only for templates marked sms (codes, reminders), and a failed
// send never breaks whatever sent it. Every send is logged in message_log.

const { TEMPLATES } = require('./message-templates');

const CHANNELS = ['email', 'whatsapp', 'sms'];
// Rough costs in paise for the funnel (Meta's India rates, and DLT SMS).
const COST = { email: 0, whatsapp: { authentication: 12, utility: 12, marketing: 80 }, sms: 25 };
const DEFAULT_CAP = 500;

// A phone number as E.164 (+919876543210), Indian numbers by default; or null.
function normalizePhone(input, country = '91') {
  let s = String(input || '').replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    if (/^0\d{10}$/.test(s)) s = s.slice(1);
    if (/^[6-9]\d{9}$/.test(s)) s = `+${country}${s}`;
    else if (/^91[6-9]\d{9}$/.test(s)) s = `+${s}`;
    else return null;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
const maskPhone = (p) => (p ? `${p.slice(0, -7).replace(/\d/g, '•')}${'•'.repeat(3)}${p.slice(-4)}` : '');

// ---------- channel adapters: { name, enabled, send({ to, template, data }) -> { id } }

function emailAdapter(mailer) {
  return {
    name: 'resend',
    enabled: Boolean(mailer && mailer.enabled),
    async send({ to, template, data }) {
      await mailer.send({ to, ...template.email(data) });
      return { id: null };
    },
  };
}

function logAdapter(channel) {
  return {
    name: 'log',
    enabled: true,
    async send({ to, template, data, name }) {
      const body = channel === 'whatsapp' ? `${template.whatsapp.name}(${template.whatsapp.params(data).join(' | ')})` : template.text(data);
      console.log(`[${channel} log] to=${to} ${name}\n${body}\n`);
      return { id: null };
    },
  };
}

function whatsappAdapter(env, fetchImpl) {
  const provider = env.WHATSAPP_PROVIDER;
  const lang = env.WHATSAPP_LANG || 'en';
  if (provider === 'meta' && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
    return {
      name: 'meta',
      enabled: true,
      async send({ to, template, data }) {
        const w = template.whatsapp;
        const params = w.params(data).map((text) => ({ type: 'text', text: String(text).slice(0, 1000) }));
        const components = [{ type: 'body', parameters: params }];
        // Authentication templates carry the code on their copy-code button too.
        if (w.authentication) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [params[0]] });
        const res = await fetchImpl(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template', template: { name: w.name, language: { code: lang }, components } }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${out.error?.message || ''}`);
        return { id: out.messages?.[0]?.id || null };
      },
    };
  }
  if (provider === 'gupshup' && env.WHATSAPP_TOKEN && env.WHATSAPP_SENDER) {
    return {
      name: 'gupshup',
      enabled: true,
      async send({ to, template, data }) {
        const w = template.whatsapp;
        const form = new URLSearchParams({
          channel: 'whatsapp', source: env.WHATSAPP_SENDER, destination: to.replace(/^\+/, ''), 'src.name': env.WHATSAPP_APP || 'tonament',
          template: JSON.stringify({ id: w.name, params: w.params(data).map(String) }),
        });
        const res = await fetchImpl('https://api.gupshup.io/wa/api/v1/template/msg', {
          method: 'POST', headers: { apikey: env.WHATSAPP_TOKEN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.status === 'error') throw new Error(`WhatsApp ${res.status}: ${out.message || ''}`);
        return { id: out.messageId || null };
      },
    };
  }
  return null;
}

function smsAdapter(env, fetchImpl) {
  const provider = env.SMS_PROVIDER;
  if (provider === 'msg91' && env.SMS_KEY) {
    let ids = {};
    try { ids = JSON.parse(env.SMS_TEMPLATES || '{}'); } catch { /* none */ }
    return {
      name: 'msg91',
      enabled: true,
      async send({ to, template, data, name }) {
        // India's DLT rules: every SMS is a registered template, by id.
        if (!ids[name]) throw new Error(`No DLT template id for ${name} (SMS_TEMPLATES)`);
        const vars = Object.fromEntries((template.whatsapp?.params(data) || [template.text(data)]).map((v, i) => [`var${i + 1}`, String(v)]));
        const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
          method: 'POST',
          headers: { authkey: env.SMS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_id: ids[name], sender: env.SMS_SENDER, short_url: '0', recipients: [{ mobiles: to.replace(/^\+/, ''), ...vars }] }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || out.type === 'error') throw new Error(`SMS ${res.status}: ${out.message || ''}`);
        return { id: out.message || out.request_id || null };
      },
    };
  }
  if (provider === 'twilio' && env.SMS_KEY && env.SMS_SENDER) {
    const [sid, token] = env.SMS_KEY.split(':');
    return {
      name: 'twilio',
      enabled: true,
      async send({ to, template, data }) {
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: to, From: env.SMS_SENDER, Body: template.text(data) }).toString(),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`SMS ${res.status}: ${out.message || ''}`);
        return { id: out.sid || null };
      },
    };
  }
  return null;
}

// ---------- the messenger

function createMessaging({ db, mailer = null, env = process.env, fetchImpl = globalThis.fetch, adapters = {} }) {
  const logOnly = !env.VERCEL && env.MESSAGING_LOG === '1';
  const channel = {
    email: adapters.email || (mailer && mailer.enabled ? emailAdapter(mailer) : null),
    whatsapp: adapters.whatsapp || whatsappAdapter(env, fetchImpl) || (logOnly ? logAdapter('whatsapp') : null),
    sms: adapters.sms || smsAdapter(env, fetchImpl) || (logOnly ? logAdapter('sms') : null),
  };
  const cap = Number(env.MESSAGING_DAILY_CAP) || DEFAULT_CAP;
  const enabled = (c) => Boolean(channel[c] && channel[c].enabled);
  const pending = new Set();

  async function sentToday(q, c) {
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM message_log WHERE channel = $1 AND status = 'sent' AND created_at >= date_trunc('day', now())`, [c],
    );
    return n;
  }
  // Logged outside the caller's transaction when there is one (so a slow
  // provider never holds it open), else straight away.
  function record(q, row) {
    const write = db.query(
      `INSERT INTO message_log (user_id, channel, template, provider, recipient, provider_id, status, error, cost_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.user ?? null, row.channel, row.template, row.provider ?? null, row.recipient ?? null, row.providerId ?? null, row.status, row.error ? String(row.error).slice(0, 300) : null, row.cost || 0],
    ).catch((err) => console.error('message_log:', err.message));
    if (q === db.query) return write;
    pending.add(write);
    write.finally(() => pending.delete(write));
    return null;
  }

  // Send `template` to a person (user: an id or a users row) or an address
  // (to: { email, phone }) on `channels`, in that order; first: stop at the
  // first that works (a code by WhatsApp, else by SMS). Never throws; returns
  // [{ channel, status, error? }].
  async function send(q, { user = null, to = {}, template: name, data = {}, channels = ['email'], first = false, optedIn = false }) {
    const template = TEMPLATES[name];
    if (!template) throw new Error(`Unknown message template ${name}`);
    const out = [];
    try {
      let person = user;
      if (Number.isInteger(user)) [person] = await q('SELECT id, email, phone, phone_verified_at, whatsapp_opt_in_at FROM users WHERE id = $1 AND disabled_at IS NULL', [user]);
      if (user && !person) return out;
      const address = {
        email: to.email || person?.email || null,
        phone: to.phone || (person?.phone_verified_at ? person.phone : null),
      };
      for (const c of channels.filter((x) => CHANNELS.includes(x))) {
        const skip = (reason) => out.push({ channel: c, status: 'skipped', error: reason });
        if (!enabled(c)) { skip('off'); continue; }
        const recipient = c === 'email' ? address.email : address.phone;
        if (!recipient) { skip('no address'); continue; }
        if (c === 'sms' && !template.sms) { skip('not an SMS template'); continue; }
        if (c === 'whatsapp' && !template.whatsapp.authentication && !optedIn && !person?.whatsapp_opt_in_at) { skip('not opted in'); continue; }
        if (c !== 'email' && await sentToday(q, c) >= cap) {
          skip('daily cap');
          record(q, { user: person?.id, channel: c, template: name, recipient, status: 'skipped', error: 'daily cap' });
          continue;
        }
        const adapter = channel[c];
        try {
          const { id } = await adapter.send({ to: recipient, template, data, name });
          const cost = c === 'whatsapp' ? COST.whatsapp[template.whatsapp.authentication ? 'authentication' : 'utility'] : COST[c];
          await record(q, { user: person?.id, channel: c, template: name, provider: adapter.name, recipient, providerId: id, status: 'sent', cost: adapter.name === 'log' ? 0 : cost });
          out.push({ channel: c, status: 'sent' });
          if (first) break;
        } catch (err) {
          console.error(`Message (${c} ${name}):`, err.message);
          await record(q, { user: person?.id, channel: c, template: name, provider: adapter.name, recipient, status: 'failed', error: err.message });
          out.push({ channel: c, status: 'failed', error: err.message });
        }
      }
    } catch (err) {
      console.error(`Message (${name}):`, err.message);
    }
    return out;
  }

  return {
    send,
    enabled,
    // The channels that are on, for settings pages (and phone sign-in).
    channels: () => Object.fromEntries(CHANNELS.map((c) => [c, enabled(c)])),
    phoneEnabled: () => enabled('whatsapp') || enabled('sms'),
    // Wait for log writes made inside transactions (tests, and the end of a job).
    flush: () => Promise.allSettled([...pending]),
  };
}

module.exports = { createMessaging, normalizePhone, maskPhone, CHANNELS };
