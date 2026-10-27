'use strict';

// Sport registry and catalogue.
//
// Live sports have a rules module (same shape as badminton.js: id, name,
// defaults, fields, normalizeConfig, compute, summary). Everything else is
// listed so people can see what's coming and vote for it; when a sport's
// module ships, register it in MODULES and flip its status to 'live'.

const MODULES = new Map(['badminton', 'pickleball', 'table-tennis', 'squash', 'volleyball', 'beach-volleyball', 'throwball', 'sepak-takraw', 'tennis', 'padel', 'snooker', 'pool', 'carrom'].map((id) => {
  const mod = require(`./${id}`);
  return [mod.id, mod];
}));

// status: live (playable) | soon (next up) | later (planned, further out)
const CATALOGUE = [
  { id: 'badminton', name: 'Badminton', family: 'rally', status: 'live' },
  { id: 'pickleball', name: 'Pickleball', family: 'rally', status: 'live' },
  { id: 'table-tennis', name: 'Table tennis', family: 'rally', status: 'live' },
  { id: 'squash', name: 'Squash', family: 'rally', status: 'live' },
  { id: 'volleyball', name: 'Volleyball', family: 'sets', status: 'live' },
  { id: 'beach-volleyball', name: 'Beach volleyball', family: 'sets', status: 'live' },
  { id: 'throwball', name: 'Throwball', family: 'sets', status: 'live' },
  { id: 'sepak-takraw', name: 'Sepak takraw', family: 'sets', status: 'live' },
  { id: 'football', name: 'Football', family: 'goals', status: 'soon' },
  { id: 'futsal', name: 'Futsal', family: 'goals', status: 'soon' },
  { id: 'hockey', name: 'Hockey', family: 'goals', status: 'soon' },
  { id: 'kabaddi', name: 'Kabaddi', family: 'goals', status: 'soon' },
  { id: 'basketball', name: 'Basketball', family: 'goals', status: 'soon' },
  { id: 'tennis', name: 'Tennis', family: 'tennis', status: 'live' },
  { id: 'padel', name: 'Padel', family: 'tennis', status: 'live' },
  { id: 'snooker', name: 'Snooker', family: 'frames', status: 'live' },
  { id: 'pool', name: 'Pool', family: 'frames', status: 'live' },
  { id: 'carrom', name: 'Carrom', family: 'points', status: 'live' },
  { id: 'cricket', name: 'Cricket', family: 'cricket', status: 'later' },
];

for (const s of CATALOGUE) {
  if ((s.status === 'live') !== MODULES.has(s.id)) throw new Error(`Sport catalogue out of sync for ${s.id}`);
}

const { tapFor } = require('../../public/sports/rally');

module.exports = {
  tapFor,
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
