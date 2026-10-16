'use strict';

// Sport registry. To add a sport, create a module exposing the same shape as
// badminton.js (id, name, defaults, fields, normalizeConfig, compute, summary)
// and register it here.

const badminton = require('./badminton');

const sports = new Map([[badminton.id, badminton]]);

module.exports = {
  get: (id) => sports.get(id) || null,
  list: () =>
    [...sports.values()].map(({ id, name, defaults, fields }) => ({ id, name, defaults, fields })),
};
