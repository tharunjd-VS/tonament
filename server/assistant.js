'use strict';

// The on-the-day assistant: the organiser says what's happening ("Ravi and
// Kiran just arrived", "walk-in pair Asha / Eva for WD, paid cash", a photo
// of the paper sign-up sheet) and Claude turns it into proposals from a
// fixed list of the app's own actions. Nothing changes until the organiser
// approves; then each approved action runs through the same service
// functions as the buttons, with every rule they enforce.
//
// Guardrails: a fixed list of actions (no deleting, no redrawing, no
// scores, no refunds, no messaging players); where a latecomer goes and
// whether a walkover is due come from the published late-arrival policy
// (latecomers.js), never from Claude; Claude sees names (to match what it's
// told) and statuses, never phones, emails or clubs, and is told not to
// infer anything from names; proposals are checked against the tournament
// as it is, and refused at approval if it has changed since (stale); every
// approved change is logged (ai_actions). Spends on-the-day credits.

const crypto = require('node:crypto');
const { COSTS } = require('./credits');

const TYPES = ['check_in', 'not_here', 'here', 'arrived', 'add_entry', 'mark_paid', 'walkover'];
const SYSTEM = `You help a tournament organiser on the day. They tell you what is happening (typed, dictated, a forwarded message or a photo of a paper list). Turn it into actions from this list only:
- check_in: a player or pair is here, before the draw (entryId)
- arrived: a player or pair who missed the draw is here now (entryId)
- not_here: a player is late for their match (entryId)
- here: a player marked late is back (entryId)
- add_entry: a new player, pair or team to add (eventId, name — a pair as "First / Second")
- mark_paid: an entry's fee was paid (entryId, paidHow: cash or upi)
- walkover: a player never came to their match (matchId, entryId of the one who didn't come)
Use the ids from the tournament below. If a name could be more than one entry, or matches none, or the event is unclear, don't guess: add a question instead. Never decide which group anyone goes in, who wins, seeds or levels — the app decides those by the organiser's published rules. Don't infer anything about people from their names. Put the words each action came from in "quote". "summary" is one short sentence of what you understood.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['actions', 'questions', 'summary'],
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'entryId', 'eventId', 'name', 'paidHow', 'matchId', 'quote'],
        properties: {
          type: { type: 'string', enum: TYPES },
          entryId: { type: ['integer', 'null'] },
          eventId: { type: ['integer', 'null'] },
          name: { type: ['string', 'null'] },
          paidHow: { anyOf: [{ type: 'string', enum: ['cash', 'upi'] }, { type: 'null' }] },
          matchId: { type: ['integer', 'null'] },
          quote: { type: 'string' },
        },
      },
    },
    questions: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
};

function createAssistant({ db, fail, ai, svc }) {
  // A fingerprint of everything an action depends on: if it changes between
  // proposal and approval, the proposal is stale.
  async function version(id) {
    const [r] = await db.query(
      `SELECT md5(COALESCE((SELECT string_agg(concat_ws(',', id, event_id, checked_in, in_draw, away_since, withdrawn, fee_status, group_no), ';' ORDER BY id) FROM entries WHERE tournament_id = $1), '')
              || '|' || COALESCE((SELECT string_agg(concat_ws(',', id, status, a_id, b_id, winner_id), ';' ORDER BY id) FROM matches WHERE tournament_id = $1), '')
              || '|' || (SELECT string_agg(concat_ws(',', id, status), ';' ORDER BY id) FROM events WHERE tournament_id = $1)) AS v`,
      [String(id)],
    );
    return r.v;
  }

  // What Claude sees: events, entries (names and statuses only) and the matches waiting on someone late.
  function context(t) {
    const lines = [`Tournament: ${t.name} (${t.sport.name})`];
    for (const ev of t.events) {
      lines.push(`Event ${ev.id}: ${ev.name} — ${ev.status === 'setup' ? 'before the draw' : ev.status === 'completed' ? 'finished' : 'under way'}${ev.fee ? ', has an entry fee' : ''}`);
      for (const e of ev.entries) {
        const flags = [e.withdrawn ? 'withdrew' : null, e.confirmed ? null : 'not confirmed', ev.status === 'setup' ? (e.checkedIn ? 'checked in' : 'not checked in') : (e.inDraw ? 'in the draw' : 'missed the draw'),
          e.awaySince ? 'marked late' : null, ev.fee ? (['received', 'cash', 'waived', 'paid'].includes(e.feeStatus) ? 'paid' : 'fee due') : null].filter(Boolean);
        lines.push(`  Entry ${e.id}: ${e.name} (${flags.join(', ')})`);
      }
      const late = new Set(ev.entries.filter((e) => e.awaySince).map((e) => e.id));
      for (const m of (ev.matches || []).filter((x) => x.status === 'scheduled' && x.a && x.b && (late.has(x.a.id) || late.has(x.b.id)))) {
        lines.push(`  Match ${m.id}: ${m.a.name} (entry ${m.a.id}) v ${m.b.name} (entry ${m.b.id}), waiting`);
      }
    }
    return lines.join('\n');
  }

  // One action, checked against the tournament as it is: what it would do, and whether it can.
  async function preview(t, a, actor) {
    const evOf = (eid) => t.events.find((ev) => ev.entries.some((e) => e.id === eid));
    const entryOf = (eid) => { const ev = evOf(eid); return ev ? ev.entries.find((e) => e.id === eid) : null; };
    const no = (why) => ({ allowed: false, why });
    const e = a.entryId ? entryOf(a.entryId) : null;
    const ev = e ? evOf(a.entryId) : null;
    const who = e ? e.name : a.name;
    switch (a.type) {
      case 'check_in':
        if (!e) return no('Not one of the entries');
        if (ev.status !== 'setup') return preview(t, { ...a, type: 'arrived' }, actor);
        if (!e.confirmed || e.withdrawn) return no(`${who} isn't a confirmed entry`);
        return e.checkedIn ? no(`${who} is already checked in`) : { allowed: true, label: `Check in ${who}`, effect: `${ev.name} · goes into the draw` };
      case 'arrived': {
        if (!e) return no('Not one of the entries');
        if (ev.status === 'setup') return { ...(await preview(t, { ...a, type: 'check_in' }, actor)), type: 'check_in' };
        if (ev.status === 'completed') return no(`${ev.name} has finished`);
        if (e.inDraw) return no(`${who} is already in the draw`);
        const o = await svc.lateOptions(t.id, actor, { kind: 'arrive', entry: e.id });
        const best = o.options.find((x) => x.recommended);
        if (!best) return no(o.rule || 'No place for them under your policy');
        return { allowed: true, label: `${who} has arrived`, effect: `${ev.name} · ${best.label}${best.matchesAdded ? ` · +${best.matchesAdded} catch-up match${best.matchesAdded === 1 ? '' : 'es'}` : ''}`, why: best.why, group: best.group ?? null };
      }
      case 'not_here':
        if (!e) return no('Not one of the entries');
        if (ev.status === 'setup' || !e.inDraw) return no('Only for players in the draw, once it\'s under way');
        return e.awaySince ? no(`${who} is already marked late`) : { allowed: true, label: `${who} is late`, effect: 'Their matches wait; courts take the next match' };
      case 'here':
        if (!e) return no('Not one of the entries');
        return e.awaySince ? { allowed: true, label: `${who} is here`, effect: 'Their matches go back in the order of play' } : no(`${who} isn't marked late`);
      case 'add_entry': {
        const target = t.events.find((x) => x.id === a.eventId);
        if (!target) return no('Which event? It wasn\'t clear');
        if (!a.name || !a.name.trim()) return no('No name');
        if (target.entries.some((x) => x.name.toLowerCase() === a.name.trim().toLowerCase())) return no(`${a.name} is already entered in ${target.name}`);
        if (target.status === 'setup') return { allowed: true, label: `Add ${a.name.trim()}`, effect: `${target.name}${a.paidHow ? ` · paid (${a.paidHow})` : ''}` };
        if (!target.config.lateEntry) return no('Late entries are switched off for this event');
        const o = await svc.lateOptions(t.id, actor, { kind: 'late', event: target.id });
        const best = o.options.find((x) => x.recommended);
        if (!best) return no(o.rule || 'No place for them under your policy');
        return { allowed: true, label: `Add ${a.name.trim()} (late entry)`, effect: `${target.name} · ${best.label}${best.matchesAdded ? ` · +${best.matchesAdded} catch-up match${best.matchesAdded === 1 ? '' : 'es'}` : ''}`, why: best.why, group: best.group ?? null };
      }
      case 'mark_paid':
        if (!e) return no('Not one of the entries');
        if (!ev.fee) return no(`${ev.name} has no entry fee`);
        if (['received', 'cash', 'waived', 'paid'].includes(e.feeStatus)) return no(`${who} has already paid`);
        return { allowed: true, label: `${who} paid`, effect: `${ev.name} · ${a.paidHow === 'upi' ? 'UPI received' : 'cash'}` };
      case 'walkover': {
        const m = t.events.flatMap((x) => x.matches || []).find((x) => x.id === a.matchId);
        if (!m || !e || ![m.a && m.a.id, m.b && m.b.id].includes(e.id)) return no('Which match? It wasn\'t clear');
        const o = await svc.lateOptions(t.id, actor, { kind: 'noshow', match: m.id, entry: e.id });
        const w = o.options.find((x) => x.action === 'walkover');
        const other = m.a.id === e.id ? m.b : m.a;
        return w.allowed ? { allowed: true, label: `Walkover to ${other.name}`, effect: `${who} didn't come`, why: w.why, winner: m.a.id === e.id ? 'b' : 'a' } : no(w.why);
      }
      default:
        return no('Not something the assistant can do');
    }
  }

  // Proposals for what the organiser said: nothing changes yet.
  async function propose(id, actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    if (!ai.enabled()) fail(503, 'AI help isn\'t switched on for this site');
    const t = await svc.getTournament(id, actor);
    if (!t.can.manage) fail(403, 'Only the tournament\'s organisers can use the assistant');
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 2000) : '';
    const image = typeof input.image === 'string' ? input.image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/) : null;
    if (!text && !image) fail(400, 'Say what\'s happening, or add a photo');
    const content = [
      ...(image ? [{ type: 'image', source: { type: 'base64', media_type: image[1], data: image[2] } }] : []),
      { type: 'text', text: `${context(t)}\n\nThe organiser says: ${text || '(see the photo)'}` },
    ];
    const v = await version(t.id);
    const out = await ai.paid({ user: actor.user.id, tournament: t.id, scope: 'manage', cost: image ? COSTS.assistPhoto : COSTS.assist, note: 'assistant' },
      () => ai.call({ kind: 'assist', user: actor.user.id, tournament: t.id, system: SYSTEM, content, schema: SCHEMA, effort: 'medium' }));
    const proposals = [];
    for (const a of (out.actions || []).slice(0, 30)) {
      const p = await preview(t, a, actor);
      proposals.push({ key: crypto.randomBytes(4).toString('hex'), type: p.type || a.type, entryId: a.entryId, eventId: a.eventId, name: a.name, paidHow: a.paidHow, matchId: a.matchId, quote: a.quote, ...p });
    }
    // Several latecomers into one event: each is placed in turn when applied,
    // so the ones after the first may go to a different group.
    const placed = new Map();
    for (const x of proposals.filter((y) => y.allowed && y.group != null)) {
      const evId = x.eventId || (t.events.find((ev) => ev.entries.some((e) => e.id === x.entryId)) || {}).id;
      if (placed.has(evId)) x.effect = `${x.effect.split(' · ')[0]} · group worked out after ${placed.get(evId)} is placed, by your policy`;
      else placed.set(evId, x.label.replace(/^Add | has arrived$| \(late entry\)$/g, ''));
    }
    return { summary: out.summary, questions: out.questions || [], proposals, version: v, request: text || '(photo)' };
  }

  // The approved proposals, applied through the app's own actions, in order.
  async function apply(id, actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const t = await svc.getTournament(id, actor);
    if (!t.can.manage) fail(403, 'Only the tournament\'s organisers can approve changes');
    if (input.version !== await version(t.id)) fail(409, 'Things changed since — ask again so the suggestions are up to date', 'stale');
    const list = Array.isArray(input.proposals) ? input.proposals.slice(0, 30) : [];
    if (!list.length) fail(400, 'Nothing to apply');
    const results = [];
    for (const a of list) {
      let ok = true;
      let result = 'done';
      try {
        const p = await preview(await svc.getTournament(id, actor), a, actor); // checked again, just before
        if (!p.allowed) throw Object.assign(new Error(p.why || 'Not allowed'), { status: 409 });
        const type = p.type || a.type;
        if (type === 'check_in') await svc.checkIn(id, actor, a.entryId, true);
        else if (type === 'arrived') await svc.arrive(id, actor, a.entryId, p.group != null ? { group: p.group } : {});
        else if (type === 'not_here') await svc.setAway(id, actor, a.entryId, true);
        else if (type === 'here') await svc.setAway(id, actor, a.entryId, false);
        else if (type === 'add_entry') {
          const target = t.events.find((x) => x.id === a.eventId);
          if (target.status === 'setup') {
            await svc.addEntries(id, actor, [a.name.trim()], { event: a.eventId });
            if (a.paidHow && target.fee) {
              const fresh = await svc.getTournament(id, actor);
              const added = fresh.events.find((x) => x.id === a.eventId).entries.find((x) => x.name.toLowerCase() === a.name.trim().toLowerCase());
              if (added) await svc.setEntryFee(id, actor, added.id, a.paidHow === 'upi' ? 'received' : 'cash');
            }
          } else await svc.lateEntry(id, actor, { name: a.name.trim(), event: a.eventId, ...(p.group != null && { group: p.group }) });
        } else if (type === 'mark_paid') await svc.setEntryFee(id, actor, a.entryId, a.paidHow === 'upi' ? 'received' : 'cash');
        else if (type === 'walkover') await svc.giveWalkover(id, actor, a.matchId, p.winner);
        result = p.effect ? `${p.label} — ${p.effect.split(' · ').slice(1).join(' · ') || p.effect}` : p.label;
      } catch (err) {
        ok = false;
        result = err.message;
      }
      results.push({ key: a.key, ok, result });
      await db.query('INSERT INTO ai_actions (tournament_id, user_id, request, type, params, ok, result) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)',
        [t.id, actor.user.id, String(input.request || '').slice(0, 2000), a.type, JSON.stringify({ entryId: a.entryId, eventId: a.eventId, name: a.name, paidHow: a.paidHow, matchId: a.matchId }), ok, String(result).slice(0, 300)]);
    }
    return { results, tournament: await svc.getTournament(id, actor) };
  }

  // The log, for the organiser.
  async function log(id, actor) {
    const t = await svc.getTournament(id, actor);
    if (!t.can.manage) fail(403, 'Organisers only');
    const rows = await db.query(
      `SELECT a.type, a.ok, a.result, a.request, a.created_at AS at, u.name AS by FROM ai_actions a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.tournament_id = $1 ORDER BY a.id DESC LIMIT 50`, [t.id]);
    return { items: rows };
  }

  return { propose, apply, log, version, context, TYPES };
}

module.exports = { createAssistant, SYSTEM, SCHEMA, TYPES };
