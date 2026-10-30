'use strict';

// Where people come from: the first touch the app saw in this browser (kept
// for 60 days, see firstTouch in public/app.js), cleaned and put in a class:
//   referral  a friend's invite link (?ref=)
//   shared    a link someone shared from Tonament (?s=wa, ig, copy, …)
//   campaign  a link with utm_ tags (a poster, a mailing, an ad)
//   social    from a social app (by utm_medium, or the referring site)
//   search    from a search engine
//   web       from any other site
//   direct    typed in, a bookmark, or nothing to go on

const CLASSES = ['referral', 'shared', 'campaign', 'social', 'search', 'web', 'direct'];
const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|yandex|baidu)\./;
const SOCIAL = /(^|\.)(facebook|fb|instagram|whatsapp|wa|t|x|twitter|linkedin|youtube|reddit|threads|telegram|snapchat|pinterest)\.(com|me|co|net|org)$|^l\.facebook\.com$|^lm\.facebook\.com$/;
const SOCIAL_WORDS = /^(social|whatsapp|wa|instagram|ig|facebook|fb|twitter|x|linkedin|youtube|telegram|story|reel|post|dm)$/i;
const OWN = /(^|\.)tonament\.com$|^localhost$|^127\.0\.0\.1$/;

const str = (v, n = 60) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, n) : null);
const hostOf = (v) => {
  if (typeof v !== 'string' || !v) return null;
  try {
    return new URL(v.includes('://') ? v : `https://${v}`).hostname.replace(/^www\./, '').toLowerCase().slice(0, 80);
  } catch {
    return null;
  }
};

// input: { utm_source, utm_medium, utm_campaign, s, referrer, landing, at }
// (anything else is dropped); ref: a referral code, if there was one.
function cleanSource(input, ref = null) {
  const i = input && typeof input === 'object' ? input : {};
  const out = {
    source: str(i.utm_source), medium: str(i.utm_medium), campaign: str(i.utm_campaign, 80),
    s: str(i.s, 20), referrer: hostOf(i.referrer), landing: typeof i.landing === 'string' && i.landing.startsWith('/') ? i.landing.slice(0, 120) : null,
  };
  if (out.referrer && OWN.test(out.referrer)) out.referrer = null;
  const at = Date.parse(i.at);
  if (Number.isFinite(at) && at <= Date.now() + 60000) out.at = new Date(at).toISOString();
  out.class = classify(out, ref);
  if (ref) out.ref = String(ref).slice(0, 40);
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

function classify(x, ref) {
  if (ref) return 'referral';
  if (x.s) return 'shared';
  if (x.source || x.medium || x.campaign) {
    if ((x.medium && SOCIAL_WORDS.test(x.medium)) || (x.source && SOCIAL_WORDS.test(x.source))) return 'social';
    return 'campaign';
  }
  if (x.referrer) {
    if (SEARCH.test(x.referrer)) return 'search';
    if (SOCIAL.test(x.referrer)) return 'social';
    return 'web';
  }
  return 'direct';
}

// A short label for one source, for the admin's table ("whatsapp", "google.com", …).
const sourceLabel = (src) => (src ? src.source || (src.s && `shared · ${src.s}`) || src.referrer || (src.ref && 'invite link') || 'direct' : 'unknown');

module.exports = { cleanSource, classify, sourceLabel, CLASSES };
