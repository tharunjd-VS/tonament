'use strict';

// Outgoing email through Resend (https://resend.com). Configured with
// RESEND_API_KEY, EMAIL_FROM and EMAIL_REPLY_TO (an inbox someone reads:
// replies there help deliverability); without a key nothing is sent and the app
// carries on. For local development, EMAIL_LOG=1 prints emails to the
// terminal instead and turns on the email features (never on Vercel).

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function createMailer({
  apiKey = process.env.RESEND_API_KEY,
  from = process.env.EMAIL_FROM || 'Tonament <noreply@tonament.com>',
  replyTo = process.env.EMAIL_REPLY_TO || null,
  fetchImpl = globalThis.fetch,
  logOnly = !process.env.VERCEL && process.env.EMAIL_LOG === '1',
} = {}) {
  return {
    enabled: Boolean(apiKey) || logOnly,
    configured: Boolean(apiKey),
    from,
    replyTo,
    // headers: extra email headers (e.g. List-Unsubscribe on notifications).
    async send({ to, subject, html, text, headers }) {
      if (!apiKey) {
        if (!process.env.VERCEL) console.log(`[email ${logOnly ? 'log' : 'not configured'}] to=${to} subject="${subject}"\n${text}\n`);
        return { sent: logOnly };
      }
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo && { reply_to: replyTo }), ...(headers && { headers }) }),
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

// preheader: the line inboxes show after the subject (hidden in the email).
function layout({ heading, body, button, url, footer, preheader }) {
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader || String(body[0] || heading).replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&'))}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
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

function signInLinkEmail({ url, code }) {
  return {
    subject: `Sign in to Tonament (${code})`,
    html: layout({
      heading: 'Sign in to Tonament',
      body: ['Tap the button to sign in. This phone or computer stays signed in, so you won\'t need to do this again.', `Check code: <strong>${esc(code)}</strong> — it should match the one on your screen.`],
      button: 'Sign in',
      url,
      footer: 'This link works once and expires in 30 minutes. If you didn\'t ask for it, ignore this email.',
    }),
    text: `Sign in to Tonament (check code ${code}):\n${url}\n\nThe link works once and expires in 30 minutes. If you didn't ask for it, ignore this email.`,
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
// The yearly academy / venue page payment.
function orgReceiptEmail({ business, org, until, amount, currency, paymentId, paidAt, url }) {
  const item = `Page for one year — ${org}`;
  const money = currency === 'INR' ? `₹${(amount / 100).toFixed(2)}` : `${(amount / 100).toFixed(2)} ${currency}`;
  const date = new Date(paidAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const live = new Date(until).toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' });
  const rows = [['Item', item], ['Amount paid', money], ['Payment ID', paymentId], ['Date', `${date} IST`], ['Live until', live],
    ['Paid to', business.name + (business.gstin ? ` (GSTIN ${business.gstin})` : '')]];
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#475569;font-size:14px">${esc(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:14px">${esc(v)}</td></tr>`)
    .join('')}</table>`;
  return {
    subject: `Payment received — ${item}`,
    html: layout({
      heading: 'Your page is live',
      body: [`Thanks for your payment. <strong>${esc(org)}</strong> is live on Tonament until ${esc(live)}.`, table],
      button: 'Open your page',
      url,
      footer: `This is your receipt. Questions or refunds: ${esc(business.email || 'reply to this email')}.`,
    }),
    text: `Payment received — ${item}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen your page: ${url}`,
  };
}

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

// Receipt for an entry fee (tournaments organised by Tonament).
function entryReceiptEmail({ business, tournament, event, player, amount, currency, paymentId, paidAt, url }) {
  const money = currency === 'INR' ? `₹${(amount / 100).toFixed(2)}` : `${(amount / 100).toFixed(2)} ${currency}`;
  const date = new Date(paidAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
  const rows = [
    ['Item', `Entry fee — ${event}`],
    ['Tournament', tournament],
    ['Entry', player],
    ['Amount paid', money],
    ['Payment ID', paymentId],
    ['Date', `${date} IST`],
    ['Paid to', business.name + (business.gstin ? ` (GSTIN ${business.gstin})` : '')],
  ];
  const table = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#475569;font-size:14px">${esc(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:14px">${esc(v)}</td></tr>`)
    .join('')}</table>`;
  return {
    subject: `You're entered — ${event}, ${tournament}`,
    html: layout({
      heading: 'You\'re entered',
      body: [`Thanks for your payment. <strong>${esc(player)}</strong> is entered in <strong>${esc(event)}</strong> at ${esc(tournament)}.`, table],
      button: 'See the tournament',
      url,
      footer: `This is your receipt. Questions or refunds: ${esc(business.email || 'reply to this email')}.`,
    }),
    text: `You're entered — ${event}, ${tournament}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nSee the tournament: ${url}`,
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

// To a player, when the organiser confirms their entry fee arrived.
function feeReceivedEmail({ tournament, event, player, url }) {
  const what = event ? `${tournament} (${event})` : tournament;
  return {
    subject: `You're in: ${tournament}`,
    html: layout({
      heading: 'Payment received — you\'re in',
      body: [`The organiser has confirmed your entry fee for <strong>${esc(what)}</strong>. <strong>${esc(player)}</strong> is on the entry list. See you on the day!`],
      button: 'See the tournament',
      url,
    }),
    text: `The organiser has confirmed your entry fee for ${what}. ${player} is on the entry list. See you on the day!\n\n${url}`,
  };
}

// To a player, when the organiser couldn't find their payment.
function feeMissingEmail({ tournament, event, url }) {
  const what = event ? `${tournament} (${event})` : tournament;
  return {
    subject: `Please check your payment for ${tournament}`,
    html: layout({
      heading: 'We couldn\'t find your payment',
      body: [
        `The organiser of <strong>${esc(what)}</strong> hasn't received your entry fee yet.`,
        'Please check the payment in your UPI app (the amount and the UPI ID), then open the tournament to pay again or add the UPI reference. Questions? Contact the organiser.',
      ],
      button: 'Open the tournament',
      url,
    }),
    text: `The organiser of ${what} hasn't received your entry fee yet. Please check the payment in your UPI app, then open the tournament to pay again or add the UPI reference: ${url}`,
  };
}

// To a doubles partner, when someone enters them with their email.
function partnerEmail({ player, tournament, event, url, hasAccount }) {
  const what = event ? `${tournament} (${event})` : tournament;
  return {
    subject: `${player} entered you in ${tournament}`,
    html: layout({
      heading: 'You\'re in a doubles entry',
      body: [
        `<strong>${esc(player)}</strong> entered you as their partner in <strong>${esc(what)}</strong>.`,
        hasAccount
          ? 'It\'s on your Tonament profile, and your results and ranking points will be added there too.'
          : 'Sign up with this email address to see it on your Tonament profile and collect your results and ranking points.',
      ],
      button: hasAccount ? 'See the tournament' : 'Sign up free',
      url,
    }),
    text: `${player} entered you as their partner in ${what}.\n\n${hasAccount ? 'See it' : 'Sign up with this email to collect your results and ranking points'}: ${url}`,
  };
}

// The inviter's reward: a friend they invited ran their first tournament.
function referralEarnedEmail({ name, friend, milestone, pages = [], url }) {
  const extra = [
    milestone ? 'That makes 3 friends — so there\'s an <strong>Open upgrade</strong> (150 entries) for you as well.' : null,
    pages.length ? `And ${esc(pages.join(', '))} gets a month more on Tonament.` : null,
  ].filter(Boolean);
  return {
    subject: `${friend} ran their first tournament — you've earned a free upgrade`,
    html: layout({
      heading: 'You\'ve earned a free upgrade',
      body: [
        `Hi ${esc(name)}, <strong>${esc(friend)}</strong> joined Tonament through your invite and has just run their first tournament.`,
        'As a thank-you, you have a <strong>free Club upgrade</strong> (up to 64 entries) for any tournament of yours — use it from the tournament\'s Players tab whenever you need it.',
        ...extra,
      ],
      button: 'See your invites',
      url,
    }),
    text: `Hi ${name}, ${friend} joined Tonament through your invite and has just run their first tournament. You have a free Club upgrade (up to 64 entries) for any tournament of yours.${milestone ? ' That makes 3 friends, so there is an Open upgrade for you as well.' : ''}${pages.length ? ` ${pages.join(', ')} gets a month more on Tonament.` : ''}\n\n${url}`,
  };
}

// A notification by email (the important ones), with a way to stop them.
function noticeEmail({ title, body, button = 'Open Tonament', url, unsubscribeUrl }) {
  return {
    subject: title,
    html: layout({
      heading: title,
      body: body ? [esc(body)] : [],
      button,
      url,
      footer: unsubscribeUrl ? `Don't want these emails? <a href="${esc(unsubscribeUrl)}" style="color:${NAVY}">Turn them off</a>.` : null,
    }),
    text: `${title}${body ? `\n\n${body}` : ''}\n\n${url}${unsubscribeUrl ? `\n\nTurn these emails off: ${unsubscribeUrl}` : ''}`,
    // One-click unsubscribe (RFC 8058), which Gmail and Yahoo expect on notifications.
    ...(unsubscribeUrl && { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
  };
}

// Admins check delivery (e.g. with mail-tester.com): a sign-in-style email.
function testEmail({ url }) {
  return {
    subject: 'Tonament test email',
    html: layout({
      heading: 'Your test email arrived',
      body: ['This is how Tonament\'s sign-in emails look. If this landed in spam, check the domain settings in Resend (SPF, DKIM, DMARC) and turn off click tracking.'],
      button: 'Open Tonament',
      url,
      footer: 'Sent from Admin › Settings › Email.',
    }),
    text: `Your test email arrived. This is how Tonament's sign-in emails look.\n\n${url}`,
  };
}

// The admins' Monday summary: rows of [label, this week, last week].
function adminWeeklyEmail({ rows, notes = [], url }) {
  const cell = `font:400 14px ${FONT};color:${NAVY};padding:6px 0;border-bottom:1px solid #E5E7EB`;
  const num = `${cell};text-align:right;font-weight:700`;
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="${cell};color:${SLATE}"></td><td style="${num};color:${SLATE};font-weight:600">This week</td><td style="${num};color:${SLATE};font-weight:600">Last week</td></tr>
${rows.map(([label, now, before]) => `<tr><td style="${cell}">${esc(label)}</td><td style="${num}">${esc(String(now))}</td><td style="${num};color:${SLATE};font-weight:400">${esc(String(before))}</td></tr>`).join('\n')}
</table>`;
  const short = rows.slice(0, 3).map(([label, now, before]) => `${label} ${now} (${before})`).join(', ');
  return {
    subject: `Tonament this week: ${short}`,
    html: layout({ heading: 'Tonament this week', body: [table, ...notes.map(esc)], button: 'Open the funnel', url }),
    text: `Tonament this week (last week in brackets)\n\n${rows.map(([label, now, before]) => `${label}: ${now} (${before})`).join('\n')}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n\n${url}`,
    short,
  };
}

module.exports = {
  testEmail, adminWeeklyEmail, noticeEmail, referralEarnedEmail, createMailer, passwordResetEmail, signInLinkEmail, inviteEmail, receiptEmail, orgReceiptEmail, entryReceiptEmail, waitingEmail, feeReceivedEmail, feeMissingEmail, partnerEmail };
