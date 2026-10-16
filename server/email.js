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

// Simple, client-safe layout: one column, inline styles, a single button.
function layout({ heading, body, button, url, footer }) {
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7f8;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#11181c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border:1px solid #dde3e6;border-radius:14px">
<tr><td style="padding:28px">
<div style="font-weight:800;font-size:20px;color:#0f766e;margin-bottom:20px">tonament</div>
<h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
${body.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${p}</p>`).join('')}
<p style="margin:24px 0"><a href="${esc(url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px">${esc(button)}</a></p>
<p style="font-size:13px;color:#5b676d;line-height:1.5;margin:0">Or open this link: <a href="${esc(url)}" style="color:#0f766e;word-break:break-all">${esc(url)}</a></p>
${footer ? `<p style="font-size:13px;color:#5b676d;line-height:1.5;margin:16px 0 0">${footer}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
  return html;
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

module.exports = { createMailer, passwordResetEmail, inviteEmail };
