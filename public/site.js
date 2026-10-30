'use strict';

// Fills business details, price and limits on the static pages (pricing,
// contact, policies) from the server's billing settings.
(function () {
  // The service worker (public/sw.js): the site and the installed app open offline.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
  // An invite link (?ref=code) is remembered for the sign-up, as in the app.
  var ref = new URLSearchParams(location.search).get('ref');
  if (ref && /^[a-z0-9]{4,24}$/.test(ref)) {
    try { localStorage.setItem('tonament:ref', JSON.stringify({ code: ref, at: Date.now() })); } catch (e) { /* this visit only */ }
  }
  // Follow buttons on server-made pages (a player's profile, a club's page):
  // the count and your state come from the API, so the page itself can be cached.
  document.querySelectorAll('[data-follow]').forEach(function (btn) {
    var kind = btn.getAttribute('data-follow');
    var id = btn.getAttribute('data-id');
    var show = function (s) {
      btn.textContent = s.following ? 'Following ✓' : 'Follow';
      btn.classList.toggle('btn-primary', !s.following);
      btn.setAttribute('aria-pressed', String(s.following));
      var count = document.querySelector('[data-followers="' + kind + ':' + id + '"]');
      if (count) count.textContent = s.followers ? s.followers + (s.followers === 1 ? ' follower' : ' followers') : '';
      btn.hidden = false;
    };
    var state = { following: false, followers: 0 };
    fetch('/api/follow?kind=' + kind + '&id=' + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : state; }).then(function (s) { state = s; show(s); }).catch(function () { show(state); });
    btn.addEventListener('click', function () {
      fetch('/api/follow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: kind, id: id, on: !state.following }) })
        .then(function (r) {
          if (r.status === 401) { location.href = '/signin?next=' + encodeURIComponent(location.pathname); return null; }
          return r.ok ? r.json() : null;
        })
        .then(function (s) { if (s) { state = s; show(s); } });
    });
  });
  // Share buttons: the phone's share menu, else copy the link.
  document.querySelectorAll('[data-share]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-share');
      if (navigator.share) { navigator.share({ title: btn.getAttribute('data-title') || document.title, url: url }).catch(function () {}); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { btn.textContent = 'Link copied ✓'; });
      else window.prompt('Copy this link:', url);
    });
  });
  var year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
  fetch('/api/billing/config')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg) return;
      var biz = cfg.business || {};
      document.querySelectorAll('[data-biz]').forEach(function (el) {
        var value = biz[el.getAttribute('data-biz')];
        if (!value) return;
        el.textContent = value;
        var link = el.getAttribute('data-biz-link');
        if (link === 'mailto') el.href = 'mailto:' + value;
        if (link === 'tel') el.href = 'tel:' + value.replace(/[^\d+]/g, '');
      });
      if (!biz.gstin) document.querySelectorAll('[data-biz-row="gstin"]').forEach(function (el) { el.hidden = true; });
      var rupees = '₹' + Math.round(cfg.price / 100);
      document.querySelectorAll('[data-price]').forEach(function (el) { el.textContent = rupees; });
      document.querySelectorAll('[data-free-limit]').forEach(function (el) { el.textContent = String(cfg.freeLimit); });
      var tiers = {};
      (cfg.tiers || []).forEach(function (t) { tiers[t.id] = t; });
      var inr = function (paise) { return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 }); };
      document.querySelectorAll('[data-tier-price]').forEach(function (el) {
        var t = tiers[el.getAttribute('data-tier-price')];
        if (t) el.textContent = inr(t.price);
      });
      document.querySelectorAll('[data-tier-limit]').forEach(function (el) {
        var t = tiers[el.getAttribute('data-tier-limit')];
        if (t) el.textContent = String(t.limit);
      });
      document.querySelectorAll('[data-ai-price]').forEach(function (el) {
        var p = (cfg.aiPrices || {})[el.getAttribute('data-ai-price')];
        if (p) el.textContent = inr(p);
      });
      if (cfg.orgPrice) document.querySelectorAll('[data-org-price]').forEach(function (el) { el.textContent = inr(cfg.orgPrice); });
      document.querySelectorAll('[data-org-branding]').forEach(function (el) { el.hidden = !cfg.orgIncludesBranding; });
      document.querySelectorAll('[data-tier-diff]').forEach(function (el) {
        var ids = el.getAttribute('data-tier-diff').split(':');
        if (tiers[ids[0]] && tiers[ids[1]]) el.textContent = inr(tiers[ids[1]].price - tiers[ids[0]].price);
      });
    })
    .catch(function () { /* keep the defaults written in the page */ });
})();
