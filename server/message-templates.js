'use strict';

// Every message Tonament sends, by name, in each channel's form: an email
// (subject, text, html), a short text (SMS, and the fallback everywhere) and
// a WhatsApp template (Meta needs templates approved in advance: `name` is
// the approved template's name, `params` fill its {{1}}, {{2}}, … in order).
// sms: true marks the few templates worth an SMS (codes and the critical).

const { noticeEmail } = require('./email');

const TEMPLATES = {
  // A notification (🔔): the same as the inbox, with an unsubscribe link.
  notice: {
    email: (d) => noticeEmail({ title: d.title, body: d.body, url: d.url, unsubscribeUrl: d.unsubscribeUrl }),
    text: (d) => `${d.title}${d.body ? ` — ${d.body}` : ''} ${d.url}`,
    whatsapp: { name: 'tonament_notice', params: (d) => [d.title, d.body || '', d.url] },
  },
  'otp.login': {
    sms: true,
    email: (d) => noticeEmail({ title: `Your Tonament code: ${d.code}`, body: `It's good for ${d.minutes} minutes. If you didn't ask for it, ignore this.`, url: d.url || 'https://tonament.com' }),
    text: (d) => `${d.code} is your Tonament sign-in code. It's good for ${d.minutes} minutes. Don't share it.`,
    whatsapp: { name: 'tonament_otp', params: (d) => [d.code], authentication: true },
  },
  'otp.reset': {
    sms: true,
    email: (d) => noticeEmail({ title: `Your Tonament code: ${d.code}`, body: `Use it to set a new password. It's good for ${d.minutes} minutes.`, url: d.url || 'https://tonament.com' }),
    text: (d) => `${d.code} is your Tonament code to reset your password. It's good for ${d.minutes} minutes. Don't share it.`,
    whatsapp: { name: 'tonament_otp', params: (d) => [d.code], authentication: true },
  },
  'otp.verify': {
    sms: true,
    email: (d) => noticeEmail({ title: `Your Tonament code: ${d.code}`, body: `It confirms this is your number. It's good for ${d.minutes} minutes.`, url: d.url || 'https://tonament.com' }),
    text: (d) => `${d.code} is your Tonament code to confirm your number. It's good for ${d.minutes} minutes.`,
    whatsapp: { name: 'tonament_otp', params: (d) => [d.code], authentication: true },
  },
  // Sprint 2 (reminders), and later: the day before something you're in.
  'reminder.event': {
    sms: true,
    email: (d) => noticeEmail({ title: `Tomorrow: ${d.name}`, body: [d.when, d.place, d.detail].filter(Boolean).join(' · '), button: 'See the details', url: d.url, unsubscribeUrl: d.unsubscribeUrl }),
    text: (d) => `Reminder: ${d.name} — ${[d.when, d.place].filter(Boolean).join(', ')}. ${d.url}`,
    whatsapp: { name: 'tonament_reminder', params: (d) => [d.name, d.when || '', d.place || '', d.url] },
  },
  'results.out': {
    email: (d) => noticeEmail({ title: `${d.name}: results are out`, body: d.body || 'See where you finished, and share it.', button: 'See results', url: d.url, unsubscribeUrl: d.unsubscribeUrl }),
    text: (d) => `${d.name}: results are out. ${d.url}`,
    whatsapp: { name: 'tonament_results', params: (d) => [d.name, d.url] },
  },
  'invite.edition': {
    email: (d) => noticeEmail({ title: `${d.name} is back`, body: `You played last time${d.when ? ` — this time it's ${d.when}` : ''}. Entries are open.`, button: 'Enter', url: d.url, unsubscribeUrl: d.unsubscribeUrl }),
    text: (d) => `${d.name} is back${d.when ? ` on ${d.when}` : ''} — entries are open: ${d.url}`,
    whatsapp: { name: 'tonament_invite', params: (d) => [d.name, d.when || '', d.url] },
  },
  'admin.weekly': {
    email: (d) => ({ subject: d.subject, text: d.text, html: d.html }),
    text: (d) => d.short,
    whatsapp: { name: 'tonament_admin_weekly', params: (d) => [d.short] },
  },
};

module.exports = { TEMPLATES };
