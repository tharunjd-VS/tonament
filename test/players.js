'use strict';

// Players enter with their account. Tests give each player a stable account
// made from the contact they enter with (phone numbers get a test email).

const crypto = require('node:crypto');

function playerFor(input = {}) {
  const contact = String(input.contact || `${input.name || 'player'}@player.test`).toLowerCase();
  const email = contact.includes('@') ? contact : `${contact.replace(/\D/g, '')}@phone.test`;
  const id = 1000000 + (crypto.createHash('sha256').update(email).digest().readUInt32BE(0) % 1000000000);
  return { user: { id, email, name: input.name || 'Player', isAdmin: false } };
}

// svc.register as that player.
const enterAs = (svc) => (id, input = {}, opts) => svc.register(id, playerFor(input), input, opts);

module.exports = { playerFor, enterAs };
