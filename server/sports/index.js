'use strict';

// Sport registry and catalogue.
//
// Live sports have a rules module (same shape as badminton.js: id, name,
// defaults, fields, normalizeConfig, compute, summary). Everything else is
// listed so people can see what's coming and vote for it; when a sport's
// module ships, register it in MODULES and flip its status to 'live'.

const MODULES = new Map(['badminton', 'pickleball', 'table-tennis', 'squash'].map((id) => {
  const mod = require(`./${id}`);
  return [mod.id, mod];
}));

// status: live (playable) | soon (next up) | later (planned, further out)
const CATALOGUE = [
  { id: 'badminton', name: 'Badminton', family: 'rally', status: 'live' },
  { id: 'pickleball', name: 'Pickleball', family: 'rally', status: 'live' },
  { id: 'table-tennis', name: 'Table tennis', family: 'rally', status: 'live' },
  { id: 'squash', name: 'Squash', family: 'rally', status: 'live' },
  { id: 'volleyball', name: 'Volleyball', family: 'rally', status: 'soon' },
  { id: 'throwball', name: 'Throwball', family: 'rally', status: 'soon' },
  { id: 'football', name: 'Football', family: 'goals', status: 'soon' },
  { id: 'futsal', name: 'Futsal', family: 'goals', status: 'soon' },
  { id: 'hockey', name: 'Hockey', family: 'goals', status: 'soon' },
  { id: 'kabaddi', name: 'Kabaddi', family: 'goals', status: 'soon' },
  { id: 'basketball', name: 'Basketball', family: 'goals', status: 'soon' },
  { id: 'tennis', name: 'Tennis', family: 'tennis', status: 'later' },
  { id: 'padel', name: 'Padel', family: 'tennis', status: 'later' },
  { id: 'cricket', name: 'Cricket', family: 'cricket', status: 'later' },
];

for (const s of CATALOGUE) {
  if ((s.status === 'live') !== MODULES.has(s.id)) throw new Error(`Sport catalogue out of sync for ${s.id}`);
}

module.exports = {
  // Only playable sports have rules.
  get: (id) => MODULES.get(id) || null,
  // Catalogue entry for any listed sport (live or not).
  info: (id) => CATALOGUE.find((s) => s.id === id) || null,
  list: () =>
    CATALOGUE.map((s) => {
      const mod = MODULES.get(s.id);
      return mod ? { ...s, defaults: mod.defaults, fields: mod.fields } : { ...s };
    }),
};
