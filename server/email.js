'use strict';

// Outgoing email through Resend (https://resend.com). Configured with
// RESEND_API_KEY and EMAIL_FROM; without a key nothing is sent and the app
// carries on. For local development, EMAIL_LOG=1 prints emails to the
// terminal instead and turns on the email features (never on Vercel).

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function createMailer({
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.EMAIL_FROM || 'Tonament <noreply@tonament.com>',
  fetchImpl = globalThis.fetch,
  logOnly = !process.env.VERCEL && process.env.EMAIL_LOG === '1',
} = {}) {
  return {
    enabled: Boolean(apiKey) || logOnly,
    async send({ to, subject, html, text }) {
      if (!apiKey) {
        if (!process.env.VERCEL) console.log(`[email ${logOnly ? 'log' : 'not configured'}] to=${to} subject="${subject}"\n${text}\n`);
        return { sent: logOnly };
      }
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text().catch(() => '')}`);
      return { sent: true };
    },
  };
}

// Brand layout (docs/BRAND.md): navy header with the white logo, mist page,
// white card, Electric Lime button with navy text. Inline styles and tables
// only, so it holds up in Gmail and Outlook. The logo is a PNG (mail apps
// don't show SVG) served from the same site the email's link points to.
const NAVY = '#0B1220';
const LIME = '#A3E635';
const SLATE = '#475569';
const FONT = "Outfit,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function layout({ heading, body, button, url, footer }) {
  let logo = '';
  try {
    logo = `${new URL(url).origin}/brand/email-logo.png`;
  } catch {
    /* no absolute link: fall back to the text logo */
  }
  const brand = logo
    ? `<img src="${esc(logo)}" width="180" height="28" alt="TONAMENT" style="display:block;border:0;height:28px;width:auto;color:#ffffff;font:700 18px ${FONT};letter-spacing:.12em">`
    : `<span style="color:#ffffff;font:700 18px ${FONT};letter-spacing:.12em">TONAMENT</span>`;
  return `<!doctype html><html><head><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;background:#E5E7EB;font-family:${FONT};color:${NAVY}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E5E7EB"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:${NAVY};padding:20px 28px;border-bottom:4px solid ${LIME}">${brand}</td></tr>
<tr><td style="padding:28px">
<h1 style="font:700 21px/1.3 ${FONT};margin:0 0 14px;color:${NAVY}">${esc(heading)}</h1>
${body.map((p) => `<p style="font:400 15px/1.55 ${FONT};margin:0 0 12px;color:${NAVY}">${p}</p>`).join('')}
<p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;background:${LIME};color:${NAVY};text-decoration:none;font:700 15px ${FONT};padding:13px 22px;border-radius:10px">${esc(button)}</a></p>
<p style="font:400 13px/1.5 ${FONT};color:${SLATE};margin:0">Or open this link: <a href="${esc(url)}" style="color:${NAVY};word-break:break-all">${esc(url)}</a></p>
${footer ? `<p style="font:400 13px/1.5 ${FONT};color:${SLATE};margin:16px 0 0">${footer}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #E5E7EB;font:600 10px/1.6 ${FONT};letter-spacing:.2em;text-transform:uppercase;color:${SLATE}">One platform. Every sport. Every tournament.</td></tr>
</table></td></tr></table></body></html>`;
}

function passwordResetEmail({ name, url }) {
  return {
    subject: 'Reset your Tonament password',
    html: layout({
      heading: 'Reset your password',
      body: [`Hi ${esc(name)},`, 'Someone (hopefully you) asked to reset the password for your Tonament account.'],
      button: 'Choose a new password',
      url,
      footer: 'This link works once and expires in 1 hour. If you didn\'t ask for this, you can ignore this email — your password won\'t change.',
    }),
    text: `Hi ${name},\n\nReset your Tonament password here (works once, expires in 1 hour):\n${url}\n\nIf you didn't ask for this, ignore this email.`,
  };
}

function inviteEmail({ inviter, tournament, roleName, roleHint, url, hasAccount }) {
  const who = inviter ? esc(inviter) : 'An organiser';
  return {
    subject: `You've been added to ${tournament} as ${roleName.toLowerCase()}`,
    html: layout({
      heading: `You're on the team for ${tournament}`,
      body: [
        `${who} added you to <strong>${esc(tournament)}</strong> as <strong>${esc(roleName.toLowerCase())}</strong> — ${esc(roleHint)}.`,
        hasAccount
          ? 'Sign in with this email address to get started.'
          : 'Create a free account with this email address and you\'ll have access straight away.',
      ],
      button: hasAccount ? 'Open the tournament' : 'Create your account',
      url,
    }),
    text: `${inviter || 'An organiser'} added you to ${tournament} as ${roleName.toLowerCase()} (${roleHint}).\n\n${hasAccount ? 'Open it' : 'Create your account with this email'}: ${url}`,
  };
}

// Receipt for a plan payment. `plan` is the plan's name ("Club"), or
// "Event Pass" for the original unlimited pass; `limit` is its entry limit.
function receiptEmail({ business, tournament, plan = 'Event Pass', limit = null, amount, currency, paymentId, paidAt, url }) {
  const item = plan === 'Event Pass' ? `Event Pass — ${tournament}` : `${plan} plan — ${tournament}`;
  const money = currency === 'INR' ? `₹${(amount / 100).toFixed(2)}` : `${(amount / 100).toFixed(2)} ${currency}`;
  const date = new Date(paidAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const rows = [
    ['Item', item],
    ['Amount paid', money],
    ['Payment ID', paymentId],
    ['Date', `${date} IST`],
    ['Paid to', business.name + (business.gstin ? ` (GSTIN ${business.gstin})` : '')],
  ];
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#475569;font-size:14px">${esc(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:14px">${esc(v)}</td></tr>`)
    .join('')}</table>`;
  return {
    subject: `Payment received — ${item}`,
    html: layout({
      heading: plan === 'Event Pass' ? 'Your Event Pass is active' : `Your ${plan} plan is active`,
      body: [`Thanks for your payment. <strong>${esc(tournament)}</strong> can now have ${limit ? `up to ${limit} entries` : 'unlimited entries'}.`, table],
      button: 'Open your tournament',
      url,
      footer: `This is your receipt. Questions or refunds: ${esc(business.email || 'reply to this email')}.`,
    }),
    text: `Payment received — ${item}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen your tournament: ${url}`,
  };
}

// To the owner, the first time a self-entry has to wait for confirmation.
function waitingEmail({ tournament, player, url }) {
  return {
    subject: `Players are waiting to enter ${tournament}`,
    html: layout({
      heading: 'Players are waiting to enter',
      body: [
        `<strong>${esc(player)}</strong> just entered <strong>${esc(tournament)}</strong>, but the tournament has reached its entry limit, so their place isn't confirmed yet.`,
        'Open the entry list to confirm or remove waiting players. If you move up to a bigger plan, everyone waiting is confirmed automatically.',
        'Unconfirmed players are not included in the draw.',
      ],
      button: 'See the entry list',
      url,
    }),
    text: `${player} just entered ${tournament}, but the tournament has reached its entry limit, so their place isn't confirmed yet.\n\nConfirm or remove waiting players (or move up a plan to confirm everyone): ${url}`,
  };
}

module.exports = { createMailer, passwordResetEmail, inviteEmail, receiptEmail, waitingEmail };
