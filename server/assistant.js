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
const { policyOf } = require('./latecomers');

const TYPES = ['check_in', 'not_here', 'here', 'arrived', 'add_entry', 'mark_paid', 'walkover', 'pair_solos', 'replace'];
const UNDO_MINUTES = 10;
const SYSTEM = `You help a tournament organiser on the day. They tell you what is happening (typed, dictated, a forwarded message or a photo of a paper list). Turn it into actions from this list only:
- check_in: a player or pair is here, before the draw (entryId)
- arrived: a player or pair who missed the draw is here now (entryId)
- not_here: a player is late for their match (entryId)
- here: a player marked late is back (entryId)
- add_entry: a new player, pair or team to add (eventId, name — a pair as "First / Second")
- mark_paid: an entry's fee was paid (entryId, paidHow: cash or upi)
- walkover: a player never came to their match (matchId, entryId of the one who didn't come)
- pair_solos: two players each looking for a partner should play together, before the draw (entryId and partnerId)
- replace: someone new plays in place of an entry who hasn't come and hasn't played yet (entryId of the one not coming, name of the new player or pair)
Two walk-ins who want to play together after the draw are one add_entry named "First / Second".
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
        required: ['type', 'entryId', 'eventId', 'name', 'paidHow', 'matchId', 'partnerId', 'quote'],
        properties: {
          type: { type: 'string', enum: TYPES },
          entryId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          eventId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          paidHow: { anyOf: [{ type: 'string', enum: ['cash', 'upi'] }, { type: 'null' }] },
          matchId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          partnerId: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
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
        const flags = [e.withdrawn ? 'withdrew' : null, e.confirmed ? null : 'not confirmed', e.solo ? 'looking for a partner' : null, ev.status === 'setup' ? (e.checkedIn ? 'checked in' : 'not checked in') : (e.inDraw ? 'in the draw' : 'missed the draw'),
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
      case 'pair_solos': {
        const b = a.partnerId ? entryOf(a.partnerId) : null;
        if (!e || !b || e.id === b.id) return no('Which two players? It wasn\'t clear');
        if (evOf(b.id).id !== ev.id) return no(`${e.name} and ${b.name} are in different events`);
        if (ev.status !== 'setup') return no('The draw has been made — add them as a new pair instead');
        if (!e.solo || !b.solo) return no(`${!e.solo ? e.name : b.name} isn't looking for a partner`);
        return { allowed: true, label: `Pair ${e.name} and ${b.name}`, effect: `${ev.name} · one entry, ${e.name} / ${b.name}` };
      }
      case 'replace': {
        if (!e) return no('Not one of the entries');
        if (!a.name || !a.name.trim()) return no('Who plays instead?');
        if (ev.status === 'setup') return no('The draw hasn\'t been made — remove them and add the new player');
        if (ev.status === 'completed') return no(`${ev.name} has finished`);
        if (!policyOf(t.config.latePolicy).replaceNoShow) return no('Your policy doesn\'t let a walk-in take someone\'s place');
        if (!e.inDraw || e.withdrawn) return no(`${who} isn't playing now`);
        if ((ev.matches || []).some((m) => (m.a?.id === e.id || m.b?.id === e.id) && m.status !== 'bye' && (m.status === 'done' || m.rallies))) return no(`${who} has already played — they can withdraw instead`);
        if (ev.entries.some((x) => x.id !== e.id && x.name.toLowerCase() === a.name.trim().toLowerCase())) return no(`${a.name} is already entered in ${ev.name}`);
        return { allowed: true, label: `${a.name.trim()} plays instead of ${who}`, effect: `${ev.name} · same group and matches`, why: 'Your policy: a walk-in can take a no-show\'s place before their first match.' };
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
      proposals.push({ key: crypto.randomBytes(4).toString('hex'), type: p.type || a.type, entryId: a.entryId, eventId: a.eventId, name: a.name, paidHow: a.paidHow, matchId: a.matchId, partnerId: a.partnerId, quote: a.quote, ...p });
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
    const batch = crypto.randomBytes(8).toString('hex');
    for (const a of list) {
      let ok = true;
      let result = 'done';
      let undo = null;
      try {
        const p = await preview(await svc.getTournament(id, actor), a, actor); // checked again, just before
        if (!p.allowed) throw Object.assign(new Error(p.why || 'Not allowed'), { status: 409 });
        const type = p.type || a.type;
        const before = await svc.getTournament(id, actor);
        const entryNow = (eid) => before.events.flatMap((x) => x.entries).find((x) => x.id === eid);
        const added = async (eventId, name) => (await svc.getTournament(id, actor)).events.find((x) => x.id === eventId).entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (type === 'check_in') { await svc.checkIn(id, actor, a.entryId, true); undo = { do: 'check_out', entryId: a.entryId }; }
        else if (type === 'arrived') { await svc.arrive(id, actor, a.entryId, p.group != null ? { group: p.group } : {}); undo = { do: 'undo_late', entryId: a.entryId, mode: 'out' }; }
        else if (type === 'not_here') { await svc.setAway(id, actor, a.entryId, true); undo = { do: 'away', entryId: a.entryId, away: false }; }
        else if (type === 'here') { await svc.setAway(id, actor, a.entryId, false); undo = { do: 'away', entryId: a.entryId, away: true }; }
        else if (type === 'add_entry') {
          const target = t.events.find((x) => x.id === a.eventId);
          if (target.status === 'setup') {
            await svc.addEntries(id, actor, [a.name.trim()], { event: a.eventId });
            const e = await added(a.eventId, a.name.trim());
            if (e && a.paidHow && target.fee) await svc.setEntryFee(id, actor, e.id, a.paidHow === 'upi' ? 'received' : 'cash');
            if (e) undo = { do: 'remove', entryId: e.id };
          } else {
            await svc.lateEntry(id, actor, { name: a.name.trim(), event: a.eventId, ...(p.group != null && { group: p.group }) });
            const e = await added(a.eventId, a.name.trim());
            if (e) undo = { do: 'undo_late', entryId: e.id, mode: 'delete' };
          }
        } else if (type === 'mark_paid') {
          const prev = entryNow(a.entryId).feeStatus || null;
          await svc.setEntryFee(id, actor, a.entryId, a.paidHow === 'upi' ? 'received' : 'cash');
          undo = { do: 'fee', entryId: a.entryId, status: prev };
        } else if (type === 'walkover') await svc.giveWalkover(id, actor, a.matchId, p.winner); // no undo: walkovers stand
        else if (type === 'pair_solos') {
          await svc.pairSolos(id, actor, a.entryId, a.partnerId);
          const [r] = await db.query('SELECT paired_into FROM entries WHERE id = $1', [a.entryId]);
          if (r && r.paired_into) undo = { do: 'unpair', entryId: r.paired_into };
        } else if (type === 'replace') {
          const snap = await svc.entrySnapshot(a.entryId);
          await svc.replaceEntry(id, actor, a.entryId, { name: a.name.trim() });
          undo = { do: 'restore', entryId: a.entryId, snap };
        }
        result = p.effect ? `${p.label} — ${p.effect.split(' · ').slice(1).join(' · ') || p.effect}` : p.label;
      } catch (err) {
        ok = false;
        result = err.message;
      }
      results.push({ key: a.key, ok, result, undoable: Boolean(undo) });
      await db.query('INSERT INTO ai_actions (tournament_id, user_id, request, type, params, ok, result, batch, undo) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb)',
        [t.id, actor.user.id, String(input.request || '').slice(0, 2000), a.type, JSON.stringify({ entryId: a.entryId, eventId: a.eventId, name: a.name, paidHow: a.paidHow, matchId: a.matchId, partnerId: a.partnerId }), ok, String(result).slice(0, 300),
          batch, undo ? JSON.stringify(undo) : null]);
    }
    return { results, batch: results.some((r) => r.undoable) ? batch : null, undoMinutes: UNDO_MINUTES, tournament: await svc.getTournament(id, actor) };
  }

  // Takes back an Apply, within UNDO_MINUTES: each change reversed, last
  // first, through the app's own actions; any that can't be (a catch-up
  // match has been played since, say) are reported and left as they are.
  async function undo(id, actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const t = await svc.getTournament(id, actor);
    if (!t.can.manage) fail(403, 'Only the tournament\'s organisers can undo changes');
    const rows = await db.query(
      `SELECT id, type, result, undo, created_at FROM ai_actions WHERE tournament_id = $1 AND batch = $2 AND ok AND undo IS NOT NULL AND undone_at IS NULL ORDER BY id DESC`,
      [t.id, String(input.batch || '')]);
    if (!rows.length) fail(404, 'Nothing to undo');
    if (Date.now() - Date.parse(rows[0].created_at) > UNDO_MINUTES * 60000) fail(409, `Changes can be undone for ${UNDO_MINUTES} minutes — change them by hand now`);
    const results = [];
    for (const r of rows) {
      const u = r.undo;
      try {
        if (u.do === 'check_out') await svc.checkIn(id, actor, u.entryId, false);
        else if (u.do === 'away') await svc.setAway(id, actor, u.entryId, u.away);
        else if (u.do === 'remove') await svc.removeEntry(id, actor, u.entryId);
        else if (u.do === 'undo_late') await svc.undoLate(id, actor, u.entryId, u.mode);
        else if (u.do === 'fee') await svc.setEntryFee(id, actor, u.entryId, u.status);
        else if (u.do === 'unpair') await svc.unpair(id, actor, u.entryId);
        else if (u.do === 'restore') await svc.restoreEntry(id, actor, u.entryId, u.snap);
        await db.query('UPDATE ai_actions SET undone_at = now() WHERE id = $1', [r.id]);
        results.push({ ok: true, result: `Undone: ${r.result}` });
      } catch (err) {
        results.push({ ok: false, result: err.message });
      }
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

  return { propose, apply, undo, log, version, context, TYPES };
}

module.exports = { createAssistant, SYSTEM, SCHEMA, TYPES };
