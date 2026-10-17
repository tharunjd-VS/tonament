'use strict';

// Fills business details, price and limits on the static pages (pricing,
// contact, policies) from the server's billing settings.
(function () {
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
    })
    .catch(function () { /* keep the defaults written in the page */ });
})();
